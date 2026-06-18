/**
 * rate-eligibility-stamp.ts — PS-279 backend-ownership pillar.
 *
 * The rate BLOCK/eligibility VERDICT (the FE's old rateBlockedReason →
 * evaluateShippingServiceEligibility) is a money/eligibility decision and must live at the rate
 * source of truth, not be re-derived in the Rate Browser. This pure resolver is the ONE place the
 * order-rate DTO calls to STAMP that verdict onto each rate, so the FE renders {eligibilityBlocked,
 * eligibilityBlockReason} verbatim. It delegates to the canonical evaluateShippingServiceEligibility
 * owner — it adds no new policy, it only adapts the result into the DTO-shaped stamp.
 */
import {
  evaluateShippingServiceEligibility,
  type ShippingServiceDescriptor,
  type ShippingServiceEligibilityContext,
  type ShippingServiceOptionEligibilityContext,
  type ShippingAutomationRule,
} from '../../lib/shipping-service-eligibility.js';

export type RateEligibilityStamp = {
  eligibilityBlocked: boolean;
  eligibilityBlockReason: string | null;
};

/**
 * Resolve the backend-owned eligibility stamp for a single rate. When no eligibility context is
 * supplied (e.g. legacy callers that never pass client/store identity), the rate defaults to
 * UNBLOCKED so older code paths are byte-compatible — the FE's deploy-skew fallback still runs.
 */
export function resolveRateEligibilityStamp(args: {
  context?: ShippingServiceEligibilityContext | null;
  service: ShippingServiceDescriptor | null | undefined;
  shippingOptions?: ShippingServiceOptionEligibilityContext | null;
  automationRules?: ShippingAutomationRule[] | null;
}): RateEligibilityStamp {
  if (args.context == null) {
    return { eligibilityBlocked: false, eligibilityBlockReason: null };
  }
  const eligibility = evaluateShippingServiceEligibility(
    args.context,
    args.service,
    args.shippingOptions ?? null,
    args.automationRules ?? null,
  );
  if (eligibility.allowed) {
    return { eligibilityBlocked: false, eligibilityBlockReason: null };
  }
  return {
    eligibilityBlocked: true,
    eligibilityBlockReason: eligibility.reason ?? 'Shipping service is not eligible',
  };
}
