/**
 * PS-468 — CSV serializer for the billing invoice, a thin parallel to the
 * PS-208 XLSX "Line Items" sheet.
 *
 * This module is a PURE serializer: it takes the per-order rows already
 * produced by billingInvoiceData (the invoice source of truth) and emits CSV
 * with the IDENTICAL column derivation as renderInvoiceXlsx — qty, pick&pack
 * fee composition, the addl_qty>0 gate on Additional Units, and the
 * `row_total > 0 ? row_total : pickPackFee + shipping + storage` fallback all
 * match the XLSX loop exactly. No DB access, no recomputation of any money
 * verdict beyond the same display arithmetic the XLSX export already performs.
 *
 * Calendar-day safety: ship_date is a calendar day stored at UTC midnight. We
 * emit the leading YYYY-MM-DD verbatim (no timezone conversion), the same
 * UTC-anchored day the XLSX `excelDayCell` renders.
 */

/** The renderer-facing per-order row — the subset of InvoiceDetailRow the CSV
 *  serializes. Kept structurally identical to routes/billing.ts InvoiceDetailRow
 *  so the route passes data.details straight through. */
export type InvoiceCsvDetailRow = {
  order_id: number | null;
  order_number: string | null;
  ship_date: string | null;
  base_qty: string;
  addl_qty: string;
  pickpack_amt: string;
  additional_amt: string;
  shipping_amt: string;
  storage_amt: string;
  row_total: string;
  skus: string | null;
  package_cost_amt: string;
  box_label: string;
  box_review: boolean;
  // PS-275 (item 2): prep-fee WAIVED indicator (the dollars already reflect it; this drives a column).
  fee_waived: boolean;
};

/** Column order mirrors the XLSX "Line Items" sheet exactly. */
export const INVOICE_CSV_HEADERS = [
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
] as const;

/** YYYY-MM-DD for a UTC-midnight ship day — the leading date component verbatim,
 *  never timezone-converted (matches the XLSX excelDayCell anchor). */
function csvDayCell(day: string | null | undefined): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(day ?? ''));
  return match ? `${match[1]}-${match[2]}-${match[3]}` : String(day ?? '');
}

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

/** Derive the 11 display columns for one order — IDENTICAL arithmetic to the
 *  renderInvoiceXlsx Line Items loop (qty/fee composition + total fallback). */
export function renderInvoiceCsvRow(row: InvoiceCsvDetailRow): string {
  const baseQty = Number(row.base_qty);
  const addlQty = Number(row.addl_qty);
  const pickPackFeeAmt = Number(row.pickpack_amt) + Number(row.additional_amt);
  const shippingAmt = Number(row.shipping_amt);
  const storageAmt = Number(row.storage_amt);
  const rowTotal = Number(row.row_total);

  const cells = [
    csvDayCell(row.ship_date),
    String(row.order_number ?? row.order_id ?? ''),
    row.skus ?? '',
    row.box_label,
    num(Number(row.package_cost_amt)),
    num(baseQty + addlQty),
    num(pickPackFeeAmt),
    num(addlQty > 0 ? Number(row.additional_amt) : 0),
    num(shippingAmt),
    num(storageAmt),
    num(rowTotal > 0 ? rowTotal : pickPackFeeAmt + shippingAmt + storageAmt),
  ];
  return cells.map(csvField).join(',');
}

/** Serialize the full invoice detail set to a CSV document (CRLF line endings,
 *  RFC-4180). Header row first, then one row per order. */
export function renderInvoiceCsv(details: InvoiceCsvDetailRow[]): string {
  const lines = [INVOICE_CSV_HEADERS.join(',')];
  for (const d of details) lines.push(renderInvoiceCsvRow(d));
  return lines.join('\r\n');
}
