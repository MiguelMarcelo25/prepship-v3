import assert from 'node:assert/strict';
import type { Carrier } from '../src/lib/shipstation/types';
import {
  SHIPSTATION_CARRIER_SNAPSHOT_FRESH_MS,
  buildShipStationCarrierAccountSources,
  refreshDueShipStationCarrierAccountSnapshots,
  resolveShipStationCarrierAccountSnapshot,
  type ShipStationCarrierAccountSnapshot,
} from '../src/services/shipstation-carrier-account-snapshots';

const carrier: Carrier = {
  carrier_id: 'se-1',
  carrier_code: 'ups',
  account_number: '1234',
  requires_funded_amount: false,
  balance: 0,
  nickname: 'Test UPS',
  friendly_name: 'UPS',
  primary: true,
  has_multi_package_supporting_services: true,
  supports_label_messages: true,
  services: [],
  packages: [],
  disabled_by_billing_plan: false,
};

const sources = buildShipStationCarrierAccountSources({
  primaryApiKeyV2: 'primary-key',
  kfgApiKeyV2: 'kfg-key',
  clients: [
    { id: 1, name: 'Duplicate Primary', ssApiKeyV2: 'primary-key' },
    { id: 2, name: 'Client Two', ssApiKeyV2: 'client-key' },
  ],
});
assert.deepEqual(
  sources.map((source) => source.sourceKey),
  ['env:primary', 'env:kfg', 'client:2'],
  'literal duplicate credentials must preserve the existing env-first source behavior',
);
assert.equal(
  sources.some((source) => source.credentialFingerprint.includes(source.apiKeyV2)),
  false,
  'stored fingerprints must not expose API keys',
);

const now = Date.parse('2026-07-10T00:00:00.000Z');
const snapshot = (
  sourceIndex: number,
  ageMs: number,
  fingerprint = sources[sourceIndex]!.credentialFingerprint,
): ShipStationCarrierAccountSnapshot => ({
  version: 1,
  sourceKey: sources[sourceIndex]!.sourceKey,
  credentialFingerprint: fingerprint,
  carriers: [carrier],
  fetchedAt: new Date(now - ageMs).toISOString(),
});
const snapshots = new Map<string, ShipStationCarrierAccountSnapshot>([
  [sources[0]!.sourceKey, snapshot(0, 1_000)],
  [sources[1]!.sourceKey, snapshot(1, SHIPSTATION_CARRIER_SNAPSHOT_FRESH_MS + 1)],
  [sources[2]!.sourceKey, snapshot(2, 1_000, 'old-credential-fingerprint')],
]);
assert.equal(resolveShipStationCarrierAccountSnapshot(sources[0]!, snapshots, now).status, 'fresh');
assert.equal(resolveShipStationCarrierAccountSnapshot(sources[1]!, snapshots, now).status, 'stale');
assert.equal(
  resolveShipStationCarrierAccountSnapshot(sources[2]!, snapshots, now).status,
  'credential_mismatch',
  'a snapshot from an old credential must never be served',
);

const fetched: string[] = [];
const written: string[] = [];
const summary = await refreshDueShipStationCarrierAccountSnapshots({
  now: () => now,
  loadSources: async () => ({ sources, dbError: null }),
  readSnapshots: async () => snapshots,
  fetchCarrierAccounts: async (source) => {
    fetched.push(source.sourceKey);
    if (source.sourceKey === 'client:2') {
      return {
        carriers: [],
        error: 'provider unavailable',
        status: 503,
        cacheStatus: 'miss',
        cacheAgeMs: null,
        durationMs: 10,
        providerDurationMs: 10,
      };
    }
    return {
      carriers: [carrier],
      error: null,
      status: 200,
      cacheStatus: 'miss',
      cacheAgeMs: null,
      durationMs: 10,
      providerDurationMs: 10,
    };
  },
  writeSnapshot: async (source) => {
    written.push(source.sourceKey);
  },
});
assert.deepEqual(fetched, ['env:kfg', 'client:2']);
assert.deepEqual(written, ['env:kfg'], 'failed refreshes must retain the previous durable snapshot');
assert.deepEqual(summary, {
  sources: 3,
  fresh: 1,
  attempted: 2,
  refreshed: 1,
  errors: 1,
  credentialDbError: null,
});

console.log('rates-multi durable snapshot behavior test passed.');
