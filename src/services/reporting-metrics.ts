import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client';

const DEFAULT_REFRESH_DAYS = 45;
const DEFAULT_INVENTORY_LIMIT = 5000;
const DEFAULT_REPORTING_READ_TIMEOUT_MS = 1200;

let ensurePromise: Promise<void> | null = null;

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

type ReportingRefreshScope =
  | 'daily-sales'
  | 'sku-velocity'
  | 'inventory-risk'
  | 'billing-summary'
  | 'all';

export type ReportingMetricsRefreshResult = {
  refreshed: true;
  days: number;
  dailyRows: number;
  skuRows: number;
  inventoryRows: number;
  billingRows: number;
};

export type ReportingMetricsStatus = {
  tablesReady: boolean;
  dailyRows: number;
  skuRows: number;
  inventoryRows: number;
  billingRows: number;
  updatedAt: {
    dailySales: string | null;
    skuVelocity: string | null;
    inventoryRisk: string | null;
    billingSummary: string | null;
  };
  lastRuns: Array<{
    scope: string;
    status: string;
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
    rowsAffected: number;
    error: string | null;
  }>;
};

export type InventoryRiskMetricRow = {
  id: number;
  clientId: number | null;
  sku: string;
  name: string | null;
  imageUrl: string | null;
  stockQty: number;
  reorderLevel: number;
  active: boolean;
  soldLast7Days: number;
  soldLast30Days: number;
  velocityPerDay: number;
  daysSupply: number | null;
  restockQty: number;
  totalReceived: number;
  totalSoldAllTime: number;
  effectiveStock: number;
  metricsUpdatedAt: string | null;
};

export type BillingSummaryMetricRow = {
  clientId: number;
  clientName: string;
  pickPackTotal: number;
  additionalTotal: number;
  pickPackFeeTotal: number;
  packageTotal: number;
  shippingTotal: number;
  storageTotal: number;
  fulfillmentFeeTotal: number;
  orderCount: number;
  grandTotal: number;
  total: number;
  count: number;
  byType: Record<string, number>;
};

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function num(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function reportingReadErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function optionalReportingRead<T>(
  label: string,
  fallback: T,
  fn: () => Promise<T>
): Promise<T> {
  const timeoutMs = Number(process.env.REPORTING_READ_TIMEOUT_MS ?? DEFAULT_REPORTING_READ_TIMEOUT_MS);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((resolve) => {
        timeoutId = setTimeout(() => {
          console.warn(`[reporting-metrics] ${label} timed out after ${timeoutMs}ms; using fallback`);
          resolve(fallback);
        }, timeoutMs);
      }),
    ]);
  } catch (err) {
    console.warn(`[reporting-metrics] ${label} unavailable:`, reportingReadErrorMessage(err));
    return fallback;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function ensureTables(): Promise<void> {
  const rows = await db.execute<{ table_name: string }>(sql`
    with required(table_name) as (
      values
        ('reporting_refresh_runs'),
        ('daily_sales_metrics'),
        ('sku_velocity_metrics'),
        ('inventory_risk_metrics'),
        ('billing_summary_metrics')
    )
    select table_name
    from required
    where to_regclass('public.' || table_name) is null
    order by table_name
  `);

  if (rows.length > 0) {
    throw new Error(
      `Reporting metrics migration is missing tables: ${rows
        .map((row) => row.table_name)
        .join(', ')}. Run drizzle/0029_reporting_metrics.sql before refreshing reporting metrics.`
    );
  }
}

export function ensureReportingMetricsTables(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = ensureTables().catch((err) => {
      ensurePromise = null;
      throw err;
    });
  }
  return ensurePromise;
}

async function withRefreshRun<T>(
  scope: ReportingRefreshScope,
  fn: () => Promise<{ result: T; rowsAffected: number }>
): Promise<T> {
  const startedAt = Date.now();
  const [run] = await db.execute<{ id: number }>(sql`
    insert into reporting_refresh_runs (scope, status)
    values (${scope}, 'running')
    returning id
  `);

  try {
    const { result, rowsAffected } = await fn();
    await db.execute(sql`
      update reporting_refresh_runs
      set
        status = 'success',
        finished_at = now(),
        duration_ms = ${Date.now() - startedAt},
        rows_affected = ${rowsAffected},
        error = null
      where id = ${run?.id}
    `);
    return result;
  } catch (err) {
    await db.execute(sql`
      update reporting_refresh_runs
      set
        status = 'failure',
        finished_at = now(),
        duration_ms = ${Date.now() - startedAt},
        error = ${err instanceof Error ? err.message : String(err)}
      where id = ${run?.id}
    `);
    throw err;
  }
}

async function refreshDailySalesMetrics(from: Date, to: Date): Promise<number> {
  const fromDay = isoDate(from);
  const toDay = isoDate(to);

  return withRefreshRun('daily-sales', async () => {
    await db.execute(sql`
      delete from daily_sales_metrics
      where day between ${fromDay}::date and ${toDay}::date
        and client_id = 0
        and store_id = 0
    `);

    await db.execute(sql`
      insert into daily_sales_metrics (
        day,
        client_id,
        store_id,
        order_count,
        shipped_count,
        cancelled_count,
        unit_count,
        revenue,
        updated_at
      )
      with order_unit_totals as (
        select
          oi.order_id,
          coalesce(sum(greatest(coalesce(oi.quantity::numeric, 0), 0)), 0)::numeric(14, 3) as units
        from order_items oi
        where oi.order_date >= ${from.toISOString()}::timestamptz
          and oi.order_date <= ${to.toISOString()}::timestamptz
        group by oi.order_id
      )
      select
        date_trunc('day', o.order_date)::date as day,
        0 as client_id,
        0 as store_id,
        count(*)::int as order_count,
        count(*) filter (where o.order_status = 'shipped')::int as shipped_count,
        count(*) filter (where o.order_status = 'cancelled')::int as cancelled_count,
        coalesce(sum(ut.units), 0)::numeric(14, 3) as unit_count,
        coalesce(sum(
          case
            when o.order_status = 'cancelled' then 0
            else coalesce(o.order_total::numeric, 0)
          end
        ), 0)::numeric(14, 2) as revenue,
        now() as updated_at
      from orders o
      left join clients c on c.id = o.client_id
      left join order_unit_totals ut on ut.order_id = o.id
      where o.order_date >= ${from.toISOString()}::timestamptz
        and o.order_date <= ${to.toISOString()}::timestamptz
        and (c.id is null or coalesce(c.is_test, false) = false)
      group by date_trunc('day', o.order_date)::date
      on conflict (day, client_id, store_id)
      do update set
        order_count = excluded.order_count,
        shipped_count = excluded.shipped_count,
        cancelled_count = excluded.cancelled_count,
        unit_count = excluded.unit_count,
        revenue = excluded.revenue,
        updated_at = now()
    `);

    const [row] = await db.execute<{ count: string | number }>(sql`
      select count(*) as count
      from daily_sales_metrics
      where day between ${fromDay}::date and ${toDay}::date
        and client_id = 0
        and store_id = 0
    `);
    const count = num(row?.count);
    return { result: count, rowsAffected: count };
  });
}

async function refreshSkuVelocityMetrics(): Promise<number> {
  return withRefreshRun('sku-velocity', async () => {
    await db.execute(sql`delete from sku_velocity_metrics`);

    await db.execute(sql`
      insert into sku_velocity_metrics (
        sku,
        client_id,
        sold_7d,
        sold_30d,
        velocity_per_day,
        updated_at
      )
      with clean_items as (
        select
          nullif(trim(oi.sku), '') as sku,
          coalesce(oi.client_id, 0) as client_id,
          oi.order_date,
          greatest(coalesce(oi.quantity::numeric, 0), 0) as quantity
        from order_items oi
        left join clients c on c.id = oi.client_id
        where oi.order_date >= now() - interval '30 days'
          and coalesce(oi.order_status, '') <> 'cancelled'
          and coalesce(c.is_test, false) = false
      )
      select
        sku,
        client_id,
        coalesce(sum(quantity) filter (where order_date >= now() - interval '7 days'), 0)::int as sold_7d,
        coalesce(sum(quantity), 0)::int as sold_30d,
        (coalesce(sum(quantity), 0) / 30.0)::numeric(12, 4) as velocity_per_day,
        now() as updated_at
      from clean_items
      where sku is not null
      group by sku, client_id
      on conflict (sku, client_id)
      do update set
        sold_7d = excluded.sold_7d,
        sold_30d = excluded.sold_30d,
        velocity_per_day = excluded.velocity_per_day,
        updated_at = now()
    `);

    const [row] = await db.execute<{ count: string | number }>(sql`
      select count(*) as count from sku_velocity_metrics
    `);
    const count = num(row?.count);
    return { result: count, rowsAffected: count };
  });
}

async function refreshInventoryRiskMetrics(limit: number): Promise<number> {
  return withRefreshRun('inventory-risk', async () => {
    await db.execute(sql`delete from inventory_risk_metrics`);

    await db.execute(sql`
      insert into inventory_risk_metrics (
        inventory_id,
        sku,
        client_id,
        stock_qty,
        reorder_level,
        sold_7d,
        sold_30d,
        velocity_per_day,
        days_supply,
        restock_qty,
        total_received,
        total_sold_all_time,
        effective_stock,
        updated_at
      )
      with inventory_scope as (
        select *
        from inventory
        where active = true
        order by updated_at desc
        limit ${limit}
      ),
      receives as (
        select
          l.inventory_id,
          coalesce(sum(l.qty), 0)::int as total_received
        from inventory_ledger l
        join inventory_scope i on i.id = l.inventory_id
        where l.type = 'receive'
        group by l.inventory_id
      ),
      ledger_balance as (
        select
          l.inventory_id,
          coalesce(sum(l.qty), 0)::int as effective_stock
        from inventory_ledger l
        join inventory_scope i on i.id = l.inventory_id
        group by l.inventory_id
      ),
      sold as (
        select
          i.id as inventory_id,
          coalesce(sum(oi.quantity) filter (
            where oi.order_date >= now() - interval '7 days'
              and coalesce(oi.order_status, '') <> 'cancelled'
          ), 0)::int as sold_7d,
          coalesce(sum(oi.quantity) filter (
            where oi.order_date >= now() - interval '30 days'
              and coalesce(oi.order_status, '') <> 'cancelled'
          ), 0)::int as sold_30d,
          coalesce(sum(oi.quantity) filter (
            where oi.order_status = 'shipped'
          ), 0)::int as total_sold_all_time
        from inventory_scope i
        join order_items oi
          on lower(oi.sku) = lower(i.sku)
          and (
            (i.client_id is null and oi.client_id is null)
            or i.client_id = oi.client_id
          )
        left join clients c on c.id = oi.client_id
        where oi.quantity > 0
          and coalesce(c.is_test, false) = false
        group by i.id
      ),
      computed as (
        select
          i.id as inventory_id,
          i.sku,
          i.client_id,
          coalesce(i.stock_qty, 0)::int as stock_qty,
          coalesce(i.reorder_level, 0)::int as reorder_level,
          coalesce(s.sold_7d, 0)::int as sold_7d,
          coalesce(s.sold_30d, 0)::int as sold_30d,
          (coalesce(s.sold_30d, 0) / 30.0)::numeric(12, 4) as velocity_per_day,
          coalesce(r.total_received, 0)::int as total_received,
          coalesce(s.total_sold_all_time, 0)::int as total_sold_all_time,
          coalesce(lb.effective_stock, i.stock_qty, 0)::int as effective_stock
        from inventory_scope i
        left join receives r on r.inventory_id = i.id
        left join ledger_balance lb on lb.inventory_id = i.id
        left join sold s on s.inventory_id = i.id
      )
      select
        inventory_id,
        sku,
        client_id,
        stock_qty,
        reorder_level,
        sold_7d,
        sold_30d,
        velocity_per_day,
        case
          when velocity_per_day > 0 then (effective_stock / velocity_per_day)::numeric(12, 2)
          else null
        end as days_supply,
        greatest(
          0,
          ceil(greatest(reorder_level::numeric, velocity_per_day * 14) - effective_stock)
        )::int as restock_qty,
        total_received,
        total_sold_all_time,
        effective_stock,
        now() as updated_at
      from computed
      on conflict (inventory_id)
      do update set
        sku = excluded.sku,
        client_id = excluded.client_id,
        stock_qty = excluded.stock_qty,
        reorder_level = excluded.reorder_level,
        sold_7d = excluded.sold_7d,
        sold_30d = excluded.sold_30d,
        velocity_per_day = excluded.velocity_per_day,
        days_supply = excluded.days_supply,
        restock_qty = excluded.restock_qty,
        total_received = excluded.total_received,
        total_sold_all_time = excluded.total_sold_all_time,
        effective_stock = excluded.effective_stock,
        updated_at = now()
    `);

    const [row] = await db.execute<{ count: string | number }>(sql`
      select count(*) as count from inventory_risk_metrics
    `);
    const count = num(row?.count);
    return { result: count, rowsAffected: count };
  });
}

export async function refreshBillingSummaryMetrics(from: Date, to: Date): Promise<number> {
  await ensureReportingMetricsTables();
  const fromDay = isoDate(from);
  const toDay = isoDate(to);

  return withRefreshRun('billing-summary', async () => {
    await db.execute(sql`
      delete from billing_summary_metrics
      where period_from = ${fromDay}::date
        and period_to = ${toDay}::date
    `);

    await db.execute(sql`
      insert into billing_summary_metrics (
        client_id,
        period_from,
        period_to,
        order_count,
        pick_pack_total,
        additional_total,
        package_total,
        shipping_total,
        storage_total,
        grand_total,
        updated_at
      )
      select
        c.id as client_id,
        ${fromDay}::date as period_from,
        ${toDay}::date as period_to,
        count(distinct b.order_id)::int as order_count,
        coalesce(sum(case when b.line_type = 'pick_pack' then b.total_cost else 0 end), 0)::numeric(14, 2) as pick_pack_total,
        coalesce(sum(case when b.line_type = 'additional_unit' then b.total_cost else 0 end), 0)::numeric(14, 2) as additional_total,
        coalesce(sum(case when b.line_type = 'package_cost' then b.total_cost else 0 end), 0)::numeric(14, 2) as package_total,
        coalesce(sum(case when b.line_type = 'shipping' then b.total_cost else 0 end), 0)::numeric(14, 2) as shipping_total,
        coalesce(sum(case when b.line_type = 'storage' then b.total_cost else 0 end), 0)::numeric(14, 2) as storage_total,
        coalesce(sum(b.total_cost), 0)::numeric(14, 2) as grand_total,
        now() as updated_at
      from clients c
      left join billing_line_items b
        on b.client_id = c.id
        and b.ship_date >= ${from.toISOString()}::timestamptz
        and b.ship_date <= ${to.toISOString()}::timestamptz
      where c.active = true
        and c.name not in ('Manual Orders', 'Rate Browser', 'Api Shipments')
      group by c.id
      on conflict (client_id, period_from, period_to)
      do update set
        order_count = excluded.order_count,
        pick_pack_total = excluded.pick_pack_total,
        additional_total = excluded.additional_total,
        package_total = excluded.package_total,
        shipping_total = excluded.shipping_total,
        storage_total = excluded.storage_total,
        grand_total = excluded.grand_total,
        updated_at = now()
    `);

    const [row] = await db.execute<{ count: string | number }>(sql`
      select count(*) as count
      from billing_summary_metrics
      where period_from = ${fromDay}::date
        and period_to = ${toDay}::date
    `);
    const count = num(row?.count);
    return { result: count, rowsAffected: count };
  });
}

export async function refreshReportingMetrics(
  options: {
    days?: number;
    inventoryLimit?: number;
    billingFrom?: Date;
    billingTo?: Date;
  } = {}
): Promise<ReportingMetricsRefreshResult> {
  await ensureReportingMetricsTables();
  const days = options.days ?? DEFAULT_REFRESH_DAYS;
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const billingTo = options.billingTo ?? to;
  const billingFrom =
    options.billingFrom ?? new Date(Date.UTC(billingTo.getUTCFullYear(), billingTo.getUTCMonth(), 1));

  const dailyRows = await refreshDailySalesMetrics(from, to);
  const skuRows = await refreshSkuVelocityMetrics();
  const inventoryRows = await refreshInventoryRiskMetrics(
    options.inventoryLimit ?? DEFAULT_INVENTORY_LIMIT
  );
  const billingRows = await refreshBillingSummaryMetrics(billingFrom, billingTo);

  await withRefreshRun('all', async () => ({
    result: null,
    rowsAffected: dailyRows + skuRows + inventoryRows + billingRows,
  }));

  return {
    refreshed: true,
    days,
    dailyRows,
    skuRows,
    inventoryRows,
    billingRows,
  };
}

export async function getReportingMetricsStatus(): Promise<ReportingMetricsStatus> {
  await ensureReportingMetricsTables();

  const [counts] = await db.execute<{
    daily_rows: string | number;
    sku_rows: string | number;
    inventory_rows: string | number;
    billing_rows: string | number;
    daily_updated_at: string | Date | null;
    sku_updated_at: string | Date | null;
    inventory_updated_at: string | Date | null;
    billing_updated_at: string | Date | null;
  }>(sql`
    select
      (select count(*) from daily_sales_metrics) as daily_rows,
      (select count(*) from sku_velocity_metrics) as sku_rows,
      (select count(*) from inventory_risk_metrics) as inventory_rows,
      (select count(*) from billing_summary_metrics) as billing_rows,
      (select max(updated_at) from daily_sales_metrics) as daily_updated_at,
      (select max(updated_at) from sku_velocity_metrics) as sku_updated_at,
      (select max(updated_at) from inventory_risk_metrics) as inventory_updated_at,
      (select max(updated_at) from billing_summary_metrics) as billing_updated_at
  `);

  const runs = await db.execute<{
    scope: string;
    status: string;
    started_at: string | Date | null;
    finished_at: string | Date | null;
    duration_ms: number | null;
    rows_affected: number | null;
    error: string | null;
  }>(sql`
    select distinct on (scope)
      scope,
      status,
      started_at,
      finished_at,
      duration_ms,
      rows_affected,
      error
    from reporting_refresh_runs
    order by scope, started_at desc
    limit 20
  `);

  const normalizeDate = (value: string | Date | null | undefined): string | null => {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : String(value);
  };

  return {
    tablesReady: true,
    dailyRows: num(counts?.daily_rows),
    skuRows: num(counts?.sku_rows),
    inventoryRows: num(counts?.inventory_rows),
    billingRows: num(counts?.billing_rows),
    updatedAt: {
      dailySales: normalizeDate(counts?.daily_updated_at),
      skuVelocity: normalizeDate(counts?.sku_updated_at),
      inventoryRisk: normalizeDate(counts?.inventory_updated_at),
      billingSummary: normalizeDate(counts?.billing_updated_at),
    },
    lastRuns: runs.map((row) => ({
      scope: row.scope,
      status: row.status,
      startedAt: normalizeDate(row.started_at),
      finishedAt: normalizeDate(row.finished_at),
      durationMs: row.duration_ms,
      rowsAffected: num(row.rows_affected),
      error: row.error,
    })),
  };
}

export async function getFreshInventoryRiskMetrics(options: {
  clientId?: number;
  pageSize: number;
  active?: boolean;
  maxAgeMinutes?: number;
}): Promise<{ items: InventoryRiskMetricRow[]; total: number; source: 'reporting_metrics' } | null> {
  const maxAgeMinutes = options.maxAgeMinutes ?? 15;

  return optionalReportingRead('inventory-risk read model', null, async () => {
    const rows = await db.execute<{
      id: number;
      client_id: number | null;
      sku: string;
      name: string | null;
      image_url: string | null;
      stock_qty: number;
      reorder_level: number;
      active: boolean;
      sold_last_7_days: number;
      sold_last_30_days: number;
      velocity_per_day: string | number;
      days_supply: string | number | null;
      restock_qty: number;
      total_received: number;
      total_sold_all_time: number;
      effective_stock: number;
      metrics_updated_at: string | Date | null;
    }>(sql`
      select
        i.id,
        i.client_id,
        i.sku,
        i.name,
        i.image_url,
        i.stock_qty,
        i.reorder_level,
        i.active,
        m.sold_7d as sold_last_7_days,
        m.sold_30d as sold_last_30_days,
        m.velocity_per_day,
        m.days_supply,
        m.restock_qty,
        m.total_received,
        m.total_sold_all_time,
        m.effective_stock,
        m.updated_at as metrics_updated_at
      from inventory_risk_metrics m
      join inventory i on i.id = m.inventory_id
      where m.updated_at >= now() - (${maxAgeMinutes} * interval '1 minute')
        and (${options.active ?? null}::boolean is null or i.active = ${options.active ?? null}::boolean)
        and (${options.clientId ?? null}::int is null or i.client_id = ${options.clientId ?? null}::int)
      order by m.restock_qty desc, m.sold_30d desc, i.updated_at desc
      limit ${options.pageSize}
    `);

    if (rows.length === 0) return null;

    return {
      items: rows.map((row) => ({
        id: row.id,
        clientId: row.client_id,
        sku: row.sku,
        name: row.name,
        imageUrl: row.image_url,
        stockQty: num(row.stock_qty),
        reorderLevel: num(row.reorder_level),
        active: row.active,
        soldLast7Days: num(row.sold_last_7_days),
        soldLast30Days: num(row.sold_last_30_days),
        velocityPerDay: num(row.velocity_per_day),
        daysSupply: row.days_supply == null ? null : num(row.days_supply),
        restockQty: num(row.restock_qty),
        totalReceived: num(row.total_received),
        totalSoldAllTime: num(row.total_sold_all_time),
        effectiveStock: num(row.effective_stock),
        metricsUpdatedAt:
          row.metrics_updated_at instanceof Date
            ? row.metrics_updated_at.toISOString()
            : row.metrics_updated_at == null
              ? null
              : String(row.metrics_updated_at),
      })),
      total: rows.length,
      source: 'reporting_metrics',
    };
  });
}

export async function getFreshInventoryRiskMetricMap(
  ids: number[],
  options: { maxAgeMinutes?: number } = {}
): Promise<Map<number, InventoryRiskMetricRow>> {
  if (ids.length === 0) return new Map();
  const maxAgeMinutes = options.maxAgeMinutes ?? 45;

  return optionalReportingRead('inventory-risk metric map', new Map(), async () => {
    const rows = await db.execute<{
      id: number;
      client_id: number | null;
      sku: string;
      name: string | null;
      image_url: string | null;
      stock_qty: number;
      reorder_level: number;
      active: boolean;
      sold_last_7_days: number;
      sold_last_30_days: number;
      velocity_per_day: string | number;
      days_supply: string | number | null;
      restock_qty: number;
      total_received: number;
      total_sold_all_time: number;
      effective_stock: number;
      metrics_updated_at: string | Date | null;
    }>(sql`
      select
        i.id,
        i.client_id,
        i.sku,
        i.name,
        i.image_url,
        i.stock_qty,
        i.reorder_level,
        i.active,
        m.sold_7d as sold_last_7_days,
        m.sold_30d as sold_last_30_days,
        m.velocity_per_day,
        m.days_supply,
        m.restock_qty,
        m.total_received,
        m.total_sold_all_time,
        m.effective_stock,
        m.updated_at as metrics_updated_at
      from inventory_risk_metrics m
      join inventory i on i.id = m.inventory_id
      where m.inventory_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
        and m.updated_at >= now() - (${maxAgeMinutes} * interval '1 minute')
    `);

    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          clientId: row.client_id,
          sku: row.sku,
          name: row.name,
          imageUrl: row.image_url,
          stockQty: num(row.stock_qty),
          reorderLevel: num(row.reorder_level),
          active: row.active,
          soldLast7Days: num(row.sold_last_7_days),
          soldLast30Days: num(row.sold_last_30_days),
          velocityPerDay: num(row.velocity_per_day),
          daysSupply: row.days_supply == null ? null : num(row.days_supply),
          restockQty: num(row.restock_qty),
          totalReceived: num(row.total_received),
          totalSoldAllTime: num(row.total_sold_all_time),
          effectiveStock: num(row.effective_stock),
          metricsUpdatedAt:
            row.metrics_updated_at instanceof Date
              ? row.metrics_updated_at.toISOString()
              : row.metrics_updated_at == null
                ? null
                : String(row.metrics_updated_at),
        },
      ])
    );
  });
}

export async function getFreshBillingSummaryMetrics(options: {
  dateFrom: string;
  dateTo: string;
  clientId?: number;
  scopeClientIds?: number[];
  scopeStoreIds?: number[];
  scopeRestricted?: boolean;
  maxAgeMinutes?: number;
}): Promise<{ clients: BillingSummaryMetricRow[]; grandTotal: number } | null> {
  const maxAgeMinutes = options.maxAgeMinutes ?? 45;
  const fromDay = isoDate(new Date(options.dateFrom));
  const toDay = isoDate(new Date(options.dateTo));
  const billingMetricsScopePredicate = (() => {
    const clientIds = normalizeScopeIds(options.scopeClientIds);
    const storeIds = normalizeScopeIds(options.scopeStoreIds);
    const predicates: SQL[] = [];
    if (clientIds.length) {
      predicates.push(sql`m.client_id = any(${intArraySql(clientIds)})`);
    }
    if (storeIds.length) {
      predicates.push(sql`c.store_ids && ${intArraySql(storeIds)}`);
    }
    if (!predicates.length) {
      return options.scopeRestricted === true ? sql`false` : sql`true`;
    }
    if (predicates.length === 1) return predicates[0]!;
    return sql`(${sql.join(predicates, sql` or `)})`;
  })();

  return optionalReportingRead('billing-summary read model', null, async () => {
    const rows = await db.execute<{
      client_id: number;
      client_name: string;
      pick_pack_total: string | number;
      additional_total: string | number;
      package_total: string | number;
      shipping_total: string | number;
      storage_total: string | number;
      order_count: number;
      grand_total: string | number;
    }>(sql`
      select
        c.id as client_id,
        c.name as client_name,
        m.pick_pack_total,
        m.additional_total,
        m.package_total,
        m.shipping_total,
        m.storage_total,
        m.order_count,
        m.grand_total
      from billing_summary_metrics m
      join clients c on c.id = m.client_id
      where m.period_from = ${fromDay}::date
        and m.period_to = ${toDay}::date
        and m.updated_at >= now() - (${maxAgeMinutes} * interval '1 minute')
        and (${options.clientId ?? null}::int is null or m.client_id = ${options.clientId ?? null}::int)
        and ${billingMetricsScopePredicate}
      order by c.name asc
    `);

    if (rows.length === 0) return null;

    const clients = rows.map((row) => {
      const pickPackTotal = num(row.pick_pack_total);
      const additionalTotal = num(row.additional_total);
      const packageTotal = num(row.package_total);
      const shippingTotal = num(row.shipping_total);
      const storageTotal = num(row.storage_total);
      const grandTotal = num(row.grand_total);
      const orderCount = num(row.order_count);
      const pickPackFeeTotal = pickPackTotal + additionalTotal;
      const fulfillmentFeeTotal =
        shippingTotal + pickPackFeeTotal + packageTotal + storageTotal;
      return {
        clientId: row.client_id,
        clientName: row.client_name,
        pickPackTotal,
        additionalTotal,
        pickPackFeeTotal,
        packageTotal,
        shippingTotal,
        storageTotal,
        fulfillmentFeeTotal,
        orderCount,
        grandTotal,
        total: grandTotal,
        count: orderCount,
        byType: {
          pick_pack: pickPackTotal,
          additional_unit: additionalTotal,
          package_cost: packageTotal,
          shipping: shippingTotal,
          storage: storageTotal,
        },
      };
    });

    return {
      clients,
      grandTotal: clients.reduce((sum, client) => sum + client.grandTotal, 0),
    };
  });
}
