/**
 * PS-334 guard - Rate Cost is the one internal-cost SOT.
 *
 * Offline only: no DB, no providers, no labels, no postage, no marketplace
 * notifications, no inventory, no production order/shipment edits, and no
 * billing regeneration.
 */
import { readFileSync } from 'node:fs';
import { resolveNextBestNonHouseRate } from '../src/lib/next-best-non-house-rate';
import { normalizeOrderBestRateDto } from '../src/services/order-rate-dto';
import { redactOrderFinancials } from '../src/services/orders-financial-redaction';
import { redactRateBrowserMoney } from '../src/services/rate-browser-money-redaction';
import { decideShippingLineBilling } from '../src/services/billing-shipping-line';
import { buildOrderRowMoneyDisplay } from '../src/services/shipping-workflow/rate-money';
import { renderInvoiceCsvRow } from '../src/routes/billing-invoice-csv';

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

const houseAwaiting = buildOrderRowMoneyDisplay({
  isAwaiting: true,
  bestRateBaseAmount: 10.55,
  selectedRateBaseAmount: null,
  labelFinalCost: null,
  markupRule: { type: 'percent', value: 35 },
  insuranceAddOn: 1.25,
  houseMarkedAmount: 14.25,
});

check(
  'backend money tuple uses rateCostAmount as the canonical internal cost',
  houseAwaiting?.markupSource === 'house_account' &&
    houseAwaiting.customerRateAmount === 14.25 &&
    houseAwaiting.rateCostAmount === 10.55 &&
    closeTo(houseAwaiting.shippingMarginAmount, 3.7) &&
    houseAwaiting.insuranceAddOn === 1.25 &&
    houseAwaiting.customerRateSource === 'projected_house_customer_rate',
  houseAwaiting,
);

const normalizedHouseBest = normalizeOrderBestRateDto({
  carrierCode: 'ups',
  serviceCode: 'ups_ground',
  shipmentCost: 10.55,
  otherCost: 0,
  totalCost: 10.55,
  nextBestNonHouseRate: {
    carrierCode: 'ups',
    serviceCode: 'ups_ground',
    shipmentCost: 14.25,
    otherCost: 0,
    totalCost: 14.25,
  },
  houseMargin: 3.7,
  customerRateAmount: 14.25,
  rateCostAmount: 10.55,
  houseRateAmount: 99.99,
  shippingMarginAmount: 3.7,
  houseApplied: true,
  houseBadgeVisible: true,
});

check(
  'OrderBestRateDto ignores drifting houseRateAmount and derives the deprecated alias from rateCostAmount',
  normalizedHouseBest?.customerRateAmount === 14.25 &&
    normalizedHouseBest.rateCostAmount === 10.55 &&
    (normalizedHouseBest as any).houseRateAmount === 10.55,
  normalizedHouseBest,
);

const HUGRAB_CONTEXT = { clientId: 4, clientName: 'HUGRAB', storeId: 378060 };
const insuredNextBest = resolveNextBestNonHouseRate({
  eligibleRates: [
    {
      provider: 'shipp',
      carrier_code: 'ups',
      carrier_id: 'se-1001',
      service_code: 'ups_ground',
      service_name: 'UPS Ground',
      shipping_amount: { amount: 10.55 },
      other_amount: { amount: 0 },
    },
    {
      provider: 'ups',
      carrier_code: 'ups',
      carrier_id: 'se-2002',
      service_code: 'ups_ground_saver',
      service_name: 'UPS Ground Saver',
      shipping_amount: { amount: 9.9 },
      other_amount: { amount: 0 },
    },
    {
      provider: 'ups',
      carrier_code: 'ups',
      carrier_id: 'se-2003',
      service_code: 'ups_ground',
      service_name: 'UPS Ground',
      shipping_amount: { amount: 14.25 },
      other_amount: { amount: 0 },
    },
  ],
  context: HUGRAB_CONTEXT,
  shippingOptions: { insuranceProvider: 'parcelguard', insuredValue: 100 },
  client: { shippingMarginPolicy: { mode: 'next_best_customer_rate' } } as never,
});

check(
  'customer Best Rate selector rejects cheaper HUGRAB insurance-ineligible competitor',
  insuredNextBest?.total === 14.25 && insuredNextBest.competitorCount === 1,
  insuredNextBest,
);

const redactedOrder = redactOrderFinancials(
  {
    shipping: {
      customerRateAmount: 14.25,
      rateCostAmount: 10.55,
      houseRateAmount: 10.55,
      shippingMarginAmount: 3.7,
    },
    overrides: {
      bestRateJson: {
        customerRateAmount: 14.25,
        rateCostAmount: 10.55,
        houseRateAmount: 10.55,
        shippingMarginAmount: 3.7,
      },
    },
    bestRateWorkflow: {
      money: {
        customerRateAmount: 14.25,
        rateCostAmount: 10.55,
        houseRateAmount: 10.55,
        shippingMarginAmount: 3.7,
      },
    },
  },
  false,
) as any;

check(
  'order financial redaction hides internal cost and deprecated house alias from non-financial viewers',
  redactedOrder.bestRateWorkflow.money === null &&
    redactedOrder.shipping.rateCostAmount === null &&
    redactedOrder.shipping.houseRateAmount === null &&
    redactedOrder.overrides.bestRateJson.rateCostAmount === null &&
    redactedOrder.overrides.bestRateJson.houseRateAmount === null,
  redactedOrder,
);

const redactedBrowse = redactRateBrowserMoney({
  bestRate: {
    carrier_code: 'ups',
    customerRateAmount: 14.25,
    rateCostAmount: 10.55,
    houseRateAmount: 10.55,
    shippingMarginAmount: 3.7,
  },
}) as any;

check(
  'rate-browser redaction hides internal cost and deprecated house alias from non-financial viewers',
  redactedBrowse.bestRate.carrier_code === 'ups' &&
    redactedBrowse.bestRate.rateCostAmount === null &&
    redactedBrowse.bestRate.houseRateAmount === null &&
    redactedBrowse.bestRate.customerRateAmount === null,
  redactedBrowse,
);

const billingDecision = decideShippingLineBilling({
  labelCost: 10.55,
  houseCustomerRate: 14.25,
  billingMode: 'label_cost',
  isBaselineCarrier: false,
  refUspsRate: 8,
  refUpsRate: 9,
  shippingMarkupPct: 35,
  shippingMarkupFlat: 0,
});

check(
  'billing charges customer Selected Rate, not Rate Cost',
  billingDecision.billedAmount === 14.25 &&
    billingDecision.source === 'house_customer_rate' &&
    billingDecision.markupApplied === false,
  billingDecision,
);

const invoiceCsv = renderInvoiceCsvRow({
  order_id: 334,
  order_number: 'PS-334-HOUSE',
  ship_date: '2026-06-26',
  base_qty: '1',
  addl_qty: '0',
  pickpack_amt: '0',
  additional_amt: '0',
  shipping_amt: '14.25',
  storage_amt: '0',
  row_total: '14.25',
  skus: 'HU-10',
  package_cost_amt: '0',
  box_label: '12x10x3',
  box_review: false,
  fee_waived: false,
});

check(
  'invoice CSV carries customer shipping amount and no internal cost column',
  invoiceCsv.includes('14.25') && !/House Rate|houseRateAmount|Rate Cost|rateCostAmount|10\.55/.test(invoiceCsv),
  invoiceCsv,
);

const rateMoneySrc = read('src/services/shipping-workflow/rate-money.ts');
check(
  'backend money owner documents houseRateAmount as deprecated compatibility alias only',
  /rateCostAmount:\s*number\s*\|\s*null/.test(rateMoneySrc) &&
    /deprecated compatibility alias/i.test(rateMoneySrc) &&
    /houseRateAmount:\s*input\.houseApplied && rateCostAmount != null \? round2\(rateCostAmount\) : null/.test(rateMoneySrc),
);

const houseStampSrc = read('src/services/shipping-workflow/house-tuple-stamp.ts');
check(
  'house tuple stamping no longer writes houseRateAmount as an independent persisted field',
  !/houseRateAmount\s*:/.test(houseStampSrc) &&
    !/house_rate_amount\s*:/.test(houseStampSrc) &&
    /rateCostAmount:\s*drpCost/.test(houseStampSrc) &&
    /rate_cost_amount:\s*drpCost/.test(houseStampSrc),
);

const columnsSrc = read('web/src/components/Views/orders-table-columns.ts');
check(
  'Orders table has no visible House Rate column or sort key',
  !/'houserate'/.test(columnsSrc) &&
    !/House Rate/.test(columnsSrc) &&
    !/case 'houserate'/.test(columnsSrc),
);

const paritySrc = read('web/src/components/Views/orders-parity.ts');
check(
  'orders parity model no longer reserves a House Rate column',
  !/'houserate'/.test(paritySrc) &&
    !/houserate:/.test(paritySrc),
);

const rateCellsSrc = read('web/src/components/Views/orders-rate-cells.tsx');
check(
  'orders rate cells do not render a separate House Rate cell',
  !/renderHouseRateCell/.test(rateCellsSrc) &&
    !/House Rate/.test(rateCellsSrc) &&
    !/getBackendRowMoney\(order\)\?\.houseRateAmount/.test(rateCellsSrc),
);

const ordersViewSrc = read('web/src/components/Views/OrdersView.tsx');
check(
  'OrdersView no longer delegates a House Rate column renderer',
  !/case 'houserate'/.test(ordersViewSrc) &&
    !/renderHouseRateCell/.test(ordersViewSrc),
);

const orderCellsSrc = read('web/src/components/Views/orders/cells/order-cells.tsx');
check(
  'Best/Selected Rate house rows do not render Rate Cost as a sub-line',
  /shippedBackendMoney\.markupSource === 'house_account'[\s\S]*?renderRateAmountWithMarkup\(null,\s*shippedBackendMoney\.markedAmount/.test(orderCellsSrc) &&
    /renderRateAmountWithMarkup\(backendMoney\.markupSource === 'house_account' \? null : backendMoney\.baseAmount,\s*backendMoney\.markedAmount/.test(orderCellsSrc),
);

check(
  'Awaiting Best Rate cell does not render the second-best sub-line',
  !/2nd\s*\{formatMoney\(secondBestAmount\)\}/.test(orderCellsSrc) &&
    !/const secondBestAmount\b/.test(orderCellsSrc),
);

const packageJson = read('package.json');
check(
  'package exposes PS-334 guard',
  /"test:ps-334-house-rate-column"\s*:\s*"tsx scripts\/ps-334-house-rate-column-guard\.ts"/.test(packageJson),
);

if (failures > 0) {
  console.error(`\nFAIL PS-334 Rate Cost SOT guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-334 Rate Cost SOT guard');
