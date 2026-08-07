/**
 * PS-495 billing coverage gap guard.
 *
 * Offline: the REAL loader and rollups against a stubbed executor. No DB, no provider.
 *
 * The defect: shipped orders with a real, non-voided shipment and ZERO rows in
 * billing_line_items. Not `shipping_missing` at $0.00 — those at least reached billing.
 * These were never billed anything: no shipping, no pick/pack, no package.
 *
 * The cause, measured 2026-08-07: billing generation is a point-in-time snapshot of a
 * period, and 448 of 450 gap orders had their shipment sync in MORE THAN A WEEK after the
 * ship date (averaging 207 days for one store, most arriving in a single 2026-04-23 bulk
 * sync). The period had already been generated; nothing regenerates one when a late
 * shipment lands inside it. The gaps are whole DAYS, not scattered orders — 31 of 33
 * affected shipping days had zero billed orders, sitting between fully-billed days.
 *
 * THE thing this guard protects is the two exclusions. Without them the number is either
 * permanently non-zero (and therefore ignored) or wildly overstated:
 *   1. Orders after the client's billing frontier are ordinary generation lag.
 *   2. Clients who have never been billed for anything are not billing clients.
 */
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ??= 'postgres://user:pass@127.0.0.1:5432/prepship_guard';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service';
process.env.SUPABASE_JWT_SECRET ??= 'secret';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

const {
  loadBillingCoverageGaps,
  summarizeBillingCoverageGaps,
  groupBillingCoverageGapsByClient,
} = await import('../src/services/billing-coverage-gap');

// ── the loader maps provider rows faithfully ───────────────────────────────
let capturedSql = '';
const executor = (rows: unknown[]) => ({
  execute: async (query: unknown) => {
    capturedSql = String((query as { queryChunks?: unknown[] })?.queryChunks
      ? JSON.stringify((query as { queryChunks: unknown[] }).queryChunks)
      : query);
    return rows as never;
  },
});

const gaps = await loadBillingCoverageGaps(executor([
  { client_id: 7, store_id: 356678, order_id: 112699, order_number: '05-14348-07475',
    ship_date: '2026-03-05', shipment_id: 8071, postage_cost: '59.01', synced_days_late: '41.7' },
  { client_id: 7, store_id: 356678, order_id: 112700, order_number: '05-14348-07475',
    ship_date: '2026-03-06', shipment_id: 8077, postage_cost: '49.40', synced_days_late: '41.2' },
  { client_id: 9, store_id: 277422, order_id: 5, order_number: null,
    ship_date: '2024-01-29', shipment_id: 99, postage_cost: '9.00', synced_days_late: null },
]) as never);

check('every gap row is returned', gaps.length === 3);
check('postage cost is numeric, not the raw string', gaps[0]!.postageCost === 59.01, gaps[0]);
check('a null order number survives as null rather than "null"', gaps[2]!.orderNumber === null);
check('sync lateness is rounded to whole days', gaps[0]!.syncedDaysLate === 42, gaps[0]);
check('an unknown sync lateness stays null rather than becoming 0',
  gaps[2]!.syncedDaysLate === null, gaps[2]);

// ── rollups ────────────────────────────────────────────────────────────────
const summary = summarizeBillingCoverageGaps(gaps);
check('the summary counts every gap order', summary.orders === 3);
check('postage totals exactly, with no float drift',
  summary.postageCost === 117.41, summary);
check('the summary reports the true earliest ship date',
  summary.earliestShipDate === '2024-01-29', summary);
check('the summary reports the true latest ship date',
  summary.latestShipDate === '2026-03-06', summary);
check('an empty gap set summarizes to zero, not NaN',
  JSON.stringify(summarizeBillingCoverageGaps([]))
  === JSON.stringify({ orders: 0, postageCost: 0, earliestShipDate: null, latestShipDate: null }));

// The fixture above happens to sum exactly in floating point, so it does NOT exercise the
// rounding — an earlier version of this guard passed with the rounding removed. These
// values drift: 10.10 + 20.20 + 30.30 is 60.599999999999994 in IEEE-754. A money total
// that renders as 60.599999999999994 on an operator screen is a bug.
{
  const drifting = [10.10, 20.20, 30.30].map((postageCost, i) => ({
    clientId: 1, storeId: null, orderId: i, orderNumber: null,
    shipDate: '2026-01-01', shipmentId: i, postageCost, syncedDaysLate: null,
  }));
  check('a total that drifts in floating point is rounded to cents',
    summarizeBillingCoverageGaps(drifting).postageCost === 60.6,
    summarizeBillingCoverageGaps(drifting).postageCost);
  check('the per-client rollup rounds the same way',
    groupBillingCoverageGapsByClient(drifting)[0]!.postageCost === 60.6);
}

const byClient = groupBillingCoverageGapsByClient(gaps);
check('gaps roll up per client, because remediation is decided per client',
  byClient.length === 2);
check('clients are ordered by money at stake',
  byClient[0]!.clientId === 7 && byClient[0]!.postageCost === 108.41, byClient);

// ── THE exclusions ─────────────────────────────────────────────────────────
const src = readFileSync('src/services/billing-coverage-gap.ts', 'utf8').replace(/\r\n/g, '\n');

// Without the frontier, every shipment from today counts as a gap and the alert is
// permanently non-zero -- 6 of 454 orders were this ordinary lag when measured.
check('the query excludes orders at or after the client billing frontier',
  /s\.ship_date::date < f\.last_billed_day/.test(src),
  'without this, normal generation lag is reported as a defect');
check('the frontier is computed from BILLED shipments only',
  /max\(s\.ship_date::date\) as last_billed_day[\s\S]{0,300}?exists \(select 1 from billing_line_items/.test(src));
// A client with no billing at all has no frontier row, so the join drops them. Two
// production stores carry 26,495 and 226 orders with zero billing between them.
check('the frontier is an INNER join, so never-billed clients are excluded entirely',
  /join frontier f on f\.client_id = o\.client_id/.test(src)
  && !/left join frontier/.test(src),
  'a left join would report every order of a non-billing client as a gap');
check('voided shipments never count as a shipped parcel',
  (src.match(/s\.voided = false/g) ?? []).length >= 2);
check('only orders with NO billing lines at all are reported',
  /not exists \(select 1 from billing_line_items b where b\.order_id = o\.id\)/.test(src));

// ── placement: detect, do not repair ───────────────────────────────────────
const route = readFileSync('src/routes/billing.ts', 'utf8').replace(/\r\n/g, '\n');
const routeCode = route
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

check('the gap report is exposed on a route, not left unread',
  /app\.get\('\/coverage-gaps'/.test(routeCode),
  'an owner nothing calls is the retained-but-unread antipattern');
check('the endpoint applies the same client scoping as every other billing route',
  /canAccessBillingClient\(row\.clientId, scoped\)/.test(routeCode),
  'a gap report must not become a way to enumerate another client’s orders');
// Regeneration writes money against orders shipped as long ago as 2024. That is an
// operator decision, so this surface reports and stops.
check('the detector never writes billing rows itself',
  !/insert into billing_line_items/i.test(src) && !/update billing_line_items/i.test(src));
check('the service is read-only SQL',
  !/\b(insert|update|delete)\b/i.test(src.replace(/\/\*[\s\S]*?\*\//g, '')));

if (failures > 0) {
  console.error(`\nFAIL PS-495 billing coverage gap guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-495 billing coverage gap guard');
