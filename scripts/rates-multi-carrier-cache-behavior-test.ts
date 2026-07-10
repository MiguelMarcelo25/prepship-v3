import assert from 'node:assert/strict';
import {
  createShipStationCarrierAccountLoader,
} from '../src/services/shipstation-carrier-account-cache';

const carrier = {
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

let now = 1_000;
let calls = 0;
const dedupeKeys: string[] = [];
const loader = createShipStationCarrierAccountLoader({
  now: () => now,
  ttlMs: 300,
  load: async (_apiKeyV2, dedupeKey) => {
    calls += 1;
    dedupeKeys.push(dedupeKey);
    return { carriers: [carrier] };
  },
});

const first = await loader('test-key-a');
assert.equal(first.cacheStatus, 'miss');
assert.equal(first.carriers.length, 1);
assert.equal(calls, 1);
assert.equal(dedupeKeys[0]?.includes('test-key-a'), false, 'dedupe keys must not expose credentials');

now += 200;
const cached = await loader('test-key-a');
assert.equal(cached.cacheStatus, 'hit');
assert.equal(cached.cacheAgeMs, 200);
assert.equal(calls, 1, 'fresh cache hit must not call ShipStation again');

now += 101;
const refreshed = await loader('test-key-a');
assert.equal(refreshed.cacheStatus, 'miss');
assert.equal(calls, 2, 'expired cache entry must refresh from ShipStation');

await loader('test-key-b');
assert.equal(calls, 3, 'different credentials must not share cached carrier accounts');

let failures = 0;
const failingLoader = createShipStationCarrierAccountLoader({
  now: () => now,
  load: async () => {
    failures += 1;
    throw Object.assign(new Error('provider unavailable'), { status: 503 });
  },
});
const failed = await failingLoader('test-key-c');
const retried = await failingLoader('test-key-c');
assert.equal(failed.status, 503);
assert.equal(retried.cacheStatus, 'miss');
assert.equal(failures, 2, 'failed provider responses must not be cached');

console.log('rates-multi carrier cache behavior test passed.');
