import { existsSync, readFileSync } from 'node:fs';
import { resolveRateQuoteForPurchase } from '../src/services/shipping-workflow/rate-quote-snapshot';

type Check = {
  name: string;
  pass: boolean;
  detail?: string;
};

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function maybeRead(path: string): string {
  return existsSync(path) ? read(path) : '';
}

function ok(name: string, pass: boolean, detail?: string): Check {
  return { name, pass, detail };
}

const packageJson = read('package.json');
const ratesBackfill = read('src/services/rates-backfill.ts');
const syncScheduler = read('src/services/sync-scheduler.ts');
const syncJobQueue = read('src/services/sync-job-queue.ts');
const ordersView = read('web/src/components/Views/OrdersView.tsx');
const policySource = maybeRead('src/services/rate-preexpiry-refresh-policy.ts');

const now = Date.parse('2026-06-29T12:00:00.000Z');
const expiredProof = resolveRateQuoteForPurchase({
  now,
  ttlMs: 60 * 60 * 1000,
  selectedRateKey: 'srk_best',
  snapshot: {
    cacheKey: 'fp-expired',
    fetchedAt: '2026-06-29T10:00:00.000Z',
    rates: [{ carrier_code: 'ups', service_code: 'ups_ground', shipping_amount: { amount: 7.5 } }],
    bestRateComplete: true,
    bestRateKey: 'srk_best',
  },
});

const checks: Check[] = [
  ok(
    'package wires PS-348 pre-expiry rate refresh guard',
    /"test:ps-348-pre-expiry-rate-refresh"\s*:\s*"tsx scripts\/ps-348-pre-expiry-rate-refresh-guard\.ts"/.test(packageJson),
  ),
  ok(
    'expired quote snapshots still block purchase/queue proof',
    expiredProof.ok === false && expiredProof.reason === 'snapshot_expired',
    JSON.stringify(expiredProof),
  ),
  ok(
    'PS-348 has a focused backend policy module instead of growing the backfill file',
    policySource.includes('RATE_PREEXPIRY_REFRESH_LEAD_MS') &&
      policySource.includes('classifyRatePreExpiryRefresh') &&
      policySource.includes('shouldPreExpiryRefreshRate'),
  ),
  ok(
    'pre-expiry policy treats near-expiry proof as refreshable before hard TTL',
    /cacheExpiresAt[\s\S]*refreshLeadMs[\s\S]*near_expiry/.test(policySource) &&
      /incomplete_tuple|missing_proof|missing_expiry/.test(policySource),
  ),
  ok(
    'rates backfill imports and delegates pre-expiry decisions to the PS-348 policy owner',
    /rate-preexpiry-refresh-policy/.test(ratesBackfill) &&
      /RATE_PREEXPIRY_REFRESH_LEAD_MS/.test(ratesBackfill) &&
      /shouldPreExpiryRefreshRate/.test(ratesBackfill),
  ),
  ok(
    'rates backfill selects near-expiry or incomplete tuple rows before cacheExpiresAt passes',
    /preExpiryCutoff/.test(ratesBackfill) &&
      /cacheExpiresAt/.test(ratesBackfill) &&
      /bestRateJson[\s\S]*isComplete/.test(ratesBackfill) &&
      /customerRateAmount|customer_rate_amount/.test(ratesBackfill) &&
      /rateCostAmount|rate_cost_amount/.test(ratesBackfill),
  ),
  ok(
    'pre-expiry SQL binds cutoff as ISO text, not a JavaScript Date object',
    /preExpiryCutoffIso\s*=\s*new Date[\s\S]{0,120}\.toISOString\(\)/.test(ratesBackfill) &&
      /\(nullif\(\$\{orderOverrides\.bestRateJson\}->>'cacheExpiresAt', ''\)\)::timestamptz\s*<=\s*\$\{preExpiryCutoffIso\}::timestamptz/.test(ratesBackfill) &&
      !/\(nullif\(\$\{orderOverrides\.bestRateJson\}->>'cacheExpiresAt', ''\)\)::timestamptz\s*<=\s*\$\{preExpiryCutoff\}/.test(ratesBackfill),
  ),
  ok(
    'scheduler runs the rate backfill as explicit pre-expiry refresh, not manual force-live',
    /startBackfillBestRates\(\{\s*mode:\s*['"]preexpiry_refresh['"]\s*\}\)/.test(syncScheduler),
  ),
  ok(
    'pg-boss scheduler still delegates to runBackfillTick for one backend-owned refresh path',
    /registerWorker\(JOBS\.rateBackfill,\s*async \(\) => runBackfillTick\(\)\)/.test(syncJobQueue),
  ),
  ok(
    'pre-expiry refresh is cache-friendly and does not force live carrier fan-out',
    /mode\?:\s*['"]cache_first['"]\s*\|\s*['"]full_live_audit['"]\s*\|\s*['"]preexpiry_refresh['"]/.test(ratesBackfill) &&
      /opts\.mode === ['"]preexpiry_refresh['"][\s\S]*cache_friendly/.test(ratesBackfill) &&
      /const liveRecalculate\s*=[^;]*full_live_audit[^;]*\|\|[^;]*maxAgeHours === 0/.test(ratesBackfill),
  ),
  ok(
    'frontend does not reintroduce a broad live-rate loop for PS-348 freshness',
    !/needsDisplayRefresh/.test(ordersView) &&
      !/refreshVisibleBestRate/.test(ordersView) &&
      !/PASSIVE_LIVE_BEST_RATE_MAX_ROWS/.test(ordersView),
  ),
];

if (policySource) {
  const policy = await import('../src/services/rate-preexpiry-refresh-policy');
  const near = policy.classifyRatePreExpiryRefresh({
    proofSource: 'backend_rate_response',
    requestFingerprint: 'fp',
    cacheKey: 'fp',
    rateQuoteId: 'rq_1',
    selectedRateKey: 'srk_1',
    isComplete: true,
    customerRateAmount: 12,
    rateCostAmount: 10,
    cacheExpiresAt: new Date(now + 30 * 60 * 1000).toISOString(),
  }, { nowMs: now, refreshLeadMs: 60 * 60 * 1000 });
  const fresh = policy.classifyRatePreExpiryRefresh({
    proofSource: 'backend_rate_response',
    requestFingerprint: 'fp',
    cacheKey: 'fp',
    rateQuoteId: 'rq_1',
    selectedRateKey: 'srk_1',
    isComplete: true,
    customerRateAmount: 12,
    rateCostAmount: 10,
    cacheExpiresAt: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
  }, { nowMs: now, refreshLeadMs: 60 * 60 * 1000 });
  const incompleteTuple = policy.classifyRatePreExpiryRefresh({
    proofSource: 'backend_rate_response',
    requestFingerprint: 'fp',
    cacheKey: 'fp',
    rateQuoteId: 'rq_1',
    selectedRateKey: 'srk_1',
    isComplete: true,
    customerRateAmount: 12,
    cacheExpiresAt: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
  }, { nowMs: now, refreshLeadMs: 60 * 60 * 1000 });
  checks.push(
    ok('policy classifies near-expiry complete tuple for refresh', near === 'near_expiry', String(near)),
    ok('policy leaves healthy tuple alone until the lead window', fresh === 'fresh', String(fresh)),
    ok('policy refreshes incomplete Best Rate + Rate Cost tuples together', incompleteTuple === 'incomplete_tuple', String(incompleteTuple)),
  );
}

let failed = 0;
for (const check of checks) {
  if (check.pass) {
    console.log(`ok   ${check.name}`);
  } else {
    failed += 1;
    console.error(`fail ${check.name}${check.detail ? ` - ${check.detail}` : ''}`);
  }
}

if (failed) {
  console.error(`\nFAIL PS-348 pre-expiry rate refresh guard (${failed} failure${failed === 1 ? '' : 's'})`);
  process.exit(1);
}

console.log('\nPASS PS-348 pre-expiry rate refresh guard');
