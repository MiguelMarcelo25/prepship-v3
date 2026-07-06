// #798 — the ONE canonical markup authority both the rate-DISPLAY path (rates.ts applyMarkups +
// rate-money row money) and the BILLING path (billing.ts / billing-shipping-line) resolve through, so
// a configured markup produces the IDENTICAL effective amount at quote time and invoice time.
//
// THE BUG it closes: today there are two disconnected markup mechanisms — display reads
// settings `markup.<carrierAccount>` (keyed by carrier ACCOUNT), billing reads billing_config
// shipping_markup_pct/flat (keyed by CLIENT). They never reconcile, so the moment a markup is set it
// would quote at one rate and invoice at another. Both are 0 today, so the divergence is latent.
//
// CANONICAL KEYING (DJ, 2026-06-18): per-CLIENT default + per-ACCOUNT override. A per-carrier-account
// override (settings markup.<account>) WINS; else the per-client billing_config default; else none.
//
// Pure + tiny (own file per repo convention; zero runtime imports so the guard verifies it offline).
// DEFAULT-OFF byte-identical: no config -> null -> apply returns the base unchanged, and the canonical
// {pct,flat} math is a faithful SUPERSET of both current formulas (proven against applyMarkupToAmount
// in the guard), so wiring it in does not change any amount until a markup is actually configured.

import type { MarkupRule, RateAdjustmentKind } from './rate-money';

export type CanonicalMarkup = { pct: number; flat: number; adjustmentKind?: RateAdjustmentKind };

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function finiteOrZero(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// A per-account settings rule is EITHER a percent OR a flat amount ({type,value}); express it in the
// canonical {pct,flat} form. Zero/absent -> null (no override).
export function markupRuleToCanonical(rule: MarkupRule | null | undefined): CanonicalMarkup | null {
  if (!rule || !rule.value) return null;
  const canonical = rule.type === 'percent' ? { pct: rule.value, flat: 0 } : { pct: 0, flat: rule.value };
  return rule.adjustmentKind ? { ...canonical, adjustmentKind: rule.adjustmentKind } : canonical;
}

export function canonicalMarkupAdjustmentKind(markup: CanonicalMarkup | null | undefined): RateAdjustmentKind {
  return markup?.adjustmentKind ?? 'customer_profit_markup';
}

// Resolve the markup for a shipment context. Precedence: per-account override wins, else per-client
// default, else null (nothing configured / nets to zero -> the default-OFF, byte-identical path).
export function resolveCanonicalMarkup(input: {
  carrierAccountMarkup?: MarkupRule | null;
  clientShippingMarkupPct?: number | null;
  clientShippingMarkupFlat?: number | null;
}): CanonicalMarkup | null {
  const override = markupRuleToCanonical(input.carrierAccountMarkup);
  if (override) return override;
  const pct = finiteOrZero(input.clientShippingMarkupPct);
  const flat = finiteOrZero(input.clientShippingMarkupFlat);
  if (pct === 0 && flat === 0) return null;
  return { pct, flat };
}

// PS-371 — THE single base*(1+pct/100)+flat formula, UNROUNDED. Every markup application in the
// repo delegates here (billing-shipping-line, billing-box-policy, rate-money); each call site keeps
// its own rounding/formatting so billed numbers stay byte-identical. No markup -> base unchanged.
export function canonicalMarkupAmount(base: number, markup: CanonicalMarkup | null | undefined): number {
  if (!markup) return base;
  return base * (1 + markup.pct / 100) + markup.flat;
}

// Apply the canonical markup additively: base*(1+pct/100)+flat, 2dp. The SAME formula billing already
// uses, and a superset of the display applyMarkupToAmount (percent-only OR flat-only), so it reproduces
// both current behaviors exactly. No markup -> base unchanged (2dp).
export function applyCanonicalMarkup(base: number, markup: CanonicalMarkup | null | undefined): number {
  return round2(canonicalMarkupAmount(base, markup));
}
