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
};

export type OrderRowMoneyFacts = {
  isAwaiting: boolean;
  bestRateBaseAmount: number | null;
  selectedRateBaseAmount: number | null;
  labelFinalCost: number | null;
  markupRule: MarkupRule | null;
  insuranceAddOn: number | null;
};

/**
 * Assemble the row money tuple. Awaiting rows price the saved best rate;
 * shipped rows price the selected rate (base ?? final label cost — the FE's
 * baseForMarkup fallback), with baseAmount kept null when only the final cost
 * is known so the breakdown line hides exactly as the FE does today.
 */
export function buildOrderRowMoneyDisplay(facts: OrderRowMoneyFacts): OrderRowMoneyDisplay | null {
  const positive = (value: number | null): number | null =>
    value != null && Number.isFinite(value) && value > 0 ? value : null;
  const insuranceAddOn = positive(facts.insuranceAddOn);
  if (facts.isAwaiting) {
    const base = positive(facts.bestRateBaseAmount);
    if (base == null) return null;
    const marked = applyMarkupToAmount(base, facts.markupRule);
    const markupAmount = Math.max(0, round2(marked - base));
    return {
      baseAmount: round2(base),
      markedAmount: marked,
      markupAmount,
      insuranceAddOn,
      marginPercent: markupAmount >= 0.005 && base > 0 ? Math.round((markupAmount / base) * 100) : null,
      source: 'best_rate',
    };
  }
  const base = positive(facts.selectedRateBaseAmount);
  const markupBasis = base ?? positive(facts.labelFinalCost);
  if (markupBasis == null) return null;
  const marked = applyMarkupToAmount(markupBasis, facts.markupRule);
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
