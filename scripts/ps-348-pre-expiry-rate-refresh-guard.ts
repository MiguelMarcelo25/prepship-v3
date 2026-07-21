import { existsSync, readFileSync } from 'node:fs';
import {
  createPreExpiryRefreshProof,
  recordPreExpiryRefreshResult,
  recordPreExpirySelection,
} from '../src/services/rate-preexpiry-refresh-proof';
import {
  backfillUsesLiveRateBudget,
  buildBackfillRateFetchDecision,
} from '../src/services/rate-preexpiry-refresh-request';

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

Object.assign(process.env, {
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://guard:guard@127.0.0.1:5432/guard',
  SUPABASE_URL: process.env.SUPABASE_URL ?? 'https://guard.supabase.co',
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY ?? 'guard-anon',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'guard-service',
  SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET ?? 'guard-secret',
  NODE_ENV: process.env.NODE_ENV ?? 'test',
});

const packageJson = read('package.json');
const ratesBackfill = read('src/services/rates-backfill.ts');
const syncScheduler = read('src/services/sync-scheduler.ts');
const syncJobQueue = read('src/services/sync-job-queue.ts');
const rateBackfillJobTypes = read('src/services/rate-backfill-job-types.ts');
const ordersView = read('web/src/components/Views/OrdersView.tsx');
const policySource = maybeRead('src/services/rate-preexpiry-refresh-policy.ts');
const proofSource = maybeRead('src/services/rate-preexpiry-refresh-proof.ts');
const refreshRequestSource = maybeRead('src/services/rate-preexpiry-refresh-request.ts');
const docSource = maybeRead('docs/ps-tickets/ps-348-pre-expiry-rate-refresh-proof.md');

const now = Date.parse('2026-06-29T12:00:00.000Z');
const { resolveRateQuoteForPurchase } = await import('../src/services/shipping-workflow/rate-quote-snapshot');
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
    'PS-348 has a focused backend proof module instead of growing the backfill file',
    proofSource.includes('createPreExpiryRefreshProof') &&
      proofSource.includes('recordPreExpirySelection') &&
      proofSource.includes('recordPreExpiryRefreshResult') &&
      proofSource.includes('liveRefreshed'),
  ),
  ok(
    'PS-348 has a focused backend refresh-request module instead of growing the backfill file',
    refreshRequestSource.includes('shouldForcePreExpiryLiveRefresh') &&
      refreshRequestSource.includes('buildBackfillRateFetchDecision') &&
      refreshRequestSource.includes('backfillUsesLiveRateBudget'),
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
      // Repointed (guard rot): e9762409 canonicalized the tuple keys the SQL reads.
      /cShippingRateAmount/.test(ratesBackfill) &&
      /selectedRateCost/.test(ratesBackfill),
  ),
  ok(
    'pre-expiry SQL binds cutoff as ISO text, not a JavaScript Date object',
    /preExpiryCutoffIso\s*=\s*new Date[\s\S]{0,120}\.toISOString\(\)/.test(ratesBackfill) &&
      /\(nullif\(\$\{orderOverrides\.bestRateJson\}->>'cacheExpiresAt', ''\)\)::timestamptz\s*<=\s*\$\{preExpiryCutoffIso\}::timestamptz/.test(ratesBackfill) &&
      !/\(nullif\(\$\{orderOverrides\.bestRateJson\}->>'cacheExpiresAt', ''\)\)::timestamptz\s*<=\s*\$\{preExpiryCutoff\}/.test(ratesBackfill),
  ),
  ok(
    'scheduler runs the rate backfill as explicit pre-expiry refresh, not manual force-live',
    /buildCadenceRateBackfillJobPayload/.test(syncScheduler) &&
      /requestedBy:\s*['"]cadence['"][\s\S]*options:\s*\{\s*mode:\s*['"]preexpiry_refresh['"]/.test(rateBackfillJobTypes),
  ),
  ok(
    'pg-boss scheduler still delegates to runBackfillTick for one backend-owned refresh path',
    // Audit 5.5 added explicit durable payloads; cadence payloads still take runBackfillTick.
    /registerWorker\(JOBS\.rateBackfill,[\s\S]*explicitRequest[\s\S]*runBackfillTick\(identity\.queueJobId, signal\)/.test(syncJobQueue),
  ),
  ok(
    'pre-expiry refresh is scheduler-scoped and forces live only for backend-selected non-fresh rows',
    /mode\?:\s*['"]cache_first['"]\s*\|\s*['"]full_live_audit['"]\s*\|\s*['"]preexpiry_refresh['"]/.test(ratesBackfill) &&
      /opts\.mode === ['"]preexpiry_refresh['"][\s\S]*cache_friendly/.test(ratesBackfill) &&
      /const liveRecalculate\s*=[^;]*full_live_audit[^;]*\|\|[^;]*maxAgeHours === 0/.test(ratesBackfill) &&
      /backfillUsesLiveRateBudget\(\{ liveRecalculate, mode: opts\.mode \}\)/.test(ratesBackfill) &&
      /buildBackfillRateFetchDecision\(\{[\s\S]*preExpiryRefreshReason/.test(ratesBackfill) &&
      /toGetRatesOptions\(rateFetchDecision\)/.test(ratesBackfill),
  ),
  ok(
    'backfill job snapshots carry pre-expiry selection/result proof',
    /preExpiryRefresh: PreExpiryRefreshProof \| null/.test(ratesBackfill) &&
      /preExpiryRefresh: job\.preExpiryRefresh/.test(ratesBackfill) &&
      /recordPreExpirySelection/.test(ratesBackfill) &&
      /recordPreExpiryRefreshResult/.test(ratesBackfill),
  ),
  ok(
    'pre-expiry refresh result proof ties saved tuple to forced live non-cached getRates result',
    /recordPreExpiryRefreshResult\(job\.preExpiryRefresh,\s*\{[\s\S]*forceRefresh:\s*rateFetchDecision\.forceRefresh[\s\S]*cached:\s*result\.cached/.test(ratesBackfill),
  ),
  ok(
    'PS-348 proof doc records scheduler/progress/log proof boundary',
    docSource.includes('## Scheduler Proof') &&
      docSource.includes('near-expiry') &&
      docSource.includes('cacheExpiresAt') &&
      docSource.includes('customerRateAmount') &&
      docSource.includes('rateCostAmount') &&
      docSource.includes('liveRefreshed') &&
      docSource.includes('No shipped/cancelled surfaces are touched'),
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
    selectionRef: 'qsel.rq_1.srk_1',
    isComplete: true,
    cShippingRateAmount: 12,
    selectedRateCost: 10,
    cacheExpiresAt: new Date(now + 30 * 60 * 1000).toISOString(),
  }, { nowMs: now, refreshLeadMs: 60 * 60 * 1000 });
  const fresh = policy.classifyRatePreExpiryRefresh({
    proofSource: 'backend_rate_response',
    requestFingerprint: 'fp',
    cacheKey: 'fp',
    rateQuoteId: 'rq_1',
    selectedRateKey: 'srk_1',
    selectionRef: 'qsel.rq_1.srk_1',
    isComplete: true,
    cShippingRateAmount: 12,
    selectedRateCost: 10,
    cacheExpiresAt: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
  }, { nowMs: now, refreshLeadMs: 60 * 60 * 1000 });
  const incompleteTuple = policy.classifyRatePreExpiryRefresh({
    proofSource: 'backend_rate_response',
    requestFingerprint: 'fp',
    cacheKey: 'fp',
    rateQuoteId: 'rq_1',
    selectedRateKey: 'srk_1',
    selectionRef: 'qsel.rq_1.srk_1',
    isComplete: true,
    cShippingRateAmount: 12,
    cacheExpiresAt: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
  }, { nowMs: now, refreshLeadMs: 60 * 60 * 1000 });
  checks.push(
    ok('policy classifies near-expiry complete tuple for refresh', near === 'near_expiry', String(near)),
    ok('policy leaves healthy tuple alone until the lead window', fresh === 'fresh', String(fresh)),
    ok('policy refreshes incomplete Best Rate + Rate Cost tuples together', incompleteTuple === 'incomplete_tuple', String(incompleteTuple)),
  );
}

if (proofSource) {
  const proof = createPreExpiryRefreshProof();
  const before = {
    proofSource: 'backend_rate_response',
    requestFingerprint: 'fp-old',
    cacheKey: 'fp-old',
    rateQuoteId: 'rq_old',
    selectedRateKey: 'srk_old',
    isComplete: true,
    cShippingRateAmount: 12,
    selectedRateCost: 10,
    cacheExpiresAt: new Date(now + 20 * 60 * 1000).toISOString(),
  };
  const after = {
    proofSource: 'backend_rate_response',
    requestFingerprint: 'fp-new',
    cacheKey: 'fp-new',
    rateQuoteId: 'rq_new',
    selectedRateKey: 'srk_new',
    isComplete: true,
    cShippingRateAmount: 12.25,
    selectedRateCost: 10.25,
    cacheExpiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
  };
  recordPreExpirySelection(proof, 'near_expiry');
  recordPreExpiryRefreshResult(proof, {
    before,
    after,
    updated: true,
    forceRefresh: true,
    cached: false,
  });
  checks.push(
    ok('proof records near-expiry selected rows', proof.selected === 1 && proof.reasons.near_expiry === 1, JSON.stringify(proof)),
    ok('proof records forced-live non-cached pre-expiry refreshes', proof.liveRefreshed === 1, JSON.stringify(proof)),
    ok('proof records pushed-forward cacheExpiresAt after refresh', proof.pushedForward === 1, JSON.stringify(proof)),
    ok('proof records customer and internal tuple refreshed together', proof.tupleRefreshed === 1, JSON.stringify(proof)),
  );
}

if (refreshRequestSource) {
  const nearExpiryDecision = buildBackfillRateFetchDecision({
    liveRecalculate: false,
    mode: 'preexpiry_refresh',
    preExpiryRefreshReason: 'near_expiry',
  });
  const freshDecision = buildBackfillRateFetchDecision({
    liveRecalculate: false,
    mode: 'preexpiry_refresh',
    preExpiryRefreshReason: 'fresh',
  });
  const cacheFirstDecision = buildBackfillRateFetchDecision({
    liveRecalculate: false,
    mode: 'cache_first',
    preExpiryRefreshReason: 'near_expiry',
  });
  checks.push(
    ok('pre-expiry selected near-expiry rows force live refresh', nearExpiryDecision.forceRefresh === true, JSON.stringify(nearExpiryDecision)),
    ok('pre-expiry fresh rows remain cache-allowed', freshDecision.forceRefresh === false, JSON.stringify(freshDecision)),
    ok('normal cache-first backfill still does not force live', cacheFirstDecision.forceRefresh === false, JSON.stringify(cacheFirstDecision)),
    ok('pre-expiry scheduler uses live timeout budget for selected rows', backfillUsesLiveRateBudget({ liveRecalculate: false, mode: 'preexpiry_refresh' }) === true),
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
