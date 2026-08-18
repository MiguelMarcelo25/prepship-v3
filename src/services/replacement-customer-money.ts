import {
  CUSTOMER_SHIPPING_MONEY_POLICY_VERSION,
  readFrozenCustomerShippingMoney,
} from './customer-shipping-money-snapshot.js';

/**
 * PS-502 AC-10 — the customer-money fence for `replace_postage`.
 *
 * ── WHY A FENCE AND NOT A PREDICATE ─────────────────────────────────────────────────────
 *
 * The card asks to "extend the customer-safe predicate so it is protected as `return_postage`
 * already is". There is no such predicate. `return_postage` is protected STRUCTURALLY, by
 * `resolveReturnCustomerShippingAmount` (billing-return-event-contract.ts), whose input type
 * has exactly one field — the configured customer rate. Raw provider cost cannot reach a return
 * charge because there is nowhere to put it, not because a list refuses it. Adding a string to
 * a list would have protected nothing.
 *
 * This is that shape, one vocabulary over.
 *
 * ── WHAT IT WAS BEFORE ──────────────────────────────────────────────────────────────────
 *
 * The planner took `money: { shipmentCost, otherCost }` and billed their sum, while its own
 * docblock said money came from the frozen customer tuple. Those two numbers are the CARRIER's
 * — written verbatim from the provider receipt into `shipments.cost` and `shipments.other_cost`
 * — so `replace_postage` would have charged the client raw postage cost as if it were a
 * customer rate: no markup, no house rate, no reference-rate floor, no policy version. The
 * comment described an intention the type never enforced.
 *
 * ── WHY cShippingRateAmount, NEVER selectedRateCost ─────────────────────────────────────
 *
 * `selectedRateCost` is what the carrier charged us. `cShippingRateAmount` is what the client is
 * charged, after the markup and flooring the money owner applies. Returning the former would
 * reintroduce exactly the defect this exists to close, which is why the two are separated in
 * the frozen tuple in the first place.
 *
 * The tuple is read through `readFrozenCustomerShippingMoney`, which fails closed on anything
 * partial, legacy or out-of-policy — it "never manufactures customer money from selected cost".
 */

/**
 * A customer postage amount that can only have come from a frozen, policy-versioned tuple.
 *
 * Deliberately an OBJECT rather than a number. A `number` parameter accepts `shipments.cost`
 * just as happily as a customer rate, and nothing at the type level could tell them apart —
 * which is how the previous shape passed review. A caller cannot fabricate one of these
 * without going through the fence below.
 */
export type ReplacementCustomerPostage = {
  readonly amount: number;
  readonly policyVersion: typeof CUSTOMER_SHIPPING_MONEY_POLICY_VERSION;
  readonly source: 'frozen_customer_shipping_money';
};

/**
 * The ONLY way to obtain a billable replacement postage amount.
 *
 * Takes the frozen tuple and nothing else. There is no cost parameter, no fallback and no
 * override: a caller holding only `shipments.cost` has no way to express it here, which is the
 * entire protection.
 *
 * Returns null — never a guess and never zero — when the tuple is absent or does not reconcile.
 * The planner turns that into a refusal, because a replacement that cannot be priced correctly
 * must not ship silently unbilled.
 */
export function resolveReplacementCustomerPostage(input: {
  frozenCustomerShippingMoney: unknown;
}): ReplacementCustomerPostage | null {
  const frozen = readFrozenCustomerShippingMoney(input.frozenCustomerShippingMoney);
  if (!frozen) return null;

  // NO equality tripwire, deliberately — and this is a REVERSAL of the first version.
  //
  // It refused any tuple whose customer amount equalled the carrier cost, on the theory that
  // equality is the signature of cost leaking through. It is not. Equality is also what a
  // client configured with zero shipping markup legitimately looks like, and for them the
  // refusal did not merely skip a charge: the planner treats missing customer money as a hard
  // failure, so their replacements could not SHIP at all. A guard against a wrong charge that
  // blocks the warehouse is a worse defect than the one it prevents.
  //
  // What actually distinguishes customer money from carrier cost is PROVENANCE, and
  // readFrozenCustomerShippingMoney has already enforced it above: customerRateSource must be
  // a realized customer rate or a hugrab override, rateCostSource must be `label_final_cost`,
  // the policy version must match, and the margin must reconcile against the two amounts. A
  // number copied out of shipments.cost cannot satisfy any of that, at any markup.

  if (!Number.isFinite(frozen.cShippingRateAmount) || frozen.cShippingRateAmount <= 0) return null;

  return {
    amount: frozen.cShippingRateAmount,
    policyVersion: CUSTOMER_SHIPPING_MONEY_POLICY_VERSION,
    source: 'frozen_customer_shipping_money',
  };
}
