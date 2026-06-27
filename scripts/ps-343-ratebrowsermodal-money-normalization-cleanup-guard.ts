/**
 * PS-343 - RateBrowserModal money normalization cleanup.
 *
 * Offline only: no DB, no provider calls, no labels, no queue mutation.
 * Proves Rate Browser display/application code consumes backend-stamped money
 * aliases instead of rebuilding customer/rate-cost totals from provider money
 * components in the frontend.
 */
import { existsSync, readFileSync } from 'node:fs';
import { applyMarkups } from '../src/services/rates';
import { rateCostTotal, rateTotal } from '../src/services/rates-combined';

let failures = 0;

function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function sliceBetween(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  if (start < 0) throw new Error(`Missing ${startNeedle}`);
  const end = source.indexOf(endNeedle, start);
  if (end <= start) throw new Error(`Missing ${endNeedle}`);
  return source.slice(start, end);
}

const modal = readFileSync('web/src/components/RateBrowserModal.tsx', 'utf8');
const moneyHelper = readFileSync('web/src/lib/rate-browser-money.ts', 'utf8');
const ratesRoute = readFileSync('src/routes/rates.ts', 'utf8');
const packageJson = readFileSync('package.json', 'utf8');
const ledger = readFileSync('docs/ps-tickets/ps-ledger.md', 'utf8');

const bestRateSeed = sliceBetween(
  modal,
  'function buildOrderBestRateSeed(',
  '\nconst TEST_MOCK_SERVICE_TEMPLATES',
);
const dedupeKey = sliceBetween(
  modal,
  'function rateRowDedupeKey(rate: RateRow): string {',
  '\nfunction dedupeRateRows(',
);

const markedShipStationRate = applyMarkups([
  {
    carrier_id: 'se-343',
    carrier_code: 'ups',
    service_code: 'ups_ground',
    service_type: 'UPS Ground',
    package_type: 'package',
    shipping_amount: { amount: 10, currency: 'USD' },
    other_amount: { amount: 0, currency: 'USD' },
    confirmation_amount: { amount: 0, currency: 'USD' },
    insurance_amount: { amount: 0, currency: 'USD' },
  } as any,
], new Map([['se-343', { type: 'percent', value: 10 } as any]]))[0] as any;

check('backend markup owner stamps customer amount after markup',
  markedShipStationRate.shipping_amount?.amount === 11 &&
  markedShipStationRate.customerShippingAmount === 11 &&
  markedShipStationRate.markedShippingAmount === 11);

check('backend markup owner preserves raw provider cost as explicit rate-cost aliases',
  markedShipStationRate.rateCostAmount === 10 &&
  markedShipStationRate.rate_cost_amount === 10 &&
  markedShipStationRate.rawShippingAmount === 10 &&
  markedShipStationRate.raw_shipping_amount === 10 &&
  markedShipStationRate.internalShippingAmount === 10 &&
  markedShipStationRate.internal_shipping_amount === 10);

check('combined backend money helpers separate customer charge from internal rate cost',
  rateTotal(markedShipStationRate) === 11 && rateCostTotal(markedShipStationRate) === 10);

check('rates route imports and stamps backend rate-cost display aliases',
  ratesRoute.includes('combineCarrierUniverses, rateCostTotal, rateTotal') &&
  ratesRoute.includes('const rateCostAmount = roundRateMoney(rateCostTotal(rate));') &&
  ratesRoute.includes('customerRateAmount: readFiniteRateNumber') &&
  ratesRoute.includes('rateCostAmount: readFiniteRateNumber'));

check('saved best-rate seed does not read provider money components',
  !/shipping_amount|original_amount|other_amount|confirmation_amount|insurance_amount/.test(bestRateSeed));

check('saved best-rate seed consumes backend amount aliases',
  bestRateSeed.includes('bestRate.amount') &&
  bestRateSeed.includes('raw.amount') &&
  bestRateSeed.includes('bestRate.totalCost') &&
  bestRateSeed.includes('raw.totalCost'));

check('saved best-rate seed does not rebuild display amount from local component math',
  !/amount:\s*shipmentCost\s*\+\s*otherCost/.test(bestRateSeed) &&
  !/componentOtherCost|confirmationAmountCost|insuranceAmountCost|otherAmountCost/.test(bestRateSeed));

check('rate row dedupe does not read provider money components',
  !/original_amount|other_amount|confirmation_amount|insurance_amount|shipping_amount/.test(dedupeKey));

check('rate row dedupe keys backend aliases only',
  dedupeKey.includes('rate.amount') &&
  dedupeKey.includes('raw?.amount') &&
  dedupeKey.includes('rate.otherCost') &&
  dedupeKey.includes('raw?.otherCost'));

check('rate-browser money helper no longer reconstructs provider component money',
  !/shipping_amount|original_amount|other_amount|confirmation_amount|insurance_amount|moneyAmount|legacyCustomerTotal|legacyRateCostTotal|componentOtherTotal/.test(moneyHelper));

check('rate-browser money helper prefers backend-stamped customer/rate-cost aliases',
  moneyHelper.includes('record?.customerRateAmount') &&
  moneyHelper.includes('record?.rateCostAmount') &&
  moneyHelper.includes('record?.amount') &&
  moneyHelper.includes('record?.totalCost'));

check('package wires PS-343 guard',
  packageJson.includes('"test:ps-343-ratebrowsermodal-money-normalization-cleanup"'));

check('ledger reserves PS-343 cleanup ticket',
  ledger.includes('| PS-343 | RateBrowserModal money normalization cleanup |'));

check('PS-343 doc exists',
  existsSync('docs/ps-tickets/ps-343-ratebrowsermodal-money-normalization-cleanup.md'));

if (failures > 0) {
  console.error(`\nFAIL PS-343 RateBrowserModal money normalization cleanup guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-343 RateBrowserModal money normalization cleanup guard');
