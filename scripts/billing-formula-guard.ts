import { readFileSync } from 'node:fs';
import {
  BILLING_DETAIL_COLUMNS,
  buildBillingSummaryTotals,
  calculateBillingFulfillmentFee,
  calculateBillingPickPackFee,
  computeBillingDetailMetrics,
  getBillingInitialRange,
  getBillingPresetRange,
} from '../web/src/components/Views/billing-parity';

function fail(message: string): never {
  throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    fail(`${message}: expected ${expected}, got ${actual}`);
  }
  console.log(`PASS ${message}`);
}

assertEqual(
  calculateBillingPickPackFee({
    baseFee: 2.5,
    additionalUnitFee: 0.5,
    quantity: 4,
    includedUnits: 1,
  }),
  4,
  'pick/pack uses client base + (quantity - included units) * addl unit',
);

assertEqual(
  calculateBillingFulfillmentFee({
    shippingCharge: 5.97,
    pickPackFee: 4,
    boxFee: 1.25,
    storageFee: 0.4,
  }),
  11.62,
  'fulfillment fee uses shipping + pick/pack + box + storage',
);

const summaryTotals = buildBillingSummaryTotals([
  {
    clientId: 1,
    clientName: 'Heritage Kids Press',
    orderCount: 1,
    pickPackTotal: 2.5,
    additionalTotal: 1.5,
    packageTotal: 1.25,
    storageTotal: 0.4,
    shippingTotal: 5.97,
    grandTotal: 11.62,
  },
] as any);

assertEqual(summaryTotals.pickPackFee, 4, 'summary exposes combined pick/pack fee');
assertEqual(summaryTotals.fulfillmentFee, 11.62, 'summary exposes fulfillment fee formula');

const detailMetrics = computeBillingDetailMetrics({
  pickpackTotal: 2.5,
  additionalTotal: 1.5,
  packageTotal: 1.25,
  storageTotal: 0.4,
  shippingTotal: 5.97,
} as any);

assertEqual(detailMetrics.pickPackFee, 4, 'detail metrics expose combined pick/pack fee');
assertEqual(detailMetrics.fulfillmentFee, 11.62, 'detail metrics expose fulfillment fee formula');

const totalColumn = BILLING_DETAIL_COLUMNS.find((column) => column.id === 'total');
assertEqual(totalColumn?.label, 'Fulfillment Fee', 'detail total column is labeled Fulfillment Fee');

const localJulyFirst = new Date(2026, 6, 1, 0, 5, 0);
assertEqual(getBillingPresetRange('this_month', localJulyFirst).from, '2026-07-01', 'this month preset uses local calendar day without UTC backshift');
assertEqual(getBillingPresetRange('this_month', localJulyFirst).to, '2026-07-31', 'this month preset ends on local calendar month end');
assertEqual(getBillingPresetRange('last_30', localJulyFirst).from, '2026-06-02', 'last 30 days is exactly 30 inclusive calendar days');
assertEqual(getBillingPresetRange('last_90', localJulyFirst).from, '2026-04-03', 'last 90 days is exactly 90 inclusive calendar days');
assertEqual(getBillingInitialRange(localJulyFirst).from, '2026-06-02', 'initial billing range matches Last 30 Days preset');

const billingRoute = readFileSync('src/routes/billing.ts', 'utf8');
const billingService = readFileSync('src/services/billing.ts', 'utf8');
const marginService = readFileSync('src/services/shipping-margin-analytics.ts', 'utf8');
const billingView = readFileSync('web/src/components/Views/BillingView.tsx', 'utf8');
assertEqual(billingRoute.includes('clientIds: z.string().optional()'), true, 'billing routes accept multi-client filter');
assertEqual(billingService.includes('c.id = any(${intArraySql(selectedClientIds)})'), true, 'billing summary applies selected client IDs in SQL');
assertEqual(marginService.includes('coalesce(bli.client_id, ${shipments.clientId}) = any(${intArraySql(selectedClientIds)})'), true, 'shipping margin applies selected client IDs in SQL');
assertEqual(billingView.includes('apiClient.fetchBillingSummary(from, to, billingClientQueryIds)'), true, 'BillingView summary fetch uses active client filter');
assertEqual(billingView.includes('apiClient.fetchShippingMarginAnalytics(from, to, billingClientQueryIds)'), true, 'BillingView margin fetch uses active client filter');
