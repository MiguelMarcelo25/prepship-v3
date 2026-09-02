import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { INVOICE_COLUMN_HEADERS } from '../src/routes/billing-invoice-columns';
import ExcelJS from 'exceljs';
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

// ── REAL exceljs reproduction (the fakes above cannot catch a `this` bug) ──
// The FakeColumn/FakeRow eachRow/eachCell are plain closures that never touch
// `this._rows`, so they passed even while prod crashed. In prod (2026-07-04) the
// layout captured worksheet.eachRow DETACHED and called it without `this`, so
// real exceljs threw "Cannot read properties of undefined (reading '_rows')" and
// EVERY /billing/invoice.xlsx returned 500. Drive the layout with a REAL exceljs
// worksheet + writeBuffer so a regression fails HERE, not in production.
{
  const workbook = new ExcelJS.Workbook();
  const invoice = workbook.addWorksheet('Invoice', { views: [{ state: 'frozen', ySplit: 1 }] });
  invoice.columns = [
    { header: 'Order #', key: 'orderNumber', width: 40 },
    { header: 'SKU', key: 'sku', width: 8 },
    { header: 'Fulfillment Fee', key: 'fulfillmentFee', width: 40 },
  ];
  invoice.getRow(1).font = { bold: true };
  invoice.addRow({ orderNumber: '1194', sku: 'Booster-gel-001, HU-10', fulfillmentFee: 14.28 });
  // A long cell exercises the multi-line row-height branch inside eachRow.
  invoice.addRow({ orderNumber: '1195', sku: 'X'.repeat(120), fulfillmentFee: 0 });

  assert.doesNotThrow(
    () => applyInvoiceXlsxReadableLayout(invoice as unknown as InvoiceXlsxWorksheet),
    'applyInvoiceXlsxReadableLayout must not throw on a REAL exceljs worksheet (eachRow must keep its `this`)',
  );
  // The row pass actually ran against the real worksheet (not a silent no-op).
  assert.equal(
    invoice.getRow(2).getCell(1).alignment?.horizontal,
    'left',
    'real exceljs data cells must be left-aligned by the row pass',
  );
  // End-to-end: the route calls writeBuffer() immediately after the layout.
  const realBytes = await workbook.xlsx.writeBuffer();
  const realBuf = Buffer.isBuffer(realBytes) ? realBytes : Buffer.from(realBytes as ArrayBuffer);
  assert.ok(realBuf.length > 0, 'workbook.xlsx.writeBuffer() must produce bytes after the readable layout');
}

const billingRoute = readFileSync('src/routes/billing.ts', 'utf8');
assert.match(billingRoute, /from '\.\/billing-invoice-xlsx-layout'/, 'billing route must import the XLSX layout owner');
assert.doesNotMatch(billingRoute, /workbook\.addWorksheet\('Summary'\)/, 'XLSX export must not create the old Summary sheet');
assert.doesNotMatch(billingRoute, /workbook\.addWorksheet\('Line Items'/, 'XLSX export must not create the old Line Items sheet');
assert.match(billingRoute, /applyInvoiceXlsxReadableLayout\(invoice\)/, 'Invoice sheet must receive readable layout');
const xlsxStart = billingRoute.indexOf('async function renderInvoiceXlsx(');
const xlsxEnd = billingRoute.indexOf("app.get('/invoice.xlsx'", xlsxStart);
const xlsxRenderer = xlsxStart >= 0 && xlsxEnd > xlsxStart ? billingRoute.slice(xlsxStart, xlsxEnd) : '';
assert.match(xlsxRenderer, /workbook\.addWorksheet\('Invoice'/, 'XLSX export must create one Invoice sheet');
// COLUMN ORDER IS NO LONGER PINNED AS SOURCE TEXT HERE.
//
// This used to scrape `header: '...'` literals out of renderInvoiceXlsx and require them in a
// fixed order. That list is gone: all three invoice artifacts now derive their columns from one
// contract (billing-invoice-columns.ts), which is what stopped the HTML, XLSX and CSV carrying
// different columns, in a different order, under different names.
//
// Pinning source literals here would recreate the problem — a fourth place where the column
// order appears to be decided, drifting from the owner the moment anyone edits it. So assert
// the DERIVATION, and assert the ORDER against the contract itself. The rendered header rows of
// all three documents are compared against each other by test:ps-520-invoice-routes-pg17.
assert.match(
  xlsxRenderer,
  /invoice\.columns = INVOICE_COLUMNS\.map/,
  'the Invoice sheet must render the shared column contract, not its own hand-written list',
);
assert.doesNotMatch(
  xlsxRenderer,
  /\{\s*header:\s*'[^']+',\s*key:/,
  'a hand-written column literal reintroduces the second source of truth this replaced',
);
// The totals row addresses its SUM() ranges by spreadsheet column letter, and billing.ts warns
// that a stale letter "does not error — it silently sums the neighbouring column". Deriving the
// letter is what made reordering safe, so a hand-typed one must not come back.
assert.doesNotMatch(
  xlsxRenderer,
  /formula:\s*`SUM\([A-Z]\$\{/,
  'totals-row column letters must be derived via xlsxColumnLetter(invoiceColumnIndex(key))',
);
assert.match(xlsxRenderer, /sumOf\('fulfillmentFee'\)/, 'the totals row must sum by column KEY');
assert.deepEqual(
  [...INVOICE_COLUMN_HEADERS],
  [
    'Billing / Activity Date (Los Angeles)',
    'Order #',
    'SKUs',
    'Box Size',
    'Box Cost',
    'Qty',
    'Pick & Pack Fee',
    'Additional Units',
    'Shipping',
    'Storage',
    'Total',
    'Shipment #',
    'Destination',
    'Return Postage',
    'Return Processing',
    'Replace Postage',
    'Replace Pick&Pack',
    // Appended LAST. New columns go on the END — several guards pin invoice cells by position
    // and the totals row addresses columns by letter.
    'Carrier',
    'Item Name',
  ],
  'the shared invoice column order changed — update every consumer deliberately, never casually',
);
assert.match(xlsxRenderer, /itemName:\s*invoiceOneLineCell\(d\.item_names\)/, 'Invoice sheet must flatten item names to one readable cell');
assert.match(xlsxRenderer, /sku:\s*invoiceOneLineCell\(d\.skus\)/, 'Invoice sheet must flatten SKUs to one readable cell');
assert.doesNotMatch(xlsxRenderer, /skus:\s*d\.skus\s*\?\?\s*''/, 'Invoice sheet must not export raw multiline SKU text');
assert.doesNotMatch(xlsxRenderer, /WAIVED_COLUMN_HEADER|key:\s*'waiver'|waivedCellText\(d\.fee_waived\)/, 'Invoice sheet must omit the Prep Fee Waiver column');
assert.match(
  xlsxRenderer,
  /shipDate:\s*invoiceBillingActivityDateCell\(\s*d\.ship_date,\s*d\.billing_effective_date,?\s*\)/,
  'XLSX must render the backend billing day and preserve a different actual activity day',
);
assert.doesNotMatch(xlsxRenderer, /invoiceShipDateTimeCell\(d\.ship_date\)/, 'XLSX ship date must not include time');
assert.match(xlsxRenderer, /carrier:\s*invoiceCarrierCell\(d\.carrier_code\)/, 'Invoice sheet must use backend-owned carrier code display');
assert.match(billingRoute, /order by \$\{invoiceEffectiveDay\} desc, b\.order_id desc/, 'Invoice detail source must sort latest effective billing day/order first for Excel');
assert.doesNotMatch(billingRoute, /order by \$\{invoiceEffectiveDay\} asc, b\.order_id asc/, 'Invoice detail source must not sort oldest effective billing days first');

const packageJson = readFileSync('package.json', 'utf8');
assert.match(packageJson, /"test:billing-invoice-xlsx-layout": "tsx scripts\/billing-invoice-xlsx-layout-guard\.ts"/, 'package.json must expose the XLSX layout guard');

console.log('billing-invoice-xlsx-layout guard passed');
