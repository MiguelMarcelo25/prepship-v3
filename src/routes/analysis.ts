import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';

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
      (select coalesce(sum(label_cost),0)::text from shipments s
         where s.voided = false and s.ship_date >= date_trunc('month',now())
           and not exists (select 1 from clients c where c.id = s.client_id and c.is_test = true)) as shipping_cost_month
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
      coalesce(sum(s.label_cost), 0)::text as total_cost
    from shipments s
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
  topN: z.coerce.number().int().positive().max(15).optional().default(5),
});

app.get('/sku-daily', zValidator('query', skuDailyQuery), async (c) => {
  const q = c.req.valid('query');
  const fromIso = new Date(q.dateFrom).toISOString();
  const toIso = new Date(q.dateTo).toISOString();
  const cid: number | null = q.clientId ?? null;

  const top = await db.execute<{ sku: string; name: string | null; total_qty: number }>(sql`
    select item->>'sku' as sku,
           max(item->>'name') as name,
           sum(coalesce((item->>'quantity')::int, 1))::int as total_qty
    from orders o, jsonb_array_elements(o.items) item
    where item ? 'sku' and item->>'sku' is not null and item->>'sku' <> ''
      and o.order_date >= ${fromIso}::timestamptz
      and o.order_date <= ${toIso}::timestamptz
      and (${cid}::int is null or o.client_id = ${cid}::int)
      and not exists (select 1 from clients c where c.id = o.client_id and c.is_test = true)
    group by item->>'sku'
    order by total_qty desc
    limit ${q.topN}
  `);

  const skus = top.map((t) => t.sku);
  if (!skus.length) {
    return c.json({ topSkus: [], days: [] });
  }

  const skuList = sql.join(
    skus.map((s) => sql`${s}`),
    sql`, `
  );

  const daily = await db.execute<{ day: string; sku: string; qty: number }>(sql`
    select to_char(date_trunc('day', o.order_date), 'YYYY-MM-DD') as day,
           item->>'sku' as sku,
           sum(coalesce((item->>'quantity')::int, 1))::int as qty
    from orders o, jsonb_array_elements(o.items) item
    where item ? 'sku' and item->>'sku' in (${skuList})
      and o.order_date >= ${fromIso}::timestamptz
      and o.order_date <= ${toIso}::timestamptz
      and (${cid}::int is null or o.client_id = ${cid}::int)
      and not exists (select 1 from clients c where c.id = o.client_id and c.is_test = true)
    group by date_trunc('day', o.order_date), item->>'sku'
    order by date_trunc('day', o.order_date) asc
  `);

  const byDay = new Map<string, Record<string, number | string>>();
  for (const row of daily) {
    const bucket = byDay.get(row.day) ?? { day: row.day };
    bucket[row.sku] = row.qty;
    byDay.set(row.day, bucket);
  }
  const sortedDays = [...byDay.keys()].sort();
  const days = sortedDays.map((d) => {
    const b = byDay.get(d)!;
    for (const s of skus) if (b[s] === undefined) b[s] = 0;
    return b;
  });

  return c.json({ topSkus: top, days });
});

const skuBreakdownQuery = rangeQuery.extend({
  clientId: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().positive().max(2000).optional().default(500),
});

app.get('/sku-breakdown', zValidator('query', skuBreakdownQuery), async (c) => {
  const q = c.req.valid('query');
  const fromIso = new Date(q.dateFrom).toISOString();
  const toIso = new Date(q.dateTo).toISOString();
  const cid: number | null = q.clientId ?? null;

  const rows = await db.execute<{
    sku: string;
    name: string | null;
    image_url: string | null;
    client_id: number | null;
    orders: number;
    pending: number;
    ext_shipped: number;
    std_orders: number;
    std_total: string;
    exp_orders: number;
    exp_total: string;
    total_qty: number;
    total_shipping: string;
  }>(sql`
    with sku_orders as (
      select
        item->>'sku'                                              as sku,
        item->>'name'                                             as name,
        nullif(item->>'imageUrl', '')                             as image_url,
        o.client_id                                               as client_id,
        o.id                                                      as order_id,
        o.order_status                                            as order_status,
        o.externally_shipped                                      as ext_shipped,
        o.service_code                                            as service_code,
        coalesce(o.shipping_amount, 0)                            as shipping_amount,
        coalesce((item->>'quantity')::int, 1)                     as qty
      from orders o,
           jsonb_array_elements(o.items) item
      where item ? 'sku'
        and item->>'sku' is not null
        and item->>'sku' <> ''
        and o.order_date >= ${fromIso}::timestamptz
        and o.order_date <= ${toIso}::timestamptz
        and (${cid}::int is null or o.client_id = ${cid}::int)
        and not exists (select 1 from clients c where c.id = o.client_id and c.is_test = true)
    ),
    classified as (
      select *,
        case
          when lower(coalesce(service_code, '')) ~ '(priority|express|overnight|expedited|next_day|2day|2_day)'
            then 'exp'
          else 'std'
        end as ship_class
      from sku_orders
    )
    select
      sku,
      max(name)                                                       as name,
      max(image_url)                                                  as image_url,
      client_id,
      count(distinct order_id)::int                                   as orders,
      count(distinct order_id)
        filter (where order_status = 'awaiting_shipment')::int        as pending,
      count(distinct order_id)
        filter (where ext_shipped = true)::int                        as ext_shipped,
      count(distinct order_id) filter (where ship_class = 'std')::int as std_orders,
      coalesce(sum(shipping_amount) filter (where ship_class = 'std'), 0)::text as std_total,
      count(distinct order_id) filter (where ship_class = 'exp')::int as exp_orders,
      coalesce(sum(shipping_amount) filter (where ship_class = 'exp'), 0)::text as exp_total,
      sum(qty)::int                                                   as total_qty,
      coalesce(sum(shipping_amount), 0)::text                         as total_shipping
    from classified
    group by sku, client_id
    order by total_qty desc
    limit ${q.limit}
  `);

  const totalOrders = await db.execute<{ count: number }>(sql`
    select count(*)::int as count from orders o
    where o.order_date >= ${fromIso}::timestamptz
      and o.order_date <= ${toIso}::timestamptz
      and (${cid}::int is null or o.client_id = ${cid}::int)
      and not exists (select 1 from clients c where c.id = o.client_id and c.is_test = true)
  `);

  return c.json({
    data: rows,
    totalSkus: rows.length,
    totalOrders: totalOrders[0]?.count ?? 0,
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

export default app;
