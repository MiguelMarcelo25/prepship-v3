import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  estimateRateBrowseFanoutBudgetMs,
  resolveRateBrowseProviderExecutionPolicy,
} from '../src/services/rate-browse-execution-policy';
import { scheduleDetachedRateBrowseJob } from '../src/services/rate-browse-job-scheduler';
import {
  buildRateBrowseFailureDiagnostic,
  buildRateBrowseTimingDiagnostics,
  sanitizeRateProviderError,
} from '../src/services/rate-browser-timing-diagnostics';
import { rateResultIsCacheable } from '../src/services/carrier-estimate-retry';
import { combineCarrierUniverses } from '../src/services/rates-combined';

const interactivePolicy = resolveRateBrowseProviderExecutionPolicy({
  priority: 'interactive',
  defaultTimeoutMs: 15_000,
  defaultMaxRetries: 1,
});
assert.equal(interactivePolicy.maxRetries, 0, 'interactive browse must not broadly retry slow providers');
assert.ok(interactivePolicy.timeoutMs <= 10_000, 'interactive per-provider timeout must remain capped');
assert.ok(
  estimateRateBrowseFanoutBudgetMs({ providerCount: 16, concurrency: 4, policy: interactivePolicy }) < 120_000,
  '16 slow providers must not consume the 120-second request ceiling',
);

const backgroundPolicy = resolveRateBrowseProviderExecutionPolicy({
  priority: 'background',
  defaultTimeoutMs: 15_000,
  defaultMaxRetries: 1,
});
assert.deepEqual(
  backgroundPolicy,
  { timeoutMs: 15_000, maxRetries: 1 },
  'background workflows keep the exhaustive retry policy',
);

let detachedStarted = false;
scheduleDetachedRateBrowseJob(async () => {
  detachedStarted = true;
});
assert.equal(detachedStarted, false, 'workflow POST scheduling must return before provider work starts');
await Promise.resolve();
assert.equal(detachedStarted, true, 'detached provider work starts on the next microtask');

const partial = combineCarrierUniverses({
  ssRates: [{
    carrier_id: 'se-fast',
    carrier_code: 'ups',
    service_code: 'ups_ground',
    shipping_amount: { amount: 8.25 },
  }],
  ssCacheKey: 'ps-403-partial',
  ssCached: false,
  ssDiagnostics: [
    { carrierId: 'se-fast', accountId: 'se-fast', nickname: 'Fast UPS', status: 'ok', rateCount: 1 },
    {
      carrierId: 'se-slow',
      accountId: 'se-slow',
      nickname: 'Slow FedEx',
      status: 'failed',
      rateCount: 0,
      durationMs: interactivePolicy.timeoutMs,
      error: 'Carrier rate request timed out',
      retryable: true,
    },
  ],
  directRates: [],
  directDiagnostics: [],
  requestedCarrierIds: ['se-fast', 'se-slow'],
  accountNamesByCarrierId: new Map([['se-fast', 'Fast UPS'], ['se-slow', 'Slow FedEx']]),
  accountCarrierIds: ['se-fast', 'se-slow'],
  isCachedOnlyLookup: false,
});
assert.equal(partial.combinedRates.length, 1, 'one provider timeout must preserve usable rates');
assert.equal(partial.cheapest?.carrier_id, 'se-fast', 'backend rate owner still selects the usable provider');
assert.equal(partial.bestRateComplete, false, 'partial rates must never claim authoritative completeness');

const timing = buildRateBrowseTimingDiagnostics({
  startedAtMs: 1_000,
  completedAtMs: 9_200,
  shipStationDurationMs: 8_200,
  directCarrierDurationMs: 0,
  carrierDiagnostics: [
    {
      source: 'shipstation',
      carrierId: 'se-slow',
      accountId: 'se-slow',
      carrierCode: 'fedex',
      nickname: 'Slow FedEx',
      status: 'failed',
      rateCount: 0,
      durationMs: 8_000,
      limiterWaitMs: 200,
      attempts: 1,
      retryable: true,
      error: 'request timeout token=super-secret',
    },
  ],
  rateEngineLimiter: {
    limiterBefore: { activeRateFetches: 4, interactiveWaiters: 1, backgroundWaiters: 8, shipStationBudgetUsed: 12 },
    limiterAfter: { activeRateFetches: 0, interactiveWaiters: 0, backgroundWaiters: 3, shipStationBudgetUsed: 13 },
  },
});
assert.equal(timing.carriers[0]?.outcome, 'timeout', 'slow provider must be classified as timeout');
assert.equal(timing.carriers[0]?.carrierName, 'Slow FedEx', 'slow provider must be named');
assert.equal(timing.carriers[0]?.limiterWaitMs, 200, 'limiter pressure must be attributed per provider');
assert.equal(timing.carriers[0]?.error, 'Carrier rate request timed out', 'provider errors must be sanitized');

const allFailed = buildRateBrowseFailureDiagnostic({ ratesCount: 0, carriers: timing.carriers });
assert.ok(allFailed?.message.includes('Slow FedEx (timeout)'), 'all-failed message must name the slow account');
assert.ok(!allFailed?.message.includes('super-secret'), 'all-failed message must never expose secrets');
assert.equal(
  sanitizeRateProviderError('401 invalid credentials api_key=super-secret'),
  'Carrier account authorization failed',
  'authorization errors must be safe and actionable',
);

assert.equal(
  rateResultIsCacheable([{ status: 'ok' }, { status: 'failed', transient: true }]),
  false,
  'partial transient results must not overwrite the authoritative cache',
);

const workflowSource = readFileSync('src/services/rate-browse-workflow.ts', 'utf8');
const producerSource = readFileSync('src/services/rate-browse-response-producer.ts', 'utf8');
const jobStoreSource = readFileSync('src/services/rate-browse-job-store.ts', 'utf8');
const ratesRouteSource = readFileSync('src/routes/rates.ts', 'utf8');
const modalSource = readFileSync('web/src/components/RateBrowserModal.tsx', 'utf8');
assert.match(workflowSource, /scheduleDetachedRateBrowseJob/, 'workflow must delegate to detached scheduling');
assert.match(producerSource, /rateBrowseFailure/, 'workflow result must expose actionable all-failed diagnostics');
assert.ok(
  producerSource.indexOf('evaluateOrderCarrierEligibility') < producerSource.indexOf('runRateBrowseSingleFlight'),
  'carrier-family eligibility must be evaluated before provider fanout',
);
const blockedQuoteBranch = producerSource.slice(
  producerSource.indexOf('const r = shipStationBlocked'),
  producerSource.indexOf('shipStationDurationMs = Date.now() - startedAt'),
);
assert.ok(
  blockedQuoteBranch.includes('rates: []') && blockedQuoteBranch.includes(': await getRates'),
  'an enforced ShipStation block must skip ShipStation provider calls',
);
assert.match(jobStoreSource, /rate_browse_job_provider_statuses/, 'provider diagnostics must remain durable');
assert.match(producerSource, /priority: 'interactive'/, 'Rate Browser provider calls must use interactive policy');
assert.match(ratesRouteSource, /\{ forceRefresh, priority: 'interactive' \}/, 'direct rate route must use interactive policy');
assert.match(modalSource, /RateBrowserDiagnosticsPanel/, 'Rate Browser must render provider diagnostics');

console.log('PASS PS-403 Rate Browser provider timeout guard');
