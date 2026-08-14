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
 * The money fallback is backend-owned by billing-invoice-row-total; the CSV
 * serializer delegates to it. Routes stay thin; the FE renders the downloaded
 * bytes verbatim and never recomputes a dollar amount.
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

// Header columns must mirror the operator-facing invoice line item sheet, in order.
//
// PS-488 M3 — the intent of this assertion is that EXISTING cell positions never shift,
// because the rest of this guard (and ps-467-468) addresses cells by index. Pinning the
// whole array made "append a column at the end" — the one safe way to add one — look
// identical to "insert a column in the middle", which is the unsafe one. Split into a
// prefix pin plus a full pin so the two failures now read differently: a prefix failure
// means positions moved and downstream index assertions are wrong; a full-list failure
// means a column was appended and only this list needs updating.
assert.deepEqual(
  // PS-505: 13, not 14 — 'Status' was removed, so every column after Order # shifted one
  // position left. This list and the positional assertions below move together.
  INVOICE_CSV_HEADERS.slice(0, 13),
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
    // PS-490: appended LAST, after Shipment #. This guard pins column ORDER by position,
    // which is exactly why the new column goes on the end rather than beside Order #.
    'Destination',
  ],
  'the first 13 CSV columns must not move — every positional assertion below depends on it',
);
assert.deepEqual(
  // PS-505: 13, matching the slice above after 'Status' was removed.
  INVOICE_CSV_HEADERS.slice(13),
  [
    // PS-488 M3: appended LAST, same rule as Destination. The XLSX sheet already carried
    // both; without them a return row exported a non-zero Total with every component
    // column at 0, so the CSV could not be reconciled against its own breakdown.
    'Return Postage',
    'Return Processing',
  ],
  'CSV columns must keep the operator-facing line item order and omit Prep Fee Waiver',
);
assert.ok(!INVOICE_CSV_HEADERS.includes('Prep Fee Waiver'), 'CSV must not include the Prep Fee Waiver column');

// A representative billed order: 3 base + 2 additional units, all line types,
// row_total present so the fallback is NOT used.
const richRow: InvoiceCsvDetailRow = {
  order_id: 9001,
  order_number: 'PO-9001',
  shipment_id: 90011,
  ship_date: '2026-05-03T00:00:00.000Z',
  billing_effective_date: '2026-05-04T00:00:00.000Z',
  base_qty: '3',
  addl_qty: '2',
  pickpack_amt: '6.00',
  additional_amt: '1.50',
  shipping_amt: '4.25',
  storage_amt: '0.75',
  row_total: '14.50',
  skus: 'SKU-A\nSKU-B',
  package_cost_amt: '2.00',
  box_label: 'Small (6x4x4)',
  box_review: false,
  fee_waived: false,
  // PS-490: both new cells carry backend-resolved values. The serializer renders what the
  // canonical owners decided — it never classifies a country or tests a line type itself.
  destination: 'International',
  order_number_label: 'PO-9001 - Return',
};

// An order with NO row_total (0) — the Total must fall back to
// pickPackFee + package cost + shipping + storage, IDENTICAL to the XLSX loop. Also addl_qty
// is 0 so the Additional Units column must serialize 0, not additional_amt.
const fallbackRow: InvoiceCsvDetailRow = {
  order_id: 9002,
  order_number: 'PO-9002',
  shipment_id: 90021,
  ship_date: '2026-05-05',
  billing_effective_date: '2026-05-05',
  base_qty: '1',
  addl_qty: '0',
  pickpack_amt: '3.00',
  additional_amt: '0',
  shipping_amt: '2.00',
  storage_amt: '1.00',
  row_total: '0',
  skus: null,
  package_cost_amt: '2.00',
  box_label: 'Small',
  box_review: false,
  fee_waived: false,
};

const csv = renderInvoiceCsv([richRow, fallbackRow]);
const lines = csv.split('\r\n');

assert.equal(csv.charCodeAt(0), 0xfeff, 'CSV starts with a UTF-8 BOM for Excel');
assert.equal(lines[0]?.replace(/^\uFEFF/, ''), INVOICE_CSV_HEADERS.join(','), 'first CSV line is the header row');

// Rich row: the backend-provided Monday billing day is rendered beside the
// actual Sunday activity day; the serializer does not calculate roll-forward.
// qty = 3+2 = 5, pickPackFee = 6.00+1.50 = 7.5, additional shown (addl>0) = 1.5,
// total = row_total (14.5) since it is > 0.
assert.equal(
  lines[1],
  // PS-488 M3: two trailing BLANK cells, not two zeros. This fixture is an outbound
  // shipment row that merely wears a " - Return" label — it has no return fee at all,
  // which is a different fact from having a return fee of $0.00. Printing 0.00 in a
  // return column on every shipment line of every invoice asserted a charge that was
  // never made. returnMoneyRow below covers a real return; the waived case is covered in
  // ps-488-billing-row-reference-guard, where the same number renders WITH presence.
  'Billed 5/4/2026 12:00 AM PT | Fulfilled 5/3/2026 12:00 AM PT,PO-9001 - Return,SKU-A | SKU-B,Small (6x4x4),2,5,7.5,1.5,4.25,0.75,14.5,#90011,International,,',
  'rich row must serialize readable one-line SKU text plus the XLSX-identical derived columns',
);

// PS-488 M3 — a REAL return row: return money only, no outbound components.
//
// Before the two columns existed this row exported Total 10.73 with Box Cost, Qty,
// Pick & Pack, Additional, Shipping and Storage all 0 — a money row whose own breakdown
// summed to nothing, and which the XLSX export of the same invoice showed differently.
const returnMoneyRow: InvoiceCsvDetailRow = {
  order_id: 4242,
  order_number: '1234',
  // Return lines are written with shipment_id NULL, so the Shipment # cell reads External.
  shipment_id: null,
  ship_date: '2026-05-06',
  billing_effective_date: '2026-05-06',
  base_qty: '0',
  addl_qty: '0',
  pickpack_amt: '0',
  additional_amt: '0',
  shipping_amt: '0',
  storage_amt: '0',
  return_postage_amt: '7.73',
  has_return_postage_line: true,
  return_processing_amt: '3.00',
  has_return_processing_line: true,
  row_total: '10.73',
  billing_status_label: 'Return postage',
  skus: null,
  package_cost_amt: '0',
  box_label: '—',
  box_review: false,
  fee_waived: false,
  destination: 'Domestic',
  order_number_label: '#1234-RETURN',
};

const returnCells = renderInvoiceCsvRow(returnMoneyRow).split(',');
assert.equal(returnCells.length, INVOICE_CSV_HEADERS.length, 'every header must get a cell');
assert.equal(returnCells[INVOICE_CSV_HEADERS.indexOf('Return Postage')], '7.73');
assert.equal(returnCells[INVOICE_CSV_HEADERS.indexOf('Return Processing')], '3');
assert.equal(returnCells[INVOICE_CSV_HEADERS.indexOf('Total')], '10.73',
  'the return Total must stay the backend row_total');
// The breakdown must now account for the Total. This is the property the missing columns
// broke, and it is asserted as arithmetic rather than as a pinned string so it keeps
// meaning if an unrelated column is appended later.
const sumOf = (header: string) => Number(returnCells[INVOICE_CSV_HEADERS.indexOf(header)]);
assert.equal(
  sumOf('Box Cost') + sumOf('Pick & Pack Fee') + sumOf('Shipping') + sumOf('Storage')
    + sumOf('Return Postage') + sumOf('Return Processing'),
  sumOf('Total'),
  'a return row must reconcile against its own component columns',
);
// Return money must never be laundered through the outbound buckets.
assert.equal(sumOf('Shipping'), 0, 'return postage must not appear as Shipping');
assert.equal(sumOf('Pick & Pack Fee'), 0, 'return processing must not appear as a prep fee');
// PS-488 AC-1: the label is the backend's STORED reference, passed through untouched.
assert.equal(returnCells[INVOICE_CSV_HEADERS.indexOf('Order #')], '#1234-RETURN');

// PS-488 M3 — ABSENT versus genuinely ZERO, on the exported cell.
//
// These two rows carry the SAME number for postage. Only presence separates them, and
// the CSV is where the difference becomes a client-facing claim: a blank says "no such
// charge", a 0 says "charged, at no cost". Collapsing them exported a waived postage
// charge onto a return that was never charged postage at all.
{
  const cellOf = (row: InvoiceCsvDetailRow, header: string) =>
    renderInvoiceCsvRow(row).split(',')[INVOICE_CSV_HEADERS.indexOf(header as never)];

  const processingOnly = {
    ...returnMoneyRow,
    return_postage_amt: null,
    has_return_postage_line: false,
    row_total: '3.00',
  };
  assert.equal(cellOf(processingOnly, 'Return Postage'), '',
    'a fee that was never charged must export BLANK');
  assert.equal(cellOf(processingOnly, 'Return Processing'), '3');

  const waivedPostage = {
    ...returnMoneyRow,
    return_postage_amt: '0',
    has_return_postage_line: true,
    return_processing_amt: null,
    has_return_processing_line: false,
    row_total: '0',
  };
  assert.equal(cellOf(waivedPostage, 'Return Postage'), '0',
    'a fee charged at zero must export 0, not blank');
  assert.equal(cellOf(waivedPostage, 'Return Processing'), '');

  assert.notEqual(
    cellOf(processingOnly, 'Return Postage'),
    cellOf(waivedPostage, 'Return Postage'),
    'absent and zero must not serialize identically — that is the whole defect',
  );
}

// PS-490: a row from a caller that has not been updated must still emit a correct order
// number and an empty Destination — never a blank Order # cell.
assert.ok(
  lines[2]?.includes(',PO-9002,'),
  'a row without order_number_label falls back to the plain order number',
);
// PS-488 M3: was `lines[2].endsWith(',')`, which only worked while Destination happened
// to be the final column — it asserted "Destination is last" as a side effect of testing
// "an absent field still emits its cell". Re-anchored to the intent itself, by cell
// count and by position, so appending a column can never make it silently vacuous.
const fallbackCells = lines[2]!.split(',');
assert.equal(
  fallbackCells.length,
  INVOICE_CSV_HEADERS.length,
  'a row with absent optional fields must still emit every column',
);
assert.equal(
  fallbackCells[INVOICE_CSV_HEADERS.indexOf('Destination')],
  '',
  'a row without a destination emits an empty Destination cell, not a missing column',
);
// The same rule for the two return columns: absent means 0, never NaN or blank.
assert.equal(fallbackCells[INVOICE_CSV_HEADERS.indexOf('Return Postage')], '');
assert.equal(fallbackCells[INVOICE_CSV_HEADERS.indexOf('Return Processing')], '');

// Fallback row: addl_qty 0 → Additional = 0; row_total 0 → Total falls back to
// pickPackFee(3) + package cost(2) + shipping(2) + storage(1) = 8. Empty SKUs serialize blank.
assert.equal(
  lines[2],
  // PS-490: trailing empty cell is the Destination column — this fixture carries no
  // country, and an unknown destination on a row with no order context renders blank.
  // PS-488 M3: two trailing 0 cells. row_total 0 still triggers the component fallback,
  // and the fallback deliberately does NOT include the return buckets — row_total is a
  // sum over every line type, so folding returns into the fallback would double-count on
  // every row that has a real total.
  '5/5/2026 12:00 AM PT,PO-9002,,Small,2,1,3,0,2,1,8,#90021,,,',
  'fallback row must use the row_total>0?:sum fallback identical to the XLSX loop',
);

assert.equal(
  renderInvoiceCsvRow({ ...richRow, fee_waived: true }),
  renderInvoiceCsvRow({ ...richRow, fee_waived: false }),
  'prep-fee waiver status must not add a trailing CSV column or marker',
);
assert.ok(!renderInvoiceCsv([richRow]).includes('\nSKU-B'), 'CSV SKU cells must be normalized to one readable line for Excel');

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
const rowTotalOwner = read('src/services/billing-invoice-row-total.ts');
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
assert.ok(!csvSrc.includes('WAIVED_COLUMN_HEADER') && !csvSrc.includes('waivedCellText'),
  'CSV serializer must not import the prep-fee waiver column owner');
// Derivation parity delegates to the same backend owner as HTML/XLSX.
assert.ok(
  csvSrc.includes('resolveBillingInvoiceRowTotal({')
    && rowTotalOwner.includes('const rowTotal = Number(input.rowTotal)'),
  'CSV total must delegate to the backend row-total owner and preserve row_total authority',
);

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
