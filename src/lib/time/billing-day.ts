/**
 * PS-208 — the canonical owner of billing calendar-day semantics.
 *
 * BUSINESS INVARIANT: `billing_line_items.ship_date` is a CALENDAR DAY, not an
 * instant. Rows are stored as UTC midnight of the ship day (source chain:
 * shipments.ship_date / orders.raw->>'shipDate', themselves date-only). NO
 * instant timezone conversion is allowed for billing-range inclusion. Invoice
 * display may label that billing day as Los Angeles time, but it must not
 * convert UTC midnight into the prior Pacific evening.
 *
 * Every billing endpoint (generate, status, summary, details, HTML/PDF
 * invoice, XLSX invoice) derives its range bounds and display strings from
 * THIS module, so the endpoints can never again disagree about which calendar
 * days belong to a month.
 *
 * The pre-PS-208 bugs this replaces:
 *  - rows shifted -2 days: `to_char(ship_date AT TIME ZONE 'America/Los_
 *    Angeles')` turned 05-01T00:00Z into 04-30, then formatInvoiceDate's
 *    `new Date('2026-04-30')` + LA Intl formatting rendered April 29.
 *  - header shifted -1 day: the FE sent `T00:00:00.000Z` instants which the
 *    LA formatter rendered as the previous day.
 *  - bounds drift: some endpoints used California day bounds
 *    (05-01T07:00:00Z) which EXCLUDED the UTC-midnight May-1 rows.
 */

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})/;
export const BILLING_LOS_ANGELES_TIME_ZONE = 'America/Los_Angeles';
export const BILLING_LOS_ANGELES_TIME_LABEL = 'PT';

/**
 * The operator-selected calendar day carried by a raw param. Accepts plain
 * YYYY-MM-DD (the canonical form) and legacy ISO instants (T00:00:00.000Z
 * from the old FE export, or CA-coerced T07:00:00Z strings) — in every legacy
 * shape the LEADING date component IS the day the operator picked, so we take
 * it verbatim and never let a timezone reinterpret it.
 */
export function billingDayOf(raw: string | null | undefined): string | null {
  const match = DAY_RE.exec(String(raw ?? '').trim());
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function nextDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  // Deterministic UTC date arithmetic on the COMPONENTS — no local timezone
  // involvement, no reinterpretation of the day.
  const ms = Date.UTC(y!, (m! - 1), d! + 1);
  const next = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

export type BillingDayRange = {
  /** Operator-picked first day, plain YYYY-MM-DD (display + audit). */
  fromDay: string;
  /** Operator-picked last day, plain YYYY-MM-DD (display + audit). */
  toDay: string;
  /** Inclusive lower bound: UTC midnight of fromDay — matches storage. */
  fromUtc: string;
  /** EXCLUSIVE upper bound: UTC midnight of the day AFTER toDay. */
  toUtcExclusive: string;
};

/**
 * Range bounds for `ship_date >= fromUtc AND ship_date < toUtcExclusive`.
 * Explicit UTC instants so the comparison is immune to the DB session
 * timezone; because rows are stored at UTC midnight, [May 1 .. May 31]
 * includes both endpoint days and excludes April entirely.
 */
export function billingDayRange(rawFrom: string, rawTo: string): BillingDayRange | null {
  const fromDay = billingDayOf(rawFrom);
  const toDay = billingDayOf(rawTo);
  if (!fromDay || !toDay) return null;
  return {
    fromDay,
    toDay,
    fromUtc: `${fromDay}T00:00:00.000Z`,
    toUtcExclusive: `${nextDay(toDay)}T00:00:00.000Z`,
  };
}

/**
 * Display a calendar day as "May 01, 2026" by COMPONENT SPLIT — no `new
 * Date()` round-trip, no timeZone option, nothing that could shift the day.
 * Accepts the same legacy instant shapes as billingDayOf.
 */
export function formatBillingDay(raw: string | null | undefined): string {
  const day = billingDayOf(raw);
  if (!day) return raw == null ? '' : String(raw);
  const [y, m, d] = day.split('-');
  const month = MONTHS[Number(m) - 1];
  if (!month) return day;
  return `${month} ${d}, ${y}`;
}

/**
 * Display the billing calendar day as a Los Angeles billing timestamp. The
 * source has no real time-of-day, so this intentionally shows the start of the
 * Los Angeles billing day instead of converting UTC midnight into the prior
 * Pacific evening.
 */
export function formatBillingLosAngelesDateTime(raw: string | null | undefined): string {
  const day = billingDayOf(raw);
  if (!day) return raw == null ? '' : String(raw);
  const [y, m, d] = day.split('-').map(Number);
  return `${m}/${d}/${y} 12:00 AM ${BILLING_LOS_ANGELES_TIME_LABEL}`;
}
