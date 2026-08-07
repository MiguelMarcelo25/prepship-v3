import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ORDER_RAW_PAYLOAD_POLICY_VERSION,
  retainOrderRawForPersistence,
  retainOrderRawSourcePayloadForPersistence,
} from '../src/services/order-raw-payload-policy';

function read(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

const shipStationRaw = {
  orderId: 123,
  // PS-491: ShipStation reassigns orderId across an edit/re-create; orderKey is its own
  // key for the order and is the evidence a corrected identity rule needs.
  orderKey: 'ss-order-key-abc',
  orderNumber: 'SS-123',
  orderStatus: 'shipped',
  shipDate: '2026-07-14',
  fulfilledAt: '2026-07-14T12:00:00Z',
  shippedAt: '2026-07-14T12:00:00Z',
  customerUsername: 'buyer-123',
  shipTo: {
    name: 'Test Recipient',
    company: 'Test Co',
    street1: '123 Test St',
    street2: 'Suite 4',
    city: 'Austin',
    state: 'TX',
    postalCode: '78701',
    country: 'US',
    phone: '555-0100',
    residential: true,
    addressVerified: 'Address validated successfully',
  },
  dimensions: { length: 10, width: 8, height: 4, units: 'inches' },
  advancedOptions: {
    storeId: 456,
    nonMachinable: false,
    customField1: 'x'.repeat(4_000),
    // PS-491: the split/merge discriminator.
    mergedOrSplit: true,
    parentId: 98765,
    mergedIds: [11, 22],
  },
  requestedShippingService: 'UPS 2nd Day Air',
  serviceCode: 'ups_2nd_day_air',
  packageCode: 'package',
  insuranceOptions: { provider: 'carrier', insureShipment: true, insuredValue: 100 },
  internationalOptions: { contents: 'merchandise' },
  externallyFulfilled: true,
  test: true,
  items: Array.from({ length: 20 }, (_, index) => ({
    lineItemKey: `line-${index}`,
    sku: `SKU-${index}`,
    imageUrl: `https://example.test/${'x'.repeat(500)}`,
  })),
  billTo: { name: 'Billing Name', street1: 'Sensitive billing address' },
  weight: { value: 16, units: 'ounces' },
  internalNotes: 'x'.repeat(2_000),
};

const retainedShipStation = retainOrderRawForPersistence({
  sourceProvider: 'ShipStation',
  raw: shipStationRaw,
});

assert.equal(retainedShipStation.rawPayloadPolicyVersion, ORDER_RAW_PAYLOAD_POLICY_VERSION);
for (const key of [
  'shipTo',
  'dimensions',
  'requestedShippingService',
  'serviceCode',
  'packageCode',
  'insuranceOptions',
  'internationalOptions',
  'customerUsername',
  'externallyFulfilled',
  'orderId',
  'orderKey',
  'orderStatus',
  'shipDate',
  'fulfilledAt',
  'shippedAt',
  'test',
]) {
  assert.deepEqual(retainedShipStation[key], shipStationRaw[key as keyof typeof shipStationRaw], `${key} remains available`);
}

// PS-491. Two `orders` rows sharing an order number are either one order ingested twice
// (a bug) or a real ShipStation split (two shipments, correctly billed twice). Nothing on
// the order row separates them — 354 of 369 duplicate groups in production match on
// provider, account, store, order date AND ship-to postal. ShipStation says which it is in
// these three fields, and the policy used to drop all of them, so the question could not
// be answered from stored data at all. They must survive the projection.
assert.deepEqual(retainedShipStation.advancedOptions, {
  storeId: 456,
  mergedOrSplit: true,
  parentId: 98765,
  mergedIds: [11, 22],
}, 'split/merge provenance survives the bounded projection');
assert.equal(
  (retainedShipStation.advancedOptions as Record<string, unknown>).customField1,
  undefined,
  'unbounded operator text is still dropped — the projection stays small',
);

// A ShipStation order with no advancedOptions at all must not gain an empty object.
assert.equal(
  'advancedOptions' in retainOrderRawForPersistence({
    sourceProvider: 'shipstation',
    raw: { orderId: 1, orderNumber: 'n' },
  }),
  false,
  'absent advancedOptions stays absent',
);
for (const omitted of ['items', 'billTo', 'weight', 'internalNotes']) {
  assert.equal(omitted in retainedShipStation, false, `${omitted} is not duplicated in orders.raw`);
}
assert.ok(
  JSON.stringify(retainedShipStation).length < JSON.stringify(shipStationRaw).length * 0.4,
  'the bounded ShipStation projection materially shrinks a representative payload',
);
assert.deepEqual(
  retainOrderRawForPersistence({ sourceProvider: 'shipstation', raw: retainedShipStation }),
  retainedShipStation,
  'the policy is idempotent for compaction retries',
);

const directMarketplaceRaw = {
  purchaseOrderId: 'WM-123',
  lineItems: [{ lineItemId: 'line-1', quantity: 1 }],
  fulfillmentOrders: [{ id: 'gid://shopify/FulfillmentOrder/123', status: 'OPEN' }],
};
assert.deepEqual(
  retainOrderRawForPersistence({ sourceProvider: 'walmart', raw: directMarketplaceRaw }),
  directMarketplaceRaw,
  'direct marketplace confirmation/fulfillment payloads remain complete in the single retained raw copy',
);
assert.equal(
  retainOrderRawSourcePayloadForPersistence(directMarketplaceRaw),
  null,
  'raw_source_payload never stores a second exact provider-payload copy',
);

const importer = read('src/services/store-order-import.ts');
const compactor = read('scripts/compact-orders-raw-payloads.ts');
const packageJson = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
const doc = read('docs/ps-tickets/audit-5.6-orders-raw-payload-policy.md');
const sourceOfTruthMatrix = read('docs/architecture-debt/source-of-truth-matrix.md');
const audit = read('AUDIT-2026-07-13.md');

assert.match(importer, /retainOrderRawForPersistence/);
assert.match(importer, /retainOrderRawSourcePayloadForPersistence/);
assert.match(importer, /Per user override unlock shipped data on 2026-07-15/);
assert.match(compactor, /const apply = hasFlag\('apply'\)/);
assert.match(compactor, /--confirm=compact-orders-raw/);
assert.match(compactor, /raw_source_payload = null/);
assert.match(compactor, /order_status/);
assert.match(sourceOfTruthMatrix, /bounded one-copy `raw` policy/);
assert.match(sourceOfTruthMatrix, /raw_source_payload` is not a second copy/);
assert.equal(
  packageJson.scripts?.['orders-raw:compact:dry-run'],
  'tsx scripts/compact-orders-raw-payloads.ts',
);
assert.equal(
  packageJson.scripts?.['orders-raw:compact:apply'],
  'tsx scripts/compact-orders-raw-payloads.ts --apply --confirm=compact-orders-raw',
);

for (const field of [
  'Business rule/workflow being changed',
  'Canonical backend/domain/read-model/policy owner',
  'Current duplicated/unsafe owners',
  'Where bad/stale/incomplete data can enter',
  'Callers that must delegate to the owner',
  'Wrapper/resolver/helper logic to delete or explicitly forbid',
  'Frontend role: display/action only; no authoritative business logic',
  'Backend boundary tests required',
  'Workflow/UI proof required',
]) {
  assert.ok(doc.includes(field), `placement record includes ${field}`);
}
assert.match(
  audit,
  /- \[x\] 5\.6 \*\*`orders\.raw` bounded payload policy complete\*\*/,
  'canonical audit checklist marks 5.6 complete',
);

console.log('PASS Audit 5.6 orders.raw payload policy guard');
