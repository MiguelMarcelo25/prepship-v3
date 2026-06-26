/**
 * PS-196/PS-299 guard - finalized-only Awaiting Shipment Best Rate display.
 *
 * PS-299 supersedes the old cache-first display behavior. Stale and legacy
 * unproven saved rates are no longer shown as dollar amounts. The backend state
 * still explains why a row needs re-rating, but display and purchase authority
 * both require a current fresh proven rate.
 *
 * Read-only: pure DTO/UI contract checks only. No DB, no carrier APIs, no labels.
 */
import { readFileSync } from 'node:fs';
import { buildBestRateWorkflowDto } from '../src/services/shipping-workflow/best-rate-workflow-dto';
import {
  classifyAwaitingRateCellStateWithWorkflow,
  savedBestRateCanDisplayForCurrentRequest,
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

const LEGACY_SAVED = {
  amount: 8.95,
  serviceCode: 'ups_ground',
  carrierCode: 'ups',
  carrierNickname: 'ROCEL C81F70',
};

{
  const dto = buildBestRateWorkflowDto({ savedBestRate: LEGACY_SAVED, source: 'cache' });
  check('legacy saved rate classifies unknown', dto.bestRateState, 'unknown');
  check('legacy saved rate is NOT displayable as saved_unproven', dto.savedRateDisplay, 'none');
  check('legacy saved rate cannot display as final', dto.canDisplayFinalRate, false);
  check('legacy saved rate is NOT purchase-authorized', dto.allowedActions.canCreateLabel, false);
  check('legacy saved rate cannot be used as the selected rate', dto.allowedActions.canUseSavedRate, false);
  check('legacy saved rate requires re-rate for purchase', dto.allowedActions.requiresRerate, true);
}

{
  const fresh = buildBestRateWorkflowDto({
    currentRequestFingerprint: 'fp-1',
    savedBestRate: {
      ...LEGACY_SAVED,
      requestFingerprint: 'fp-1',
      proofSource: 'backend_rate_response',
      isComplete: true,
      cacheExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
    source: 'cache',
  });
  check('proven current rate stays fresh', fresh.bestRateState, 'fresh');
  check('proven current rate displays as fresh', fresh.savedRateDisplay, 'fresh');
  check('proven current rate can display as final', fresh.canDisplayFinalRate, true);
  check('proven current rate IS purchase-authorized', fresh.allowedActions.canCreateLabel, true);
}

{
  const mismatched = buildBestRateWorkflowDto({
    currentRequestFingerprint: 'fp-NEW',
    savedBestRate: {
      ...LEGACY_SAVED,
      requestFingerprint: 'fp-OLD',
      proofSource: 'backend_rate_response',
      isComplete: true,
      cacheExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
    source: 'cache',
  });
  check('changed fingerprint classifies mismatched_request', mismatched.bestRateState, 'mismatched_request');
  check('changed fingerprint does not display as stale', mismatched.savedRateDisplay, 'none');
  check('changed fingerprint cannot display as final', mismatched.canDisplayFinalRate, false);
  check('changed fingerprint is NOT purchase-authorized', mismatched.allowedActions.canCreateLabel, false);
}

{
  const noIdentity = buildBestRateWorkflowDto({ savedBestRate: { amount: 5.5 }, source: 'cache' });
  check('saved amount without display identity -> none', noIdentity.savedRateDisplay, 'none');
}

const STRICT_LEGACY_INPUT = {
  clientRequestKey: null,
  requestKey: 'req-1',
  hasBackendIssuedRateProof: false,
  isComplete: false,
  cacheExpiresAt: null,
  baseAmount: 8.95,
} as const;

check(
  'WITHOUT backend verdict, the strict contract rejects legacy',
  savedBestRateCanDisplayForCurrentRequest({ ...STRICT_LEGACY_INPUT }),
  false,
);
check(
  'WITH backend saved_unproven verdict, legacy still does NOT display',
  savedBestRateCanDisplayForCurrentRequest({ ...STRICT_LEGACY_INPUT, backendSavedRateDisplay: 'saved_unproven' }),
  false,
);
check(
  'WITH backend stale verdict, proven-stale still does NOT display',
  savedBestRateCanDisplayForCurrentRequest({ ...STRICT_LEGACY_INPUT, backendSavedRateDisplay: 'stale' }),
  false,
);
check(
  'backend none verdict does NOT loosen the strict contract',
  savedBestRateCanDisplayForCurrentRequest({ ...STRICT_LEGACY_INPUT, backendSavedRateDisplay: 'none' }),
  false,
);
check(
  'a zero-amount rate never displays, even with a verdict',
  savedBestRateCanDisplayForCurrentRequest({ ...STRICT_LEGACY_INPUT, baseAmount: 0, backendSavedRateDisplay: 'saved_unproven' }),
  false,
);

const FALLBACK_DISPLAYABLE = {
  hasDims: true,
  hasWeight: true,
  hasDisplayableBestRate: true,
  isCalculatingBestRate: false,
  resolvedNoRate: false,
  hasCarrierContext: true,
  accountsLoading: false,
};
const FALLBACK_BLANK = { ...FALLBACK_DISPLAYABLE, hasDisplayableBestRate: false };

check(
  'unknown without a final displayable rate -> pending',
  classifyAwaitingRateCellStateWithWorkflow(
    { bestRateState: 'unknown', savedRateDisplay: 'none', canDisplayFinalRate: false },
    FALLBACK_BLANK,
  ),
  'pending',
);
check(
  'stale + displayable saved -> calculating',
  classifyAwaitingRateCellStateWithWorkflow(
    { bestRateState: 'stale', savedRateDisplay: 'none', canDisplayFinalRate: false },
    FALLBACK_DISPLAYABLE,
  ),
  'calculating',
);
check(
  'mismatched_request + displayable saved -> calculating',
  classifyAwaitingRateCellStateWithWorkflow(
    { bestRateState: 'mismatched_request', savedRateDisplay: 'none', canDisplayFinalRate: false },
    FALLBACK_DISPLAYABLE,
  ),
  'calculating',
);
check(
  'stale without a displayable rate still refreshes',
  classifyAwaitingRateCellStateWithWorkflow(
    { bestRateState: 'stale', savedRateDisplay: 'none', canDisplayFinalRate: false },
    FALLBACK_BLANK,
  ),
  'calculating',
);
check(
  'missing is still terminal unavailable',
  classifyAwaitingRateCellStateWithWorkflow(
    { bestRateState: 'missing', savedRateDisplay: 'none' },
    FALLBACK_BLANK,
  ),
  'unavailable',
);

const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
// PS-317: the display-order overlay (getOrderWithAutoBestRate, which clears a saved rate that fails
// the same hasSavedBestRateForRequest contract) moved into ./orders/best-rate/rate-helpers.ts. The
// passive-enqueue skip + the backend-verdict FE pass-throughs below stayed as OrdersView call sites.
const rateHelpers = readFileSync('web/src/components/Views/orders/best-rate/rate-helpers.ts', 'utf8');
// The passive enqueue still cache-first SKIPS a row with a valid saved display — EXCEPT a row the
// backend flagged needsDisplayRefresh (forceLive), which is re-quoted LIVE to detect carrier drift.
// Pin the exact `!forceLive &&` carve-out so removing it (re-freezing display-stale rows) is caught,
// and pin that forceLive is the backend verdict (the FE never recomputes the freshness threshold).
check(
  'passive enqueue skips a valid saved display, except a backend-flagged display-refresh (forceLive)',
  /if \(!forceLive && hasValidSavedBestRateForRequest\(order, request\)\) return null/.test(ordersView) &&
    /const forceLive = getBestRateWorkflowModel\(order\)\?\.needsDisplayRefresh === true/.test(ordersView),
  true,
);
check(
  'display order clears saved rates that fail the same contract (rate-helpers.ts)',
  /!hasSavedBestRateForRequest\(order, autoRequest\)/.test(rateHelpers),
  true,
);
check(
  'pending same-request refresh keeps a displayable saved rate visible (rate-helpers.ts)',
  /entry\.rate === null && entry\.pending !== true/.test(rateHelpers) &&
    !/\(entry\.error \|\| entry\.rate === null\)/.test(rateHelpers),
  true,
);
check(
  'the FE passes the backend savedRateDisplay verdict into the contract',
  /backendSavedRateDisplay: toStringValue\(workflowRecord\?\.savedRateDisplay\)/.test(ordersView),
  true,
);
check(
  'the FE passes the backend canDisplayFinalRate verdict into the contract',
  /backendWorkflowCanDisplayFinalRate:[\s\S]{0,160}workflowRecord\?\.canDisplayFinalRate/.test(ordersView),
  true,
);

if (failures > 0) {
  console.error(`\nFAIL PS-196 finalized-only display guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-196 finalized-only display guard');
