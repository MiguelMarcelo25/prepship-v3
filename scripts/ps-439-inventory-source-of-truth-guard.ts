import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeSkuStorageCuFtDays } from '../src/services/billing-storage';

process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
process.env.SUPABASE_URL = 'https://example.test';
process.env.SUPABASE_ANON_KEY = 'test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
process.env.SUPABASE_JWT_SECRET = 'test';
process.env.NODE_ENV = 'test';
const { inventoryLedgerQuantity } = await import('../src/services/inventory-stock-math');

const read = (path: string) => readFileSync(path, 'utf8');

assert.equal(inventoryLedgerQuantity([{ qty: 5 }, { qty: -8 }]), -3, 'negative ledger balances stay visible');
assert.equal(inventoryLedgerQuantity([{ qty: 5 }, { qty: -8 }, { qty: 4 }]), 1, 'later receive adds to the same signed history');
assert.equal(inventoryLedgerQuantity([{ qty: -2 }, { qty: -2 }]), -4, 'every persisted movement is summed without read-time dedupe');

const storage = computeSkuStorageCuFtDays({
  inventoryId: 1,
  sku: 'PS439',
  cuFtPerUnit: 1,
  periodStart: '2026-01-01T00:00:00Z',
  periodEnd: '2026-02-01T00:00:00Z',
  movements: [
    { type: 'ship', qty: -2, orderId: 1, effectiveAt: '2026-01-01T00:00:00Z' },
    { type: 'receive', qty: 3, orderId: null, effectiveAt: '2026-01-11T00:00:00Z' },
  ],
});
assert.equal(storage.hadNegativeBalance, true);
assert.equal(storage.segments[0]?.balance, -2);
assert.equal(storage.segments[0]?.billedQty, 0, 'only storage charging clamps negatives');
assert.equal(storage.cuFtDays, 21, 'actual January days after the receive are billed');

const migration = read('drizzle/0073_inventory_quantity_sot.sql');
const schema = read('src/db/schema/inventory.ts');
const movementOwner = read('src/services/inventory-movement.ts');
const quantityOwner = read('src/services/inventory-stock-math.ts');
const inventoryRoute = read('src/routes/inventory.ts');
const fulfillment = read('src/services/fulfillment-deductions.ts');
const adminRoute = read('src/routes/admin.ts');
const uiAdapter = read('web/src/hooks/useInventory.ts');
const uiHelpers = read('web/src/components/Views/inventory-stock-helpers.ts');
const inventoryView = read('web/src/components/Views/InventoryView.tsx');

assert.match(migration, /PS439_INVENTORY_CUTOVER_BLOCKED/);
assert.match(migration, /inventory_ledger_no_update_delete/);
assert.match(migration, /inventory_ledger_no_truncate/);
assert.match(migration, /DROP COLUMN IF EXISTS stock_qty/);
assert.match(migration, /inventory_ledger_source_identity_unq/);
assert.match(migration, /inventory_ledger_nonzero_qty_chk/);
assert.doesNotMatch(schema, /stockQty:/);
assert.match(schema, /sourceEntity: text\('source_entity'\)/);
assert.match(movementOwner, /onConflictDoNothing\(\)/);
assert.match(movementOwner, /INVENTORY_IDEMPOTENCY_CONFLICT/);
assert.doesNotMatch(movementOwner, /update\(inventory\)[\s\S]{0,200}stockQty/);
assert.match(quantityOwner, /sum\(movement\.qty\)/);
assert.doesNotMatch(quantityOwner, /orderItems|orders|stockQty|effectiveStock/);
assert.match(inventoryRoute, /atomic: true/);
assert.match(inventoryRoute, /db\.transaction\(async \(tx\)/);
assert.match(fulfillment, /Per user override unlock shipped data on 2026-07-21/);
assert.match(fulfillment, /isInventoryAutoDeductEnabled/);
assert.match(fulfillment, /applyInventoryMovementInTransaction/);
assert.match(adminRoute, /PS439_IMMUTABLE_HISTORY/);
assert.doesNotMatch(adminRoute, /truncate table inventory_ledger/i);
assert.doesNotMatch(uiAdapter, /stockQty|currentStock|effectiveStock|displayStock/);
assert.match(uiHelpers, /row\.inventoryQuantity/);
assert.doesNotMatch(uiHelpers, /classifyStockStatus/);
assert.match(inventoryRoute, /body\.idempotencyKey/);
assert.match(inventoryView, /receiveSubmissionIdentity/);

console.log('PASS PS-439 inventory source-of-truth guard');
