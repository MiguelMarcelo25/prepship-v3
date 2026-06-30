/**
 * PS-177 (Phase 5, part 2) — canonical owner of order-row MONEY display.
 *
 * Before this module the markup MATH lived twice: src/services/rates.ts
 * applyMarkups (browse responses) and web/src/utils/markups.ts
 * applyCarrierMarkup (order-row Best Rate / Margin cells, applied client-side
 * from the FE-fetched markup map). The row display therefore depended on the
 * FE re-deriving money policy — exactly what ARCHITECTURE.md forbids for
 * billing-adjacent display.
 *
 * This module owns, PURE (zero imports — offline guard-importable):
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

export type MarkupRule = { type: 'amount' | 'percent'; value: number };

/**
 * Parse one `markup.<pidOrCarrier>` settings VALUE (JSON string) into a rule.
 * Mirrors the historical rates.ts loadCarrierMarkups normalization exactly:
 * flat→amount, pct→percent, zero/garbage/non-finite → null (no rule).
 */
export function parseMarkupSettingValue(raw: unknown): MarkupRule | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as { type?: unknown; value?: unknown };
    const value = Number(parsed?.value);
    if (!Number.isFinite(value) || value === 0) return null;
    if (parsed.type === 'amount' || parsed.type === 'flat') return { type: 'amount', value };
    if (parsed.type === 'percent' || parsed.type === 'pct') return { type: 'percent', value };
    return null;
  } catch {
    return null;
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Apply a markup rule to a base amount. Identical math to rates.ts
 * applyMarkups and the FE applyCarrierMarkup: percent = base*(1+v/100),
 * amount = base+v; rounded to cents. No rule → the base unchanged.
 */
export function applyMarkupToAmount(amount: number, rule: MarkupRule | null | undefined): number {
  if (!rule || !rule.value) return round2(amount);
  return round2(rule.type === 'percent' ? amount * (1 + rule.value / 100) : amount + rule.value);
}

// PS-798 (slice 2b): apply the CANONICAL per-client+per-account markup ({pct,flat}, additive) — the
// SAME formula markup-resolver.applyCanonicalMarkup uses (parity pinned by the markup-single-source
// guard), inlined here to preserve this module's zero-import purity. A SUPERSET of applyMarkupToAmount
// (percent-only => {pct,flat:0}; flat-only => {pct:0,flat}), so a resolved canonical markup keeps the
// existing per-account display byte-identical while also honoring the per-client default. null => base.
function applyCanonicalRowMarkup(base: number, markup: { pct: number; flat: number } | null | undefined): number {
  if (!markup) return round2(base);
  return round2(base * (1 + markup.pct / 100) + markup.flat);
}

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
  // PS-356: explicit separated money model. Keep base/marked/markup above as compatibility
  // aliases while API/UI callers move to these names: C. Shipping Rate = customerRateAmount,
  // Best/Selected purchase cost = rateCostAmount, Shipping Margin = shippingMarginAmount.
  // houseRateAmount remains only as a deprecated compatibility alias derived from rateCostAmount
  // for legacy payloads.
  customerRateAmount: number | null;
  rateCostAmount: number | null;
  houseRateAmount: number | null;
  shippingMarginAmount: number | null;
  shippingMarginPct: number | null;
  houseApplied: boolean;
  houseBadgeVisible: boolean;
  customerRateSource:
    | 'best_rate_marked_amount'
    | 'selected_rate_marked_amount'
    | 'projected_house_customer_rate'
    | 'realized_house_customer_rate';
  rateCostSource:
    | 'best_rate_internal_cost'
    | 'selected_rate_internal_cost'
    | 'label_final_cost'
    | 'shipp_house_internal_cost';
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
    customerRateAmount: number | null;
    rateCostAmount: number | null;
    houseApplied: boolean;
    customerRateSource: OrderRowMoneyDisplay['customerRateSource'];
    rateCostSource: OrderRowMoneyDisplay['rateCostSource'];
  }): Pick<
    OrderRowMoneyDisplay,
    | 'customerRateAmount'
    | 'rateCostAmount'
    | 'houseRateAmount'
    | 'shippingMarginAmount'
    | 'shippingMarginPct'
    | 'houseApplied'
    | 'houseBadgeVisible'
    | 'customerRateSource'
    | 'rateCostSource'
  > => {
    const customerRateAmount = positive(input.customerRateAmount);
    const rateCostAmount = positive(input.rateCostAmount);
    const shippingMarginAmount =
      customerRateAmount != null && rateCostAmount != null
        ? Math.max(0, round2(customerRateAmount - rateCostAmount))
        : null;
    return {
      customerRateAmount: customerRateAmount != null ? round2(customerRateAmount) : null,
      rateCostAmount: rateCostAmount != null ? round2(rateCostAmount) : null,
      houseRateAmount: input.houseApplied && rateCostAmount != null ? round2(rateCostAmount) : null,
      shippingMarginAmount,
      shippingMarginPct:
        shippingMarginAmount != null && shippingMarginAmount >= 0.005 && customerRateAmount != null && customerRateAmount > 0
          ? Math.round((shippingMarginAmount / customerRateAmount) * 1000) / 10
          : null,
      houseApplied: input.houseApplied,
      houseBadgeVisible: input.houseApplied,
      customerRateSource: input.customerRateSource,
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
    const markupAmount = Math.max(0, round2(houseMarked - base));
    return {
      baseAmount: round2(base),
      markedAmount: round2(houseMarked),
      markupAmount,
      insuranceAddOn,
      marginPercent: markupAmount >= 0.005 && base > 0 ? Math.round((markupAmount / base) * 100) : null,
      source: facts.isAwaiting ? 'best_rate' : 'selected_rate',
      markupSource: 'house_account',
      ...separatedFields({
        customerRateAmount: houseMarked,
        rateCostAmount: base,
        houseApplied: true,
        customerRateSource: facts.isAwaiting ? 'projected_house_customer_rate' : 'realized_house_customer_rate',
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
    const markupAmount = Math.max(0, round2(marked - base));
    return {
      baseAmount: round2(base),
      markedAmount: marked,
      markupAmount,
      insuranceAddOn,
      marginPercent: markupAmount >= 0.005 && base > 0 ? Math.round((markupAmount / base) * 100) : null,
      source: 'best_rate',
      markupSource: 'carrier_markup',
      ...separatedFields({
        customerRateAmount: marked,
        rateCostAmount: base,
        houseApplied: false,
        customerRateSource: 'best_rate_marked_amount',
        rateCostSource: 'best_rate_internal_cost',
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
  const markupAmount = base != null ? Math.max(0, round2(marked - base)) : null;
  return {
    baseAmount: base != null ? round2(base) : null,
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
      customerRateAmount: marked,
      rateCostAmount: markupBasis,
      houseApplied: false,
      customerRateSource: 'selected_rate_marked_amount',
      rateCostSource: base != null ? 'selected_rate_internal_cost' : 'label_final_cost',
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
  if (!Number.isFinite(pct)) return round2(0);
  return round2(s * (pct / 100));
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
      ? round2(facts.productSubtotal)
      : null;
  const marketplaceFee = computeMarketplaceFee(subtotal, facts.marketplaceFeeRule);
  if (subtotal == null && marketplaceFee == null) return null;
  const profit =
    subtotal != null && facts.markedAmount != null
      ? round2(subtotal - (marketplaceFee ?? 0) - facts.markedAmount)
      : null;
  return { productSubtotal: subtotal, marketplaceFee, profit };
}
