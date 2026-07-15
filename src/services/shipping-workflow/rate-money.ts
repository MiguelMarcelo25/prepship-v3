/**
 * PS-177 (Phase 5, part 2) — canonical owner of order-row MONEY display.
 *
 * Before this module the markup MATH lived twice: src/services/rates.ts
 * applyMarkups (browse responses) and a now-deleted frontend helper's
 * applyCarrierMarkup (order-row Best Rate / Margin cells, applied client-side
 * from the FE-fetched markup map). The row display therefore depended on the
 * FE re-deriving money policy — exactly what ARCHITECTURE.md forbids for
 * billing-adjacent display.
 *
 * This module owns the row money display tuple:
 *   - parsing a `markup.<pidOrCarrier>` settings value into a MarkupRule
 *   - the markup application math (percent / flat amount, 2dp rounding)
 *   - the row markup-rule lookup precedence (FE getCarrierMarkup parity:
 *     provider-account id first, carrier code second; awaiting rows look up
 *     by the BEST-RATE identity, shipped rows canonical-first)
 *   - the insurance add-on extraction (FE getBackendInsuranceAddOn parity)
 *   - the assembled OrderRowMoneyDisplay tuple the workflow DTO carries
 *
 * rates.ts delegates its parse + math here (behavior-preserving); the orders
 * route resolves the rule + passes money facts into withOrderRowWorkflow; the
 * FE prefers the DTO tuple and keeps its computation only as a deploy-skew
 * fallback (deleted in Phase 6).
 */

import {
  resolveHugrabShippingRateOverride,
  type HugrabShippingRateOverrideConfig,
} from '../billing-hugrab-shipping-rate-override';
import { roundMoney } from '../../lib/money';
// PS-371: the markup FORMULA lives in exactly one owner (markup-resolver). This module keeps its
// public API (applyMarkupToAmount / the canonical row markup) but delegates the math. The import is
// value-safe: markup-resolver only imports a TYPE from this file, so no runtime cycle exists.
import {
  applyCanonicalMarkup,
  canonicalMarkupAdjustmentKind,
  markupRuleToCanonical,
} from './markup-resolver';

export type RateAdjustmentKind = 'customer_profit_markup' | 'true_cost_uplift';
export type MarkupRule = { type: 'amount' | 'percent'; value: number; adjustmentKind?: RateAdjustmentKind };

function parseRateAdjustmentKind(value: unknown): RateAdjustmentKind | null {
  const text = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!text) return null;
  if (
    text === 'true_cost_uplift' ||
    text === 'true_cost' ||
    text === 'carrier_true_cost' ||
    text === 'carrier_cost_uplift' ||
    text === 'account_true_cost_uplift'
  ) {
    return 'true_cost_uplift';
  }
  if (
    text === 'customer_profit_markup' ||
    text === 'profit_markup' ||
    text === 'customer_markup' ||
    text === 'billable_markup'
  ) {
    return 'customer_profit_markup';
  }
  return null;
}

export function markupRuleAdjustmentKind(rule: MarkupRule | null | undefined): RateAdjustmentKind {
  return rule?.adjustmentKind ?? 'customer_profit_markup';
}

export function isTrueCostUpliftMarkup(rule: MarkupRule | null | undefined): boolean {
  return markupRuleAdjustmentKind(rule) === 'true_cost_uplift';
}

/**
 * Parse one `markup.<pidOrCarrier>` settings VALUE (JSON string) into a rule.
 * Mirrors the historical rates.ts loadCarrierMarkups normalization exactly:
 * flat→amount, pct→percent, zero/garbage/non-finite → null (no rule).
 */
export function parseMarkupSettingValue(raw: unknown): MarkupRule | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      type?: unknown;
      value?: unknown;
      adjustmentKind?: unknown;
      adjustment_kind?: unknown;
      basis?: unknown;
      kind?: unknown;
      purpose?: unknown;
    };
    const value = Number(parsed?.value);
    if (!Number.isFinite(value) || value === 0) return null;
    const adjustmentKind = parseRateAdjustmentKind(
      parsed.adjustmentKind ?? parsed.adjustment_kind ?? parsed.basis ?? parsed.kind ?? parsed.purpose,
    );
    const withKind = <T extends { type: 'amount' | 'percent'; value: number }>(rule: T): MarkupRule =>
      adjustmentKind ? { ...rule, adjustmentKind } : rule;
    if (parsed.type === 'amount' || parsed.type === 'flat') return withKind({ type: 'amount', value });
    if (parsed.type === 'percent' || parsed.type === 'pct') return withKind({ type: 'percent', value });
    return null;
  } catch {
    return null;
  }
}

/**
 * Apply a markup rule to a base amount. Same observable behavior as the historical
 * rates.ts applyMarkups and the FE applyCarrierMarkup: percent = base*(1+v/100),
 * amount = base+v; rounded to cents. No rule → the base unchanged.
 * PS-371: delegates to the single formula owner (markup-resolver) — a percent rule is
 * {pct,flat:0}, an amount rule is {pct:0,flat}, byte-identical (pinned by the guard).
 */
export function applyMarkupToAmount(amount: number, rule: MarkupRule | null | undefined): number {
  return applyCanonicalMarkup(amount, markupRuleToCanonical(rule));
}

// PS-798 (slice 2b) / PS-371: the CANONICAL per-client+per-account markup ({pct,flat}, additive).
// Formerly an inlined copy kept in parity with markup-resolver by guard; now a direct alias of the
// single owner so drift is impossible. A SUPERSET of applyMarkupToAmount (percent-only =>
// {pct,flat:0}; flat-only => {pct:0,flat}). null => base unchanged (2dp).
const applyCanonicalRowMarkup = applyCanonicalMarkup;

export type OrderRowMarkupLookupFacts = {
  isAwaiting: boolean;
  bestRateProviderAccountId: number | null;
  canonicalProviderAccountId: number | null;
  selectedRateProviderAccountId: number | null;
  bestRateCarrierCode: string | null;
  canonicalCarrierCode: string | null;
  selectedRateCarrierCode: string | null;
};

/**
 * Resolve the markup rule for an order ROW. FE parity, owned here:
 *   - getCarrierMarkup precedence: provider-account id key first, carrier
 *     code key second (rules are keyed by the raw `markup.` suffix).
 *   - awaiting rows use the best-rate identity (rate pid ?? canonical pid;
 *     bestRate carrierCode) — FE getBestRateShippingProviderId + renderRateCell.
 *   - shipped rows are canonical-first (canonical pid ?? selected-rate pid;
 *     canonical ?? selected-rate carrierCode) — FE getSelectedRate* helpers.
 */
export function resolveOrderRowMarkupRule(
  facts: OrderRowMarkupLookupFacts,
  rules: ReadonlyMap<string, MarkupRule>,
): MarkupRule | null {
  if (!rules.size) return null;
  const pid = facts.isAwaiting
    ? facts.bestRateProviderAccountId ?? facts.canonicalProviderAccountId
    : facts.canonicalProviderAccountId ?? facts.selectedRateProviderAccountId;
  const carrierCode = facts.isAwaiting
    ? facts.bestRateCarrierCode
    : facts.canonicalCarrierCode ?? facts.selectedRateCarrierCode;
  if (pid != null) {
    const byPid = rules.get(String(pid));
    if (byPid) return byPid;
  }
  if (carrierCode) {
    const byCode = rules.get(carrierCode);
    if (byCode) return byCode;
  }
  return null;
}

/**
 * Extract the backend insurance add-on from a saved rate record. FE
 * getBackendInsuranceAddOn parity: a positive numeric `insuranceCost`, or a
 * positive nested `{ insuranceCost: { amount } }`; anything else → null.
 */
export function extractInsuranceAddOn(rate: unknown): number | null {
  if (!rate || typeof rate !== 'object' || Array.isArray(rate)) return null;
  const record = rate as Record<string, unknown>;
  const direct = record.insuranceCost;
  if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) return direct;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    const nested = (direct as Record<string, unknown>).amount;
    if (typeof nested === 'number' && Number.isFinite(nested) && nested > 0) return nested;
  }
  return null;
}

export type OrderRowMoneyDisplay = {
  /** Carrier base cost shown under the marked amount (null = base unknown). */
  baseAmount: number | null;
  /** Customer-facing amount (base + markup) — what the row renders bold. */
  markedAmount: number | null;
  /** marked − base, clamped at 0 (the FE breakdown clamp). Null when either side is unknown. */
  markupAmount: number | null;
  /** Backend insurance add-on line (PS-170/171), already backend-owned on the rate. */
  insuranceAddOn: number | null;
  /** Margin % for the Margin cell: round(markup/base*100); null below the 0.005 display floor. */
  marginPercent: number | null;
  source: 'best_rate' | 'selected_rate';
  // PS-220: discriminates a normal carrier markup (ORION-style rule) from the SHIPP house-account
  // margin so display + guards never double-apply. 'house_account' => marked is the customer_rate
  // (next-best non-SHIPP), base is the SHIPP drp_cost, and NO carrier markupRule was applied.
  markupSource: 'carrier_markup' | 'house_account';
  rateAdjustmentKind: RateAdjustmentKind;
  // PS-356/PS-367: explicit separated money model. C. Shipping Rate is the customer-billed
  // amount; selectedRateCost is the selected/purchased label cost; shippingMarginAmount is
  // cShippingRateAmount - selectedRateCost.
  cShippingRateAmount: number | null;
  selectedRateCost: number | null;
  shippingMarginAmount: number | null;
  shippingMarginPct: number | null;
  houseApplied: boolean;
  houseBadgeVisible: boolean;
  customerRateSource:
    | 'best_rate_marked_amount'
    | 'selected_rate_marked_amount'
    | 'projected_customer_shipping_rate'
    | 'realized_customer_shipping_rate'
    | 'projected_house_c_shipping_rate'
    | 'realized_house_c_shipping_rate'
    | 'true_cost_uplift'
    | 'hugrab_shipping_rate_override';
  rateCostSource:
    | 'best_rate_internal_cost'
    | 'selected_rate_internal_cost'
    | 'label_final_cost'
    | 'shipp_house_internal_cost'
    | 'carrier_true_cost_uplift';
};

export type OrderRowMoneyFacts = {
  isAwaiting: boolean;
  bestRateBaseAmount: number | null;
  selectedRateBaseAmount: number | null;
  labelFinalCost: number | null;
  markupRule: MarkupRule | null;
  // PS-798 (slice 2b): the CANONICAL markup the orders route resolved (per-account override -> per-
  // client billing_config default) via markup-resolver.resolveCanonicalMarkup — the SAME owner billing
  // consumes, so a per-client markup is identical on the Best Rate column and the invoice. When set it
  // SUPERSEDES the per-account-only markupRule (byte-identical for existing per-account markups; adds
  // the per-client default). Absent => the legacy per-account markupRule path (unchanged).
  markupRuleCanonical?: { pct: number; flat: number } | null;
  insuranceAddOn: number | null;
  // PS-220: presence => this is a SHIPP house order. The captured customer_rate (cheapest eligible
  // non-SHIPP) becomes the bold marked amount; the carrier markupRule is suppressed (margin = spread).
  houseMarkedAmount?: number | null;
  clientName?: string | null;
  hugrabShippingRateOverrideConfig?: HugrabShippingRateOverrideConfig | null;
};

/**
 * Assemble the row money tuple. Awaiting rows price the saved best rate;
 * shipped rows price the selected rate (base ?? final label cost — the FE's
 * baseForMarkup fallback), with baseAmount kept null when only the final cost
 * is known so the breakdown line hides exactly as the FE does today.
 */
export function buildOrderRowMoneyDisplay(facts: OrderRowMoneyFacts): OrderRowMoneyDisplay | null {
  const positive = (value: number | null | undefined): number | null =>
    value != null && Number.isFinite(value) && value > 0 ? value : null;
  const insuranceAddOn = positive(facts.insuranceAddOn);
  const separatedFields = (input: {
    cShippingRateAmount: number | null;
    selectedRateCost: number | null;
    houseApplied: boolean;
    rateAdjustmentKind: RateAdjustmentKind;
    customerRateSource: OrderRowMoneyDisplay['customerRateSource'];
    rateCostSource: OrderRowMoneyDisplay['rateCostSource'];
  }): Pick<
    OrderRowMoneyDisplay,
    | 'cShippingRateAmount'
    | 'selectedRateCost'
    | 'shippingMarginAmount'
    | 'shippingMarginPct'
    | 'houseApplied'
    | 'rateAdjustmentKind'
    | 'houseBadgeVisible'
    | 'customerRateSource'
    | 'rateCostSource'
  > => {
    const rawCShippingRateAmount = positive(input.cShippingRateAmount);
    const selectedRateCost = positive(input.selectedRateCost);
    const overrideDecision =
      rawCShippingRateAmount != null
        ? resolveHugrabShippingRateOverride({
            clientName: facts.clientName,
            customerShippingRate: rawCShippingRateAmount,
            selectedRateCost,
            config: facts.hugrabShippingRateOverrideConfig,
          })
        : null;
    const cShippingRateAmount = overrideDecision
      ? positive(overrideDecision.customerShippingRate)
      : rawCShippingRateAmount;
    const shippingMarginAmount =
      cShippingRateAmount != null && selectedRateCost != null
        ? roundMoney(cShippingRateAmount - selectedRateCost)
        : null;
    return {
      cShippingRateAmount: cShippingRateAmount != null ? roundMoney(cShippingRateAmount) : null,
      selectedRateCost: selectedRateCost != null ? roundMoney(selectedRateCost) : null,
      shippingMarginAmount,
      shippingMarginPct:
        shippingMarginAmount != null &&
        Math.abs(shippingMarginAmount) >= 0.005 &&
        cShippingRateAmount != null &&
        cShippingRateAmount > 0
          ? Math.round((shippingMarginAmount / cShippingRateAmount) * 1000) / 10
          : null,
      houseApplied: input.houseApplied,
      rateAdjustmentKind: input.rateAdjustmentKind,
      houseBadgeVisible: input.houseApplied,
      customerRateSource: overrideDecision?.overrideApplied === true
        ? 'hugrab_shipping_rate_override'
        : input.customerRateSource,
      rateCostSource: input.rateCostSource,
    };
  };
  // PS-220 house order: marked = customer_rate (cheapest eligible non-SHIPP), base = drp_cost (the
  // SHIPP cost), markup = the spread. The carrier markupRule is SUPPRESSED (the margin IS the markup);
  // markupSource='house_account' so display + the guard never double-apply a carrier markup.
  const houseMarked = positive(facts.houseMarkedAmount);
  if (houseMarked != null) {
    const base = facts.isAwaiting
      ? positive(facts.bestRateBaseAmount)
      : (positive(facts.selectedRateBaseAmount) ?? positive(facts.labelFinalCost));
    if (base == null) return null;
    const markupAmount = Math.max(0, roundMoney(houseMarked - base));
    return {
      baseAmount: roundMoney(base),
      markedAmount: roundMoney(houseMarked),
      markupAmount,
      insuranceAddOn,
      marginPercent: markupAmount >= 0.005 && base > 0 ? Math.round((markupAmount / base) * 100) : null,
      source: facts.isAwaiting ? 'best_rate' : 'selected_rate',
      markupSource: 'house_account',
      ...separatedFields({
        cShippingRateAmount: houseMarked,
        selectedRateCost: base,
        houseApplied: true,
        rateAdjustmentKind: 'customer_profit_markup',
        customerRateSource: facts.isAwaiting ? 'projected_house_c_shipping_rate' : 'realized_house_c_shipping_rate',
        rateCostSource: 'shipp_house_internal_cost',
      }),
    };
  }
  if (facts.isAwaiting) {
    const base = positive(facts.bestRateBaseAmount);
    if (base == null) return null;
    // PS-798: prefer the canonical (per-account override -> per-client default) markup when the orders
    // route resolved one; fall back to the legacy per-account markupRule otherwise (byte-identical).
    const marked = facts.markupRuleCanonical !== undefined
      ? applyCanonicalRowMarkup(base, facts.markupRuleCanonical)
      : applyMarkupToAmount(base, facts.markupRule);
    const rateAdjustmentKind = facts.markupRuleCanonical !== undefined
      ? canonicalMarkupAdjustmentKind(facts.markupRuleCanonical)
      : markupRuleAdjustmentKind(facts.markupRule);
    const selectedRateCost = rateAdjustmentKind === 'true_cost_uplift' ? marked : base;
    const markupAmount = Math.max(0, roundMoney(marked - base));
    return {
      baseAmount: roundMoney(base),
      markedAmount: marked,
      markupAmount,
      insuranceAddOn,
      marginPercent: markupAmount >= 0.005 && base > 0 ? Math.round((markupAmount / base) * 100) : null,
      source: 'best_rate',
      markupSource: 'carrier_markup',
      ...separatedFields({
        cShippingRateAmount: marked,
        selectedRateCost,
        houseApplied: false,
        rateAdjustmentKind,
        customerRateSource: rateAdjustmentKind === 'true_cost_uplift' ? 'true_cost_uplift' : 'best_rate_marked_amount',
        rateCostSource: rateAdjustmentKind === 'true_cost_uplift' ? 'carrier_true_cost_uplift' : 'best_rate_internal_cost',
      }),
    };
  }
  const base = positive(facts.selectedRateBaseAmount);
  const markupBasis = base ?? positive(facts.labelFinalCost);
  if (markupBasis == null) return null;
  // PS-798: prefer the canonical markup (see the awaiting branch) — byte-identical fallback otherwise.
  const marked = facts.markupRuleCanonical !== undefined
    ? applyCanonicalRowMarkup(markupBasis, facts.markupRuleCanonical)
    : applyMarkupToAmount(markupBasis, facts.markupRule);
  const rateAdjustmentKind = facts.markupRuleCanonical !== undefined
    ? canonicalMarkupAdjustmentKind(facts.markupRuleCanonical)
    : markupRuleAdjustmentKind(facts.markupRule);
  const selectedRateCost = rateAdjustmentKind === 'true_cost_uplift' ? marked : markupBasis;
  const markupAmount = base != null ? Math.max(0, roundMoney(marked - base)) : null;
  return {
    baseAmount: base != null ? roundMoney(base) : null,
    markedAmount: marked,
    markupAmount,
    insuranceAddOn,
    marginPercent:
      markupAmount != null && markupAmount >= 0.005 && base != null && base > 0
        ? Math.round((markupAmount / base) * 100)
        : null,
    source: 'selected_rate',
    markupSource: 'carrier_markup',
    ...separatedFields({
      cShippingRateAmount: marked,
      selectedRateCost,
      houseApplied: false,
      rateAdjustmentKind,
      customerRateSource: rateAdjustmentKind === 'true_cost_uplift' ? 'true_cost_uplift' : 'selected_rate_marked_amount',
      rateCostSource:
        rateAdjustmentKind === 'true_cost_uplift'
          ? 'carrier_true_cost_uplift'
          : base != null ? 'selected_rate_internal_cost' : 'label_final_cost',
    }),
  };
}

// ── PS-239: Marketplace fee + Profit ──────────────────────────────────────────
// Pure, zero-import (offline guard-importable), parallel to the markup math above.
// A marketplace fee is a configurable commission on the order's PRODUCT subtotal
// (price before tax + shipping). Two rule kinds:
//   - flat:   subtotal * percent
//   - tiered: subtotal >= threshold ? atOrAbovePercent : belowPercent, applied to
//             the WHOLE subtotal (flat-tier, not marginal/bracketed).

export type MarketplaceFeeRule =
  | { kind: 'flat'; percent: number }
  | { kind: 'tiered'; threshold: number; belowPercent: number; atOrAbovePercent: number };

/**
 * The fee amount for a subtotal under a rule. No rule → null (the cell renders —).
 * A rule with a zero/negative subtotal → 0 (a real, known fee of $0).
 */
export function computeMarketplaceFee(
  subtotal: number | null | undefined,
  rule: MarketplaceFeeRule | null | undefined,
): number | null {
  if (!rule) return null;
  const s = typeof subtotal === 'number' && Number.isFinite(subtotal) && subtotal > 0 ? subtotal : 0;
  const pct =
    rule.kind === 'flat'
      ? rule.percent
      : s >= rule.threshold
        ? rule.atOrAbovePercent
        : rule.belowPercent;
  if (!Number.isFinite(pct)) return roundMoney(0);
  return roundMoney(s * (pct / 100));
}

export type OrderRowMarketplaceDisplay = {
  /** Σ non-adjustment unitPrice×qty (pre-tax, pre-shipping). Null when unknown. */
  productSubtotal: number | null;
  /** Configured commission on the subtotal. Null = no matching rule (renders —). */
  marketplaceFee: number | null;
  /** subtotal − marketplaceFee − best-rate-incl-markup. Null until a rate exists. */
  profit: number | null;
};

/**
 * Assemble the marketplace economics tuple, INDEPENDENT of the rate so the fee can
 * show before an order is rated (profit stays null until a marked rate exists).
 * Returns null only when there's neither a subtotal nor a fee to display.
 */
export function buildOrderRowMarketplace(facts: {
  productSubtotal: number | null;
  marketplaceFeeRule: MarketplaceFeeRule | null;
  markedAmount: number | null;
}): OrderRowMarketplaceDisplay | null {
  const subtotal =
    typeof facts.productSubtotal === 'number' &&
    Number.isFinite(facts.productSubtotal) &&
    facts.productSubtotal > 0
      ? roundMoney(facts.productSubtotal)
      : null;
  const marketplaceFee = computeMarketplaceFee(subtotal, facts.marketplaceFeeRule);
  if (subtotal == null && marketplaceFee == null) return null;
  const profit =
    subtotal != null && facts.markedAmount != null
      ? roundMoney(subtotal - (marketplaceFee ?? 0) - facts.markedAmount)
      : null;
  return { productSubtotal: subtotal, marketplaceFee, profit };
}
