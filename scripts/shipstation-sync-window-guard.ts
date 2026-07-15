import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SHIPSTATION_V1_ACCOUNT_TIME_ZONE,
  formatShipStationV1DateParam,
  parseShipStationV1Date,
} from '../src/lib/shipstation/v1-date';

const affectedWatermark = Date.UTC(2026, 4, 28, 22, 0, 0);

assert.equal(
  SHIPSTATION_V1_ACCOUNT_TIME_ZONE,
  'America/Los_Angeles',
  'ShipStation v1 account-local timezone must be explicit',
);

assert.equal(
  formatShipStationV1DateParam(affectedWatermark),
  '2026-05-28 15:00:00',
  'UTC watermark must be rendered as account-local/PT wall-clock for ShipStation v1',
);

assert.notEqual(
  formatShipStationV1DateParam(affectedWatermark),
  '2026-05-28 22:00:00',
  'ShipStation v1 date params must not send stripped UTC wall-clock timestamps',
);

assert.equal(
  parseShipStationV1Date('2026-05-28T12:58:48.0000000')?.toISOString(),
  '2026-05-28T19:58:48.000Z',
  'timezone-less ShipStation v1 order dates must be parsed as account-local/PT timestamps',
);
assert.notEqual(
  parseShipStationV1Date('2026-05-28T12:58:48.0000000')?.toISOString(),
  '2026-05-28T12:58:48.000Z',
  'timezone-less ShipStation v1 order dates must not be parsed as UTC',
);

const connector = readFileSync('src/connectors/store/shipstation.ts', 'utf8');
const orderSync = readFileSync('src/services/order-sync.ts', 'utf8');
const shipmentSync = readFileSync('src/services/shipment-sync.ts', 'utf8');

assert.match(
  connector,
  /formatShipStationV1DateParam\(input\.sinceMs\)/,
  'ShipStation store connector must use account-local v1 formatter for modifyDateStart',
);
assert.match(
  shipmentSync,
  /formatShipStationV1DateParam\(lastSync\)/,
  'ShipStation shipment sync must use account-local v1 formatter for createDateStart',
);
assert.match(
  connector,
  /parseShipStationV1Date\(value\)/,
  'ShipStation store connector must parse timezone-less order dates as account-local v1 timestamps',
);
assert.match(
  shipmentSync,
  /parseShipStationV1Date\(s\.createDate\)/,
  'ShipStation shipment sync must parse timezone-less shipment dates as account-local v1 timestamps',
);
assert.doesNotMatch(
  connector + orderSync + shipmentSync,
  /toISOString\(\)\.replace\('T', ' '\)\.slice\(0, 19\)/,
  'ShipStation v1 sync paths must not strip UTC ISO timezone into timezone-less params',
);

assert.match(
  orderSync,
  /upsertMissingShippedOrdersBatch/,
  'ShipStation shipped status pass must recover shipped orders that were never imported while awaiting',
);
assert.match(
  orderSync,
  /inventoryDeductionSource: 'order_sync_status'/,
  'Recovered shipped orders must atomically use the shared durable inventory deduction lane',
);
assert.match(
  orderSync,
  /insert-only for missing shipped rows/,
  'Recovered shipped-order import must document that shipped/cancelled protections remain in force',
);
assert.match(
  orderSync,
  /isNull\(shipments\.orderId\)[\s\S]+eq\(shipments\.orderNumber, row\.orderNumber\)/,
  'Recovered shipped-order import must link existing orphan shipment rows by order number',
);

assert.match(
  readFileSync('package.json', 'utf8'),
  /test:shipstation-sync-window/,
  'package.json must expose the ShipStation sync-window guard',
);

// PS-036 #2 — the recovery dry-run must predict what --apply actually inserts.
// upsertShipmentsBatch skips SS rows for orders that already have a non-voided
// PrepShip-sourced label (v2-parity guard) or belong to a test client. If
// buildReport drops those gates it over-reports "missing" rows that --apply
// will never insert (confirmed: 6 PrepShip-guard skips reported as missing).
const recovery = readFileSync('scripts/recover-missing-shipments.ts', 'utf8');
assert.match(
  recovery,
  /inArray\(shipments\.source, \['prepship', 'prepship_v2', 'test_offline'\]\)/,
  'recovery dry-run must replicate the v2-parity PrepShip-source guard so missingRows excludes orders that already carry an authoritative PrepShip label',
);
assert.match(
  recovery,
  /skippedHasPrepshipLabel/,
  'recovery report must surface a skippedHasPrepshipLabel bucket instead of counting PrepShip-protected orders as missing',
);
assert.match(
  recovery,
  /testClientSet\.has\(matchedOrder\.clientId\)/,
  'recovery dry-run must replicate the test-client skip so test orders are not reported as insertable missing rows',
);

console.log('PASS ShipStation v1 sync-window timezone guard');
console.log('PASS recovery dry-run report mirrors apply-path PrepShip + test-client gates (PS-036 #2)');
