/**
 * PS-296 guard — shipping-margin breakdown + exception metrics.
 *
 * Proves the analytics builder now produces (a) a carrier/service/account rollup, (b)
 * negative-margin count + total, and (c) average label cost + average billable shipping,
 * in addition to the existing client rollup. Pure/offline: builds rows in-memory and
 * asserts the aggregation; no DB, no network, no billing regeneration, no shipped writes.
 */
import {
  buildShippingMarginRow,
  buildShippingMarginAnalytics,
  type ShippingMarginInputRow,
} from '../src/services/shipping-margin-analytics';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function input(over: Partial<ShippingMarginInputRow>): ShippingMarginInputRow {
  return {
    clientId: 1,
    clientName: 'Acme',
    shipmentId: 100,
    orderId: 200,
    orderNumber: 'A-1',
    shipDate: '2026-06-20T00:00:00.000Z',
    shipmentCost: null,
    shipmentLabelCost: null,
    shipmentOtherCost: null,
    billingLineItemId: null,
    billingTotalCost: null,
    projectedBillableAmount: null,
    projectedBillableSource: null,
    houseCustomerRate: null,
    carrierCode: null,
    serviceCode: null,
    providerAccountId: null,
    providerAccountNickname: null,
    ...over,
  };
}

// Row A: UPS/ground/acct1 — actual 10, billable 15 → +5
// Row B: UPS/ground/acct1 — actual 10, billable 8  → -2 (negative-margin exception)
// Row C: USPS/priority/acct2 — actual 5, billable 12 → +7
const rows = [
  buildShippingMarginRow(input({ shipmentId: 1, billingLineItemId: 11, shipmentCost: 10, billingTotalCost: 15, carrierCode: 'ups', serviceCode: 'ups_ground', providerAccountId: 1, providerAccountNickname: 'UPS Main' })),
  buildShippingMarginRow(input({ shipmentId: 2, billingLineItemId: 12, shipmentCost: 10, billingTotalCost: 8, carrierCode: 'ups', serviceCode: 'ups_ground', providerAccountId: 1, providerAccountNickname: 'UPS Main' })),
  buildShippingMarginRow(input({ shipmentId: 3, billingLineItemId: 13, shipmentCost: 5, billingTotalCost: 12, carrierCode: 'usps', serviceCode: 'usps_priority', providerAccountId: 2, providerAccountNickname: 'USPS A' })),
];

const a = buildShippingMarginAnalytics(rows, { dateFrom: '2026-06-01', dateTo: '2026-07-01' });

// Summary totals.
check('summary marginRowCount=3', a.summary.marginRowCount === 3, a.summary);
check('summary marginTotal=10', a.summary.marginTotal === 10, a.summary.marginTotal);
check('summary actualShippingTotal=25', a.summary.actualShippingTotal === 25, a.summary.actualShippingTotal);
check('summary billableShippingTotal=35', a.summary.billableShippingTotal === 35, a.summary.billableShippingTotal);

// Negative-margin exception metrics.
check('summary negativeMarginCount=1', a.summary.negativeMarginCount === 1, a.summary.negativeMarginCount);
check('summary negativeMarginTotal=-2', a.summary.negativeMarginTotal === -2, a.summary.negativeMarginTotal);

// Averages over the 3 margin rows.
check('summary averageActualShippingCost≈8.33', a.summary.averageActualShippingCost === 8.33, a.summary.averageActualShippingCost);
check('summary averageBillableShipping≈11.67', a.summary.averageBillableShipping === 11.67, a.summary.averageBillableShipping);

// Carrier/service/account breakdown.
check('carriers has 2 groups', a.carriers.length === 2, a.carriers.map((cs) => `${cs.carrierCode}/${cs.serviceCode}/${cs.providerAccountId}`));
const ups = a.carriers.find((cs) => cs.carrierCode === 'ups' && cs.providerAccountId === 1);
const usps = a.carriers.find((cs) => cs.carrierCode === 'usps' && cs.providerAccountId === 2);
check('ups group rolls up 2 rows, margin +3, 1 negative',
  !!ups && ups.marginRowCount === 2 && ups.marginTotal === 3 && ups.negativeMarginCount === 1, ups);
check('usps group rolls up 1 row, margin +7, 0 negative',
  !!usps && usps.marginRowCount === 1 && usps.marginTotal === 7 && usps.negativeMarginCount === 0, usps);
check('ups group carries account nickname', ups?.providerAccountNickname === 'UPS Main', ups);
check('carriers sorted by marginTotal desc (usps first)', a.carriers[0]?.carrierCode === 'usps', a.carriers[0]);

// Row identity passthrough.
check('rows carry carrier/service/account identity',
  a.rows[0]?.carrierCode === 'ups' && a.rows[0]?.serviceCode === 'ups_ground' && a.rows[0]?.providerAccountId === 1, a.rows[0]);

if (failures > 0) {
  console.error(`\nPS-296 margin breakdown guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-296 margin breakdown guard passed.');
