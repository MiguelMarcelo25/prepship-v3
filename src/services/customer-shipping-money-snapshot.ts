import { roundMoney } from '../lib/money.js';

export const CUSTOMER_SHIPPING_MONEY_POLICY_VERSION = 'ps-437-v1';

/**
 * PS-508 — the ORDINARY-OUTBOUND version. A SECOND accepted version, deliberately not a new value
 * for the constant above.
 *
 * ── WHY NOT JUST EDIT ps-437-v1 ─────────────────────────────────────────────────────────
 *
 * resolveCustomerShippingMoney stamps the version unconditionally, and the REPLACEMENT freeze
 * flows through it. Bumping the constant in place would therefore silently start writing the new
 * version on every replacement — while the Client Portal still pins the literal 'ps-437-v1' in
 * four independent runtime sites (a TS reader, a SQL gate, an HTTP-boundary validator and an audit
 * script) and does NOT import this constant. Replacement money would vanish from the portal with
 * nothing failing loudly on either side.
 *
 * Two coexisting versions is also what makes the cutover STAGEABLE: outbound tuples are invisible
 * to every consumer until that consumer explicitly opts in (see `accept` below).
 */
export const CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_OUTBOUND = 'ps-508-v1';

export const ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS = [
  CUSTOMER_SHIPPING_MONEY_POLICY_VERSION,
  CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_OUTBOUND,
] as const;

export type CustomerShippingMoneyPolicyVersion =
  typeof ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS[number];

/**
 * PS-508: `house_next_best_customer_rate` is a THIRD provenance, not a flavour of the first.
 *
 * Billing's house path (billing-shipping-line.ts, `source: 'c_shipping_rate'`) bills the captured
 * next-best competitor rate floored at label cost, with reference-rate flooring AND carrier markup
 * fully suppressed. Before this, such a tuple would have been stamped
 * `realized_customer_shipping_rate` — byte-indistinguishable from carrier-markup money that was
 * computed by a completely different formula. Provenance, not amount, is what tells them apart;
 * PS-502 already removed an equality tripwire that tried to do this by value and could not.
 */
export type CustomerShippingRateSource =
  | 'realized_customer_shipping_rate'
  | 'hugrab_shipping_rate_override'
  | 'house_next_best_customer_rate';

export type FrozenCustomerShippingMoney = {
  selectedRateCost: number;
  cShippingRateAmount: number;
  shippingMarginAmount: number;
  shippingMarginPct: number | null;
  customerRateSource: CustomerShippingRateSource;
  rateCostSource: 'label_final_cost';
  customerShippingMoneyPolicyVersion: CustomerShippingMoneyPolicyVersion;
  /**
   * PS-508 — the EIGHTH field, and optional on purpose.
   *
   * Billing consumes exactly two outputs of resolveCustomerShippingMoney: the amount, and this
   * suffix (e.g. " (20% + $1.00)"), which it appends to the line description. Description is part
   * of the unique index that suppresses duplicate billing lines, so a freeze that captured only
   * the seven money fields could reproduce the AMOUNT but not the LINE — descriptions would drift
   * at cutover and duplicate suppression would stop matching.
   *
   * Optional rather than required because every already-frozen ps-437-v1 tuple in production was
   * written without it. Making it required would retroactively invalidate all of them: the reader
   * would return null, and money that is frozen and correct would read as absent.
   */
  billingDescriptionSuffix?: string;
};

function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const CUSTOMER_RATE_SOURCES: ReadonlySet<string> = new Set<CustomerShippingRateSource>([
  'realized_customer_shipping_rate',
  'hugrab_shipping_rate_override',
  'house_next_best_customer_rate',
]);

/**
 * Strict reader for an already-frozen shared money snapshot. Unlike the legacy
 * rate normalizer, this never manufactures customer money from selected cost.
 *
 * ── `accept` IS THE CUTOVER SWITCH ──────────────────────────────────────────────────────
 *
 * It defaults to ps-437-v1 ALONE, which is byte-for-byte today's behaviour: an ordinary-outbound
 * tuple is invisible to every existing consumer until that consumer names the outbound version.
 * That is deliberate. If this reader accepted both versions by default, every consumer would flip
 * the instant the first outbound freeze landed, and the staged rollout would not exist — the
 * migration would be one un-revertable step across billing, the portal and analytics at once.
 *
 * Widening the default is therefore a MONEY-VISIBLE change, not a cleanup.
 */
export function readFrozenCustomerShippingMoney(
  value: unknown,
  options?: { accept?: readonly CustomerShippingMoneyPolicyVersion[] },
): FrozenCustomerShippingMoney | null {
  const accept: readonly CustomerShippingMoneyPolicyVersion[] =
    options?.accept ?? [CUSTOMER_SHIPPING_MONEY_POLICY_VERSION];
  const row = recordOrNull(value);
  if (!row) return null;
  const selectedRateCost = finiteNumber(row.selectedRateCost);
  const cShippingRateAmount = finiteNumber(row.cShippingRateAmount);
  const shippingMarginAmount = finiteNumber(row.shippingMarginAmount);
  const hasShippingMarginPct = Object.prototype.hasOwnProperty.call(row, 'shippingMarginPct');
  const shippingMarginPct = row.shippingMarginPct == null
    ? null
    : finiteNumber(row.shippingMarginPct);
  const customerRateSource = row.customerRateSource;
  const rateCostSource = row.rateCostSource;
  const policyVersion = row.customerShippingMoneyPolicyVersion;
  if (
    selectedRateCost == null || selectedRateCost <= 0 ||
    cShippingRateAmount == null || cShippingRateAmount <= 0 ||
    shippingMarginAmount == null ||
    !hasShippingMarginPct ||
    (row.shippingMarginPct != null && shippingMarginPct == null) ||
    Math.abs(roundMoney(cShippingRateAmount - selectedRateCost) - roundMoney(shippingMarginAmount)) > 0.001 ||
    typeof customerRateSource !== 'string' || !CUSTOMER_RATE_SOURCES.has(customerRateSource) ||
    rateCostSource !== 'label_final_cost' ||
    typeof policyVersion !== 'string' ||
    !accept.includes(policyVersion as CustomerShippingMoneyPolicyVersion)
  ) {
    return null;
  }
  return {
    selectedRateCost: roundMoney(selectedRateCost),
    cShippingRateAmount: roundMoney(cShippingRateAmount),
    shippingMarginAmount: roundMoney(shippingMarginAmount),
    shippingMarginPct,
    customerRateSource: customerRateSource as CustomerShippingRateSource,
    rateCostSource,
    // PS-508: carried through only when the frozen tuple actually has it, so a v1 tuple round-trips
    // to exactly the seven fields it was written with rather than gaining an empty-string eighth
    // that would read as "no markup suffix" when the truth is "this version never recorded one".
    ...(typeof row.billingDescriptionSuffix === 'string'
      ? { billingDescriptionSuffix: row.billingDescriptionSuffix }
      : {}),
    // PS-508: return the version that was READ, never the constant.
    //
    // This line used to hardcode CUSTOMER_SHIPPING_MONEY_POLICY_VERSION. That was invisible while
    // exactly one version was accepted — the guard above had already proven they were equal. The
    // moment a SECOND version becomes acceptable it silently relabels: a ps-508-v1 tuple would be
    // handed back to the caller stamped ps-437-v1, so no consumer could tell which policy produced
    // the number it is about to bill, and the staged rollout above would be undone by its own reader.
    customerShippingMoneyPolicyVersion: policyVersion as CustomerShippingMoneyPolicyVersion,
  };
}
