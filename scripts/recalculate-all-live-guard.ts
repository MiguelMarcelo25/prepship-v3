/**
 * Recalculate All — live fan-out + visible progress guard.
 *
 * THE BUG (DJ, 2026-06-12): clicking Recalculate All (a) re-served CACHED rate
 * sets — a set cached while one carrier errored "recalculated" to a worse
 * winner than a manual Browse Rates ($13.00 UPS vs the live $11.66 FedEx) —
 * and (b) gave no per-row feedback: rows with fresh saved rates never received
 * the pending/rating override (the PS-120 fresh-rate gate), and the FE only
 * refetched rows when the job FINISHED.
 *
 * THE FIX:
 *   1. rates-backfill: maxAgeHours === 0 (the Recalculate All signature) now
 *      forces getRates({ forceRefresh: true }) — the same full live carrier
 *      fan-out manual Browse Rates uses. Nightly/passive sweeps unchanged.
 *   2. order-rate-job-status: an ACTIVE 'rating' overrides even a fresh saved
 *      rate (the worker is re-rating it NOW); only the queued 'pending' stamp
 *      defers to fresh (leftover-stamp protection).
 *   3. OrdersView: rows being re-rated show a watchdog-bounded spinner beside
 *      the saved amount (PS-196 value preserved), and the poll effect refetches
 *      rows DURING the job so each fresh best rate lands as it resolves.
 *
 *   npx tsx scripts/recalculate-all-live-guard.ts
 */
import { readFileSync } from 'node:fs';
import { resolveRateJobWorkflowOverride } from '../src/services/shipping-workflow/order-rate-job-status';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

// ── behavioral: the visibility rule at the canonical owner ────────────────────
const FP = 'o=1|w=320|z=90248';
const now = 1_750_000_000_000;
check('ACTIVE rating overrides a fresh saved rate (operator sees the re-rate)',
  resolveRateJobWorkflowOverride({
    jobState: 'rating', jobFingerprint: FP, currentFingerprint: FP,
    hasFreshRate: true, jobUpdatedAtMs: now - 2_000, nowMs: now,
  })?.bestRateState === 'rating');
check('QUEUED pending still defers to a fresh saved rate (leftover-stamp protection)',
  resolveRateJobWorkflowOverride({
    jobState: 'pending', jobFingerprint: FP, currentFingerprint: FP,
    hasFreshRate: true, jobUpdatedAtMs: now - 2_000, nowMs: now,
  }) === null);
check('override still carries the age for the FE watchdog',
  resolveRateJobWorkflowOverride({
    jobState: 'rating', jobFingerprint: FP, currentFingerprint: FP,
    hasFreshRate: true, jobUpdatedAtMs: now - 7_500, nowMs: now,
  })?.bestRateStateAgeMs === 7_500);

// ── wiring pins ───────────────────────────────────────────────────────────────
const backfill = readFileSync('src/services/rates-backfill.ts', 'utf8');
check('Recalculate All (maxAgeHours 0) forces the LIVE carrier fan-out',
  /const liveRecalculate = opts\.maxAgeHours === 0/.test(backfill) &&
  /liveRecalculate \? \{ forceRefresh: true \} : undefined/.test(backfill));
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
check('Best Rate cell spins while the row is being re-rated (watchdog-bounded)',
  /isRowRecalculating/.test(ordersView) &&
  /rowRateJobAgeMs == null \|\| rowRateJobAgeMs <= PENDING_RATING_WATCHDOG_MS/.test(ordersView) &&
  (ordersView.match(/\{recalculatingSpinner\}/g)?.length ?? 0) === 2);
check('poll effect refetches rows DURING the job (results land as orders resolve)',
  /Mid-job row refresh/.test(ordersView) &&
  /void refetchOrders\(\)\.finally\(\(\) => \{ refreshInflight = false \}\)/.test(ordersView));

if (failures > 0) {
  console.error(`\nFAIL recalculate-all live guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS recalculate-all live guard');
