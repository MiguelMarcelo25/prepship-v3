import { formatBillingLosAngelesDateTime } from '../lib/time/billing-day';

export const INVOICE_SHIP_DATE_HEADER = 'Ship Date/Time (Los Angeles)';

export function invoiceShipDateTimeCell(value: unknown): string {
  return formatBillingLosAngelesDateTime(value == null ? null : String(value));
}

export function invoiceOneLineCell(value: unknown): string {
  return String(value ?? '')
    .split(/\r\n|\r|\n/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' | ');
}
