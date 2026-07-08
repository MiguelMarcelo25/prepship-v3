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
 *   5. NO double-counting: the per-row Fulfillment Fee (HTML/XLSX)
 *      fallbacks are byte-identical and contain no box-cost term — box cost is
 *      DISPLAY-ONLY (already inside row_total).
 *   6. The XLSX totals SUM formulas match the one-sheet Invoice layout
 *      (Fulfillment Fee -> M) and a Box Cost SUM exists.
 *   7. Unresolved/mismatched boxes surface a review reason, not a blank.
 *
 *   npx tsx scripts/ps-217-billing-export-box-fields.ts
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const routes = readFileSync('src/routes/billing.ts', 'utf8');
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
check('HTML invoice shows a Box Size header', routes.includes('<th>Box Size</th>'));
check('HTML invoice shows a Box Cost header', routes.includes('<th class="num">Box Cost</th>'));
check('XLSX adds a Box Size column', routes.includes("{ header: 'Box Size', key: 'boxSize'"));
check('XLSX adds a Box Cost column', routes.includes("{ header: 'Box Cost', key: 'boxCost'"));

// 4. One canonical data owner, both renderers consume it (no fork).
const dataCalls = routes.split('await billingInvoiceData(').length - 1;
check(`both renderers consume billingInvoiceData (found ${dataCalls})`, dataCalls >= 2);

// 5. No double-counting: per-row Fulfillment Fee (HTML) + Total (XLSX) fallbacks
//    are byte-identical and carry NO box-cost term.
check('HTML per-row Fulfillment Fee fallback unchanged (no box term)',
  routes.includes(': pickPackFeeAmt + shippingAmt + storageAmt;'));
check('XLSX per-row Fulfillment Fee fallback unchanged (no box term)',
  routes.includes('fulfillmentFee: rowTotal > 0 ? rowTotal : pickPackFeeAmt + shippingAmt + storageAmt,'));

// 6. XLSX totals match the current one-sheet Invoice layout.
// PS-393 (b95126dc) inserted the Status column, shifting every column one letter right
// (Qty F->G, Box Cost I->J, Fulfillment Fee M->N). Pins are key-bound so they cannot
// coincidentally match a neighboring column's SUM.
check('XLSX Fulfillment Fee SUM targets column N', routes.includes('fulfillmentFee: { formula: `SUM(N${first}:N${last})`'));
check('XLSX Qty SUM re-lettered to column G', routes.includes('qty: { formula: `SUM(G${first}:G${last})`'));
check('XLSX totals include a Box Cost SUM (column J)', routes.includes('boxCost: { formula: `SUM(J${first}:J${last})`'));

// Self-wiring.
check('package.json exposes test:ps-217-billing-export-box-fields',
  /test:ps-217-billing-export-box-fields/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-217 billing export box fields (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-217 billing export box fields guard');
