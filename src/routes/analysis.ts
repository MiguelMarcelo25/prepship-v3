import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client';
import { EXCLUDED_STORE_IDS_SQL } from '../config/prepship';
import { activeClientPredicateSql, testOrInactiveClientPredicateSql } from '../lib/active-client-predicate';
import { getClientStoreScope, type ClientStoreScope } from '../lib/client-store-scope';
import { hasAppPermission } from '../middleware/auth';

// v2-parity: exact list from apps/api/src/common/prepship-config.ts.
// v4 previously used a broad regex `(priority|express|overnight|expedited|...)`
// which over-matched `usps_priority_mail` as expedited. v2 treats USPS priority
// as standard; only priority_mail_express is expedited. The regex was inflating
// AnalysisView "expedited" counts for every USPS priority shipment.
const EXPEDITED_SERVICES = [
  'ups_2nd_day_air', 'ups_2nd_day_air_am',
  'ups_next_day_air', 'ups_next_day_air_saver', 'ups_next_day_air_early_am',
  'ups_3_day_select',
  'usps_priority_mail_express',
  'fedex_2day', 'fedex_2day_am',
  'fedex_express_saver',
  'fedex_priority_overnight', 'fedex_standard_overnight', 'fedex_first_overnight',
] as const;

const EXPEDITED_SERVICES_SQL = sql`ARRAY[${sql.join(EXPEDITED_SERVICES.map((s) => sql`${s}`), sql`, `)}]::text[]`;

const app = new Hono();

app.get('/overview', async (c) => {
  const scope = analysisScopeFromContext(c);
  const canViewFinancials = canViewAnalysisFinancials(c);
  // 2026-05-12 visibility fix: every sub-query excludes rows tied to
  // either (a) is_test clients (sandbox / smoke-test data) or (b)
  // inactive clients (operator disabled them via Settings → Clients).
  // Previously only (a) was filtered — which left disabled clients'
  // KPIs leaking into the Dashboard top cards. Pattern matches the
  // /orders and /init/counts predicates so visibility is now uniform
  // across the app. `coalesce(c.active, true) = false` is the right
  // half of the OR: only EXPLICITLY active=false rows are excluded;
  // legacy NULL-active rows stay visible (lenient default).
  const rows = await db.execute<{
    orders_today: number;
    orders_week: number;
    orders_month: number;
    shipped_today: number;
    shipped_week: number;
    shipped_month: number;
    shipping_cost_month: string;
  }>(sql`
    select
      (select count(*)::int from orders o
         where order_date >= date_trunc('day', now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles'
           and ${analysisOrderScopePredicate(scope)}
           and not exists (select 1 from clients c where c.id = o.client_id and ${sql.raw(testOrInactiveClientPredicateSql('c'))})) as orders_today,
      (select count(*)::int from orders o
         where order_date >= date_trunc('week', now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles'
           and ${analysisOrderScopePredicate(scope)}
           and not exists (select 1 from clients c where c.id = o.client_id and ${sql.raw(testOrInactiveClientPredicateSql('c'))})) as orders_week,
      (select count(*)::int from orders o
         where order_date >= date_trunc('month', now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles'
           and ${analysisOrderScopePredicate(scope)}
           and not exists (select 1 from clients c where c.id = o.client_id and ${sql.raw(testOrInactiveClientPredicateSql('c'))})) as orders_month,
      (select count(*)::int from shipments s
         where s.voided = false and s.ship_date >= date_trunc('day', now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles'
           and ${analysisShipmentScopePredicate(scope)}
           and not exists (select 1 from clients c where c.id = s.client_id and ${sql.raw(testOrInactiveClientPredicateSql('c'))})) as shipped_today,
      (select count(*)::int from shipments s
         where s.voided = false and s.ship_date >= date_trunc('week', now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles'
           and ${analysisShipmentScopePredicate(scope)}
           and not exists (select 1 from clients c where c.id = s.client_id and ${sql.raw(testOrInactiveClientPredicateSql('c'))})) as shipped_week,
      (select count(*)::int from shipments s
         where s.voided = false and s.ship_date >= date_trunc('month', now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles'
           and ${analysisShipmentScopePredicate(scope)}
           and not exists (select 1 from clients c where c.id = s.client_id and ${sql.raw(testOrInactiveClientPredicateSql('c'))})) as shipped_month,
      (select coalesce(sum(marked_cost),0)::text
         from (
           select
             case
               when lower(cost_model.markup->>'type') in ('pct', 'percent')
                 then cost_model.base_cost * (1 + coalesce(nullif(cost_model.markup->>'value', '')::numeric, 0) / 100)
               when lower(cost_model.markup->>'type') in ('amount', 'flat')
                 then cost_model.base_cost + coalesce(nullif(cost_model.markup->>'value', '')::numeric, 0)
               else cost_model.base_cost
             end as marked_cost
           from shipments s
           left join settings pid_markup
             on pid_markup.key = 'markup.' || coalesce(s.provider_account_id, s.label_provider, s.selected_pid)::text
           left join settings carrier_markup
             on carrier_markup.key in ('markup.' || s.carrier_code, 'markup.' || lower(s.carrier_code))
           cross join lateral (
             select
               (coalesce(s.cost, s.label_cost, 0) + coalesce(s.other_cost, 0))::numeric as base_cost,
               case
                 when coalesce(pid_markup.value, carrier_markup.value) ~ '^\\s*\\{'
                   then coalesce(pid_markup.value, carrier_markup.value)::jsonb
                 else null::jsonb
               end as markup
           ) cost_model
           where s.voided = false and s.ship_date >= date_trunc('month', now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles'
             and ${analysisShipmentScopePredicate(scope)}
             and not exists (select 1 from clients c where c.id = s.client_id and ${sql.raw(testOrInactiveClientPredicateSql('c'))})
         ) shipping_costs) as shipping_cost_month
  `);
  const r = rows[0] ?? {
    orders_today: 0,
    orders_week: 0,
    orders_month: 0,
    shipped_today: 0,
    shipped_week: 0,
    shipped_month: 0,
    shipping_cost_month: '0',
  };
  return c.json({
    ordersToday: r.orders_today,
    ordersWeek: r.orders_week,
    ordersMonth: r.orders_month,
    shippedToday: r.shipped_today,
    shippedWeek: r.shipped_week,
    shippedMonth: r.shipped_month,
    shippingCostMonth: canViewFinancials ? r.shipping_cost_month : '0',
  });
});

const rangeQuery = z.object({
  dateFrom: z.string().datetime(),
  dateTo: z.string().datetime(),
});

app.get('/daily-shipments', zValidator('query', rangeQuery), async (c) => {
  const q = c.req.valid('query');
  const fromIso = new Date(q.dateFrom).toISOString();
  const toIso = new Date(q.dateTo).toISOString();
  const dailyShipmentsScope = analysisScopeFromContext(c);
  const canViewFinancials = canViewAnalysisFinancials(c);
  const rows = await db.execute<{
    day: string;
    count: number;
    total_cost: string;
  }>(sql`
    select
      to_char(date_trunc('day', s.ship_date at time zone 'America/Los_Angeles'), 'YYYY-MM-DD') as day,
      count(*)::int as count,
      coalesce(sum(
        case
          when lower(cost_model.markup->>'type') in ('pct', 'percent')
            then cost_model.base_cost * (1 + coalesce(nullif(cost_model.markup->>'value', '')::numeric, 0) / 100)
          when lower(cost_model.markup->>'type') in ('amount', 'flat')
            then cost_model.base_cost + coalesce(nullif(cost_model.markup->>'value', '')::numeric, 0)
          else cost_model.base_cost
        end
      ), 0)::text as total_cost
    from shipments s
    left join settings pid_markup
      on pid_markup.key = 'markup.' || coalesce(s.provider_account_id, s.label_provider, s.selected_pid)::text
    left join settings carrier_markup
      on carrier_markup.key in ('markup.' || s.carrier_code, 'markup.' || lower(s.carrier_code))
    cross join lateral (
      select
        (coalesce(s.cost, s.label_cost, 0) + coalesce(s.other_cost, 0))::numeric as base_cost,
        case
          when coalesce(pid_markup.value, carrier_markup.value) ~ '^\\s*\\{'
            then coalesce(pid_markup.value, carrier_markup.value)::jsonb
          else null::jsonb
        end as markup
    ) cost_model
    where s.voided = false
      and s.ship_date >= ${fromIso}::timestamptz
      and s.ship_date <= ${toIso}::timestamptz
      and ${analysisShipmentScopePredicate(dailyShipmentsScope)}
      -- 2026-05-12 visibility fix: also exclude inactive clients
      -- (operator disabled them in Settings → Clients) so the timeseries
      -- chart stops including their historical shipments.
      and not exists (select 1 from clients c where c.id = s.client_id and ${sql.raw(testOrInactiveClientPredicateSql('c'))})
    group by date_trunc('day', s.ship_date at time zone 'America/Los_Angeles')
    order by date_trunc('day', s.ship_date at time zone 'America/Los_Angeles') desc
  `);
  return c.json({
    data: canViewFinancials
      ? rows
      : rows.map((row) => ({ ...row, total_cost: '0' })),
  });
});

const topSkusQuery = rangeQuery.extend({
  clientId: z.coerce.number().int().optional(),
  storeId: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().positive().max(200).optional().default(50),
});

const skuDailyQuery = rangeQuery.extend({
  clientId: z.coerce.number().int().optional(),
  storeId: z.coerce.number().int().optional(),
  top: z.coerce.number().int().positive().max(10).optional(),
  topN: z.coerce.number().int().positive().max(15).optional(),
  hideTestOrders: z.coerce.boolean().optional().default(false),
  // 2026-05-13: per-caller toggle that decides whether cancelled
  // orders count toward the analytics. Default is false (preserves
  // historical Analysis-page behavior — operators reading the
  // Analysis page see only fulfilled-or-fulfilling units). The new
  // Dashboard passes ?includeCancelled=true so its KPIs (which
  // already aggregate the full /orders set) stay consistent with
  // the trend / top SKUs / heatmap on the same page. Without this
  // flag, the dashboard would show e.g. "Total 30-Day Units = 852"
  // in the KPI card while the trend chart sums to a smaller
  // number (cancelled excluded), confusing operators.
  includeCancelled: z.coerce.boolean().optional().default(false),
});

type ClientStoreScopeQuery = {
  clientIds?: number[];
  storeIds?: number[];
  scopeRestricted?: boolean;
  canViewFinancials?: boolean;
};
type AnalysisScopeInput = ClientStoreScopeQuery & { storeId?: number; isRestricted?: boolean };

export type SkuDailyQuery = z.infer<typeof skuDailyQuery> & ClientStoreScopeQuery;

function buildDateBuckets(fromIso: string, toIso: string) {
  const startMs = Date.parse(`${fromIso.slice(0, 10)}T00:00:00.000Z`);
  const endMs = Date.parse(`${toIso.slice(0, 10)}T00:00:00.000Z`);
  const days = Math.max(1, Math.round((endMs - startMs) / 86_400_000) + 1);
  return Array.from({ length: days }, (_, index) =>
    new Date(startMs + index * 86_400_000).toISOString().slice(0, 10)
  );
}

function normalizeScopeIds(values: number[] | undefined): number[] {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );
}

function intArraySql(values: number[]): SQL {
  return sql`array[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::int[]`;
}

function analysisScopeFromContext(c: Context): ClientStoreScope {
  return getClientStoreScope({
    email: c.get('email' as never) as string | undefined,
    role: c.get('role' as never) as string | undefined,
    permissions: c.get('permissions' as never) as string[] | undefined,
    clientIds: c.get('clientIds' as never) as number[] | undefined,
    storeIds: c.get('storeIds' as never) as number[] | undefined,
  });
}

function canViewAnalysisFinancials(c: Context): boolean {
  return hasAppPermission(
    {
      email: c.get('email' as never) as string | undefined,
      role: c.get('role' as never) as string | undefined,
      permissions: c.get('permissions' as never) as string[] | undefined,
    },
    'financials:read'
  );
}

function withAnalysisScope<T extends object>(c: Context, q: T): T & ClientStoreScopeQuery {
  const scope = analysisScopeFromContext(c);
  return {
    ...q,
    clientIds: scope.clientIds,
    storeIds: scope.storeIds,
    scopeRestricted: scope.isRestricted,
    canViewFinancials: canViewAnalysisFinancials(c),
  };
}

function analysisOrderScopePredicate(q: AnalysisScopeInput): SQL {
  const predicates: SQL[] = [];
  const clientIds = normalizeScopeIds(q.clientIds);
  const storeIds = normalizeScopeIds([
    ...(q.storeIds ?? []),
    ...(q.storeId !== undefined ? [q.storeId] : []),
  ]);

  if (clientIds.length) {
    predicates.push(sql`o.client_id = any(${intArraySql(clientIds)})`);
  }
  if (storeIds.length) {
    predicates.push(sql`o.store_id = any(${intArraySql(storeIds)})`);
  }
  if (!predicates.length) {
    return q.scopeRestricted === true || q.isRestricted === true ? sql`false` : sql`true`;
  }
  if (predicates.length === 1) return predicates[0]!;
  return sql`(${sql.join(predicates, sql` or `)})`;
}

function analysisShipmentScopePredicate(q: AnalysisScopeInput): SQL {
  const predicates: SQL[] = [];
  const clientIds = normalizeScopeIds(q.clientIds);
  const storeIds = normalizeScopeIds(q.storeIds);

  if (clientIds.length) {
    predicates.push(sql`s.client_id = any(${intArraySql(clientIds)})`);
  }
  if (storeIds.length) {
    predicates.push(sql`exists (
      select 1 from clients scoped_client
      where scoped_client.id = s.client_id
        and scoped_client.store_ids && ${intArraySql(storeIds)}
    )`);
  }
  if (!predicates.length) {
    return q.scopeRestricted === true || q.isRestricted === true ? sql`false` : sql`true`;
  }
  if (predicates.length === 1) return predicates[0]!;
  return sql`(${sql.join(predicates, sql` or `)})`;
}

export async function getSkuDailyFromOrderItems(q: SkuDailyQuery) {
  const fromIso = new Date(q.dateFrom).toISOString();
  const toIso = new Date(q.dateTo).toISOString();
  const cid: number | null = q.clientId ?? null;
  const topLimit = q.top ?? q.topN ?? 5;
  const cancelledFilter = q.includeCancelled
    ? sql`true`
    : sql`o.order_status not in ('cancelled')`;
  const testOrderFilter = q.hideTestOrders
    ? sql`and not (
        exists (
          select 1 from clients test_client
          where test_client.id = o.client_id
            and test_client.is_test = true
        )
        or coalesce(o.order_number, '') ilike 'TESTING-%'
        or o.raw @> '{"test": true}'::jsonb
        or o.raw @> '{"testing": true}'::jsonb
      )`
    : sql``;

  const top = await db.execute<{ sku: string; name: string | null; total_qty: number }>(sql`
    with item_rows as (
      select
        oi.sku as sku,
        coalesce(nullif(oi.name, ''), '-') as name,
        greatest(0, coalesce(oi.quantity, 0))::int as qty
      from order_items oi
      join orders o on o.id = oi.order_id
      where ${cancelledFilter}
        and o.order_date >= ${fromIso}::timestamptz
        and o.order_date <= ${toIso}::timestamptz
        ${testOrderFilter}
        and o.store_id not in (${sql.raw(EXCLUDED_STORE_IDS_SQL)})
        and (${cid}::int is null or o.client_id = ${cid}::int)
        and ${analysisOrderScopePredicate(q)}
        and oi.quantity > 0
        and oi.sku <> ''
        and (
          o.client_id is null
          or exists (
            select 1 from clients c
            where c.id = o.client_id and ${sql.raw(activeClientPredicateSql('c'))}
          )
        )
    )
    select
      sku,
      (array_agg(name order by length(name) desc))[1] as name,
      sum(qty)::int as total_qty
    from item_rows
    group by sku
    order by total_qty desc
    limit ${topLimit}
  `);

  const dateBuckets = buildDateBuckets(fromIso, toIso);
  const skus = top.map((t) => t.sku);
  if (!skus.length) {
    return { topSkus: [], days: dateBuckets.map((day) => ({ day })) };
  }

  const skuList = sql.join(
    skus.map((s) => sql`${s}`),
    sql`, `
  );

  const daily = await db.execute<{ day: string; sku: string; qty: number }>(sql`
    select
      to_char(o.order_date at time zone 'America/Los_Angeles', 'YYYY-MM-DD') as day,
      oi.sku as sku,
      sum(greatest(0, coalesce(oi.quantity, 0)))::int as qty
    from order_items oi
    join orders o on o.id = oi.order_id
    where ${cancelledFilter}
      and o.order_date >= ${fromIso}::timestamptz
      and o.order_date <= ${toIso}::timestamptz
      ${testOrderFilter}
      and o.store_id not in (${sql.raw(EXCLUDED_STORE_IDS_SQL)})
      and (${cid}::int is null or o.client_id = ${cid}::int)
      and ${analysisOrderScopePredicate(q)}
      and oi.quantity > 0
      and oi.sku <> ''
      and (
        o.client_id is null
        or exists (
          select 1 from clients c
          where c.id = o.client_id and ${sql.raw(activeClientPredicateSql('c'))}
        )
      )
      and oi.sku in (${skuList})
    group by to_char(o.order_date at time zone 'America/Los_Angeles', 'YYYY-MM-DD'), sku
    order by to_char(o.order_date at time zone 'America/Los_Angeles', 'YYYY-MM-DD') asc
  `);

  const byDay = new Map<string, Record<string, number | string>>();
  for (const row of daily) {
    const bucket = byDay.get(row.day) ?? { day: row.day };
    bucket[row.sku] = row.qty;
    byDay.set(row.day, bucket);
  }
  const days = dateBuckets.map((d) => {
    const b = byDay.get(d) ?? { day: d };
    for (const s of skus) if (b[s] === undefined) b[s] = 0;
    return b;
  });

  return { topSkus: top, days };
}

async function getSkuDaily(q: SkuDailyQuery) {
  return getSkuDailyFromOrderItems(q);
}

app.get('/sku-daily', zValidator('query', skuDailyQuery), async (c) => {
  return c.json(await getSkuDaily(withAnalysisScope(c, c.req.valid('query'))));
});

const skuBreakdownQuery = rangeQuery.extend({
  clientId: z.coerce.number().int().optional(),
  storeId: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().positive().max(2000).optional().default(2000),
  hideTestOrders: z.coerce.boolean().optional().default(false),
  // 2026-05-13: same caller-controlled cancelled-orders toggle as
  // skuDailyQuery (see comment there for full rationale). The
  // Dashboard's SKU Performance Summary panel passes true to align
  // with its own KPI cards; the Analysis page leaves it false.
  includeCancelled: z.coerce.boolean().optional().default(false),
});

export type SkuBreakdownQuery = z.infer<typeof skuBreakdownQuery> & ClientStoreScopeQuery;
type SkuBreakdownRow = {
  sku: string;
  name: string | null;
  image_url: string | null;
  inv_sku_id: number | null;
  client_id: number | null;
  client_name: string | null;
  orders: number;
  pending: number;
  ext_shipped: number;
  std_orders: number;
  std_ship_count: number;
  std_total: string;
  std_qty_total: number;
  exp_orders: number;
  exp_ship_count: number;
  exp_total: string;
  exp_qty_total: number;
  ship_count_with_cost: number;
  total_qty: number;
  total_shipping: string;
  // 2026-05-12: revenue + avg-selling-price feed the Analysis page's
  // new "Total Revenue" and "Avg Selling Price" columns. total_revenue
  // is summed server-side as SUM(unit_price × qty) across every non-
  // cancelled order containing this SKU. avg_selling_price is derived
  // on the FE as total_revenue / total_qty (units, not orders) so we
  // don't ship two numbers when one suffices. unit_price comes from
  // orders.items.unitPrice (camel) or orders.items.unit_price (snake)
  // — both shapes appear depending on the marketplace integration that
  // ingested the order.
  total_revenue: string;
  // 2026-05-13: per-SKU selling-fee total (commission + shipping
  // commission + processing fees from Walmart Marketplace; future
  // marketplaces add in). Allocated per-unit just like
  // total_shipping above. FE renders this in the new "Selling Fees"
  // column and derives `profit = revenue - shipping - selling_fee`
  // for the "Profit" column. Returns "0" (not null) for SKUs whose
  // orders haven't been synced via api/carriers/walmart/fees.ts yet.
  total_selling_fee: string;
  // Per-day unit map: { 'YYYY-MM-DD': units } for each day this SKU had
  // activity in the selected range. The route pads this to a dense
  // aligned array (one slot per day in the range, zeros for quiet days)
  // before returning to clients so the FE can render a sparkline
  // without any further math. See `daily_qty_map` in the SQL below.
  daily_qty_map: Record<string, number> | null;
};

// Runtime schema-bootstrap for the selling-fee columns. Idempotent
// — ADD COLUMN IF NOT EXISTS is essentially free when the column
// already exists (catalog lookup, no table rewrite). This belt-and-
// suspenders pattern keeps the route self-healing if the formal
// migration (drizzle/0019_selling_fees.sql) hasn't been applied yet:
// the SELECT below references o.selling_fee, so without these
// columns the query fails with "column o.selling_fee does not
// exist" and the whole Analysis page breaks (2026-05-13 operator
// report). The selling_fee_source index is migration-owned, not
// request-time DDL. Cached behind a module-level flag so we only hit
// the DB catalog once per process lifetime.
let sellingFeeColumnsEnsured = false;
async function ensureSellingFeeColumns(): Promise<void> {
  if (sellingFeeColumnsEnsured) return;
  try {
    await db.execute(sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS selling_fee NUMERIC(10, 2) NOT NULL DEFAULT 0`);
    await db.execute(sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS selling_fee_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb`);
    await db.execute(sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS selling_fee_synced_at TIMESTAMPTZ`);
    await db.execute(sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS selling_fee_source TEXT`);
    sellingFeeColumnsEnsured = true;
  } catch (err) {
    // Don't break the analysis page if bootstrap fails (e.g. DB
    // role can't ALTER TABLE). The downstream SELECT will fail with
    // its original error message in that case — surfacing the real
    // problem rather than the bootstrap symptom.
    console.warn('[analysis] selling_fee column bootstrap failed:',
      err instanceof Error ? err.message : err);
  }
}

export async function getSkuBreakdownFromOrderItems(q: SkuBreakdownQuery) {
  await ensureSellingFeeColumns();

  const fromIso = new Date(q.dateFrom).toISOString();
  const toIso = new Date(q.dateTo).toISOString();
  const cid: number | null = q.clientId ?? null;
  const cancelledFilter = q.includeCancelled
    ? sql`true`
    : sql`coalesce(o.order_status, '') <> 'cancelled'`;
  const testOrderFilter = q.hideTestOrders
    ? sql`and not (
        coalesce(c.is_test, false) = true
        or coalesce(o.order_number, '') ilike 'TESTING-%'
        or o.raw @> '{"test": true}'::jsonb
        or o.raw @> '{"testing": true}'::jsonb
      )`
    : sql``;

  const rows = await db.execute<SkuBreakdownRow>(sql`
    with item_rows as (
      select
        o.id                                                                as order_id,
        o.order_date                                                        as order_date,
        o.client_id                                                         as client_id,
        c.name                                                              as client_name,
        o.order_status                                                      as order_status,
        coalesce(ls.service_code, o.service_code)                           as service_code,
        ls.order_id                                                         as shipment_order_id,
        coalesce(ls.label_cost, 0)                                          as label_cost,
        oi.sku                                                              as sku,
        oi.sku                                                              as sku_key,
        coalesce(nullif(oi.name, ''), '-')                                  as name,
        nullif(oi.image_url, '')                                            as image_url,
        greatest(0, coalesce(oi.quantity, 0))::int                          as qty,
        coalesce(oi.unit_price, 0)::numeric                                 as unit_price,
        coalesce(o.selling_fee, 0)::numeric                                 as order_selling_fee
      from order_items oi
      join orders o on o.id = oi.order_id
      left join clients c on c.id = o.client_id
      left join lateral (
        select
          s.order_id,
          s.service_code,
          case
            when lower(cost_model.markup->>'type') in ('pct', 'percent')
              then cost_model.base_cost * (1 + coalesce(nullif(cost_model.markup->>'value', '')::numeric, 0) / 100)
            when lower(cost_model.markup->>'type') in ('amount', 'flat')
              then cost_model.base_cost + coalesce(nullif(cost_model.markup->>'value', '')::numeric, 0)
            else cost_model.base_cost
          end as label_cost
        from shipments s
        left join settings pid_markup
          on pid_markup.key = 'markup.' || coalesce(s.provider_account_id, s.label_provider, s.selected_pid)::text
        left join settings carrier_markup
          on carrier_markup.key in ('markup.' || s.carrier_code, 'markup.' || lower(s.carrier_code))
        cross join lateral (
          select
            (coalesce(s.cost, s.label_cost, 0) + coalesce(s.other_cost, 0))::numeric as base_cost,
            case
              when coalesce(pid_markup.value, carrier_markup.value) ~ '^\\s*\\{'
                then coalesce(pid_markup.value, carrier_markup.value)::jsonb
              else null::jsonb
            end as markup
        ) cost_model
        where s.order_id = o.id
          and coalesce(s.voided, false) = false
        order by s.id desc
        limit 1
      ) ls on true
      where ${cancelledFilter}
        and o.order_date >= ${fromIso}::timestamptz
        and o.order_date <= ${toIso}::timestamptz
        ${testOrderFilter}
        and (${cid}::int is null or o.client_id = ${cid}::int)
        and ${analysisOrderScopePredicate(q)}
        and oi.quantity > 0
        and oi.sku <> ''
        and (o.client_id is null or ${sql.raw(activeClientPredicateSql('c'))})
    ),
    order_sku_rows as (
      select
        order_id,
        min(order_date)                                                      as order_date,
        min(client_id)                                                       as client_id,
        max(client_name)                                                     as client_name,
        max(order_status)                                                    as order_status,
        max(service_code)                                                    as service_code,
        max(shipment_order_id)                                               as shipment_order_id,
        max(label_cost)                                                      as label_cost,
        sku_key,
        max(sku)                                                             as sku,
        (array_agg(name order by length(name) desc))[1]                      as name,
        max(image_url)                                                       as image_url,
        sum(qty)::int                                                        as qty,
        max(unit_price)::numeric                                             as unit_price,
        sum(unit_price * qty)::numeric                                       as line_revenue,
        max(order_selling_fee)::numeric                                      as order_selling_fee
      from item_rows
      group by order_id, sku_key
    ),
    allocated as (
      select
        r.*,
        sum(qty) over (partition by r.order_id)::int                         as order_qty_total,
        case
          when r.order_status = 'shipped' and r.shipment_order_id is null then true
          else false
        end                                                                 as is_external,
        case
          when lower(coalesce(r.service_code, '')) = ANY(${EXPEDITED_SERVICES_SQL})
            then 'exp'
          else 'std'
        end                                                                 as ship_class
      from order_sku_rows r
    ),
    sku_inventory as (
      select distinct on (lower(inv.sku))
        lower(inv.sku) as sku_lc,
        inv.id
      from inventory inv
      where inv.sku is not null and inv.sku <> ''
      order by lower(inv.sku), inv.id
    ),
    sku_day_agg as (
      select
        a.sku_key,
        to_char(a.order_date at time zone 'America/Los_Angeles', 'YYYY-MM-DD') as day,
        sum(a.qty)::int as qty
      from allocated a
      group by a.sku_key, to_char(a.order_date at time zone 'America/Los_Angeles', 'YYYY-MM-DD')
    ),
    sku_daily_json as (
      select sku_key, jsonb_object_agg(day, qty) as daily_qty_map
      from sku_day_agg
      group by sku_key
    )
    select
      max(sku)                                                                 as sku,
      (array_agg(name order by length(name) desc))[1]                           as name,
      max(image_url)                                                            as image_url,
      min(inv.id)::int                                                          as inv_sku_id,
      (array_agg(client_id order by order_date asc nulls last))[1]::int          as client_id,
      (array_agg(client_name order by order_date asc nulls last))[1]             as client_name,
      count(*)::int                                                             as orders,
      greatest(
        count(*)::int
          - count(*) filter (where is_external)::int
          - count(*) filter (where not is_external and label_cost > 0 and ship_class = 'std')::int
          - count(*) filter (where not is_external and label_cost > 0 and ship_class = 'exp')::int,
        0
      )::int                                                                    as pending,
      count(*) filter (where is_external)::int                                   as ext_shipped,
      count(*) filter (where not is_external and ship_class = 'std')::int         as std_orders,
      count(*) filter (where not is_external and label_cost > 0 and ship_class = 'std')::int as std_ship_count,
      coalesce(sum(label_cost * qty / nullif(order_qty_total, 0)) filter (where not is_external and label_cost > 0 and ship_class = 'std'), 0)::text as std_total,
      coalesce(sum(qty) filter (where not is_external and label_cost > 0 and ship_class = 'std'), 0)::int as std_qty_total,
      count(*) filter (where not is_external and ship_class = 'exp')::int         as exp_orders,
      count(*) filter (where not is_external and label_cost > 0 and ship_class = 'exp')::int as exp_ship_count,
      coalesce(sum(label_cost * qty / nullif(order_qty_total, 0)) filter (where not is_external and label_cost > 0 and ship_class = 'exp'), 0)::text as exp_total,
      coalesce(sum(qty) filter (where not is_external and label_cost > 0 and ship_class = 'exp'), 0)::int as exp_qty_total,
      count(*) filter (where not is_external and label_cost > 0)::int             as ship_count_with_cost,
      sum(qty)::int                                                              as total_qty,
      coalesce(sum(label_cost * qty / nullif(order_qty_total, 0)) filter (where not is_external and label_cost > 0), 0)::text as total_shipping,
      coalesce(sum(line_revenue), 0)::text                                       as total_revenue,
      coalesce(sum(order_selling_fee * qty / nullif(order_qty_total, 0)) filter (where not is_external and order_selling_fee > 0), 0)::text as total_selling_fee,
      (array_agg(sdj.daily_qty_map))[1]                                          as daily_qty_map
    from allocated a
    left join sku_inventory inv on inv.sku_lc = lower(a.sku)
    left join sku_daily_json sdj on sdj.sku_key = a.sku_key
    group by a.sku_key
    order by total_qty desc
    limit ${q.limit}
  `);

  const totalOrders = await db.execute<{ count: number }>(sql`
    select count(*)::int as count from orders o
    where ${cancelledFilter}
      and o.order_date >= ${fromIso}::timestamptz
      and o.order_date <= ${toIso}::timestamptz
      and (${cid}::int is null or o.client_id = ${cid}::int)
      and ${analysisOrderScopePredicate(q)}
      and (
        o.client_id is null
        or exists (
          select 1 from clients c
          where c.id = o.client_id and ${sql.raw(activeClientPredicateSql('c'))}
        )
      )
  `);

  const dateBuckets = buildDateBuckets(fromIso, toIso);
  const canViewFinancials = q.canViewFinancials !== false;
  const enrichedRows = rows.map((r) => {
    const map = (r.daily_qty_map ?? {}) as Record<string, number>;
    const dailyQty = dateBuckets.map((day) => {
      const value = map[day];
      return typeof value === 'number' ? value : Number(value ?? 0) || 0;
    });
    const { daily_qty_map: _omit, ...rest } = r as SkuBreakdownRow & {
      daily_qty_map?: unknown;
    };
    return {
      ...rest,
      std_total: canViewFinancials ? rest.std_total : '0',
      exp_total: canViewFinancials ? rest.exp_total : '0',
      total_shipping: canViewFinancials ? rest.total_shipping : '0',
      total_selling_fee: canViewFinancials ? rest.total_selling_fee : '0',
      daily_qty: dailyQty,
    };
  });

  return {
    rows: enrichedRows,
    dateBuckets,
    totalSkus: enrichedRows.length,
    totalOrders: totalOrders[0]?.count ?? 0,
  };
}

async function getSkuBreakdown(q: SkuBreakdownQuery) {
  return getSkuBreakdownFromOrderItems(q);
}

app.get('/sku-breakdown', zValidator('query', skuBreakdownQuery), async (c) => {
  const result = await getSkuBreakdown(withAnalysisScope(c, c.req.valid('query')));
  return c.json({
    data: result.rows,
    dateBuckets: result.dateBuckets,
    totalSkus: result.totalSkus,
    totalOrders: result.totalOrders,
  });
});

app.get('/top-skus', zValidator('query', topSkusQuery), async (c) => {
  const q = c.req.valid('query');
  const topSkusScope = withAnalysisScope(c, q);
  const fromIso = new Date(q.dateFrom).toISOString();
  const toIso = new Date(q.dateTo).toISOString();
  const cid: number | null = q.clientId ?? null;
  const rows = await db.execute<{
    sku: string;
    total_qty: number;
    order_count: number;
  }>(sql`
    select
      oi.sku as sku,
      sum(greatest(0, coalesce(oi.quantity, 0)))::int as total_qty,
      count(distinct o.id)::int as order_count
    from order_items oi
    join orders o on o.id = oi.order_id
    where o.order_date >= ${fromIso}::timestamptz
      and o.order_date <= ${toIso}::timestamptz
      and (${cid}::int is null or o.client_id = ${cid}::int)
      and ${analysisOrderScopePredicate(topSkusScope)}
      and oi.sku is not null
      and oi.sku <> ''
      and oi.quantity > 0
      -- 2026-05-13 visibility hardening: original NOT EXISTS only
      -- filtered test clients, so disabled (non-test) clients orders
      -- still contributed to top-SKU rankings on the Dashboard widget.
      -- Adding coalesce(c.active, true) = false to the exclusion
      -- matches the predicate used everywhere else (sku-breakdown,
      -- daily-shipments, overview, orders). Orders with NULL client_id
      -- still pass through (no matching row in clients implies the
      -- NOT EXISTS is true), same lenient policy as other analysis routes.
      and not exists (
        select 1 from clients c
        where c.id = o.client_id
          and ${sql.raw(testOrInactiveClientPredicateSql('c'))}
      )
    group by oi.sku
    order by total_qty desc
    limit ${q.limit}
  `);
  return c.json({ data: rows });
});

// v2-parity aliases: v2's apiClient calls /analysis/skus and /analysis/daily-sales.
// v4 picked clearer names (sku-breakdown, sku-daily). Mount the v2 paths as
// aliases so the v2-apiClient compat shim doesn't need to translate.
app.get('/skus', zValidator('query', skuBreakdownQuery), async (c) => {
  const result = await getSkuBreakdown(withAnalysisScope(c, c.req.valid('query')));
  return c.json({
    data: result.rows,
    dateBuckets: result.dateBuckets,
    totalSkus: result.totalSkus,
    totalOrders: result.totalOrders,
  });
});

app.get('/daily-sales', zValidator('query', skuDailyQuery), async (c) => {
  return c.json(await getSkuDaily(withAnalysisScope(c, c.req.valid('query'))));
});

export default app;

