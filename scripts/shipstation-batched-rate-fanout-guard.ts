import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { partitionShipStationEstimateBatch } from '../src/services/shipstation-rate-batch';

const complete = partitionShipStationEstimateBatch(
  ['se-1', 'se-2'],
  [
    { carrier_id: 'se-1', service_code: 'ups_ground' },
    { carrier_id: 'se-2', service_code: 'usps_priority_mail' },
  ],
);
assert.deepEqual(complete.missingCarrierIds, [], 'complete batch must not schedule fallback calls');
assert.equal(complete.ratesByCarrierId.get('se-1')?.length, 1);
assert.equal(complete.ratesByCarrierId.get('se-2')?.length, 1);
assert.deepEqual(complete.rejectedRates, []);

const partial = partitionShipStationEstimateBatch(
  ['se-1', 'se-2', 'se-3'],
  [
    { carrier_id: 'se-1', service_code: 'ups_ground' },
    { carrier_id: '', service_code: 'missing_identity' },
    { carrier_id: 'se-not-requested', service_code: 'wrong_scope' },
  ],
);
assert.deepEqual(
  partial.missingCarrierIds,
  ['se-2', 'se-3'],
  'every requested account absent from batch rows must use targeted single-account fallback',
);
assert.equal(partial.rejectedRates.length, 2, 'unattributed or out-of-scope rows must never enter rate truth');
assert.equal(partial.ratesByCarrierId.has('se-not-requested'), false);

const empty = partitionShipStationEstimateBatch(['se-1', 'se-2'], []);
assert.deepEqual(empty.missingCarrierIds, ['se-1', 'se-2'], 'empty batch must fall back for every account');

const ratesSource = readFileSync('src/services/rates.ts', 'utf8');
const envExample = readFileSync('.env.example', 'utf8');
const packageJson = readFileSync('package.json', 'utf8');
const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const liveProbeSource = readFileSync('scripts/probe-batched-rate-estimate.ts', 'utf8');

assert.match(
  ratesSource,
  /SHIPSTATION_BATCHED_RATE_FANOUT/,
  'canonical rate owner must gate batching behind an explicit env flag',
);
assert.match(
  ratesSource,
  /partitionShipStationEstimateBatch/,
  'canonical rate owner must derive fallback coverage from attributed batch rows',
);
assert.match(
  ratesSource,
  /shipStationBatchedRateFanoutEnabled\(\) && carriers\.length > 1/,
  'single-account requests must keep the existing path without a redundant batch probe',
);
assert.match(
  ratesSource,
  /fetchEstimateForCarrierWithRetry\(carrier[\s\S]{0,160}priority/,
  'missing accounts must reuse existing completeness-safe per-account retry path',
);
assert.match(
  ratesSource,
  /requestMode:\s*'batch'/,
  'shared batch timings must be marked as batch diagnostics',
);
assert.match(
  ratesSource,
  /requestMode:\s*'fallback'/,
  'targeted fallback diagnostics must remain distinguishable',
);
// 2026-07-14 (batching-review LOW): per-KEY scoping pins. A batch must carry the
// SAME credential the carrier discovery used — mixing keys would quote one
// tenant's accounts with another tenant's credential — and the batch dedupe
// identity must embed the full request key (rateCacheKey embeds the api-key
// fingerprint since PS-050, and sf= origin since audit C4), so two different
// keys/origins can never share one in-flight batched HTTP response.
assert.match(
  ratesSource,
  /fetchEstimateForCarriers\(\s*carriers[\s\S]{0,900}?apiKeyV2:\s*input\.apiKeyV2 \?\? undefined[\s\S]{0,200}?dedupeKey:\s*`rates-estimate:batch:\$\{carrierSetHash\}:\$\{rateCacheKey\(input\)\}`/,
  'batched estimate must forward the request credential and key the dedupe slot by carrier set + full request identity',
);
assert.match(envExample, /^SHIPSTATION_BATCHED_RATE_FANOUT=false$/m, 'rollout flag must default off');
assert.match(
  packageJson,
  /"test:shipstation-batched-rate-fanout"\s*:\s*"tsx scripts\/shipstation-batched-rate-fanout-guard\.ts"/,
  'package.json must expose batching boundary guard',
);
assert.match(
  ciWorkflow,
  /run: npm run test:shipstation-batched-rate-fanout/,
  'CI must run batching boundary guard before typecheck',
);
assert.match(
  liveProbeSource,
  /if \(!options\.live\) throw new Error\('refusing provider calls without --live'\)/,
  'live comparison probe must fail closed unless the operator passes --live',
);
assert.match(
  liveProbeSource,
  /loadShipStationCarrierAccountSources/,
  'live comparison probe must enumerate distinct env and client credential sources',
);
assert.match(
  liveProbeSource,
  /'\/v2\/carriers'[\s\S]*'\/v2\/rates\/estimate'/,
  'live comparison probe may discover carriers and request estimates only',
);
assert.doesNotMatch(
  liveProbeSource,
  /\/v2\/labels|createCarrierLabel|createLabel|orders\.(?:update|insert|delete)|shipments\.(?:update|insert|delete)/,
  'live comparison probe must not contain label purchase or order/shipment mutation paths',
);
assert.match(
  liveProbeSource,
  /compareBatchAgainstSingles[\s\S]*missingFromBatch[\s\S]*batchOnly[\s\S]*RESULT \$\{comparison\.go \? 'GO' : 'NO-GO'\}/,
  'live comparison probe must fail rollout on attributed batch-vs-single drift',
);
assert.match(
  packageJson,
  /"probe:shipstation-batched-rate-estimate"\s*:\s*"tsx scripts\/probe-batched-rate-estimate\.ts"/,
  'package.json must expose the operator-only live probe',
);
assert.match(
  packageJson,
  /"test:probe-batched-rate-estimate"\s*:\s*"tsx scripts\/probe-batched-rate-estimate\.ts --self-test"/,
  'package.json must expose the offline probe comparison proof',
);
assert.match(
  ciWorkflow,
  /run: npm run test:probe-batched-rate-estimate/,
  'CI must keep the live probe comparison contract from rotting without making provider calls',
);

process.env.CARRIER_TEST_MODE = '1';
process.env.SHIPSTATION_BATCHED_RATE_FANOUT = '1';
process.env.SHIPSTATION_RATE_LIMIT_PER_MINUTE = '10000';
process.env.SHIPSTATION_RATE_LIMIT_BURST = '10000';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/prepship_test';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'offline-test';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'offline-test';
process.env.SUPABASE_JWT_SECRET ??= 'offline-test';

const { __setCarrierReplay } = await import('../src/lib/http/timing');
const { fetchLiveRatesWithDiagnostics } = await import('../src/services/rates');

const carrierFixture = {
  account_number: 'test',
  requires_funded_amount: false,
  balance: 0,
  primary: false,
  has_multi_package_supporting_services: false,
  supports_label_messages: false,
  services: [],
  packages: [],
  disabled_by_billing_plan: false,
};
const carriers = [
  { ...carrierFixture, carrier_id: 'se-1', carrier_code: 'ups', nickname: 'Replay UPS', friendly_name: 'UPS' },
  { ...carrierFixture, carrier_id: 'se-2', carrier_code: 'stamps_com', nickname: 'Replay USPS', friendly_name: 'USPS' },
];
const rateInput = {
  weightOz: 16,
  toZip: '29707',
  toCity: 'Indian Land',
  toState: 'SC',
  toCountry: 'US',
  shipFrom: { postal_code: '90248', country_code: 'US' },
  carrierIds: ['se-1', 'se-2'],
};
const rate = (carrierId: string, serviceCode: string, amount: number) => ({
  rate_id: `rate-${carrierId}`,
  carrier_id: carrierId,
  carrier_code: carrierId === 'se-1' ? 'ups' : 'stamps_com',
  service_code: serviceCode,
  service_type: serviceCode,
  shipping_amount: { currency: 'usd', amount },
  other_amount: { currency: 'usd', amount: 0 },
});

try {
  __setCarrierReplay([
    { name: 'shipstation.v2.request', body: { carriers } },
    { name: 'shipstation.v2.request', body: [rate('se-1', 'ups_ground', 8.25)] },
    { name: 'shipstation.v2.request', body: [rate('se-2', 'usps_priority_mail', 9.1)] },
  ]);
  const partialResult = await fetchLiveRatesWithDiagnostics(
    { ...rateInput, apiKeyV2: 'replay-partial-key' },
    [],
    'interactive',
  );
  assert.equal(partialResult.rates.length, 2, 'partial batch plus targeted fallback must preserve both rates');
  assert.deepEqual(
    partialResult.carrierDiagnostics.map((diagnostic) => [diagnostic.carrierId, diagnostic.requestMode]),
    [['se-1', 'batch'], ['se-2', 'fallback']],
    'only missing account must use single-account fallback',
  );

  __setCarrierReplay([
    { name: 'shipstation.v2.request', body: { carriers } },
    { name: 'shipstation.v2.request', status: 400, body: { errors: [{ message: 'batch rejected' }] } },
    { name: 'shipstation.v2.request', body: [rate('se-1', 'ups_ground', 8.25)] },
    { name: 'shipstation.v2.request', body: [rate('se-2', 'usps_priority_mail', 9.1)] },
  ]);
  const failedBatchResult = await fetchLiveRatesWithDiagnostics(
    { ...rateInput, apiKeyV2: 'replay-failed-batch-key' },
    [],
    'interactive',
  );
  assert.equal(failedBatchResult.rates.length, 2, 'failed batch must fall back to complete single-account fan-out');
  assert.deepEqual(
    failedBatchResult.carrierDiagnostics.map((diagnostic) => diagnostic.requestMode),
    ['fallback', 'fallback'],
  );

  delete process.env.SHIPSTATION_BATCHED_RATE_FANOUT;
  __setCarrierReplay([
    { name: 'shipstation.v2.request', body: { carriers } },
    { name: 'shipstation.v2.request', body: [{ ...rate('se-1', 'ups_ground', 8.25), carrier_id: undefined }] },
    { name: 'shipstation.v2.request', body: [{ ...rate('se-2', 'usps_priority_mail', 9.1), carrier_id: undefined }] },
  ]);
  const flagOffResult = await fetchLiveRatesWithDiagnostics(
    { ...rateInput, apiKeyV2: 'replay-flag-off-key' },
    [],
    'interactive',
  );
  assert.equal(flagOffResult.rates.length, 2, 'flag off must preserve existing single-account fan-out');
  assert.deepEqual(
    flagOffResult.carrierDiagnostics.map((diagnostic) => diagnostic.requestMode),
    [undefined, undefined],
    'flag off diagnostics must remain unchanged',
  );
} finally {
  __setCarrierReplay(null);
  delete process.env.CARRIER_TEST_MODE;
  delete process.env.SHIPSTATION_BATCHED_RATE_FANOUT;
  delete process.env.SHIPSTATION_RATE_LIMIT_PER_MINUTE;
  delete process.env.SHIPSTATION_RATE_LIMIT_BURST;
}

console.log('PASS ShipStation batched rate fan-out guard');
