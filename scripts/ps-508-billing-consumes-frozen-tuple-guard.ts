import {
  decideBillableShippingMoney,
} from '../src/services/customer-shipping-money-billable-decision';
import {
  ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS,
  CUSTOMER_SHIPPING_MONEY_POLICY_VERSION,
  CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_OUTBOUND,
} from '../src/services/customer-shipping-money-snapshot';

/**
 * PS-508 blocker B — Billing consumes the frozen tuple; it does not reprice it.
 *
 * This replaces the ps-437 guard's `assert.match(billing, /resolveCustomerShippingMoney\(\{/)`,
 * which asserted only that a CALL SITE exists. That assertion passes whether Billing reprices
 * everything or nothing, so it protected neither behaviour — the same failure mode that let
 * PS-497 sit dead for five weeks behind a green symbol-presence check.
 *
 * The assertion here is behavioural: the legacy recalculator is passed as a spy, and for any
 * shipment carrying a valid accepted tuple it must NEVER be invoked. Pure — no DB, no env.
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
const v437 = { ...money, customerShippingMoneyPolicyVersion: CUSTOMER_SHIPPING_MONEY_POLICY_VERSION };
const v508 = {
  ...money,
  customerRateSource: 'house_next_best_customer_rate',
  billingDescriptionSuffix: '',
  customerShippingMoneyPolicyVersion: CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_OUTBOUND,
};
const accept = ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS;

/** A recalculator that records every invocation and returns a deliberately different number. */
function spy(amount = 999) {
  let calls = 0;
  return { fn: () => { calls += 1; return amount; }, calls: () => calls };
}

// 1. A valid outbound tuple bills the frozen amount, and the recalculator is never consulted.
{
  const s = spy();
  const d = decideBillableShippingMoney({ selectedRateJson: v508, accept, recompute: s.fn });
  check('valid ps-508-v1 bills the frozen amount', d.source === 'frozen' && d.amount === 12,
    `got source=${d.source} amount=${d.amount}`);
  check('valid ps-508-v1 never invokes the legacy recalculator', s.calls() === 0,
    `recompute called ${s.calls()}x`);
}

// 2. THE CONTRACT (PS-437): markup changed after purchase must not move frozen money.
//    The recalculator here returns what today's markup would produce. It must be ignored.
{
  const s = spy(47.5);
  const d = decideBillableShippingMoney({ selectedRateJson: v508, accept, recompute: s.fn });
  check('a markup change after purchase does NOT move the frozen amount',
    d.source === 'frozen' && d.amount === 12, `got ${d.amount}`);
  check('a markup change after purchase does NOT reprice', s.calls() === 0);
}

// 3. legacy_absent is the ONLY state permitted to recompute.
{
  const s = spy(31);
  const receiptOnly = { carrierCode: 'ups', cost: 10, totalCost: 10, providerLabelId: 'x' };
  const d = decideBillableShippingMoney({ selectedRateJson: receiptOnly, accept, recompute: s.fn });
  check('legacy_absent recomputes', d.source === 'legacy_recompute' && d.amount === 31,
    `got source=${d.source}`);
  check('legacy_absent actually invoked the recalculator', s.calls() === 1);
}

// 4. Malformed / unknown fail CLOSED to review — never a silent recompute.
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

// 5. Staging safety: a valid tuple this consumer does not accept must hold, not reprice.
{
  const s = spy();
  const d = decideBillableShippingMoney({
    selectedRateJson: v508, accept: [CUSTOMER_SHIPPING_MONEY_POLICY_VERSION], recompute: s.fn,
  });
  check('valid-but-unaccepted version -> review, not recompute',
    d.source === 'review' && s.calls() === 0, `got ${d.source} calls=${s.calls()}`);
}

// 6. The other frozen writers stay frozen too (return/replacement isolation unchanged).
{
  const s = spy();
  const d = decideBillableShippingMoney({ selectedRateJson: v437, accept, recompute: s.fn });
  check('valid ps-437-v1 also bills frozen', d.source === 'frozen' && s.calls() === 0);
}

console.log(failures === 0 ? '\nPASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
