import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';

const app = new Hono();

app.get('/overview', async (c) => {
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
      (select count(*)::int from orders where order_date >= date_trunc('day',  now())) as orders_today,
      (select count(*)::int from orders where order_date >= date_trunc('week', now())) as orders_week,
      (select count(*)::int from orders where order_date >= date_trunc('month',now())) as orders_month,
      (select count(*)::int from shipments where voided = false and ship_date >= date_trunc('day',  now())) as shipped_today,
      (select count(*)::int from shipments where voided = false and ship_date >= date_trunc('week', now())) as shipped_week,
      (select count(*)::int from shipments where voided = false and ship_date >= date_trunc('month',now())) as shipped_month,
      (select coalesce(sum(label_cost),0)::text from shipments
         where voided = false and ship_date >= date_trunc('month',now())) as shipping_cost_month
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
  const rows = await db.execute<{
    day: string;
    count: number;
    total_cost: string;
  }>(sql`
    select
      to_char(date_trunc('day', ship_date), 'YYYY-MM-DD') as day,
      count(*)::int as count,
      coalesce(sum(label_cost), 0)::text as total_cost
    from shipments
    where voided = false
      and ship_date >= ${new Date(q.dateFrom)}
      and ship_date <= ${new Date(q.dateTo)}
    group by date_trunc('day', ship_date)
    order by date_trunc('day', ship_date) desc
  `);
  return c.json({ data: rows });
});

const topSkusQuery = rangeQuery.extend({
  limit: z.coerce.number().int().positive().max(200).optional().default(50),
});

app.get('/top-skus', zValidator('query', topSkusQuery), async (c) => {
  const q = c.req.valid('query');
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
    where o.order_date >= ${new Date(q.dateFrom)}
      and o.order_date <= ${new Date(q.dateTo)}
      and item ? 'sku'
      and item->>'sku' is not null
      and item->>'sku' <> ''
    group by item->>'sku'
    order by total_qty desc
    limit ${q.limit}
  `);
  return c.json({ data: rows });
});

export default app;
