/**
 * PS-071 Guard — Awaiting-Shipment rate cell never deadlocks on a spinner.
 *
 * Locks the rule that an awaiting order with dims+weight but no displayable best
 * rate resolves to a bounded/terminal state — never an indefinite spinner that
 * only Browse Rates can unstick. Exercises the ACTUAL classifier used by the
 * Carrier / Shipping Account / Best Rate / Ship Margin cells.
 *
 *   npx tsx scripts/ps-071-rate-cell-state-guard.ts
 *
 * Read-only: no DB, no IO, mutates nothing.
 */
import {
  classifyAwaitingRateCellState,
  awaitingRateCellIsSpinner,
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

const base = {
  hasDims: true,
  hasWeight: true,
  hasDisplayableBestRate: false,
  isCalculatingBestRate: false,
  resolvedNoRate: false,
  hasCarrierContext: true,
  accountsLoading: false,
};
const S = (over: Partial<typeof base>): AwaitingRateCellState =>
  classifyAwaitingRateCellState({ ...base, ...over });

// Ready always wins.
check('displayable rate => ready', S({ hasDisplayableBestRate: true, resolvedNoRate: true }), 'ready');

// Not rateable yet.
check('missing dims => add-dims', S({ hasDims: false }), 'add-dims');
check('missing weight => add-dims', S({ hasWeight: false }), 'add-dims');

// THE BUG: rate request finished with no rate must be terminal, not a spinner.
check('resolved no rate => unavailable', S({ resolvedNoRate: true }), 'unavailable');

// Accounts gating must surface, not spin.
check('no carrier ctx + loading => loading-carriers', S({ hasCarrierContext: false, accountsLoading: true }), 'loading-carriers');
check('no carrier ctx + loaded => no-carrier-account', S({ hasCarrierContext: false, accountsLoading: false }), 'no-carrier-account');

// Bounded spinners (a real request is in flight / refreshing).
check('stale saved rate refreshing => calculating', S({ isCalculatingBestRate: true }), 'calculating');
check('queued/in-flight => pending', S({}), 'pending');

// The DoD invariant: the historically-infinite states are NOT spinners now.
check('unavailable is not a spinner', awaitingRateCellIsSpinner('unavailable'), false);
check('no-carrier-account is not a spinner', awaitingRateCellIsSpinner('no-carrier-account'), false);
check('loading-carriers is not a spinner', awaitingRateCellIsSpinner('loading-carriers'), false);
check('add-dims is not a spinner', awaitingRateCellIsSpinner('add-dims'), false);
// Only the genuinely-in-flight states still spin (and they resolve to terminal).
check('pending is a (bounded) spinner', awaitingRateCellIsSpinner('pending'), true);
check('calculating is a (bounded) spinner', awaitingRateCellIsSpinner('calculating'), true);

// Exhaustive sweep: every rateable, no-rate combination yields a non-spinner
// terminal state UNLESS a request is genuinely in flight (carrier ctx present,
// not yet resolved). This proves "no Browse Rates required to escape a spinner".
for (const resolvedNoRate of [true, false]) {
  for (const hasCarrierContext of [true, false]) {
    for (const accountsLoading of [true, false]) {
      for (const isCalculatingBestRate of [true, false]) {
        const state = classifyAwaitingRateCellState({
          hasDims: true,
          hasWeight: true,
          hasDisplayableBestRate: false,
          isCalculatingBestRate,
          resolvedNoRate,
          hasCarrierContext,
          accountsLoading,
        });
        // A spinner is only acceptable when carrier context exists AND the rate
        // hasn't resolved to "no rate" — i.e. a request can still complete.
        if (awaitingRateCellIsSpinner(state)) {
          check(
            `spinner only when resolvable (ctx=${hasCarrierContext}, resolvedNoRate=${resolvedNoRate})`,
            hasCarrierContext && !resolvedNoRate,
            true,
          );
        }
      }
    }
  }
}

if (failures > 0) {
  console.error(`\nFAIL PS-071 rate cell state guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-071 rate cell state guard');
