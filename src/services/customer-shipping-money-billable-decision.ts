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
 * This owns the choice so callers cannot re-derive it. `resolveCustomerShippingMoney` remains
 * the calculation owner at preview and label commit; it stops being an invoice-time repricing
 * authority for any shipment that already carries a frozen tuple.
 *
 * Fails CLOSED: anything that is neither a valid accepted tuple nor a clean legacy receipt
 * goes to review rather than being silently repriced.
 */
export type BillableShippingMoneyDecision =
  | { source: 'frozen'; amount: number; frozen: FrozenCustomerShippingMoney }
  | { source: 'legacy_recompute'; amount: number }
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
  recompute: () => number;
}): BillableShippingMoneyDecision {
  const classification = classifyCustomerShippingMoney(input.selectedRateJson);

  const frozen = billableUnder(classification, input.accept);
  if (frozen) {
    return { source: 'frozen', amount: frozen.cShippingRateAmount, frozen };
  }

  if (mayUseLegacyRecompute(classification)) {
    return { source: 'legacy_recompute', amount: input.recompute() };
  }

  return { source: 'review', reason: reviewReason(classification) };
}
