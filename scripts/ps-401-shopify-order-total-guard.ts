import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolveImportedOrderTotal } from '../src/services/store-order-import';

function read(path: string): string {
  assert(existsSync(path), `missing ${path}`);
  return readFileSync(path, 'utf8');
}

const importer = read('src/services/store-order-import.ts');
const packageJson = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };

assert(
  importer.includes('resolveImportedOrderTotal'),
  'store-order-import must own imported order total resolution',
);
assert(
  importer.includes('loadExistingOrderTotalsForImport(rows)'),
  'store-order-import must load existing totals before provider zero can overwrite them',
);
assert(
  importer.includes('[store-order-import] corrected') && importer.includes('suspicious zero order total'),
  'store-order-import must log redacted suspicious-zero correction counts',
);
assert.equal(
  packageJson.scripts?.['test:ps-401-shopify-order-total'],
  'tsx scripts/ps-401-shopify-order-total-guard.ts',
  'package.json must expose the PS-401 order total guard',
);
assert.equal(
  packageJson.scripts?.['shopify-order-total:dry-run'],
  'tsx scripts/ps-401-shopify-order-total-reconcile.ts',
  'package.json must expose the PS-401 order total reconciliation dry run',
);
assert.equal(
  packageJson.scripts?.['shopify-order-total:apply'],
  'tsx scripts/ps-401-shopify-order-total-reconcile.ts --apply',
  'package.json must expose the explicit PS-401 order total reconciliation apply command',
);

const providerPositive = resolveImportedOrderTotal({
  incomingOrderTotal: '146.22',
  items: [{ sku: 'HU-10', quantity: 1, unitPrice: 98.55 }],
  raw: { orderTotal: 146.22 },
  orderStatus: 'awaiting_shipment',
});
assert.equal(providerPositive.orderTotal, '146.22');
assert.equal(providerPositive.source, 'provider_order_total');
assert.equal(providerPositive.suspiciousZero, false);

const shopifyCurrentWins = resolveImportedOrderTotal({
  incomingOrderTotal: '0.00',
  items: [{ sku: 'Booster-gel-001', quantity: 2, unitPrice: 49.27 }],
  rawSourcePayload: {
    current_total_price: '98.55',
    total_price: '111.11',
  },
  orderStatus: 'awaiting_shipment',
});
assert.equal(shopifyCurrentWins.orderTotal, '98.55');
assert.equal(shopifyCurrentWins.source, 'shopify_current_total');

const shipStationZeroWithItems = resolveImportedOrderTotal({
  incomingOrderTotal: '0.00',
  items: [
    { sku: 'Booster-gel-001', quantity: 1, unitPrice: 49.28 },
    { sku: 'HU-10', quantity: 1, unitPrice: 49.27 },
  ],
  raw: { orderTotal: 0 },
  orderStatus: 'awaiting_shipment',
});
assert.equal(shipStationZeroWithItems.orderTotal, '98.55');
assert.equal(shipStationZeroWithItems.source, 'item_subtotal_fallback');
assert.equal(shipStationZeroWithItems.suspiciousZero, true);

const existingPositiveBeatsBadZero = resolveImportedOrderTotal({
  incomingOrderTotal: '0.00',
  existingOrderTotal: '231.37',
  items: [{ sku: 'SKU-1', quantity: 1, unitPrice: 10 }],
  raw: { orderTotal: 0 },
  orderStatus: 'awaiting_shipment',
});
assert.equal(existingPositiveBeatsBadZero.orderTotal, '231.37');
assert.equal(existingPositiveBeatsBadZero.source, 'existing_positive_preserved');
assert.equal(existingPositiveBeatsBadZero.preservedExistingPositive, true);

const missingTotalPreservesExisting = resolveImportedOrderTotal({
  incomingOrderTotal: null,
  existingOrderTotal: '167.52',
  items: [],
  raw: {},
  orderStatus: 'awaiting_shipment',
});
assert.equal(missingTotalPreservesExisting.orderTotal, '167.52');
assert.equal(missingTotalPreservesExisting.source, 'existing_positive_preserved');

const freeTestOrderStaysZero = resolveImportedOrderTotal({
  incomingOrderTotal: '0.00',
  items: [{ sku: 'TEST-SKU', quantity: 1, unitPrice: 99 }],
  raw: { test: true, orderTotal: 0 },
  orderStatus: 'awaiting_shipment',
});
assert.equal(freeTestOrderStaysZero.orderTotal, '0.00');
assert.equal(freeTestOrderStaysZero.source, 'zero_proven');
assert.equal(freeTestOrderStaysZero.suspiciousZero, false);

const fullyDiscountedShopifyOrderStaysZero = resolveImportedOrderTotal({
  incomingOrderTotal: '0.00',
  items: [{ sku: 'PROMO-SKU', quantity: 2, unitPrice: 50 }],
  rawSourcePayload: {
    current_total_price: '0.00',
    current_total_discounts: '100.00',
  },
  orderStatus: 'awaiting_shipment',
});
assert.equal(fullyDiscountedShopifyOrderStaysZero.orderTotal, '0.00');
assert.equal(fullyDiscountedShopifyOrderStaysZero.source, 'zero_proven');

console.log('PASS PS-401 Shopify-backed imported order total guard');
