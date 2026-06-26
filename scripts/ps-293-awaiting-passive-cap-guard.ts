/**
 * PS-293 (slice 1) — Awaiting Best Rate must not drain the full table from the browser.
 *
 * THE BUG (DJ screenshot): HUGRAB Awaiting rows only populate the correct rate/House tuple after
 * clicking Browse Rates one row at a time. ROOT: the passive auto-rating effect drained the ENTIRE
 * unresolved queue live from the browser (`queue.splice(0)`, "no count cap"), so a 40+ row table
 * fired 40+ live carrier-rate jobs from the frontend.
 *
 * SLICE 1 (the card's immediate safety requirement, no regression): cap the BROWSER to
 * PASSIVE_LIVE_BEST_RATE_MAX_ROWS=5 live requests per mount, and HAND the overflow to the canonical
 * backend backfill (the same job manual Recalculate All uses, but CACHE-FRIENDLY via a positive
 * maxAgeHours) so the rest are rated server-side without per-row Browse Rates clicks. The existing
 * recalc poll refetches as rows resolve.
 *
 *   npx tsx scripts/ps-293-awaiting-passive-cap-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
const recalcAll = readFileSync('web/src/components/Views/orders-recalculate-all.ts', 'utf8');

// 1. The cap constant exists and is 5.
check('OrdersView defines PASSIVE_LIVE_BEST_RATE_MAX_ROWS = 5',
  /const PASSIVE_LIVE_BEST_RATE_MAX_ROWS = 5\b/.test(ordersView));

// 2. The browser drain is CAPPED by a mount-scoped budget (no longer the full-table `queue.splice(0)`).
check('passive drain uses a mount-scoped live budget (count ref vs the cap)',
  /passiveLiveBestRateCountRef/.test(ordersView) &&
  /const liveBudget = Math\.max\(0, PASSIVE_LIVE_BEST_RATE_MAX_ROWS - passiveLiveBestRateCountRef\.current\)/.test(ordersView) &&
  /const liveQueue = queue\.splice\(0, liveBudget\)/.test(ordersView));
check('the old uncapped full-table drain (queue.splice(0) as liveQueue) is gone',
  !/const liveQueue = queue\.splice\(0\)\s*$/m.test(ordersView));

// 3. The overflow is handed to the backend backfill, de-duped. It is CACHE-FRIENDLY for a normal
//    overflow, but FORCE-LIVE (maxAgeHours:0) when ANY overflow row is DISPLAY-STALE (forceLive) — else
//    a display-stale row past the 5-row browser budget would never self-correct (the cache sweep serves
//    its stale price and its 24h gate even skips a <24h row). The browser 5-cap (checks 1–2 above) still
//    bounds the LIVE-from-browser fan-out unchanged; this only changes the BACKEND sweep's freshness.
check('overflow is handed to the backend backfill (startRecalculateAllBestRates) when it exists',
  /const overflow = queue\.splice\(0\)/.test(ordersView) &&
  /overflow\.length > 0 && !passiveBackfillStartedRef\.current/.test(ordersView) &&
  /startRecalculateAllBestRates\(overflowMaxAgeHours\)/.test(ordersView));
check('passive backfill is cache-friendly by default, force-live ONLY for a display-stale overflow',
  /const PASSIVE_BACKFILL_MAX_AGE_HOURS = \d+/.test(ordersView) &&
  !/PASSIVE_BACKFILL_MAX_AGE_HOURS = 0\b/.test(ordersView) &&
  /overflow\.some\(\(candidate\) => candidate\.forceLive\)[\s\S]{0,24}\?\s*0[\s\S]{0,24}:\s*PASSIVE_BACKFILL_MAX_AGE_HOURS/.test(ordersView));
check('overflow handoff is de-duped so a mid-job refetch cannot double-kick the backend job',
  /passiveBackfillStartedRef\.current = true/.test(ordersView) &&
  /passiveBackfillStartedRef\.current = false/.test(ordersView));

// 4. The backend trigger is parameterized (manual Recalculate All stays force-live; passive passes 24h).
check('startRecalculateAllBestRates accepts a maxAgeHours param (default 0 = manual force-live)',
  /export async function startRecalculateAllBestRates\(maxAgeHours = 0\)/.test(recalcAll) &&
  /'\/rates\/backfill-best', \{ maxAgeHours \}/.test(recalcAll));

if (failures > 0) {
  console.error(`\nFAIL PS-293 awaiting passive-cap guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-293 awaiting passive-cap guard');
