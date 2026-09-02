import { INVOICE_SHIP_DATE_HEADER } from './billing-invoice-text';

/**
 * ONE ordered column contract for all three invoice artifacts: the operator HTML, the XLSX
 * workbook, and the CSV.
 *
 * WHY THIS EXISTS
 * ---------------
 * The three renderers each carried their own column list. They had drifted into carrying
 * DIFFERENT COLUMNS IN A DIFFERENT ORDER UNDER DIFFERENT NAMES:
 *
 *   HTML + CSV : 17 columns, same order, four label spellings apart
 *   XLSX       : 19 columns in a different order — led with Order # instead of the date,
 *                carried Carrier and Item Name that nothing else had, put Box Cost before
 *                Box Size (the reverse of the other two), and placed Destination AFTER the
 *                return columns instead of before them
 *
 * An operator comparing "the invoice" against "the Excel export" of the same invoice was
 * comparing two differently-shaped documents. Three lists that must agree, maintained by hand,
 * will not agree — the only fix that stays fixed is one list.
 *
 * LABEL CHOICE: THE CSV WINS EVERY DISAGREEMENT
 * ---------------------------------------------
 * Where the three disagreed on a name, the CSV's spelling is canonical and the other two moved.
 * That is deliberate and it is not arbitrary: the CSV is the machine-readable export, so its
 * header row is an EXTERNAL CONTRACT a customer may have keyed a spreadsheet or a script to.
 * Renaming an XLSX or HTML column inconveniences a reader; renaming a CSV column breaks
 * whatever is parsing it. So `SKUs`, `Pick & Pack Fee` and `Additional Units` stayed put, and
 * the workbook and the web page adopted them.
 *
 * ORDER AND APPEND RULES — READ BEFORE ADDING A COLUMN
 * ----------------------------------------------------
 * Several guards pin invoice cells BY POSITION (ps-425, ps-468, ps-490), and the XLSX totals
 * row addresses its SUM() ranges by spreadsheet COLUMN LETTER. A column inserted mid-list
 * silently shifts what those read — billing.ts says it plainly: "A stale letter here does not
 * error, it silently sums the neighbouring column."
 *
 * So: APPEND NEW COLUMNS AT THE END OF THIS LIST. Never insert one in the middle. Carrier and
 * Item Name sit last for exactly that reason — they are the two the XLSX already had and the
 * other two formats were missing, and appending them was the only way to give all three the
 * same set without moving anything that is pinned.
 */
export type InvoiceColumn = {
  /** Stable data key. Renderers bind to this; only the header is operator-visible. */
  key: string;
  /** The ONE operator-visible label. Identical in all three artifacts, by construction. */
  header: string;
  /** XLSX column width. Ignored by HTML and CSV. */
  width: number;
  /** Right-aligned and 2dp in the formats that distinguish it. */
  money?: boolean;
};

export const INVOICE_COLUMNS: readonly InvoiceColumn[] = [
  { key: 'shipDate', header: INVOICE_SHIP_DATE_HEADER, width: 26 },
  { key: 'orderNumber', header: 'Order #', width: 12 },
  { key: 'sku', header: 'SKUs', width: 30 },
  { key: 'boxSize', header: 'Box Size', width: 14 },
  { key: 'boxCost', header: 'Box Cost', width: 10, money: true },
  { key: 'qty', header: 'Qty', width: 8 },
  { key: 'pickPackFee', header: 'Pick & Pack Fee', width: 14, money: true },
  { key: 'additional', header: 'Additional Units', width: 14, money: true },
  { key: 'shipping', header: 'Shipping', width: 12, money: true },
  { key: 'storage', header: 'Storage', width: 10, money: true },
  { key: 'fulfillmentFee', header: 'Total', width: 16, money: true },
  { key: 'shipmentId', header: 'Shipment #', width: 14 },
  { key: 'destination', header: 'Destination', width: 14 },
  { key: 'returnPostage', header: 'Return Postage', width: 14, money: true },
  { key: 'returnProcessing', header: 'Return Processing', width: 16, money: true },
  { key: 'replacePostage', header: 'Replace Postage', width: 15, money: true },
  { key: 'replacePickPack', header: 'Replace Pick&Pack', width: 17, money: true },
  // Appended LAST — see the rule above. These two existed only in the workbook; the HTML and
  // the CSV were missing them, which is one of the ways the three documents disagreed.
  { key: 'carrier', header: 'Carrier', width: 12 },
  { key: 'itemName', header: 'Item Name', width: 36 },
] as const;

/** The header row, in order. The single source for all three artifacts' column names. */
export const INVOICE_COLUMN_HEADERS: readonly string[] =
  INVOICE_COLUMNS.map((column) => column.header);

/** Position of a column by key. Throws rather than returning -1: a silent -1 becomes a wrong cell. */
export function invoiceColumnIndex(key: string): number {
  const index = INVOICE_COLUMNS.findIndex((column) => column.key === key);
  if (index < 0) throw new Error(`unknown invoice column key: ${key}`);
  return index;
}

/**
 * 1-based column number to a spreadsheet letter (1 -> A, 27 -> AA).
 *
 * The XLSX totals row addresses its SUM() ranges by letter. Those letters used to be typed by
 * hand, with a comment in billing.ts warning that a stale one "does not error — it silently
 * sums the neighbouring column". Deriving them from this contract is what makes moving a
 * column safe.
 */
export function xlsxColumnLetter(columnNumber: number): string {
  let out = '';
  for (let n = columnNumber; n > 0; n = Math.floor((n - 1) / 26)) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  }
  return out;
}
