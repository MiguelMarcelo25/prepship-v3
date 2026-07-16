import { billingDayOf, formatBillingLosAngelesDateTime } from '../lib/time/billing-day';

export const INVOICE_SHIP_DATE_HEADER = 'Billing / Activity Date (Los Angeles)';
export const INVOICE_XLSX_SHIP_DATE_HEADER = 'Billing / Activity Date';

export function invoiceShipDateTimeCell(value: unknown): string {
  return formatBillingLosAngelesDateTime(value == null ? null : String(value));
}

export function invoiceShipDateCell(value: unknown): string {
  return billingDayOf(value == null ? null : String(value)) ?? String(value ?? '');
}

export function invoiceBillingActivityDateTimeCell(
  actualValue: unknown,
  effectiveValue: unknown,
): string {
  const actual = billingDayOf(actualValue == null ? null : String(actualValue));
  const effective = billingDayOf(
    effectiveValue == null ? null : String(effectiveValue),
  ) ?? actual;
  if (!effective) return '';
  const billed = formatBillingLosAngelesDateTime(effective);
  if (!actual || actual === effective) return billed;
  return `Billed ${billed} | Fulfilled ${formatBillingLosAngelesDateTime(actual)}`;
}

export function invoiceBillingActivityDateCell(
  actualValue: unknown,
  effectiveValue: unknown,
): string {
  const actual = billingDayOf(actualValue == null ? null : String(actualValue));
  const effective = billingDayOf(
    effectiveValue == null ? null : String(effectiveValue),
  ) ?? actual;
  if (!effective) return '';
  if (!actual || actual === effective) return effective;
  return `Billed ${effective} | Fulfilled ${actual}`;
}

export function invoiceOneLineCell(value: unknown): string {
  return String(value ?? '')
    .split(/\r\n|\r|\n/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' | ');
}
