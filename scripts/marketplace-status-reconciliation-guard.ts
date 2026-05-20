import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  aggregateMarketplaceOrderStatus,
  normalizeMarketplaceOrderStatus,
  shouldUpdateMarketplaceOrderStatus,
} from '../api/_lib/marketplace-status-reconciliation.ts';

assert.equal(normalizeMarketplaceOrderStatus('walmart', 'Shipped'), 'shipped');
assert.equal(normalizeMarketplaceOrderStatus('walmart', 'Delivered'), 'shipped');
assert.equal(normalizeMarketplaceOrderStatus('walmart', 'Acknowledged'), 'awaiting_shipment');
assert.equal(normalizeMarketplaceOrderStatus('walmart', 'Created'), 'awaiting_shipment');
assert.equal(normalizeMarketplaceOrderStatus('walmart', 'Cancelled'), 'cancelled');
assert.equal(normalizeMarketplaceOrderStatus('walmart', 'Canceled'), 'cancelled');

assert.equal(normalizeMarketplaceOrderStatus('ebay', 'FULFILLED'), 'shipped');
assert.equal(normalizeMarketplaceOrderStatus('ebay', 'NOT_STARTED'), 'awaiting_shipment');
assert.equal(normalizeMarketplaceOrderStatus('ebay', 'IN_PROGRESS'), 'awaiting_shipment');
assert.equal(normalizeMarketplaceOrderStatus('ebay', 'CANCELED'), 'cancelled');

assert.equal(
  aggregateMarketplaceOrderStatus(['Shipped', 'Acknowledged'], 'walmart'),
  'awaiting_shipment',
  'mixed Walmart statuses must stay awaiting until every line/order is terminal',
);
assert.equal(
  aggregateMarketplaceOrderStatus(['Shipped', 'Shipped'], 'walmart'),
  'shipped',
  'all shipped Walmart rows should reconcile to shipped',
);
assert.equal(
  aggregateMarketplaceOrderStatus(['FULFILLED', 'FULFILLED'], 'ebay'),
  'shipped',
  'all fulfilled eBay rows should reconcile to shipped',
);

assert.equal(shouldUpdateMarketplaceOrderStatus('awaiting_shipment', 'shipped'), true);
assert.equal(shouldUpdateMarketplaceOrderStatus('awaiting_shipment', 'cancelled'), true);
assert.equal(shouldUpdateMarketplaceOrderStatus('awaiting_shipment', 'awaiting_shipment'), false);
assert.equal(shouldUpdateMarketplaceOrderStatus('shipped', 'cancelled'), false);
assert.equal(shouldUpdateMarketplaceOrderStatus('cancelled', 'shipped'), false);

const script = readFileSync('scripts/reconcile-marketplace-order-status.ts', 'utf8');
assert.match(script, /dryRun:\s*!apply/);
assert.match(script, /Only orders currently awaiting_shipment can be updated/);
assert.match(script, /marketplace:reconcile:apply/);
assert.match(script, /--provider ebay --order-number 12-14640-05489/);
assert.match(
  script,
  /Synthetic marketplace rows are reconciled only when no real ShipStation row owns the order number/,
);

const reconciliationSource = readFileSync('api/_lib/marketplace-status-reconciliation.ts', 'utf8');
assert.match(reconciliationSource, /synthetic marketplace row/i);
assert.ok(
  reconciliationSource.includes('external_order_id LIKE ${syntheticPrefix}'),
  'direct marketplace synthetic rows must be eligible when no real ShipStation row owns the order number',
);

for (const file of ['api/carriers/walmart/orders.ts', 'api/carriers/ebay/orders.ts']) {
  const source = readFileSync(file, 'utf8');
  assert.match(source, /hasExistingMarketplaceOrderRow/);
  assert.match(source, /reconcileMarketplaceOrderStatuses/);
  assert.match(source, /skippedSyntheticMirrors/);
}

console.log('marketplace status reconciliation guard passed');
