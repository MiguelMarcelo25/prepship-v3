// PS-220 — the pure "next-best non-house rate" resolver for the SHIPP house-account margin.
//
// When SHIPP (DRP's house carrier) wins an order AND the client is opted in, DRP pays the SHIPP
// rate (drp_cost) but bills the cheapest ELIGIBLE non-SHIPP rate (customer_rate). This module is
// the single, pure decision: from an in-hand rate list, drop SHIPP, keep only client-eligible +
// priced rates, and pick the cheapest on the SAME charge basis the winner was chosen on. No IO,
// no new rate fetch — the caller supplies the list (the merged combinedRates at best-rate save).
//
// CARRIER_CODE TRAP: the Shipp connector rewrites carrier_code to fedex/ups/stamps_com/dhl_express
// (shipp.ts), so SHIPP identity is carried ONLY by `provider === 'shipp'` (stamped by toDirectRate).
// Keying the drop on carrier_code would BOTH fail to drop the house rate AND wrongly drop real
// FedEx/UPS competitors — so we key strictly on the normalized provider.
import { normalizeProviderKey } from './direct-carrier-scope.js';
import {
  describeShippingService,
  filterEligibleShippingServices,
  type ShippingAutomationRule,
  type ShippingServiceEligibilityContext,
  type ShippingServiceOptionEligibilityContext,
} from './shipping-service-eligibility.js';
import { isPricedRate, rateTotal, type CombinableRate } from '../services/rates-combined.js';

/** True only for DRP's house carrier (SHIPP), identified by provider — never carrier_code. */
export function isHouseShippRate(rate: CombinableRate): boolean {
  return normalizeProviderKey((rate as { provider?: unknown }).provider) === 'shipp';
}

export type NextBestNonHouseResult = {
  /** The cheapest eligible, priced, non-SHIPP rate — the basis for customer_rate. */
  rate: CombinableRate;
  /** Its charge total (rateTotal) — the customer_rate amount. */
  total: number;
  /** How many eligible priced non-SHIPP competitors were seen (0 ⇒ this returns null). */
  competitorCount: number;
};

/**
 * Resolve the cheapest eligible non-SHIPP rate from an in-hand list, or null when the client is
 * not opted in OR there is no eligible non-SHIPP competitor (the caller then sets
 * customer_rate = drp_cost, margin 0 — the pass-through case). Margin arithmetic and the >= 0
 * clamp stay with the caller; this resolver only finds the basis.
 */
export function resolveNextBestNonHouseRate(input: {
  eligibleRates: CombinableRate[];
  context: ShippingServiceEligibilityContext | null;
  shippingOptions?: ShippingServiceOptionEligibilityContext | null;
  automationRules?: ShippingAutomationRule[] | null;
  client: { houseAccountOptIn?: boolean | null };
}): NextBestNonHouseResult | null {
  if (!input.client?.houseAccountOptIn) return null;
  // Same eligibility verdict the browse/selection path uses — no new policy.
  const eligible = filterEligibleShippingServices(
    input.eligibleRates,
    input.context ?? null,
    describeShippingService,
    input.shippingOptions ?? null,
    input.automationRules ?? null,
  );
  // Drop the house carrier (by provider) and any unpriced rate (same basis as the winner pick).
  const competitors = eligible.filter((rate) => !isHouseShippRate(rate) && isPricedRate(rate));
  const cheapest = [...competitors].sort((a, b) => rateTotal(a) - rateTotal(b))[0] ?? null;
  return cheapest
    ? { rate: cheapest, total: rateTotal(cheapest), competitorCount: competitors.length }
    : null;
}
