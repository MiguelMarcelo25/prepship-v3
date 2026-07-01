/**
 * PS-355 guard - Other Cost is part of every cheapest-rate comparison.
 *
 * Offline only: no DB, no network, no providers, no labels/postage, and no
 * production order mutation. The fixture mirrors the reported Walmart/ORION
 * failure: low base shipping plus high Other Cost must lose to the lower full
 * customer total.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolveNextBestNonHouseRate } from '../src/lib/next-best-non-house-rate';
import {
  combineCarrierUniverses,
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

function near(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) < 0.005;
}

const lowShippingHighOther: CombinableRate = {
  carrier_id: 'se-redacted-orion',
  carrier_code: 'ups',
  provider: 'shipstation',
  service_code: 'ups_ground',
  service_type: 'UPS Ground',
  shipping_amount: { amount: 8.39 },
  customerShippingAmount: 9.65,
  other_amount: { amount: 8.48 },
};

const lowerFullTotal: CombinableRate = {
  carrier_id: 'se-redacted-usps',
  carrier_code: 'usps',
  provider: 'shipstation',
  service_code: 'usps_ground_advantage',
  service_type: 'USPS Ground Advantage',
  shipping_amount: { amount: 11.84 },
  other_amount: { amount: 0 },
};

check(
  'rateTotal includes Other Cost in the customer-facing total',
  near(rateTotal(lowShippingHighOther), 18.13) && near(rateTotal(lowerFullTotal), 11.84),
  {
    lowShippingHighOther: rateTotal(lowShippingHighOther),
    lowerFullTotal: rateTotal(lowerFullTotal),
  },
);

const combined = combineCarrierUniverses({
  ssRates: [lowShippingHighOther, lowerFullTotal],
  ssCacheKey: 'ps-355',
  ssCached: false,
  ssDiagnostics: [
    { carrierId: 'se-redacted-orion', status: 'ok', rateCount: 1 },
    { carrierId: 'se-redacted-usps', status: 'ok', rateCount: 1 },
  ],
  directRates: [],
  directDiagnostics: [],
  requestedCarrierIds: null,
  accountNamesByCarrierId: new Map([
    ['se-redacted-orion', 'ORION'],
    ['se-redacted-usps', 'USPS'],
  ]),
  accountCarrierIds: ['se-redacted-orion', 'se-redacted-usps'],
  isCachedOnlyLookup: false,
});

check(
  'combined best-rate owner ranks by full customer total, not base shipping',
  combined.cheapest?.service_code === 'usps_ground_advantage' &&
    combined.secondCheapest?.service_code === 'ups_ground',
  {
    ranked: combined.rankedEligibleRates.map((rate) => ({
      service: rate.service_code,
      baseShipping: rate.shipping_amount?.amount,
      other: rate.other_amount?.amount,
      total: rateTotal(rate),
    })),
  },
);

const houseRockBottom: CombinableRate = {
  carrier_id: 'se-redacted-house',
  carrier_code: 'ups',
  provider: 'shipp',
  service_code: 'house_ground',
  service_type: 'House Ground',
  shipping_amount: { amount: 6 },
  other_amount: { amount: 0 },
  rateCostAmount: 6,
  customerShippingAmount: 6,
};

const nextBest = resolveNextBestNonHouseRate({
  eligibleRates: [houseRockBottom, lowShippingHighOther, lowerFullTotal],
  context: { clientId: 1, storeId: 1 },
  client: { houseAccountOptIn: true },
});

check(
  'house next-best customer-rate logic includes Other Cost when choosing the competitor',
  nextBest?.rate.service_code === 'usps_ground_advantage' && near(nextBest.total, 11.84),
  nextBest,
);

const ratesBackfill = readFileSync('src/services/rates-backfill.ts', 'utf8');
check(
  'rates backfill imports the canonical full-total owner',
  /import \{[^}]*\brateTotal\b[^}]*\} from '\.\/rates-combined'/.test(ratesBackfill),
);
check(
  'rates backfill tier picker delegates cheapest comparison to rateTotal',
  /sort\(\s*\(\s*a\s*,\s*b\s*\)\s*=>\s*rateTotal\(a\)\s*-\s*rateTotal\(b\)\s*\)/s.test(ratesBackfill),
);
check(
  'rates backfill no longer ranks by base shipping_amount only',
  !/shipping_amount\.amount\s*-\s*b\.shipping_amount\.amount/.test(ratesBackfill),
);

const costComponentPath = 'web/src/lib/rate-browser-cost-components.ts';
check('Rate Browser cost component reader exists', existsSync(costComponentPath));
const costComponentSource = existsSync(costComponentPath) ? readFileSync(costComponentPath, 'utf8') : '';
check(
  'Rate Browser cost reader can show top-level or raw Other Cost without rate_details',
  /rateBrowserOtherCostAmount/.test(costComponentSource) &&
    /record\?\.otherCost/.test(costComponentSource) &&
    /raw\?\.otherCost/.test(costComponentSource) &&
    /other_amount/.test(costComponentSource),
);

const rateRowItem = readFileSync('web/src/components/RateRowItem.tsx', 'utf8');
check(
  'Rate Browser row renders an explicit Other Cost line when nonzero',
  /rateBrowserOtherCostAmount/.test(rateRowItem) &&
    /Other Cost/.test(rateRowItem) &&
    /otherCostAmount\.toFixed\(2\)/.test(rateRowItem),
);

if (failures > 0) {
  console.error(`\nFAIL PS-355 Other Cost rate comparison guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-355 Other Cost rate comparison guard');
