import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { EXCLUDED_STORE_IDS_SQL } from '../config/prepship';

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
  // Every sub-query excludes rows tied to is_test clients so sandbox data
  // never inflates dashboard numbers or the monthly shipping spend metric.
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
         where order_date >= date_trunc('day',  now())
           and not exists (select 1 from clients c where c.id = o.client_id and c.is_test = true)) as orders_today,
      (select count(*)::int from orders o
         where order_date >= date_trunc('week', now())
           and not exists (select 1 from clients c where c.id = o.client_id and c.is_test = true)) as orders_week,
      (select count(*)::int from orders o
         where order_date >= date_trunc('month',now())
           and not exists (select 1 from clients c where c.id = o.client_id and c.is_test = true)) as orders_month,
      (select count(*)::int from shipments s
         where s.voided = false and s.ship_date >= date_trunc('day',  now())
           and not exists (select 1 from clients c where c.id = s.client_id and c.is_test = true)) as shipped_today,
      (select count(*)::int from shipments s
         where s.voided = false and s.ship_date >= date_trunc('week', now())
           and not exists (select 1 from clients c where c.id = s.client_id and c.is_test = true)) as shipped_week,
      (select count(*)::int from shipments s
         where s.voided = false and s.ship_date >= date_trunc('month',now())
           and not exists (select 1 from clients c where c.id = s.client_id and c.is_test = true)) as shipped_month,
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
           where s.voided = false and s.ship_date >= date_trunc('month',now())
             and not exists (select 1 from clients c where c.id = s.client_id and c.is_test = true)
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
    shippingCostMonth: r.shipping_cost_month,
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
  const rows = await db.execute<{
    day: string;
    count: number;
    total_cost: string;
  }>(sql`
    select
      to_char(date_trunc('day', s.ship_date), 'YYYY-MM-DD') as day,
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
      and not exists (select 1 from clients c where c.id = s.client_id and c.is_test = true)
    group by date_trunc('day', s.ship_date)
    order by date_trunc('day', s.ship_date) desc
  `);
  return c.json({ data: rows });
});

const topSkusQuery = rangeQuery.extend({
  limit: z.coerce.number().int().positive().max(200).optional().default(50),
});

const skuDailyQuery = rangeQuery.extend({
  clientId: z.coerce.number().int().optional(),
  top: z.coerce.number().int().positive().max(10).optional(),
  topN: z.coerce.number().int().positive().max(15).optional(),
});

type SkuDailyQuery = z.infer<typeof skuDailyQuery>;

function buildDateBuckets(fromIso: string, toIso: string) {
  const startMs = Date.parse(`${fromIso.slice(0, 10)}T00:00:00.000Z`);
  const endMs = Date.parse(`${toIso.slice(0, 10)}T00:00:00.000Z`);
  const days = Math.max(1, Math.round((endMs - startMs) / 86_400_000) + 1);
  return Array.from({ length: days }, (_, index) =>
    new Date(startMs + index * 86_400_000).toISOString().slice(0, 10)
  );
}

async function getSkuDaily(q: SkuDailyQuery) {
  const fromIso = new Date(q.dateFrom).toISOString();
  const toIso = new Date(q.dateTo).toISOString();
  const cid: number | null = q.clientId ?? null;
  const topLimit = q.top ?? q.topN ?? 5;

  const top = await db.execute<{ sku: string; name: string | null; total_qty: number }>(sql`
    with item_rows as (
      select
        case
          when nullif(item->>'sku', '') is not null then item->>'sku'
          else '_name_:' || lower(trim(coalesce(item->>'name', '')))
        end as sku,
        coalesce(nullif(item->>'name', ''), '—') as name,
        coalesce((item->>'quantity')::int, 1) as qty
      from orders o, jsonb_array_elements(o.items) item
      where o.order_status not in ('cancelled')
        and o.order_date >= ${fromIso}::timestamptz
        and o.order_date <= ${toIso}::timestamptz
        and o.store_id not in (${sql.raw(EXCLUDED_STORE_IDS_SQL)})
        and (${cid}::int is null or o.client_id = ${cid}::int)
        and coalesce((item->>'adjustment')::boolean, false) = false
        -- Hide disabled clients (boss directive 2026-05-07)
        and (
          o.client_id is null
          or exists (
            select 1 from clients c
            where c.id = o.client_id and coalesce(c.active, true) = true
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
      to_char(o.order_date at time zone 'UTC', 'YYYY-MM-DD') as day,
      case
        when nullif(item->>'sku', '') is not null then item->>'sku'
        else '_name_:' || lower(trim(coalesce(item->>'name', '')))
      end as sku,
      sum(coalesce((item->>'quantity')::int, 1))::int as qty
    from orders o, jsonb_array_elements(o.items) item
    where o.order_status not in ('cancelled')
      and o.order_date >= ${fromIso}::timestamptz
      and o.order_date <= ${toIso}::timestamptz
      and o.store_id not in (${sql.raw(EXCLUDED_STORE_IDS_SQL)})
      and (${cid}::int is null or o.client_id = ${cid}::int)
      and coalesce((item->>'adjustment')::boolean, false) = false
      -- Hide disabled clients (boss directive 2026-05-07)
      and (
        o.client_id is null
        or exists (
          select 1 from clients c
          where c.id = o.client_id and coalesce(c.active, true) = true
        )
      )
      and (
        case
          when nullif(item->>'sku', '') is not null then item->>'sku'
          else '_name_:' || lower(trim(coalesce(item->>'name', '')))
        end
      ) in (${skuList})
    group by to_char(o.order_date at time zone 'UTC', 'YYYY-MM-DD'), sku
    order by to_char(o.order_date at time zone 'UTC', 'YYYY-MM-DD') asc
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

app.get('/sku-daily', zValidator('query', skuDailyQuery), async (c) => {
  return c.json(await getSkuDaily(c.req.valid('query')));
});

const skuBreakdownQuery = rangeQuery.extend({
  clientId: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().positive().max(2000).optional().default(2000),
});

type SkuBreakdownQuery = z.infer<typeof skuBreakdownQuery>;
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
};

async function getSkuBreakdown(q: SkuBreakdownQuery) {
  const fromIso = new Date(q.dateFrom).toISOString();
  const toIso = new Date(q.dateTo).toISOString();
  const cid: number | null = q.clientId ?? null;

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
        coalesce(nullif(item->>'sku', ''), '')                              as sku,
        case
          when nullif(item->>'sku', '') is not null then item->>'sku'
          else '_name_:' || lower(trim(coalesce(item->>'name', '')))
        end                                                                as sku_key,
        coalesce(nullif(item->>'name', ''), '—')                            as name,
        nullif(item->>'imageUrl', '')                                       as image_url,
        coalesce((item->>'quantity')::int, 1)                               as qty
      from orders o
      cross join lateral jsonb_array_elements(o.items) item
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
      where coalesce(o.order_status, '') <> 'cancelled'
        and o.order_date >= ${fromIso}::timestamptz
        and o.order_date <= ${toIso}::timestamptz
        and (${cid}::int is null or o.client_id = ${cid}::int)
        and coalesce((item->>'adjustment')::boolean, false) = false
        and coalesce((item->>'quantity')::int, 1) > 0
        -- Hide disabled clients from analysis (boss directive
        -- 2026-05-07). Matches the orders.ts predicate exactly:
        -- coalesce(active, true) keeps legacy clients with null
        -- active flag visible (no behavior change for existing
        -- data) while explicitly inactive clients (e.g. Api
        -- Shipments toggled off in Inventory > Clients) drop
        -- their orders from the SKU breakdown. Orders with no
        -- client_id at all still pass through (test/orphan
        -- orders) — same lenient policy as the main orders list.
        and (o.client_id is null or coalesce(c.active, true) = true)
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
        sum(qty)::int                                                        as qty
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
      -- Per-UNIT shipping average (boss directive 2026-05-07):
      -- allocate each label by units in the order, then let the FE divide
      -- by the units for this SKU/service class. A $23 label on two units
      -- contributes $11.50 per unit; mixed-SKU orders use the same
      -- per-unit share for every item unit in that order.
      coalesce(sum(qty) filter (where not is_external and label_cost > 0 and ship_class = 'std'), 0)::int as std_qty_total,
      count(*) filter (where not is_external and ship_class = 'exp')::int         as exp_orders,
      count(*) filter (where not is_external and label_cost > 0 and ship_class = 'exp')::int as exp_ship_count,
      coalesce(sum(label_cost * qty / nullif(order_qty_total, 0)) filter (where not is_external and label_cost > 0 and ship_class = 'exp'), 0)::text as exp_total,
      coalesce(sum(qty) filter (where not is_external and label_cost > 0 and ship_class = 'exp'), 0)::int as exp_qty_total,
      count(*) filter (where not is_external and label_cost > 0)::int             as ship_count_with_cost,
      sum(qty)::int                                                              as total_qty,
      coalesce(sum(label_cost * qty / nullif(order_qty_total, 0)) filter (where not is_external and label_cost > 0), 0)::text as total_shipping
    from allocated a
    left join sku_inventory inv on inv.sku_lc = lower(a.sku)
    group by sku_key
    order by total_qty desc
    limit ${q.limit}
  `);

  const totalOrders = await db.execute<{ count: number }>(sql`
    select count(*)::int as count from orders o
    where coalesce(o.order_status, '') <> 'cancelled'
      and o.order_date >= ${fromIso}::timestamptz
      and o.order_date <= ${toIso}::timestamptz
      and (${cid}::int is null or o.client_id = ${cid}::int)
      -- Hide disabled clients (boss directive 2026-05-07)
      and (
        o.client_id is null
        or exists (
          select 1 from clients c
          where c.id = o.client_id and coalesce(c.active, true) = true
        )
      )
  `);

  return {
    rows,
    totalSkus: rows.length,
    totalOrders: totalOrders[0]?.count ?? 0,
  };
}

app.get('/sku-breakdown', zValidator('query', skuBreakdownQuery), async (c) => {
  const result = await getSkuBreakdown(c.req.valid('query'));
  return c.json({
    data: result.rows,
    totalSkus: result.totalSkus,
    totalOrders: result.totalOrders,
  });
});

app.get('/top-skus', zValidator('query', topSkusQuery), async (c) => {
  const q = c.req.valid('query');
  const fromIso = new Date(q.dateFrom).toISOString();
  const toIso = new Date(q.dateTo).toISOString();
  const rows = await db.execute<{
    sku: string;
    total_qty: number;
    order_count: number;
  }>(sql`
    select
      item->>'sku' as sku,
      sum(coalesce((item->>'quantity')::int, 1))::int as total_qty,
      count(distinct o.id)::int as order_count
    from orders o,
         jsonb_array_elements(o.items) item
    where o.order_date >= ${fromIso}::timestamptz
      and o.order_date <= ${toIso}::timestamptz
      and item ? 'sku'
      and item->>'sku' is not null
      and item->>'sku' <> ''
      and not exists (select 1 from clients c where c.id = o.client_id and c.is_test = true)
    group by item->>'sku'
    order by total_qty desc
    limit ${q.limit}
  `);
  return c.json({ data: rows });
});

// v2-parity aliases: v2's apiClient calls /analysis/skus and /analysis/daily-sales.
// v4 picked clearer names (sku-breakdown, sku-daily). Mount the v2 paths as
// aliases so the v2-apiClient compat shim doesn't need to translate.
app.get('/skus', zValidator('query', skuBreakdownQuery), async (c) => {
  const result = await getSkuBreakdown(c.req.valid('query'));
  return c.json({
    data: result.rows,
    totalSkus: result.totalSkus,
    totalOrders: result.totalOrders,
  });
});

app.get('/daily-sales', zValidator('query', skuDailyQuery), async (c) => {
  return c.json(await getSkuDaily(c.req.valid('query')));
});

export default app;
