/**
 * Audit 2026-07-13 item 4.3 sync cursor and webhook dedupe hygiene guard.
 *
 * Offline only: pure key/dedupe execution plus source inspection. No database,
 * provider, label/postage, marketplace, inventory, or production data access.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  shipStationSyncWatermarkKeys,
} from '../src/services/shipstation-sync-account-state';
import { webhookDedupeKey } from '../src/services/fulfillment/webhook-ledger';

const renamedAccount = { label: 'client:Renamed Customer', ownerClientId: 42 };
assert.deepEqual(
  shipStationSyncWatermarkKeys('order_sync.last_modified_ms', renamedAccount),
  {
    primaryKey: 'order_sync.last_modified_ms:client:42',
    legacyKey: 'order_sync.last_modified_ms:client:Renamed Customer',
  },
  'client watermark identity must use the immutable account ID and expose the legacy name key',
);
assert.deepEqual(
  shipStationSyncWatermarkKeys('shipment_sync.last_created_ms', {
    label: 'main',
    ownerClientId: null,
  }),
  {
    primaryKey: 'shipment_sync.last_created_ms',
    legacyKey: null,
  },
  'main-account watermark key must remain backward compatible',
);

const occurredAt = new Date('2026-07-14T08:01:00.000Z');
const retryBeforeReceiptBoundary = webhookDedupeKey({
  provider: 'walmart',
  payloadHash: 'same-payload',
  occurredAt,
  receivedAtMs: Date.parse('2026-07-14T08:04:59.000Z'),
});
const retryAfterReceiptBoundary = webhookDedupeKey({
  provider: 'walmart',
  payloadHash: 'same-payload',
  occurredAt,
  receivedAtMs: Date.parse('2026-07-14T08:10:01.000Z'),
});
assert.equal(
  retryBeforeReceiptBoundary,
  retryAfterReceiptBoundary,
  'same event occurrence must dedupe even when delivery retries cross receipt-time windows',
);
assert.notEqual(
  retryBeforeReceiptBoundary,
  webhookDedupeKey({
    provider: 'walmart',
    payloadHash: 'same-payload',
    occurredAt: new Date('2026-07-14T08:06:00.000Z'),
    receivedAtMs: Date.parse('2026-07-14T08:10:01.000Z'),
  }),
  'distinct occurrence windows must remain distinct without an external event ID',
);
assert.equal(
  webhookDedupeKey({ provider: 'shopify', externalEventId: 'evt-1', payloadHash: 'a', occurredAt, receivedAtMs: 1 }),
  webhookDedupeKey({ provider: 'shopify', externalEventId: 'evt-1', payloadHash: 'b', receivedAtMs: 9_999_999 }),
  'provider event ID must remain the primary time-independent idempotency key',
);
assert.notEqual(
  webhookDedupeKey({ provider: 'custom', payloadHash: 'h', receivedAtMs: 1_000 }),
  webhookDedupeKey({ provider: 'custom', payloadHash: 'h', receivedAtMs: 301_000 }),
  'missing occurredAt must retain the receipt-time fallback',
);

const orderSync = readFileSync('src/services/order-sync.ts', 'utf8');
const shipmentSync = readFileSync('src/services/shipment-sync.ts', 'utf8');
const webhookRoute = readFileSync('src/routes/webhooks.ts', 'utf8');
const doc = readFileSync('docs/ps-tickets/audit-4.3-sync-cursor-webhook-hygiene.md', 'utf8');
const packageJson = readFileSync('package.json', 'utf8');
const guardPack = readFileSync('scripts/sot-guard-pack.mjs', 'utf8');

assert.match(orderSync, /shipStationSyncWatermarkKeys\(LAST_SYNC_KEY, account\)/,
  'order sync must delegate watermark identity to account-state');
assert.match(orderSync, /legacyKey[\s\S]*getSettingNumber\(legacyKey\)/,
  'order sync must read the legacy name-derived key when the stable key is absent');
assert.doesNotMatch(orderSync, /function watermarkKey\(accountLabel:/,
  'order sync must not retain its name-derived key owner');
assert.match(shipmentSync, /shipStationSyncWatermarkKeys\(LAST_SYNC_KEY, acct\)/,
  'shipment sync must delegate watermark identity to account-state');
assert.match(shipmentSync, /legacyKey[\s\S]*getSettingNumber\(legacyKey\)/,
  'shipment sync must read the legacy name-derived key when the stable key is absent');
assert.match(shipmentSync, /parseShipStationV1Date\(s\.createDate\s*\?\?\s*''\)\?\.getTime\(\)/,
  'shipment resume cursor must use the Pacific-aware ShipStation parser');
assert.doesNotMatch(shipmentSync, /Date\.parse\(s\.createDate/,
  'shipment resume cursor must not use the server timezone');
assert.match(webhookRoute, /occurredAt: normalized\.occurredAt/,
  'webhook route must pass normalized event time to the ledger owner');
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
  assert.ok(doc.includes(field), `placement record must include ${field}`);
}
assert.ok(packageJson.includes('"test:audit-sync-cursor-webhook-hygiene"'), 'package must expose the 4.3 guard');
assert.ok(guardPack.includes("'test:audit-sync-cursor-webhook-hygiene'"), 'SOT pack must require the 4.3 guard');

console.log('PASS Audit 4.3 sync cursor and webhook dedupe hygiene guard');
