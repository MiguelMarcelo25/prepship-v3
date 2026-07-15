import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { inventory } from '../db/schema/inventory';
import {
  ensureAuditLogSchema,
  recordRequiredAuditEventInTransaction,
  type AuditActor,
} from './audit-log';
import {
  computeEffectiveStockForIdsInTransaction,
  type InventoryStockTransaction,
} from './inventory-stock-math';

export const INVENTORY_RECONCILIATION_CONFIRMATION = 'apply-reviewed-ledger-cache-rebuild';
const PLAN_VERSION = 'ps-427-ledger-cache-v1';

export type InventoryReconciliationScope = {
  clientId?: number;
  sku?: string;
};

export type InventoryReconciliationPlanRow = {
  inventoryId: number;
  clientId: number | null;
  sku: string;
  normalizedSku: string;
  currentStockQty: number;
  authoritativeLedgerQty: number;
  totalReceived: number;
  totalSold: number;
  delta: number;
  normalizedSkuDuplicateCount: number;
  ambiguous: boolean;
};

export type InventoryReconciliationPlan = {
  contract: 'ledger_authoritative_cache_rebuild';
  scope: { clientId: number | null; sku: string | null };
  planHash: string;
  rows: InventoryReconciliationPlanRow[];
  rowsScanned: number;
  rowsToAdjust: number;
  totalDelta: number;
  blocked: boolean;
  ambiguousRows: InventoryReconciliationPlanRow[];
};

export type ApplyInventoryReconciliationInput = {
  scope: InventoryReconciliationScope;
  reviewedPlanHash: string;
  confirmation: string;
  reason: string;
  approvalReference: string;
  actor: AuditActor;
  applyEnabled: boolean;
};

export type InventoryReconciliationDependencies = {
  database?: typeof db;
  ensureAuditReady?: () => Promise<void>;
};

export class InventoryReconciliationError extends Error {
  constructor(
    readonly code:
      | 'APPLY_DISABLED'
      | 'REVIEWED_SCOPE_REQUIRED'
      | 'CONFIRMATION_REQUIRED'
      | 'ACTOR_REQUIRED'
      | 'PLAN_MISMATCH'
      | 'AMBIGUOUS_SKU'
      | 'CONCURRENT_CHANGE',
    message: string,
    readonly status: 400 | 403 | 409 | 503,
  ) {
    super(message);
    this.name = 'InventoryReconciliationError';
  }
}

type ScopedInventoryRow = {
  inventory_id: number;
  client_id: number | null;
  sku: string;
  stock_qty: number;
};

function normalizeScope(scope: InventoryReconciliationScope): {
  clientId: number | null;
  sku: string | null;
} {
  const clientId = scope.clientId;
  if (clientId !== undefined && (!Number.isInteger(clientId) || clientId <= 0)) {
    throw new InventoryReconciliationError(
      'REVIEWED_SCOPE_REQUIRED',
      'clientId must be a positive integer.',
      400,
    );
  }
  return {
    clientId: clientId ?? null,
    sku: scope.sku?.trim() || null,
  };
}

function normalizedSkuKey(clientId: number | null, sku: string): string {
  return `${clientId ?? 'null'}:${sku.trim().toLocaleLowerCase('en-US')}`;
}

async function selectScopedInventoryRows(
  tx: InventoryStockTransaction,
  scope: ReturnType<typeof normalizeScope>,
  lockRows: boolean,
): Promise<ScopedInventoryRow[]> {
  const executed = await tx.execute<ScopedInventoryRow>(sql`
    select
      i.id as inventory_id,
      i.client_id,
      i.sku,
      i.stock_qty
    from ${inventory} i
    where i.active = true
      ${scope.clientId === null ? sql`` : sql`and i.client_id = ${scope.clientId}`}
      ${scope.sku === null ? sql`` : sql`and lower(i.sku) = lower(${scope.sku})`}
    order by i.id
    ${lockRows ? sql`for update` : sql``}
  `);
  // postgres-js returns a row array; PGlite returns the same rows under `.rows`.
  return Array.isArray(executed)
    ? executed
    : (executed as unknown as { rows?: ScopedInventoryRow[] }).rows ?? [];
}

function planHash(
  scope: ReturnType<typeof normalizeScope>,
  rows: InventoryReconciliationPlanRow[],
): string {
  return createHash('sha256')
    .update(JSON.stringify({
      version: PLAN_VERSION,
      scope: {
        clientId: scope.clientId,
        sku: scope.sku?.toLocaleLowerCase('en-US') ?? null,
      },
      rows: rows.map((row) => ({
        inventoryId: row.inventoryId,
        clientId: row.clientId,
        normalizedSku: row.normalizedSku,
        currentStockQty: row.currentStockQty,
        authoritativeLedgerQty: row.authoritativeLedgerQty,
        normalizedSkuDuplicateCount: row.normalizedSkuDuplicateCount,
      })),
    }))
    .digest('hex');
}

async function buildInventoryReconciliationPlanInTransaction(
  tx: InventoryStockTransaction,
  requestedScope: InventoryReconciliationScope,
  lockRows: boolean,
): Promise<InventoryReconciliationPlan> {
  const scope = normalizeScope(requestedScope);
  const inventoryRows = await selectScopedInventoryRows(tx, scope, lockRows);
  const facts = await computeEffectiveStockForIdsInTransaction(
    tx,
    inventoryRows.map((row) => Number(row.inventory_id)),
  );
  const duplicateCounts = new Map<string, number>();
  for (const row of inventoryRows) {
    const key = normalizedSkuKey(row.client_id, row.sku);
    duplicateCounts.set(key, (duplicateCounts.get(key) ?? 0) + 1);
  }

  const rows = inventoryRows.map((row): InventoryReconciliationPlanRow => {
    const inventoryId = Number(row.inventory_id);
    const currentStockQty = Number(row.stock_qty) || 0;
    const ledgerFacts = facts.get(inventoryId);
    const authoritativeLedgerQty = ledgerFacts?.effectiveStock ?? currentStockQty;
    const normalizedSku = row.sku.trim().toLocaleLowerCase('en-US');
    const normalizedSkuDuplicateCount = duplicateCounts.get(
      normalizedSkuKey(row.client_id, row.sku),
    ) ?? 1;
    return {
      inventoryId,
      clientId: row.client_id,
      sku: row.sku,
      normalizedSku,
      currentStockQty,
      authoritativeLedgerQty,
      totalReceived: ledgerFacts?.totalReceived ?? 0,
      totalSold: ledgerFacts?.totalSold ?? 0,
      delta: authoritativeLedgerQty - currentStockQty,
      normalizedSkuDuplicateCount,
      ambiguous: normalizedSkuDuplicateCount > 1,
    };
  });
  const adjustments = rows.filter((row) => row.delta !== 0);
  const ambiguousRows = rows.filter((row) => row.ambiguous);

  return {
    contract: 'ledger_authoritative_cache_rebuild',
    scope,
    planHash: planHash(scope, rows),
    rows,
    rowsScanned: rows.length,
    rowsToAdjust: adjustments.length,
    totalDelta: adjustments.reduce((sum, row) => sum + row.delta, 0),
    blocked: ambiguousRows.length > 0,
    ambiguousRows,
  };
}

export function buildInventoryReconciliationPlan(
  scope: InventoryReconciliationScope,
  dependencies: InventoryReconciliationDependencies = {},
): Promise<InventoryReconciliationPlan> {
  const database = dependencies.database ?? db;
  return database.transaction(
    (tx) => buildInventoryReconciliationPlanInTransaction(tx, scope, false),
    {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    },
  );
}

function validateApplyInput(input: ApplyInventoryReconciliationInput): void {
  if (!input.applyEnabled) {
    throw new InventoryReconciliationError(
      'APPLY_DISABLED',
      'Inventory cache rebuild apply is disabled until DJ separately approves production execution.',
      503,
    );
  }
  const scope = normalizeScope(input.scope);
  if (scope.clientId === null || scope.sku === null) {
    throw new InventoryReconciliationError(
      'REVIEWED_SCOPE_REQUIRED',
      'Apply requires an exact reviewed clientId and SKU scope.',
      400,
    );
  }
  if (input.confirmation !== INVENTORY_RECONCILIATION_CONFIRMATION) {
    throw new InventoryReconciliationError(
      'CONFIRMATION_REQUIRED',
      `confirmation must equal ${INVENTORY_RECONCILIATION_CONFIRMATION}.`,
      400,
    );
  }
  if (!/^[a-f0-9]{64}$/i.test(input.reviewedPlanHash)) {
    throw new InventoryReconciliationError(
      'PLAN_MISMATCH',
      'A valid reviewed dry-run plan hash is required.',
      409,
    );
  }
  if (input.reason.trim().length < 10 || input.approvalReference.trim().length < 5) {
    throw new InventoryReconciliationError(
      'CONFIRMATION_REQUIRED',
      'A specific reason and separate approval reference are required.',
      400,
    );
  }
  if (!input.actor.actorId?.trim() && !input.actor.actorEmail?.trim()) {
    throw new InventoryReconciliationError(
      'ACTOR_REQUIRED',
      'An authenticated actor is required for inventory reconciliation apply.',
      403,
    );
  }
}

export async function applyInventoryReconciliationPlan(
  input: ApplyInventoryReconciliationInput,
  dependencies: InventoryReconciliationDependencies = {},
): Promise<{
  mode: 'apply';
  contract: 'ledger_authoritative_cache_rebuild';
  runId: string | null;
  planHash: string;
  rowsScanned: number;
  rowsAdjusted: number;
  totalDelta: number;
  adjustments: InventoryReconciliationPlanRow[];
}> {
  validateApplyInput(input);
  await (dependencies.ensureAuditReady ?? ensureAuditLogSchema)();
  const database = dependencies.database ?? db;
  const runId = randomUUID();
  const appliedAt = new Date();

  return database.transaction(async (tx) => {
    const plan = await buildInventoryReconciliationPlanInTransaction(tx, input.scope, true);
    if (plan.planHash !== input.reviewedPlanHash) {
      throw new InventoryReconciliationError(
        'PLAN_MISMATCH',
        'Inventory changed after dry-run review; generate and review a new plan.',
        409,
      );
    }
    if (plan.blocked) {
      throw new InventoryReconciliationError(
        'AMBIGUOUS_SKU',
        'Case-variant duplicate SKUs make this scope ambiguous; no cache rows were changed.',
        409,
      );
    }

    const adjustments = plan.rows.filter((row) => row.delta !== 0);
    if (adjustments.length === 0) {
      return {
        mode: 'apply' as const,
        contract: plan.contract,
        runId: null,
        planHash: plan.planHash,
        rowsScanned: plan.rowsScanned,
        rowsAdjusted: 0,
        totalDelta: 0,
        adjustments: [],
      };
    }

    for (const row of adjustments) {
      const [updated] = await tx
        .update(inventory)
        .set({ stockQty: row.authoritativeLedgerQty, updatedAt: appliedAt })
        .where(and(
          eq(inventory.id, row.inventoryId),
          eq(inventory.stockQty, row.currentStockQty),
        ))
        .returning({ id: inventory.id, stockQty: inventory.stockQty });
      if (!updated || updated.stockQty !== row.authoritativeLedgerQty) {
        throw new InventoryReconciliationError(
          'CONCURRENT_CHANGE',
          'Inventory changed during the cache rebuild; the transaction was rolled back.',
          409,
        );
      }

      await recordRequiredAuditEventInTransaction(tx, {
        ...input.actor,
        eventType: 'inventory.cache_rebuilt',
        resourceType: 'inventory',
        resourceId: row.inventoryId,
        action: 'set_stock_qty_from_ledger',
        details: {
          runId,
          planHash: plan.planHash,
          contract: plan.contract,
          reviewedScope: plan.scope,
          reason: input.reason.trim(),
          approvalReference: input.approvalReference.trim(),
          sku: row.sku,
          beforeStockQty: row.currentStockQty,
          authoritativeLedgerQty: row.authoritativeLedgerQty,
          afterStockQty: updated.stockQty,
          rollbackStockQty: row.currentStockQty,
          totalReceived: row.totalReceived,
          totalSold: row.totalSold,
        },
      });
    }

    await recordRequiredAuditEventInTransaction(tx, {
      ...input.actor,
      eventType: 'inventory.reconciliation_applied',
      resourceType: 'inventory_reconciliation',
      resourceId: runId,
      action: 'ledger_cache_rebuild',
      details: {
        planHash: plan.planHash,
        contract: plan.contract,
        reviewedScope: plan.scope,
        reason: input.reason.trim(),
        approvalReference: input.approvalReference.trim(),
        rowsAdjusted: adjustments.length,
        totalDelta: plan.totalDelta,
        inventoryIds: adjustments.map((row) => row.inventoryId),
      },
    });

    return {
      mode: 'apply' as const,
      contract: plan.contract,
      runId,
      planHash: plan.planHash,
      rowsScanned: plan.rowsScanned,
      rowsAdjusted: adjustments.length,
      totalDelta: plan.totalDelta,
      adjustments,
    };
  }, {
    isolationLevel: 'serializable',
  });
}
