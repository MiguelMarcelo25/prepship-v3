/**
 * Canonical California-time formatting helpers for PrepShip v4.
 *
 * THE PROBLEM (audited 2026-05-07)
 * ────────────────────────────────
 * Before this module, 5+ files defined their own duplicated
 * `formatDate` / `formatDateTime` / `formatDateOnly` helpers, each
 * with slightly different rules:
 *
 *   - Some used `timeZone: 'UTC'` (correct for SS-sourced naive-PT
 *     timestamps stamped as Z, since UTC render reproduces the
 *     original Pacific wall-clock face).
 *   - Some used no `timeZone` at all (browser-local — produces
 *     7-8 hour drift if the operator is anywhere except Pacific).
 *   - Some labeled with no timezone abbreviation, leaving the
 *     operator guessing whether "4:53 PM" was their laptop time
 *     or California time.
 *
 * Boss's verdict: "I want all CA TIME, no PST". So:
 *
 *   1. Every operator-facing time renders in America/Los_Angeles
 *      (DST-aware — auto-resolves to PST in winter, PDT in summer).
 *   2. Labels say "CA" (not "PST", not "PDT", not bare).
 *   3. Two flavors of input:
 *        - `formatCa*`        — for true-UTC stored timestamps
 *                               (createdAt, updatedAt, labelCreatedAt,
 *                               billing dates, sync timestamps).
 *        - `formatNaivePt*`   — for legacy "naive PT stamped Z"
 *                               timestamps (orderDate, shipDate,
 *                               labelShipDate from ShipStation V1).
 *
 *      Both produce identical output; they differ only in the
 *      timeZone passed to Intl.DateTimeFormat.
 *
 * THE NAIVE-PT-STAMPED-Z BACKGROUND
 * ─────────────────────────────────
 * ShipStation V1 returns timestamps like "2026-04-23T21:35:42.0000000"
 * with NO timezone offset. The DR Prepper SS account is configured
 * for Pacific Time, so these naive strings are wall-clock Pacific.
 *
 * v4's order-sync stamps the naive string with "Z" before insertion
 * (see src/services/order-sync.ts:parseShipStationDate). So the DB
 * stores 21:35:42 UTC even though the wall-clock represented PT.
 * Rendering with `timeZone: 'UTC'` preserves the original face.
 *
 * Migrating to "real UTC" storage would require a data migration
 * that shifts every existing orderDate by 7-8 hours — high-risk
 * during a working week. The pragmatic compromise: KEEP the
 * existing storage convention, document it here, and use the
 * appropriate helper at every display site.
 */

const CA_TZ = 'America/Los_Angeles' as const;

type DateInput = Date | string | number | null | undefined;

function toDate(value: DateInput): Date | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const d = new Date(value as string | number);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Internal formatter cache. Intl.DateTimeFormat construction is
// expensive (~50µs per instance); caching brings list rendering
// down to a fraction of a millisecond per row.
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(timeZone: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(opts)}`;
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { ...opts, timeZone });
    fmtCache.set(key, f);
  }
  return f;
}

// ──────────────────────────────────────────────────────────────
// CA-time helpers (input is true UTC — createdAt, updatedAt, etc.)
// ──────────────────────────────────────────────────────────────

/** "May 6, 2026" — full month name, no time, no TZ label */
export function formatCaDateLong(value: DateInput): string {
  const d = toDate(value);
  if (!d) return '—';
  return fmt(CA_TZ, { month: 'short', day: 'numeric', year: 'numeric' }).format(d);
}

/** "05/06/26" — compact mm/dd/yy, no time, no TZ label */
export function formatCaDateShort(value: DateInput): string {
  const d = toDate(value);
  if (!d) return '—';
  return fmt(CA_TZ, { month: '2-digit', day: '2-digit', year: '2-digit' }).format(d);
}

/** "2:30 PM" — time only, no date, no TZ label */
export function formatCaTimeOnly(value: DateInput): string {
  const d = toDate(value);
  if (!d) return '—';
  return fmt(CA_TZ, { hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
}

/** "2:30 PM CA" — time only, with CA label */
export function formatCaTimeLabeled(value: DateInput): string {
  const d = toDate(value);
  if (!d) return '—';
  return `${formatCaTimeOnly(d)} CA`;
}

/** "05/06/26 2:30 PM" — compact date + time, no TZ label */
export function formatCaDateTime(value: DateInput): string {
  const d = toDate(value);
  if (!d) return '—';
  return `${formatCaDateShort(d)} ${formatCaTimeOnly(d)}`;
}

/** "05/06/26 2:30 PM CA" — full datetime with CA label */
export function formatCaDateTimeLabeled(value: DateInput): string {
  const d = toDate(value);
  if (!d) return '—';
  return `${formatCaDateShort(d)} ${formatCaTimeOnly(d)} CA`;
}

/** "May 6, 2:30 PM" — month-day-time without year (compact log lines) */
export function formatCaShort(value: DateInput): string {
  const d = toDate(value);
  if (!d) return '—';
  const date = fmt(CA_TZ, { month: 'short', day: 'numeric' }).format(d);
  return `${date}, ${formatCaTimeOnly(d)}`;
}

/** "Wed, May 6, 2026" — weekday + full date (used in side-panel headers) */
export function formatCaWeekday(value: DateInput): string {
  const d = toDate(value);
  if (!d) return '—';
  return fmt(CA_TZ, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(d);
}

// ──────────────────────────────────────────────────────────────
// NAIVE-PT helpers (input is "naive PT stamped Z" — orderDate, shipDate, etc.)
// ──────────────────────────────────────────────────────────────
// These render with timeZone: 'UTC' to preserve the original
// wall-clock face the SS account intended. The output is still
// labeled "CA" because the wall-clock IS California time — we just
// avoid double-shifting it.
// ──────────────────────────────────────────────────────────────

/** SS-sourced "May 6, 2026" */
export function formatNaivePtDateLong(value: DateInput): string {
  const d = toDate(value);
  if (!d) return '—';
  return fmt('UTC', { month: 'short', day: 'numeric', year: 'numeric' }).format(d);
}

/** SS-sourced "05/06/26" */
export function formatNaivePtDateShort(value: DateInput): string {
  const d = toDate(value);
  if (!d) return '—';
  return fmt('UTC', { month: '2-digit', day: '2-digit', year: '2-digit' }).format(d);
}

/** SS-sourced "2:30 PM" */
export function formatNaivePtTimeOnly(value: DateInput): string {
  const d = toDate(value);
  if (!d) return '—';
  return fmt('UTC', { hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
}

/** SS-sourced "05/06/26 2:30 PM" */
export function formatNaivePtDateTime(value: DateInput): string {
  const d = toDate(value);
  if (!d) return '—';
  return `${formatNaivePtDateShort(d)} ${formatNaivePtTimeOnly(d)}`;
}

/** SS-sourced "05/06/26 2:30 PM CA" — labeled */
export function formatNaivePtDateTimeLabeled(value: DateInput): string {
  const d = toDate(value);
  if (!d) return '—';
  return `${formatNaivePtDateShort(d)} ${formatNaivePtTimeOnly(d)} CA`;
}

/** SS-sourced "Wed, May 6, 2026" */
export function formatNaivePtWeekday(value: DateInput): string {
  const d = toDate(value);
  if (!d) return '—';
  return fmt('UTC', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(d);
}

// ──────────────────────────────────────────────────────────────
// Specialty formats kept for parity with prior helpers
// ──────────────────────────────────────────────────────────────

/** "May 6, 2:30 pm" lowercase (used in label-created strings, naive-PT). */
export function formatNaivePtLabelCreated(value: DateInput): string {
  const d = toDate(value);
  if (!d) return '—';
  const month = fmt('UTC', { month: 'short' }).format(d);
  const day = fmt('UTC', { day: 'numeric' }).format(d);
  const time = formatNaivePtTimeOnly(d).toLowerCase();
  return `${month} ${day}, ${time}`;
}

/** Re-export the canonical timezone constant for any code that
 *  needs to manually call Intl.DateTimeFormat with our zone. */
export const CALIFORNIA_TZ = CA_TZ;

/** Standard label suffix — used when manually concatenating. */
export const CA_LABEL = 'CA';
