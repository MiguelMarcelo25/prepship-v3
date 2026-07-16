/**
 * PS-208 guard — billing ship-date calendar-day invariant + XLSX invoice export.
 *
 * BUSINESS INVARIANT: billing_line_items.ship_date is a CALENDAR DAY stored at
 * UTC midnight. Range bounds and display NEVER timezone-convert it. The
 * canonical owner is src/lib/time/billing-day.ts; every billing endpoint
 * derives bounds from billingDayRange (`>= fromUtc AND < toUtcExclusive`) and
 * display from formatBillingDay (component split, no Date round-trip).
 *
 * Pre-PS-208 bugs this pins against (DJ's SP6447 evidence, 2026-06-11):
 *  - invoice rows -2 days: SQL `at time zone 'America/Los_Angeles'` turned a
 *    UTC-midnight May-4 row into May 3, then formatInvoiceDate's
 *    `new Date('2026-05-03')` + LA Intl formatting rendered May 02.
 *  - header -1 day: FE sent T00:00:00.000Z instants, LA formatter showed the
 *    previous day ("April 30, 2026 → May 30, 2026" for a 05/01→05/31 pick).
 *  - bounds drift: California day coercion (07:00:00Z) EXCLUDED the
 *    UTC-midnight first-day rows from every month.
 *
 * Two layers:
 *  1) Behavioral matrix on the pure helpers (offline, no DB).
 *  2) Source pins on routes/services/FE so the semantics can't silently revert.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  billingDayOf,
  billingDayRange,
  formatBillingDay,
  formatBillingLosAngelesDateTime,
} from '../src/lib/time/billing-day';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

// ── 1. Behavioral matrix ────────────────────────────────────────────────────

// Canonical plain-day inputs.
assert.equal(billingDayOf('2026-05-01'), '2026-05-01');
// Legacy FE instants: the LEADING date IS the operator-picked day.
assert.equal(billingDayOf('2026-05-01T00:00:00.000Z'), '2026-05-01');
assert.equal(billingDayOf('2026-05-31T23:59:59.999Z'), '2026-05-31');
// CA-coerced day-end shape keys to the NEXT UTC day by design — documents why
// the FE must send plain days / same-day instants (it does; pinned below).
assert.equal(billingDayOf('2026-06-01T06:59:59.999Z'), '2026-06-01');
// Garbage / missing.
assert.equal(billingDayOf('not-a-date'), null);
assert.equal(billingDayOf(undefined), null);
assert.equal(billingDayOf(null), null);
assert.equal(billingDayOf(''), null);

// Range bounds: UTC midnight inclusive lower, EXCLUSIVE day-after upper.
const may = billingDayRange('2026-05-01', '2026-05-31');
assert.ok(may, 'May range must parse');
assert.equal(may.fromDay, '2026-05-01');
assert.equal(may.toDay, '2026-05-31');
assert.equal(may.fromUtc, '2026-05-01T00:00:00.000Z');
assert.equal(may.toUtcExclusive, '2026-06-01T00:00:00.000Z');

// THE regression case: UTC-midnight first/last-day rows are INSIDE the range;
// the next period's first day is OUTSIDE. (String compare is valid for
// fixed-format UTC ISO instants.)
const mayFirstRow = '2026-05-01T00:00:00.000Z';
const mayLastRow = '2026-05-31T00:00:00.000Z';
const juneFirstRow = '2026-06-01T00:00:00.000Z';
assert.ok(mayFirstRow >= may.fromUtc && mayFirstRow < may.toUtcExclusive,
  'UTC-midnight May 1 row must be IN May (the California bounds excluded it)');
assert.ok(mayLastRow >= may.fromUtc && mayLastRow < may.toUtcExclusive,
  'UTC-midnight May 31 row must be IN May');
assert.ok(!(juneFirstRow < may.toUtcExclusive),
  'June 1 row must be OUT of May (exclusive upper bound)');

// Rollovers: month end, year end, leap/non-leap February.
assert.equal(billingDayRange('2026-12-01', '2026-12-31')?.toUtcExclusive, '2027-01-01T00:00:00.000Z');
assert.equal(billingDayRange('2026-02-01', '2026-02-28')?.toUtcExclusive, '2026-03-01T00:00:00.000Z');
assert.equal(billingDayRange('2028-02-01', '2028-02-29')?.toUtcExclusive, '2028-03-01T00:00:00.000Z');
// Single-day range covers exactly that day.
const oneDay = billingDayRange('2026-05-04', '2026-05-04');
assert.equal(oneDay?.fromUtc, '2026-05-04T00:00:00.000Z');
assert.equal(oneDay?.toUtcExclusive, '2026-05-05T00:00:00.000Z');
// Invalid input → null (route returns 400, never a silently-shifted range).
assert.equal(billingDayRange('garbage', '2026-05-31'), null);
assert.equal(billingDayRange('2026-05-01', ''), null);

// Display: component split, no timezone. The SP6447 row (stored 2026-05-04)
// must render May 04 — pre-fix it rendered May 02.
assert.equal(formatBillingDay('2026-05-04T00:00:00.000Z'), 'May 04, 2026');
assert.equal(formatBillingDay('2026-05-01'), 'May 01, 2026');
assert.equal(formatBillingDay('2026-12-31'), 'December 31, 2026');
assert.equal(formatBillingDay(null), '');
assert.equal(formatBillingDay('weird-value'), 'weird-value');
assert.equal(formatBillingLosAngelesDateTime('2026-05-04T00:00:00.000Z'), '5/4/2026 12:00 AM PT');
assert.equal(formatBillingLosAngelesDateTime('2026-05-01'), '5/1/2026 12:00 AM PT');

// ── 2. Source pins ──────────────────────────────────────────────────────────

const routes = read('src/routes/billing.ts');
const service = read('src/services/billing.ts');
const reporting = read('src/services/reporting-metrics.ts');
const helper = read('src/lib/time/billing-day.ts');
const invoiceText = read('src/routes/billing-invoice-text.ts');
const feClient = read('web/src/lib/v2-apiClient.ts');
const feTable = read('web/src/components/Views/BillingSummaryTable.tsx');
const feView = read('web/src/components/Views/BillingView.tsx');
const pkg = read('package.json');

// Canonical owner is wired in, California coercion is OUT of billing.
assert.ok(routes.includes("from '../lib/time/billing-day'"),
  'routes/billing.ts must import the canonical billing-day helpers');
assert.ok(!routes.includes('coerceCaliforniaIsoDay'),
  'routes/billing.ts must not use California day coercion (PS-208)');
assert.ok(routes.includes('billingDayRange(v.dateFrom ?? v.from'),
  'generate/details schemas must normalize through billingDayRange');
assert.ok(routes.includes('range?.toUtcExclusive') || routes.includes('range.toUtcExclusive'),
  'schemas must pass the EXCLUSIVE upper bound as dateTo');
// Invoice query: plain days accepted (no z.string().datetime() rejection).
assert.ok(!/invoiceQuery = z\.object\(\{[^}]*datetime\(\)/s.test(routes),
  'invoiceQuery must accept plain YYYY-MM-DD (datetime() validation removed)');
// SQL: actual activity-day extraction stays at UTC; billing period membership
// delegates to the persisted effective day with a legacy ship_date fallback.
assert.ok(routes.includes("to_char(b.ship_date at time zone 'UTC', 'YYYY-MM-DD')"),
  'invoice rows must extract the ship day AT UTC');
assert.ok(!/ship_date at time zone 'America\/Los_Angeles'/.test(routes),
  'ship_date must never be converted to America/Los_Angeles');
// Exclusive bound in the invoice detail query; the inclusive form is gone.
assert.ok(routes.includes('and ${invoiceEffectiveDay} < ${dateTo}::timestamptz'),
  'invoice effective-day bounds must use the exclusive upper bound');
assert.ok(!/b\.ship_date <= /.test(routes),
  'routes/billing.ts must not retain inclusive ship_date upper bounds');
// formatInvoiceDate (Date round-trip + LA Intl) is deleted; renderer uses
// formatBillingDay for header and rows.
assert.ok(!routes.includes('function formatInvoiceDate'),
  'formatInvoiceDate must stay deleted — formatBillingDay owns display');
assert.ok(routes.includes('formatBillingDay(fromDay)') && routes.includes('formatBillingDay(toDay)'),
  'invoice header must format the operator-picked days via formatBillingDay');
assert.ok(routes.includes('d.billing_effective_date ?? d.ship_date'),
  'HTML invoice rows must display the backend effective billing day with legacy fallback');
assert.ok(invoiceText.includes("INVOICE_SHIP_DATE_HEADER = 'Billing / Activity Date (Los Angeles)'"),
  'invoice date header must distinguish billing and activity dates');
assert.ok(routes.includes('INVOICE_SHIP_DATE_HEADER'),
  'HTML invoice renderer must use the shared Los Angeles ship-date/time header');

// XLSX export: same dataset (billingInvoiceData), exceljs, plain billing
// ship-date cells, SUM formulas, frozen header, attachment headers.
assert.ok(routes.includes("app.get('/invoice.xlsx'"),
  'GET /billing/invoice.xlsx route must exist');
const invoiceDataCalls = routes.split('await billingInvoiceData(').length - 1;
assert.ok(invoiceDataCalls >= 2,
  `HTML and XLSX invoices must BOTH consume billingInvoiceData (no query fork) — found ${invoiceDataCalls} call(s)`);
assert.ok(routes.includes("import('exceljs')"),
  'XLSX renderer must lazy-import exceljs');
assert.ok(routes.includes("state: 'frozen'"),
  'Invoice sheet must freeze the header row');
assert.ok(routes.includes('SUM(M${first}:M${last})'),
  'Invoice totals row must use real SUM formulas for Fulfillment Fee');
assert.ok(routes.includes('invoiceBillingActivityDateCell('),
  'XLSX invoice rows must preserve both effective billing and actual activity dates');
assert.ok(routes.includes('INVOICE_XLSX_SHIP_DATE_HEADER'),
  'XLSX invoice must use the date-only Ship Date header');
assert.ok(!routes.includes('excelDayCell'),
  'XLSX invoice must not revive Date-object day cells');
assert.ok(routes.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
  'XLSX response must carry the workbook MIME type');

// Service layer: every ship_date bound is exclusive-upper; no <= anywhere —
// in raw SQL (`<=`), drizzle sql-template (`shipDate} <=`), OR the drizzle
// builder form (lte(...)) that a literal sweep misses.
assert.ok(!/ship_date <= /.test(service) && !/shipDate} <= /.test(service),
  'services/billing.ts must not retain inclusive ship_date upper bounds');
assert.ok(!/lte\(billingPersistedEffectiveDaySql/.test(service),
  'billingDetails must bound the effective day with lt(), not lte()');
assert.ok(/lt\(billingPersistedEffectiveDaySql/.test(service),
  'billingDetails must use the exclusive effective-day lt() upper bound');
assert.ok(service.includes('and b.ship_date < ${fromIso') === false, 'sanity: lower bounds stay >=');
assert.ok(/dateFrom: string; \/\/ ISO, UTC midnight, inclusive/.test(service),
  'GenerateInput must document the calendar-day bound semantics');
// The period rebuild DELETE must be strictly bounded (else regenerating May
// wipes June 1 lines).
assert.ok(service.includes('sql`${billingPersistedEffectiveDaySql} < ${toIso}::timestamptz`'),
  'generateLineItems period DELETE must use the strict effective-day upper bound');
// The legacy actual-day projection remains UTC-midnight while the PS-434
// calendar owner receives the untouched source instant for LA-day policy.
assert.ok(/billingLegacyActivityDaySql = sql<Date \| null>`date_trunc\(/.test(service),
  'the legacy actual activity day must retain the UTC-midnight storage invariant');
assert.ok(
  service.includes("${billingSourceActivityTimestampSql} at time zone 'UTC'") &&
    service.includes("at time zone 'UTC'`"),
  'the legacy actual activity-day projection must be UTC-anchored');

// Reporting cache materializer uses the same strict bound.
assert.ok(!/b\.ship_date <= /.test(reporting),
  'billing_summary_metrics materializer must not use inclusive ship_date upper bounds');

// The canonical helper itself never reaches for a timezone. Pin CODE shapes
// (quoted zone literal, timeZone option, Intl/locale formatting) — the
// header COMMENTS legitimately mention timezones while documenting the bugs.
assert.ok(helper.includes("BILLING_LOS_ANGELES_TIME_ZONE = 'America/Los_Angeles'"),
  'billing-day.ts must name the Los Angeles billing timezone');
assert.ok(!/timeZone\s*:/.test(helper),
  'billing-day.ts must not use Intl timezone conversion for calendar-day ship_date');
assert.ok(!helper.includes('toLocale') && !/Intl\./.test(helper),
  'billing-day.ts must not use locale/Date display formatting');

// FE: billing days go to the API verbatim; the XLSX trigger exists end-to-end.
assert.ok(!feClient.includes('toIsoStart(from)'),
  'openBillingInvoice must pass the picked days verbatim (instant coercion deleted)');
assert.ok(feClient.includes('openBillingInvoiceXlsx'),
  'v2-apiClient must expose openBillingInvoiceXlsx');
assert.ok(feClient.includes('/billing/invoice.xlsx?'),
  'openBillingInvoiceXlsx must call the XLSX route');
assert.ok(feTable.includes('handleExportInvoiceXlsx') && feTable.includes('Excel'),
  'BillingSummaryTable must render the Excel export button');
assert.ok(feView.includes('openBillingInvoiceXlsx'),
  'BillingView must wire the Excel handler to the apiClient');

// Dependency present (Render + Vercel builds both need it).
assert.ok(/"exceljs"\s*:/.test(pkg), 'exceljs must be a package.json dependency');

console.log('PASS ps-208 billing calendar-day + invoice xlsx guard (behavioral matrix + source pins)');
