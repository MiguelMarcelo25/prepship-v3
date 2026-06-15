/**
 * PS-265 (sync drain) guard — shipments sync drains the backlog incrementally instead of
 * timing out forever.
 *
 * Root cause: syncShipments walked the ENTIRE ShipStation backlog in one run (uncapped
 * `while(true)`) and only advanced its watermark on FULL success. A run that exceeded the
 * 10-min handler deadline was killed mid-walk, the watermark never advanced, and the next run
 * re-pulled the identical backlog and timed out again — draining nothing. Fix: a per-run page
 * + wall-clock budget; on a budget-bounded run the watermark resumes from the last processed
 * CreateDate (results are CreateDate ASC, so no shipment is skipped). This unit-tests the
 * budget helper and statically pins the incremental-drain wiring in shipment-sync.
 *
 *   npx tsx scripts/ps-265-sync-run-budget-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  createSyncRunBudget,
  syncRunBudgetExhausted,
  syncRunBudgetTimeExhausted,
  DEFAULT_SYNC_MAX_PAGES_PER_RUN,
} from '../src/lib/sync-run-budget';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}
function read(p: string): string { try { return readFileSync(p, 'utf8'); } catch { return ''; } }

// ── budget helper (deterministic via explicit startedAtMs/nowMs) ──────────────
const b = createSyncRunBudget({ startedAtMs: 1000, maxPages: 10, timeBudgetMs: 60_000 });
check('page budget: pages >= maxPages exhausts', syncRunBudgetExhausted(b, 10, 1000) === true);
check('page budget: pages < maxPages, time left -> not exhausted', syncRunBudgetExhausted(b, 9, 1000) === false);
check('time budget: elapsed >= timeBudget exhausts (even with pages left)', syncRunBudgetExhausted(b, 1, 61_001) === true);
check('time-only check: under budget -> false', syncRunBudgetTimeExhausted(b, 1000) === false);
check('time-only check: over budget -> true', syncRunBudgetTimeExhausted(b, 61_001) === true);
check('defaults: maxPages = 10 (5000 rows/run), time budget < 10-min deadline',
  createSyncRunBudget().maxPages === DEFAULT_SYNC_MAX_PAGES_PER_RUN
  && createSyncRunBudget().timeBudgetMs < 600_000);
check('clamps: maxPages >= 1, timeBudget >= 10s',
  createSyncRunBudget({ maxPages: 0, timeBudgetMs: 1 }).maxPages === 1
  && createSyncRunBudget({ maxPages: 0, timeBudgetMs: 1 }).timeBudgetMs === 10_000);

// ── shipment-sync wiring: bounded + incremental + safe ───────────────────────
const ship = read('src/services/shipment-sync.ts');
check('shipment-sync imports the run budget', ship.includes("from '../lib/sync-run-budget'"));
check('shipment-sync creates a run budget', /const budget = createSyncRunBudget\(\)/.test(ship));
check('V1 page loop breaks on the per-account page/time budget',
  /syncRunBudgetExhausted\(budget, pagesThisAccount\)/.test(ship));
check('tracks the newest processed CreateDate as a resume cursor',
  /cursorCreateMs/.test(ship) && /Date\.parse\(s\.createDate/.test(ship));
check('watermark resumes from the cursor on a budget-bounded run, advances to now on full drain',
  /drained \? runStartMs : cursorCreateMs/.test(ship));
check('run-level time budget stops starting new accounts',
  /syncRunBudgetTimeExhausted\(budget\)\) break/.test(ship));
check('V2 enrichment is skipped when out of time budget',
  /if \(!syncRunBudgetTimeExhausted\(budget\)\) \{/.test(ship));
check('the deadline is NOT raised (no JOB_HANDLER_TIMEOUT_MS change here)',
  !/JOB_HANDLER_TIMEOUT_MS/.test(ship));

// ── order-sync wiring (slice 2): bounded + awaiting-first ────────────────────
const ord = read('src/services/order-sync.ts');
check('order-sync imports the run budget', ord.includes("from '../lib/sync-run-budget'"));
check('syncOrders creates a run-wide budget', /const budget = createSyncRunBudget\(\)/.test(ord));
check('fetchOrdersPage breaks on the per-pass page/time budget',
  /syncRunBudgetExhausted\(budget, pagesThisPass\)/.test(ord));
check('the awaiting_shipment pass runs BEFORE the status catch-up passes (no new-order starvation)',
  ord.indexOf("orderStatus: 'awaiting_shipment'") > -1
  && ord.indexOf("orderStatus: 'awaiting_shipment'") < ord.indexOf('const passes:'));
check('status catch-up passes stop when the run is out of time budget',
  /if \(syncRunBudgetTimeExhausted\(budget\)\) break;[\s\S]{0,200}orderStatus: pass\.orderStatus/.test(ord));
check('order-sync stops starting new accounts near the deadline',
  (ord.match(/syncRunBudgetTimeExhausted\(budget\)\) break/g) ?? []).length >= 2);

const pkg = read('package.json');
check('package.json wires test:ps-265-sync-run-budget', /test:ps-265-sync-run-budget/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-265 sync-run-budget guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-265 sync-run-budget guard');
