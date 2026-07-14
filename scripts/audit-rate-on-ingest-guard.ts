import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  addRateOnIngestOrderIds,
  RATE_ON_INGEST_BATCH_SIZE,
  takeRateOnIngestBatch,
} from '../src/services/rate-on-ingest-queue';
import { buildShippingRateRequestFingerprint } from '../src/services/shipping-workflow/rate-fingerprint';

function read(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

const queue = new Set<number>();
assert.equal(
  addRateOnIngestOrderIds(queue, [3, 2, 3, -1, 0, Number.NaN, 1.5, 1]),
  3,
  'only unique positive integer order IDs are admitted',
);
addRateOnIngestOrderIds(
  queue,
  Array.from({ length: RATE_ON_INGEST_BATCH_SIZE + 5 }, (_, index) => index + 4),
);
const firstBatch = takeRateOnIngestBatch(queue);
assert.equal(firstBatch.length, RATE_ON_INGEST_BATCH_SIZE, 'ingest rating drains in bounded batches');
assert.equal(queue.size, 8, 'overflow remains queued for the next drip');
assert.equal(new Set(firstBatch).size, firstBatch.length, 'one batch contains no duplicate order IDs');

const baseFingerprintInput = {
  version: 'audit-5.1',
  shipDateBucket: '2026-07-15',
  weightOz: 16,
  toZip: '90210',
  toCountry: 'US',
  toState: 'CA',
  toCity: 'Beverly Hills',
  residential: true,
  clientId: 9,
  dimsL: 12,
  dimsW: 10,
  dimsH: 3,
  confirmation: 'signature',
  carrierIds: ['se-22', 'se-11'],
};
const exact = buildShippingRateRequestFingerprint(baseFingerprintInput);
assert.equal(
  exact,
  buildShippingRateRequestFingerprint({ ...baseFingerprintInput, carrierIds: ['se-11', 'se-22'] }),
  'equivalent account sets share the exact signature regardless of input ordering',
);
for (const [label, changed] of [
  ['destination ZIP', { toZip: '90211' }],
  ['weight', { weightOz: 17 }],
  ['dimensions', { dimsH: 4 }],
  ['options', { confirmation: 'adult_signature' }],
  ['residential state', { residential: false }],
  ['account identity', { carrierIds: ['se-11'] }],
] as const) {
  assert.notEqual(
    exact,
    buildShippingRateRequestFingerprint({ ...baseFingerprintInput, ...changed }),
    `${label} changes must miss the exact signature cache`,
  );
}

const importOwner = read('src/services/store-order-import.ts');
const backfillOwner = read('src/services/rates-backfill.ts');
const rateOwner = read('src/services/rates.ts');
const doc = read('docs/ps-tickets/audit-5.1-rate-on-ingest.md');
const audit = read('AUDIT-2026-07-13.md');

assert.match(importOwner, /enqueueBackfillBestRatesForOrderIds/);
assert.match(importOwner, /newSourceIdentityKeys/);
assert.match(importOwner, /row\.orderStatus !== 'awaiting_shipment'/);
assert.ok(
  importOwner.indexOf('materializePackageFactsForImportedOrderIds')
    < importOwner.lastIndexOf('enqueueBackfillBestRatesForOrderIds'),
  'rate admission happens only after package-fact materialization',
);
assert.doesNotMatch(importOwner, /\bgetRates\b|getDirectCarrierRatesForRateInput|quoteCarrierRates/);
assert.match(backfillOwner, /queuedRateOnIngestOrderIds = new Set<number>\(\)/);
assert.match(backfillOwner, /export function enqueueBackfillBestRatesForOrderIds/);
assert.match(backfillOwner, /takeRateOnIngestBatch\(queuedRateOnIngestOrderIds\)/);
assert.match(backfillOwner, /mode: 'cache_first'/);
assert.match(rateOwner, /buildShippingRateRequestFingerprint\(\{/);
assert.match(rateOwner, /carrierIds: input\.carrierIds/);

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

assert.match(audit, /- \[x\] 5\.1 \*\*Rate-on-ingest \+ exact signature cache complete\*\*/);

console.log('PASS Audit 5.1 rate-on-ingest exact-signature guard');
