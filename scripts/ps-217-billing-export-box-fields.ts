/**
 * PS-217 guard — Billing PDF (GET /billing/invoice) AND Excel
 * (GET /billing/invoice.xlsx) exports must each show, per order, the billed
 * BOX SIZE and BOX COST so DR Prepper can recover package charges.
 *
 * Invariants pinned (source-pin style — billing.ts is a route module that
 * pulls in the DB client on import, so it is read as text, like ps-208):
 *   1. The shared InvoiceDetailRow carries package_cost_amt + box_label
 *      + box_review (one canonical shape; both renderers consume it).
 *   2. Box COST is the BILLED package_cost line value — never a current
 *      price-table guess (no client_package_prices / markup recompute) and
 *      never the package_cost_missing $0.00 review rows. The box label reads
 *      the stamped billed package_id (PS-207) and never re-resolves the
 *      shipment package at invoice time.
 *   3. Both renderers expose visible Box Size + Box Cost columns.
 *   4. billingInvoiceData is consumed by BOTH renderers (no forked query).
 *   5. NO double-counting: positive row_total remains authoritative (and
 *      already includes box cost); only the legacy zero-total compatibility
 *      fallback adds the separately billed package_cost amount.
 *   6. The XLSX totals SUM formulas match the one-sheet Invoice layout
 *      (Fulfillment Fee -> M) and a Box Cost SUM exists.
 *   7. Unresolved/mismatched boxes surface a review reason, not a blank.
 *
 *   npx tsx scripts/ps-217-billing-export-box-fields.ts
 */
import { readFileSync } from 'node:fs';
import { INVOICE_COLUMNS } from '../src/routes/billing-invoice-columns';
import assert from 'node:assert/strict';

const routes = readFileSync('src/routes/billing.ts', 'utf8');
const rowTotalOwner = readFileSync('src/services/billing-invoice-row-total.ts', 'utf8');
const pkg = readFileSync('package.json', 'utf8');

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// 1. Canonical shared row carries the recovery fields.
check('InvoiceDetailRow carries package_cost_amt', routes.includes('package_cost_amt: string'));
check('InvoiceDetailRow carries box_label', routes.includes('box_label: string'));
check('InvoiceDetailRow carries box_review', routes.includes('box_review: boolean'));

// 2. Box cost = the BILLED package_cost line; no current-price recompute.
const dataStart = routes.indexOf('async function billingInvoiceData(');
const dataEnd = routes.indexOf('function renderInvoiceHtml(', dataStart);
check('billingInvoiceData precedes renderInvoiceHtml', dataStart >= 0 && dataEnd > dataStart);
const invoiceData = routes.slice(dataStart, dataEnd > dataStart ? dataEnd : undefined);
// PS-373/377 (7f34f7bf) routes the billed amount through cancelledNoChargeBillingAmountSql
// (detailAmount), zeroing cancelled/no-charge rows; still b.total_cost on the package_cost line.
check('box cost aggregates the billed package_cost line',
  invoiceData.includes("sum(case when b.line_type = 'package_cost' then ${detailAmount} else 0 end), 0)::text as package_cost_amt"));
check('invoice box cost does NOT read the current price table (client_package_prices)',
  !invoiceData.includes('client_package_prices'));
check('invoice path does NOT re-resolve the shipment package (reads the billed outcome)',
  !invoiceData.includes('resolveShippedPackageId'));
check('box label reads the stamped billed package_id',
  invoiceData.includes('max(b.package_id) as billed_package_id'));

// 7. Review reason for unresolved/mismatched boxes (not a blank).
check('SQL surfaces the package_cost_missing review reason',
  invoiceData.includes("max(case when b.line_type = 'package_cost_missing' then b.description else null end) as box_review_reason"));
check('box label resolver exists with the documented precedence',
  routes.includes('function resolveInvoiceBoxLabel('));

// 3. Both renderers expose the columns.
// The four checks below used to scrape hand-written <th> and column literals out of
// routes/billing.ts. All three invoice artifacts now derive their columns from ONE contract
// (billing-invoice-columns.ts), which is what stopped the HTML, XLSX and CSV carrying different
// columns under different names — so there are no literals left to scrape, and re-adding them
// here would recreate the second source of truth. Assert the columns EXIST in the contract every
// renderer reads; ps-520's real-PG proof compares the rendered header rows of all three.
check('Box Size is a column in the shared invoice contract',
  INVOICE_COLUMNS.some((c) => c.key === 'boxSize' && c.header === 'Box Size'));
check('Box Cost is a MONEY column in the shared invoice contract',
  INVOICE_COLUMNS.some((c) => c.key === 'boxCost' && c.header === 'Box Cost' && c.money === true));
check('the HTML header row is generated from that contract',
  routes.includes('${invoiceHeaderCellsHtml()}'));
check('the XLSX columns are generated from that contract',
  /invoice\.columns = INVOICE_COLUMNS\.map/.test(routes));

// 4. One canonical data owner, both renderers consume it (no fork).
const dataCalls = routes.split('await billingInvoiceData(').length - 1;
check(`both renderers consume billingInvoiceData (found ${dataCalls})`, dataCalls >= 2);

// 5. No double-counting: both renderers delegate. The owner returns positive
//    row_total unchanged and adds package cost only for the legacy fallback.
check('HTML and XLSX delegate per-row Fulfillment Fee to one owner',
  routes.split('resolveBillingInvoiceRowTotal({').length - 1 >= 2);
// Repointed 2026-08-04. This required the literal `if (rowTotal > 0) return
// rowTotal;`. The owner now reads:
//   if (Number.isFinite(rowTotal) && rowTotal !== 0) return roundMoney(rowTotal);
// Every difference is a STRENGTHENING, and pinning the old form made the guard
// demand the weaker predicate back:
//   > 0        -> !== 0            a negative authoritative total (credit, refund,
//                                  adjustment) is now preserved instead of falling
//                                  through to the recomputed fallback
//   (none)     -> Number.isFinite  NaN/Infinity can no longer be returned as money
//   rowTotal   -> roundMoney(...)  delegates to PS-457's single cent-rounding owner
// Pin the PROPERTY -- an authoritative nonzero total is preserved, not recomputed,
// and package cost is added only in the fallback -- rather than one spelling of it.
check('row-total owner preserves authoritative totals and includes box in fallback',
  rowTotalOwner.includes('rowTotal !== 0')
    && rowTotalOwner.includes('Number.isFinite(rowTotal)')
    && rowTotalOwner.includes('roundMoney(rowTotal)')
    // PS-505: the owner now routes every term through a shared `amount()` helper so an
    // absent return bucket reads as 0 instead of NaN. Box cost is still a term.
    && rowTotalOwner.includes('amount(input.packageCost)'));

// 6. XLSX totals match the current one-sheet Invoice layout.
// PS-393 (b95126dc) inserted the Status column, shifting every column one letter right
// (Qty F->G, Box Cost I->J, Fulfillment Fee M->N). PS-505 REMOVED that column, so every
// letter shifts back left to where it was before PS-393. Pins are key-bound so they
// cannot coincidentally match a neighboring column's SUM — which matters here because a
// wrong letter sums the adjacent column silently instead of erroring.
// The three checks below used to pin the literal SUM letters (M, F, I). Those letters are now
// DERIVED from each column's own position in the shared contract, which is what made reordering
// the sheet safe — billing.ts had warned for two tickets that "a stale letter here does not
// error, it silently sums the neighbouring column", and PS-505 had already been forced to
// re-letter all seven once. Pinning a letter re-creates that trap; assert the derivation and
// that each total is addressed by COLUMN KEY instead.
check('the totals row sums Fulfillment Fee by key, not by a typed letter',
  routes.includes("fulfillmentFee: sumOf('fulfillmentFee')"));
check('the totals row sums Qty by key', routes.includes("qty: sumOf('qty')"));
check('the totals row sums Box Cost by key', routes.includes("boxCost: sumOf('boxCost')"));
check('SUM letters come from the column contract, never typed by hand',
  /xlsxColumnLetter\(invoiceColumnIndex\(key\)/.test(routes)
  && !/formula:\s*`SUM\([A-Z]\$\{/.test(routes));

// Self-wiring.
check('package.json exposes test:ps-217-billing-export-box-fields',
  /test:ps-217-billing-export-box-fields/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-217 billing export box fields (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-217 billing export box fields guard');
