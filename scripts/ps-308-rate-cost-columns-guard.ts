/**
 * PS-308/PS-357 guard - separated Best/Selected purchase cost, C. Shipping Rate, and Shipping Margin.
 *
 * Offline only: no DB, no network, no providers, no labels, no postage, no
 * marketplace notifications, no queue mutation, and no shipped/cancelled data.
 */
import { readFileSync } from 'node:fs';
import { redactOrderFinancials } from '../src/services/orders-financial-redaction';
import { redactRateBrowserMoney } from '../src/services/rate-browser-money-redaction';
import { normalizeOrderBestRateDto } from '../src/services/order-rate-dto';
import { rateCostTotal, rateTotal } from '../src/services/rates-combined';
import { buildOrderRowMoneyDisplay } from '../src/services/shipping-workflow/rate-money';

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function closeTo(actual: unknown, expected: number, epsilon = 0.001): boolean {
  return typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= epsilon;
}

const houseAwaiting = buildOrderRowMoneyDisplay({
  isAwaiting: true,
  bestRateBaseAmount: 7.75,
  selectedRateBaseAmount: null,
  labelFinalCost: null,
  markupRule: { type: 'percent', value: 50 },
  insuranceAddOn: null,
  houseMarkedAmount: 8.05,
});

check(
  'house awaiting model keeps customer charge separate from internal rate cost',
  houseAwaiting?.markedAmount === 8.05 &&
    houseAwaiting.baseAmount === 7.75 &&
    (houseAwaiting as any).cShippingRateAmount === 8.05 &&
    (houseAwaiting as any).selectedRateCost === 7.75 &&
    closeTo((houseAwaiting as any).shippingMarginAmount, 0.3) &&
    closeTo((houseAwaiting as any).shippingMarginPct, 3.7) &&
    (houseAwaiting as any).houseApplied === true &&
    (houseAwaiting as any).houseBadgeVisible === true &&
    (houseAwaiting as any).rateAdjustmentKind === 'customer_profit_markup' &&
    (houseAwaiting as any).customerRateSource === 'projected_house_c_shipping_rate' &&
    (houseAwaiting as any).rateCostSource === 'shipp_house_internal_cost',
  houseAwaiting,
);

const houseShipped = buildOrderRowMoneyDisplay({
  isAwaiting: false,
  bestRateBaseAmount: null,
  selectedRateBaseAmount: 10.14,
  labelFinalCost: 10.14,
  markupRule: { type: 'percent', value: 40 },
  insuranceAddOn: null,
  houseMarkedAmount: 10.79,
});

check(
  'house shipped model uses realized customer rate against SHIPP actual cost',
  houseShipped?.source === 'selected_rate' &&
    (houseShipped as any).cShippingRateAmount === 10.79 &&
    (houseShipped as any).selectedRateCost === 10.14 &&
    closeTo((houseShipped as any).shippingMarginAmount, 0.65) &&
    closeTo((houseShipped as any).shippingMarginPct, 6) &&
    (houseShipped as any).rateAdjustmentKind === 'customer_profit_markup' &&
    (houseShipped as any).customerRateSource === 'realized_house_c_shipping_rate' &&
    (houseShipped as any).rateCostSource === 'shipp_house_internal_cost',
  houseShipped,
);

const normalAwaiting = buildOrderRowMoneyDisplay({
  isAwaiting: true,
  bestRateBaseAmount: 10,
  selectedRateBaseAmount: null,
  labelFinalCost: null,
  markupRule: { type: 'percent', value: 20 },
  insuranceAddOn: null,
});

check(
  'normal awaiting model separates marked customer rate from carrier cost',
  normalAwaiting?.markedAmount === 12 &&
    normalAwaiting.baseAmount === 10 &&
    (normalAwaiting as any).cShippingRateAmount === 12 &&
    (normalAwaiting as any).selectedRateCost === 10 &&
    (normalAwaiting as any).shippingMarginAmount === 2 &&
    closeTo((normalAwaiting as any).shippingMarginPct, 16.7) &&
    (normalAwaiting as any).houseApplied === false &&
    (normalAwaiting as any).houseBadgeVisible === false &&
    (normalAwaiting as any).rateAdjustmentKind === 'customer_profit_markup' &&
    (normalAwaiting as any).customerRateSource === 'best_rate_marked_amount' &&
    (normalAwaiting as any).rateCostSource === 'best_rate_internal_cost',
  normalAwaiting,
);

const orderRedacted = redactOrderFinancials(
  {
    bestRateWorkflow: {
      money: {
        customerRateAmount: 12,
        rateCostAmount: 10,
        shippingMarginAmount: 2,
        shippingMarginPct: 16.7,
        houseApplied: true,
        houseBadgeVisible: true,
        customerRateSource: 'projected_house_c_shipping_rate',
        rateCostSource: 'shipp_house_internal_cost',
      },
    },
    shipping: {
      customerRateAmount: 12,
      rateCostAmount: 10,
      shippingMarginAmount: 2,
      shippingMarginPct: 16.7,
      houseApplied: true,
      houseBadgeVisible: true,
    },
    overrides: {
      bestRateJson: {
        customerRateAmount: 12,
        rateCostAmount: 10,
        shippingMarginAmount: 2,
        shippingMarginPct: 16.7,
      },
    },
  },
  false,
) as any;

check(
  'order financial redaction hides separated internal rate-cost fields',
  orderRedacted.bestRateWorkflow.money === null &&
    orderRedacted.shipping.customerRateAmount === null &&
    orderRedacted.shipping.rateCostAmount === null &&
    orderRedacted.shipping.shippingMarginAmount === null &&
    orderRedacted.shipping.shippingMarginPct === null &&
    orderRedacted.shipping.houseApplied === null &&
    orderRedacted.shipping.houseBadgeVisible === null &&
    orderRedacted.overrides.bestRateJson.customerRateAmount === null &&
    orderRedacted.overrides.bestRateJson.rateCostAmount === null,
  orderRedacted,
);

const rateBrowserRedacted = redactRateBrowserMoney({
  bestRate: {
    carrier_code: 'ups',
    customerRateAmount: 8.05,
    rateCostAmount: 7.75,
    shippingMarginAmount: 0.3,
    shippingMarginPct: 3.7,
    houseApplied: true,
    houseBadgeVisible: true,
    customerRateSource: 'projected_house_c_shipping_rate',
    rateCostSource: 'shipp_house_internal_cost',
  },
}) as any;

check(
  'rate browser redaction hides separated internal rate-cost fields while preserving non-money facts',
  rateBrowserRedacted.bestRate.carrier_code === 'ups' &&
    rateBrowserRedacted.bestRate.customerRateAmount === null &&
    rateBrowserRedacted.bestRate.rateCostAmount === null &&
    rateBrowserRedacted.bestRate.shippingMarginAmount === null &&
    rateBrowserRedacted.bestRate.shippingMarginPct === null &&
    rateBrowserRedacted.bestRate.houseApplied === null &&
    rateBrowserRedacted.bestRate.houseBadgeVisible === null &&
    rateBrowserRedacted.bestRate.customerRateSource === null &&
    rateBrowserRedacted.bestRate.rateCostSource === null,
  rateBrowserRedacted,
);

const splitRate = {
  shipping_amount: { amount: 8.5 },
  other_amount: { amount: 0 },
  cShippingRateAmount: 12,
  selectedRateCost: 8.5,
};

check(
  'combined-rate owner keeps customer billing separate from DJR purchase cost',
  rateTotal(splitRate) === 12 && rateCostTotal(splitRate) === 8.5,
  { customerTotal: rateTotal(splitRate), rateCost: rateCostTotal(splitRate) },
);

const normalizedHouseBest = normalizeOrderBestRateDto({
  carrierCode: 'ups',
  serviceCode: 'shipp_ups_ground',
  shipmentCost: 8.5,
  otherCost: 0,
  totalCost: 8.5,
  nextBestNonHouseRate: {
    carrierCode: 'stamps_com',
    serviceCode: 'usps_ground_advantage',
    shipmentCost: 9.64,
    otherCost: 0,
    totalCost: 9.64,
  },
  houseMargin: 1.14,
  cShippingRateAmount: 9.64,
  selectedRateCost: 8.5,
  shippingMarginAmount: 1.14,
  shippingMarginPct: 11.8,
  houseApplied: true,
  houseBadgeVisible: true,
  customerRateSource: 'projected_house_c_shipping_rate',
  rateCostSource: 'shipp_house_internal_cost',
});

check(
  'OrderBestRateDto whitelist preserves separated PS-308 house fields',
  normalizedHouseBest?.cShippingRateAmount === 9.64 &&
    normalizedHouseBest.selectedRateCost === 8.5 &&
    normalizedHouseBest.shippingMarginAmount === 1.14 &&
    normalizedHouseBest.shippingMarginPct === 11.8 &&
    normalizedHouseBest.houseApplied === true &&
    normalizedHouseBest.houseBadgeVisible === true &&
    normalizedHouseBest.customerRateSource === 'projected_house_c_shipping_rate' &&
    normalizedHouseBest.rateCostSource === 'shipp_house_internal_cost',
  normalizedHouseBest,
);

const legacyHouseBest = normalizeOrderBestRateDto({
  carrierCode: 'ups',
  serviceCode: 'shipp_ups_ground',
  shipmentCost: 8.5,
  otherCost: 0,
  nextBestNonHouseRate: {
    totalCost: 9.64,
    shipmentCost: 9.64,
    otherCost: 0,
  },
  houseMargin: 1.14,
});

check(
  'OrderBestRateDto derives separated PS-308 fields for older house rows',
  legacyHouseBest?.cShippingRateAmount === 9.64 &&
    legacyHouseBest.selectedRateCost === 8.5 &&
    legacyHouseBest.shippingMarginAmount === 1.14 &&
    closeTo(legacyHouseBest.shippingMarginPct, 11.8) &&
    legacyHouseBest.houseApplied === true,
  legacyHouseBest,
);

const rateMoneyTs = readFileSync('src/services/shipping-workflow/rate-money.ts', 'utf8');
check(
  'backend money owner declares explicit PS-308 separated fields',
  /cShippingRateAmount/.test(rateMoneyTs) &&
    /selectedRateCost/.test(rateMoneyTs) &&
    /shippingMarginAmount/.test(rateMoneyTs) &&
    /shippingMarginPct/.test(rateMoneyTs) &&
    /rateAdjustmentKind/.test(rateMoneyTs) &&
    /customerRateSource/.test(rateMoneyTs) &&
    /rateCostSource/.test(rateMoneyTs),
);

const houseStampTs = readFileSync('src/services/shipping-workflow/house-tuple-stamp.ts', 'utf8');
check(
  'house stamp writes separated customer billing and DJR purchase cost fields from internal cost owner',
  /rateCostTotal/.test(houseStampTs) &&
    /cShippingRateAmount/.test(houseStampTs) &&
    /selectedRateCost/.test(houseStampTs) &&
    /shippingMarginAmount/.test(houseStampTs) &&
    /houseApplied/.test(houseStampTs),
);

const ratesServiceTs = readFileSync('src/services/rates.ts', 'utf8');
check(
  'direct-carrier adapter emits explicit customer billing and DJR purchase cost amounts',
  /cShippingRateAmount: amount/.test(ratesServiceTs) &&
    /selectedRateCost: rawShippingCost/.test(ratesServiceTs) &&
    /selectedRateCost/.test(ratesServiceTs),
);

const rateRowItemTs = readFileSync('web/src/components/RateRowItem.tsx', 'utf8');
check(
  'Rate Browser no longer renders SHIPP House as a stacked price tuple',
  !/priceDisplay\(houseTuple\.drpCost,\s*houseTuple\.customerRate/.test(rateRowItemTs) &&
    /DJR Purchase Cost/.test(rateRowItemTs) &&
    /renderHouseBadge/.test(rateRowItemTs) &&
    !/houseTuple\.customerRate\s*-\s*houseTuple\.drpCost/.test(rateRowItemTs) &&
    !/Margin \$\{/.test(rateRowItemTs) &&
    !/>\s*Margin \$/.test(rateRowItemTs),
);

const packageJson = readFileSync('package.json', 'utf8');
check(
  'package exposes PS-308 guard',
  /"test:ps-308-rate-cost-columns": "tsx scripts\/ps-308-rate-cost-columns-guard\.ts"/.test(packageJson),
);

if (failures > 0) {
  console.error(`\nFAIL PS-308 rate-cost columns guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-308 rate-cost columns guard');
