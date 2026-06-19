/**
 * PS-295 guard - SHIPP House shipped tuple + billing customer_rate proof.
 *
 * This is the dedicated proof for the live-regression tail of PS-220/PS-292:
 * a SHIPP house label freezes customer_rate in the sidecar, shipped rows show
 * that customer_rate over DRP cost, and billing/invoice/export surfaces bill
 * customer_rate instead of the SHIPP drp_cost.
 *
 * It is intentionally separate from ps-295-rate-browser-speed-diagnostics; that
 * Browse Rates guard does not prove shipped DTO/UI or billing customer_rate.
 *
 *   npx tsx scripts/ps-295-house-customer-rate-proof-guard.ts
 */
import { readFileSync } from 'node:fs';
import { normalizeOrderBestRateDto } from '../src/services/order-rate-dto';
import {
  houseMarginFromProjection,
  planRealizedHouseCapture,
} from '../src/services/shipping-workflow/house-margin-capture';
import { houseMarkedAmountForRow } from '../src/services/shipping-workflow/house-row-marked-amount';
import { buildOrderRowMoneyDisplay } from '../src/services/shipping-workflow/rate-money';
import { decideShippingLineBilling } from '../src/services/billing-shipping-line';
import { computeBillingDetailMetrics } from '../web/src/components/Views/billing-parity';
import { renderInvoiceCsvRow } from '../src/routes/billing-invoice-csv';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` - ${detail}` : ''}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

function centsEqual(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) < 0.005;
}

const pkg = readFileSync('package.json', 'utf8');
check(
  'package.json exposes the dedicated PS-295 House customer_rate guard',
  /"test:ps-295-house-customer-rate-proof"\s*:\s*"tsx scripts\/ps-295-house-customer-rate-proof-guard\.ts"/.test(pkg),
);
check(
  'the old PS-295 Browse Rates diagnostics guard still exists but is not the House proof',
  /"test:ps-295-rate-browser-speed-diagnostics"\s*:/.test(pkg),
);

const projectedHouseBest = normalizeOrderBestRateDto({
  provider: 'shipp',
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
    providerAccountId: 442007,
    competitorCount: 2,
  },
  houseMargin: 1.14,
});

const realized = houseMarginFromProjection(projectedHouseBest, 8.5);
check(
  'sidecar planner freezes customer_rate 9.64 from projected next-best over drp_cost 8.50',
  realized?.customerRate === 9.64 && realized.margin === 1.14 && realized.competitorCount === 2,
  JSON.stringify(realized),
);
check(
  'realized writer gate only opens for opted-in valid-cost house stamps',
  JSON.stringify(planRealizedHouseCapture({ drpCost: 8.5, optedIn: true, best: projectedHouseBest })) ===
    JSON.stringify(realized) &&
    planRealizedHouseCapture({ drpCost: 8.5, optedIn: false, best: projectedHouseBest }) === null,
);

const shippedMarked = houseMarkedAmountForRow({
  isAwaiting: false,
  projectedNextBestTotalCost: null,
  realizedCustomerRate: realized?.customerRate ?? null,
});
check('shipped rows read realized customer_rate, not projected awaiting stamp', shippedMarked === 9.64);

const shippedMoney = buildOrderRowMoneyDisplay({
  isAwaiting: false,
  bestRateBaseAmount: null,
  selectedRateBaseAmount: 8.5,
  labelFinalCost: 8.5,
  markupRule: { type: 'percent', value: 50 } as never,
  insuranceAddOn: null,
  houseMarkedAmount: shippedMarked,
});
check(
  'shipped DTO money tuple shows customer_rate over SHIPP drp_cost and suppresses carrier markup',
  shippedMoney?.markupSource === 'house_account' &&
    shippedMoney.source === 'selected_rate' &&
    shippedMoney.baseAmount === 8.5 &&
    shippedMoney.markedAmount === 9.64 &&
    shippedMoney.markupAmount === 1.14,
  JSON.stringify(shippedMoney),
);

const billingDecision = decideShippingLineBilling({
  labelCost: 8.5,
  houseCustomerRate: 9.64,
  billingMode: 'label_cost',
  isBaselineCarrier: false,
  refUspsRate: 7,
  refUpsRate: 7.5,
  shippingMarkupPct: 50,
  shippingMarkupFlat: 2,
});
check(
  'billing decision bills customer_rate exactly and ignores ref-rate + carrier markup',
  billingDecision.billedAmount === 9.64 &&
    billingDecision.source === 'house_customer_rate' &&
    billingDecision.markupApplied === false &&
    billingDecision.descriptionSuffix === '',
  JSON.stringify(billingDecision),
);

const detailMetrics = computeBillingDetailMetrics({
  lineType: 'shipping',
  totalCost: '9.64',
  actualLabelCost: 8.5,
  orderNumber: 'PS-295-HOUSE',
});
check(
  'billing detail metrics display billed shipping as customer_rate and margin as spread',
  centsEqual(detailMetrics.shipping, 9.64) &&
    centsEqual(detailMetrics.ourCost, 8.5) &&
    centsEqual(detailMetrics.margin, 1.14),
  JSON.stringify(detailMetrics),
);

const csvRow = renderInvoiceCsvRow({
  order_id: 295,
  order_number: 'PS-295-HOUSE',
  ship_date: '2026-06-19',
  base_qty: '1',
  addl_qty: '0',
  pickpack_amt: '0',
  additional_amt: '0',
  shipping_amt: '9.64',
  storage_amt: '0',
  row_total: '9.64',
  skus: 'HU-10',
  package_cost_amt: '0',
  box_label: '12x10x3',
  box_review: false,
  fee_waived: false,
});
const csvCells = csvRow.split(',');
check(
  'invoice CSV row consumes the same shipping_amt customer_rate value',
  csvCells[8] === '9.64' && csvCells[10] === '9.64',
  csvRow,
);

const labelsSrc = readFileSync('src/services/labels.ts', 'utf8');
check(
  'label purchase captures realized House sidecar after committed SHIPP label transaction',
  /await timer\.task\('markOrderShipped'[\s\S]*?if \(directProviderKey === 'shipp'\) \{[\s\S]*?captureRealizedHouseMargin\(\{[\s\S]*?shipmentId: localShipmentId,[\s\S]*?drpCost: Number\(created\.cost \?\? 0\)/.test(labelsSrc),
);

const captureSrc = readFileSync('src/services/shipping-workflow/house-margin-capture.ts', 'utf8');
check(
  'realized capture writes only the sidecar and never updates locked shipments',
  /INSERT INTO order_competitive_rate/.test(captureSrc) && !/UPDATE\s+shipments/i.test(captureSrc),
);

const ordersSrc = readFileSync('src/routes/orders.ts', 'utf8');
check(
  'shipped DTO bulk-loads realized customer_rate by order id for financial shipped rows only',
  /const houseRealizedByOrderId = new Map<number, \{ customerRate: number; drpCost: number \| null \}>/.test(ordersSrc) &&
    /canViewFinancials && joined\.some\(\(r\) => r\.order\.orderStatus === 'shipped'\)/.test(ordersSrc) &&
    /orderCompetitiveRate\.isHouseOrder/.test(ordersSrc) &&
    /inArray\(orderCompetitiveRate\.orderId, shippedOrderIds\)/.test(ordersSrc),
);
check(
  'shipped DTO feeds realized customer_rate into the backend money tuple',
  /houseMarkedAmount: realizedHouse\.customerRate/.test(ordersSrc) &&
    /labelFinalCost: labelCost \?\? realizedHouse\.drpCost/.test(ordersSrc) &&
    /markupRule: null, \/\/ house: the margin IS the markup; no carrier markup applied/.test(ordersSrc),
);

const ordersViewSrc = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
check(
  'shipped Orders UI renders House badge and selected-rate tuple only from backend money',
  /shippedBackendMoney\.markupSource === 'house_account'[\s\S]*?renderHouseBadge\(\)/.test(ordersViewSrc) &&
    /shippedMoney\?\.markupSource === 'house_account'/.test(ordersViewSrc),
);

const billingSrc = readFileSync('src/services/billing.ts', 'utf8');
check(
  'billing generator loads customer_rate from sidecar by shipment id',
  /houseCustomerRateByShipmentId/.test(billingSrc) &&
    /\.select\(\{ shipmentId: orderCompetitiveRate\.shipmentId, customerRate: orderCompetitiveRate\.customerRate \}\)/.test(billingSrc) &&
    /inArray\(orderCompetitiveRate\.shipmentId, houseShipmentIds\)/.test(billingSrc),
);
check(
  'billing generator persists customer_rate as the shipping line unit/total cost',
  /const houseCustomerRate = s\.id != null \? houseCustomerRateByShipmentId\.get\(Number\(s\.id\)\) : undefined/.test(billingSrc) &&
    /houseCustomerRate,/.test(billingSrc) &&
    /unitCost: shippingDecision\.billedAmount\.toFixed\(2\)/.test(billingSrc) &&
    /totalCost: shippingDecision\.billedAmount\.toFixed\(2\)/.test(billingSrc),
);
check(
  'billing details expose billed customer_rate and actual SHIPP cost for margin review',
  /unitCost: billingLineItems\.unitCost/.test(billingSrc) &&
    /totalCost: billingLineItems\.totalCost/.test(billingSrc) &&
    /actualLabelCost: isShippingLine \? labelCost : null/.test(billingSrc),
);

const billingRouteSrc = readFileSync('src/routes/billing.ts', 'utf8');
check(
  'invoice data aggregates the generated shipping line items without recomputing provider cost',
  /case when b\.line_type = 'shipping' then b\.total_cost else 0 end\), 0\)::text as shipping_amt/.test(billingRouteSrc) &&
    /const csv = renderInvoiceCsv\(data\.details\)/.test(billingRouteSrc),
);
check(
  'HTML and XLSX invoice renderers consume shipping_amt from billingInvoiceData',
  /const shippingAmt = Number\(d\.shipping_amt\)/.test(billingRouteSrc) &&
    /<td class="num">\$\{shippingAmt > 0 \? fmt\(shippingAmt\) :/.test(billingRouteSrc) &&
    /shipping: shippingAmt,/.test(billingRouteSrc),
);

if (failures > 0) {
  console.error(`\nFAIL PS-295 House customer_rate proof guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-295 House customer_rate proof guard');
