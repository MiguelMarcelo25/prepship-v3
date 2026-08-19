import { readFileSync } from 'node:fs';
import {
  classifyCustomerShippingMoney,
  mayUseLegacyRecompute,
  billableUnder,
} from '../src/services/customer-shipping-money-classification';
import {
  ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS,
  CUSTOMER_SHIPPING_MONEY_POLICY_VERSION,
  CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_OUTBOUND,
} from '../src/services/customer-shipping-money-snapshot';

/**
 * PS-508 step 1 — the five-state classifier.
 *
 * The plan review ruled the cutover unsafe while "no billable tuple" collapsed four different
 * situations into one null. These checks execute the distinction. Pure: no database, no env, so
 * it runs in every lane.
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

check('valid ps-437-v1 classifies as valid_ps437',
  classifyCustomerShippingMoney(v437).kind === 'valid_ps437');
check('valid ps-508-v1 classifies as valid_ps508',
  classifyCustomerShippingMoney(v508).kind === 'valid_ps508');

// The ordinary pre-writer shape: a real provider receipt, no tuple. This is the ONLY state that
// may recompute after cutover, so misclassifying it strands every historical shipment.
const receiptOnly = { carrierCode: 'ups', cost: 10, totalCost: 10, providerLabelId: 'x' };
check('a receipt with no version key is legacy_absent (not malformed)',
  classifyCustomerShippingMoney(receiptOnly).kind === 'legacy_absent');
check('null / non-object selected_rate_json is legacy_absent',
  classifyCustomerShippingMoney(null).kind === 'legacy_absent'
  && classifyCustomerShippingMoney([1, 2]).kind === 'legacy_absent');

// A row WE wrote and got wrong. Recomputing it silently would hide a writer defect behind the
// legacy path, and the one-shot guard keys on key presence so the writer will not repair it.
{
  const c = classifyCustomerShippingMoney({ ...v437, shippingMarginAmount: 5 });
  check('a known version whose margin does not reconcile is malformed_known_version',
    c.kind === 'malformed_known_version', JSON.stringify(c));
  check('and it reports WHY, for the operator report',
    c.kind === 'malformed_known_version' && /margin does not reconcile/.test(c.reason),
    c.kind === 'malformed_known_version' ? c.reason : c.kind);
}
{
  const partial = { ...v437 } as Record<string, unknown>;
  delete partial.cShippingRateAmount;
  const c = classifyCustomerShippingMoney(partial);
  check('a known version missing a money field is malformed, and names the field',
    c.kind === 'malformed_known_version' && /cShippingRateAmount/.test(c.reason),
    JSON.stringify(c));
}

// A FUTURE policy this build cannot read. Never repaired, never overwritten.
{
  const c = classifyCustomerShippingMoney({ ...money, customerShippingMoneyPolicyVersion: 'ps-999-v9' });
  check('an unrecognised version is unknown_version, carrying the raw value',
    c.kind === 'unknown_version' && c.rawVersion === 'ps-999-v9', JSON.stringify(c));
}
check('a non-string version key is unknown_version, never legacy_absent',
  classifyCustomerShippingMoney({ ...money, customerShippingMoneyPolicyVersion: 42 }).kind
    === 'unknown_version');

// THE cutover safety property. If any of the three non-legacy failures could recompute, a
// systematic writer error would bill as though it were an ordinary historical row.
check('ONLY legacy_absent may take the recompute fallback',
  mayUseLegacyRecompute(classifyCustomerShippingMoney(receiptOnly))
  && !mayUseLegacyRecompute(classifyCustomerShippingMoney({ ...v437, shippingMarginAmount: 5 }))
  && !mayUseLegacyRecompute(classifyCustomerShippingMoney({ ...money, customerShippingMoneyPolicyVersion: 'ps-999-v9' }))
  && !mayUseLegacyRecompute(classifyCustomerShippingMoney(v508))
  && !mayUseLegacyRecompute(classifyCustomerShippingMoney(v437)));

// Staging still holds at the classifier layer: a v2 tuple is classified, but not yet billable to
// a consumer that has only opted into v1.
check('STAGING: valid_ps508 is NOT billable to a v1-only consumer',
  billableUnder(classifyCustomerShippingMoney(v508), [CUSTOMER_SHIPPING_MONEY_POLICY_VERSION]) === null);
check('valid_ps508 IS billable to a consumer that accepts it',
  billableUnder(classifyCustomerShippingMoney(v508), ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS)
    ?.cShippingRateAmount === 12);
check('a malformed tuple is never billable, under any accept list',
  billableUnder(classifyCustomerShippingMoney({ ...v437, shippingMarginAmount: 5 }),
    ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS) === null);

// Purity: the audit, the billing precedence path and CI all need this in lanes with no database.
const src = readFileSync('src/services/customer-shipping-money-classification.ts', 'utf8');
check('the classifier never value-imports db/client',
  !/^\s*import\s+(?!type\b)[^;]*['"][^'"]*db\/client/m.test(src)
  && !/from '\.\/customer-shipping-money\.js'/.test(src));

if (failures > 0) {
  console.log(`\nFAIL PS-508 classification guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPS-508 classification guard passed.');
