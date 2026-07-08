/**
 * PS-293 superseded by PS-345.
 *
 * Historical PS-293 capped Awaiting's browser-owned passive live-rate drain at
 * five rows and handed overflow to backend backfill. PS-345 removes the passive
 * frontend drain entirely. This guard now preserves the important no-regression
 * invariant: the old uncapped/full-table browser drain must stay gone, live
 * backfill remains backend/manual-intent owned, and PS-345 owns the new runtime
 * contract.
 *
 *   npx tsx scripts/ps-293-awaiting-passive-cap-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (!cond) {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` - ${detail}` : ''}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
const recalcAll = readFileSync('web/src/components/Views/orders-recalculate-all.ts', 'utf8');
const packageJson = readFileSync('package.json', 'utf8');
const ps345Guard = readFileSync('scripts/ps-345-rate-loading-sot-guard.ts', 'utf8');
const ps345Doc = readFileSync('docs/ps-tickets/ps-345-rate-loading-sot.md', 'utf8');

check('PS-345 guard is registered as the active rate-loading SOT contract',
  packageJson.includes('"test:ps-345-rate-loading-sot": "tsx scripts/ps-345-rate-loading-sot-guard.ts"'));

check('OrdersView no longer defines the PS-293 browser passive live-rate cap',
  !/PASSIVE_LIVE_BEST_RATE_MAX_ROWS|PASSIVE_LIVE_BEST_RATE_CONCURRENCY/.test(ordersView));

check('OrdersView no longer owns a page-mount passive live-rate worker',
  !/runPassiveAutoRating|refreshVisibleBestRate|fetchCachedRatesBulk/.test(ordersView));

check('the old uncapped full-table browser drain is still gone',
  !/const liveQueue = queue\.splice\(0\)\s*$/m.test(ordersView));

check('OrdersView no longer starts hidden passive backend backfill on page load',
  !/passiveBackfillStartedRef|startRecalculateAllBestRates\(overflowMaxAgeHours\)/.test(ordersView));

check('manual Recalculate All remains an explicit backend cache-first backfill entry point',
  /async function handleRecalculateAll\(\)[\s\S]{0,260}startRecalculateAllBestRates\(\)/.test(ordersView) &&
    /export async function startRecalculateAllBestRates\(maxAgeHours = FAST_RECALCULATE_MAX_AGE_HOURS\)/.test(recalcAll) &&
    /mode:\s*'cache_first'/.test(recalcAll) &&
    /export async function startFullLiveRecalculateAllBestRates/.test(recalcAll) &&
    /mode:\s*'full_live_audit'/.test(recalcAll));

check('PS-345 guard explicitly protects against reintroducing passive live orchestration',
  ps345Guard.includes('OrdersView no longer runs a page-mount passive auto-rating worker') &&
    // Repointed (guard rot): PS-346 inverted the modal open effect to a live workflow;
    // the PS-345 guard's anti-passive check title moved with it.
    ps345Guard.includes('RateBrowserModal open live workflow does not reintroduce Awaiting-table passive rate loading'));

check('PS-345 doc records the superseding manual/backend ownership boundary',
  ps345Doc.includes('Keep explicit manual controls') &&
    ps345Doc.includes('No shipped/cancelled surfaces are touched'));

if (failures > 0) {
  console.error(`\nFAIL PS-293 awaiting passive-cap supersession guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-293 awaiting passive-cap supersession guard');
