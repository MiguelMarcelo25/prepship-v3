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
const rowsView = readFileSync('web/src/components/RateRowsView.tsx', 'utf8');
const openWorkflow = readFileSync('web/src/components/rate-browser-open-workflow.ts', 'utf8');
const pkg = readFileSync('package.json', 'utf8');

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// 1. The premature-best gate exists: a cached-only probe with pending live coverage is awaiting.
// Repointed (guard rot): PS-345/346 renamed awaitingLiveFanout -> cachedProbeHasIncompleteCoverage
// (same cachedOnly + uncovered-coverage predicate).
check('defines the incomplete-coverage gate from cachedOnly + uncovered coverage',
  /const cachedProbeHasIncompleteCoverage = options\.cachedOnly === true && uncoveredPids\.length > 0/.test(modal));

// 2. onBestRateResolved is emitted ONLY when the cached probe has full coverage (or the browse is live).
check('onBestRateResolved emission is gated behind !cachedProbeHasIncompleteCoverage',
  /if \(!cachedProbeHasIncompleteCoverage && onBestRateResolved && \(liveFetchedRates\.length \|\| seededBestRate\)\)/.test(modal));

// 3. Exactly two onBestRateResolved(applied) sites: the testMode immediate emit (no live
//    fan-out ever follows it — uncoveredPids stays empty in that branch) and the gated
//    real-path emission. No third, ungated bypass in the live path.
// Repointed 2026-08-05. This required exactly TWO emit call sites: a testMode immediate
// emit plus the gated real-path emit. There is one now, and the one that went is the
// IMMEDIATE one -- PS-345/346 deleted the modal-open cached probe it lived on (the note
// further down in this file already records that deletion). The survivor is the gated
// path: decision.kind === 'emit' && rateIsBackendComplete(decision.rate).
//
// Losing an ungated immediate emit is the safe direction for a guard whose entire point
// is "no premature best rate", so requiring two would be requiring the bypass back.
// Tightened instead: ONE call site, it must be gated on both the backend emission
// decision and backend completeness, and the parent callback must only ever be reached
// through the single emitBestRateResolved funnel.
check('the only best-rate emit is the gated one (no ungated bypass)',
  (modal.match(/emitBestRateResolved\(applied\)/g) ?? []).length === 1
  && /decision\.kind === 'emit' && rateIsBackendComplete\(decision\.rate\)[\s\S]{0,400}?emitBestRateResolved\(applied\)/.test(modal)
  && (modal.match(/onBestRateResolved\?\.\(applied\)/g) ?? []).length === 1
  && /function emitBestRateResolved\([\s\S]{0,300}?onBestRateResolved\?\.\(applied\)/.test(modal));

// 4. Repointed (guard rot): PS-345/346 supersede the PS-241 coverage-driven escalation —
//    the modal-open cached probe was deleted and open now loads ALL rates live via the
//    shared open-workflow options (forceLive: true), so no partial-coverage window exists.
check('PS-346 load-all-on-open replaces the coverage-driven escalation (open goes straight live)',
  modal.includes('browseRates(undefined, rateBrowserOpenBrowseOptions())') &&
  openWorkflow.includes('forceLive: true'));

// 5. PS-196 preserved — the cached seed is still painted (visible) during the probe.
check('PS-196 cache-first seed paint preserved (seededBestRate still rendered)',
  modal.includes('buildOrderBestRateSeed(order') && /\[String\(seededPid\)\]: \[seededBestRate\]/.test(modal));

// 6. PS-135 preserved — the emitted best is still the canonical backend winner, not a re-rank.
check('emitted best still consumes the canonical backend winner',
  modal.includes('findCanonicalBestRate(canonicalBackendBest'));

// 7. The visible "Recommended" badge must be tied to the backend-final canonical
//    winner, not the first row of an in-flight/provisional local sort.
check('RateRowsView delegates recommended badge ownership to backend-final predicate',
  /isRecommendedRate: \(rate: RateRow\) => boolean/.test(rowsView) &&
  /renderRateRow\(r, i, true, isRecommendedRate\(r\)\)/.test(rowsView) &&
  /renderRateRow\(r, i, false, isRecommendedRate\(r\)\)/.test(rowsView) &&
  !/renderRateRow\(r, i, true, i === firstOk\)/.test(rowsView) &&
  !/renderRateRow\(r, i, false, i === firstOk\)/.test(rowsView));

check('RateBrowserModal recommends only the backend complete canonical best after carrier checks finish',
  /function isRecommendedRate\(r: RateRow\): boolean/.test(modal) &&
  /totalCarriersLoading > 0/.test(modal) &&
  /findCanonicalBestRate\(canonicalBestRef\.current, \[r\]\) === r/.test(modal) &&
  /rateIsBackendComplete\(r\)/.test(modal) &&
  /isRecommendedRate=\{isRecommendedRate\}/.test(modal));

// Self-wiring.
check('package.json exposes test:ps-260-premature-best-rate', /test:ps-260-premature-best-rate/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-260 premature best-rate guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-260 premature best-rate guard');
