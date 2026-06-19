/**
 * PS-468 guard — billing invoice CSV export (thin parallel to the PS-208 XLSX).
 *
 * BUSINESS INVARIANT: the CSV export is a THIN serialization of the SAME
 * invoice dataset behind the HTML and XLSX exports. It MUST:
 *  - reuse the SAME billingInvoiceData(invoiceScope, clientId, range) SOT call
 *    (no forked query — the three exports can never disagree about rows);
 *  - serialize data.details with the IDENTICAL column derivation as the XLSX
 *    "Line Items" sheet (qty = base+addl, pickPackFee = pickpack+additional,
 *    additional shown only when addl_qty>0, total = row_total || fallback) —
 *    NO recomputation of any money/insurance verdict in the FE;
 *  - preserve auth (financials:read) + client-scope + financial-visibility
 *    gating EXACTLY as the XLSX route (same billingScopeFromContext + 404 on
 *    out-of-scope client);
 *  - set Content-Type text/csv + a Content-Disposition attachment filename.
 *
 * The money/column derivation is the backend source of truth (renderInvoiceCsvRow
 * in src/routes/billing-invoice-csv.ts). Routes stay thin; the FE renders the
 * downloaded bytes verbatim and never recomputes a dollar amount.
 *
 * Two layers:
 *  1) Behavioral: drive the pure CSV serializer over a fixture and assert the
 *     exact header + a derived row (offline, no DB, no provider data).
 *  2) Source pins so the route/FE wiring can't silently revert.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  INVOICE_CSV_HEADERS,
  renderInvoiceCsv,
  renderInvoiceCsvRow,
  type InvoiceCsvDetailRow,
} from '../src/routes/billing-invoice-csv';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

// ── 1. Behavioral: derivation parity with the XLSX Line Items sheet ──────────

// Header columns must mirror the XLSX "Line Items" sheet, in order.
assert.deepEqual(
  INVOICE_CSV_HEADERS,
  [
    'Ship Date',
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
    // PS-275 item 2: the prep-fee waiver indicator column (last, mirroring the
    // XLSX Line Items sheet; HTML keeps only the period-level waiver note).
    'Prep Fee Waiver',
  ],
  'CSV columns must mirror the XLSX Line Items sheet, in order',
);

// A representative billed order: 3 base + 2 additional units, all line types,
// row_total present so the fallback is NOT used.
const richRow: InvoiceCsvDetailRow = {
  order_id: 9001,
  order_number: 'PO-9001',
  ship_date: '2026-05-04T00:00:00.000Z',
  base_qty: '3',
  addl_qty: '2',
  pickpack_amt: '6.00',
  additional_amt: '1.50',
  shipping_amt: '4.25',
  storage_amt: '0.75',
  row_total: '14.50',
  skus: 'SKU-A, SKU-B',
  package_cost_amt: '2.00',
  box_label: 'Small (6x4x4)',
  box_review: false,
  fee_waived: false,
};

// An order with NO row_total (0) — the Total must fall back to
// pickPackFee + shipping + storage, IDENTICAL to the XLSX loop. Also addl_qty
// is 0 so the Additional Units column must serialize 0, not additional_amt.
const fallbackRow: InvoiceCsvDetailRow = {
  order_id: 9002,
  order_number: 'PO-9002',
  ship_date: '2026-05-05',
  base_qty: '1',
  addl_qty: '0',
  pickpack_amt: '3.00',
  additional_amt: '0',
  shipping_amt: '2.00',
  storage_amt: '1.00',
  row_total: '0',
  skus: null,
  package_cost_amt: '0',
  box_label: '—',
  box_review: false,
  fee_waived: false,
};

const csv = renderInvoiceCsv([richRow, fallbackRow]);
const lines = csv.split('\r\n');

assert.equal(lines[0], INVOICE_CSV_HEADERS.join(','), 'first CSV line is the header row');

// Rich row: ship day extracted at UTC (calendar day, never timezone-shifted),
// qty = 3+2 = 5, pickPackFee = 6.00+1.50 = 7.5, additional shown (addl>0) = 1.5,
// total = row_total (14.5) since it is > 0.
assert.equal(
  lines[1],
  '2026-05-04,PO-9001,"SKU-A, SKU-B",Small (6x4x4),2,5,7.5,1.5,4.25,0.75,14.5,',
  'rich row must serialize the XLSX-identical derived columns (qty/fee/additional/total) + blank waiver cell',
);

// Fallback row: addl_qty 0 → Additional = 0; row_total 0 → Total falls back to
// pickPackFee(3) + shipping(2) + storage(1) = 6. Empty SKUs serialize blank.
assert.equal(
  lines[2],
  '2026-05-05,PO-9002,,—,0,1,3,0,2,1,6,',
  'fallback row must use the row_total>0?:sum fallback identical to the XLSX loop + blank waiver cell',
);

// PS-275 item 2: the prep-fee WAIVER indicator is a real CSV column. A waived
// order serializes the "Waived" marker in the trailing column; a non-waived
// order leaves it blank. The dollar columns are untouched — the waiver only
// drives the indicator (billingInvoiceData already reflects the zeroed prep).
assert.ok(
  renderInvoiceCsvRow({ ...richRow, fee_waived: true }).endsWith(',Waived'),
  'a WAIVED order must serialize the "Waived" marker in the trailing prep-fee-waiver column',
);
assert.ok(
  renderInvoiceCsvRow({ ...richRow, fee_waived: false }).endsWith(',14.5,'),
  'a non-waived order must leave the trailing prep-fee-waiver column blank',
);

// CSV injection / comma / quote safety: a field with a comma or a leading "="
// must be quoted; embedded quotes doubled. (No raw provider payloads here —
// synthetic fixture only.)
const csvSafe = renderInvoiceCsv([
  {
    ...fallbackRow,
    order_number: '=cmd,"x"',
    skus: 'A,B',
  },
]);
const unsafeLine = csvSafe.split('\r\n')[1];
assert.ok(
  unsafeLine.includes('"\'=cmd,""x"""') || unsafeLine.includes('"=cmd,""x"""'),
  'fields with commas/quotes/formula-leads must be CSV-quoted/escaped',
);

// ── 2. Source pins ───────────────────────────────────────────────────────────

const routes = read('src/routes/billing.ts');
const csvSrc = read('src/routes/billing-invoice-csv.ts');
const feClient = read('web/src/lib/v2-apiClient.ts');
const feView = read('web/src/components/Views/BillingView.tsx');
const feTable = read('web/src/components/Views/BillingSummaryTable.tsx');
const pkg = read('package.json');

// Route exists and is a THIN parallel of the XLSX route.
assert.ok(routes.includes("app.get('/invoice.csv'"),
  'GET /billing/invoice.csv route must exist');
// No query fork: the CSV consumes billingInvoiceData like HTML + XLSX. With the
// new route there must be at least THREE call sites.
const invoiceDataCalls = routes.split('await billingInvoiceData(').length - 1;
assert.ok(invoiceDataCalls >= 3,
  `HTML, XLSX and CSV invoices must ALL consume billingInvoiceData (no query fork) — found ${invoiceDataCalls} call(s)`);
// CSV serialization is delegated to the dedicated small module, not inlined.
assert.ok(routes.includes("from './billing-invoice-csv'"),
  'invoice.csv route must import the CSV serializer from its own small module');
assert.ok(routes.includes('renderInvoiceCsv('),
  'invoice.csv route must call renderInvoiceCsv from the dedicated module');
// Same scope/auth gating as the XLSX route: derive scope via
// billingScopeFromContext and 404 when the client is out of scope.
assert.ok(routes.includes('billingScopeFromContext(c)') ,
  'invoice.csv route must derive client scope via billingScopeFromContext (financial-visibility gate)');
// Content-Type + attachment disposition.
assert.ok(/['"]content-type['"]\s*:\s*['"]text\/csv/.test(routes),
  'invoice.csv response must carry the text/csv content-type');
assert.ok(/content-disposition['"]\s*:\s*[`'"]attachment;[^\n]*\.csv/.test(routes),
  'invoice.csv response must set an attachment .csv filename');

// The serializer module owns the derivation and must NOT re-run a DB query or
// import the db client (it is a pure serializer of the SOT rows).
assert.ok(!/from ['"]\.\.\/db\//.test(csvSrc) && !csvSrc.includes('db.execute'),
  'billing-invoice-csv.ts must be a pure serializer — no DB access');
// Derivation parity tokens with the XLSX loop (no independent recomputation).
assert.ok(csvSrc.includes('Number(row.row_total)') || csvSrc.includes('Number(d.row_total)'),
  'CSV total must derive from row_total (XLSX-identical), not a recomputed sum');

// FE: apiClient download helper + handler wired through the table, next to the
// Excel button.
assert.ok(feClient.includes('openBillingInvoiceCsv'),
  'v2-apiClient must expose openBillingInvoiceCsv');
assert.ok(feClient.includes('/billing/invoice.csv?'),
  'openBillingInvoiceCsv must call the CSV route');
assert.ok(feView.includes('handleExportInvoiceCsv') && feView.includes('openBillingInvoiceCsv'),
  'BillingView must wire the CSV handler to the apiClient');
assert.ok(feView.includes('handleExportInvoiceCsv={handleExportInvoiceCsv}'),
  'BillingView must pass handleExportInvoiceCsv to BillingSummaryTable');
assert.ok(feTable.includes('handleExportInvoiceCsv') && feTable.includes('CSV'),
  'BillingSummaryTable must render the CSV export button next to Excel');

// Guard registered.
assert.ok(/"test:ps-468-invoice-csv"\s*:/.test(pkg),
  'package.json must register the test:ps-468-invoice-csv script');

console.log('PASS ps-468 billing invoice CSV export guard (derivation parity + source pins)');
