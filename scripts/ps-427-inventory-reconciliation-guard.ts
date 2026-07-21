/** PS-427 static placement/safety guard. Offline only; no database or provider calls. */
import { existsSync, readFileSync } from 'node:fs';

let failures = 0;

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function includesAll(name: string, text: string, values: string[]): void {
  const missing = values.filter((value) => !text.includes(value));
  check(name, missing.length === 0, missing);
}

const service = read('src/services/inventory-reconciliation.ts');
const admin = read('src/routes/admin.ts');
const stockMath = read('src/services/inventory-stock-math.ts');
const audit = read('src/services/audit-log.ts');
const env = read('src/lib/env.ts');
const docs = read('docs/ps-tickets/PS-427.md');

includesAll('canonical reconciliation owner is explicit and ledger-authoritative', service, [
  "contract: 'ledger_authoritative_cache_rebuild'",
  'computeEffectiveStockForIdsInTransaction',
  'stockQty: row.authoritativeLedgerQty',
  "isolationLevel: 'serializable'",
  'for update',
]);
check(
  'reconciliation never appends a discrepancy movement',
  !/applyInventoryMovement|insert\(inventoryLedger\)|inventory\.stockQty\}\s*\+/.test(service),
);
includesAll('apply requires reviewed exact scope and fail-closed evidence', service, [
  'REVIEWED_SCOPE_REQUIRED',
  'reviewedPlanHash',
  'INVENTORY_RECONCILIATION_CONFIRMATION',
  'approvalReference',
  'ACTOR_REQUIRED',
  'PLAN_MISMATCH',
  'AMBIGUOUS_SKU',
]);
includesAll('repair audit is required inside the same transaction', service, [
  'recordRequiredAuditEventInTransaction(tx',
  "eventType: 'inventory.cache_rebuilt'",
  'beforeStockQty',
  'authoritativeLedgerQty',
  'rollbackStockQty',
]);
check(
  'required audit helper propagates insert failures',
  audit.includes('recordRequiredAuditEventInTransaction') &&
    !/recordRequiredAuditEventInTransaction[\s\S]{0,400}catch/.test(audit),
);
check(
  'apply gate is declared default-off',
  /INVENTORY_RECONCILIATION_APPLY_ENABLED:\s*booleanFlag\(false\)/.test(env),
);
includesAll('admin route is a thin reconciliation caller', admin, [
  "'/reconcile-inventory-stock'",
  'buildInventoryReconciliationPlan(',
  'applyInventoryReconciliationPlan({',
  'env.INVENTORY_RECONCILIATION_APPLY_ENABLED',
]);
check(
  'admin route owns neither stock math nor ledger mutation',
  !admin.includes('applyInventoryMovementInTransaction') && !admin.includes('ledger_balance as ('),
);
check(
  'transaction-bound stock math is exported for the canonical repair owner',
  stockMath.includes('computeEffectiveStockForIdsInTransaction'),
);
includesAll('PS-427 placement and operational constraints are documented', docs, [
  'inventory_ledger` is authoritative',
  '`inventory.stockQty` is a cache',
  'deterministic plan hash',
  'default-off',
  'No production repair is part of PS-427 development or deployment',
]);

if (failures > 0) {
  console.error(`\nPS-427 inventory reconciliation guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}

console.log('\nPASS PS-427 inventory reconciliation guard');
