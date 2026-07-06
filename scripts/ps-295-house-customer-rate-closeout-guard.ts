/**
 * PS-295 closeout guard - SHIPP House customer_rate Final Review packet.
 *
 * This ties the dedicated customer_rate proof to a conservative status artifact:
 * Final Review-ready at 91%, still not 100% until a read-only production canary
 * confirms one shipped House row and its billing/export output.
 */
import { existsSync, readFileSync } from 'node:fs';
import { decideShippingLineBilling } from '../src/services/billing-shipping-line';
import { renderInvoiceCsvRow } from '../src/routes/billing-invoice-csv';
import { computeBillingDetailMetrics } from '../web/src/components/Views/billing-parity';
import {
  houseMarginFromProjection,
  planRealizedHouseCapture,
} from '../src/services/shipping-workflow/house-margin-capture';
import { houseMarkedAmountForRow } from '../src/services/shipping-workflow/house-row-marked-amount';
import { buildOrderRowMoneyDisplay } from '../src/services/shipping-workflow/rate-money';
import { normalizeOrderBestRateDto } from '../src/services/order-rate-dto';

let failures = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` - ${detail}` : ''}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function hasScript(pkg: string, script: string, target: string): boolean {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`"${script}"\\s*:\\s*"${escaped}"`).test(pkg);
}

function centsEqual(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) < 0.005;
}

const packageJson = read('package.json');
const statusDoc = read('docs/ps-tickets/ps-295-house-customer-rate-proof-status.md');
const ps220 = read('scripts/ps-220-house-margin-guard.ts');
const ps292 = read('scripts/ps-292-house-tuple-display-guard.ts');
const ps292Closeout = read('scripts/ps-292-final-review-closeout-guard.ts');
const ps295 = read('scripts/ps-295-house-customer-rate-proof-guard.ts');
const captureSrc = read('src/services/shipping-workflow/house-margin-capture.ts');
const billingSrc = read('src/services/billing.ts');
const billingRouteSrc = read('src/routes/billing.ts');

check('package exposes the PS-295 House customer_rate proof guard',
  hasScript(packageJson, 'test:ps-295-house-customer-rate-proof', 'tsx scripts/ps-295-house-customer-rate-proof-guard.ts'));
check('package exposes this PS-295 closeout guard',
  hasScript(packageJson, 'test:ps-295-house-customer-rate-closeout', 'tsx scripts/ps-295-house-customer-rate-closeout-guard.ts'));
check('package keeps the upstream PS-220/PS-292 guards wired',
  hasScript(packageJson, 'test:ps-220-house-margin', 'tsx scripts/ps-220-house-margin-guard.ts') &&
    hasScript(packageJson, 'test:ps-292-house-tuple-display', 'tsx scripts/ps-292-house-tuple-display-guard.ts') &&
    hasScript(packageJson, 'test:ps-292-final-review-closeout', 'tsx scripts/ps-292-final-review-closeout-guard.ts'));

check('status doc exists and records PS-295 at 91%',
  /Current completion estimate: PS-295 91%/.test(statusDoc));
check('status doc recommends Final Review but not 100%',
  /Final Review-ready/.test(statusDoc) &&
    /not a claim of 100% production completion/.test(statusDoc));
check('status doc lists proof and closeout commands',
  [
    'test:ps-220-house-margin',
    'test:ps-292-house-tuple-display',
    'test:ps-292-final-review-closeout',
    'test:ps-295-house-customer-rate-proof',
    'test:ps-295-house-customer-rate-closeout',
  ].every((command) => statusDoc.includes(`\`${command}\``)));
check('status doc keeps Trello mutation behind task update',
  /Trello move\/comment only after explicit `task update`/.test(statusDoc));
check('status doc documents offline-only safety',
  /offline-only/.test(statusDoc) &&
    /does not run live labels/.test(statusDoc) &&
    /mutate[\s\S]*shipped\/cancelled data/.test(statusDoc));

check('PS-220 and PS-292 proofs remain the upstream source of truth',
  /billing decision \(house\): bills customer_rate/.test(ps220) &&
    /item3: realized two-tier/.test(ps292) &&
    /PS-295 owns live shipped\/billing canary proof/.test(ps292Closeout));
check('PS-295 proof guard owns sidecar through invoice evidence',
  /sidecar planner freezes customer_rate/.test(ps295) &&
    /shipped DTO money tuple/.test(ps295) &&
    /billing generator loads customer_rate from sidecar/.test(ps295) &&
    /invoice data aggregates the generated shipping line items/.test(ps295));
check('PS-295 proof stays separate from Browse Rates speed diagnostics',
  /intentionally separate from ps-295-rate-browser-speed-diagnostics/.test(ps295) &&
    /old PS-295 Browse Rates diagnostics guard still exists but is not the House proof/.test(ps295));

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
check('closeout behavior freezes customer_rate from projected competitor over DRP cost',
  realized?.customerRate === 9.64 &&
    realized.margin === 1.14 &&
    realized.competitorCount === 2,
  JSON.stringify(realized));
check('closeout behavior keeps realized writer gated by client opt-in',
  JSON.stringify(planRealizedHouseCapture({ drpCost: 8.5, optedIn: true, best: projectedHouseBest })) ===
    JSON.stringify(realized) &&
    planRealizedHouseCapture({ drpCost: 8.5, optedIn: false, best: projectedHouseBest }) === null);

const shippedMarked = houseMarkedAmountForRow({
  isAwaiting: false,
  projectedNextBestTotalCost: null,
  realizedCustomerRate: realized?.customerRate ?? null,
});
const shippedMoney = buildOrderRowMoneyDisplay({
  isAwaiting: false,
  bestRateBaseAmount: null,
  selectedRateBaseAmount: 8.5,
  labelFinalCost: 8.5,
  markupRule: { type: 'percent', value: 50 } as never,
  insuranceAddOn: null,
  houseMarkedAmount: shippedMarked,
});
check('closeout behavior displays shipped House customer_rate over SHIPP DRP cost',
  shippedMarked === 9.64 &&
    shippedMoney?.markupSource === 'house_account' &&
    shippedMoney.baseAmount === 8.5 &&
    shippedMoney.markedAmount === 9.64 &&
    shippedMoney.markupAmount === 1.14,
  JSON.stringify(shippedMoney));

const billingDecision = decideShippingLineBilling({
  labelCost: 8.5,
  houseCustomerRate: realized?.customerRate ?? null,
  billingMode: 'label_cost',
  isBaselineCarrier: false,
  refUspsRate: 7,
  refUpsRate: 7.5,
  shippingMarkupPct: 50,
  shippingMarkupFlat: 2,
});
check('closeout behavior bills customer_rate exactly with no carrier markup',
  billingDecision.billedAmount === 9.64 &&
    billingDecision.source === 'house_customer_rate' &&
    billingDecision.markupApplied === false,
  JSON.stringify(billingDecision));

const detailMetrics = computeBillingDetailMetrics({
  lineType: 'shipping',
  totalCost: '9.64',
  actualLabelCost: 8.5,
  orderNumber: 'PS-295-HOUSE-CLOSEOUT',
});
check('closeout behavior billing detail margin is customer_rate minus DRP cost',
  centsEqual(detailMetrics.shipping, 9.64) &&
    centsEqual(detailMetrics.ourCost, 8.5) &&
    centsEqual(detailMetrics.margin, 1.14),
  JSON.stringify(detailMetrics));

const csvCells = renderInvoiceCsvRow({
  order_id: 295,
  order_number: 'PS-295-HOUSE-CLOSEOUT',
  ship_date: '2026-06-22',
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
}).split(',');
check('closeout behavior invoice CSV consumes generated shipping_amt',
  csvCells[9] === '9.64' && csvCells[11] === '9.64',
  csvCells.join('|'));

check('realized capture writes sidecar only, not locked shipments',
  /INSERT INTO order_competitive_rate/.test(captureSrc) && !/UPDATE\s+shipments/i.test(captureSrc));
check('billing generator reads customer_rate by shipment id and persists it as the shipping line',
  /houseCustomerRateByShipmentId/.test(billingSrc) &&
    /houseCustomerRate,/.test(billingSrc) &&
    /unitCost: shippingDecision\.billedAmount\.toFixed\(2\)/.test(billingSrc) &&
    /totalCost: shippingDecision\.billedAmount\.toFixed\(2\)/.test(billingSrc));
check('invoice renderers consume generated shipping_amt instead of provider cost',
  /case when b\.line_type = 'shipping' then b\.total_cost else 0 end\), 0\)::text as shipping_amt/.test(billingRouteSrc) &&
    /const shippingAmt = Number\(d\.shipping_amt\)/.test(billingRouteSrc) &&
    /shipping: shippingAmt,/.test(billingRouteSrc));

const closeoutStatus = {
  card: 'PS-295',
  completion: 91,
  recommendation: 'Final Review',
  blocker: 'None for code/test proof; read-only production canary remains before 100%.',
  trelloAction: 'recommend-only',
  safety: 'No live labels, postage, queue mutation, marketplace notification, production order mutation, or shipped/cancelled data mutation.',
} as const;

check('closeout status recommends PS-295 Final Review',
  closeoutStatus.card === 'PS-295' &&
    closeoutStatus.completion >= 89 &&
    closeoutStatus.recommendation === 'Final Review');
check('closeout status does not call PS-295 100%',
  /before 100%/.test(closeoutStatus.blocker));
check('closeout status leaves Trello mutation to explicit approval',
  closeoutStatus.trelloAction === 'recommend-only');
check('closeout status documents no live side effects',
  /No live labels/.test(closeoutStatus.safety) &&
    /shipped\/cancelled data mutation/.test(closeoutStatus.safety));

if (failures > 0) {
  console.error(`\nFAIL PS-295 House customer_rate closeout guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-295 House customer_rate closeout guard');
