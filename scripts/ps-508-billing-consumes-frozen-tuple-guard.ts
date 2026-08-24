import {
  decideBillableShippingMoney,
  type BillableShippingMoney,
} from '../src/services/customer-shipping-money-billable-decision';
import {
  ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS,
  CUSTOMER_SHIPPING_MONEY_POLICY_VERSION,
  CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_OUTBOUND,
} from '../src/services/customer-shipping-money-snapshot';

/**
 * PS-508 blocker B + W5 — Billing consumes the frozen tuple; it does not reprice it.
 *
 * This replaces the ps-437 guard's `assert.match(billing, /resolveCustomerShippingMoney\(\{/)`,
 * which asserted only that a CALL SITE exists. That assertion passes whether Billing reprices
 * everything or nothing, so it protected neither behaviour — the same failure mode that let
 * PS-497 sit dead for five weeks behind a green symbol-presence check.
 *
 * The assertion here is behavioural: the legacy recalculator is a spy, and for any shipment
 * carrying a valid accepted tuple it must NEVER be invoked. Pure — no DB, no env.
 */

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { console.log(`ok   ${name}`); return; }
  failures += 1;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

const money = {
  selectedRateCost: 10,
  cShippingRateAmount: 12,
  shippingMarginAmount: 2,
  shippingMarginPct: 16.7,
  rateCostSource: 'label_final_cost',
  customerRateSource: 'realized_customer_shipping_rate',
};
const v437NoSuffix = { ...money, customerShippingMoneyPolicyVersion: CUSTOMER_SHIPPING_MONEY_POLICY_VERSION };
const v437 = { ...v437NoSuffix, billingDescriptionSuffix: ' (10%)' };
const v508 = {
  ...money,
  customerRateSource: 'house_next_best_customer_rate',
  billingDescriptionSuffix: ' (20% + $1.00)',
  customerShippingMoneyPolicyVersion: CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_OUTBOUND,
};
const accept = ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS;

/** A recalculator that records invocations and returns deliberately different values. */
function spy(v: BillableShippingMoney = { amount: 999, descriptionSuffix: ' (LEGACY)' }) {
  let calls = 0;
  return { fn: () => { calls += 1; return v; }, calls: () => calls };
}

// 1. A valid outbound tuple bills the frozen amount AND the frozen suffix, un-consulted.
{
  const s = spy();
  const d = decideBillableShippingMoney({ selectedRateJson: v508, accept, recompute: s.fn });
  check('valid ps-508-v1 bills the frozen amount',
    d.source === 'frozen' && d.value.amount === 12, `got ${d.source}`);
  check('valid ps-508-v1 bills the frozen SUFFIX, not a recomputed one',
    d.source === 'frozen' && d.value.descriptionSuffix === ' (20% + $1.00)');
  check('valid ps-508-v1 never invokes the legacy recalculator', s.calls() === 0,
    `recompute called ${s.calls()}x`);
}

// 2. THE CONTRACT (PS-437): markup changed after purchase must not move frozen money.
{
  const s = spy({ amount: 47.5, descriptionSuffix: ' (99%)' });
  const d = decideBillableShippingMoney({ selectedRateJson: v508, accept, recompute: s.fn });
  check('a markup change after purchase does NOT move the frozen amount',
    d.source === 'frozen' && d.value.amount === 12, `got ${d.source === 'frozen' ? d.value.amount : d.source}`);
  check('a markup change after purchase does NOT move the DESCRIPTION either',
    d.source === 'frozen' && d.value.descriptionSuffix === ' (20% + $1.00)');
  check('a markup change after purchase does NOT reprice', s.calls() === 0);
}

// 3. legacy_absent is the ONLY state permitted to recompute.
{
  const s = spy({ amount: 31, descriptionSuffix: ' (10%)' });
  const receiptOnly = { carrierCode: 'ups', cost: 10, totalCost: 10, providerLabelId: 'x' };
  const d = decideBillableShippingMoney({ selectedRateJson: receiptOnly, accept, recompute: s.fn });
  check('legacy_absent recomputes',
    d.source === 'legacy_recompute' && d.value.amount === 31, `got ${d.source}`);
  check('legacy_absent actually invoked the recalculator', s.calls() === 1);
}

// 4. A frozen tuple WITHOUT the eighth field cannot rebuild the line. Fail closed — never pair a
//    frozen amount with a recomputed suffix, or descriptions drift and duplicate suppression
//    (order_id, line_type, description) stops matching.
{
  const s = spy();
  const d = decideBillableShippingMoney({ selectedRateJson: v437NoSuffix, accept, recompute: s.fn });
  check('frozen tuple missing billingDescriptionSuffix -> review', d.source === 'review', `got ${d.source}`);
  check('missing-suffix tuple never recomputes', s.calls() === 0);
}
{
  const s = spy();
  const d = decideBillableShippingMoney({ selectedRateJson: v437, accept, recompute: s.fn });
  check('ps-437-v1 WITH a suffix bills frozen',
    d.source === 'frozen' && d.value.descriptionSuffix === ' (10%)' && s.calls() === 0);
}

// 5. Malformed / unknown fail CLOSED to review — never a silent recompute.
{
  const s = spy();
  const malformed = { ...v508, cShippingRateAmount: 'not-a-number' };
  const d = decideBillableShippingMoney({ selectedRateJson: malformed, accept, recompute: s.fn });
  check('malformed known version -> review', d.source === 'review', `got ${d.source}`);
  check('malformed never recomputes', s.calls() === 0);
}
{
  const s = spy();
  const unknown = { ...money, customerShippingMoneyPolicyVersion: 'ps-999-v9' };
  const d = decideBillableShippingMoney({ selectedRateJson: unknown, accept, recompute: s.fn });
  check('unknown version -> review', d.source === 'review', `got ${d.source}`);
  check('unknown version never recomputes', s.calls() === 0);
}

// 6. Staging safety: a valid tuple this consumer does not accept must hold, not reprice.
{
  const s = spy();
  const d = decideBillableShippingMoney({
    selectedRateJson: v508, accept: [CUSTOMER_SHIPPING_MONEY_POLICY_VERSION], recompute: s.fn,
  });
  check('valid-but-unaccepted version -> review, not recompute',
    d.source === 'review' && s.calls() === 0, `got ${d.source} calls=${s.calls()}`);
}

console.log(failures === 0 ? '\nPASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
