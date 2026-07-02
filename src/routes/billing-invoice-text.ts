export const INVOICE_SHIP_DATE_HEADER = 'Ship Date (CA)';

export function invoiceOneLineCell(value: unknown): string {
  return String(value ?? '')
    .split(/\r\n|\r|\n/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' | ');
}
