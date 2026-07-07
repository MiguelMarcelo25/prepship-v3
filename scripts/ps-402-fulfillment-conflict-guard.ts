import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveFulfillmentConflict } from '../src/services/fulfillment-conflict';
import { resolveBillingRowStatus } from '../src/services/billing-row-status';
import { toBillingDetailOrderRows } from '../src/services/billing-detail-row-sot';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

check('PS-402 fixture: #1424 cancelled with marketplace fulfilled marker becomes fulfillment conflict', () => {
  const conflict = resolveFulfillmentConflict({
    orderId: 1424,
    orderNumber: '1424',
    orderStatus: 'cancelled',
    canonicalStatus: 'cancelled',
    sourceProvider: 'shipstation',
    externallyShippedSource: 'marketplace_fulfilled',
    marketplaceName: 'Shopify',
    hasLocalShipment: false,
    marketplaceTrackingNumber: '1ZR05H190309705889',
    trackingAttachedOrderId: 1426,
    trackingAttachedOrderNumber: '1426',
    upstreamOrderMissing: true,
  });

  assert.ok(conflict);
  assert.equal(conflict.code, 'marketplace_fulfilled_local_cancelled');
  assert.ok(conflict.codes.includes('marketplace_fulfilled_missing_local_shipment'));
  assert.ok(conflict.codes.includes('marketplace_tracking_attached_to_other_order'));
  assert.ok(conflict.codes.includes('upstream_order_missing_after_marketplace_fulfilled'));
  assert.equal(conflict.billingAction, 'shipping_missing_review');
  assert.match(conflict.label, /Shopify delivered but PrepShip cancelled/);
});

check('normal cancelled order without marketplace fulfillment evidence remains non-conflict', () => {
  const conflict = resolveFulfillmentConflict({
    orderId: 2222,
    orderNumber: '2222',
    orderStatus: 'cancelled',
    canonicalStatus: 'cancelled',
    hasLocalShipment: false,
  });
  assert.equal(conflict, null);
});

check('fulfilled marketplace order with verified local shipment does not require missing-shipping billing action', () => {
  const conflict = resolveFulfillmentConflict({
    orderId: 1424,
    orderNumber: '1424',
    orderStatus: 'cancelled',
    externallyShippedSource: 'marketplace_fulfilled',
    hasLocalShipment: true,
  });
  assert.ok(conflict);
  assert.equal(conflict.billingAction, null);
});

check('Billing status owner lets fulfillment conflict win over cancelled no-charge', () => {
  const status = resolveBillingRowStatus({
    lineType: 'shipping_missing',
    orderStatus: 'cancelled',
    orderLifecycleStatus: 'cancelled',
    fulfillmentConflictCode: 'marketplace_fulfilled_local_cancelled',
    shippingZeroNeedsReview: true,
  });
  assert.equal(status.billingLifecycleStatus, 'fulfillment_conflict');
  assert.equal(status.billingStatusLabel, 'Fulfillment conflict');
  assert.equal(status.billingZeroReason, 'fulfillment_conflict');
  assert.equal(status.billingStatusBadge, 'REVIEW');
});

check('Billing detail aggregation preserves conflict review instead of cancelled no-charge cleanup', () => {
  const [row] = toBillingDetailOrderRows([
    {
      lineType: 'shipping_missing',
      orderId: 1424,
      orderNumber: '1424',
      orderStatus: 'cancelled',
      orderLifecycleStatus: 'cancelled',
      billingLifecycleStatus: 'fulfillment_conflict',
      billingStatusLabel: 'Fulfillment conflict',
      billingStatusTone: 'amber',
      billingZeroReason: 'fulfillment_conflict',
      billingStatusBadge: 'REVIEW',
      fulfillmentConflictCode: 'marketplace_fulfilled_local_cancelled',
      fulfillmentConflictLabel: 'Fulfillment conflict / Shopify delivered but PrepShip cancelled',
      fulfillmentConflictReason: 'Shopify fulfillment evidence exists, but PrepShip has no verified local shipment for this cancelled order.',
      shippingCostMissing: true,
      qty: '1',
      totalCost: '0.00',
    },
  ]);

  assert.ok(row);
  assert.equal(row.billingLifecycleStatus, 'fulfillment_conflict');
  assert.equal(row.fulfillmentConflictCode, 'marketplace_fulfilled_local_cancelled');
  assert.equal(row.shippingCostMissing, true);
  assert.notEqual(row.billingStatusBadge, 'CANCELLED');
});

check('Orders route delegates conflict detection to backend read model', () => {
  const route = read('src/routes/orders.ts');
  assert.match(route, /resolveFulfillmentConflict/);
  assert.match(route, /fulfillmentConflict/);
  assert.match(route, /shipmentTrackingCollisions/);
});

check('Orders UI renders backend conflict DTO instead of only cancelled status', () => {
  const hook = read('web/src/hooks/useOrders.ts');
  const cell = read('web/src/components/Views/OrdersTableCells.tsx');
  assert.match(hook, /fulfillmentConflict/);
  assert.match(cell, /fulfillmentConflictLabel/);
  assert.match(cell, />\s*Conflict\s*</);
});

check('Billing generation bypasses cancelled collapse for fulfillment conflicts', () => {
  const billing = read('src/services/billing.ts');
  assert.match(billing, /fulfillmentConflict\?\.billingAction === 'shipping_missing_review'/);
  assert.match(billing, /!fulfillmentConflict &&/);
  assert.match(billing, /Fulfillment conflict - reconcile verified outbound shipment/);
});

