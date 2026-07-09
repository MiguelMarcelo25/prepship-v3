import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  defaultCutoverSyncAnchorAt,
  filterShipStationStoreIdsForCutover,
  normalizeShipStationStoreIds,
} from '../src/services/store-source-cutover-policy';

assert.deepEqual(
  normalizeShipStationStoreIds([202, '101', 202, 0, -1, 303.5, null]),
  [101, 202],
  'normalizes unique positive integer ShipStation store IDs',
);

assert.deepEqual(
  filterShipStationStoreIdsForCutover([101, 202, 303], new Set([202])),
  [101, 303],
  'active cutover removes the legacy ShipStation store from awaiting sync targets',
);

assert.equal(
  defaultCutoverSyncAnchorAt(new Date('2026-07-09T12:00:00.000Z')).toISOString(),
  '2026-07-08T12:00:00.000Z',
  'default Shopify sync anchor starts 24 hours before approval',
);

const service = readFileSync('src/services/store-source-cutover.ts', 'utf8');
const shopifySync = readFileSync('src/services/shopify-order-sync.ts', 'utf8');
const route = readFileSync('src/routes/store-source-cutovers.ts', 'utf8');
const orderSync = readFileSync('src/services/order-sync.ts', 'utf8');
const pendingUi = readFileSync('web/src/components/Settings/PendingClientIntegrationsCard.tsx', 'utf8');
const main = readFileSync('src/main.ts', 'utf8');
const migration = readFileSync('drizzle/0057_store_source_cutovers.sql', 'utf8');
const pkg = readFileSync('package.json', 'utf8');

assert.match(service, /CREATE TABLE IF NOT EXISTS store_source_cutovers/);
assert.match(shopifySync, /account\.source === 'admin' && account\.active === true/);
assert.match(migration, /CREATE TABLE IF NOT EXISTS "store_source_cutovers"/);
assert.match(migration, /store_source_cutovers_active_legacy_idx/);

assert.match(route, /\/dry-run/);
assert.match(route, /\/apply/);
assert.match(route, /requireInternalPermission\('settings:write'\)/);
assert.match(route, /recordAuditEvent/);

assert.match(orderSync, /loadActiveShipStationCutoverStoreIds/);
assert.match(orderSync, /filterShipStationStoreIdsForCutover\(/);
assert.match(orderSync, /orderStatus: 'awaiting_shipment'/);

assert.doesNotMatch(service, /UPDATE\s+orders/i, 'cutover service must not mutate orders');
assert.doesNotMatch(service, /DELETE\s+FROM\s+orders/i, 'cutover service must not delete orders');
assert.doesNotMatch(service, /\bshipments\b/i, 'cutover service must not touch shipments');

assert.match(pendingUi, /\/store-accounts\?source=portal&pending=1/);
assert.match(pendingUi, /\/store-source-cutovers\/dry-run/);
assert.match(pendingUi, /\/store-source-cutovers\/apply/);
assert.match(pendingUi, /Cut over from ShipStation store ID/);

assert.match(main, /store-source-cutovers/);
assert.match(pkg, /"test:store-source-cutover"\s*:\s*"tsx scripts\/store-source-cutover-guard\.ts"/);

console.log('PASS store-source cutover source-of-truth guard');
