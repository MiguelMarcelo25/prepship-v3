/** PS-133 compatibility guard updated for PS-439's immutable signed ledger. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.VERCEL ??= '1';
process.env.DATABASE_URL ??= 'postgres://user:pass@localhost:5432/test';
process.env.SUPABASE_URL ??= 'http://localhost';

const { inventoryLedgerQuantity } = await import('../src/services/inventory-stock-math');
assert.equal(inventoryLedgerQuantity([{ qty: 10 }, { qty: -3 }, { qty: -3 }]), 4);
assert.equal(inventoryLedgerQuantity([{ qty: 10 }, { qty: -3 }, { qty: -2 }]), 5);
assert.equal(inventoryLedgerQuantity([{ qty: -2 }, { qty: 3 }]), 1);

const owner = readFileSync('src/services/inventory-stock-math.ts', 'utf8');
const inventoryRoute = readFileSync('src/routes/inventory.ts', 'utf8');
const dashboardRoute = readFileSync('src/routes/dashboard.ts', 'utf8');
assert.match(owner, /export function computeInventoryQuantityForIds/);
assert.match(owner, /sum\((?:movement|quantity_ledger)\.qty\)/);
assert.doesNotMatch(owner, /dedup|effectiveStock|stockQty/);
assert.match(inventoryRoute, /computeInventoryQuantityForIds/);
assert.match(dashboardRoute, /computeInventoryQuantityForIds/);

console.log('PASS PS-133 compatibility guard via PS-439 inventory quantity');
