import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rollback = readFileSync('ops/rollback/ps-462_inventory_quantity_forward_rollback.sql', 'utf8');

assert.match(rollback, /PS462_FORWARD_ROLLBACK_REQUIRES_0074/);
assert.match(rollback, /ADD COLUMN IF NOT EXISTS stock_qty integer/);
assert.match(rollback, /COALESCE\(SUM\(qty\), 0\)::int AS quantity/);
assert.match(rollback, /PS462_FORWARD_ROLLBACK_PARITY_FAILED/);
assert.match(rollback, /inventory_ledger_no_update_delete/);
assert.match(rollback, /inventory_ledger_no_truncate/);
assert.match(rollback, /legacy_inventory_runtime/);
assert.match(rollback, /inventory:opening:inventory:/);
assert.doesNotMatch(rollback, /UPDATE\s+public\.inventory_ledger/i);
assert.doesNotMatch(rollback, /DELETE\s+FROM\s+public\.inventory_ledger/i);
assert.doesNotMatch(rollback, /TRUNCATE\s+(TABLE\s+)?public\.inventory_ledger/i);
assert.doesNotMatch(rollback, /\b(orders|shipments)\b/i);

console.log('PASS PS-462 inventory forward-rollback static guard');
