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
  billing_status_label?: string | null;
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
  'Status',
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
  // PS-488 M3 — NOT fed into resolveBillingInvoiceRowTotal below. That helper's fallback
  // reconstructs a total from the outbound components when row_total is absent, and its
  // shape is pinned by PS-468/Audit B-9. row_total already includes return money (it is
  // a sum over every line type), so adding these here would double-count on every row
  // that has a real row_total. They are display buckets only.
  //
  // PS-488 M3 — presence decides whether the cell renders at all. `0` and `absent` are
  // different facts: a return that was never charged processing and one that was charged
  // $0.00 must not export the same cell. Branching on the flag, never on the number.
  const returnPostageAmt = row.has_return_postage_line === true
    ? num(Number(row.return_postage_amt ?? 0) || 0)
    : '';
  const returnProcessingAmt = row.has_return_processing_line === true
    ? num(Number(row.return_processing_amt ?? 0) || 0)
    : '';
  // Per user override unlock shipped data on 2026-07-14 (Audit B-9):
  // CSV delegates the read-only total fallback to the backend owner.
  const total = resolveBillingInvoiceRowTotal({
    rowTotal: row.row_total,
    pickPackFee: pickPackFeeAmt,
    packageCost: packageCostAmt,
    shipping: shippingAmt,
    storage: storageAmt,
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
    row.billing_status_label || 'Fulfilled',
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
