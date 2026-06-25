// PS-317: pure saved-rate display predicates, moved verbatim out of OrdersView. They decide whether
// a saved best rate may be shown for the current request, delegating the verdict to the canonical
// orders-parity contract. Pure on their args — no component state.
import { toStringValue, toRecord, getBestRateWorkflowModel } from '../../orders-row-display';
import { hasBackendIssuedRateProof } from '../../../../lib/rate-proof';
import { savedBestRateCanDisplayForCurrentRequest } from '../../orders-parity';
import { SHIPPING_SERVICE_ELIGIBILITY_VERSION } from '../../../../../../src/lib/shipping-service-eligibility';
import { getSavedBestRateRecord, getRateBaseAmount } from './rate-proof';
import type { StrictBestRateRequest } from './rate-request';
import type { OrderSummaryDto } from '../../../../types/api';

export function hasSavedBestRateForRequest(
  order: OrderSummaryDto,
  request: StrictBestRateRequest,
  options: { requireEligibilityVersion?: boolean } = {},
) {
  const savedRate = getSavedBestRateRecord(order);
  if (!savedRate) return false;
  const workflow = getBestRateWorkflowModel(order);
  const workflowRecord = toRecord(workflow);
  return savedBestRateCanDisplayForCurrentRequest({
    clientRequestKey: toStringValue(savedRate.clientRequestKey),
    requestKey: request.key,
    hasBackendIssuedRateProof: hasBackendIssuedRateProof(savedRate),
    isComplete: savedRate.isComplete === true,
    cacheExpiresAt: toStringValue(savedRate.cacheExpiresAt),
    eligibilityVersion: toStringValue(savedRate.eligibilityVersion),
    requiredEligibilityVersion: SHIPPING_SERVICE_ELIGIBILITY_VERSION,
    requireEligibilityVersion: options.requireEligibilityVersion,
    matchType: toStringValue(savedRate.matchType),
    baseAmount: getRateBaseAmount(savedRate),
    backendWorkflowCanUseSavedRate: toRecord(workflowRecord?.allowedActions)?.canUseSavedRate === true,
    backendWorkflowCanDisplayFinalRate:
      typeof workflowRecord?.canDisplayFinalRate === 'boolean' ? workflowRecord.canDisplayFinalRate : null,
    backendWorkflowCanUseDisplayedRateForPurchase:
      typeof workflowRecord?.canUseDisplayedRateForPurchase === 'boolean'
        ? workflowRecord.canUseDisplayedRateForPurchase
        : null,
    // PS-196: the backend's display-only verdict — legacy saved rates render immediately as
    // saved/stale instead of a spinner. Display only; the purchase paths still require fresh proof.
    backendSavedRateDisplay: toStringValue(workflowRecord?.savedRateDisplay),
  });
}

export function hasAnySavedBestRateForDisplay(order: OrderSummaryDto) {
  const savedRate = getSavedBestRateRecord(order);
  return Boolean(savedRate && getRateBaseAmount(savedRate) > 0);
}

export function hasValidSavedBestRateForRequest(
  order: OrderSummaryDto,
  request: StrictBestRateRequest,
) {
  return hasSavedBestRateForRequest(order, request);
}
