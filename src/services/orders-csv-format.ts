// PS-137: pure CSV value formatters extracted VERBATIM from routes/orders.ts (no behavior
// change). Used ONLY by the GET /export handler. The escaping rules (Date->ISOString,
// /[",\r\n]/ detection, "" doubling), the compact null/undefined stripping, the integer-vs-
// toFixed(decimals) numeric rule, the dimension L/W/H layout, and the item/sku formatting are
// the CSV byte contract — kept character-for-character identical. Pure (no DB, no I/O).
import { finiteNumberOrNull, stringOrNull } from './orders-dto-primitives';

export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function compactCsvValue(parts: unknown[], separator = ', '): string {
  return parts
    .map((part) => {
      if (part === null || part === undefined) return '';
      const value = String(part).trim();
      return value === 'null' || value === 'undefined' ? '' : value;
    })
    .filter(Boolean)
    .join(separator);
}

export function formatCsvNumber(value: unknown, decimals = 2): string | number {
  const n = finiteNumberOrNull(value);
  if (n === null) return '';
  return Number.isInteger(n) ? n : Number(n.toFixed(decimals));
}

export function formatCsvDimensions(
  length: unknown,
  width: unknown,
  height: unknown
): string {
  const dims = [
    ['L', finiteNumberOrNull(length)],
    ['W', finiteNumberOrNull(width)],
    ['H', finiteNumberOrNull(height)],
  ] as const;
  if (dims.every(([, value]) => value !== null)) {
    return dims.map(([, value]) => formatCsvNumber(value)).join(' x ');
  }
  return dims
    .filter(([, value]) => value !== null)
    .map(([label, value]) => `${label} ${formatCsvNumber(value)}`)
    .join(' ');
}

export function formatCsvItems(items: Array<Record<string, unknown>>): string {
  return items
    .map((item) => {
      const qty = finiteNumberOrNull(item.quantity);
      const sku = stringOrNull(item.sku);
      const name = stringOrNull(item.name);
      return compactCsvValue([qty !== null && qty > 0 ? `${qty}x` : '', sku, name], ' - ');
    })
    .filter(Boolean)
    .join(' | ');
}

export function formatCsvSkuList(items: Array<Record<string, unknown>>): string {
  return [
    ...new Set(
      items
        .map((item) => stringOrNull(item.sku))
        .filter((sku): sku is string => Boolean(sku))
    ),
  ].join(', ');
}
