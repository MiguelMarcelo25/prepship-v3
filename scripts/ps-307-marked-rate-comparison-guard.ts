/**
 * PS-307/PS-356 guard - backend preserves customer charge while Best Rate ranks by marked/customer charge.
 *
 * Offline only: no DB, no network, no providers, no labels, no postage, no
 * marketplace notifications, no queue mutation, and no shipped/cancelled data.
 */
import { readFileSync } from 'node:fs';
import { resolveNextBestNonHouseRate } from '../src/lib/next-best-non-house-rate';
import {
  combineCarrierUniverses,
  dedupeBrowseRates,
  rateCostTotal,
  rateTotal,
  type CombinableRate,
} from '../src/services/rates-combined';

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

const houseRawCheapButCustomerExpensive: CombinableRate = {
  carrier_id: 'se-900001',
  carrier_code: 'ups',
  provider: 'shipp',
  service_code: 'shipp_ups_ground',
  service_type: 'Shipp UPS Ground',
  shipping_amount: { amount: 8.5 },
  customerShippingAmount: 14.5,
  other_amount: { amount: 0 },
};

const nonHouseCustomerCheaper: CombinableRate = {
  carrier_id: 'se-900002',
  carrier_code: 'ups',
  provider: 'ups',
  service_code: 'ups_ground',
  service_type: 'UPS Ground',
  shipping_amount: { amount: 12.0 },
  other_amount: { amount: 0 },
};

check(
  'rateTotal prefers explicit customer shipping charge over raw/internal shipping_amount',
  rateTotal(houseRawCheapButCustomerExpensive) === 14.5,
  { total: rateTotal(houseRawCheapButCustomerExpensive), rate: houseRawCheapButCustomerExpensive },
);

const combined = combineCarrierUniverses({
  ssRates: [nonHouseCustomerCheaper],
  ssCacheKey: 'ps-307',
  ssCached: false,
  ssDiagnostics: [{ carrierId: 'se-900002', status: 'ok', rateCount: 1 }],
  directRates: [houseRawCheapButCustomerExpensive],
  directDiagnostics: [{ carrierId: 'se-900001', status: 'ok', rateCount: 1 }],
  requestedCarrierIds: null,
  accountNamesByCarrierId: new Map([
    ['se-900001', 'SHIPP'],
    ['se-900002', 'UPS'],
  ]),
  accountCarrierIds: ['se-900001', 'se-900002'],
  isCachedOnlyLookup: false,
});

check(
  'combined best-rate owner ranks by marked/customer charge while preserving internal cost',
  combined.cheapest?.service_code === 'ups_ground' &&
    combined.secondCheapest?.service_code === 'shipp_ups_ground' &&
    rateCostTotal(combined.cheapest) === 12 &&
    rateTotal(combined.cheapest) === 12 &&
    rateCostTotal(combined.secondCheapest) === 8.5 &&
    rateTotal(combined.secondCheapest) === 14.5,
  {
    cheapest: combined.cheapest,
    secondCheapest: combined.secondCheapest,
    ranked: combined.rankedEligibleRates.map((rate) => ({
      service: rate.service_code,
      total: rateTotal(rate),
      purchaseCost: rateCostTotal(rate),
      customerShippingAmount: rate.customerShippingAmount,
    })),
  },
);

const houseCustomerRateBasis = resolveNextBestNonHouseRate({
  eligibleRates: [houseRawCheapButCustomerExpensive, nonHouseCustomerCheaper],
  context: { clientId: 1, storeId: 1 },
  client: { houseAccountOptIn: true },
});

check(
  'SHIPP house customer_rate competitor uses the same customer-charge basis',
  houseCustomerRateBasis?.rate.service_code === 'ups_ground' && houseCustomerRateBasis.total === 12,
  houseCustomerRateBasis,
);

const distinctCustomerCharges = dedupeBrowseRates([
  {
    carrier_id: 'se-900003',
    service_code: 'ups_ground',
    shipping_amount: { amount: 8 },
    customerShippingAmount: 11,
    other_amount: { amount: 0 },
  },
  {
    carrier_id: 'se-900003',
    service_code: 'ups_ground',
    shipping_amount: { amount: 8 },
    customerShippingAmount: 12,
    other_amount: { amount: 0 },
  },
]);

check(
  'browse-rate dedupe keeps rates distinct when customer charge differs',
  distinctCustomerCharges.length === 2,
  distinctCustomerCharges,
);

const ratesTs = readFileSync('src/services/rates.ts', 'utf8');
check(
  'direct-carrier adapter normalizes customer amount before raw cost',
  /const amount = directCustomerShippingAmount\(rate\);/.test(ratesTs) &&
    /directRawShippingCost\(rate, amount\)/.test(ratesTs),
);
check(
  'local rates pickBestRate delegates comparison to combined customer-charge owner',
  /function rateCostTotal\(rate: Rate\): number \{\s*return combinedRateCostTotal\(rate as any\);\s*\}/s.test(ratesTs) &&
    /rateTotal\(a\) - rateTotal\(b\)\) \|\| \(rateCostTotal\(a\) - rateCostTotal\(b\)/.test(ratesTs),
);

if (failures > 0) {
  console.error(`\nFAIL PS-307 marked-rate comparison guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-307 marked-rate comparison guard');
