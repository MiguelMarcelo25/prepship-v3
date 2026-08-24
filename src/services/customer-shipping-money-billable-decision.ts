import {
  classifyCustomerShippingMoney,
  mayUseLegacyRecompute,
  billableUnder,
  type CustomerShippingMoneyClassification,
} from './customer-shipping-money-classification';
import type {
  FrozenCustomerShippingMoney,
  CustomerShippingMoneyPolicyVersion,
} from './customer-shipping-money-snapshot';

/**
 * PS-508 W5 — the single place that decides whether a shipment's customer shipping money is
 * READ from the frozen tuple or RECALCULATED.
 *
 * Placement: the rule already lived in the classifier (`mayUseLegacyRecompute` — only
 * `legacy_absent` may recompute). Billing did not delegate to it; `billing.ts` called
 * `resolveCustomerShippingMoney` unconditionally at invoice-generation time, re-deriving
 * customer money from MUTABLE billing config. That made Billing a second source of truth and
 * broke PS-437's contract: frozen customer money must not move when markup changes later.
 *
 * `resolveCustomerShippingMoney` remains the calculation owner at preview and label commit. It
 * stops being an invoice-time repricing authority for any shipment that already carries a
 * frozen tuple.
 *
 * Fails CLOSED: anything that is neither a valid accepted tuple nor a clean legacy receipt goes
 * to review rather than being silently repriced.
 */

/**
 * Billing consumes exactly two outputs — the amount and the description suffix. Both must come
 * from the SAME source. The suffix is part of the (order_id, line_type, description) key that
 * suppresses duplicate lines, so pairing a frozen amount with a recomputed suffix would drift
 * descriptions at cutover and stop duplicate suppression from matching.
 */
export type BillableShippingMoney = { amount: number; descriptionSuffix: string };

export type BillableShippingMoneyDecision =
  | { source: 'frozen'; value: BillableShippingMoney; frozen: FrozenCustomerShippingMoney }
  | { source: 'legacy_recompute'; value: BillableShippingMoney }
  | { source: 'review'; reason: string };

function reviewReason(c: CustomerShippingMoneyClassification): string {
  switch (c.kind) {
    case 'malformed_known_version':
      return `malformed_${c.policyVersion}: ${c.reason}`;
    case 'unknown_version':
      return `unknown_policy_version:${c.rawVersion}`;
    default:
      // A valid tuple this build does not accept yet — staging safety. Holding is correct;
      // recomputing would surface a number Billing has not been cut over to honour.
      return 'policy_version_not_accepted_by_this_consumer';
  }
}

export function decideBillableShippingMoney(input: {
  /** The shipment's `selected_rate_json`, unparsed. */
  selectedRateJson: unknown;
  accept: readonly CustomerShippingMoneyPolicyVersion[];
  /** The legacy invoice-time calculation. Invoked ONLY for `legacy_absent`. */
  recompute: () => BillableShippingMoney;
}): BillableShippingMoneyDecision {
  const classification = classifyCustomerShippingMoney(input.selectedRateJson);

  const frozen = billableUnder(classification, input.accept);
  if (frozen) {
    // The eighth field is optional on the tuple because production ps-437-v1 rows predate it.
    // A tuple without it can reproduce the AMOUNT but not the LINE. Recomputing just the suffix
    // would let a later markup change move the description while the money stayed frozen, so
    // this fails closed instead.
    if (typeof frozen.billingDescriptionSuffix !== 'string') {
      return { source: 'review', reason: 'frozen_tuple_missing_billing_description_suffix' };
    }
    return {
      source: 'frozen',
      value: { amount: frozen.cShippingRateAmount, descriptionSuffix: frozen.billingDescriptionSuffix },
      frozen,
    };
  }

  if (mayUseLegacyRecompute(classification)) {
    return { source: 'legacy_recompute', value: input.recompute() };
  }

  return { source: 'review', reason: reviewReason(classification) };
}
