import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  buildOrderSourceIdentity,
  legacyExternalOrderIdForSource,
  orderSourceIdentityKey,
} from '../src/services/order-source-identity';

function read(path: string): string {
  assert(existsSync(path), `missing ${path}`);
  return readFileSync(path, 'utf8');
}

function assertIncludes(haystack: string, needle: string, message: string): void {
  assert(haystack.includes(needle), message);
}

const schema = read('src/db/schema/orders.ts');
const migration = read('drizzle/0056_order_source_identity_sot.sql');
const importer = read('src/services/store-order-import.ts');
const sourceOwner = read('src/services/order-source-identity.ts');
const normalized = read('src/services/normalized-order-persistence.ts');
const orderSync = read('src/services/order-sync.ts');
const shipmentSync = read('src/services/shipment-sync.ts');
const walmartHandler = read('src/lib/imported-handlers/walmart-orders.ts');
const ebayHandler = read('src/lib/imported-handlers/ebay-orders.ts');
const packageJson = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };

const shopifyA = buildOrderSourceIdentity({
  sourceProvider: ' Shopify ',
  sourceAccountId: ' store:alpha ',
  sourceOrderId: ' 123 ',
});
const shopifyB = buildOrderSourceIdentity({
  sourceProvider: 'shopify',
  sourceAccountId: 'store:beta',
  sourceOrderId: '123',
});
const walmart = buildOrderSourceIdentity({
  sourceProvider: 'WALMART',
  sourceAccountId: 44,
  sourceOrderId: 123,
});

assert.deepEqual(shopifyA, {
  sourceProvider: 'shopify',
  sourceAccountId: 'store:alpha',
  sourceOrderId: '123',
});
assert.deepEqual(walmart, {
  sourceProvider: 'walmart',
  sourceAccountId: '44',
  sourceOrderId: '123',
});
assert.notEqual(orderSourceIdentityKey(shopifyA!), orderSourceIdentityKey(shopifyB!));
assert.equal(buildOrderSourceIdentity({ sourceProvider: 'shopify', sourceAccountId: '', sourceOrderId: '123' }), null);
assert.equal(legacyExternalOrderIdForSource({ sourceProvider: 'shipstation', sourceAccountId: 'store:1', sourceOrderId: '987' }), '987');
assert.equal(legacyExternalOrderIdForSource(shopifyA!), 'shopify-123');

assertIncludes(sourceOwner, 'export function orderSourceIdentityPredicate', 'source owner must expose SQL predicate helper');
assertIncludes(sourceOwner, 'export function legacyOrderSourceCompatibilityPredicate', 'source owner must own bounded legacy fallback predicate');
assertIncludes(sourceOwner, 'inArray(orders.externalOrderId, ids)', 'legacy fallback must be gated by the requested external ids');
assertIncludes(sourceOwner, "eq(orders.sourceAccountId, 'shipstation-default')", 'legacy fallback must explicitly include unqualified ShipStation rows only when requested');
assertIncludes(normalized, "from './order-source-identity'", 'normalized source builder must delegate to source identity owner');

assert(!/externalOrderId:\s*text\(\)\.unique\(\)/.test(schema), 'orders.externalOrderId must no longer be globally unique in schema');
assert(/uniqueIndex\('orders_source_unique_idx'\)/.test(schema), 'schema must expose composite source unique index');
assert(/sourceProvider[\s\S]*sourceAccountId[\s\S]*sourceOrderId/.test(schema), 'schema must keep source identity fields together');

assertIncludes(migration, 'DROP CONSTRAINT IF EXISTS "orders_externalOrderId_unique"', 'migration must drop legacy global external id constraint');
assertIncludes(migration, 'CREATE UNIQUE INDEX IF NOT EXISTS "orders_source_unique_idx"', 'migration must enforce composite unique source identity');
assertIncludes(migration, "order_status NOT IN ('shipped', 'cancelled')", 'automatic backfill must not bulk-update terminal shipped/cancelled rows');
assertIncludes(migration, 'orders_legacy_external_order_id_idx', 'migration must retain a bounded legacy lookup index');
assertIncludes(migration, "source_account_id = 'shipstation-default'", 'legacy lookup index must include unqualified ShipStation fallback rows');

assertIncludes(importer, 'target: [orders.sourceProvider, orders.sourceAccountId, orders.sourceOrderId]', 'importer must upsert by composite source identity');
assertIncludes(importer, 'targetWhere:', 'importer must target the partial source identity index');
assert(!/target:\s*orders\.externalOrderId/.test(importer), 'importer must not conflict on externalOrderId');
assertIncludes(importer, 'claimLegacyOrderSourceIdentities(rows)', 'importer must claim bounded legacy rows before composite upsert');
assertIncludes(importer, 'legacyOrderSourceCompatibilityPredicate', 'importer legacy external fallback must be explicit/bounded');
assertIncludes(importer, 'replaceOrderItemsForOrders(persistedRows)', 'importer must refresh order items by persisted local order ids');
assertIncludes(importer, 'materializePackageFactsForImportedOrderIds(persistedOrderIds)', 'importer must materialize package facts by local order ids');

assertIncludes(orderSync, 'orderSourceIdentityOrLegacyPredicate', 'order sync must delegate source/legacy matching to the source identity owner');
assertIncludes(orderSync, 'includeUnqualifiedShipStationLegacy: true', 'order sync legacy external fallback must be explicit/bounded');
assert(!/inArray\(orders\.externalOrderId, externalIds\)/.test(orderSync), 'order sync must not use externalOrderId as the primary match key');

assertIncludes(shipmentSync, 'orderSourceIdentityOrLegacyPredicate', 'shipment sync must delegate source/legacy matching to the source identity owner');
assertIncludes(shipmentSync, 'includeUnqualifiedShipStationLegacy: true', 'shipment sync legacy external fallback must be explicit/bounded');
assert(!/\.where\(inArray\(orders\.externalOrderId, externalIds\)\)/.test(shipmentSync), 'shipment sync must not use externalOrderId-only lookup');

assert(!/INSERT INTO orders \([\s\S]*?ON CONFLICT \(external_order_id\) DO UPDATE SET/.test(walmartHandler), 'Walmart mirror must not upsert orders by external_order_id');
assert(!/INSERT INTO orders \([\s\S]*?ON CONFLICT \(external_order_id\) DO UPDATE SET/.test(ebayHandler), 'eBay mirror must not upsert orders by external_order_id');
assertIncludes(walmartHandler, 'upsertNormalizedStoreOrders', 'Walmart mirror must delegate to canonical import persistence');
assertIncludes(ebayHandler, 'upsertNormalizedStoreOrders', 'eBay mirror must delegate to canonical import persistence');

assert.equal(
  packageJson.scripts?.['test:ps-388-order-source-identity-sot'],
  'tsx scripts/ps-388-order-source-identity-sot-guard.ts',
  'package.json must expose the PS-388 source identity guard',
);

console.log('PASS PS-388 order source identity SOT guard');
