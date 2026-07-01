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

const skuCell: FakeCell = { value: 'HU-10\nBooster-gel-001 x2' };
const totalCell: FakeCell = { value: 14.28 };
const worksheet: InvoiceXlsxWorksheet & { columns: FakeColumn[]; rows: FakeRow[] } = {
  columns: [
    column('shipDate', 'Ship Date', [{ value: new Date('2026-06-03T00:00:00.000Z') }]),
    column('orderNumber', 'Order #', [{ value: '1194' }]),
    column('skus', 'SKUs', [skuCell]),
    column('boxSize', 'Box Size', [{ value: '12x10x3 (12x10x3)' }]),
    column('total', 'Total', [totalCell]),
  ],
  rows: [
    row([{ value: 'Ship Date' }, { value: 'Order #' }, { value: 'SKUs' }, { value: 'Box Size' }, { value: 'Total' }]),
    row([{ value: new Date('2026-06-03T00:00:00.000Z') }, { value: '1194' }, skuCell, { value: '12x10x3 (12x10x3)' }, totalCell]),
  ],
  eachRow: (_options, callback) => {
    worksheet.rows.forEach((fakeRow, index) => callback(fakeRow, index + 1));
  },
};

assert.equal(invoiceXlsxCellDisplayWidth('HU-10\nBooster-gel-001 x2'), 'Booster-gel-001 x2'.length);

applyInvoiceXlsxReadableLayout(worksheet);

for (const col of worksheet.columns) {
  assert.deepEqual(col.alignment, INVOICE_XLSX_LEFT_ALIGNMENT, `column ${col.key} must be left-aligned and wrapped`);
  assert.ok(Number(col.width) >= String(col.header).length, `column ${col.key} must fit at least its header`);
  for (const cell of col.cells) {
    assert.deepEqual(cell.alignment, INVOICE_XLSX_LEFT_ALIGNMENT, `cells in ${col.key} must be left-aligned and wrapped`);
  }
}
assert.ok(Number(worksheet.columns[2]?.width) >= 24, 'SKU column must stay wide enough for multi-line SKU text');
assert.ok(Number(worksheet.columns[3]?.width) >= '12x10x3 (12x10x3)'.length, 'Box Size column must fit the full box label');
assert.ok(Number(worksheet.rows[1]?.height) > 15, 'multi-line SKU rows must receive expanded height');
assert.deepEqual(totalCell.alignment, INVOICE_XLSX_LEFT_ALIGNMENT, 'money cells must be left-aligned too');

const billingRoute = readFileSync('src/routes/billing.ts', 'utf8');
assert.match(billingRoute, /from '\.\/billing-invoice-xlsx-layout'/, 'billing route must import the XLSX layout owner');
assert.match(billingRoute, /applyInvoiceXlsxReadableLayout\(summary\)/, 'Summary sheet must receive readable layout');
assert.match(billingRoute, /applyInvoiceXlsxReadableLayout\(items\)/, 'Line Items sheet must receive readable layout');

const packageJson = readFileSync('package.json', 'utf8');
assert.match(packageJson, /"test:billing-invoice-xlsx-layout": "tsx scripts\/billing-invoice-xlsx-layout-guard\.ts"/, 'package.json must expose the XLSX layout guard');

console.log('billing-invoice-xlsx-layout guard passed');
