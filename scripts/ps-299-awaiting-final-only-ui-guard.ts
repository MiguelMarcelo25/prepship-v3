/**
 * PS-299 guard - Awaiting UI and print queue display only finalized backend rates.
 *
 * Read-only: pure frontend classifiers only. No DOM, no DB, no carrier APIs.
 */
import {
  classifyAwaitingRateCellStateWithWorkflow,
  savedBestRateCanDisplayForCurrentRequest,
} from '../web/src/components/Views/orders-parity';
import { classifyPrintQueuePreflightForSavedRate } from '../web/src/components/Views/print-queue-preflight-saved-rate';

let failures = 0;

function check(name: string, got: unknown, want: unknown) {
  if (!Object.is(got, want)) {
    failures += 1;
    console.error(`FAIL ${name}: got ${String(got)}, want ${String(want)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const finalDisplayInput = {
  clientRequestKey: 'order|current',
  requestKey: 'order|current',
  hasBackendIssuedRateProof: true,
  isComplete: true,
  cacheExpiresAt: '2026-06-20T15:30:00.000Z',
  nowMs: Date.parse('2026-06-20T15:00:00.000Z'),
  eligibilityVersion: 'ground-saver-v2',
  requiredEligibilityVersion: 'ground-saver-v2',
  baseAmount: 7,
};

check(
  'fresh proven backend rate remains displayable',
  savedBestRateCanDisplayForCurrentRequest({
    ...finalDisplayInput,
    backendWorkflowCanUseSavedRate: true,
    backendSavedRateDisplay: 'fresh',
  }),
  true,
);
check(
  'backend stale verdict is not displayable',
  savedBestRateCanDisplayForCurrentRequest({
    ...finalDisplayInput,
    backendSavedRateDisplay: 'stale',
  }),
  false,
);
check(
  'backend saved-unproven verdict is not displayable',
  savedBestRateCanDisplayForCurrentRequest({
    ...finalDisplayInput,
    hasBackendIssuedRateProof: false,
    isComplete: false,
    cacheExpiresAt: null,
    backendSavedRateDisplay: 'saved_unproven',
  }),
  false,
);

const stalePreflight = classifyPrintQueuePreflightForSavedRate({
  shippingProviderId: 123,
  hasSavedBestRate: true,
  hasDimsAndWeight: true,
  ...finalDisplayInput,
  backendSavedRateDisplay: 'stale',
});
check('print queue blocks stale saved rate', stalePreflight.queueableAsCurrent, false);
check('print queue stale state asks for recalculation', stalePreflight.blockedReason, 'recalculate_required');

const ratingState = classifyAwaitingRateCellStateWithWorkflow(
  {
    bestRateState: 'rating',
    savedRateDisplay: 'fresh',
    canDisplayFinalRate: false,
    allowedActions: { canUseSavedRate: false, requiresRerate: true, canCreateLabel: false },
  } as any,
  {
    hasDims: true,
    hasWeight: true,
    hasDisplayableBestRate: true,
    isCalculatingBestRate: true,
    resolvedNoRate: false,
    resolvedError: false,
    hasCarrierContext: true,
    accountsLoading: false,
  },
);
check('rating workflow hides previous amount and shows calculating', ratingState, 'calculating');

const staleState = classifyAwaitingRateCellStateWithWorkflow(
  {
    bestRateState: 'stale',
    savedRateDisplay: 'stale',
    canDisplayFinalRate: false,
    allowedActions: { canUseSavedRate: false, requiresRerate: true, canCreateLabel: false },
  } as any,
  {
    hasDims: true,
    hasWeight: true,
    hasDisplayableBestRate: true,
    isCalculatingBestRate: true,
    resolvedNoRate: false,
    resolvedError: false,
    hasCarrierContext: true,
    accountsLoading: false,
  },
);
check('stale workflow hides previous amount and shows calculating', staleState, 'calculating');

if (failures > 0) {
  console.error(`\nFAIL PS-299 awaiting final-only UI guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-299 awaiting final-only UI guard');
