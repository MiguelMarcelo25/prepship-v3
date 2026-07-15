import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDurableRateBackfillJobPayload } from '../src/services/rate-backfill-job-types';
import { buildShippingRateRequestFingerprint } from '../src/services/shipping-workflow/rate-fingerprint';

function read(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

const durablePayload = parseDurableRateBackfillJobPayload({
  version: 1,
  jobId: 'audit-5.1-job',
  requestedAt: '2026-07-15T00:00:00.000Z',
  requestedBy: 'rate-on-ingest',
  options: { mode: 'cache_first', orderIds: [3, 2, 1], limit: 3 },
});
assert.deepEqual(durablePayload?.options.orderIds, [3, 2, 1], 'durable admission preserves targeted IDs');
assert.equal(durablePayload?.requestedBy, 'rate-on-ingest', 'durable admission records ingest provenance');

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
assert.match(backfillOwner, /export async function enqueueBackfillBestRatesForOrderIds/);
assert.match(backfillOwner, /enqueueDurableRateBackfillJob\(payload\)/);
assert.doesNotMatch(backfillOwner, /queuedRateOnIngestOrderIds|takeRateOnIngestBatch/);
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
