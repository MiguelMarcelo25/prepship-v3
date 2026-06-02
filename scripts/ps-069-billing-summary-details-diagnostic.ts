/**
 * PS-069 — read-only billing Summary vs Details consistency diagnostic.
 *
 * Reproduces, for a client + date range, exactly what the app compares when an
 * operator clicks a Summary row and the Line Items panel loads:
 *   1. The billing_summary_metrics cache row the Summary READ would serve
 *      (matched on period_from/period_to = isoDate(range) + 45-min TTL, the same
 *      key getFreshBillingSummaryMetrics uses), incl. its age/freshness.
 *   2. The LIVE billing_line_items aggregate (distinct orders + per-type totals)
 *      over the same ship_date range — what a live Summary fallback AND the
 *      Details panel are built from.
 *   3. The billingDetails row population (count of rows the Details query would
 *      return) for the same client/range/scope.
 *   4. A verdict: do Summary and Details agree, or is the Summary serving a
 *      STALE/zero-detail cache window (the PS-069 "158 orders but No line items"
 *      condition)?
 *
 * READ-ONLY. No mutations. Redacted: client id/name, counts, totals, dates only
 * — no order numbers, SKUs, addresses, payloads, or label URLs.
 *
 *   npx tsx scripts/ps-069-billing-summary-details-diagnostic.ts [clientId] [dateFrom] [dateTo]
 *   Defaults: clientId=4 (HUGRAB), dateFrom=2026-03-04, dateTo=2026-06-02
 */
import { sql } from '../src/db/client';
import { coerceCaliforniaIsoDay } from '../src/lib/time/california';

const clientId = Number.parseInt(process.argv[2] ?? '', 10) || 4;
const rawFrom = process.argv[3] ?? '2026-03-04';
const rawTo = process.argv[4] ?? '2026-06-02';

const EPS = 0.005;
function n(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
function money(v: number): string {
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`;
}
function line(): void {
  console.log('-'.repeat(68));
}
function isoDay(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  // Coerce the way /billing/summary and /billing/details do (shared schema).
  const from = coerceCaliforniaIsoDay(rawFrom, false)!;
  const to = coerceCaliforniaIsoDay(rawTo, true)!;
  const fromDay = isoDay(from); // billing_summary_metrics.period_from key
  const toDay = isoDay(to); // billing_summary_metrics.period_to key

  console.log('PS-069 billing summary/details consistency diagnostic (read-only)');
  console.log(`clientId=${clientId}  range=${rawFrom}..${rawTo}`);
  console.log(`coerced from=${from}`);
  console.log(`coerced to  =${to}`);
  console.log(`cache key period_from=${fromDay} period_to=${toDay}`);
  line();

  // ── 1. Summary cache row the READ would serve (exact key + 45-min TTL) ────
  const cacheRows = await sql<
    {
      order_count: number;
      package_total: string;
      pick_pack_total: string;
      additional_total: string;
      shipping_total: string;
      storage_total: string;
      grand_total: string;
      age_min: string;
      fresh: boolean;
    }[]
  >`
    select
      m.order_count, m.package_total::text, m.pick_pack_total::text,
      m.additional_total::text, m.shipping_total::text, m.storage_total::text,
      m.grand_total::text,
      (extract(epoch from (now() - m.updated_at)) / 60.0)::numeric(12,1)::text as age_min,
      (m.updated_at >= now() - interval '45 minutes') as fresh
    from billing_summary_metrics m
    where m.client_id = ${clientId}
      and m.period_from = ${fromDay}::date
      and m.period_to   = ${toDay}::date
  `;
  const cache = cacheRows[0] ?? null;
  console.log('1) Summary cache row for EXACT range key:');
  if (!cache) {
    console.log('   (no cache row for this exact period — Summary would fall to LIVE aggregation)');
  } else {
    console.log(
      `   orders=${cache.order_count}  grand=${money(n(cache.grand_total))}  ` +
        `box=${money(n(cache.package_total))}  ship=${money(n(cache.shipping_total))}`
    );
    console.log(
      `   age=${cache.age_min} min  fresh(<=45m, would be SERVED)=${cache.fresh ? 'YES' : 'no (ignored on read; rebuilds)'}`
    );
  }
  line();

  // ── 2. LIVE billing_line_items aggregate over the ship_date range ─────────
  // This is what a live Summary fallback computes AND what Details is built on.
  const [live] = await sql<
    {
      orders: number;
      rows: number;
      package_total: string;
      pick_pack_total: string;
      additional_total: string;
      shipping_total: string;
      storage_total: string;
      grand_total: string;
    }[]
  >`
    select
      count(distinct b.order_id)::int as orders,
      count(*)::int as rows,
      coalesce(sum(case when b.line_type='package_cost'    then b.total_cost else 0 end),0)::text as package_total,
      coalesce(sum(case when b.line_type='pick_pack'       then b.total_cost else 0 end),0)::text as pick_pack_total,
      coalesce(sum(case when b.line_type='additional_unit' then b.total_cost else 0 end),0)::text as additional_total,
      coalesce(sum(case when b.line_type='shipping'        then b.total_cost else 0 end),0)::text as shipping_total,
      coalesce(sum(case when b.line_type='storage'         then b.total_cost else 0 end),0)::text as storage_total,
      coalesce(sum(b.total_cost),0)::text as grand_total
    from billing_line_items b
    where b.client_id = ${clientId}
      and b.ship_date >= ${from}::timestamptz
      and b.ship_date <= ${to}::timestamptz
  `;
  console.log('2) LIVE billing_line_items over the same ship_date range:');
  console.log(
    `   distinct orders=${live?.orders ?? 0}  line rows=${live?.rows ?? 0}  ` +
      `grand=${money(n(live?.grand_total))}  box=${money(n(live?.package_total))}  ship=${money(n(live?.shipping_total))}`
  );
  line();

  // ── 3. Details row population (what billingDetails would return, limit 2000)─
  const [details] = await sql<{ detail_rows: number; detail_orders: number }[]>`
    select count(*)::int as detail_rows, count(distinct b.order_id)::int as detail_orders
    from billing_line_items b
    where b.client_id = ${clientId}
      and b.ship_date >= ${from}::timestamptz
      and b.ship_date <= ${to}::timestamptz
    limit 2000
  `;
  console.log('3) Details query population (billingDetails row filter):');
  console.log(`   rows that Details would render=${details?.detail_rows ?? 0} (orders=${details?.detail_orders ?? 0})`);
  line();

  // ── 4. Verdict ───────────────────────────────────────────────────────────
  const summaryOrders = cache?.fresh ? cache.order_count : n(live?.orders);
  const summarySource = cache?.fresh ? 'CACHE (fresh)' : cache ? 'LIVE (cache stale, ignored)' : 'LIVE (no cache row)';
  const detailRows = n(details?.detail_rows);
  console.log('4) Verdict:');
  console.log(`   Summary would show orders=${summaryOrders} from ${summarySource}`);
  console.log(`   Details would show ${detailRows} line rows`);
  if (summaryOrders > 0 && detailRows === 0) {
    console.log('   >> MISMATCH: Summary nonzero but Details empty.');
    if (cache?.fresh && n(live?.orders) === 0) {
      console.log('      Root cause = STALE CACHE: a fresh cache window claims orders the live');
      console.log('      billing_line_items no longer has for this range (regenerate/refresh needed).');
    } else {
      console.log('      Cache is not the cause here (live also has rows or no fresh cache);');
      console.log('      a real /billing/details API error is being hidden as empty by the client.');
    }
  } else if (summaryOrders === 0 && detailRows === 0) {
    console.log('   >> OK: both empty — legitimate empty state.');
  } else if (Math.abs(summaryOrders - n(details?.detail_orders)) === 0) {
    console.log('   >> OK: Summary and Details agree (same order count).');
  } else {
    console.log(
      `   >> NOTE: Summary orders=${summaryOrders} vs Details orders=${n(details?.detail_orders)} ` +
        '(non-empty but differ; inspect boundary/scope).'
    );
  }
  line();
  console.log('Diagnostic complete (no rows mutated).');
}

main()
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error('PS-069 diagnostic failed:', e instanceof Error ? e.message : e);
    try {
      await sql.end({ timeout: 5 });
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
