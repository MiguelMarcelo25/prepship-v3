import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const operator = readFileSync('scripts/ps-462-inventory-preparation-operator.ts', 'utf8');
const rollback = readFileSync(
  'ops/rollback/ps-462_inventory_preparation_compatibility_rollback.sql',
  'utf8',
);
const runbook = readFileSync('docs/runbooks/ps-462-inventory-preparation.md', 'utf8');
const packageJson = readFileSync('package.json', 'utf8');

assert.match(operator, /set transaction read only/i);
assert.match(operator, /apply-ps-462-preparation-0075-0077/);
assert.match(operator, /rollback-ps-462-inventory-preparation-0075/);
assert.match(operator, /0077_ps462_billing_storage_month/);
assert.match(operator, /api-workers-stopped-inventory-auto-deduct-disabled/);
assert.match(operator, /set local lock_timeout = '5s'/i);
assert.match(operator, /set local statement_timeout = '60s'/i);
assert.match(operator, /assertDataUnchanged/);
assert.match(operator, /already_applied=true; no SQL executed/);
assert.doesNotMatch(operator, /--startup/);

assert.match(rollback, /PS462_PREPARATION_ROLLBACK_REQUIRES_PRE_CUTOVER/);
assert.match(rollback, /DROP TRIGGER IF EXISTS inventory_ledger_prepare_insert_guard/);
assert.match(rollback, /inventory_ledger_no_update_delete/);
assert.match(rollback, /inventory_ledger_no_truncate/);
assert.doesNotMatch(rollback, /^\s*(?:insert|update|delete|truncate)\b/im);
assert.doesNotMatch(rollback, /\b(?:orders|shipments)\b/i);

assert.match(runbook, /maintenance/i);
assert.match(runbook, /INVENTORY_AUTO_DEDUCT=false/);
assert.match(runbook, /auto-deploy is disabled/i);
assert.match(runbook, /do not push the production branch yet/i);
assert.match(runbook, /separate push approval/i);
assert.match(runbook, /backup|point-in-time recovery|PITR/i);
assert.match(runbook, /fresh read-only discrepancy report/i);
assert.match(runbook, /Do not reopen traffic after phase 1/i);
assert.match(runbook, /correction and `0076` procedures in the same/i);
assert.match(runbook, /Do not apply 0076/i);
assert.match(runbook, /Do not apply the correction/i);
assert.match(runbook, /migrate:ps-462-inventory-preparation/);
assert.match(runbook, /rollback:ps-462-inventory-preparation/);
assert.match(runbook, /PS462_PREPARATION_DATA_CHANGED/);

assert.match(packageJson, /"migrate:ps-462-inventory-preparation"/);
assert.match(packageJson, /"rollback:ps-462-inventory-preparation"/);
assert.match(packageJson, /"test:ps-462-inventory-preparation-rollout"/);

console.log('PASS PS-462 inventory preparation operator/runbook static guard');
