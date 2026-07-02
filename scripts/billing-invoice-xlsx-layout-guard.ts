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

const skuCell: FakeCell = { value: 'Booster-gel-001 x2 | HU-10' };
const totalCell: FakeCell = { value: 14.28 };
const worksheet: InvoiceXlsxWorksheet & { columns: FakeColumn[]; rows: FakeRow[] } = {
  columns: [
    column('shipDate', 'Ship Date/Time (Los Angeles)', [{ value: '6/3/2026 12:00 AM PT' }]),
    column('orderNumber', 'Order #', [{ value: '1194' }]),
    column('skus', 'SKUs', [skuCell]),
    column('boxSize', 'Box Size', [{ value: '12x10x3 (12x10x3)' }]),
    column('total', 'Total', [totalCell]),
  ],
  rows: [
    row([{ value: 'Ship Date/Time (Los Angeles)' }, { value: 'Order #' }, { value: 'SKUs' }, { value: 'Box Size' }, { value: 'Total' }]),
    row([{ value: '6/3/2026 12:00 AM PT' }, { value: '1194' }, skuCell, { value: '12x10x3 (12x10x3)' }, totalCell]),
  ],
  eachRow: (_options, callback) => {
    worksheet.rows.forEach((fakeRow, index) => callback(fakeRow, index + 1));
  },
};

assert.equal(INVOICE_XLSX_LEFT_ALIGNMENT.horizontal, 'left');
assert.equal(INVOICE_XLSX_LEFT_ALIGNMENT.wrapText, false, 'XLSX layout should keep invoice rows single-line like the operator CSV view');
assert.equal(invoiceXlsxCellDisplayWidth('Booster-gel-001 x2 | HU-10'), 'Booster-gel-001 x2 | HU-10'.length);

applyInvoiceXlsxReadableLayout(worksheet);

for (const col of worksheet.columns) {
  assert.deepEqual(col.alignment, INVOICE_XLSX_LEFT_ALIGNMENT, `column ${col.key} must be left-aligned and wrapped`);
  assert.ok(Number(col.width) >= String(col.header).length, `column ${col.key} must fit at least its header`);
  for (const cell of col.cells) {
    assert.deepEqual(cell.alignment, INVOICE_XLSX_LEFT_ALIGNMENT, `cells in ${col.key} must be left-aligned and wrapped`);
  }
}
assert.ok(Number(worksheet.columns[2]?.width) >= 'Booster-gel-001 x2 | HU-10'.length, 'SKU column must fit one-line SKU text');
assert.ok(Number(worksheet.columns[3]?.width) >= '12x10x3 (12x10x3)'.length, 'Box Size column must fit the full box label');
assert.equal(worksheet.rows[1]?.height, undefined, 'one-line SKU rows must keep the normal Excel row height');
assert.deepEqual(totalCell.alignment, INVOICE_XLSX_LEFT_ALIGNMENT, 'money cells must be left-aligned too');

const billingRoute = readFileSync('src/routes/billing.ts', 'utf8');
assert.match(billingRoute, /from '\.\/billing-invoice-xlsx-layout'/, 'billing route must import the XLSX layout owner');
assert.match(billingRoute, /applyInvoiceXlsxReadableLayout\(summary\)/, 'Summary sheet must receive readable layout');
assert.match(billingRoute, /applyInvoiceXlsxReadableLayout\(items\)/, 'Line Items sheet must receive readable layout');
const xlsxStart = billingRoute.indexOf('async function renderInvoiceXlsx(');
const xlsxEnd = billingRoute.indexOf("app.get('/invoice.xlsx'", xlsxStart);
const xlsxRenderer = xlsxStart >= 0 && xlsxEnd > xlsxStart ? billingRoute.slice(xlsxStart, xlsxEnd) : '';
assert.match(xlsxRenderer, /skus:\s*invoiceOneLineCell\(d\.skus\)/, 'Line Items sheet must flatten SKUs to one readable cell like the CSV export');
assert.doesNotMatch(xlsxRenderer, /skus:\s*d\.skus\s*\?\?\s*''/, 'Line Items sheet must not export raw multiline SKU text');
assert.doesNotMatch(xlsxRenderer, /WAIVED_COLUMN_HEADER|key:\s*'waiver'|waivedCellText\(d\.fee_waived\)/, 'Line Items sheet must omit the Prep Fee Waiver column');
assert.match(xlsxRenderer, /header:\s*INVOICE_SHIP_DATE_HEADER/, 'Line Items sheet must use the shared Los Angeles ship-date/time header');
assert.match(xlsxRenderer, /shipDate:\s*invoiceShipDateTimeCell\(d\.ship_date\)/, 'Line Items sheet must render Los Angeles ship date/time text');
assert.match(billingRoute, /order by b\.ship_date desc,\s*b\.order_id desc/, 'Invoice detail source must sort latest ship date/order first for Excel');
assert.doesNotMatch(billingRoute, /order by b\.ship_date asc,\s*b\.order_id asc/, 'Invoice detail source must not sort oldest orders first');

const packageJson = readFileSync('package.json', 'utf8');
assert.match(packageJson, /"test:billing-invoice-xlsx-layout": "tsx scripts\/billing-invoice-xlsx-layout-guard\.ts"/, 'package.json must expose the XLSX layout guard');

console.log('billing-invoice-xlsx-layout guard passed');
