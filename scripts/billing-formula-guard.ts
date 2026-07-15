import { readFileSync } from 'node:fs';
import {
  BILLING_DETAIL_COLUMNS,
  buildBillingSummaryTotals,
  computeBillingDetailMetrics,
} from '../web/src/components/Views/billing-parity';
import { resolveBillingPresetWindow } from '../src/services/reporting-window-presets';

function fail(message: string): never {
  throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    fail(`${message}: expected ${expected}, got ${actual}`);
  }
  console.log(`PASS ${message}`);
}

// PS-369: the FE fee calculators (calculateBillingPickPackFee /
// calculateBillingFulfillmentFee) are DELETED — the backend generator owns the
// fee math and emits pickPackFeeTotal / fulfillmentFeeTotal on every summary and
// detail row (typed since PS-368). The FE displays backend totals verbatim.
const parity = readFileSync('web/src/components/Views/billing-parity.ts', 'utf8');
assertEqual(
  /calculateBillingPickPackFee\s*\(|calculateBillingFulfillmentFee\s*\(/.test(parity.replace(/\/\/[^\n]*/g, '')),
  false,
  'PS-369: no FE fee recompute remains in billing-parity (calculators deleted)',
);
assertEqual(
  /export function aggregateBillingDetailRowsByOrder/.test(parity),
  false,
  'PS-369: dead FE aggregator twin (aggregateBillingDetailRowsByOrder) is deleted',
);

const summaryTotals = buildBillingSummaryTotals([
  {
    clientId: 1,
    clientName: 'Heritage Kids Press',
    orderCount: 1,
    pickPackTotal: 2.5,
    additionalTotal: 1.5,
    pickPackFeeTotal: 4,
    packageTotal: 1.25,
    storageTotal: 0.4,
    shippingTotal: 5.97,
    fulfillmentFeeTotal: 11.62,
    grandTotal: 11.62,
  },
] as any);

assertEqual(summaryTotals.pickPackFee, 4, 'summary displays the backend pickPackFeeTotal verbatim');
assertEqual(summaryTotals.fulfillmentFee, 11.62, 'summary displays the backend fulfillmentFeeTotal verbatim');

const detailMetrics = computeBillingDetailMetrics({
  pickpackTotal: 2.5,
  additionalTotal: 1.5,
  pickPackFeeTotal: 4,
  packageTotal: 1.25,
  storageTotal: 0.4,
  shippingTotal: 5.97,
  fulfillmentFeeTotal: 11.62,
} as any);

assertEqual(detailMetrics.pickPackFee, 4, 'detail metrics display the backend pickPackFeeTotal verbatim');
assertEqual(detailMetrics.fulfillmentFee, 11.62, 'detail metrics display the backend fulfillmentFeeTotal verbatim');

// PS-369: a row WITHOUT backend fee totals renders 0 — the FE must not silently
// re-derive money (a zero is visible/diagnosable; a recomputed number would hide
// a backend regression).
const bareMetrics = computeBillingDetailMetrics({
  pickpackTotal: 2.5,
  additionalTotal: 1.5,
  packageTotal: 1.25,
  storageTotal: 0.4,
  shippingTotal: 5.97,
} as any);
assertEqual(bareMetrics.pickPackFee, 0, 'missing backend pickPackFeeTotal is NOT recomputed in the FE');
assertEqual(bareMetrics.fulfillmentFee, 0, 'missing backend fulfillmentFeeTotal is NOT recomputed in the FE');

const totalColumn = BILLING_DETAIL_COLUMNS.find((column) => column.id === 'total');
assertEqual(totalColumn?.label, 'Fulfillment Fee', 'detail total column is labeled Fulfillment Fee');

const localJulyFirst = new Date('2026-07-01T08:05:00.000Z');
assertEqual(resolveBillingPresetWindow('this_month', localJulyFirst).from, '2026-07-01', 'this month preset uses the backend California calendar day');
assertEqual(resolveBillingPresetWindow('this_month', localJulyFirst).to, '2026-07-31', 'this month preset ends on backend calendar month end');
assertEqual(resolveBillingPresetWindow('last_30', localJulyFirst).from, '2026-06-02', 'last 30 days is exactly 30 inclusive calendar days');
assertEqual(resolveBillingPresetWindow('last_90', localJulyFirst).from, '2026-04-03', 'last 90 days is exactly 90 inclusive calendar days');

const billingRoute = readFileSync('src/routes/billing.ts', 'utf8');
const billingService = readFileSync('src/services/billing.ts', 'utf8');
const marginService = readFileSync('src/services/shipping-margin-analytics.ts', 'utf8');
const billingView = readFileSync('web/src/components/Views/BillingView.tsx', 'utf8');
assertEqual(billingRoute.includes('clientIds: z.string().optional()'), true, 'billing routes accept multi-client filter');
assertEqual(billingService.includes('c.id = any(${intArraySql(selectedClientIds)})'), true, 'billing summary applies selected client IDs in SQL');
assertEqual(marginService.includes('coalesce(bli.client_id, ${shipments.clientId}) = any(${intArraySql(selectedClientIds)})'), true, 'shipping margin applies selected client IDs in SQL');
assertEqual(billingView.includes('apiClient.fetchBillingSummary(from, to, billingClientQueryIds)'), true, 'BillingView summary fetch uses active client filter');
assertEqual(billingView.includes('apiClient.fetchShippingMarginAnalytics(from, to, billingClientQueryIds)'), true, 'BillingView margin fetch uses active client filter');
