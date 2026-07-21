import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { inventory } from '../db/schema/inventory';
import {
  computeInventoryQuantityForIdsInTransaction,
  type InventoryStockTransaction,
} from './inventory-stock-math';

export const INVENTORY_RECONCILIATION_CONFIRMATION = 'append-reviewed-ledger-movements';

export type InventoryReconciliationScope = {
  clientId?: number;
  sku?: string;
};

export type InventoryReconciliationPlanRow = {
  inventoryId: number;
  clientId: number | null;
  sku: string;
  normalizedSku: string;
  legacyQuantity: number | null;
  inventoryQuantity: number;
  totalReceived: number;
  totalShipped: number;
  legacyDelta: number | null;
  normalizedSkuDuplicateCount: number;
  negativeBalance: boolean;
  missingVolume: boolean;
  ambiguous: boolean;
};

export type InventoryReconciliationPlan = {
  contract: 'ledger_quantity_discrepancy_report';
  scope: { clientId: number | null; sku: string | null };
  planHash: string;
  rows: InventoryReconciliationPlanRow[];
  rowsScanned: number;
  rowsToAdjust: number;
  totalDelta: number;
  blocked: boolean;
  ambiguousRows: InventoryReconciliationPlanRow[];
  classifications: {
    balanceMismatch: number;
    negativeBalance: number;
    caseVariantSkuCollision: number;
    missingVolume: number;
  };
};

export type InventoryReconciliationDependencies = {
  database?: typeof db;
};

export class InventoryReconciliationError extends Error {
  constructor(
    readonly code: 'REVIEWED_SCOPE_REQUIRED' | 'APPLY_REMOVED',
    message: string,
    readonly status: 400 | 409,
  ) {
    super(message);
    this.name = 'InventoryReconciliationError';
  }
}

type ScopedInventoryRow = {
  inventory_id: number;
  client_id: number | null;
  sku: string;
  legacy_quantity: number | null;
  cu_ft_override: number | null;
  length: number | null;
  width: number | null;
  height: number | null;
};

function normalizeScope(scope: InventoryReconciliationScope) {
  if (scope.clientId !== undefined && (!Number.isInteger(scope.clientId) || scope.clientId <= 0)) {
    throw new InventoryReconciliationError(
      'REVIEWED_SCOPE_REQUIRED',
      'clientId must be a positive integer.',
      400,
    );
  }
  return { clientId: scope.clientId ?? null, sku: scope.sku?.trim() || null };
}

function volumeMissing(row: ScopedInventoryRow): boolean {
  const override = Number(row.cu_ft_override);
  if (Number.isFinite(override) && override > 0) return false;
  return ![row.length, row.width, row.height].every((value) => Number(value) > 0);
}

export async function buildInventoryReconciliationPlanInTransaction(
  tx: InventoryStockTransaction,
  requestedScope: InventoryReconciliationScope,
): Promise<InventoryReconciliationPlan> {
  const scope = normalizeScope(requestedScope);
  const executed = await tx.execute<ScopedInventoryRow>(sql`
    select
      i.id as inventory_id,
      i.client_id,
      i.sku,
      nullif(to_jsonb(i)->>'stock_qty', '')::int as legacy_quantity,
      i.cu_ft_override,
      i.length,
      i.width,
      i.height
    from ${inventory} i
    where i.active = true
      ${scope.clientId === null ? sql`` : sql`and i.client_id = ${scope.clientId}`}
      ${scope.sku === null ? sql`` : sql`and lower(i.sku) = lower(${scope.sku})`}
    order by i.id
  `);
  const sourceRows = Array.isArray(executed)
    ? executed
    : (executed as unknown as { rows?: ScopedInventoryRow[] }).rows ?? [];
  const quantities = await computeInventoryQuantityForIdsInTransaction(
    tx,
    sourceRows.map((row) => Number(row.inventory_id)),
  );
  const duplicateCounts = new Map<string, number>();
  for (const row of sourceRows) {
    const key = `${row.client_id ?? 'global'}:${row.sku.trim().toLowerCase()}`;
    duplicateCounts.set(key, (duplicateCounts.get(key) ?? 0) + 1);
  }

  const rows = sourceRows.map((row): InventoryReconciliationPlanRow => {
    const quantity = quantities.get(Number(row.inventory_id)) ?? {
      inventoryQuantity: 0,
      totalReceived: 0,
      totalShipped: 0,
    };
    const normalizedSku = row.sku.trim().toLowerCase();
    const duplicateCount = duplicateCounts.get(`${row.client_id ?? 'global'}:${normalizedSku}`) ?? 1;
    const legacyQuantity = row.legacy_quantity == null ? null : Number(row.legacy_quantity);
    return {
      inventoryId: Number(row.inventory_id),
      clientId: row.client_id == null ? null : Number(row.client_id),
      sku: row.sku,
      normalizedSku,
      legacyQuantity,
      inventoryQuantity: quantity.inventoryQuantity,
      totalReceived: quantity.totalReceived,
      totalShipped: quantity.totalShipped,
      legacyDelta: legacyQuantity == null ? null : quantity.inventoryQuantity - legacyQuantity,
      normalizedSkuDuplicateCount: duplicateCount,
      negativeBalance: quantity.inventoryQuantity < 0,
      missingVolume: volumeMissing(row),
      ambiguous: duplicateCount > 1,
    };
  });
  const mismatches = rows.filter((row) => row.legacyDelta != null && row.legacyDelta !== 0);
  const classifications = {
    balanceMismatch: mismatches.length,
    negativeBalance: rows.filter((row) => row.negativeBalance).length,
    caseVariantSkuCollision: rows.filter((row) => row.ambiguous).length,
    missingVolume: rows.filter((row) => row.missingVolume).length,
  };
  const planHash = createHash('sha256')
    .update(JSON.stringify({ scope, rows, classifications }))
    .digest('hex');
  return {
    contract: 'ledger_quantity_discrepancy_report',
    scope,
    planHash,
    rows,
    rowsScanned: rows.length,
    rowsToAdjust: mismatches.length,
    totalDelta: mismatches.reduce((sum, row) => sum + (row.legacyDelta ?? 0), 0),
    blocked: mismatches.length > 0 || classifications.caseVariantSkuCollision > 0,
    ambiguousRows: rows.filter((row) => row.ambiguous),
    classifications,
  };
}

export function buildInventoryReconciliationPlan(
  scope: InventoryReconciliationScope,
  dependencies: InventoryReconciliationDependencies = {},
): Promise<InventoryReconciliationPlan> {
  const database = dependencies.database ?? db;
  return database.transaction((tx) => buildInventoryReconciliationPlanInTransaction(tx, scope));
}

export async function applyInventoryReconciliationPlan(): Promise<never> {
  throw new InventoryReconciliationError(
    'APPLY_REMOVED',
    'Direct balance repair was removed by PS-439. Submit a separately reviewed append-only movement plan.',
    409,
  );
}
