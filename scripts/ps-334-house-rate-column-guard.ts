/**
 * PS-334 guard - House Rate column + customer Best/Selected Rate contract.
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
  'backend money tuple exposes House Rate separately from customer Best Rate for awaiting house rows',
  houseAwaiting?.markupSource === 'house_account' &&
    houseAwaiting.customerRateAmount === 14.25 &&
    houseAwaiting.rateCostAmount === 10.55 &&
    (houseAwaiting as any).houseRateAmount === 10.55 &&
    closeTo(houseAwaiting.shippingMarginAmount, 3.7) &&
    houseAwaiting.insuranceAddOn === 1.25 &&
    houseAwaiting.customerRateSource === 'projected_house_customer_rate' &&
    houseAwaiting.rateCostSource === 'shipp_house_internal_cost',
  houseAwaiting,
);

const normalAwaiting = buildOrderRowMoneyDisplay({
  isAwaiting: true,
  bestRateBaseAmount: 10.55,
  selectedRateBaseAmount: null,
  labelFinalCost: null,
  markupRule: { type: 'percent', value: 35 },
  insuranceAddOn: 1.25,
  houseMarkedAmount: null,
});

check(
  'house feature off / normal carrier row does not invent a House Rate spread',
  normalAwaiting?.markupSource === 'carrier_markup' &&
    normalAwaiting.customerRateAmount === 14.24 &&
    normalAwaiting.rateCostAmount === 10.55 &&
    (normalAwaiting as any).houseRateAmount === null,
  normalAwaiting,
);

const houseShipped = buildOrderRowMoneyDisplay({
  isAwaiting: false,
  bestRateBaseAmount: null,
  selectedRateBaseAmount: 10.55,
  labelFinalCost: 10.55,
  markupRule: null,
  insuranceAddOn: 1.25,
  houseMarkedAmount: 14.25,
});

check(
  'backend money tuple exposes realized House Rate separately from customer Selected Rate for shipped house rows',
  houseShipped?.source === 'selected_rate' &&
    houseShipped.markupSource === 'house_account' &&
    houseShipped.customerRateAmount === 14.25 &&
    houseShipped.rateCostAmount === 10.55 &&
    (houseShipped as any).houseRateAmount === 10.55 &&
    closeTo(houseShipped.shippingMarginAmount, 3.7) &&
    houseShipped.customerRateSource === 'realized_house_customer_rate',
  houseShipped,
);

const normalizedHouseBest = normalizeOrderBestRateDto({
  carrierCode: 'ups',
  serviceCode: 'shipp_ups_ground',
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
  houseRateAmount: 10.55,
  shippingMarginAmount: 3.7,
  houseApplied: true,
  houseBadgeVisible: true,
});

check(
  'OrderBestRateDto whitelist preserves explicit House Rate amount',
  normalizedHouseBest?.customerRateAmount === 14.25 &&
    normalizedHouseBest.rateCostAmount === 10.55 &&
    (normalizedHouseBest as any).houseRateAmount === 10.55,
  normalizedHouseBest,
);

const legacyHouseBest = normalizeOrderBestRateDto({
  carrierCode: 'ups',
  serviceCode: 'shipp_ups_ground',
  shipmentCost: 10.55,
  otherCost: 0,
  nextBestNonHouseRate: {
    totalCost: 14.25,
    shipmentCost: 14.25,
    otherCost: 0,
  },
  houseMargin: 3.7,
});

check(
  'OrderBestRateDto derives House Rate for legacy house tuples from backend internal cost',
  legacyHouseBest?.customerRateAmount === 14.25 &&
    legacyHouseBest.rateCostAmount === 10.55 &&
    (legacyHouseBest as any).houseRateAmount === 10.55,
  legacyHouseBest,
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
  'order financial redaction hides House Rate/internal cost from non-financial viewers',
  redactedOrder.bestRateWorkflow.money === null &&
    redactedOrder.shipping.houseRateAmount === null &&
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
  'rate-browser redaction hides House Rate/internal cost from non-financial viewers',
  redactedBrowse.bestRate.carrier_code === 'ups' &&
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
  'billing charges customer Selected Rate, not House Rate',
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
  'invoice CSV carries customer shipping amount and no House Rate/internal column',
  invoiceCsv.includes('14.25') && !/House Rate|houseRateAmount|10\.55/.test(invoiceCsv),
  invoiceCsv,
);

const rateMoneySrc = read('src/services/shipping-workflow/rate-money.ts');
check(
  'backend money owner declares PS-334 House Rate field',
  /houseRateAmount/.test(rateMoneySrc) && /houseRateAmount:\s*number\s*\|\s*null/.test(rateMoneySrc),
);

const houseStampSrc = read('src/services/shipping-workflow/house-tuple-stamp.ts');
check(
  'house stamp persists House Rate amount from internal cost owner',
  /houseRateAmount:\s*drpCost/.test(houseStampSrc) && /house_rate_amount:\s*drpCost/.test(houseStampSrc),
);

const columnsSrc = read('web/src/components/Views/orders-table-columns.ts');
check(
  'Orders table registers a House Rate column for Awaiting/Shipped',
  /'houserate'/.test(columnsSrc) &&
    /\{ key: 'houserate', label: 'House Rate'/.test(columnsSrc) &&
    /hidden\.add\('houserate'\)/.test(columnsSrc) &&
    /case 'houserate':[\s\S]*?houseRateAmount/.test(columnsSrc),
);

const rowDisplaySrc = read('web/src/components/Views/orders-row-display.tsx');
check(
  'FE money getter passes through backend House Rate without recomputing',
  /houseRateAmount: toNumberValue\(money\.houseRateAmount\)/.test(rowDisplaySrc),
);

const rateCellsSrc = read('web/src/components/Views/orders-rate-cells.tsx');
check(
  'House Rate cell renders only backend houseRateAmount',
  /export function renderHouseRateCell/.test(rateCellsSrc) &&
    /getBackendRowMoney\(order\)\?\.houseRateAmount/.test(rateCellsSrc) &&
    !/houseRateAmount\s*[-+*/]\s/.test(rateCellsSrc),
);

const ordersViewSrc = read('web/src/components/Views/OrdersView.tsx');
check(
  'OrdersView delegates House Rate cell rendering',
  /case 'houserate':\s*\n\s*return renderHouseRateCell\(order\)/.test(ordersViewSrc),
);

const packageJson = read('package.json');
check(
  'package exposes PS-334 guard',
  /"test:ps-334-house-rate-column"\s*:\s*"tsx scripts\/ps-334-house-rate-column-guard\.ts"/.test(packageJson),
);

if (failures > 0) {
  console.error(`\nFAIL PS-334 House Rate column guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-334 House Rate column guard');
