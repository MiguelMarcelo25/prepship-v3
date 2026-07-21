/** PS-450 static placement and safety proof. No database or provider access. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(path, 'utf8');
const report = read('src/services/fulfillment/inventory-deduction-report.ts');
const reportCli = read('scripts/report-inventory-deductions.ts');
const deductionOutbox = read('src/services/fulfillment/inventory-deduction-outbox.ts');
const deductions = read('src/services/fulfillment-deductions.ts');
const outbox = read('src/services/fulfillment/outbox.ts');
const lifecycleIntegration = read('scripts/ps-424-order-lifecycle-command-integration.ts');
const scheduler = read('src/services/sync-job-queue.ts');
const packageJson = read('package.json');
const guardPack = read('scripts/sot-guard-pack.mjs');

assert.match(report, /WHERE event_type = \$\{INVENTORY_DEDUCTION_REPORT_EVENT\}/);
assert.match(report, /status IN \('pending', 'processing', 'failed'\)/);
assert.match(report, /parked_kill_switch/);
assert.match(report, /inventoryAutoDeductEnabled/);
assert.doesNotMatch(report, /\b(?:UPDATE|DELETE|INSERT INTO)\b/i);
assert.match(reportCli, /env\.INVENTORY_AUTO_DEDUCT/);
assert.match(reportCli, /No order, shipment, inventory, ledger, outbox, label, or provider state is changed/);

const claimOwnerStart = deductions.indexOf('export async function applyInventoryClaimsForLifecycleEvent');
const claimOwnerEnd = deductions.indexOf('export async function deductInventoryForOrder', claimOwnerStart);
const claimOwner = deductions.slice(claimOwnerStart, claimOwnerEnd);
assert.ok(claimOwnerStart >= 0 && claimOwnerEnd > claimOwnerStart);
assert.ok(
  claimOwner.indexOf('if (!isInventoryAutoDeductEnabled())') < claimOwner.indexOf('return conn.transaction'),
  'kill switch must return before the inventory transaction can write',
);
assert.match(claimOwner, /return \{ applied: 0, alreadyApplied: 0, lockedDown: true \}/);
assert.match(deductionOutbox, /if \(result\.lockedDown\)[\s\S]*throw new Error\('INVENTORY_AUTO_DEDUCT is disabled/);
assert.match(outbox, /status IN \('pending', 'failed'\)[\s\S]*next_run_at <= NOW\(\)/);
assert.match(outbox, /status = 'processing'[\s\S]*updated_at < NOW\(\) -/);

const settleStart = outbox.indexOf('async function settleOutboxRowWithExecutor');
const failEnd = outbox.indexOf('// Per user override unlock shipped data on 2026-06-13', settleStart);
const inventorySettlement = outbox.slice(settleStart, failEnd);
assert.match(inventorySettlement, /if \(isInventoryDeductionOutboxEvent\(row\.event_type\)\) return;/g);
assert.match(lifecycleIntegration, /concurrent worker retry applies inventory once/);
assert.match(lifecycleIntegration, /worker retry is idempotent at the exact claim ledger key/);
assert.match(scheduler, /singletonKey/);
assert.match(scheduler, /boss\.schedule/);

assert.match(packageJson, /"inventory:deduction-report"\s*:\s*"tsx scripts\/report-inventory-deductions\.ts"/);
assert.match(packageJson, /"test:ps-450-inventory-outbox"[\s\S]*ps-450-inventory-outbox-integration/);
assert.match(guardPack, /'test:ps-450-inventory-outbox'/);

console.log('PASS PS-450 inventory outbox placement + safety guard');
