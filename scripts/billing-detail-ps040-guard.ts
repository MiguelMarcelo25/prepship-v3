import {
  buildBillingShipmentRepairPlan,
  summarizeBillingItemsForDetail,
} from '../src/services/billing-detail-utils';

function fail(message: string): never {
  throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    fail(`${message}: expected ${expected}, got ${actual}`);
  }
  console.log(`PASS ${message}`);
}

function summary(items: unknown[]) {
  return summarizeBillingItemsForDetail(items);
}

assertEqual(
  summary([{ name: 'Leeds Line V2', sku: 'HU-10', quantity: 1 }]).itemNames,
  'Leeds Line V2',
  'single item qty 1 has no item suffix',
);

assertEqual(
  summary([{ name: 'Booster Gel', sku: 'Booster-gel-001', quantity: 2 }]).itemSkus,
  'Booster-gel-001 x2',
  'single item qty 2 has SKU suffix',
);

const mixed = summary([
  { name: 'Leeds Line V2', sku: 'HU-10', quantity: 1 },
  { name: 'Booster Gel', sku: 'Booster-gel-001', quantity: 2 },
]);
assertEqual(
  mixed.itemNames,
  'Leeds Line V2\nBooster Gel x2',
  'mixed SKU summary suffixes only qty greater than 1',
);
assertEqual(mixed.totalQty, 3, 'mixed SKU total quantity remains billable units');

const duplicate = summary([
  { name: 'Booster Gel', sku: 'Booster-gel-001', quantity: 1 },
  { name: 'Booster Gel', sku: 'Booster-gel-001', quantity: 2 },
  { name: 'Discount', sku: 'DISC', quantity: 1, adjustment: true },
]);
assertEqual(
  duplicate.itemNames,
  'Booster Gel x3',
  'duplicate SKU lines aggregate and adjustment rows are skipped',
);
assertEqual(
  duplicate.itemSkus,
  'Booster-gel-001 x3',
  'duplicate SKU aggregation also applies to SKU display',
);
assertEqual(duplicate.totalQty, 3, 'duplicate SKU quantity excludes adjustment rows');

const repair = buildBillingShipmentRepairPlan([
  {
    billingLineItemId: 501,
    orderId: 1026,
    orderNumber: '1026',
    lineType: 'pick_pack',
    description: 'Pick/pack for order 1026',
    currentShipmentId: null,
    matchingShipmentId: 24751,
    carrierCode: 'ups',
    cost: '10.79',
    dimsL: 12,
    dimsW: 10,
    dimsH: 3,
    lineHasManualInvoiceLock: false,
  },
  {
    billingLineItemId: 502,
    orderId: 1003,
    orderNumber: '1003',
    lineType: 'shipping',
    description: 'Shipping · order 1003',
    currentShipmentId: 24739,
    matchingShipmentId: 24739,
    carrierCode: 'ups',
    cost: '10.79',
    dimsL: 12,
    dimsW: 10,
    dimsH: 3,
    lineHasManualInvoiceLock: false,
  },
]);

assertEqual(repair.scanned, 2, 'repair plan scans all candidate rows');
assertEqual(repair.actions.length, 1, 'repair plan only includes stale null-shipment rows');
assertEqual(repair.actions[0]?.action, 'update_shipment_id', 'repair action updates shipment id only');
assertEqual(repair.actions[0]?.billingLineItemId, 501, 'repair action reports exact billing row id');
assertEqual(repair.actions[0]?.matchingShipmentId, 24751, 'repair action reports exact shipment id');
