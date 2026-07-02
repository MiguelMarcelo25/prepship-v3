import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  INVOICE_XLSX_LEFT_ALIGNMENT,
  applyInvoiceXlsxReadableLayout,
  invoiceXlsxCellDisplayWidth,
  type InvoiceXlsxWorksheet,
} from '../src/routes/billing-invoice-xlsx-layout';

type FakeCell = { value: unknown; alignment?: typeof INVOICE_XLSX_LEFT_ALIGNMENT };
type FakeColumn = {
  key: string;
  header: string;
  width?: number;
  cells: FakeCell[];
  alignment?: typeof INVOICE_XLSX_LEFT_ALIGNMENT;
  eachCell: (options: { includeEmpty?: boolean }, callback: (cell: FakeCell) => void) => void;
};
type FakeRow = {
  cells: FakeCell[];
  height?: number;
  alignment?: typeof INVOICE_XLSX_LEFT_ALIGNMENT;
  eachCell: (options: { includeEmpty?: boolean }, callback: (cell: FakeCell, colNumber?: number) => void) => void;
};

function column(key: string, header: string, cells: FakeCell[]): FakeColumn {
  return {
    key,
    header,
    cells,
    eachCell: (_options, callback) => {
      for (const cell of cells) callback(cell);
    },
  };
}

function row(cells: FakeCell[]): FakeRow {
  return {
    cells,
    eachCell: (_options, callback) => {
      cells.forEach((cell, index) => callback(cell, index + 1));
    },
  };
}

const itemNameCell: FakeCell = { value: 'Booster Gel x2 | Leeds Line V2 x1' };
const skuCell: FakeCell = { value: 'Booster-gel-001, HU-10' };
const feeCell: FakeCell = { value: 14.28 };
const worksheet: InvoiceXlsxWorksheet & { columns: FakeColumn[]; rows: FakeRow[] } = {
  columns: [
    column('orderNumber', 'Order #', [{ value: '1194' }]),
    column('shipDate', 'Ship Date', [{ value: '2026-06-03' }]),
    column('carrier', 'Carrier', [{ value: 'UPS' }]),
    column('itemName', 'Item Name', [itemNameCell]),
    column('sku', 'SKU', [skuCell]),
    column('boxSize', 'Box Size', [{ value: '12x10x3' }]),
    column('fulfillmentFee', 'Fulfillment Fee', [feeCell]),
  ],
  rows: [
    row([{ value: 'Order #' }, { value: 'Ship Date' }, { value: 'Carrier' }, { value: 'Item Name' }, { value: 'SKU' }, { value: 'Box Size' }, { value: 'Fulfillment Fee' }]),
    row([{ value: '1194' }, { value: '2026-06-03' }, { value: 'UPS' }, itemNameCell, skuCell, { value: '12x10x3' }, feeCell]),
  ],
  eachRow: (_options, callback) => {
    worksheet.rows.forEach((fakeRow, index) => callback(fakeRow, index + 1));
  },
};

assert.equal(INVOICE_XLSX_LEFT_ALIGNMENT.horizontal, 'left');
assert.equal(INVOICE_XLSX_LEFT_ALIGNMENT.wrapText, false, 'XLSX layout should keep invoice rows single-line like the operator CSV view');
assert.equal(invoiceXlsxCellDisplayWidth('Booster Gel x2 | Leeds Line V2 x1'), 'Booster Gel x2 | Leeds Line V2 x1'.length);

applyInvoiceXlsxReadableLayout(worksheet);

for (const col of worksheet.columns) {
  assert.deepEqual(col.alignment, INVOICE_XLSX_LEFT_ALIGNMENT, `column ${col.key} must be left-aligned and wrapped`);
  assert.ok(Number(col.width) >= String(col.header).length, `column ${col.key} must fit at least its header`);
  for (const cell of col.cells) {
    assert.deepEqual(cell.alignment, INVOICE_XLSX_LEFT_ALIGNMENT, `cells in ${col.key} must be left-aligned and wrapped`);
  }
}
assert.ok(Number(worksheet.columns[3]?.width) >= 'Booster Gel x2 | Leeds Line V2 x1'.length, 'Item Name column must fit one-line item text');
assert.ok(Number(worksheet.columns[4]?.width) >= 'Booster-gel-001, HU-10'.length, 'SKU column must fit one-line SKU text');
assert.ok(Number(worksheet.columns[5]?.width) >= '12x10x3'.length, 'Box Size column must fit the full box label');
assert.equal(worksheet.rows[1]?.height, undefined, 'one-line SKU rows must keep the normal Excel row height');
assert.deepEqual(feeCell.alignment, INVOICE_XLSX_LEFT_ALIGNMENT, 'money cells must be left-aligned too');

const billingRoute = readFileSync('src/routes/billing.ts', 'utf8');
assert.match(billingRoute, /from '\.\/billing-invoice-xlsx-layout'/, 'billing route must import the XLSX layout owner');
assert.doesNotMatch(billingRoute, /workbook\.addWorksheet\('Summary'\)/, 'XLSX export must not create the old Summary sheet');
assert.doesNotMatch(billingRoute, /workbook\.addWorksheet\('Line Items'/, 'XLSX export must not create the old Line Items sheet');
assert.match(billingRoute, /applyInvoiceXlsxReadableLayout\(invoice\)/, 'Invoice sheet must receive readable layout');
const xlsxStart = billingRoute.indexOf('async function renderInvoiceXlsx(');
const xlsxEnd = billingRoute.indexOf("app.get('/invoice.xlsx'", xlsxStart);
const xlsxRenderer = xlsxStart >= 0 && xlsxEnd > xlsxStart ? billingRoute.slice(xlsxStart, xlsxEnd) : '';
assert.match(xlsxRenderer, /workbook\.addWorksheet\('Invoice'/, 'XLSX export must create one Invoice sheet');
const expectedHeaders = [
  "header: 'Order #'",
  'header: INVOICE_XLSX_SHIP_DATE_HEADER',
  "header: 'Carrier'",
  "header: 'Item Name'",
  "header: 'SKU'",
  "header: 'Qty'",
  "header: 'Pick & Pack'",
  "header: 'Addl Units'",
  "header: 'Box Cost'",
  "header: 'Box Size'",
  "header: 'Shipping'",
  "header: 'Storage'",
  "header: 'Fulfillment Fee'",
];
let lastHeaderIndex = -1;
for (const header of expectedHeaders) {
  const index = xlsxRenderer.indexOf(header);
  assert.ok(index > lastHeaderIndex, `XLSX Invoice headers must include ${header} in screenshot order`);
  lastHeaderIndex = index;
}
assert.match(xlsxRenderer, /itemName:\s*invoiceOneLineCell\(d\.item_names\)/, 'Invoice sheet must flatten item names to one readable cell');
assert.match(xlsxRenderer, /sku:\s*invoiceOneLineCell\(d\.skus\)/, 'Invoice sheet must flatten SKUs to one readable cell');
assert.doesNotMatch(xlsxRenderer, /skus:\s*d\.skus\s*\?\?\s*''/, 'Invoice sheet must not export raw multiline SKU text');
assert.doesNotMatch(xlsxRenderer, /WAIVED_COLUMN_HEADER|key:\s*'waiver'|waivedCellText\(d\.fee_waived\)/, 'Invoice sheet must omit the Prep Fee Waiver column');
assert.match(xlsxRenderer, /shipDate:\s*invoiceShipDateCell\(d\.ship_date\)/, 'XLSX ship date must render the date-only invoice day');
assert.doesNotMatch(xlsxRenderer, /invoiceShipDateTimeCell\(d\.ship_date\)/, 'XLSX ship date must not include time');
assert.match(xlsxRenderer, /carrier:\s*invoiceCarrierCell\(d\.carrier_code\)/, 'Invoice sheet must use backend-owned carrier code display');
assert.match(billingRoute, /order by b\.ship_date desc,\s*b\.order_id desc/, 'Invoice detail source must sort latest ship date/order first for Excel');
assert.doesNotMatch(billingRoute, /order by b\.ship_date asc,\s*b\.order_id asc/, 'Invoice detail source must not sort oldest orders first');

const packageJson = readFileSync('package.json', 'utf8');
assert.match(packageJson, /"test:billing-invoice-xlsx-layout": "tsx scripts\/billing-invoice-xlsx-layout-guard\.ts"/, 'package.json must expose the XLSX layout guard');

console.log('billing-invoice-xlsx-layout guard passed');
