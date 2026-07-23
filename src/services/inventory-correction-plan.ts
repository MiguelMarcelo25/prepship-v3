import { createHash } from 'node:crypto';
import type { InventoryReconciliationPlan } from './inventory-reconciliation';

export const PS462_CORRECTION_NOTE = 'PS-462 reviewed legacy opening-balance correction';
export const PS462_CORRECTION_SOURCE = 'inventory_reconciliation';

export type InventoryCorrectionPlanRow = {
  sequence: number;
  inventoryId: number;
  clientId: number | null;
  sku: string;
  expectedLegacyQuantity: number;
  expectedLedgerQuantity: number;
  correctionQuantity: number;
  expectedPostQuantity: number;
  type: 'adjust';
  orderId: null;
  note: string;
  idempotencyKey: string;
  sourceEntity: string;
  sourceId: string;
  effectiveAt: 'REQUIRED_AT_APPLY_TIME';
  createdBy: 'REQUIRED_AT_APPLY_TIME';
  reviewFingerprint: string;
};

export type InventoryCorrectionPlan = {
  contract: 'ps462_append_only_inventory_correction_plan_v1';
  sourcePlanHash: string;
  rows: InventoryCorrectionPlanRow[];
  movementCsv: string;
  movementsSha256: string;
  correctionQuantity: number;
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function csv(value: unknown): string {
  if (value == null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function buildInventoryCorrectionPlan(
  plan: InventoryReconciliationPlan,
): InventoryCorrectionPlan {
  if (plan.ambiguousRows.length > 0) {
    throw new Error(`PS462_CORRECTION_PLAN_AMBIGUOUS: ${plan.ambiguousRows.length} rows`);
  }

  const mismatches = plan.rows
    .filter((row) => row.legacyQuantity != null && row.legacyQuantity !== row.inventoryQuantity)
    .sort((left, right) => left.inventoryId - right.inventoryId);
  const rows = mismatches.map((row, index): InventoryCorrectionPlanRow => {
    const expectedLegacyQuantity = Number(row.legacyQuantity);
    const correctionQuantity = expectedLegacyQuantity - row.inventoryQuantity;
    if (!Number.isInteger(correctionQuantity) || correctionQuantity === 0) {
      throw new Error(`PS462_CORRECTION_PLAN_INVALID_QUANTITY: inventory ${row.inventoryId}`);
    }
    const identity = {
      inventoryId: row.inventoryId,
      clientId: row.clientId,
      sku: row.sku,
      expectedLegacyQuantity,
      expectedLedgerQuantity: row.inventoryQuantity,
      correctionQuantity,
      expectedPostQuantity: expectedLegacyQuantity,
      type: 'adjust' as const,
      orderId: null,
      idempotencyKey: `inventory:reconciliation:ps462:${plan.planHash}:${row.inventoryId}`,
      sourceEntity: PS462_CORRECTION_SOURCE,
      sourceId: `ps462:${plan.planHash}:${row.inventoryId}`,
    };
    return {
      sequence: index + 1,
      ...identity,
      note: PS462_CORRECTION_NOTE,
      effectiveAt: 'REQUIRED_AT_APPLY_TIME',
      createdBy: 'REQUIRED_AT_APPLY_TIME',
      reviewFingerprint: sha256(JSON.stringify(identity)),
    };
  });

  const headers = [
    'sequence', 'inventory_id', 'client_id', 'sku', 'expected_legacy_quantity',
    'expected_ledger_quantity', 'correction_quantity', 'expected_post_quantity',
    'type', 'order_id', 'note', 'idempotency_key', 'source_entity', 'source_id',
    'effective_at', 'created_by', 'review_fingerprint',
  ];
  const movementCsv = [
    headers.join(','),
    ...rows.map((row) => [
      row.sequence,
      row.inventoryId,
      row.clientId,
      row.sku,
      row.expectedLegacyQuantity,
      row.expectedLedgerQuantity,
      row.correctionQuantity,
      row.expectedPostQuantity,
      row.type,
      row.orderId,
      row.note,
      row.idempotencyKey,
      row.sourceEntity,
      row.sourceId,
      row.effectiveAt,
      row.createdBy,
      row.reviewFingerprint,
    ].map(csv).join(',')),
  ].join('\n') + '\n';

  return {
    contract: 'ps462_append_only_inventory_correction_plan_v1',
    sourcePlanHash: plan.planHash,
    rows,
    movementCsv,
    movementsSha256: sha256(movementCsv),
    correctionQuantity: rows.reduce((sum, row) => sum + row.correctionQuantity, 0),
  };
}

export function assertInventoryCorrectionApproval(
  plan: InventoryCorrectionPlan,
  approvedPlanHash: string | undefined,
  approvedMovementsSha: string | undefined,
): void {
  if (approvedPlanHash !== plan.sourcePlanHash) {
    throw new Error('PS462_CORRECTION_PLAN_HASH_MISMATCH');
  }
  if (approvedMovementsSha !== plan.movementsSha256) {
    throw new Error('PS462_CORRECTION_MOVEMENTS_SHA_MISMATCH');
  }
}
