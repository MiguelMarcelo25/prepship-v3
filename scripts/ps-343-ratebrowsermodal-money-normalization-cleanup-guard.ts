/**
 * PS-343 - RateBrowserModal money normalization cleanup.
 *
 * Offline only: no DB, no provider calls, no labels, no queue mutation.
 * Proves Rate Browser display/application code consumes backend-stamped money
 * aliases instead of rebuilding customer/rate-cost totals from provider money
 * components in the frontend.
 */
import { existsSync, readFileSync } from 'node:fs';

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
const ratesService = readFileSync('src/services/rates.ts', 'utf8');
const combinedRateOwner = readFileSync('src/services/rates-combined.ts', 'utf8');
const ratesRoute = readFileSync('src/routes/rates.ts', 'utf8');
const displayFields = readFileSync('src/services/rate-browser-display-fields.ts', 'utf8');
const purchaseCustomerAliases = readFileSync('src/services/shipping-workflow/purchase-customer-rate-aliases.ts', 'utf8');
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
const applyMarkupsOwner = sliceBetween(
  ratesService,
  'export function applyMarkups(',
  '\n// PS-perf',
);
const rateTotalOwner = sliceBetween(
  combinedRateOwner,
  'export function rateTotal(',
  '\n/** DJR/DRP purchase-cost total',
);
const rateCostTotalOwner = sliceBetween(
  combinedRateOwner,
  'export function rateCostTotal(',
  '\nexport function isPricedRate(',
);

check('backend markup owner stamps customer amount after markup',
  applyMarkupsOwner.includes('const orig = r.shipping_amount.amount;') &&
  applyMarkupsOwner.includes('const marked = applyMarkupToAmount(orig, m);') &&
  applyMarkupsOwner.includes('shipping_amount:') &&
  applyMarkupsOwner.includes('amount: marked') &&
  applyMarkupsOwner.includes('customerShippingAmount: marked') &&
  applyMarkupsOwner.includes('customer_shipping_amount: marked') &&
  applyMarkupsOwner.includes('customerRateAmount: marked') &&
  applyMarkupsOwner.includes('customer_rate_amount: marked') &&
  applyMarkupsOwner.includes('markedShippingAmount: marked') &&
  applyMarkupsOwner.includes('marked_shipping_amount: marked'));

check('backend markup owner preserves raw provider cost as explicit rate-cost aliases',
  applyMarkupsOwner.includes('rateCostAmount: orig') &&
  applyMarkupsOwner.includes('rate_cost_amount: orig') &&
  applyMarkupsOwner.includes('rawShippingAmount: orig') &&
  applyMarkupsOwner.includes('raw_shipping_amount: orig') &&
  applyMarkupsOwner.includes('internalShippingAmount: orig') &&
  applyMarkupsOwner.includes('internal_shipping_amount: orig'));

check('combined backend money helpers separate customer charge from internal rate cost',
  rateTotalOwner.includes('customerShippingAmount(rate) ?? rate.shipping_amount?.amount') &&
  rateCostTotalOwner.includes('internalShippingCost(rate) ?? rate.shipping_amount?.amount') &&
  combinedRateOwner.includes('function customerShippingAmount(rate: CombinableRate): number | null') &&
  combinedRateOwner.includes('function internalShippingCost(rate: CombinableRate): number | null') &&
  combinedRateOwner.indexOf('export function rateTotal(') < combinedRateOwner.indexOf('export function rateCostTotal('));

check('rates route delegates backend purchase/customer display aliases to shared owner',
  ratesRoute.includes("import { stampRateBrowserDisplayAliases } from '../services/rate-browser-display-fields'") &&
  ratesRoute.includes('rates: stampRateBrowserDisplayAliases(row.rates)') &&
  ratesRoute.includes('bestRate: stampRateBrowserDisplayAliases(row.bestRate)') &&
  displayFields.includes('stampPurchaseCustomerRateAliases') &&
  purchaseCustomerAliases.includes('rateCostTotal(rate as CombinableRate)') &&
  purchaseCustomerAliases.includes('rateTotal(rate as CombinableRate)'));

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
