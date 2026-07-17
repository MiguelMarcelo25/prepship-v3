import {
  resolveHugrabShippingRateOverride,
  type HugrabShippingRateOverrideConfig,
} from './billing-hugrab-shipping-rate-override';
import { roundMoney } from '../lib/money';
import { canonicalMarkupAmount } from './shipping-workflow/markup-resolver';
import type { RateAdjustmentKind } from './shipping-workflow/rate-money';

// PS-220 — pure decision for a shipment's billed SHIPPING line amount. Extracted from
// billing.ts so the money-committing choice (the worst-case failure is billing the WRONG
// amount) is provable behaviorally, offline, instead of living inline + untested.
//
// Two paths, mutually exclusive:
//   HOUSE (a captured customer_rate is present): bill that customer_rate exactly — the cheapest
//     eligible non-SHIPP rate. NO reference-rate flooring, NO carrier markup. The SHIPP drp_cost
//     (labelCost) is never billed; the spread IS DRP's margin and stays internal.
//   CARRIER (no captured rate): bill the label cost, optionally floored to the cheaper reference
//     rate for non-baseline carriers under reference_rate mode, then the carrier markup (pct + flat).
//
// Pure: numbers/bools in, decision out. The caller (billing.ts) still derives the inputs
// (toNum, SS_BASELINE_CARRIER_CODES.has, the C. Shipping Rate map) and builds the row.

export type ShippingLineBillingInput = {
  /** drp_cost: synced shipment cost (+ otherCost). Always the carrier-path basis. */
  labelCost: number;
  /** captured C. Shipping Rate for an opted-in SHIPP order; null/undefined => carrier path. */
  cShippingRateAmount?: number | null | undefined;
  billingMode: string | null | undefined;
  /** true when the carrier IS an SS baseline carrier (reference-rate flooring then does NOT apply). */
  isBaselineCarrier: boolean;
  refUspsRate: number;
  refUpsRate: number;
  shippingMarkupPct: number;
  shippingMarkupFlat: number;
  shippingMarkupKind?: RateAdjustmentKind | null | undefined;
  hugrabShippingRateOverride?: {
    clientName: string | null | undefined;
    selectedRateCost?: number | null | undefined;
    config?: HugrabShippingRateOverrideConfig | null;
  } | null | undefined;
};

export type ShippingLineBillingResult = {
  /** Canonical cent amount to bill; callers only serialize this value. */
  billedAmount: number;
  source: 'c_shipping_rate' | 'reference_rate' | 'label_cost';
  markupApplied: boolean;
  /** description suffix: '' for house/no-markup; ' (P% + $F.FF)' when a carrier markup applies. */
  descriptionSuffix: string;
  /** True only when the PrepShip HUGRAB account override replaced the normal result. */
  hugrabOverrideApplied?: boolean;
};

function withHugrabShippingRateOverride(
  input: ShippingLineBillingInput,
  result: ShippingLineBillingResult,
): ShippingLineBillingResult {
  const override = input.hugrabShippingRateOverride;
  if (!override) return { ...result, hugrabOverrideApplied: false };
  const decision = resolveHugrabShippingRateOverride({
    clientName: override.clientName,
    customerShippingRate: result.billedAmount,
    selectedRateCost: override.selectedRateCost ?? input.labelCost,
    config: override.config,
  });
  if (decision.customerShippingRate === result.billedAmount) {
    return { ...result, hugrabOverrideApplied: decision.overrideApplied };
  }
  return {
    ...result,
    billedAmount: decision.customerShippingRate,
    hugrabOverrideApplied: decision.overrideApplied,
  };
}

export function decideShippingLineBilling(input: ShippingLineBillingInput): ShippingLineBillingResult {
  const cShippingRateAmount = input.cShippingRateAmount;
  // HOUSE: bill the captured customer_rate; markup + reference-rate suppressed. Floor at the SHIPP
  // drp_cost (labelCost) so a house order can NEVER bill below DRP's own cost — the margin>=0 invariant
  // (enforced by the order_competitive_rate CHECK and the capture clamp) held at the money-commit point.
  // Under the model this is a no-op (SHIPP won => customer_rate >= drp_cost); it only guards a stale/forged
  // customer_rate below cost. labelCost <= 0 (unknown cost) leaves the customer_rate untouched.
  if (cShippingRateAmount != null) {
    const floor = input.labelCost > 0 ? input.labelCost : cShippingRateAmount;
    return withHugrabShippingRateOverride(input, {
      billedAmount: roundMoney(Math.max(cShippingRateAmount, floor)),
      source: 'c_shipping_rate',
      markupApplied: false,
      descriptionSuffix: '',
    });
  }

  let billedCost = input.labelCost;
  let source: ShippingLineBillingResult['source'] = 'label_cost';
  const mode = input.billingMode ?? 'label_cost';
  if ((mode === 'reference_rate' || mode === 'ss_ref_rate') && !input.isBaselineCarrier) {
    const candidates = [input.refUspsRate, input.refUpsRate].filter((value) => value > 0);
    if (candidates.length > 0) {
      billedCost = Math.max(input.labelCost, Math.min(...candidates));
      source = 'reference_rate';
    }
  }

  const pct = input.shippingMarkupPct;
  const flat = input.shippingMarkupFlat;
  const isTrueCostUplift = input.shippingMarkupKind === 'true_cost_uplift';
  // PS-371: markup-resolver owns the formula; roundMoney owns its cent boundary.
  const billedAmount = roundMoney(
    isTrueCostUplift ? billedCost : canonicalMarkupAmount(billedCost, { pct, flat }),
  );
  const markupApplied = !isTrueCostUplift && (pct > 0 || flat > 0);
  return withHugrabShippingRateOverride(input, {
    billedAmount,
    source,
    markupApplied,
    descriptionSuffix: markupApplied ? ` (${pct}% + $${roundMoney(flat).toFixed(2)})` : '',
  });
}
