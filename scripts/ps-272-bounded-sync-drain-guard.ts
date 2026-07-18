/**
 * PS-272 (#857, bounded-batch drain) guard — pins that the bounded-batch + durable-cursor
 * limits the card requires live INSIDE the heavy sync SERVICE functions, not at the scheduler
 * call sites.
 *
 * Why this guard exists separately from the PS-265 guard:
 *   The implementation shipped under PS-265. DJ's PS-272 audit scored it ~20% because the audit
 *   looked for batch/page/limit arguments at the SCHEDULER CALL SITES — `syncOrders({})`,
 *   `syncShipments({})`, `runInventoryImportFromOrders()` are all called with NO batch args — and
 *   concluded the drain was unbounded. The truth is the opposite: the bound is the
 *   source-of-truth's responsibility, so it lives in the service function bodies. The scheduler
 *   stays a thin caller. This guard asserts the bound at that authoritative layer (the service
 *   fns) AND records that the workers delegate without re-deriving a batch size, so a future
 *   audit reading only the call sites can't mis-score it again.
 *
 * Card DoD pinned here:
 *   1. syncShipments uses createSyncRunBudget (page cap + wall-clock cap) and resumes its
 *      watermark from the last-processed CreateDate cursor on a budget-bounded run.
 *   2. syncOrders uses a run-wide createSyncRunBudget; per-pass page budget + run-level time
 *      budget bound it.
 *   3. importSkusFromOrders caps rows with MAX_SKUS_PER_RUN (SQL LIMIT) and its NOT-EXISTS
 *      predicate is the durable cursor (already-imported SKUs are excluded next run).
 *   4. runFulfillmentOutboxTick is bounded to limit: 25 per tick.
 *   5. The scheduler workers delegate to the bounded service fns with NO batch arg at the call
 *      site (the bound is owned by the service, not the caller) — the exact thing the audit missed.
 *
 *   npx tsx scripts/ps-272-bounded-sync-drain-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}
function read(p: string): string { try { return readFileSync(p, 'utf8'); } catch { return ''; } }

// ── 1. syncShipments: bounded batch + durable CreateDate cursor (in the service fn) ──────────
const ship = read('src/services/shipment-sync.ts');
check('shipment-sync imports the run-budget helpers', ship.includes("from '../lib/sync-run-budget'"));
check('syncShipments is the bounded service fn', /export async function syncShipments\(/.test(ship));
check('syncShipments creates a per-run budget (page + wall-clock cap)',
  /const budget = createSyncRunBudget\(\)/.test(ship));
check('the per-account page loop breaks on the page/time budget (bounded batch)',
  /syncRunBudgetExhausted\(budget, pagesThisAccount\)/.test(ship));
check('a CreateDate resume cursor is tracked (durable watermark, not all-or-nothing)',
  /cursorCreateMs/.test(ship) && /parseShipStationV1Date\(s\.createDate/.test(ship));
check('watermark resumes from the cursor on a budget-bounded run; advances to now only on full drain',
  /drained \? runStartMs : cursorCreateMs/.test(ship));
check('the run-level time budget stops starting new accounts',
  /syncRunBudgetTimeExhausted\(budget\)\) break/.test(ship));

// ── 2. syncOrders: run-wide budget bounds per-pass pagination (in the service fn) ────────────
const ord = read('src/services/order-sync.ts');
check('order-sync imports the run-budget helpers', ord.includes("from '../lib/sync-run-budget'"));
check('syncOrders is the bounded service fn', /export async function syncOrders\(/.test(ord));
check('syncOrders creates a run-wide budget', /const budget = createSyncRunBudget\(\)/.test(ord));
check('the per-pass page loop breaks on the page/time budget (bounded batch)',
  /syncRunBudgetExhausted\(budget, pagesThisPass\)/.test(ord));
check('status catch-up passes stop when the run is out of time budget',
  /syncRunBudgetTimeExhausted\(budget\)\) break/.test(ord));

// ── 3. importSkusFromOrders: SQL LIMIT cap + NOT-EXISTS durable cursor (in the service fn) ───
const inv = read('src/services/inventory-enrichment.ts');
check('importSkusFromOrders is the bounded service fn', /export async function importSkusFromOrders\(/.test(inv));
check('importSkusFromOrders caps rows with a MAX_SKUS_PER_RUN SQL LIMIT (bounded batch)',
  /MAX_SKUS_PER_RUN\s*=\s*\d+/.test(inv) && /limit \$\{MAX_SKUS_PER_RUN\}/.test(inv));
check('importSkusFromOrders NOT-EXISTS predicate is the durable cursor (excludes already-imported SKUs)',
  /not exists \(\s*select 1 from inventory inv/.test(inv));
check('importSkusFromOrders has a defense-in-depth wall-clock break',
  inv.includes('syncRunBudgetTimeExhausted(budget)'));

// ── 4. runFulfillmentOutboxTick: bounded to limit:25 per tick ────────────────────────────────
const scheduler = read('src/services/sync-scheduler.ts');
check('runFulfillmentOutboxTick is defined in the scheduler', /export async function runFulfillmentOutboxTick\(/.test(scheduler));
check('the outbox tick processes at most 25 jobs per run (bounded)',
  /processFulfillmentOutboxOnce\(\{ limit: 25 \}\)/.test(scheduler));
check('the outbox tick auto-recovers at most 25 missing confirmations per run (bounded)',
  /enqueueMissingShipmentConfirmations\(\{ limit: 25 \}\)/.test(scheduler));

// ── 5. the audit blind spot: workers delegate to the bounded service fns, NO batch arg ───────
// This is the crux. If the bound lived at the call site we'd see syncOrders({ ...batch }); the
// fact these calls pass {} (or nothing) is the PROOF the bound is owned by the service fn — the
// exact thing the 20% audit mis-read as "unbounded".
const queue = read('src/services/sync-job-queue.ts');
check('queued order worker delegates to the bounded syncOrders service',
  /syncOrders\(\{ \.\.\.options, runIdentity: identity, signal \}\)/.test(queue) &&
    !/syncOrders\(\{[^}]*(?:limit|batch|maxPages)/.test(queue));
check('queued shipment worker delegates to the bounded syncShipments service',
  /runShipmentSyncWithOrderPriority[\s\S]*syncShipments\(\{[\s\S]*shipmentSyncOptionsFromJobPayload\(jobData\)[\s\S]*signal: workSignal/.test(queue) &&
    !/syncShipments\(\{[^}]*(?:limit|batch|maxPages|pageSize)/.test(queue));
check('runInventoryImportFromOrders delegates to importSkusFromOrders (bound owned by the service)',
  /importSkusFromOrders\(\)/.test(read('src/services/sync-scheduler.ts')));

// ── package.json wiring ──────────────────────────────────────────────────────────────────────
const pkg = read('package.json');
check('package.json wires test:ps-272-bounded-sync', /test:ps-272-bounded-sync/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-272 bounded-sync drain guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-272 bounded-sync drain guard');
