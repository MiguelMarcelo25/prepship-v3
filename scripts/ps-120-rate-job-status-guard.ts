/**
 * PS-120 guard — the FE classifier contract for the backend-owned per-order rate-job states
 * `pending` (queued for backfill) and `rating` (actively rating). Pure logic, no DB/network.
 *
 * Pins: pending -> queued spinner; rating -> in-progress (calculating); a last-known displayable
 * rate still wins; missing dims/weight still wins as 'add-dims' (PS-119 dims-first); and the WATCHDOG
 * — an in-progress state older than PENDING_RATING_WATCHDOG_MS becomes a terminal retryable state
 * (never an infinite spinner).
 *
 *   npx tsx scripts/ps-120-rate-job-status-guard.ts
 */
import {
  classifyAwaitingRateCellStateWithWorkflow,
  PENDING_RATING_WATCHDOG_MS,
} from '../web/src/components/Views/orders-parity';

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failures += 1;
    console.error(`FAIL ${name}: got ${g}, want ${w}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// Rateable row, no displayable rate yet → the workflow state drives the cell.
const base = {
  hasDims: true,
  hasWeight: true,
  hasDisplayableBestRate: false,
  isCalculatingBestRate: false,
  resolvedNoRate: false,
  hasCarrierContext: true,
  accountsLoading: false,
};
const wf = (bestRateState: string, bestRateStateAgeMs: number | null = null) => ({ bestRateState, bestRateStateAgeMs });

check('pending -> queued spinner', classifyAwaitingRateCellStateWithWorkflow(wf('pending'), base), 'pending');
check('rating -> in-progress (calculating)', classifyAwaitingRateCellStateWithWorkflow(wf('rating'), base), 'calculating');
check('pending + displayable rate -> ready (never hide a usable rate)', classifyAwaitingRateCellStateWithWorkflow(wf('pending'), { ...base, hasDisplayableBestRate: true }), 'ready');
check('rating + displayable rate -> ready', classifyAwaitingRateCellStateWithWorkflow(wf('rating'), { ...base, hasDisplayableBestRate: true }), 'ready');

// PS-119 dims-first still wins for in-progress states.
check('pending + missing dims (no rate) -> add-dims', classifyAwaitingRateCellStateWithWorkflow(wf('pending'), { ...base, hasDims: false }), 'add-dims');
check('rating + missing weight (no rate) -> add-dims', classifyAwaitingRateCellStateWithWorkflow(wf('rating'), { ...base, hasWeight: false }), 'add-dims');

// Watchdog: stale in-progress state -> terminal (never an infinite spinner).
check('pending older than watchdog (no rate) -> unavailable (terminal)', classifyAwaitingRateCellStateWithWorkflow(wf('pending', PENDING_RATING_WATCHDOG_MS + 1), base), 'unavailable');
check('rating older than watchdog (no rate) -> unavailable (terminal)', classifyAwaitingRateCellStateWithWorkflow(wf('rating', PENDING_RATING_WATCHDOG_MS + 1), base), 'unavailable');
check('rating older than watchdog + displayable -> ready (show last-known)', classifyAwaitingRateCellStateWithWorkflow(wf('rating', PENDING_RATING_WATCHDOG_MS + 1), { ...base, hasDisplayableBestRate: true }), 'ready');
check('pending UNDER watchdog -> still pending (bounded, not terminal)', classifyAwaitingRateCellStateWithWorkflow(wf('pending', PENDING_RATING_WATCHDOG_MS - 1), base), 'pending');

// No workflow state at all → falls through to the live classifier (no behavior change).
check('no workflow state -> live classifier (pending here, rateable+no-rate)', classifyAwaitingRateCellStateWithWorkflow(null, base), 'pending');

if (failures > 0) {
  console.error(`\nFAIL PS-120 rate-job status guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-120 rate-job status guard');
