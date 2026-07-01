/**
 * PS-362 - Billing detail SOT rows + Excel-safe SKU exports.
 *
 * Offline guard. It proves the billing detail screen no longer depends on a
 * frontend raw-line merge or a 2000-line API cap, and that SKU quantity strings
 * are safe/readable in Excel exports.
 */
import { readFileSync } from 'node:fs';
import { toBillingDetailOrderRows } from '../src/services/billing-detail-row-sot';
import { summarizeBillingItemsForDetail } from '../src/services/billing-detail-utils';
import { renderInvoiceCsv, type InvoiceCsvDetailRow } from '../src/routes/billing-invoice-csv';

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

const detailRows = toBillingDetailOrderRows([
  {
    id: 1,
    orderId: 100,
    orderNumber: 'PS362-A',
    lineType: 'pick_pack',
    totalCost: '2.50',
    itemSkus: 'HU-10 x2',
    totalQty: 2,
  },
  {
    id: 2,
    orderId: 100,
    orderNumber: 'PS362-A',
    lineType: 'additional_unit',
    totalCost: '1.25',
  },
  {
    id: 3,
    orderId: 100,
    orderNumber: 'PS362-A',
    lineType: 'package_cost',
    totalCost: '0.75',
    packageName: '12x10x3',
  },
  {
    id: 4,
    orderId: 100,
    orderNumber: 'PS362-A',
    lineType: 'shipping',
    totalCost: '8.00',
    actualLabelCost: 7,
    carrierNickname: 'USPS Chase x7439',
    shippingZeroNeedsReview: true,
  },
]);

check('backend detail SOT collapses raw fee lines into one order row', detailRows.length === 1);
check('backend order row keeps pick/pack, addl, box, and shipping totals',
  detailRows[0]?.pickpackTotal === 2.5 &&
  detailRows[0]?.additionalTotal === 1.25 &&
  detailRows[0]?.packageTotal === 0.75 &&
  detailRows[0]?.shippingTotal === 8);
check('backend order row carries rich shipping fields and review flags',
  detailRows[0]?.actualLabelCost === 7 &&
  detailRows[0]?.carrierNickname === 'USPS Chase x7439' &&
  detailRows[0]?.shippingZeroNeedsReview === true);

const skuSummary = summarizeBillingItemsForDetail([
  { sku: 'Booster-gel-001', name: 'Booster Gel', quantity: 2 },
  { sku: 'HU-10', name: 'Leeds Line V2', quantity: 1 },
]);
check('SKU summary uses Excel-safe ASCII xN quantity suffix',
  skuSummary.itemSkus === 'Booster-gel-001 x2\nHU-10');
check('SKU summary does not emit the mojibake-prone multiply sign',
  !String(skuSummary.itemSkus).includes('\u00d7'));

const csvRow: InvoiceCsvDetailRow = {
  order_id: 100,
  order_number: 'PS362-A',
  ship_date: '2026-06-30',
  base_qty: '1',
  addl_qty: '1',
  pickpack_amt: '2.50',
  additional_amt: '1.25',
  shipping_amt: '8.00',
  storage_amt: '0',
  row_total: '12.50',
  skus: skuSummary.itemSkus,
  package_cost_amt: '0.75',
  box_label: '12x10x3',
  box_review: false,
  fee_waived: false,
};
const csv = renderInvoiceCsv([csvRow]);
check('CSV export starts with a UTF-8 BOM for Excel',
  csv.charCodeAt(0) === 0xfeff);
check('CSV export quotes multiline SKU cells',
  csv.includes('"Booster-gel-001 x2\nHU-10"'));

const billingService = read('src/services/billing.ts');
const billingRoute = read('src/routes/billing.ts');
const apiClient = read('web/src/lib/v2-apiClient.ts');
const billingView = read('web/src/components/Views/BillingView.tsx');
const xlsxRoute = read('src/routes/billing.ts');
const packageJson = read('package.json');

check('billingDetails delegates final rows to the backend order-row SOT',
  billingService.includes('toBillingDetailOrderRows(detailRows)'));
check('billingDetails no longer limits raw fee lines before order aggregation',
  !/\.limit\(input\.limit\s*\?\?\s*2000\)/.test(billingService));
check('/billing/details schema no longer exposes a raw-line limit',
  !/const detailsSchema[\s\S]{0,220}\.extend\(\{\s*limit:/.test(billingRoute));
check('frontend Billing details request no longer sends limit=2000',
  !/billing\/details[\s\S]{0,160}limit:\s*2000/.test(apiClient));
check('BillingView no longer calls the frontend raw-line order merge',
  !/aggregateBillingDetailRowsByOrder\(detailState\.rows\)/.test(billingView));
check('XLSX Line Items SKU column is wrapText-enabled',
  /header:\s*'SKUs'[\s\S]{0,120}wrapText:\s*true/.test(xlsxRoute));
check('package.json wires the PS-362 guard',
  packageJson.includes('"test:ps-362-billing-detail-sot-export"'));

if (failures > 0) {
  console.error(`\nPS-362 billing detail SOT/export guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-362 billing detail SOT/export guard passed.');
