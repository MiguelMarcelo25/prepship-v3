import {
  BILLING_DETAIL_COLUMNS,
  buildBillingSummaryTotals,
  calculateBillingFulfillmentFee,
  calculateBillingPickPackFee,
  computeBillingDetailMetrics,
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
