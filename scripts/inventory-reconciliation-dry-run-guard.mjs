import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const report = readFileSync('scripts/ps-439-inventory-discrepancy-report.ts', 'utf8');
assert.equal(pkg.scripts?.['inventory:reconcile:dry-run'], 'tsx scripts/ps-439-inventory-discrepancy-report.ts');
assert.equal(pkg.scripts?.['test:inventory-reconciliation-dry-run'], 'tsx scripts/ps-439-inventory-discrepancy-report.ts --self-test');
for (const category of [
  'balance_mismatch', 'missing_movement', 'duplicate_ship_deduction',
  'direct_stock_write', 'negative_balance', 'case_variant_sku_collision',
  'missing_volume', 'duplicate_storage_line', 'billing_display_mismatch',
]) assert.match(report, new RegExp(category));
assert.match(report, /read-only; --apply is not supported/i);
console.log('PASS legacy reconciliation guard delegates to PS-439 discrepancy audit');
