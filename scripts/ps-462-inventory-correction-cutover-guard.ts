import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  assertInventoryCorrectionApproval,
  buildInventoryCorrectionPlan,
} from '../src/services/inventory-correction-plan.js';
import type { InventoryReconciliationPlan } from '../src/services/inventory-reconciliation.js';

const baseRow: InventoryReconciliationPlan['rows'][number] = {
  inventoryId: 2,
  clientId: 1,
  sku: 'PS462',
  normalizedSku: 'ps462',
  legacyQuantity: 9,
  inventoryQuantity: 4,
  totalReceived: 4,
  totalShipped: 0,
  legacyDelta: -5,
  normalizedSkuDuplicateCount: 1,
  negativeBalance: false,
  missingVolume: false,
  ambiguous: false,
};
const sourcePlan: InventoryReconciliationPlan = {
  contract: 'ledger_quantity_discrepancy_report',
  scope: { clientId: null, sku: null },
  planHash: 'reviewed-plan-hash',
  rows: [{ ...baseRow, inventoryId: 5 }, baseRow],
  rowsScanned: 2,
  rowsToAdjust: 2,
  totalDelta: -10,
  blocked: true,
  ambiguousRows: [],
  classifications: {
    balanceMismatch: 2,
    negativeBalance: 0,
    caseVariantSkuCollision: 0,
    missingVolume: 0,
  },
};

const correction = buildInventoryCorrectionPlan(sourcePlan);
assert.deepEqual(correction.rows.map((row) => row.inventoryId), [2, 5]);
assert.deepEqual(correction.rows.map((row) => row.correctionQuantity), [5, 5]);
assert.equal(correction.correctionQuantity, 10);
assert.equal(buildInventoryCorrectionPlan(sourcePlan).movementsSha256, correction.movementsSha256);
assert.doesNotThrow(() => assertInventoryCorrectionApproval(
  correction,
  sourcePlan.planHash,
  correction.movementsSha256,
));
assert.throws(
  () => assertInventoryCorrectionApproval(correction, 'stale', correction.movementsSha256),
  /PS462_CORRECTION_PLAN_HASH_MISMATCH/,
);
assert.throws(
  () => assertInventoryCorrectionApproval(correction, sourcePlan.planHash, 'stale'),
  /PS462_CORRECTION_MOVEMENTS_SHA_MISMATCH/,
);
assert.throws(
  () => buildInventoryCorrectionPlan({ ...sourcePlan, ambiguousRows: [baseRow] }),
  /PS462_CORRECTION_PLAN_AMBIGUOUS/,
);

const correctionOperator = readFileSync('scripts/ps-462-inventory-correction-operator.ts', 'utf8');
assert.match(correctionOperator, /mode: 'READ_ONLY_PREFLIGHT'/);
assert.match(correctionOperator, /apply-ps-462-inventory-correction/);
assert.match(correctionOperator, /api-workers-stopped-inventory-auto-deduct-disabled/);
assert.match(correctionOperator, /assertInventoryCorrectionApproval/);
assert.match(correctionOperator, /order by id for update/i);
assert.match(correctionOperator, /applyInventoryMovementInTransaction/);
assert.match(correctionOperator, /PS462_CORRECTION_GLOBAL_PARITY_FAILED/);
assert.doesNotMatch(correctionOperator, /update\s+(?:public\.)?inventory\s+set\s+stock_qty/i);
assert.doesNotMatch(correctionOperator, /(?:update|delete|truncate)\s+(?:table\s+)?(?:public\.)?inventory_ledger/i);
assert.doesNotMatch(correctionOperator, /\b(?:orders|shipments)\b/i);

const cutoverOperator = readFileSync('scripts/ps-462-inventory-cutover-operator.ts', 'utf8');
assert.match(cutoverOperator, /mode: 'READ_ONLY_PREFLIGHT'/);
assert.match(cutoverOperator, /apply-ps-462-inventory-cutover-0074/);
assert.match(cutoverOperator, /forward-rollback-reviewed/);
assert.match(cutoverOperator, /PS462_CUTOVER_PREFLIGHT_BLOCKED/);
assert.match(cutoverOperator, /PS462_CUTOVER_DATA_SNAPSHOT_CHANGED/);
assert.match(cutoverOperator, /PS462_CUTOVER_SQL_PROTECTED_SURFACE_DETECTED/);

const runbook = readFileSync('docs/runbooks/ps-462-inventory-correction-cutover.md', 'utf8');
assert.match(runbook, /Do not reopen traffic after phase 1/i);
assert.match(runbook, /Never deploy.*latest/i);
assert.match(runbook, /append-only inverse movement/i);
assert.match(runbook, /ps-462_inventory_quantity_forward_rollback\.sql/);

console.log('PASS PS-462 inventory correction and cutover static guards');
