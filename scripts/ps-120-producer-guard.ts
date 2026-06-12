/**
 * PS-120 — backend per-order rate-job PRODUCER guard.
 *
 * Pins the PURE logic of the backend producer/reader for the in-progress rate states
 * (pending/rating) WITHOUT a DB. Two things are asserted:
 *
 *   1. The status helper: setOrderRatePending/setOrderRateRating/clearOrderRateJob exist and the
 *      shared fingerprint (computeOrderRateJobFingerprint) is stable for identical inputs and
 *      CHANGES when dims/weight/zip change (so a stale dims/weight invalidates the job).
 *
 *   2. The payload override decision (resolveRateJobWorkflowOverride) is ADDITIVE: it returns an
 *      override ONLY on (a) a job row whose state is pending/rating, (b) a fingerprint match, and
 *      (c) no fresh saved rate — and is a NO-OP (null) otherwise. That no-op is the byte-identical
 *      guarantee: when there's no row, the fingerprint mismatches, or a fresh rate exists, the
 *      orders payload is unchanged.
 *
 * Offline / pure: no DB, no network. Imports the pure exports directly.
 */
import {
  computeOrderRateJobFingerprint,
  resolveRateJobWorkflowOverride,
  setOrderRatePending,
  setOrderRateRating,
  clearOrderRateJob,
} from '../src/services/shipping-workflow/order-rate-job-status';
import { PENDING_RATING_WATCHDOG_MS, classifyAwaitingRateCellStateWithWorkflow } from '../web/src/components/Views/orders-parity';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// ── (1) status helper surface + shared fingerprint ──────────────────────────────────────
check('setOrderRatePending is a function', typeof setOrderRatePending === 'function');
check('setOrderRateRating is a function', typeof setOrderRateRating === 'function');
check('clearOrderRateJob is a function', typeof clearOrderRateJob === 'function');

const baseInput = {
  orderId: 555,
  weightOz: 16,
  shipToPostalCode: '11364-2081',
  shipToState: 'NY',
  shipToCity: 'Bayside',
  rateDimsL: 10,
  rateDimsW: 8,
  rateDimsH: 6,
  raw: { shipTo: { country: 'US', residential: true }, dimensions: { length: 99, width: 99, height: 99 } },
};
const fpA = computeOrderRateJobFingerprint(baseInput);
const fpB = computeOrderRateJobFingerprint({ ...baseInput });
check('fingerprint is stable for identical inputs', fpA === fpB, `${fpA} vs ${fpB}`);
check('override dims win over raw dimensions in the fingerprint', fpA.includes('l=100') && fpA.includes('dw=80') && fpA.includes('h=60'),
  fpA);
check('fingerprint changes when weight changes',
  computeOrderRateJobFingerprint({ ...baseInput, weightOz: 32 }) !== fpA);
check('fingerprint changes when dims change',
  computeOrderRateJobFingerprint({ ...baseInput, rateDimsL: 20 }) !== fpA);
check('fingerprint changes when zip changes',
  computeOrderRateJobFingerprint({ ...baseInput, shipToPostalCode: '90210' }) !== fpA);
check('two different orders get different fingerprints',
  computeOrderRateJobFingerprint({ ...baseInput, orderId: 556 }) !== fpA);

const CURRENT = fpA;
const now = 1_000_000_000_000;

// ── (2) override decision is ADDITIVE ───────────────────────────────────────────────────

// 2a. Match + pending + no fresh rate -> override to pending with age.
const pendingOverride = resolveRateJobWorkflowOverride({
  jobState: 'pending', jobFingerprint: CURRENT, currentFingerprint: CURRENT,
  hasFreshRate: false, jobUpdatedAtMs: now - 5_000, nowMs: now,
});
check('pending + fingerprint match + no fresh rate -> override pending',
  pendingOverride?.bestRateState === 'pending' && pendingOverride?.bestRateStateAgeMs === 5_000,
  JSON.stringify(pendingOverride));

// 2b. Match + rating -> override to rating.
const ratingOverride = resolveRateJobWorkflowOverride({
  jobState: 'rating', jobFingerprint: CURRENT, currentFingerprint: CURRENT,
  hasFreshRate: false, jobUpdatedAtMs: now - 1_000, nowMs: now,
});
check('rating + fingerprint match + no fresh rate -> override rating',
  ratingOverride?.bestRateState === 'rating' && ratingOverride?.bestRateStateAgeMs === 1_000);

// 2c. NO-OP: no job row (state null) -> null (byte-identical).
check('no job row -> no override (null)',
  resolveRateJobWorkflowOverride({
    jobState: null, jobFingerprint: null, currentFingerprint: CURRENT,
    hasFreshRate: false, jobUpdatedAtMs: null, nowMs: now,
  }) === null);

// 2d. NO-OP: fingerprint MISMATCH (stale dims/weight) -> null.
check('fingerprint mismatch -> no override (null)',
  resolveRateJobWorkflowOverride({
    jobState: 'pending', jobFingerprint: 'STALE|w=1', currentFingerprint: CURRENT,
    hasFreshRate: false, jobUpdatedAtMs: now - 5_000, nowMs: now,
  }) === null);

// 2e. NO-OP: order already has a FRESH saved rate -> a QUEUED 'pending' stamp never
// shows a spinner over it (leftover stamps from dead jobs must not haunt resolved rows).
check('fresh saved rate -> no override for a matching pending row (null)',
  resolveRateJobWorkflowOverride({
    jobState: 'pending', jobFingerprint: CURRENT, currentFingerprint: CURRENT,
    hasFreshRate: true, jobUpdatedAtMs: now - 5_000, nowMs: now,
  }) === null);

// 2e'. Recalculate All visibility: an ACTIVE 'rating' DOES override a fresh rate —
// the worker is re-rating this order right now, and the operator must see it.
// (Stuck rows are bounded by the FE watchdog via bestRateStateAgeMs.)
check('fresh saved rate + ACTIVE rating -> override rating (visible re-rate)',
  resolveRateJobWorkflowOverride({
    jobState: 'rating', jobFingerprint: CURRENT, currentFingerprint: CURRENT,
    hasFreshRate: true, jobUpdatedAtMs: now - 1_000, nowMs: now,
  })?.bestRateState === 'rating');

// 2f. NO-OP: missing current fingerprint -> null.
check('missing current fingerprint -> no override (null)',
  resolveRateJobWorkflowOverride({
    jobState: 'rating', jobFingerprint: CURRENT, currentFingerprint: null,
    hasFreshRate: false, jobUpdatedAtMs: now - 5_000, nowMs: now,
  }) === null);

// 2g. NO-OP: a terminal/non-in-progress stored state is never resurfaced.
check('non-in-progress stored state -> no override (null)',
  resolveRateJobWorkflowOverride({
    jobState: 'fresh', jobFingerprint: CURRENT, currentFingerprint: CURRENT,
    hasFreshRate: false, jobUpdatedAtMs: now - 5_000, nowMs: now,
  }) === null);

// ── (3) the consumer maps the overridden states + the watchdog bounds them ──────────────
const fallback = {
  hasDims: true, hasWeight: true, hasDisplayableBestRate: false, isCalculatingBestRate: false,
  resolvedNoRate: false, resolvedError: false, hasCarrierContext: true, accountsLoading: false,
};
check('classifier maps pending (fresh age) -> pending spinner',
  classifyAwaitingRateCellStateWithWorkflow(
    { bestRateState: 'pending', bestRateStateAgeMs: 1_000 }, fallback) === 'pending');
check('classifier maps rating (fresh age) -> calculating spinner',
  classifyAwaitingRateCellStateWithWorkflow(
    { bestRateState: 'rating', bestRateStateAgeMs: 1_000 }, fallback) === 'calculating');
check('WATCHDOG: a stuck rating past the bound becomes terminal (not an infinite spinner)',
  classifyAwaitingRateCellStateWithWorkflow(
    { bestRateState: 'rating', bestRateStateAgeMs: PENDING_RATING_WATCHDOG_MS + 1 }, fallback) === 'unavailable');
check('PS-119 dims-first still wins over pending (add-dims)',
  classifyAwaitingRateCellStateWithWorkflow(
    { bestRateState: 'pending', bestRateStateAgeMs: 1_000 },
    { ...fallback, hasDims: false }) === 'add-dims');

if (failures > 0) {
  console.error(`\nFAIL PS-120 producer guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-120 producer guard (status helper + additive override + bounded watchdog)');
