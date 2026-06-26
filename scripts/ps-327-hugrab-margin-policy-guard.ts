/**
 * PS-327 - generalized HUGRAB-safe shipping margin policy guard.
 *
 * Proves the backend owner can express "next-best customer-rate" margin mode
 * as a policy, not as a SHIPP-only UI/boolean shortcut, and that the selected
 * customer-rate competitor uses the same eligibility + HUGRAB insurance basis
 * as the rest of the rate workflow.
 *
 * Pure/offline: no DB, no providers, no labels, no billing mutation.
 */
import { readFileSync } from 'node:fs';
import { resolveNextBestNonHouseRate } from '../src/lib/next-best-non-house-rate';

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function read(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

const HUGRAB_CONTEXT = { clientId: 4, clientName: 'HUGRAB', storeId: 378060 };
const INSURED_OPTIONS = { insuranceProvider: 'parcelguard', insuredValue: 100 };

const HOUSE_WINNER = {
  provider: 'shipp',
  carrier_code: 'ups',
  carrier_id: 'se-1001',
  service_code: 'ups_ground',
  service_name: 'UPS Ground',
  shipping_amount: { amount: 10.54 },
  other_amount: { amount: 0 },
};

const INSURED_NON_HOUSE_COMPETITOR = {
  provider: 'ups',
  carrier_code: 'ups',
  carrier_id: 'se-2002',
  service_code: 'ups_ground',
  service_name: 'UPS Ground',
  shipping_amount: { amount: 11.21 },
  other_amount: { amount: 0 },
};

const CHEAPER_INSURANCE_INELIGIBLE_COMPETITOR = {
  provider: 'ups',
  carrier_code: 'ups',
  carrier_id: 'se-2003',
  service_code: 'ups_ground_saver',
  service_name: 'UPS Ground Saver',
  shipping_amount: { amount: 9.90 },
  other_amount: { amount: 0 },
};

const passThrough = resolveNextBestNonHouseRate({
  eligibleRates: [HOUSE_WINNER, INSURED_NON_HOUSE_COMPETITOR],
  context: HUGRAB_CONTEXT,
  shippingOptions: INSURED_OPTIONS,
  client: { shippingMarginPolicy: { mode: 'pass_through' } } as never,
});
check('pass-through policy returns null even with eligible competitors', passThrough === null, passThrough);

const nextBest = resolveNextBestNonHouseRate({
  eligibleRates: [
    HOUSE_WINNER,
    CHEAPER_INSURANCE_INELIGIBLE_COMPETITOR,
    INSURED_NON_HOUSE_COMPETITOR,
  ],
  context: HUGRAB_CONTEXT,
  shippingOptions: INSURED_OPTIONS,
  client: { shippingMarginPolicy: { mode: 'next_best_customer_rate' } } as never,
});
check('next-best policy enables customer-rate competitor selection',
  nextBest != null,
  nextBest);
check('HUGRAB insured competitor selection excludes cheaper insurance-ineligible Ground Saver',
  nextBest?.total === 11.21 &&
  nextBest.rate === INSURED_NON_HOUSE_COMPETITOR &&
  nextBest.competitorCount === 1,
  nextBest);

const legacy = resolveNextBestNonHouseRate({
  eligibleRates: [HOUSE_WINNER, INSURED_NON_HOUSE_COMPETITOR],
  context: HUGRAB_CONTEXT,
  shippingOptions: INSURED_OPTIONS,
  client: { houseAccountOptIn: true },
});
check('legacy houseAccountOptIn remains compatible for existing SHIPP clients',
  legacy?.total === 11.21,
  legacy);

const policySrc = read('src/services/house-account-opt-in.ts');
const resolverSrc = read('src/lib/next-best-non-house-rate.ts');
const stampSrc = read('src/services/shipping-workflow/house-tuple-stamp.ts');
const captureSrc = read('src/services/shipping-workflow/house-margin-capture.ts');
const adminSrc = read('src/routes/admin.ts');
const billingRouteSrc = read('src/routes/billing.ts');
const configTableSrc = read('web/src/components/Views/BillingConfigTable.tsx');

check('policy owner exports a backend shippingMarginPolicyForClient accessor',
  /export async function shippingMarginPolicyForClient/.test(policySrc));
check('policy owner keeps a pure shippingMarginPolicyFromRow conversion',
  /export function shippingMarginPolicyFromRow/.test(policySrc) &&
  /next_best_customer_rate/.test(policySrc) &&
  /pass_through/.test(policySrc));
check('resolver consumes shippingMarginPolicy mode instead of only a SHIPP boolean',
  /shippingMarginPolicy/.test(resolverSrc) &&
  /next_best_customer_rate/.test(resolverSrc));
check('stamp owner asks the backend policy owner for policy, not only clientHouseAccountEnabled',
  /shippingMarginPolicyForClient/.test(stampSrc));
check('realized capture planner can receive policy mode for default-off safety',
  /shippingMarginPolicy/.test(captureSrc) &&
  /next_best_customer_rate/.test(captureSrc));
check('admin and billing config payloads expose the policy mode while keeping houseAccountEnabled compatibility',
  /shippingMarginPolicyMode/.test(adminSrc) &&
  /shippingMarginPolicyMode/.test(billingRouteSrc));
check('settings UI labels the toggle as margin policy, not SHIPP-only House Acct',
  /Margin Mode/.test(configTableSrc) &&
  !/label:\s*'House Acct'/.test(configTableSrc));

if (failures > 0) {
  console.error(`\nPS-327 HUGRAB margin policy guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}

console.log('\nPS-327 HUGRAB margin policy guard passed.');
