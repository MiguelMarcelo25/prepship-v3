import { Hono, type Context } from 'hono';
import { intArraySql } from '../lib/scope-sql';
import { msSince } from '../lib/route-timing';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client';
import { clients } from '../db/schema/clients';
import { inventory, inventoryLedger } from '../db/schema/inventory';
import { orderItems } from '../db/schema/order-items';
import { orders } from '../db/schema/orders';
import { analyticsCacheKey, getAnalyticsCache, setAnalyticsCache } from '../services/analytics-cache';
import { EXCLUDED_STORE_IDS_SQL } from '../config/prepship';
import { activeClientPredicateSql } from '../lib/active-client-predicate';
import { computeEffectiveStockForIds, type EffectiveStockEntry } from '../services/inventory-stock-math';
import { isAdminEmail } from '../lib/admin-emails';
import { getClientStoreScope, type ClientStoreScope } from '../lib/client-store-scope';
import { californiaDayEnd, californiaDayStart } from '../lib/time/california';
import { hasAppPermission } from '../middleware/auth';
import { getFreshInventoryRiskMetrics } from '../services/reporting-metrics';
import { getSkuBreakdownFromOrderItems, getSkuDailyFromOrderItems } from './analysis';

const app = new Hono();

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
  liveMetrics: z.coerce.boolean().optional().default(false),
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
      and ${sql.raw(activeClientPredicateSql('owner_client'))}
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
      and ${sql.raw(activeClientPredicateSql('owner_client'))}
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

function dashboardScopeFromContext(c: Context): ClientStoreScope {
  return getClientStoreScope({
    email: c.get('email' as never) as string | undefined,
    role: c.get('role' as never) as string | undefined,
    permissions: c.get('permissions' as never) as string[] | undefined,
    clientIds: c.get('clientIds' as never) as number[] | undefined,
    storeIds: c.get('storeIds' as never) as number[] | undefined,
  });
}

function canViewDashboardFinancials(c: Context): boolean {
  return hasAppPermission(
    {
      email: c.get('email' as never) as string | undefined,
      role: c.get('role' as never) as string | undefined,
      permissions: c.get('permissions' as never) as string[] | undefined,
    },
    'financials:read'
  );
}

function orderScopePredicate(scope: ClientStoreScope): SQL | undefined {
  if (!scope.isRestricted) return undefined;
  const predicates: SQL[] = [];
  if (scope.clientIds.length) {
    predicates.push(sql`${orders.clientId} = any(${intArraySql(scope.clientIds)})`);
  }
  if (scope.storeIds.length) {
    predicates.push(sql`${orders.storeId} = any(${intArraySql(scope.storeIds)})`);
  }
  if (!predicates.length) return sql`false`;
  if (predicates.length === 1) return predicates[0]!;
  return sql`(${sql.join(predicates, sql` or `)})`;
}

function inventoryScopePredicate(scope: ClientStoreScope): SQL | undefined {
  if (!scope.isRestricted) return undefined;
  const predicates: SQL[] = [];
  if (scope.clientIds.length) {
    predicates.push(sql`${inventory.clientId} = any(${intArraySql(scope.clientIds)})`);
  }
  if (scope.storeIds.length) {
    predicates.push(sql`exists (
      select 1 from ${clients} scoped_client
      where scoped_client.id = ${inventory.clientId}
        and scoped_client.store_ids && ${intArraySql(scope.storeIds)}
    )`);
  }
  if (!predicates.length) return sql`false`;
  if (predicates.length === 1) return predicates[0]!;
  return sql`(${sql.join(predicates, sql` or `)})`;
}

function dashboardCallerCacheScope(c: Context, scope: ClientStoreScope): string {
  const callerEmail = c.get('email' as never) as string | undefined;
  const callerUserId = c.get('userId' as never) as string | undefined;
  const callerScope = scope.isRestricted
    ? `clients=${scope.clientIds.join(',')};stores=${scope.storeIds.join(',')}`
    : 'global';
  return `${isAdminEmail(callerEmail) ? 'admin' : callerUserId ?? 'anonymous'}:${callerScope}`;
}

function orderVisibilityWhere(
  c: Context,
  q: z.infer<typeof dashboardRangeQuery>,
  fromDate: Date,
  toDate: Date,
  scope: ClientStoreScope,
  options: { excludeCancelled?: boolean } = {},
) {
  const includeInactiveClients = q.includeInactive === true || q.includeInactiveClients === true;
  return and(
    ...[
      callerAssigneeFilter(c),
      orderScopePredicate(scope),
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
  return californiaDayStart(day).toISOString();
}

function isoDayEnd(day: string): string {
  return californiaDayEnd(day).toISOString();
}

async function loadDashboardSummary(
  c: Context,
  q: z.infer<typeof dashboardSummaryQuery>,
) {
  const startedAt = performance.now();
  const fromDate = californiaDayStart(q.from);
  const toDate = californiaDayEnd(q.to);
  const includeInactiveClients = q.includeInactive === true || q.includeInactiveClients === true;
  const sevenFrom = q.sevenFrom ?? q.from;
  const scope = dashboardScopeFromContext(c);
  const where = orderVisibilityWhere(c, q, fromDate, toDate, scope, { excludeCancelled: true });

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
    caller: dashboardCallerCacheScope(c, scope),
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
        to_char(date_trunc('day', ${orders.orderDate} at time zone 'America/Los_Angeles'), 'YYYY-MM-DD') as day,
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
  const fromDate = californiaDayStart(q.from);
  const toDate = californiaDayEnd(q.to);
  const scope = dashboardScopeFromContext(c);
  const where = orderVisibilityWhere(c, q, fromDate, toDate, scope);
  const includeInactiveClients = q.includeInactive === true || q.includeInactiveClients === true;
  type DashboardDailyCountsPayload = {
    data: Array<{ day: string; awaiting: number; shipped: number; cancelled: number; total: number }>;
  };
  const cacheKey = analyticsCacheKey('dashboard.daily-counts.v1', {
    from: q.from,
    to: q.to,
    clientId: q.clientId ?? null,
    storeId: q.storeId ?? null,
    includeInactiveClients,
    hideTestOrders: q.hideTestOrders === true,
    caller: dashboardCallerCacheScope(c, scope),
  });

  const cached = await getAnalyticsCache<DashboardDailyCountsPayload>(cacheKey);
  if (cached) return c.json(cached);

  const rows = await db.execute<{
    day: string;
    awaiting: number;
    shipped: number;
    cancelled: number;
    total: number;
  }>(sql`
    select
      to_char(date_trunc('day', ${orders.orderDate} at time zone 'America/Los_Angeles'), 'YYYY-MM-DD') as day,
      count(*) filter (where ${orders.orderStatus} = 'awaiting_shipment')::int as awaiting,
      count(*) filter (where ${orders.orderStatus} = 'shipped')::int as shipped,
      count(*) filter (where ${orders.orderStatus} = 'cancelled')::int as cancelled,
      count(*)::int as total
    from ${orders}
    where ${where}
    group by date_trunc('day', ${orders.orderDate} at time zone 'America/Los_Angeles')
    order by date_trunc('day', ${orders.orderDate} at time zone 'America/Los_Angeles') asc
  `);

  const payload = { data: rows };
  void setAnalyticsCache(cacheKey, payload, 60);
  return c.json(payload);
});

// Per-client daily order VALUE for the Daily Orders Trend multi-line
// ("All Clients") view. Read-only analytics — sums orders.orderTotal per
// (day, client), excluding cancelled to match the dashboard "Order value"
// line. Returns long rows; the frontend pivots to one line per client.
app.get('/daily-revenue-by-client', zValidator('query', dashboardRangeQuery), async (c) => {
  const q = c.req.valid('query');
  const fromDate = californiaDayStart(q.from);
  const toDate = californiaDayEnd(q.to);
  const scope = dashboardScopeFromContext(c);
  const where = orderVisibilityWhere(c, q, fromDate, toDate, scope, { excludeCancelled: true });
  const includeInactiveClients = q.includeInactive === true || q.includeInactiveClients === true;
  type DashboardDailyRevenueByClientPayload = {
    data: Array<{ day: string; clientId: number | null; revenue: number; count: number }>;
  };
  const cacheKey = analyticsCacheKey('dashboard.daily-revenue-by-client.v2', {
    from: q.from,
    to: q.to,
    clientId: q.clientId ?? null,
    storeId: q.storeId ?? null,
    includeInactiveClients,
    hideTestOrders: q.hideTestOrders === true,
    caller: dashboardCallerCacheScope(c, scope),
  });

  const cached = await getAnalyticsCache<DashboardDailyRevenueByClientPayload>(cacheKey);
  if (cached) return c.json(cached);

  const rows = await db.execute<{ day: string; clientId: number | null; revenue: number; count: number }>(sql`
    select
      to_char(date_trunc('day', ${orders.orderDate} at time zone 'America/Los_Angeles'), 'YYYY-MM-DD') as day,
      ${orders.clientId} as "clientId",
      coalesce(sum(${orders.orderTotal}), 0)::float8 as revenue,
      count(*)::int as count
    from ${orders}
    where ${where}
    group by date_trunc('day', ${orders.orderDate} at time zone 'America/Los_Angeles'), ${orders.clientId}
    order by date_trunc('day', ${orders.orderDate} at time zone 'America/Los_Angeles') asc
  `);

  const payload = { data: rows };
  void setAnalyticsCache(cacheKey, payload, 60);
  return c.json(payload);
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
  const scope = dashboardScopeFromContext(c);
  const includeInactiveClients = q.includeInactive === true || q.includeInactiveClients === true;
  const cacheKey = analyticsCacheKey('dashboard.sku-trends.v1', {
    from: q.from,
    to: q.to,
    clientId: q.clientId ?? null,
    storeId: q.storeId ?? null,
    top: q.top ?? null,
    topN: q.topN ?? null,
    includeCancelled: q.includeCancelled,
    includeInactiveClients,
    hideTestOrders: q.hideTestOrders === true,
    caller: dashboardCallerCacheScope(c, scope),
  });
  const cached = await getAnalyticsCache<Awaited<ReturnType<typeof getSkuDailyFromOrderItems>>>(cacheKey);
  if (cached) return c.json(cached);

  const payload = await getSkuDailyFromOrderItems({
    dateFrom: isoDayStart(q.from),
    dateTo: isoDayEnd(q.to),
    clientId: q.clientId,
    storeId: q.storeId,
    clientIds: scope.clientIds,
    storeIds: scope.storeIds,
    scopeRestricted: scope.isRestricted,
    top: q.top,
    topN: q.topN,
    hideTestOrders: q.hideTestOrders === true,
    includeCancelled: q.includeCancelled,
  });
  void setAnalyticsCache(cacheKey, payload, 120);
  return c.json(payload);
});

app.get('/top-skus', zValidator('query', dashboardTopSkusQuery), async (c) => {
  const q = c.req.valid('query');
  const scope = dashboardScopeFromContext(c);
  const includeInactiveClients = q.includeInactive === true || q.includeInactiveClients === true;
  const canViewFinancials = canViewDashboardFinancials(c);
  type DashboardTopSkusPayload = {
    data: unknown[];
    dateBuckets: string[];
    totalSkus: number;
    totalOrders: number;
  };
  const cacheKey = analyticsCacheKey('dashboard.top-skus.v1', {
    from: q.from,
    to: q.to,
    clientId: q.clientId ?? null,
    storeId: q.storeId ?? null,
    limit: q.limit,
    includeCancelled: q.includeCancelled,
    includeInactiveClients,
    hideTestOrders: q.hideTestOrders === true,
    caller: dashboardCallerCacheScope(c, scope),
    financials: canViewFinancials,
  });
  const cached = await getAnalyticsCache<DashboardTopSkusPayload>(cacheKey);
  if (cached) return c.json(cached);

  const result = await getSkuBreakdownFromOrderItems({
    dateFrom: isoDayStart(q.from),
    dateTo: isoDayEnd(q.to),
    clientId: q.clientId,
    storeId: q.storeId,
    clientIds: scope.clientIds,
    storeIds: scope.storeIds,
    scopeRestricted: scope.isRestricted,
    canViewFinancials,
    limit: q.limit,
    hideTestOrders: q.hideTestOrders === true,
    includeCancelled: q.includeCancelled,
  });
  const payload = {
    data: result.rows,
    dateBuckets: result.dateBuckets,
    totalSkus: result.totalSkus,
    totalOrders: result.totalOrders,
  };
  void setAnalyticsCache(cacheKey, payload, 120);
  return c.json(payload);
});

app.get('/inventory-risk', zValidator('query', dashboardInventoryRiskQuery), async (c) => {
  const q = c.req.valid('query');
  const scope = dashboardScopeFromContext(c);
  type DashboardInventoryRiskPayload = {
    items: unknown[];
    total: number;
  };
  const cacheKey = analyticsCacheKey('dashboard.inventory-risk.v1', {
    clientId: q.clientId ?? null,
    pageSize: q.pageSize,
    active: q.active,
    liveMetrics: q.liveMetrics,
    caller: dashboardCallerCacheScope(c, scope),
  });
  const cached = await getAnalyticsCache<DashboardInventoryRiskPayload>(cacheKey);
  if (cached) return c.json(cached);

  const callerEmail = c.get('email' as never) as string | undefined;
  const reportingMetricsAllowed = isAdminEmail(callerEmail) && !scope.isRestricted;
  if (reportingMetricsAllowed) {
    const metricsPayload = await getFreshInventoryRiskMetrics({
      clientId: q.clientId,
      pageSize: q.pageSize,
      active: q.active,
      maxAgeMinutes: 45,
    }).catch((err) => {
      console.warn(
        '[dashboard] inventory-risk reporting metrics unavailable:',
        err instanceof Error ? err.message : err
      );
      return null;
    });
    if (metricsPayload) {
      void setAnalyticsCache(cacheKey, metricsPayload, 60);
      return c.json(metricsPayload);
    }
  }

  const where = and(
    ...[
      q.clientId !== undefined ? eq(inventory.clientId, q.clientId) : undefined,
      q.active !== undefined ? eq(inventory.active, q.active) : undefined,
      inventoryScopePredicate(scope),
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
  const shouldRunLiveMetrics = q.liveMetrics === true;
  const soldRows = ids.length && shouldRunLiveMetrics
    ? await db.execute<{ inventory_id: number; sold_last_30_days: number }>(sql`
        with ship_rows as (
          select l.inventory_id, l.order_id, min(l.qty)::int as qty
          from ${inventoryLedger} l
          where l.inventory_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
            and l.type = 'ship'
            and l.order_id is not null
            and l.created_at >= now() - interval '30 days'
          group by l.inventory_id, l.order_id
        )
        select
          ship_rows.inventory_id,
          abs(coalesce(sum(ship_rows.qty), 0))::int as sold_last_30_days
        from ship_rows
        group by ship_rows.inventory_id
      `)
    : [];
  const soldByInventoryId = new Map(
    soldRows.map((row) => [row.inventory_id, Number(row.sold_last_30_days) || 0])
  );

  // PS-133: delegate to the canonical effective-stock owner. This FIXES the prior drift bug
  // where effectiveStock = total_received - total_sold, which IGNORED adjust/remove/damage/
  // pick ledger rows. The owner uses the full ledger_balance (all non-ship rows + dedup ship
  // rows) with a stock_qty fallback — identical to the inventory list + admin reconcile.
  const effectiveByInventoryId = ids.length && shouldRunLiveMetrics
    ? await computeEffectiveStockForIds(ids)
    : new Map<number, EffectiveStockEntry>();

  const payload = {
    items: rows.map((row) => {
      const stockQty = Number(row.stockQty ?? 0) || 0;
      const reorderLevel = Number(row.reorderLevel ?? 0) || 0;
      const eff = effectiveByInventoryId.get(row.id) ?? {
        totalReceived: 0,
        totalSold: 0,
        effectiveStock: stockQty,
      };
      return {
        ...row,
        soldLast30Days: soldByInventoryId.get(row.id) ?? 0,
        soldLast7Days: 0,
        velocityPerDay: 0,
        daysSupply: null,
        restockQty: Math.max(0, reorderLevel - stockQty),
        totalReceived: eff.totalReceived,
        totalSoldAllTime: eff.totalSold,
        effectiveStock: eff.effectiveStock,
      };
    }),
    total: rows.length,
  };
  void setAnalyticsCache(cacheKey, payload, 60);
  return c.json(payload);
});

export default app;
