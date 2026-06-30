/**
 * PS-356 guard - backend preserves the selected Best Rate purchase cost and
 * customer-facing C. Shipping Rate as separated money fields.
 *
 * Offline only: no DB, no providers, no labels, no postage, no marketplace
 * notifications, no inventory, and no production order/shipment edits.
 */
import { readFileSync } from 'node:fs';
import { resolveNextBestNonHouseRate } from '../src/lib/next-best-non-house-rate';
import { combineCarrierUniverses, rateCostTotal, rateTotal, type CombinableRate } from '../src/services/rates-combined';
import { stampRateBrowserDisplayAliases } from '../src/services/rate-browser-display-fields';
import { buildOrderRowMoneyDisplay } from '../src/services/shipping-workflow/rate-money';
import { normalizeOrderBestRateDto } from '../src/services/order-rate-dto';
import { decideShippingLineBilling } from '../src/services/billing-shipping-line';
import { redactOrderFinancials } from '../src/services/orders-financial-redaction';
import { redactRateBrowserMoney } from '../src/services/rate-browser-money-redaction';

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

function read(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

const purchaseCheapest: CombinableRate = {
  carrier_id: 'se-10000005',
  carrier_code: 'ups',
  service_code: 'ups_ground',
  shipping_amount: { amount: 12 },
  other_amount: { amount: 0 },
  customerRateAmount: 12,
  customer_rate_amount: 12,
  rateCostAmount: 5,
  rate_cost_amount: 5,
};

const customerCheapest: CombinableRate = {
  carrier_id: 'se-10000007',
  carrier_code: 'usps',
  service_code: 'ground_advantage',
  shipping_amount: { amount: 8 },
  other_amount: { amount: 0 },
  customerRateAmount: 8,
  customer_rate_amount: 8,
  rateCostAmount: 7,
  rate_cost_amount: 7,
};

const combined = combineCarrierUniverses({
  ssRates: [customerCheapest, purchaseCheapest],
  ssCacheKey: 'ps-356',
  ssCached: false,
  ssDiagnostics: [],
  directRates: [],
  directDiagnostics: [],
  requestedCarrierIds: null,
  accountNamesByCarrierId: new Map(),
  accountCarrierIds: [],
  isCachedOnlyLookup: false,
});

check(
  'combined universe selects official Best Rate by marked/customer rate, not internal cost',
  combined.cheapest?.carrier_id === 'se-10000007' &&
    closeTo(rateCostTotal(combined.cheapest), 7) &&
    closeTo(rateTotal(combined.cheapest), 8),
  {
    picked: combined.cheapest?.carrier_id,
    pickedRateCost: combined.cheapest ? rateCostTotal(combined.cheapest) : null,
    pickedCustomerCharge: combined.cheapest ? rateTotal(combined.cheapest) : null,
  },
);

const houseCustomer = resolveNextBestNonHouseRate({
  eligibleRates: [customerCheapest, purchaseCheapest],
  context: { clientId: 4, storeId: 378060 },
  client: { shippingMarginPolicy: { mode: 'next_best_customer_rate' } },
});

check(
  'house/customer-margin mode gets C. Shipping Rate from the next eligible customer-facing rate',
  houseCustomer?.rate.carrier_id === 'se-10000007' &&
    closeTo(houseCustomer.total, 8) &&
    houseCustomer.competitorCount === 1,
  houseCustomer,
);

const passThroughMoney = buildOrderRowMoneyDisplay({
  isAwaiting: true,
  bestRateBaseAmount: 5,
  selectedRateBaseAmount: null,
  labelFinalCost: null,
  markupRule: null,
  insuranceAddOn: null,
  houseMarkedAmount: null,
});

check(
  'when customer-margin mode is off, customer Best Rate equals the backend marked amount',
  passThroughMoney?.rateCostAmount === 5 &&
    passThroughMoney.customerRateAmount === 5 &&
    passThroughMoney.shippingMarginAmount === 0,
  passThroughMoney,
);

const houseMoney = buildOrderRowMoneyDisplay({
  isAwaiting: true,
  bestRateBaseAmount: 5,
  selectedRateBaseAmount: null,
  labelFinalCost: null,
  markupRule: null,
  insuranceAddOn: null,
  houseMarkedAmount: 8,
});

check(
  'when customer-margin mode is on, backend separates customer rate and internal purchase cost',
  houseMoney?.rateCostAmount === 5 &&
    houseMoney.customerRateAmount === 8 &&
    houseMoney.shippingMarginAmount === 3,
  houseMoney,
);

const aliasedBest = stampRateBrowserDisplayAliases({
  ...purchaseCheapest,
  amount: 12,
});

check(
  'Rate Browser DTO keeps shipmentCost/totalCost on the Best Rate purchase basis',
  (aliasedBest as any).shipmentCost === 5 &&
    (aliasedBest as any).totalCost === 5 &&
    (aliasedBest as any).rateCostAmount === 5 &&
    (aliasedBest as any).customerRateAmount === 12,
  aliasedBest,
);

const normalized = normalizeOrderBestRateDto(aliasedBest);
check(
  'OrderBestRateDto preserves purchase cost and customerRateAmount as separated money fields',
  normalized?.shipmentCost === 5 &&
    normalized.totalCost === 5 &&
    normalized.rateCostAmount === 5 &&
    normalized.customerRateAmount === 12,
  normalized,
);

const billingDecision = decideShippingLineBilling({
  labelCost: 5,
  houseCustomerRate: 8,
  billingMode: 'label_cost',
  isBaselineCarrier: false,
  refUspsRate: 7,
  refUpsRate: 9,
  shippingMarkupPct: 0,
  shippingMarkupFlat: 0,
});

check(
  'billing uses customer rate when present, not internal Rate Cost',
  billingDecision.billedAmount === 8 && billingDecision.source === 'house_customer_rate',
  billingDecision,
);

const redactedOrder = redactOrderFinancials(
  {
    shipping: {
      customerRateAmount: 12,
      rateCostAmount: 5,
      shippingMarginAmount: 7,
    },
    bestRateWorkflow: {
      money: {
        customerRateAmount: 12,
        rateCostAmount: 5,
        shippingMarginAmount: 7,
      },
    },
  },
  false,
) as any;

check(
  'non-financial order viewers cannot see Best Rate purchase or C. Shipping money tuple',
  redactedOrder.bestRateWorkflow.money === null &&
    redactedOrder.shipping.customerRateAmount === null &&
    redactedOrder.shipping.rateCostAmount === null,
  redactedOrder,
);

const redactedBrowse = redactRateBrowserMoney({
  bestRate: {
    carrier_code: 'ups',
    customerRateAmount: 12,
    rateCostAmount: 5,
    shippingMarginAmount: 7,
  },
}) as any;

check(
  'non-financial Rate Browser viewers cannot see Best Rate purchase or C. Shipping values',
  redactedBrowse.bestRate.customerRateAmount === null &&
    redactedBrowse.bestRate.rateCostAmount === null,
  redactedBrowse,
);

const columnsSrc = read('web/src/components/Views/orders-table-columns.ts');
check(
  'Orders table labels the customer-billing column C. Shipping Rate',
  /key:\s*'ratecost',\s*label:\s*'C\. Shipping Rate'/.test(columnsSrc) && !/label:\s*'Rate Cost'/.test(columnsSrc),
);

const orderCellsSrc = read('web/src/components/Views/orders/cells/order-cells.tsx');
check(
  'Best Rate cell delegates separated tuple display to focused presentation policy',
  orderCellsSrc.includes('resolveAwaitingBestRatePriceDisplay') &&
    /renderRateAmountWithMarkup\(\s*bestRatePriceDisplay\.baseAmount,\s*bestRatePriceDisplay\.primaryAmount/.test(orderCellsSrc) &&
    /bestRatePriceDisplay\.showHouseBadge \? null : getBestRateInsuranceCoverage/.test(orderCellsSrc),
);

if (failures > 0) {
  console.error(`\nFAIL PS-356 Best Rate / C. Shipping SOT guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-356 Best Rate / C. Shipping SOT guard');
