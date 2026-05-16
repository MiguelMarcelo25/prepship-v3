import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { clients } from '../db/schema/clients';
import { inventory, inventoryLedger } from '../db/schema/inventory';
import { orderItems } from '../db/schema/order-items';
import { orders } from '../db/schema/orders';
import { analyticsCacheKey, getAnalyticsCache, setAnalyticsCache } from '../services/analytics-cache';
import { EXCLUDED_STORE_IDS_SQL } from '../config/prepship';
import { isAdminEmail } from '../lib/admin-emails';
import { getSkuBreakdownFromOrderItems, getSkuDailyFromOrderItems } from './analysis';

const app = new Hono();

function msSince(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

const dashboardRangeQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'from must be YYYY-MM-DD'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'to must be YYYY-MM-DD'),
  clientId: z.coerce.number().int().optional(),
  storeId: z.coerce.number().int().optional(),
  hideTestOrders: z.coerce.boolean().optional(),
  includeInactive: z.coerce.boolean().optional(),
  includeInactiveClients: z.coerce.boolean().optional(),
});

const dashboardSummaryQuery = dashboardRangeQuery.extend({
  sevenFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'sevenFrom must be YYYY-MM-DD').optional(),
});

const dashboardSkuTrendQuery = dashboardRangeQuery.extend({
  top: z.coerce.number().int().positive().max(10).optional(),
  topN: z.coerce.number().int().positive().max(15).optional(),
  includeCancelled: z.coerce.boolean().optional().default(true),
});

const dashboardTopSkusQuery = dashboardRangeQuery.extend({
  limit: z.coerce.number().int().positive().max(500).optional().default(200),
  includeCancelled: z.coerce.boolean().optional().default(true),
});

const dashboardInventoryRiskQuery = z.object({
  clientId: z.coerce.number().int().optional(),
  pageSize: z.coerce.number().int().positive().max(1000).optional().default(500),
  active: z.coerce.boolean().optional().default(true),
});

const visibleStoreBasePredicate = sql`(
  (${orders.storeId} is not null and ${orders.storeId} not in (${sql.raw(EXCLUDED_STORE_IDS_SQL)}))
  or exists (
    select 1 from ${clients} test_client
    where test_client.id = ${orders.clientId}
      and test_client.is_test = true
  )
)`;

const activeOrderClientPredicate = sql`(
  ${orders.clientId} is null
  or exists (
    select 1 from ${clients} owner_client
    where owner_client.id = ${orders.clientId}
      and coalesce(owner_client.active, true) = true
  )
)`;

const visibleStorePredicate = sql`${visibleStoreBasePredicate} and ${activeOrderClientPredicate}`;

const testOrderPredicate = sql`(
  exists (
    select 1 from ${clients} test_client
    where test_client.id = ${orders.clientId}
      and test_client.is_test = true
  )
  or coalesce(${orders.orderNumber}, '') ilike 'TESTING-%'
  or ${orders.raw} @> '{"test": true}'::jsonb
  or ${orders.raw} @> '{"testing": true}'::jsonb
 )`;

const activeInventoryClientPredicate = sql`(
  ${inventory.clientId} is null
  or exists (
    select 1 from ${clients} owner_client
    where owner_client.id = ${inventory.clientId}
      and coalesce(owner_client.active, true) = true
  )
)`;

function callerAssigneeFilter(c: Context) {
  const callerEmail = c.get('email' as never) as string | undefined;
  const callerUserId = c.get('userId' as never) as string | undefined;
  const callerIsAdmin = isAdminEmail(callerEmail);
  return !callerIsAdmin && callerUserId
    ? eq(orders.assignedToUserId, callerUserId)
    : undefined;
}

function orderVisibilityWhere(
  c: Context,
  q: z.infer<typeof dashboardRangeQuery>,
  fromDate: Date,
  toDate: Date,
  options: { excludeCancelled?: boolean } = {},
) {
  const includeInactiveClients = q.includeInactive === true || q.includeInactiveClients === true;
  return and(
    ...[
      callerAssigneeFilter(c),
      q.clientId !== undefined ? eq(orders.clientId, q.clientId) : undefined,
      q.storeId !== undefined ? eq(orders.storeId, q.storeId) : undefined,
      includeInactiveClients ? visibleStoreBasePredicate : visibleStorePredicate,
      q.hideTestOrders === true && q.clientId === undefined && q.storeId === undefined
        ? sql`not ${testOrderPredicate}`
        : undefined,
      gte(orders.orderDate, fromDate),
      lte(orders.orderDate, toDate),
      options.excludeCancelled
        ? sql`lower(coalesce(${orders.orderStatus}, '')) <> 'cancelled'`
        : undefined,
    ].filter((p): p is NonNullable<typeof p> => p !== undefined)
  );
}

function isoDayStart(day: string): string {
  return new Date(`${day}T00:00:00.000Z`).toISOString();
}

function isoDayEnd(day: string): string {
  return new Date(`${day}T23:59:59.999Z`).toISOString();
}

async function loadDashboardSummary(
  c: Context,
  q: z.infer<typeof dashboardSummaryQuery>,
) {
  const startedAt = performance.now();
  const fromDate = new Date(`${q.from}T00:00:00.000Z`);
  const toDate = new Date(`${q.to}T23:59:59.999Z`);
  const includeInactiveClients = q.includeInactive === true || q.includeInactiveClients === true;
  const sevenFrom = q.sevenFrom ?? q.from;
  const where = orderVisibilityWhere(c, q, fromDate, toDate, { excludeCancelled: true });
  const callerEmail = c.get('email' as never) as string | undefined;
  const callerUserId = c.get('userId' as never) as string | undefined;
  const callerIsAdmin = isAdminEmail(callerEmail);

  type DashboardSummaryPayload = {
    revenue: number;
    units: number;
    bySku: Array<{ sku: string; revenue: number | string; units30: number | string; units7: number | string }>;
    dailyRevenue: Array<{ day: string; revenue: number | string }>;
  };

  const cacheKey = analyticsCacheKey('dashboard.summary.v1', {
    from: q.from,
    to: q.to,
    sevenFrom,
    clientId: q.clientId ?? null,
    storeId: q.storeId ?? null,
    includeInactiveClients,
    hideTestOrders: q.hideTestOrders === true,
    caller: callerIsAdmin ? 'admin' : callerUserId ?? 'anonymous',
  });

  const cached = await getAnalyticsCache<DashboardSummaryPayload>(cacheKey);
  if (cached) return cached;

  const [row] = await db.execute<{
    revenue: number | string | null;
    units: number | string | null;
    bySku: Array<{ sku: string; revenue: number | string; units30: number | string; units7: number | string }> | null;
    dailyRevenue: Array<{ day: string; revenue: number | string }> | null;
  }>(sql`
    with item_rows as (
      select
        ${orders.id} as order_id,
        coalesce(${orders.orderTotal}, 0)::numeric as order_total,
        to_char(date_trunc('day', ${orders.orderDate} at time zone 'UTC'), 'YYYY-MM-DD') as day,
        trim(coalesce(oi.sku, '')) as sku,
        greatest(0, coalesce(oi.quantity, 0))::numeric as qty
      from ${orderItems} oi
      join ${orders} on ${orders.id} = oi.order_id
      where ${where}
        and trim(coalesce(oi.sku, '')) <> ''
    ),
    valid_items as (
      select *
      from item_rows
      where qty > 0
    ),
    order_totals as (
      select
        order_id,
        max(order_total) as order_total,
        sum(qty) as order_qty
      from valid_items
      group by order_id
    ),
    allocated as (
      select
        vi.order_id,
        vi.day,
        vi.sku,
        vi.qty,
        case
          when ot.order_qty > 0 then ot.order_total * vi.qty / ot.order_qty
          else 0
        end as allocated_revenue
      from valid_items vi
      join order_totals ot on ot.order_id = vi.order_id
    ),
    sku_totals as (
      select
        sku,
        coalesce(sum(allocated_revenue), 0) as revenue,
        coalesce(sum(qty), 0) as units30,
        coalesce(sum(qty) filter (where day >= ${sevenFrom}), 0) as units7
      from allocated
      group by sku
    ),
    daily_totals as (
      select
        day,
        coalesce(sum(order_total), 0) as revenue
      from (
        select distinct vi.order_id, vi.day, ot.order_total
        from valid_items vi
        join order_totals ot on ot.order_id = vi.order_id
      ) distinct_orders
      group by day
    )
    select
      coalesce((select sum(order_total) from order_totals), 0)::float8 as "revenue",
      coalesce((select sum(order_qty) from order_totals), 0)::float8 as "units",
      coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'sku', sku,
              'revenue', revenue,
              'units30', units30,
              'units7', units7
            )
            order by units30 desc, sku asc
          )
          from sku_totals
        ),
        '[]'::jsonb
      ) as "bySku",
      coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'day', day,
              'revenue', revenue
            )
            order by day asc
          )
          from daily_totals
        ),
        '[]'::jsonb
      ) as "dailyRevenue"
  `);

  const payload: DashboardSummaryPayload = {
    revenue: Number(row?.revenue ?? 0) || 0,
    units: Number(row?.units ?? 0) || 0,
    bySku: Array.isArray(row?.bySku) ? row.bySku : [],
    dailyRevenue: Array.isArray(row?.dailyRevenue) ? row.dailyRevenue : [],
  };

  const totalMs = msSince(startedAt);
  if (totalMs >= 500) {
    console.info('[dashboard:summary] completed', {
      from: q.from,
      to: q.to,
      clientId: q.clientId ?? null,
      storeId: q.storeId ?? null,
      totalMs,
      skuRows: payload.bySku.length,
      dayRows: payload.dailyRevenue.length,
    });
  }

  void setAnalyticsCache(cacheKey, payload, 120);
  return payload;
}

app.get('/daily-counts', zValidator('query', dashboardRangeQuery), async (c) => {
  const q = c.req.valid('query');
  const fromDate = new Date(`${q.from}T00:00:00.000Z`);
  const toDate = new Date(`${q.to}T23:59:59.999Z`);
  const where = orderVisibilityWhere(c, q, fromDate, toDate);

  const rows = await db.execute<{
    day: string;
    awaiting: number;
    shipped: number;
    cancelled: number;
    total: number;
  }>(sql`
    select
      to_char(date_trunc('day', ${orders.orderDate} at time zone 'UTC'), 'YYYY-MM-DD') as day,
      count(*) filter (where ${orders.orderStatus} = 'awaiting_shipment')::int as awaiting,
      count(*) filter (where ${orders.orderStatus} = 'shipped')::int as shipped,
      count(*) filter (where ${orders.orderStatus} = 'cancelled')::int as cancelled,
      count(*)::int as total
    from ${orders}
    where ${where}
    group by date_trunc('day', ${orders.orderDate} at time zone 'UTC')
    order by date_trunc('day', ${orders.orderDate} at time zone 'UTC') asc
  `);

  return c.json({ data: rows });
});

app.get('/summary', zValidator('query', dashboardSummaryQuery), async (c) => {
  return c.json(await loadDashboardSummary(c, c.req.valid('query')));
});

// Alias for dashboard panels that think of this payload as chart trend data.
app.get('/trends', zValidator('query', dashboardSummaryQuery), async (c) => {
  return c.json(await loadDashboardSummary(c, c.req.valid('query')));
});

app.get('/sku-trends', zValidator('query', dashboardSkuTrendQuery), async (c) => {
  const q = c.req.valid('query');
  return c.json(await getSkuDailyFromOrderItems({
    dateFrom: isoDayStart(q.from),
    dateTo: isoDayEnd(q.to),
    clientId: q.clientId,
    top: q.top,
    topN: q.topN,
    hideTestOrders: q.hideTestOrders === true,
    includeCancelled: q.includeCancelled,
  }));
});

app.get('/top-skus', zValidator('query', dashboardTopSkusQuery), async (c) => {
  const q = c.req.valid('query');
  const result = await getSkuBreakdownFromOrderItems({
    dateFrom: isoDayStart(q.from),
    dateTo: isoDayEnd(q.to),
    clientId: q.clientId,
    limit: q.limit,
    hideTestOrders: q.hideTestOrders === true,
    includeCancelled: q.includeCancelled,
  });
  return c.json({
    data: result.rows,
    dateBuckets: result.dateBuckets,
    totalSkus: result.totalSkus,
    totalOrders: result.totalOrders,
  });
});

app.get('/inventory-risk', zValidator('query', dashboardInventoryRiskQuery), async (c) => {
  const q = c.req.valid('query');
  const where = and(
    ...[
      q.clientId !== undefined ? eq(inventory.clientId, q.clientId) : undefined,
      q.active !== undefined ? eq(inventory.active, q.active) : undefined,
      activeInventoryClientPredicate,
    ].filter((p): p is NonNullable<typeof p> => p !== undefined)
  );

  const rows = await db
    .select()
    .from(inventory)
    .where(where)
    .orderBy(desc(inventory.updatedAt))
    .limit(q.pageSize);

  const ids = rows.map((row) => row.id);
  const soldRows = ids.length
    ? await db.execute<{ inventory_id: number; sold_last_30_days: number }>(sql`
        select
          i.id as inventory_id,
          coalesce(sum(oi.quantity), 0)::int as sold_last_30_days
        from ${inventory} i
        join ${orderItems} oi
          on lower(oi.sku) = lower(i.sku)
        join ${orders} o
          on (
            o.id = oi.order_id
            and (
              (i.client_id is null and o.client_id is null)
              or i.client_id = o.client_id
            )
          )
        where i.id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
          and oi.quantity > 0
          and o.order_date >= now() - interval '30 days'
          and coalesce(o.order_status, '') <> 'cancelled'
        group by i.id
      `)
    : [];
  const soldByInventoryId = new Map(
    soldRows.map((row) => [row.inventory_id, Number(row.sold_last_30_days) || 0])
  );

  const effectiveRows = ids.length
    ? await db.execute<{
        inventory_id: number;
        total_received: number;
        total_sold: number;
      }>(sql`
        with ids as (
          select unnest(array[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::int[]) as id
        ),
        receives as (
          select l.inventory_id as id, coalesce(sum(l.qty), 0)::int as total_received
          from ${inventoryLedger} l
          where l.inventory_id in (select id from ids)
            and l.type = 'receive'
          group by l.inventory_id
        ),
        sells as (
          select i.id as id, coalesce(sum(oi.quantity), 0)::int as total_sold
          from ${inventory} i
          join ${orderItems} oi
            on lower(oi.sku) = lower(i.sku)
          join ${orders} o
            on (
              o.id = oi.order_id
              and (
                (i.client_id is null and o.client_id is null)
                or i.client_id = o.client_id
              )
            )
          where i.id in (select id from ids)
            and oi.quantity > 0
            and o.order_status = 'shipped'
          group by i.id
        )
        select
          ids.id as inventory_id,
          coalesce(receives.total_received, 0)::int as total_received,
          coalesce(sells.total_sold, 0)::int as total_sold
        from ids
        left join receives on receives.id = ids.id
        left join sells on sells.id = ids.id
      `)
    : [];

  const effectiveByInventoryId = new Map(
    effectiveRows.map((row) => [
      row.inventory_id,
      {
        totalReceived: Number(row.total_received) || 0,
        totalSold: Number(row.total_sold) || 0,
        effectiveStock: (Number(row.total_received) || 0) - (Number(row.total_sold) || 0),
      },
    ])
  );

  return c.json({
    items: rows.map((row) => {
      const eff = effectiveByInventoryId.get(row.id) ?? { totalReceived: 0, totalSold: 0, effectiveStock: 0 };
      return {
        ...row,
        soldLast30Days: soldByInventoryId.get(row.id) ?? 0,
        totalReceived: eff.totalReceived,
        totalSoldAllTime: eff.totalSold,
        effectiveStock: eff.effectiveStock,
      };
    }),
    total: rows.length,
  });
});

export default app;
