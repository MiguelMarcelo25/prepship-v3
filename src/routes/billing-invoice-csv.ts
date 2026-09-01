/**
 * PS-468 — CSV serializer for the billing invoice, a thin parallel to the
 * PS-208 XLSX "Line Items" sheet.
 *
 * This module is a PURE serializer: it takes the per-order rows already
 * produced by billingInvoiceData (the invoice source of truth) and emits CSV
 * with the same money derivation as renderInvoiceXlsx — qty, pick&pack fee
 * composition, the addl_qty>0 gate on Additional Units, and the
 * backend-owned row-total fallback (including billed package cost).
 * Text cells are normalized to one line so Excel does not open the CSV with
 * tall/clipped rows. No DB access, no recomputation of any money verdict beyond
 * the same display arithmetic the XLSX export already performs.
 *
 * Calendar-day safety: the backend supplies both actual activity day and
 * effective billing day. The serializer displays those values and never owns
 * weekend roll-forward policy.
 */
import {
  INVOICE_SHIP_DATE_HEADER,
  invoiceBillingActivityDateTimeCell,
  invoiceOneLineCell,
} from './billing-invoice-text';
import { resolveBillingInvoiceRowTotal } from '../services/billing-invoice-row-total';
import { resolveBillingInvoiceReturnFee } from '../services/billing-invoice-return-cell';

/** The renderer-facing per-order row — the subset of InvoiceDetailRow the CSV
 *  serializes. Kept structurally identical to routes/billing.ts InvoiceDetailRow
 *  so the route passes data.details straight through. */
export type InvoiceCsvDetailRow = {
  order_id: number | null;
  order_number: string | null;
  shipment_id?: number | null;
  billing_adjustment_id?: string | null;
  ship_date: string | null;
  billing_effective_date: string | null;
  base_qty: string;
  addl_qty: string;
  pickpack_amt: string;
  additional_amt: string;
  shipping_amt: string;
  storage_amt: string;
  row_total: string;
  /**
   * PS-488 M3 — return money, already bucketed by the backend aggregate. Optional so a
   * caller that has not been updated serializes 0 rather than NaN into a money column.
   */
  return_postage_amt?: string | null;
  return_processing_amt?: string | null;
  /** PS-488 M3 — whether the fee EXISTS. The cell is blank when false, 0 when a real zero. */
  has_return_postage_line?: boolean;
  has_return_processing_line?: boolean;
  /**
   * PS-513 — replacement re-ship money, already bucketed by the backend aggregate. Optional so
   * a caller that has not been updated serializes blank rather than NaN into a money column.
   */
  replace_postage_amt?: string | null;
  replace_pick_pack_amt?: string | null;
  skus: string | null;
  package_cost_amt: string;
  box_label: string;
  box_review: boolean;
  // PS-275: fee_waived is carried for route parity; the CSV line items no longer render it as a column.
  fee_waived: boolean;
  /** PS-490: Domestic / International / Needs Review, already classified by the backend
   *  owner (classifyDestinationCountry). The serializer renders it and never re-derives
   *  "international" from a country string. */
  destination?: string | null;
  /** PS-490: the Order # cell including any " - Return" suffix, resolved backend-side. */
  order_number_label?: string | null;
};

/** Column order mirrors the operator-facing invoice line item sheet. */
export const INVOICE_CSV_HEADERS = [
  INVOICE_SHIP_DATE_HEADER,
  'Order #',
  // PS-505: 'Status' removed. Every later cell shifts one position left; the ps-468
  // positional assertions move with it.
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
  // PS-490: appended LAST. ps-468 pins CSV cells by position, same constraint as the
  // XLSX sheet, so a column inserted earlier would shift every existing assertion.
  'Destination',
  // PS-488 M3: return money, appended last for the same reason. The XLSX sheet already
  // carried these two columns; the CSV did not, so a return row exported with a non-zero
  // Total and every component column at 0.00 — the row could not be reconciled against
  // its own breakdown, and the two exports of one invoice disagreed on what was shown.
  'Return Postage',
  'Return Processing',
  // PS-513: appended LAST, same position-pinning rule as the return columns and Destination.
  // A replacement row exported a non-zero Total with every component column blank until these
  // two existed — the same reconciliation gap the return columns closed.
  'Replace Postage',
  'Replace Pick&Pack',
] as const;

/** RFC-4180 quote a field, with spreadsheet formula-injection neutralization:
 *  a leading =, +, -, @, tab or CR gets a leading apostrophe before quoting so
 *  the cell is treated as text, not a live formula. */
function csvField(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Format a derived numeric the same way the XLSX cells carry it — a plain
 *  number, trailing zeros trimmed (Number(...).toString()). The downstream
 *  consumer (spreadsheet/import) applies its own currency formatting. */
function num(n: number): string {
  return Number.isFinite(n) ? String(n) : '0';
}

/** Derive the display columns for one order — same arithmetic as the
 *  renderInvoiceXlsx Line Items loop (qty/fee composition + total fallback). */
export function renderInvoiceCsvRow(row: InvoiceCsvDetailRow): string {
  const baseQty = Number(row.base_qty);
  const addlQty = Number(row.addl_qty);
  const pickPackFeeAmt = Number(row.pickpack_amt) + Number(row.additional_amt);
  const packageCostAmt = Number(row.package_cost_amt);
  const shippingAmt = Number(row.shipping_amt);
  const storageAmt = Number(row.storage_amt);
  // PS-505 — these ARE now fed into resolveBillingInvoiceRowTotal below.
  //
  // PS-488 M3 held them back on the reasoning that row_total already sums every line
  // type, so passing them would double-count. That is not what happens: the helper
  // returns a persisted nonzero row_total immediately and only reconstructs when the
  // total is zero or absent. On a Return row every outbound component is zero, so the
  // fallback summed to $0.00 and exported a return with real Return Postage and Return
  // Processing cells as a zero-dollar line. Counted exactly once, in the branch that
  // reconstructs.
  //
  // PS-488 M3 — presence decides whether the cell renders at all. `0` and `absent` are
  // different facts: a return that was never charged processing and one that was charged
  // $0.00 must not export the same cell. Branching on the flag, never on the number.
  // Routed through the SAME owner the HTML and XLSX serializers use, so the three
  // renderings of one invoice cannot disagree about whether a fee exists. Each renderer
  // now makes only a formatting choice; the three-state question is answered once.
  const returnPostageCell = resolveBillingInvoiceReturnFee({
    present: row.has_return_postage_line,
    amount: row.return_postage_amt,
  });
  const returnProcessingCell = resolveBillingInvoiceReturnFee({
    present: row.has_return_processing_line,
    amount: row.return_processing_amt,
  });
  const returnPostageAmt = returnPostageCell === null ? '' : num(returnPostageCell);
  const returnProcessingAmt = returnProcessingCell === null ? '' : num(returnProcessingCell);
  // PS-513: replacement money, rendered blank when zero (dashIfZero) like the outbound cells so
  // non-replacement rows are not noisy. Backend-owned; never inferred from a line type here.
  const replacePostageRaw = Number(row.replace_postage_amt ?? 0);
  const replacePickPackRaw = Number(row.replace_pick_pack_amt ?? 0);
  const replacePostageAmt = replacePostageRaw > 0 ? num(replacePostageRaw) : '';
  const replacePickPackAmt = replacePickPackRaw > 0 ? num(replacePickPackRaw) : '';
  // Per user override unlock shipped data on 2026-07-14 (Audit B-9):
  // CSV delegates the read-only total fallback to the backend owner.
  const total = resolveBillingInvoiceRowTotal({
    rowTotal: row.row_total,
    pickPackFee: pickPackFeeAmt,
    packageCost: packageCostAmt,
    shipping: shippingAmt,
    storage: storageAmt,
    // The raw amounts, not the rendered cells: an absent fee is '' for display but 0 as
    // a term, and the resolver must not be handed a formatting decision.
    returnPostage: row.return_postage_amt,
    returnProcessing: row.return_processing_amt,
    replacePostage: row.replace_postage_amt,
    replacePickPack: row.replace_pick_pack_amt,
  });

  const cells = [
    invoiceBillingActivityDateTimeCell(
      row.ship_date,
      row.billing_effective_date,
    ),
    // PS-490: the backend-resolved Order # cell, carrying any " - Return" suffix. Falls
    // back to the previous derivation so a caller that has not been updated still emits a
    // correct order number rather than a blank cell.
    row.order_number_label
      ?? (row.billing_adjustment_id
        ? `Adjustment ${row.billing_adjustment_id.slice(0, 8)}`
        : String(row.order_number ?? row.order_id ?? '')),
    invoiceOneLineCell(row.skus),
    invoiceOneLineCell(row.box_label),
    num(packageCostAmt),
    num(baseQty + addlQty),
    num(pickPackFeeAmt),
    num(addlQty > 0 ? Number(row.additional_amt) : 0),
    num(shippingAmt),
    num(storageAmt),
    num(total),
    row.billing_adjustment_id
      ? 'Adjustment'
      : row.shipment_id == null
        ? 'External'
        : `#${row.shipment_id}`,
    // PS-490: an adjustment has no shipment and therefore no destination — blank, not
    // "Needs Review", which would imply a gap worth chasing.
    row.billing_adjustment_id ? '' : (row.destination ?? ''),
    // PS-488 M3: the backend's own return buckets, never borrowed from shipping_amt.
    // Rendered through the same num() as every other money cell so an absent value
    // becomes 0, matching how the XLSX sheet carries these two columns.
    returnPostageAmt,
    returnProcessingAmt,
    // PS-513: replacement re-ship money, appended last to match the header order.
    replacePostageAmt,
    replacePickPackAmt,
  ];
  return cells.map(csvField).join(',');
}

/** Serialize the full invoice detail set to a CSV document (CRLF line endings,
 *  RFC-4180). Header row first, then one row per order. */
export function renderInvoiceCsv(details: InvoiceCsvDetailRow[]): string {
  const lines = [INVOICE_CSV_HEADERS.join(',')];
  for (const d of details) lines.push(renderInvoiceCsvRow(d));
  return `\uFEFF${lines.join('\r\n')}`;
}
