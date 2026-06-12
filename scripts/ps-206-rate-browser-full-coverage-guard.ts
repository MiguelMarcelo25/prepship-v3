/**
 * PS-206 guard — Rate Browser always covers the FULL scoped carrier universe.
 *
 * DJ's invariant: 1/2/3 carriers with cached rates is NEVER "good enough".
 * Opening Rate Browser may paint cached rows instantly, but every scoped
 * eligible carrier account must end in a TERMINAL state (live / cached /
 * unavailable / error / uncached→live-followed-up), 'loading' may exist only
 * while a request is actually in flight, and cachedOnly means cached-only
 * across the WHOLE combined universe (direct carriers are never silently
 * live-quoted during a cache paint).
 *
 * Behavioral checks run the PURE owners (rates-combined) directly; source pins
 * verify the wiring. Offline: no network, no DB, no postage.
 *
 *   npx tsx scripts/ps-206-rate-browser-full-coverage-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  combineCarrierUniverses,
  withCarrierQuoteTimeout,
  DIRECT_CARRIER_QUOTE_TIMEOUT_MS,
} from '../src/services/rates-combined';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

const baseInput = {
  ssCacheKey: 'fp_ps206',
  accountNamesByCarrierId: new Map<string, string>([
    ['se-100', 'SS Account A'],
    ['se-200', 'SS Account B'],
    ['se-300', 'SS Account C'],
  ]),
  accountCarrierIds: ['se-100', 'se-200', 'se-300'],
  requestedCarrierIds: ['se-100', 'se-200', 'se-300'],
};
const rate = (carrierId: string, amount: number) => ({
  carrier_id: carrierId,
  service_code: 'svc',
  shipping_amount: { amount },
});

// ── (1) 2+ carriers WITH cached rates is still INCOMPLETE coverage ────────────
{
  const combined = combineCarrierUniverses({
    ...baseInput,
    ssRates: [rate('se-100', 7.5), rate('se-200', 8.1)], // 2 carriers have rates
    ssCached: true,
    ssDiagnostics: [],
    directRates: [],
    // cached-only probe: the direct account was deliberately NOT quoted.
    directDiagnostics: [{ carrierId: 'se-10000025', nickname: 'Shipp Carrier', status: 'uncached', rateCount: 0 }],
    isCachedOnlyLookup: true,
  });
  const byId = new Map(combined.combinedCarrierStatuses.map((s) => [s.carrierId, s.status]));
  check('cached probe: 2 carriers with rates does NOT mean complete — uncovered SS account is terminal uncached (never loading)',
    byId.get('se-300') === 'uncached');
  check('cached probe: direct account reports terminal uncached coverage',
    byId.get('se-10000025') === 'uncached');
  check('cached probe with uncovered accounts is NEVER bestRateComplete',
    combined.bestRateComplete === false);
  check('no status rests at loading after a cached-only probe',
    combined.combinedCarrierStatuses.every((s) => s.status !== 'loading'));
}

// ── (2) full live coverage IS complete; one failed carrier is partial ─────────
{
  const live = combineCarrierUniverses({
    ...baseInput,
    ssRates: [rate('se-100', 7.5), rate('se-200', 8.1), rate('se-300', 9.9)],
    ssCached: false,
    ssDiagnostics: [],
    directRates: [rate('se-10000025', 6.9)],
    directDiagnostics: [{ carrierId: 'se-10000025', nickname: 'Shipp Carrier', status: 'ok', rateCount: 1 }],
    isCachedOnlyLookup: false,
  });
  check('full live fan-out with every account terminal-ok is complete', live.bestRateComplete === true);
  const partial = combineCarrierUniverses({
    ...baseInput,
    ssRates: [rate('se-100', 7.5), rate('se-200', 8.1), rate('se-300', 9.9)],
    ssCached: false,
    ssDiagnostics: [],
    directRates: [],
    directDiagnostics: [{ carrierId: 'se-10000025', nickname: 'Shipp Carrier', status: 'failed', rateCount: 0, error: 'Shipp Carrier rate request timed out after 25s' }],
    isCachedOnlyLookup: false,
  });
  const direct = partial.combinedCarrierStatuses.find((s) => s.carrierId === 'se-10000025');
  check('one timed-out/failed provider becomes a terminal per-carrier error',
    direct?.status === 'error' && /timed out/.test(direct?.error ?? ''));
  check('the rest of the universe still resolves (other carriers terminal, rates present)',
    partial.combinedRates.length === 3 && partial.bestRateComplete === false);
}

// ── (3) bounded per-carrier quoting (pure timeout rule) ───────────────────────
{
  let timedOut = false;
  await withCarrierQuoteTimeout(new Promise(() => { /* hangs forever */ }), 'Shipp Carrier', 30)
    .catch((err) => { timedOut = /timed out/.test(err instanceof Error ? err.message : ''); });
  check('a hung provider promise rejects with a timeout error instead of hanging the response', timedOut);
  const value = await withCarrierQuoteTimeout(Promise.resolve('rates'), 'Shipp Carrier', 1_000);
  check('a responsive provider passes through untouched', value === 'rates');
  check('the default quote timeout is bounded (≤ 30s)', DIRECT_CARRIER_QUOTE_TIMEOUT_MS <= 30_000);
}

// ── (4) wiring pins: cachedOnly honored end-to-end ────────────────────────────
const ratesService = readFileSync('src/services/rates.ts', 'utf8');
check('rates service: cached-only lookups return uncached coverage WITHOUT quoting direct carriers',
  /options\.cachedOnly\)\s*\{[\s\S]{0,700}?status: 'uncached' as CarrierRateDiagnosticStatus/.test(ratesService));
check('rates service: direct quoting is wrapped in the bounded per-carrier timeout',
  /withCarrierQuoteTimeout\(quoteCarrierRates\(/.test(ratesService));
const ratesRoute = readFileSync('src/routes/rates.ts', 'utf8');
check('/rates/browse passes cachedOnly through to the direct universe',
  /getDirectCarrierRatesForRateInput\(\{[\s\S]{0,200}?\}, \{ cachedOnly: isCachedOnlyLookup \}\)/.test(ratesRoute));
check('the misleading source ternary is gone (cache+live-direct reports mixed)',
  !/source: result\.cached \? 'cache' : filtered\.length \? 'live' : 'live'/.test(ratesRoute) &&
  /'mixed' : 'cache'/.test(ratesRoute));
const combinedSrc = readFileSync('src/services/rates-combined.ts', 'utf8');
check('combined owner: cached-only missing carriers are terminal uncached, never resting loading',
  /isCachedOnlyLookup \? 'uncached' : 'unavailable'/.test(combinedSrc));
check('combined owner: completeness rejects uncached coverage',
  /status\.status !== 'loading' && status\.status !== 'error' && status\.status !== 'uncached'/.test(combinedSrc));

// ── (5) Rate Browser pins: coverage identity drives the follow-up ─────────────
const modal = readFileSync('web/src/components/RateBrowserModal.tsx', 'utf8');
check('the carrier-COUNT live-fanout heuristic is deleted',
  !/cachedCarrierCount/.test(modal) && !/carriersWithRates\s*<=\s*\d/.test(modal));
check('the open flow live-fetches when ANY scoped account is uncovered',
  /probe\.uncoveredPids\.length > 0/.test(modal) &&
  /await browseRates\(undefined, \{ forceLive: true \}\)/.test(modal));
check('cached-only paint marks unc covered accounts terminal uncached (not loading)'.replace('unc covered', 'uncovered'),
  /options\.cachedOnly\)\s*\{[\s\S]{0,500}?\?\?= 'uncached'/.test(modal));
check('header in-flight count derives ONLY from genuinely pending requests',
  /rateShippingAccounts\.filter\(\(c\) => pendingPids\.has\(c\.shippingProviderId\)\)\.length/.test(modal) &&
  !/carrierStatusByPid\[key\] === 'loading'/.test(modal));
check('a failed browse leaves every scoped account terminal error (no blank/loading rest state)',
  /setCarrierStatusByPid\(\s*\n\s*Object\.fromEntries\(rateShippingAccounts\.map\(\(acct\) => \[String\(acct\.shippingProviderId\), 'error'/.test(modal));
check('backend quote proof fields still flow on browse rows (rateQuoteId + selectedRateKey untouched)',
  /rateQuoteId/.test(ratesRoute) && /withSelectedRateKeys|selectedRateKey/.test(ratesRoute));
const sidebar = readFileSync('web/src/components/RateBrowserCarrierSidebar.tsx', 'utf8');
check('sidebar renders uncached as its own terminal state (distinct from the in-flight spinner)',
  /carrierStatus === 'uncached'/.test(sidebar));

if (failures > 0) {
  console.error(`\nFAIL PS-206 rate-browser full-coverage guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-206 rate-browser full-coverage guard');
