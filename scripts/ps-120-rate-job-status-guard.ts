/**
 * PS-120/PS-299 guard - FE classifier contract for backend-owned per-order
 * rate-job states `pending` (queued) and `rating` (actively rating).
 *
 * PS-299 changed the display rule: while a checker/recalculation is active,
 * the Awaiting Best Rate cell must not keep showing a previous amount as final.
 * It renders pending/calculating until the backend finishes and stamps a fresh
 * final rate. Pure logic only; no DB/network.
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

const base = {
  hasDims: true,
  hasWeight: true,
  hasDisplayableBestRate: false,
  isCalculatingBestRate: false,
  resolvedNoRate: false,
  hasCarrierContext: true,
  accountsLoading: false,
};
const wf = (bestRateState: string, bestRateStateAgeMs: number | null = null) => ({
  bestRateState,
  bestRateStateAgeMs,
  canDisplayFinalRate: bestRateState === 'fresh',
});

check('pending -> queued spinner', classifyAwaitingRateCellStateWithWorkflow(wf('pending'), base), 'pending');
check('rating -> in-progress (calculating)', classifyAwaitingRateCellStateWithWorkflow(wf('rating'), base), 'calculating');
check(
  'pending + displayable previous rate still hides amount',
  classifyAwaitingRateCellStateWithWorkflow(wf('pending'), { ...base, hasDisplayableBestRate: true }),
  'pending',
);
check(
  'rating + displayable previous rate still hides amount',
  classifyAwaitingRateCellStateWithWorkflow(wf('rating'), { ...base, hasDisplayableBestRate: true }),
  'calculating',
);

check('pending + missing dims -> add-dims', classifyAwaitingRateCellStateWithWorkflow(wf('pending'), { ...base, hasDims: false }), 'add-dims');
check('rating + missing weight -> add-dims', classifyAwaitingRateCellStateWithWorkflow(wf('rating'), { ...base, hasWeight: false }), 'add-dims');

check(
  'pending older than watchdog -> unavailable',
  classifyAwaitingRateCellStateWithWorkflow(wf('pending', PENDING_RATING_WATCHDOG_MS + 1), base),
  'unavailable',
);
check(
  'rating older than watchdog -> unavailable',
  classifyAwaitingRateCellStateWithWorkflow(wf('rating', PENDING_RATING_WATCHDOG_MS + 1), base),
  'unavailable',
);
check(
  'rating older than watchdog + previous displayable still terminal',
  classifyAwaitingRateCellStateWithWorkflow(wf('rating', PENDING_RATING_WATCHDOG_MS + 1), {
    ...base,
    hasDisplayableBestRate: true,
  }),
  'unavailable',
);
check(
  'pending under watchdog -> still pending',
  classifyAwaitingRateCellStateWithWorkflow(wf('pending', PENDING_RATING_WATCHDOG_MS - 1), base),
  'pending',
);

check('no workflow state -> live classifier', classifyAwaitingRateCellStateWithWorkflow(null, base), 'pending');

if (failures > 0) {
  console.error(`\nFAIL PS-120 rate-job status guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-120 rate-job status guard');
