import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, ilike, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { inventory, inventoryLedger } from '../db/schema/inventory';
import { inventorySkuParents } from '../db/schema/inventory-sku-parents';
import { orders } from '../db/schema/orders';
import { parentSkus } from '../db/schema/parent-skus';
import { offsetOf, paginated, paginationSchema } from '../lib/pagination';
import { applyMovement, inventoryStats } from '../services/inventory';
import {
  importSkusFromOrders,
  syncShipStationProducts,
} from '../services/inventory-enrichment';

const app = new Hono();

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
const activeInventoryClientPredicate = sql`(
  ${inventory.clientId} is null
  or exists (
    select 1 from clients visible_client
    where visible_client.id = ${inventory.clientId}
      and coalesce(visible_client.active, true) = true
  )
)`;

const listQuery = paginationSchema.extend({
  clientId: z.coerce.number().int().optional(),
  search: z.string().optional(),
  lowStock: z.coerce.boolean().optional(),
  // Opt-in flag — when true, the response includes inventory rows
  // where active=false. Default behavior (omitted/false) keeps the
  // legacy "active-only" semantics so the rate browser, order
  // auto-fulfillment lookups, and Receive tab don't accidentally
  // start seeing deactivated SKUs. Currently only the Stock Levels
  // tab sets this when its "Active only" toolbar toggle is off.
  includeInactive: z.coerce.boolean().optional(),
});

app.get('/', zValidator('query', listQuery), async (c) => {
  const q = c.req.valid('query');
  const where = and(
    ...[
      q.clientId !== undefined ? eq(inventory.clientId, q.clientId) : undefined,
      q.search
        ? or(
            ilike(inventory.sku, `%${q.search}%`),
            ilike(inventory.name, `%${q.search}%`)
          )
        : undefined,
      q.lowStock ? lte(inventory.stockQty, inventory.reorderLevel) : undefined,
      // Active filter: applied unless the caller explicitly asks
      // for everything via ?includeInactive=true.
      q.includeInactive ? undefined : eq(inventory.active, true),
      activeInventoryClientPredicate,
    ].filter(<T>(x: T | undefined): x is T => x !== undefined)
  );

  const [rows, countRows] = await Promise.all([
    db
      .select()
      .from(inventory)
      .where(where)
      .orderBy(desc(inventory.updatedAt))
      .limit(q.pageSize)
      .offset(offsetOf(q)),
    db.select({ count: sql<number>`count(*)::int` }).from(inventory).where(where),
  ]);

  const soldRows = rows.length
    ? await db.execute<{ inventory_id: number; sold_last_30_days: number }>(sql`
        select
          i.id as inventory_id,
          coalesce(sum(
            case
              when coalesce(item->>'quantity', '') ~ '^[0-9]+$'
                then (item->>'quantity')::int
              else 1
            end
          ), 0)::int as sold_last_30_days
        from ${inventory} i
        join ${orders} o
          on (
            (i.client_id is null and o.client_id is null)
            or i.client_id = o.client_id
          )
        cross join lateral jsonb_array_elements(o.items) item
        where i.id in (${sql.join(rows.map((row) => sql`${row.id}`), sql`, `)})
          and item ? 'sku'
          and lower(item->>'sku') = lower(i.sku)
          and coalesce(item->>'adjustment', 'false') <> 'true'
          and o.order_date >= now() - interval '30 days'
          and coalesce(o.order_status, '') <> 'cancelled'
        group by i.id
      `)
    : [];
  const soldByInventoryId = new Map(
    soldRows.map((row) => [row.inventory_id, Number(row.sold_last_30_days) || 0])
  );

  // 2026-05-13 / refined 2026-05-14 (a+b+c): operator reported the
  // STOCK column shows numbers that don't match -SOLD. Root cause:
  // `stockQty` is only mutated by the auto-deduct path, which
  // didn't track historical orders shipped before the system came
  // online and skips edge cases like external labels.
  //
  // Definition (current — revision (c) 2026-05-14):
  //
  //   effective_stock = total_received − total_sold_shipped_all_time
  //
  // The one non-obvious filter on the sold counter:
  //   Only count `order_status = 'shipped'` (NOT "any non-
  //   cancelled order"). An awaiting_shipment order represents a
  //   future commitment, not inventory that has physically left
  //   the building. STOCK is meant to reflect what we actually
  //   have on the floor right now.
  //
  // History of attempts:
  //   (a) sum of all non-cancelled order quantities — inflated by
  //       awaiting_shipment orders, didn't match operator's "what
  //       has actually gone out" mental model.
  //   (b) anchored sold counter at inventory.created_at — backfired
  //       on auto-synced SKUs whose created_at is TODAY but whose
  //       order history goes back further. Most SKUs are auto-
  //       synced, so most rows came out wrong.
  //   (c) (current) no created_at anchor. For an operator who hasn't
  //       received anything, STOCK = −(every order they've ever
  //       shipped for this SKU). Matches their mental model
  //       exactly: "we haven't received any, so STOCK should be
  //       what's gone."
  //
  // Returns: if a shipment carries `isReturn=true` we should
  // technically add the qty back. We don't yet — returns are rare
  // and the shipments table doesn't break down qty per item.
  //
  // SOLD 30D stays unrelated to this — it's an unbounded "last 30
  // days regardless of status" window by design, used as a "recent
  // velocity" indicator, not a stock signal.
  //
  // The cached stockQty stays in the response as `currentStock` for
  // backward-compat; the new `effectiveStock` is what the operator
  // sees in the STOCK column. A separate admin endpoint
  // POST /admin/reconcile-inventory-stock can backfill stockQty to
  // match effectiveStock for every row (see admin.ts).
  //
  // Allowed under the shipped-data lockdown: this is a READ-only
  // analytics computation. No locked rows are mutated.
  const effectiveRows = rows.length
    ? await db.execute<{
        inventory_id: number
        total_received: number
        total_sold: number
      }>(sql`
        with ids as (
          select unnest(array[${sql.join(rows.map((r) => sql`${r.id}`), sql`, `)}]::int[]) as id
        ),
        receives as (
          select l.inventory_id as id, coalesce(sum(l.qty), 0)::int as total_received
          from ${inventoryLedger} l
          where l.inventory_id in (select id from ids)
            and l.type = 'receive'
          group by l.inventory_id
        ),
        sells as (
          select i.id as id, coalesce(sum(
            case
              when coalesce(item->>'quantity', '') ~ '^[0-9]+$'
                then (item->>'quantity')::int
              else 1
            end
          ), 0)::int as total_sold
          from ${inventory} i
          join ${orders} o
            on (
              (i.client_id is null and o.client_id is null)
              or i.client_id = o.client_id
            )
          cross join lateral jsonb_array_elements(o.items) item
          where i.id in (select id from ids)
            and item ? 'sku'
            and lower(item->>'sku') = lower(i.sku)
            and coalesce(item->>'adjustment', 'false') <> 'true'
            -- Only physically-shipped orders count toward sold.
            -- awaiting_shipment = future commitment, not gone.
            -- cancelled = never went out. shipped = left the floor.
            -- (Revision (c): the created_at anchor that lived here
            -- was removed — it backfired on auto-synced SKUs whose
            -- created_at is TODAY but whose order history is
            -- older. See the long comment block above for the
            -- full reasoning.)
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

  return c.json(paginated(
    rows.map((row) => {
      const eff = effectiveByInventoryId.get(row.id) ?? { totalReceived: 0, totalSold: 0, effectiveStock: 0 };
      return {
        ...row,
        soldLast30Days: soldByInventoryId.get(row.id) ?? 0,
        // NEW fields — see comment block above the SQL.
        totalReceived: eff.totalReceived,
        totalSoldAllTime: eff.totalSold,
        effectiveStock: eff.effectiveStock,
      };
    }),
    countRows[0]?.count ?? 0,
    q
  ));
});

// Global ledger query — flattens the ledger across all SKUs with filters.
// Safe: the id-scoped `/:id{[0-9]+}/ledger` below won't match the literal
// string "ledger" because the regex constrains :id to digits.
const ledgerQuery = paginationSchema.extend({
  clientId: z.coerce.number().int().optional(),
  sku: z.string().optional(),
  type: z.string().optional(),
  dateStart: z.coerce.number().optional(),
  dateEnd: z.coerce.number().optional(),
});

app.get('/ledger', zValidator('query', ledgerQuery), async (c) => {
  const q = c.req.valid('query');
  const dateStart = q.dateStart != null && Number.isFinite(q.dateStart) ? new Date(q.dateStart) : null;
  const dateEnd = q.dateEnd != null && Number.isFinite(q.dateEnd) ? new Date(q.dateEnd) : null;
  const where = and(
    ...[
      q.clientId !== undefined ? eq(inventory.clientId, q.clientId) : undefined,
      q.sku ? eq(inventory.sku, q.sku) : undefined,
      q.type ? eq(inventoryLedger.type, q.type) : undefined,
      dateStart && !Number.isNaN(dateStart.getTime()) ? gte(inventoryLedger.createdAt, dateStart) : undefined,
      dateEnd && !Number.isNaN(dateEnd.getTime()) ? lte(inventoryLedger.createdAt, dateEnd) : undefined,
      activeInventoryClientPredicate,
    ].filter(<T>(x: T | undefined): x is T => x !== undefined)
  );

  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: inventoryLedger.id,
        inventoryId: inventoryLedger.inventoryId,
        sku: inventory.sku,
        name: inventory.name,
        clientId: inventory.clientId,
        type: inventoryLedger.type,
        qty: inventoryLedger.qty,
        orderId: inventoryLedger.orderId,
        note: inventoryLedger.note,
        createdBy: inventoryLedger.createdBy,
        createdAt: inventoryLedger.createdAt,
      })
      .from(inventoryLedger)
      .innerJoin(inventory, eq(inventory.id, inventoryLedger.inventoryId))
      .where(where)
      .orderBy(desc(inventoryLedger.createdAt))
      .limit(q.pageSize)
      .offset(offsetOf(q)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(inventoryLedger)
      .innerJoin(inventory, eq(inventory.id, inventoryLedger.inventoryId))
      .where(where),
  ]);

  return c.json(paginated(rows, countRows[0]?.count ?? 0, q));
});

app.get('/stats', async (c) => {
  const clientId = c.req.query('clientId');
  const parsed = clientId !== undefined ? Number(clientId) : undefined;
  const stats = await inventoryStats(
    Number.isFinite(parsed as number) ? (parsed as number) : undefined
  );
  return c.json(stats);
});

// v2-parity: GET /inventory/alerts?clientId=N
// Returns low-stock items (stock_qty <= reorder_level) for the given client.
// v2 computed stock by summing ledger; v4 stores stock_qty on the row, so
// the query is a simple compare.
app.get(
  '/alerts',
  zValidator('query', z.object({ clientId: z.coerce.number().int().optional() })),
  async (c) => {
    const { clientId } = c.req.valid('query');
    const rows = await db
      .select({
        id: inventory.id,
        sku: inventory.sku,
        name: inventory.name,
        stock: inventory.stockQty,
        minStock: inventory.reorderLevel,
        parentSkuId: inventory.parentSkuId,
        clientId: inventory.clientId,
      })
      .from(inventory)
      .where(
        and(
          ...[
            clientId !== undefined ? eq(inventory.clientId, clientId) : undefined,
            eq(inventory.active, true),
            activeInventoryClientPredicate,
            lte(inventory.stockQty, inventory.reorderLevel),
          ].filter(<T>(x: T | undefined): x is T => x !== undefined)
        )
      )
      .orderBy(inventory.stockQty);
    return c.json({ data: rows.map((r) => ({ type: 'sku' as const, ...r })) });
  }
);

app.get('/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const [row] = await db.select().from(inventory).where(eq(inventory.id, id)).limit(1);
  if (!row) return c.json({ error: 'Inventory item not found' }, 404);
  return c.json(row);
});

app.get('/:id{[0-9]+}/ledger', async (c) => {
  const id = Number(c.req.param('id'));
  const rows = await db
    .select()
    .from(inventoryLedger)
    .where(eq(inventoryLedger.inventoryId, id))
    .orderBy(desc(inventoryLedger.createdAt))
    .limit(200);
  return c.json({ data: rows });
});

// Orders that contain this SKU, bounded by an optional date window.
// Scans orders.items JSONB for any element with {sku: <this sku>} and
// returns an ordered list for the Inventory view's "Used by" panel.
app.get(
  '/:id{[0-9]+}/sku-orders',
  zValidator(
    'query',
    z.object({
      days: z.coerce.number().int().positive().max(3650).optional(),
      dateFrom: z.string().datetime().optional(),
      dateTo: z.string().datetime().optional(),
    })
  ),
  async (c) => {
    const id = Number(c.req.param('id'));
    const { days, dateFrom, dateTo } = c.req.valid('query');

    const [row] = await db
      .select({ sku: inventory.sku, name: inventory.name, clientId: inventory.clientId })
      .from(inventory)
      .where(eq(inventory.id, id))
      .limit(1);
    if (!row) return c.json({ error: 'Inventory item not found' }, 404);

    const since = dateFrom
      ? new Date(dateFrom).toISOString()
      : days
        ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
        : null;
    const until = dateTo ? new Date(dateTo).toISOString() : null;
    const dateFilterSql = sql`
      ${since ? sql`and o.order_date >= ${since}::timestamptz` : sql``}
      ${until ? sql`and o.order_date <= ${until}::timestamptz` : sql``}
    `;

    // 2026-05-13 visibility hardening: this endpoint matches orders by
    // SKU STRING (not by client_id), so when two clients share a SKU
    // string and one is disabled, the disabled client's orders mix
    // into the SKU drawer's daily-sales chart and shipping-cost
    // averages. Filtering by `coalesce(c.active, true) = true` excludes
    // disabled clients' orders from the three CTEs below while keeping
    // cross-client SKU analytics intact for ACTIVE clients. Orders
    // with NULL client_id (test/orphan) still pass through, matching
    // the same lenient policy as activeOrderClientPredicate in orders.ts.
    const activeClientOrderFilter = sql`
      and (
        o.client_id is null
        or exists (
          select 1 from clients c
          where c.id = o.client_id
            and coalesce(c.active, true) = true
        )
      )
    `;

    const dailyRows = since || until
      ? await db.execute<{ day: string; units: number }>(sql`
          select
            to_char(date_trunc('day', o.order_date), 'YYYY-MM-DD') as day,
            sum(coalesce((item->>'quantity')::int, 1))::int        as units
          from orders o
          cross join lateral jsonb_array_elements(o.items) item
          where item ? 'sku'
            and lower(item->>'sku') = lower(${row.sku})
            ${dateFilterSql}
            and coalesce(o.order_status, '') <> 'cancelled'
            and coalesce((item->>'adjustment')::boolean, false) = false
            and coalesce((item->>'quantity')::int, 1) > 0
            ${activeClientOrderFilter}
          group by date_trunc('day', o.order_date)
          order by date_trunc('day', o.order_date) asc
        `)
      : [];
    const salesMap = new Map(dailyRows.map((r) => [r.day, Number(r.units ?? 0)]));
    const dailySales: { day: string; units: number }[] = [];
    const safeDays = Math.max(1, Math.min(3650, days ?? 30));
    const startDay = since ? new Date(since) : new Date(Date.now() - (safeDays - 1) * 24 * 60 * 60 * 1000);
    startDay.setUTCHours(0, 0, 0, 0);
    const endDay = until ? new Date(until) : new Date();
    endDay.setUTCHours(0, 0, 0, 0);
    const bucketDays = Math.max(
      1,
      Math.min(3650, Math.round((endDay.getTime() - startDay.getTime()) / 86_400_000) + 1)
    );
    for (let i = 0; i < bucketDays; i += 1) {
      const d = new Date(startDay);
      d.setUTCDate(d.getUTCDate() + i);
      const day = d.toISOString().slice(0, 10);
      dailySales.push({ day, units: salesMap.get(day) ?? 0 });
    }

    const [shippingSummary] = await db.execute<{
      standard_ship_count: number;
      standard_shipping_total: string;
      avg_standard_shipping_cost: string;
    }>(sql`
      with matching_order_ids as (
        select distinct
          o.id
        from orders o
        cross join lateral jsonb_array_elements(o.items) item
        where item ? 'sku'
          and lower(item->>'sku') = lower(${row.sku})
          ${dateFilterSql}
          and coalesce(o.order_status, '') <> 'cancelled'
          and coalesce((item->>'adjustment')::boolean, false) = false
          and coalesce((item->>'quantity')::int, 1) > 0
          ${activeClientOrderFilter}
      ),
      item_rows as (
        select
          o.id                                                               as order_id,
          o.order_status                                                     as order_status,
          coalesce(ls.service_code, o.service_code)                          as service_code,
          ls.order_id                                                        as shipment_order_id,
          coalesce(ls.marked_cost, 0)                                        as label_cost,
          coalesce(nullif(item->>'sku', ''), '')                             as sku,
          case
            when nullif(item->>'sku', '') is not null then item->>'sku'
            else '_name_:' || lower(trim(coalesce(item->>'name', '')))
          end                                                               as sku_key,
          coalesce(nullif(item->>'name', ''), '—')                           as name,
          coalesce((item->>'quantity')::int, 1)                              as qty
        from matching_order_ids moi
        join orders o on o.id = moi.id
        cross join lateral jsonb_array_elements(o.items) item
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
          where s.order_id = o.id
            and coalesce(s.voided, false) = false
          order by s.id desc
          limit 1
        ) ls on true
        where coalesce((item->>'adjustment')::boolean, false) = false
          and coalesce((item->>'quantity')::int, 1) > 0
      ),
      order_sku_rows as (
        select
          order_id,
          max(order_status)                                                   as order_status,
          max(service_code)                                                    as service_code,
          max(shipment_order_id)                                               as shipment_order_id,
          max(label_cost)                                                      as label_cost,
          sku_key,
          max(sku)                                                             as sku,
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
      )
      select
        count(*) filter (
          where lower(sku) = lower(${row.sku})
            and not is_external
            and label_cost > 0
            and ship_class = 'std'
        )::int as standard_ship_count,
        coalesce(sum(label_cost * qty / nullif(order_qty_total, 0)) filter (
          where lower(sku) = lower(${row.sku})
            and not is_external
            and label_cost > 0
            and ship_class = 'std'
        ), 0)::text as standard_shipping_total,
        coalesce(
          sum(label_cost * qty / nullif(order_qty_total, 0)) filter (
            where lower(sku) = lower(${row.sku})
              and not is_external
              and label_cost > 0
              and ship_class = 'std'
          )
          / nullif(sum(qty) filter (
            where lower(sku) = lower(${row.sku})
              and not is_external
              and label_cost > 0
              and ship_class = 'std'
          ), 0),
          0
        )::text as avg_standard_shipping_cost
      from allocated
    `);

    const rows = await db.execute<{
      order_id: number;
      order_number: string;
      order_date: string | null;
      order_status: string;
      ship_to_name: string | null;
      carrier_code: string | null;
      service_code: string | null;
      qty: number;
      unit_price: string | null;
      item_name: string | null;
      shipping_cost: string | null;
      shipping_total: string | null;
      standard_shipping_cost: string | null;
      standard_shipping_total: string | null;
      is_external_shipped: boolean;
    }>(sql`
      with matching_order_ids as (
        select distinct
          o.id
        from orders o
        cross join lateral jsonb_array_elements(o.items) item
        where item ? 'sku'
          and lower(item->>'sku') = lower(${row.sku})
          ${dateFilterSql}
          and coalesce(o.order_status, '') <> 'cancelled'
          and coalesce((item->>'adjustment')::boolean, false) = false
          and coalesce((item->>'quantity')::int, 1) > 0
          ${activeClientOrderFilter}
      ),
      item_rows as (
        select
          o.id                                                               as order_id,
          o.order_number                                                     as order_number,
          o.order_date                                                       as order_date,
          o.order_status                                                     as order_status,
          o.ship_to_name                                                     as ship_to_name,
          o.carrier_code                                                     as carrier_code,
          coalesce(ls.service_code, o.service_code)                          as service_code,
          ls.order_id                                                        as shipment_order_id,
          coalesce(ls.marked_cost, 0)                                        as label_cost,
          coalesce(o.externally_shipped, false)                              as externally_shipped_flag,
          coalesce(nullif(item->>'sku', ''), '')                             as sku,
          case
            when nullif(item->>'sku', '') is not null then item->>'sku'
            else '_name_:' || lower(trim(coalesce(item->>'name', '')))
          end                                                               as sku_key,
          coalesce(nullif(item->>'name', ''), '—')                           as item_name,
          coalesce((item->>'quantity')::int, 1)                              as qty,
          coalesce(item->>'unitPrice', item->>'unit_price')                  as unit_price
        from matching_order_ids moi
        join orders o on o.id = moi.id
        cross join lateral jsonb_array_elements(o.items) item
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
          where s.order_id = o.id
            and coalesce(s.voided, false) = false
          order by s.id desc
          limit 1
        ) ls on true
        where coalesce((item->>'adjustment')::boolean, false) = false
          and coalesce((item->>'quantity')::int, 1) > 0
      ),
      order_sku_rows as (
        select
          order_id,
          max(order_number)                                                   as order_number,
          min(order_date)                                                      as order_date,
          max(order_status)                                                    as order_status,
          max(ship_to_name)                                                    as ship_to_name,
          max(carrier_code)                                                    as carrier_code,
          max(service_code)                                                    as service_code,
          max(shipment_order_id)                                               as shipment_order_id,
          max(label_cost)                                                      as label_cost,
          bool_or(externally_shipped_flag)                                     as externally_shipped_flag,
          sku_key,
          max(sku)                                                             as sku,
          (array_agg(item_name order by length(item_name) desc))[1]            as item_name,
          sum(qty)::int                                                        as qty,
          max(unit_price)                                                      as unit_price
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
      )
      select
        order_id,
        order_number,
        order_date,
        order_status,
        ship_to_name,
        carrier_code,
        service_code,
        qty,
        unit_price,
        item_name,
        case
          when not is_external and label_cost > 0 then (label_cost / nullif(order_qty_total, 0))::text
          else null
        end as shipping_cost,
        case
          when not is_external and label_cost > 0 then (label_cost * qty / nullif(order_qty_total, 0))::text
          else null
        end as shipping_total,
        case
          when not is_external and label_cost > 0 and ship_class = 'std' then (label_cost / nullif(order_qty_total, 0))::text
          else null
        end as standard_shipping_cost,
        case
          when not is_external and label_cost > 0 and ship_class = 'std' then (label_cost * qty / nullif(order_qty_total, 0))::text
          else null
        end as standard_shipping_total,
        (is_external or externally_shipped_flag)                               as is_external_shipped
      from allocated
      where lower(sku) = lower(${row.sku})
      order by order_date desc nulls last
      limit 200
    `);

    return c.json({
      sku: row.sku,
      name: row.name,
      clientId: row.clientId,
      totalUnits: dailySales.reduce((sum, r) => sum + r.units, 0),
      standardShipCount: shippingSummary?.standard_ship_count ?? 0,
      standardShippingTotal: shippingSummary?.standard_shipping_total ?? '0',
      avgStandardShippingCost: shippingSummary?.avg_standard_shipping_cost ?? '0',
      dailySales,
      orders: rows,
    });
  }
);

const createBody = z.object({
  clientId: z.number().int().nullable().optional(),
  sku: z.string().min(1),
  name: z.string().optional(),
  imageUrl: z.string().url().nullable().optional(),
  stockQty: z.number().int().nonnegative().optional(),
  reorderLevel: z.number().int().nonnegative().optional(),
  baseUnitQty: z.number().int().positive().optional(),
  unitsPerPack: z.number().int().positive().optional(),
  cuFtOverride: z.number().nonnegative().nullable().optional(),
  packageId: z.number().int().positive().nullable().optional(),
  weightOz: z.number().nonnegative().nullable().optional(),
  length: z.number().nonnegative().nullable().optional(),
  width: z.number().nonnegative().nullable().optional(),
  height: z.number().nonnegative().nullable().optional(),
  // 2026-05-12: `active` was missing from this schema, so PATCHes
  // from the toolbar/per-row toggle had the field silently stripped
  // by zod's default .strip() mode — the row's updatedAt bumped but
  // the active column never changed. Adding it here makes the
  // active-only toggle and the per-row toggle actually persist.
  active: z.boolean().optional(),
});

app.post('/', zValidator('json', createBody), async (c) => {
  const body = c.req.valid('json');
  const [row] = await db.insert(inventory).values(body).returning();
  return c.json(row, 201);
});

app.patch(
  '/:id{[0-9]+}',
  zValidator('json', createBody.omit({ sku: true }).partial().extend({ sku: z.string().min(1).optional() })),
  async (c) => {
    const id = Number(c.req.param('id'));
    const body = c.req.valid('json');
    const [row] = await db
      .update(inventory)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(inventory.id, id))
      .returning();
    if (!row) return c.json({ error: 'Inventory item not found' }, 404);
    return c.json(row);
  }
);

const movementBody = z.object({
  qty: z.number().int(),
  note: z.string().optional(),
  orderId: z.number().int().optional(),
  type: z.enum(['receive', 'adjust', 'pick', 'ship', 'return', 'damage']).optional(),
  receivedAt: z.string().datetime().optional(),
  adjustedAt: z.string().datetime().optional(),
});

function movementDateFrom(value: string | undefined) {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

app.post(
  '/:id{[0-9]+}/receive',
  zValidator('json', movementBody.refine((v) => v.qty > 0, 'Receive qty must be > 0')),
  async (c) => {
    const id = Number(c.req.param('id'));
    const body = c.req.valid('json');
    const email = c.get('email' as never) as string | undefined;
    const result = await applyMovement({
      inventoryId: id,
      type: 'receive',
      qty: body.qty,
      note: body.note,
      createdBy: email ?? 'manual',
      createdAt: movementDateFrom(body.receivedAt ?? body.adjustedAt),
    });
    return c.json(result);
  }
);

app.put(
  '/:id{[0-9]+}/set-parent',
  zValidator(
    'json',
    z.object({ parentSkuId: z.number().int().positive().nullable() })
  ),
  async (c) => {
    const id = Number(c.req.param('id'));
    const { parentSkuId } = c.req.valid('json');
    // Dual-write: update inventory.parentSkuId FK (primary parent — back-compat)
    // AND upsert inventory_sku_parents join (v2-parity multi-parent table).
    // When parentSkuId is null, clear both: null out the FK and delete the
    // primary row from the join.
    const result = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(inventory)
        .set({ parentSkuId, updatedAt: new Date() })
        .where(eq(inventory.id, id))
        .returning();
      if (!row) return null;

      // Clear any existing primary row for this inventory id so the unique
      // partial index doesn't fight us on a re-parent.
      await tx
        .delete(inventorySkuParents)
        .where(
          and(
            eq(inventorySkuParents.inventoryId, id),
            eq(inventorySkuParents.isPrimary, true)
          )
        );

      if (parentSkuId !== null) {
        await tx
          .insert(inventorySkuParents)
          .values({ inventoryId: id, parentSkuId, isPrimary: true })
          .onConflictDoUpdate({
            target: [inventorySkuParents.inventoryId, inventorySkuParents.parentSkuId],
            set: { isPrimary: true },
          });
      }
      return row;
    });
    if (!result) return c.json({ error: 'Inventory item not found' }, 404);
    return c.json(result);
  }
);

// v2-parity: list all parent SKUs a given inventory row belongs to (may be
// many, since an inventory item can belong to multiple bundles). Uses the
// join table + left-joins parent_skus for display fields.
app.get('/:id{[0-9]+}/parents', async (c) => {
  const id = Number(c.req.param('id'));
  const rows = await db
    .select({
      parentSkuId: inventorySkuParents.parentSkuId,
      isPrimary: inventorySkuParents.isPrimary,
      createdAt: inventorySkuParents.createdAt,
      name: parentSkus.name,
      sku: parentSkus.sku,
      baseUnitQty: parentSkus.baseUnitQty,
    })
    .from(inventorySkuParents)
    .innerJoin(parentSkus, eq(parentSkus.id, inventorySkuParents.parentSkuId))
    .where(eq(inventorySkuParents.inventoryId, id))
    .orderBy(desc(inventorySkuParents.isPrimary), parentSkus.name);
  return c.json({ data: rows });
});

// Add a non-primary parent (idempotent). For primary parent use /set-parent.
app.post(
  '/:id{[0-9]+}/add-parent',
  zValidator(
    'json',
    z.object({ parentSkuId: z.number().int().positive() })
  ),
  async (c) => {
    const id = Number(c.req.param('id'));
    const { parentSkuId } = c.req.valid('json');
    const [inv] = await db
      .select({ id: inventory.id })
      .from(inventory)
      .where(eq(inventory.id, id))
      .limit(1);
    if (!inv) return c.json({ error: 'Inventory item not found' }, 404);

    await db
      .insert(inventorySkuParents)
      .values({ inventoryId: id, parentSkuId, isPrimary: false })
      .onConflictDoNothing({
        target: [inventorySkuParents.inventoryId, inventorySkuParents.parentSkuId],
      });
    return c.json({ data: { inventoryId: id, parentSkuId, isPrimary: false } });
  }
);

// Remove a parent from the join. If it was the primary parent, also null
// out inventory.parentSkuId so the two representations stay consistent.
app.delete(
  '/:id{[0-9]+}/parents/:parentSkuId{[0-9]+}',
  async (c) => {
    const id = Number(c.req.param('id'));
    const parentSkuId = Number(c.req.param('parentSkuId'));
    const result = await db.transaction(async (tx) => {
      const [removed] = await tx
        .delete(inventorySkuParents)
        .where(
          and(
            eq(inventorySkuParents.inventoryId, id),
            eq(inventorySkuParents.parentSkuId, parentSkuId)
          )
        )
        .returning();
      if (removed?.isPrimary) {
        await tx
          .update(inventory)
          .set({ parentSkuId: null, updatedAt: new Date() })
          .where(eq(inventory.id, id));
      }
      return removed;
    });
    if (!result) return c.json({ error: 'Parent link not found' }, 404);
    return c.json({ deleted: true, wasPrimary: result.isPrimary });
  }
);

app.post(
  '/:id{[0-9]+}/adjust',
  zValidator('json', movementBody.refine((v) => v.qty !== 0, 'Adjust qty cannot be 0')),
  async (c) => {
    const id = Number(c.req.param('id'));
    const body = c.req.valid('json');
    const email = c.get('email' as never) as string | undefined;
    const result = await applyMovement({
      inventoryId: id,
      type: body.type ?? 'adjust',
      qty: body.qty,
      note: body.note,
      createdBy: email ?? 'manual',
      createdAt: movementDateFrom(body.adjustedAt ?? body.receivedAt),
    });
    return c.json(result);
  }
);

const bulkReceiveBody = z.object({
  clientId: z.number().int().nullable().optional(),
  note: z.string().optional(),
  receivedAt: z.string().datetime().optional(),
  items: z
    .array(
      z.object({
        invSkuId: z.number().int().positive().optional(),
        inventoryId: z.number().int().positive().optional(),
        sku: z.string().trim().optional(),
        name: z.string().trim().optional(),
        qty: z.number().int().positive(),
        note: z.string().optional(),
      }).refine(
        (item) => item.invSkuId != null || item.inventoryId != null || Boolean(item.sku?.trim()),
        'Each receive item needs an inventory id or SKU'
      )
    )
    .min(1),
});

async function findOrCreateInventoryForReceive(
  item: z.infer<typeof bulkReceiveBody>['items'][number],
  clientId: number | null | undefined,
) {
  const requestedId = item.invSkuId ?? item.inventoryId;
  if (requestedId != null) {
    const [row] = await db
      .select()
      .from(inventory)
      .where(eq(inventory.id, requestedId))
      .limit(1);
    if (!row) throw new Error(`Inventory item #${requestedId} not found`);
    return row;
  }

  const sku = item.sku?.trim();
  if (!sku) throw new Error('SKU is required');
  const clientFilter = clientId == null ? isNull(inventory.clientId) : eq(inventory.clientId, clientId);
  const [existing] = await db
    .select()
    .from(inventory)
    .where(and(clientFilter, sql`lower(${inventory.sku}) = lower(${sku})`))
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(inventory)
    .values({
      clientId: clientId ?? null,
      sku,
      name: item.name?.trim() || sku,
      stockQty: 0,
    })
    .returning();
  if (!created) throw new Error(`Could not create inventory item for ${sku}`);
  return created;
}

// v2-parity bulk receive: POST /inventory/receive body
// {clientId, note, receivedAt, items:[{sku|invSkuId, qty, name?, note?}]}.
// Calls applyMovement per item so every receipt lands in the ledger. Per-item
// errors are tallied without aborting the batch.
app.post(
  '/receive',
  zValidator('json', bulkReceiveBody),
  async (c) => {
    const body = c.req.valid('json');
    const email = c.get('email' as never) as string | undefined;
    const receivedAt = movementDateFrom(body.receivedAt);
    // v2-parity ReceiveInventoryResultDto adds `newStock` per item so
    // the receiving UI can display the post-receive on-hand total without a
    // round-trip fetch. applyMovement returns the updated inventory row,
    // whose stockQty IS the new on-hand total.
    const results: Array<{
      invSkuId: number;
      sku?: string | null;
      name?: string | null;
      qty?: number;
      ok: boolean;
      newStock?: number;
      ledgerId?: number;
      createdAt?: Date;
      error?: string;
    }> = [];
    for (const item of body.items) {
      try {
        const inv = await findOrCreateInventoryForReceive(item, body.clientId);
        const res = await applyMovement({
          inventoryId: inv.id,
          type: 'receive',
          qty: item.qty,
          note: item.note?.trim() || body.note?.trim() || undefined,
          createdBy: email ?? 'manual',
          createdAt: receivedAt,
        });
        results.push({
          invSkuId: inv.id,
          sku: res.inventory?.sku ?? inv.sku,
          name: res.inventory?.name ?? inv.name,
          qty: item.qty,
          ok: true,
          newStock: res.inventory?.stockQty ?? 0,
          ledgerId: res.ledger?.id,
          createdAt: res.ledger?.createdAt,
        });
      } catch (err) {
        results.push({
          invSkuId: item.invSkuId ?? item.inventoryId ?? 0,
          sku: item.sku ?? null,
          qty: item.qty,
          ok: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }
    const received = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    return c.json({
      ok: failed.length === 0,
      received,
      failed: failed.length,
      total: results.length,
      results,
    });
  }
);

// v2-parity single adjust: POST /inventory/adjust body {invSkuId, qty, note?}.
// Same semantic as POST /:id/adjust but v2 shape with id in the body.
app.post(
  '/adjust',
  zValidator(
    'json',
    z.object({
      invSkuId: z.number().int().positive(),
      qty: z.number().int().refine((v) => v !== 0, 'qty cannot be 0'),
      note: z.string().optional(),
      type: z.enum(['receive', 'adjust', 'pick', 'ship', 'return', 'damage']).optional(),
      adjustedAt: z.string().datetime().optional(),
      receivedAt: z.string().datetime().optional(),
    })
  ),
  async (c) => {
    const body = c.req.valid('json');
    const email = c.get('email' as never) as string | undefined;
    const result = await applyMovement({
      inventoryId: body.invSkuId,
      type: body.type ?? 'adjust',
      qty: body.qty,
      note: body.note,
      createdBy: email ?? 'manual',
      createdAt: movementDateFrom(body.adjustedAt ?? body.receivedAt),
    });
    return c.json(result);
  }
);

// Bulk update of dimensions + pack-size fields for many inventory rows in one call.
// Extended for v2 parity: baseUnitQty, unitsPerPack, cuFtOverride, packageId — so
// CSV importers and bulk editors can populate the new pack-size fields without
// per-row PATCH round-trips.
const bulkDimsBody = z.object({
  items: z
    .array(
      z.object({
        id: z.number().int().positive(),
        weightOz: z.number().nonnegative().optional(),
        length: z.number().nonnegative().optional(),
        width: z.number().nonnegative().optional(),
        height: z.number().nonnegative().optional(),
        baseUnitQty: z.number().int().positive().optional(),
        unitsPerPack: z.number().int().positive().optional(),
        cuFtOverride: z.number().nonnegative().nullable().optional(),
        packageId: z.number().int().positive().nullable().optional(),
      })
    )
    .min(1)
    .max(500),
});

// v2-parity: POST /inventory/bulk-set-default-package
// {clientId, packageId, skus[]} — sets inventory.package_id for many SKUs in
// one call. Fired by the shipping panel when an auto-detected package can't be
// saved through the single-SKU savePanelSkuDefaults path (multi-SKU orders),
// so the same default package lands on every line item rather than only on
// single-SKU orders. clientId is required when scoping to a tenant; pass null
// to update the shared (clientId IS NULL) catalog rows.
const bulkSetPackageBody = z.object({
  clientId: z.number().int().nullable(),
  packageId: z.number().int().positive().nullable(),
  skus: z.array(z.string().trim().min(1)).min(1).max(200),
});

app.post(
  '/bulk-set-default-package',
  zValidator('json', bulkSetPackageBody),
  async (c) => {
    const { clientId, packageId, skus } = c.req.valid('json');
    let updated = 0;
    for (const rawSku of skus) {
      const sku = rawSku.trim();
      if (!sku) continue;
      const skuWhere = sql`lower(${inventory.sku}) = lower(${sku})`;
      const where = and(
        skuWhere,
        clientId === null ? isNull(inventory.clientId) : eq(inventory.clientId, clientId)
      );
      const rows = await db
        .update(inventory)
        .set({ packageId, updatedAt: new Date() })
        .where(where)
        .returning({ id: inventory.id });
      updated += rows.length;
    }
    return c.json({
      updated,
      skipped: skus.length - updated,
      total: skus.length,
    });
  }
);

app.post('/bulk-update-dims', zValidator('json', bulkDimsBody), async (c) => {
  const { items } = c.req.valid('json');
  let updated = 0;
  for (const item of items) {
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (item.weightOz !== undefined) patch.weightOz = item.weightOz;
    if (item.length !== undefined) patch.length = item.length;
    if (item.width !== undefined) patch.width = item.width;
    if (item.height !== undefined) patch.height = item.height;
    if (item.baseUnitQty !== undefined) patch.baseUnitQty = item.baseUnitQty;
    if (item.unitsPerPack !== undefined) patch.unitsPerPack = item.unitsPerPack;
    if (item.cuFtOverride !== undefined) patch.cuFtOverride = item.cuFtOverride;
    if (item.packageId !== undefined) patch.packageId = item.packageId;
    const [row] = await db
      .update(inventory)
      .set(patch)
      .where(eq(inventory.id, item.id))
      .returning({ id: inventory.id });
    if (row) updated += 1;
  }
  return c.json({
    updated,
    skipped: items.length - updated,
    message: `Updated ${updated} of ${items.length} items`,
  });
});

// Scan orders.items JSONB and seed inventory rows for any SKU we don't
// have yet (clientId set from the order's clientId, or null if order is
// unassigned). Useful as a quick way to populate inventory from the
// orders that already synced from ShipStation.
//
// 2026-05-13: extracted to src/services/inventory-enrichment.ts so the
// in-process scheduler can call the same logic on a 30-min interval.
// This route handler is now a thin wrapper that the Inventory toolbar's
// "📥 Import SKUs from Orders" button still drives manually.
app.post('/import-from-orders', async (c) => {
  const result = await importSkusFromOrders();
  return c.json(result);
});

// Pull product catalog from ShipStation v1 /products (every account we
// know about) and upsert as inventory rows. stockQty stays 0 — the
// standard SS API doesn't expose stock levels. Matching:
//   • Main account products → clientId IS NULL (shared catalog)
//   • Per-client accounts (e.g. KFG) → clientId = account owner
// so each client's product catalog lands on its own row and pulls its
// ShipStation thumbnail + dims + weight.
//
// 2026-05-13: extracted to src/services/inventory-enrichment.ts so the
// in-process scheduler can fire this hourly. This route handler is the
// manual path — the "📐 Import Dims from SS" toolbar button still
// drives it on demand.
app.post('/sync-products', async (c) => {
  const result = await syncShipStationProducts();
  return c.json(result);
});

export default app;
