/**
 * PS-260 guard — Rate Browser must not surface a "best rate" before the live fan-out finalizes.
 *
 * On open the modal paints an instant cached seed (PS-196) and runs a cached-only PROBE, then a
 * live fan-out whenever the probe left scoped accounts uncovered (PS-206/PS-241). The bug: the
 * shared browseRates body fired onBestRateResolved whenever `(liveFetchedRates.length ||
 * seededBestRate)` was truthy — true during the cached-only probe (seed present, no live rates) —
 * so a premature/partial best was persisted to the order panel and auto-selected BEFORE the live
 * fan-out ran, while the UI still showed "Checking carriers…".
 *
 * The fix gates the emission on `!(options.cachedOnly && uncoveredPids.length > 0)` so the
 * canonical best is only resolved once the fan-out is complete (or when a cached probe has full
 * coverage and no live follow-up). This statically pins the gate without weakening PS-196's
 * cache-first paint or PS-241's coverage-driven fan-out. The live render is DJ's canary.
 *
 *   npx tsx scripts/ps-260-premature-best-rate-guard.ts
 */
import { readFileSync } from 'node:fs';

const modal = readFileSync('web/src/components/RateBrowserModal.tsx', 'utf8');
const pkg = readFileSync('package.json', 'utf8');

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// 1. The premature-best gate exists: a cached-only probe with pending live coverage is awaiting.
check('defines the awaiting-live-fanout gate from cachedOnly + uncovered coverage',
  /awaitingLiveFanout\s*=\s*options\.cachedOnly === true && uncoveredPids\.length > 0/.test(modal));

// 2. onBestRateResolved is emitted ONLY when not awaiting the live fan-out.
check('onBestRateResolved emission is gated behind !awaitingLiveFanout',
  /if \(!awaitingLiveFanout && onBestRateResolved && \(liveFetchedRates\.length \|\| seededBestRate\)\)/.test(modal));

// 3. Exactly two onBestRateResolved(applied) sites: the testMode immediate emit (no live
//    fan-out ever follows it — uncoveredPids stays empty in that branch) and the gated
//    real-path emission. No third, ungated bypass in the live path.
check('only the testMode immediate emit + the gated real-path emit exist (no ungated bypass)',
  (modal.match(/onBestRateResolved\(applied\)/g) ?? []).length === 2
  && /if \(applied && onBestRateResolved\) onBestRateResolved\(applied\);/.test(modal));

// 4. PS-241 preserved — the coverage-driven live fan-out still runs after the probe.
check('PS-241 coverage-driven live fan-out still runs on uncovered probe',
  modal.includes('probe.uncoveredPids.length > 0') && /browseRates\(undefined, \{ forceLive: true \}\)/.test(modal));

// 5. PS-196 preserved — the cached seed is still painted (visible) during the probe.
check('PS-196 cache-first seed paint preserved (seededBestRate still rendered)',
  modal.includes('buildOrderBestRateSeed(order') && /\[String\(seededPid\)\]: \[seededBestRate\]/.test(modal));

// 6. PS-135 preserved — the emitted best is still the canonical backend winner, not a re-rank.
check('emitted best still consumes the canonical backend winner',
  modal.includes('findCanonicalBestRate(canonicalBackendBest'));

// Self-wiring.
check('package.json exposes test:ps-260-premature-best-rate', /test:ps-260-premature-best-rate/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-260 premature best-rate guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-260 premature best-rate guard');
