// PS-220 -> PS-333: pure customer-rate ladder for HUGRAB/house margin policy.
//
// The backend-finalized rock-bottom cost is the cheapest eligible priced rate in
// the current combined universe. The customer rate is the next cheapest eligible
// priced rate above that rock-bottom cost. Provider name is not authoritative:
// SHIPP, ShipStation, EasyPost, direct carriers, and carrier accounts are rate
// sources/accounts, not automatic house/non-house identities.
import { normalizeProviderKey } from './direct-carrier-scope.js';
import {
  describeShippingService,
  filterEligibleShippingServices,
  type ShippingAutomationRule,
  type ShippingServiceEligibilityContext,
  type ShippingServiceOptionEligibilityContext,
} from './shipping-service-eligibility.js';
import { isPricedRate, rateCostTotal, rateTotal, type CombinableRate } from '../services/rates-combined.js';
import type { ShippingMarginPolicy } from '../services/house-account-opt-in.js';

/** Legacy SHIPP detector retained for older guards/reporting; PS-333 no longer uses it for ladder ranking. */
export function isHouseShippRate(rate: CombinableRate): boolean {
  return normalizeProviderKey((rate as { provider?: unknown }).provider) === 'shipp';
}

/** Legacy internal-rate detector retained for compatibility; do not use as the PS-333 house divider. */
export function isInternalHouseRate(rate: CombinableRate): boolean {
  return isHouseShippRate(rate);
}

export type NextBestNonHouseResult = {
  /** The next eligible priced rate above the rock-bottom cheapest rate. */
  rate: CombinableRate;
  /** Its charge total (rateTotal) - the customer_rate amount. */
  total: number;
  /** How many eligible priced rates were above the rock-bottom rate. */
  competitorCount: number;
};

/**
 * Resolve the next eligible priced customer rate from an in-hand list, or null
 * when the client is not in next-best mode OR there is no eligible rate above
 * the rock-bottom cheapest rate. Margin arithmetic and the >= 0 clamp stay with
 * the caller; this resolver only finds the basis.
 */
export function resolveNextBestNonHouseRate(input: {
  eligibleRates: CombinableRate[];
  context: ShippingServiceEligibilityContext | null;
  shippingOptions?: ShippingServiceOptionEligibilityContext | null;
  automationRules?: ShippingAutomationRule[] | null;
  client?: {
    houseAccountOptIn?: boolean | null;
    shippingMarginPolicy?: Pick<ShippingMarginPolicy, 'mode'> | null;
  } | null;
}): NextBestNonHouseResult | null {
  const marginMode =
    input.client?.shippingMarginPolicy?.mode ??
    (input.client?.houseAccountOptIn ? 'next_best_customer_rate' : 'pass_through');
  if (marginMode !== 'next_best_customer_rate') return null;

  const eligible = filterEligibleShippingServices(
    input.eligibleRates,
    input.context ?? null,
    describeShippingService,
    input.shippingOptions ?? null,
    input.automationRules ?? null,
  );
  const priced = eligible.filter(isPricedRate);
  const rankedByInternalCost = [...priced].sort((a, b) => rateCostTotal(a) - rateCostTotal(b));
  const houseRate = rankedByInternalCost[0] ?? null;
  if (!houseRate) return null;
  const houseCost = rateCostTotal(houseRate);
  if (!Number.isFinite(houseCost) || houseCost <= 0) return null;
  const competitors = priced
    .filter((rate) => rate !== houseRate && rateCostTotal(rate) > houseCost)
    .sort((a, b) => rateTotal(a) - rateTotal(b));
  const customerRate = competitors[0] ?? null;
  return customerRate
    ? { rate: customerRate, total: rateTotal(customerRate), competitorCount: competitors.length }
    : null;
}
