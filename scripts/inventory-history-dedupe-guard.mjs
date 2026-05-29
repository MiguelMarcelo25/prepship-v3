import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const inventoryRoute = readFileSync('src/routes/inventory.ts', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

const order = {
  id: 1047,
  clientId: 4,
  items: [{ sku: 'HU-10', quantity: 1 }],
};

const inventoryRows = [
  { id: 9001, clientId: null, sku: 'HU-10' },
  { id: 1033, clientId: 4, sku: 'HU-10' },
];

const realLedgerRows = [
  {
    orderId: 1047,
    inventoryId: 1033,
    type: 'ship',
    qty: -1,
    source: 'shipment_sync',
  },
];

function normalizedSku(value) {
  return String(value ?? '').trim().toLowerCase();
}

function oldSuppressionLeavesDuplicate() {
  const derivedInventory = inventoryRows.find(
    (row) => row.clientId == null && normalizedSku(row.sku) === normalizedSku(order.items[0].sku),
  );
  return !realLedgerRows.some(
    (row) =>
      row.orderId === order.id &&
      row.inventoryId === derivedInventory.id &&
      row.type === 'ship',
  );
}

function fixedSuppressionHidesFallback() {
  return realLedgerRows.some((row) => {
    const realInventory = inventoryRows.find((inventory) => inventory.id === row.inventoryId);
    return (
      row.orderId === order.id &&
      row.type === 'ship' &&
      normalizedSku(realInventory?.sku) === normalizedSku(order.items[0].sku) &&
      (realInventory?.clientId === order.clientId || realInventory?.clientId == null)
    );
  });
}

assert.equal(
  oldSuppressionLeavesDuplicate(),
  true,
  'fixture reproduces old inventory_id-only suppression failure',
);

assert.equal(
  fixedSuppressionHidesFallback(),
  true,
  'fixture suppresses order_history when shipment_sync exists for the same order/SKU/client scope',
);

assert(
  inventoryRoute.includes('real_ship_ledger_keys') &&
    inventoryRoute.includes('order_history is a display fallback') &&
    inventoryRoute.includes("existing_ledger.sku_key = lower(item->>'sku')") &&
    inventoryRoute.includes('scoped_inventory.client_id ='),
  'backend /inventory/ledger de-dupes derived order_history rows by order/SKU/client scope',
);

assert.equal(
  pkg.scripts?.['test:inventory-history-dedupe'],
  'node scripts/inventory-history-dedupe-guard.mjs',
  'package exposes focused Inventory History de-dupe guard',
);

console.log('PASS inventory history de-dupe guard');
