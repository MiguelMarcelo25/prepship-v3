import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { buildNormalizedOrderSource } from '../src/services/normalized-order-persistence';

function read(path: string): string {
  assert(existsSync(path), `missing ${path}`);
  return readFileSync(path, 'utf8');
}

const plan = read('docs/ps-031-store-connector-source-of-truth.md');
const normalized = read('src/services/normalized-order-persistence.ts');
const storeOrderImport = read('src/services/store-order-import.ts');
const orderSync = read('src/services/order-sync.ts');
const outbox = read('src/services/fulfillment/outbox.ts');
const directLabels = read('api/carriers/labels.ts');
const fulfillmentTypes = read('src/domain/fulfillment/types.ts');
const packageJson = JSON.parse(read('package.json')) as {
  scripts?: Record<string, string>;
};

for (const section of [
  '## Source-of-Truth Matrix',
  '## Mutation Ownership',
  '## ShipStation Compatibility',
  '## Non-ShipStation Connector Path',
  '## Carrier Account Differentiation',
  '## Safe Implementation Plan',
  '## Verification Plan',
]) {
  assert(plan.includes(section), `PS-031 plan missing ${section}`);
}

const shopifySource = buildNormalizedOrderSource({
  sourceProvider: 'shopify',
  sourceAccountId: 'shop:drp-ca',
  sourceOrderId: 'gid://shopify/Order/12345',
  sourceOrderNumber: 'SP-SHOP-1001',
  raw: { id: 'gid://shopify/Order/12345', name: '#1001' },
});
assert.equal(shopifySource.sourceProvider, 'shopify');
assert.equal(shopifySource.sourceAccountId, 'shop:drp-ca');
assert.equal(shopifySource.sourceOrderId, 'gid://shopify/Order/12345');
assert.equal(shopifySource.sourceOrderNumber, 'SP-SHOP-1001');
assert.deepEqual(shopifySource.rawSourcePayload, {
  id: 'gid://shopify/Order/12345',
  name: '#1001',
});

assert(
  normalized.includes('buildNormalizedOrderSource'),
  'normalized order persistence must expose provider-agnostic buildNormalizedOrderSource',
);
assert(
  storeOrderImport.includes('NormalizedStoreOrder') &&
    storeOrderImport.includes('upsertNormalizedStoreOrders') &&
    storeOrderImport.includes('replaceOrderItemsForOrders(persistedRows)'),
  'store-order-import service must provide provider-agnostic order upsert into orders + order_items from persisted local rows',
);
assert(
  orderSync.includes('upsertNormalizedStoreOrders') &&
    orderSync.includes('toShipStationNormalizedStoreOrder'),
  'ShipStation order sync must route persistence through provider-agnostic store-order-import service',
);
assert(
  normalized.includes('buildShipStationOrderSource') &&
    normalized.includes('return buildNormalizedOrderSource'),
  'ShipStation source helper must delegate to provider-agnostic source helper',
);
assert(
  outbox.includes("status: 'not_supported'"),
  'unsupported shipment confirmation providers must be marked not_supported, not not_required',
);
assert(
  !outbox.includes("const supported = provider === 'shipstation' || provider === 'walmart' || provider === 'ebay'"),
  'fulfillment outbox must not hardcode supported providers',
);
assert(
  outbox.includes("resolveStoreConnector(provider, 'shipment.confirm')"),
  'fulfillment outbox must resolve shipment confirmation through store connector capabilities',
);
// PS-136 → PS-209 re-anchor: the old pin required the legacy Vercel label fn
// to delegate its confirmation decision to the canonical owners. PS-209's
// first slice retired that fn as a purchase path entirely (no-import 410 —
// LEGACY_LABEL_ENDPOINT_RETIRED), which is strictly STRONGER: it cannot
// confirm anything, canonically or otherwise. The pin now holds the stub
// shape so purchase/confirmation machinery cannot creep back in.
assert(
  !directLabels.includes("const supported = provider === 'shipstation' || provider === 'walmart' || provider === 'ebay'"),
  'api/carriers/labels.ts must not hardcode supported confirmation providers',
);
assert(
  directLabels.includes('LEGACY_LABEL_ENDPOINT_RETIRED') &&
    !directLabels.includes('confirmStoreShipment') &&
    !directLabels.includes('processFulfillmentOutboxOnce'),
  'api/carriers/labels.ts must stay the retired 410 stub with zero confirmation capability (PS-209)',
);
assert(
  fulfillmentTypes.includes("'not_supported'"),
  'fulfillment confirmation status type must include not_supported',
);
assert.equal(
  packageJson.scripts?.['test:store-connector-source'],
  'tsx scripts/store-connector-source-guard.ts',
  'package.json missing test:store-connector-source script',
);

console.log('PASS store connector source-of-truth guard');
