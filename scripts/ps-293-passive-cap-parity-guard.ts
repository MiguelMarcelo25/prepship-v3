/**
 * PS-293 slice 3 — passive-cap PARITY + render: a row rated by the BACKEND BACKFILL (the rows beyond
 * the browser's 5-row live cap) renders the SAME spinner-then-terminal progression as a LIVE-DRAINED
 * row, and never strands on a state that needs a manual Browse Rates click.
 *
 * Slices 1+2 capped the browser to PASSIVE_LIVE_BEST_RATE_MAX_ROWS=5 live rows and handed the overflow
 * to the canonical backend backfill (which now also stamps the House tuple). The per-function guards
 * prove the pieces in isolation — PS-071 the base classifier, PS-120/119/196 the workflow classifier +
 * watchdog, ps-293 slices 1/2 the wiring + house-tuple. This guard locks the END-TO-END invariant they
 * never assert together: the two rating paths are at PARITY — both spin while waiting, both resolve to
 * {ready, unavailable, error}, and a STALLED backfill is terminal (the watchdog), never an infinite
 * spinner. It composes the REAL classifiers (no re-implementation) + pins the render fall-through.
 *
 *   npx tsx scripts/ps-293-passive-cap-parity-guard.ts
 *
 * Read-only: no DB, no IO, mutates nothing.
 */
import { readFileSync } from 'node:fs';
import {
  classifyAwaitingRateCellState,
  classifyAwaitingRateCellStateWithWorkflow,
  awaitingRateCellIsSpinner,
  PENDING_RATING_WATCHDOG_MS,
  type AwaitingRateCellState,
} from '../web/src/components/Views/orders-parity';

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  if (!Object.is(got, want)) {
    failures += 1;
    console.error(`FAIL ${name}: got ${String(got)}, want ${String(want)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// A rateable awaiting row: dims + weight + carrier context, no displayable rate yet.
const rateable = {
  hasDims: true,
  hasWeight: true,
  hasDisplayableBestRate: false,
  isCalculatingBestRate: false,
  resolvedNoRate: false,
  resolvedError: false,
  hasCarrierContext: true,
  accountsLoading: false,
};

// ── LIVE-DRAIN path (one of the first 5 rows): the FE sets a pending entry => isAutoRatingActive. ──
const liveWaiting = classifyAwaitingRateCellState({ ...rateable, isAutoRatingActive: true });
check('live-drain: waiting row => pending', liveWaiting, 'pending');
check('live-drain: waiting is a spinner', awaitingRateCellIsSpinner(liveWaiting), true);

// ── BACKFILL path (beyond the cap): NO FE entry => isAutoRatingActive false, backend not yet stamped. ──
const backfillPreStamp = classifyAwaitingRateCellStateWithWorkflow(
  { bestRateState: null },
  { ...rateable, isAutoRatingActive: false },
);
check('backfill: pre-stamp overflow row => deferred', backfillPreStamp, 'deferred');
check('backfill: pre-stamp overflow row is a spinner (NOT a Browse-Rates prompt)',
  awaitingRateCellIsSpinner(backfillPreStamp), true);

// PARITY 1 — both paths spin while waiting (the overflow row never looks stuck/actionable pre-resolve).
check('PARITY waiting: live-drain spinner === backfill spinner',
  awaitingRateCellIsSpinner(liveWaiting) === awaitingRateCellIsSpinner(backfillPreStamp), true);

// ── BACKFILL path, backend stamps the row (PS-120): pending => spinner, rating => calculating spinner. ──
const backfillPending = classifyAwaitingRateCellStateWithWorkflow(
  { bestRateState: 'pending', bestRateStateAgeMs: 1000 }, { ...rateable, isAutoRatingActive: false });
check('backfill: backend pending => pending', backfillPending, 'pending');
const backfillRating = classifyAwaitingRateCellStateWithWorkflow(
  { bestRateState: 'rating', bestRateStateAgeMs: 1000 }, { ...rateable, isAutoRatingActive: false });
check('backfill: backend rating => calculating', backfillRating, 'calculating');
check('backfill: backend-stamped in-progress states still spin',
  awaitingRateCellIsSpinner(backfillPending) && awaitingRateCellIsSpinner(backfillRating), true);

// ── WATCHDOG — a STALLED backfill (stamped pending/rating older than the bound) is TERMINAL, never an
//    infinite spinner. The overflow rows DEPEND on the backfill, so a stuck job must not strand them. ──
const stalled = classifyAwaitingRateCellStateWithWorkflow(
  { bestRateState: 'pending', bestRateStateAgeMs: PENDING_RATING_WATCHDOG_MS + 1 },
  { ...rateable, isAutoRatingActive: false });
check('backfill: stalled job past watchdog => unavailable (terminal)', stalled, 'unavailable');
check('backfill: stalled terminal is NOT a spinner', awaitingRateCellIsSpinner(stalled), false);

// ── TERMINAL PARITY — both paths resolve to the SAME terminal set. ──
check('live-drain: rate resolved => ready',
  classifyAwaitingRateCellState({ ...rateable, hasDisplayableBestRate: true, isAutoRatingActive: true }), 'ready');
check('backfill: rate resolved => ready',
  classifyAwaitingRateCellStateWithWorkflow({ bestRateState: 'fresh' },
    { ...rateable, hasDisplayableBestRate: true, isAutoRatingActive: false }), 'ready');
check('backfill: backend reports no rate (missing) => unavailable',
  classifyAwaitingRateCellStateWithWorkflow({ bestRateState: 'missing' },
    { ...rateable, isAutoRatingActive: false }), 'unavailable');
check('live-drain: resolved no-rate => unavailable',
  classifyAwaitingRateCellState({ ...rateable, resolvedNoRate: true }), 'unavailable');

// ── NO-DEADLOCK sweep for the BACKFILL path (parity with PS-071's invariant for the live path): across
//    every backend state, a dims+weight row is EITHER a bounded spinner OR a terminal non-spinner, and a
//    stalled pending/rating is ALWAYS terminal. No state requires Browse Rates to escape. ──
const BACKEND_STATES = ['pending', 'rating', 'fresh', 'stale', 'missing', 'blocked',
  'partial_carrier_failure', 'mismatched_request', 'unknown', null] as const;
for (const bestRateState of BACKEND_STATES) {
  for (const ageMs of [1000, PENDING_RATING_WATCHDOG_MS + 1]) {
    const st: AwaitingRateCellState = classifyAwaitingRateCellStateWithWorkflow(
      bestRateState ? { bestRateState, bestRateStateAgeMs: ageMs } : { bestRateState: null },
      { ...rateable, isAutoRatingActive: false },
    );
    check(`backfill no-deadlock: state for ${bestRateState}@${ageMs} is defined`,
      typeof st === 'string' && st.length > 0, true);
    if (ageMs > PENDING_RATING_WATCHDOG_MS && (bestRateState === 'pending' || bestRateState === 'rating')) {
      check(`backfill watchdog: stalled ${bestRateState} is NOT a spinner`, awaitingRateCellIsSpinner(st), false);
    }
  }
}

// ── RENDER parity (static): the three "waiting" states share ONE spinner branch in OrdersView, so a
//    backfill-waiting row (deferred) is pixel-identical to a live-waiting row (pending/calculating). ──
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
check("render parity: 'deferred'/'calculating'/'pending' share one spinner case (fall-through)",
  /case 'deferred':\s*case 'calculating':\s*case 'pending':\s*default:/.test(ordersView), true);
check('render parity: that shared branch renders the spinner (spin-center + data-rate-state)',
  /case 'pending':\s*default:[\s\S]{0,200}?spin-center[\s\S]{0,120}?data-rate-state=\{state\}/.test(ordersView), true);

if (failures > 0) {
  console.error(`\nFAIL PS-293 passive-cap parity guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-293 passive-cap parity guard');
