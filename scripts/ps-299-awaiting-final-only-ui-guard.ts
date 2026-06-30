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
  'backend stable-display verdict can show expired cache',
  savedBestRateCanDisplayForCurrentRequest({
    ...finalDisplayInput,
    cacheExpiresAt: '2026-06-20T14:59:59.000Z',
    backendWorkflowCanDisplayFinalRate: true,
    backendSavedRateDisplay: 'stale',
  }),
  true,
);
check(
  'backend final-display verdict can show a proven rate with missing legacy eligibility metadata',
  savedBestRateCanDisplayForCurrentRequest({
    ...finalDisplayInput,
    eligibilityVersion: null,
    backendWorkflowCanDisplayFinalRate: true,
    backendSavedRateDisplay: 'fresh',
  }),
  true,
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
  cacheExpiresAt: '2026-06-20T14:59:59.000Z',
  backendWorkflowCanDisplayFinalRate: true,
  backendWorkflowCanUseDisplayedRateForPurchase: false,
  backendSavedRateDisplay: 'stale',
});
check('print queue blocks display-only expired saved rate', stalePreflight.queueableAsCurrent, false);
check('print queue display-only expired state asks for fresh rate', stalePreflight.blockedReason, 'expired');

const ratingState = classifyAwaitingRateCellStateWithWorkflow(
  {
    bestRateState: 'rating',
    savedRateDisplay: 'fresh',
    canDisplayFinalRate: true,
    activeRateCheckState: 'rating',
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
check('rating workflow keeps stable amount visible', ratingState, 'ready');

const staleState = classifyAwaitingRateCellStateWithWorkflow(
  {
    bestRateState: 'stale',
    savedRateDisplay: 'stale',
    canDisplayFinalRate: true,
    canUseDisplayedRateForPurchase: false,
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
check('stale workflow keeps cached amount visible', staleState, 'ready');

const emptyRatingState = classifyAwaitingRateCellStateWithWorkflow(
  {
    bestRateState: 'rating',
    savedRateDisplay: 'none',
    canDisplayFinalRate: false,
    activeRateCheckState: 'rating',
    allowedActions: { canUseSavedRate: false, requiresRerate: true, canCreateLabel: false },
  } as any,
  {
    hasDims: true,
    hasWeight: true,
    hasDisplayableBestRate: false,
    isCalculatingBestRate: false,
    resolvedNoRate: false,
    resolvedError: false,
    hasCarrierContext: true,
    accountsLoading: false,
  },
);
check('rating workflow without finalized cache still shows calculating', emptyRatingState, 'calculating');

if (failures > 0) {
  console.error(`\nFAIL PS-299 awaiting final-only UI guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-299 awaiting final-only UI guard');
