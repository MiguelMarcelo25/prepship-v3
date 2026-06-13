/**
 * PS-241 guard — Rate Browser live carrier fan-out (regression lock).
 *
 * The original bug (cached-only probe live-quoting direct carriers → 2 > 1 →
 * live fan-out skipped → ShipStation accounts stuck on a permanent "Checking
 * carriers…") was fixed by PS-206 (coverage-driven fan-out) + the existing
 * per-quote timeouts. PS-241 keeps that fixed: this guard pins the four invariants
 * so a future change can't silently reintroduce the hang.
 *
 *   npx tsx scripts/ps-241-rate-browser-fanout-guard.ts
 */
import { readFileSync } from 'node:fs';

const routesRates = readFileSync('src/routes/rates.ts', 'utf8');
const svcRates = readFileSync('src/services/rates.ts', 'utf8');
const ratesCombined = readFileSync('src/services/rates-combined.ts', 'utf8');
const ssClient = readFileSync('src/lib/shipstation/client.ts', 'utf8');
const modal = readFileSync('web/src/components/RateBrowserModal.tsx', 'utf8');
const pkg = readFileSync('package.json', 'utf8');

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// 1. The cached-only probe is GENUINELY cache-only — direct carriers are not
//    live-quoted during it (the original bug #1). The route threads cachedOnly
//    into the direct-carrier path, and the service short-circuits to empty.
check('route passes cachedOnly into the direct-carrier path',
  /getDirectCarrierRatesForRateInput\([\s\S]*?cachedOnly:\s*isCachedOnlyLookup/.test(routesRates));
check('cachedOnly lookup is gated (not forceRefresh/forceLive)',
  /isCachedOnlyLookup = Boolean\(cachedOnly && !forceRefresh && !forceLive\)/.test(routesRates));
check('service returns empty on a cached-only lookup (no live quote)',
  /if \(opts\.cachedOnly\)[\s\S]{0,200}rates: \[\],/.test(svcRates));

// 2. The follow-up fan-out is COVERAGE-driven, not a carrier-COUNT heuristic.
check('modal fans out on uncovered coverage identity', modal.includes('probe.uncoveredPids.length > 0'));
check('modal does NOT use a <=1 carrier-count heuristic to decide fan-out',
  !/(carriers?WithRates|ratedCount|withRates)\s*<=\s*1/.test(modal));

// 3. A hung provider can't hang the response — per-quote timeouts exist.
check('direct-carrier quotes are timeout-bounded',
  /DIRECT_CARRIER_QUOTE_TIMEOUT_MS/.test(ratesCombined) && /Promise\.race/.test(ratesCombined) && /timed out/.test(ratesCombined));
check('ShipStation client requests are timeout-bounded (AbortSignal.timeout)',
  /AbortSignal\.timeout/.test(ssClient));

// 4. Empty/no-service results are cached only BRIEFLY (short negative TTL), so a
//    transient failure doesn't poison the cache for the full TTL.
check('empty results use the short negative cache TTL',
  /cacheTtlMs = cachedRaw\.length \? CACHE_TTL_MS : RATE_NEGATIVE_CACHE_TTL_MS/.test(svcRates));

// 5. The misleading no-op `source: x ? 'live' : 'live'` ternary is gone.
check('no no-op live/live source ternary', !/\?\s*'live'\s*:\s*'live'/.test(routesRates));

// Self-wiring.
check('package.json exposes test:ps-241-rate-browser-fanout', /test:ps-241-rate-browser-fanout/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-241 rate-browser fan-out guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-241 rate-browser fan-out guard');
