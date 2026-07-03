/**
 * PS-323 — Billing source-of-truth parity guard.
 *
 * The PS-323 audit found NO residual money-recompute drift: every billed value is owned by the
 * backend generator (markup/price/fees frozen into billing_line_items.total_cost at generate time),
 * and the on-screen summary/detail plus the three invoice exports (HTML / XLSX / CSV) all read the
 * SAME backend read model (billingInvoiceData → sum(total_cost) over billing_line_items). This guard
 * LOCKS that conclusion so a future change cannot make one surface recompute money differently:
 *
 *   1. Behavioral: the extracted CSV serializer derives the per-order Total by the canonical
 *      `row_total > 0 ? row_total : pickPackFee + shipping + storage` rule (and gates Additional
 *      Units on addl_qty>0). It reads the backend row_total verbatim — no markup, no re-derivation.
 *   2. Cross-export lockstep: that SAME Total expression appears in all THREE renderers (CSV file +
 *      the HTML and XLSX loops in routes/billing.ts), so they cannot silently diverge.
 *   3. Single source: all three export routes feed off billingInvoiceData, whose per-order Total is
 *      sum(b.total_cost) — the generated/frozen line-item dollars — and waiver visibility stays as
 *      the invoice-level period note (not a trailing CSV/XLSX column).
 *   4. FE pin: the shared FE billing math prefers the backend DTO fields (fulfillmentFeeTotal /
 *      grandTotal) and only falls back to the shared calculate* helpers (the backend's own formula),
 *      so the frontend never invents a divergent authoritative total.
 *
 * Offline/pure: no DB, no network, no shipped/cancelled mutation. Read-only over source text plus a
 * behavioral exercise of the pure CSV serializer.
 */
import { readFileSync } from 'node:fs';
import { renderInvoiceCsvRow, type InvoiceCsvDetailRow } from '../src/routes/billing-invoice-csv';

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
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

// Total column index in the CSV row (Ship Date, Order #, SKUs, Box Size, Box Cost, Qty,
// Pick & Pack Fee, Additional Units, Shipping, Storage, Total).
const TOTAL_COL = 10;
const ADDITIONAL_COL = 7;
const QTY_COL = 5;

function baseRow(over: Partial<InvoiceCsvDetailRow>): InvoiceCsvDetailRow {
  return {
    order_id: 1,
    order_number: 'A1',
    ship_date: '2026-06-21',
    base_qty: '1',
    addl_qty: '0',
    pickpack_amt: '2.50',
    additional_amt: '0.50',
    shipping_amt: '7.11',
    storage_amt: '0',
    row_total: '0',
    skus: 'HU-10',
    package_cost_amt: '0.55',
    box_label: '12x10x3',
    box_review: false,
    fee_waived: false,
    ...over,
  };
}

// ── 1) Behavioral: the per-order Total is the backend row_total verbatim when it is > 0 ──
const billed = renderInvoiceCsvRow(baseRow({ row_total: '10.66' })).split(',');
check('CSV Total reads the backend row_total verbatim when present (no FE recompute)', billed[TOTAL_COL] === '10.66');

// ── 2) Behavioral: the documented fallback fires ONLY when row_total is 0 (sums the same backend
//        per-line amounts: pickPackFee + shipping + storage) — clean integers to avoid float noise ──
const fallback = renderInvoiceCsvRow(
  baseRow({ row_total: '0', pickpack_amt: '2', additional_amt: '1', shipping_amt: '7', storage_amt: '1' }),
).split(',');
check('CSV Total fallback = pickPackFee + shipping + storage when row_total is 0 (3 + 7 + 1 = 11)', fallback[TOTAL_COL] === '11');

// ── 3) Behavioral: Additional Units is gated on addl_qty>0; Qty = base + addl (display derivation
//        of the SAME backend amounts, never a new charge) ──
const noAddl = renderInvoiceCsvRow(baseRow({ addl_qty: '0', additional_amt: '0.50', base_qty: '3' })).split(',');
check('Additional Units shows 0 when addl_qty is 0 (no phantom additional charge)', noAddl[ADDITIONAL_COL] === '0');
check('Qty = base_qty + addl_qty', noAddl[QTY_COL] === '3');
const withAddl = renderInvoiceCsvRow(baseRow({ addl_qty: '2', additional_amt: '1.00', base_qty: '1' })).split(',');
check('Additional Units shows the backend additional_amt when addl_qty>0', withAddl[ADDITIONAL_COL] === '1');
check('Qty = base + addl when addl present (1 + 2 = 3)', withAddl[QTY_COL] === '3');

// ── 4) Cross-export lockstep: the SAME Total expression in all three renderers ──
const csvSrc = read('src/routes/billing-invoice-csv.ts');
const billingRoute = read('src/routes/billing.ts');
const totalExpr = /rowTotal > 0[\s\S]{0,12}rowTotal[\s\S]{0,40}pickPackFeeAmt \+ shippingAmt \+ storageAmt/;
check('CSV serializer uses the canonical Total expression', totalExpr.test(csvSrc));
const billingMatches = billingRoute.match(new RegExp(totalExpr, 'g')) ?? [];
check('routes/billing.ts HTML + XLSX renderers BOTH use the SAME Total expression (>=2 occurrences)', billingMatches.length >= 2);

// ── 5) Single source: per-order Total = sum(total_cost) over billing_line_items (the frozen dollars),
//        and all three export routes feed off the one billingInvoiceData read model ──
check('invoice per-order Total derives from sum(b.total_cost) (generated/frozen line items)',
  /sum\(b\.total_cost\)::text as row_total/.test(billingRoute));
check('HTML / XLSX / CSV invoice routes all consume the single billingInvoiceData source',
  (billingRoute.match(/billingInvoiceData\(/g) ?? []).length >= 3 &&
  /invoice\.xlsx[\s\S]{0,400}billingInvoiceData\(/.test(billingRoute) &&
  /invoice\.csv[\s\S]{0,400}billingInvoiceData\(/.test(billingRoute));

// ── 6) Exports format, never re-mark-up: the CSV serializer applies no markup of its own ──
check('CSV serializer applies NO markup / price re-derivation (formats backend dollars only)',
  !/markup/i.test(csvSrc) && !/\*\s*\(1\s*\+/.test(csvSrc) && !/clientPackagePrices/.test(csvSrc));

// ── 7) Waiver visibility stays invoice-level only; CSV carries no trailing marker column ──
check('CSV serializer omits the prep-fee waiver marker column',
  !/billing-invoice-waiver-indicator/.test(csvSrc) && !/Prep Fee Waiver|waivedCellText/.test(csvSrc));
check('invoice routes keep the shared waiver period note owner',
  /billing-invoice-waiver-indicator/.test(billingRoute) && /waivedSummaryNote/.test(billingRoute));

// ── 8) FE pin: the shared FE billing math displays the backend DTO totals VERBATIM.
//        PS-369 deleted the calculate* fallback helpers entirely — the FE recomputes
//        no money; a missing backend total renders 0 instead of a re-derived number ──
const parity = read('web/src/components/Views/billing-parity.ts');
const billingSvc = read('src/services/billing.ts');
check('FE summary/detail math prefers the backend fulfillmentFeeTotal / grandTotal DTO fields',
  /row\.fulfillmentFeeTotal/.test(parity) &&
  /row\.grandTotal/.test(parity) &&
  /detail\.fulfillmentFeeTotal/.test(parity));
check('PS-369: FE fee recompute is GONE (no calculateBillingFulfillmentFee/PickPackFee in billing-parity)',
  !/calculateBillingFulfillmentFee\s*\(|calculateBillingPickPackFee\s*\(/.test(parity.replace(/\/\/[^\n]*/g, '')));
check('backend billingSummary RETURNS the fulfillmentFeeTotal / pickPackFeeTotal the FE reads (single formula, owned backend)',
  /fulfillmentFeeTotal/.test(billingSvc) && /pickPackFeeTotal/.test(billingSvc));

if (failures > 0) {
  console.error(`\nPS-323 billing SOT parity guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-323 billing SOT parity guard passed.');
