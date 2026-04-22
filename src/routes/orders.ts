import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, ilike, inArray, lte, notInArray, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { orderOverrides, orders } from '../db/schema/orders';
import { shipments } from '../db/schema/shipments';
import { offsetOf, paginated, paginationSchema } from '../lib/pagination';
import { getSyncStatus, syncOrders } from '../services/order-sync';

const app = new Hono();

// User-initiated sync + status. Sits behind requireAuth (mounted at main.ts).
// /cron/sync-orders is the cron-secret equivalent for schedulers.
app.get('/sync/status', async (c) => {
  const status = await getSyncStatus();
  return c.json(status);
});

app.post('/sync', async (c) => {
  const result = await syncOrders({});
  return c.json(result);
});

const listQuery = paginationSchema.extend({
  status: z.string().optional(),
  clientId: z.coerce.number().int().optional(),
  storeId: z.coerce.number().int().optional(),
  excludeClientId: z.string().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  search: z.string().optional(),
});

app.get('/', zValidator('query', listQuery), async (c) => {
  const q = c.req.valid('query');
  const excludeIds = (q.excludeClientId ?? '')
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);

  const where = and(
    ...[
      q.status ? eq(orders.orderStatus, q.status) : undefined,
      q.clientId !== undefined ? eq(orders.clientId, q.clientId) : undefined,
      q.storeId !== undefined ? eq(orders.storeId, q.storeId) : undefined,
      excludeIds.length > 0 && q.clientId === undefined
        ? notInArray(orders.clientId, excludeIds)
        : undefined,
      q.dateFrom ? gte(orders.orderDate, new Date(q.dateFrom)) : undefined,
      q.dateTo ? lte(orders.orderDate, new Date(q.dateTo)) : undefined,
      q.search
        ? or(
            ilike(orders.orderNumber, `%${q.search}%`),
            ilike(orders.shipToName, `%${q.search}%`),
            ilike(orders.customerEmail, `%${q.search}%`)
          )
        : undefined,
    ].filter(<T>(x: T | undefined): x is T => x !== undefined)
  );

  // Dedupe by orderNumber: keep the row with the highest id (most recent
  // sync wins). ShipStation occasionally syncs the same order_number twice
  // (separate stores, manual re-sync, etc.) — collapse to one row.
  // Using a CTE so pagination + count stay accurate against the deduped set.
  const dedupedIdsSubquery = sql`(
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY order_number ORDER BY id DESC
      ) AS rn
      FROM orders
      WHERE ${where ?? sql`true`}
    ) ranked
    WHERE ranked.rn = 1
  )`;

  const [joined, countRows] = await Promise.all([
    db
      .select({ order: orders, overrides: orderOverrides })
      .from(orders)
      .leftJoin(orderOverrides, eq(orderOverrides.orderId, orders.id))
      .where(and(where, sql`${orders.id} IN ${dedupedIdsSubquery}`))
      .orderBy(desc(orders.orderDate))
      .limit(q.pageSize)
      .offset(offsetOf(q)),
    db.execute<{ count: number }>(sql`SELECT COUNT(*)::int AS count FROM ${dedupedIdsSubquery} d`),
  ]);

  const rows = joined.map((r) => ({ ...r.order, overrides: r.overrides }));
  const total = countRows[0]?.count ?? 0;
  return c.json(paginated(rows, total, q));
});

// Picklist: aggregated SKU + qty + order count per client over a date
// range and status filter. Used to print a warehouse pick list grouped
// by client. Skipping clients table to keep the query simple — we
// resolve client names client-side via the clients query.
const picklistQuery = z.object({
  status: z.string().optional().default('awaiting_shipment'),
  clientId: z.coerce.number().int().optional(),
  storeId: z.coerce.number().int().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
});

// Order IDs that contain a given SKU (warehouse pick lookup).
// Optional filters restored for v2 parity: qty (min qty on the line),
// orderStatus, storeId.
app.get(
  '/ids',
  zValidator(
    'query',
    z.object({
      sku: z.string().min(1),
      qty: z.coerce.number().int().positive().optional(),
      orderStatus: z.string().optional(),
      storeId: z.coerce.number().int().optional(),
    })
  ),
  async (c) => {
    const { sku, qty, orderStatus, storeId } = c.req.valid('query');
    const rows = await db.execute<{ id: number; order_number: string }>(sql`
      select distinct o.id, o.order_number
      from orders o, jsonb_array_elements(o.items) item
      where item ? 'sku' and item->>'sku' = ${sku}
        ${qty !== undefined ? sql`and coalesce((item->>'quantity')::int, 1) >= ${qty}` : sql``}
        ${orderStatus ? sql`and o.order_status = ${orderStatus}` : sql``}
        ${storeId !== undefined ? sql`and o.store_id = ${storeId}` : sql``}
      order by o.id desc
      limit 500
    `);
    return c.json({ data: rows });
  }
);

// Per-store order counts in a window — useful for store dashboards.
app.get(
  '/store-counts',
  zValidator(
    'query',
    z.object({
      dateFrom: z.string().datetime().optional(),
      dateTo: z.string().datetime().optional(),
      status: z.string().optional(),
    })
  ),
  async (c) => {
    const q = c.req.valid('query');
    const fromIso = (q.dateFrom ? new Date(q.dateFrom) : new Date(0)).toISOString();
    const toIso = (q.dateTo ? new Date(q.dateTo) : new Date(Date.now() + 86400000)).toISOString();
    const status = q.status ?? null;
    const rows = await db.execute<{
      store_id: number | null;
      count: number;
    }>(sql`
      select store_id, count(*)::int as count
      from orders
      where order_date >= ${fromIso}::timestamptz
        and order_date <= ${toIso}::timestamptz
        and (${status}::text is null or order_status = ${status}::text)
      group by store_id
      order by count desc
    `);
    return c.json({ data: rows });
  }
);

// Rolling 48-hour window ending at the current Pacific Time noon. Used for
// the stats strip's "Total Orders" count. Wider than v2's shift window so
// low-activity accounts don't see 0 during quiet shifts, narrower than
// "all time" so the strip reflects recent activity.
function computeRolling48hWindow(now = new Date()): { from: Date; to: Date } {
  const to = now;
  const from = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  return { from, to };
}

// v2 shift-based window (Pacific Time). Kept for reference; no longer used
// by /daily-stats. Noon→noon weekday, expanded across weekends.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function computeShiftWindow(now = new Date()): { from: Date; to: Date } {
  // Read current PT calendar date + time using Intl.DateTimeFormat. We can't
  // rely on server TZ because Render runs UTC.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const y = Number(get('year'));
  const m = Number(get('month'));
  const d = Number(get('day'));
  const hr = Number(get('hour'));
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = dowMap[get('weekday')] ?? 0;

  // todayNoon and today6pm as UTC Date objects representing PT noon/6pm today.
  // PT is UTC-7 (PDT) or UTC-8 (PST). Cheapest correct approach: construct
  // the ISO string for "YYYY-MM-DDThh:00:00" in PT and let Date parse with
  // an explicit offset. Use Intl to derive the offset for the given date.
  const offsetMinutes = (() => {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      timeZoneName: 'shortOffset',
    }).formatToParts(now);
    const raw = fmt.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-8';
    const match = raw.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
    if (!match) return -480; // fallback PST
    const h = Number(match[1]);
    const mm = match[2] ? Number(match[2]) : 0;
    return h * 60 + (h < 0 ? -mm : mm);
  })();
  const offsetSign = offsetMinutes >= 0 ? '+' : '-';
  const offsetAbs = Math.abs(offsetMinutes);
  const offsetStr = `${offsetSign}${String(Math.floor(offsetAbs / 60)).padStart(2, '0')}:${String(offsetAbs % 60).padStart(2, '0')}`;
  const todayNoon = new Date(
    `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T12:00:00${offsetStr}`
  );
  const isPm = hr >= 18;
  const dayMs = 24 * 60 * 60 * 1000;

  let windowStart: Date;
  let windowEnd: Date;
  if (dow === 6) {
    // Saturday: from Fri noon → Mon noon (weekend coverage)
    windowStart = new Date(todayNoon.getTime() - dayMs);
    windowEnd = new Date(todayNoon.getTime() + 2 * dayMs);
  } else if (dow === 0) {
    // Sunday
    windowStart = new Date(todayNoon.getTime() - 2 * dayMs);
    windowEnd = new Date(todayNoon.getTime() + dayMs);
  } else if (dow === 1) {
    // Monday — before 6pm shows Fri-noon→Mon-noon; after 6pm shows Mon-noon→Tue-noon
    if (isPm) {
      windowStart = todayNoon;
      windowEnd = new Date(todayNoon.getTime() + dayMs);
    } else {
      windowStart = new Date(todayNoon.getTime() - 3 * dayMs);
      windowEnd = todayNoon;
    }
  } else if (dow === 5) {
    // Friday — before 6pm: Thu-noon→Fri-noon; after 6pm: Fri-noon→Mon-noon
    if (isPm) {
      windowStart = todayNoon;
      windowEnd = new Date(todayNoon.getTime() + 3 * dayMs);
    } else {
      windowStart = new Date(todayNoon.getTime() - dayMs);
      windowEnd = todayNoon;
    }
  } else if (isPm) {
    // Tue/Wed/Thu after 6pm — peek into tomorrow
    windowStart = todayNoon;
    windowEnd = new Date(todayNoon.getTime() + dayMs);
  } else {
    // Tue/Wed/Thu before 6pm — yesterday noon → today noon
    windowStart = new Date(todayNoon.getTime() - dayMs);
    windowEnd = todayNoon;
  }
  return { from: windowStart, to: windowEnd };
}

function formatPtLabel(d: Date): string {
  return (
    d
      .toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        hour12: true,
        timeZone: 'America/Los_Angeles',
      })
      .replace(',', '') + ' PT'
  );
}

// Daily stats — hybrid window: 48h activity + all-time awaiting backlog.
// Accepts excludeClientId (comma-separated) so hidden clients (Api Shipments,
// Test Orders, etc.) are filtered out of the strip just like they are from
// the sidebar and orders table. Without this the strip counts thousands of
// test orders and shows numbers that don't match the visible list.
app.get(
  '/daily-stats',
  zValidator(
    'query',
    z.object({
      dateFrom: z.string().datetime().optional(),
      dateTo: z.string().datetime().optional(),
      excludeClientId: z.string().optional(),
    })
  ),
  async (c) => {
    const q = c.req.valid('query');
    const rolling = computeRolling48hWindow();
    const fromDate = q.dateFrom ? new Date(q.dateFrom) : rolling.from;
    const toDate = q.dateTo ? new Date(q.dateTo) : rolling.to;
    const fromIso = fromDate.toISOString();
    const toIso = toDate.toISOString();

    const excludeIds = (q.excludeClientId ?? '')
      .split(',')
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    // Keep orders with NULL client_id (not-yet-assigned) visible; only
    // filter the explicit hidden IDs. Using inArray avoids array-literal
    // quoting quirks through Drizzle's sql template.
    const excludeFilter =
      excludeIds.length > 0
        ? sql`and (client_id is null or not (client_id in (${sql.join(
            excludeIds.map((id) => sql`${id}`),
            sql`, `
          )})))`
        : sql``;

    const rows = await db.execute<{
      day: string;
      count: number;
      shipped: number;
    }>(sql`
      select to_char(date_trunc('day', order_date), 'YYYY-MM-DD') as day,
             count(*)::int as count,
             count(*) filter (where order_status = 'shipped')::int as shipped
      from orders
      where order_date >= ${fromIso}::timestamptz
        and order_date <= ${toIso}::timestamptz
        ${excludeFilter}
      group by date_trunc('day', order_date)
      order by date_trunc('day', order_date) desc
    `);
    // totalOrders + shippedTotal: windowed (last 48h activity)
    const windowedRows = await db.execute<{
      total_orders: number;
      shipped_total: number;
    }>(sql`
      select
        count(*) filter (where order_status <> 'cancelled')::int as total_orders,
        count(*) filter (where order_status = 'shipped')::int as shipped_total
      from orders
      where order_date >= ${fromIso}::timestamptz
        and order_date <= ${toIso}::timestamptz
        ${excludeFilter}
    `);
    // needToShip: ALL awaiting_shipment orders (the real work queue, not windowed).
    const backlogRows = await db.execute<{ need_to_ship: number }>(sql`
      select count(*)::int as need_to_ship
      from orders
      where order_status = 'awaiting_shipment'
        ${excludeFilter}
    `);
    const upcomingRows = await db.execute<{ upcoming_orders: number }>(sql`
      select count(*)::int as upcoming_orders
      from orders
      where order_date > ${toIso}::timestamptz
        and order_status <> 'cancelled'
        ${excludeFilter}
    `);
    const w = windowedRows[0];
    const b = backlogRows[0];
    const u = upcomingRows[0];
    return c.json({
      data: rows,
      summary: {
        totalOrders: w?.total_orders ?? 0,
        needToShip: b?.need_to_ship ?? 0,
        shippedTotal: w?.shipped_total ?? 0,
        upcomingOrders: u?.upcoming_orders ?? 0,
        window: {
          from: fromIso,
          to: toIso,
          fromLabel: formatPtLabel(fromDate),
          toLabel: formatPtLabel(toDate),
        },
      },
    });
  }
);

app.get('/picklist', zValidator('query', picklistQuery), async (c) => {
  const q = c.req.valid('query');
  const fromIso = q.dateFrom
    ? new Date(q.dateFrom).toISOString()
    : new Date(0).toISOString();
  const toIso = q.dateTo
    ? new Date(q.dateTo).toISOString()
    : new Date(Date.now() + 86400000).toISOString();
  const cid: number | null = q.clientId ?? null;
  const sid: number | null = q.storeId ?? null;
  const status = q.status;

  const rows = await db.execute<{
    client_id: number | null;
    client_name: string | null;
    sku: string;
    name: string | null;
    image_url: string | null;
    total_qty: number;
    order_count: number;
  }>(sql`
    select
      o.client_id                                   as client_id,
      coalesce(c.name, 'Unknown')                   as client_name,
      item->>'sku'                                  as sku,
      max(item->>'name')                            as name,
      max(nullif(item->>'imageUrl', ''))            as image_url,
      sum(coalesce((item->>'quantity')::int, 1))::int as total_qty,
      count(distinct o.id)::int                     as order_count
    from orders o
    left join clients c on c.id = o.client_id,
         jsonb_array_elements(o.items) item
    where (${status}::text is null or o.order_status = ${status}::text)
      and (${cid}::int is null or o.client_id = ${cid}::int)
      and (${sid}::int is null or o.store_id = ${sid}::int)
      and o.order_date >= ${fromIso}::timestamptz
      and o.order_date <= ${toIso}::timestamptz
      and item ? 'sku'
      and item->>'sku' is not null
      and item->>'sku' <> ''
    group by o.client_id, c.name, item->>'sku'
    order by client_name asc, total_qty desc
  `);

  return c.json({
    skus: rows,
    totalSkus: rows.length,
    totalUnits: rows.reduce((s, r) => s + (r.total_qty ?? 0), 0),
  });
});

app.get('/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (!order) return c.json({ error: 'Order not found' }, 404);

  const [overrides, shipmentRows] = await Promise.all([
    db
      .select()
      .from(orderOverrides)
      .where(eq(orderOverrides.orderId, id))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db.select().from(shipments).where(eq(shipments.orderId, id)),
  ]);

  return c.json({ ...order, overrides, shipments: shipmentRows });
});

// Alias of GET /orders/:id — old API exposed both shapes. Same payload.
app.get('/:id{[0-9]+}/full', async (c) => {
  const id = Number(c.req.param('id'));
  const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (!order) return c.json({ error: 'Order not found' }, 404);
  const [overrides, shipmentRows] = await Promise.all([
    db
      .select()
      .from(orderOverrides)
      .where(eq(orderOverrides.orderId, id))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db.select().from(shipments).where(eq(shipments.orderId, id)),
  ]);
  return c.json({ ...order, overrides, shipments: shipmentRows });
});

const patchBody = z.object({
  residential: z.boolean().nullable().optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
  trackingNumber: z.string().nullable().optional(),
  selectedPid: z.number().int().nullable().optional(),
  selectedPackageId: z.string().nullable().optional(),
  bestRateJson: z.unknown().optional(),
  bestRateDims: z.string().nullable().optional(),
  shippingAccount: z.string().nullable().optional(),
  externallyShipped: z.boolean().optional(),
  externallyShippedSource: z.string().nullable().optional(),
});

app.patch('/:id{[0-9]+}', zValidator('json', patchBody), async (c) => {
  const id = Number(c.req.param('id'));
  const body = c.req.valid('json');

  const [existing] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.id, id))
    .limit(1);
  if (!existing) return c.json({ error: 'Order not found' }, 404);

  // Split the body: externallyShipped lives on the `orders` table;
  // everything else (including externallyShippedSource) lives on order_overrides.
  const { externallyShipped, ...overridesBody } = body;

  if (externallyShipped !== undefined) {
    await db
      .update(orders)
      .set({ externallyShipped, updatedAt: new Date() })
      .where(eq(orders.id, id));
  }

  const bestRateAt = overridesBody.bestRateJson !== undefined ? new Date() : undefined;
  const [row] = await db
    .insert(orderOverrides)
    .values({ orderId: id, ...overridesBody, bestRateAt, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: orderOverrides.orderId,
      set: { ...overridesBody, bestRateAt, updatedAt: new Date() },
    })
    .returning();

  return c.json(row);
});

const saveDimsBody = z.object({
  l: z.number().nonnegative(),
  w: z.number().nonnegative(),
  h: z.number().nonnegative(),
  weightOz: z.number().nonnegative().optional(),
});

app.post(
  '/:id{[0-9]+}/save-dims',
  zValidator('json', saveDimsBody),
  async (c) => {
    const id = Number(c.req.param('id'));
    const body = c.req.valid('json');

    const [existing] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.id, id))
      .limit(1);
    if (!existing) return c.json({ error: 'Order not found' }, 404);

    const patch: Record<string, unknown> = {
      rateDimsL: body.l,
      rateDimsW: body.w,
      rateDimsH: body.h,
    };
    if (body.weightOz !== undefined) patch.rateWeightOz = body.weightOz;

    const [row] = await db
      .insert(orderOverrides)
      .values({ orderId: id, ...patch, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: orderOverrides.orderId,
        set: { ...patch, updatedAt: new Date() },
      })
      .returning();

    return c.json({ data: row });
  }
);

app.get('/:id{[0-9]+}/dims', async (c) => {
  const id = Number(c.req.param('id'));
  const [row] = await db
    .select({
      rateDimsL: orderOverrides.rateDimsL,
      rateDimsW: orderOverrides.rateDimsW,
      rateDimsH: orderOverrides.rateDimsH,
      rateWeightOz: orderOverrides.rateWeightOz,
    })
    .from(orderOverrides)
    .where(eq(orderOverrides.orderId, id))
    .limit(1);

  if (
    !row ||
    (row.rateDimsL == null &&
      row.rateDimsW == null &&
      row.rateDimsH == null &&
      row.rateWeightOz == null)
  ) {
    return c.json({ data: null });
  }

  return c.json({
    data: {
      l: row.rateDimsL,
      w: row.rateDimsW,
      h: row.rateDimsH,
      weightOz: row.rateWeightOz,
    },
  });
});

const exportQuery = z.object({
  status: z.string().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  clientId: z.coerce.number().int().optional(),
});

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

app.get('/export', zValidator('query', exportQuery), async (c) => {
  const q = c.req.valid('query');

  const where = and(
    ...[
      q.status ? eq(orders.orderStatus, q.status) : undefined,
      q.clientId !== undefined ? eq(orders.clientId, q.clientId) : undefined,
      q.dateFrom ? gte(orders.orderDate, new Date(q.dateFrom)) : undefined,
      q.dateTo ? lte(orders.orderDate, new Date(q.dateTo)) : undefined,
    ].filter(<T>(x: T | undefined): x is T => x !== undefined)
  );

  const rows = await db
    .select({ order: orders, overrides: orderOverrides })
    .from(orders)
    .leftJoin(orderOverrides, eq(orderOverrides.orderId, orders.id))
    .where(where)
    .orderBy(desc(orders.orderDate))
    .limit(5000);

  // Latest non-voided shipment per order (for label cost / tracking / created)
  const orderIds = rows.map((r) => r.order.id);
  const shipmentsByOrder = new Map<number, typeof shipments.$inferSelect>();
  if (orderIds.length > 0) {
    try {
      const ships = await db
        .select()
        .from(shipments)
        .where(and(inArray(shipments.orderId, orderIds), eq(shipments.voided, false)))
        .orderBy(desc(shipments.shipDate));
      for (const s of ships) {
        if (s.orderId != null && !shipmentsByOrder.has(s.orderId)) {
          shipmentsByOrder.set(s.orderId, s);
        }
      }
    } catch (err) {
      // If shipments table is missing, has different columns, or the query
      // shape is wrong on this DB, log and continue without label data.
      console.warn('[orders/export] shipments lookup failed; carrying on without label cols:', err);
    }
  }

  const header = [
    'Order ID',
    'Order #',
    'Order Date',
    'Store ID',
    'Client ID',
    'Status',
    'Recipient',
    'Item Name',
    'SKU',
    'Qty',
    'Weight (oz)',
    'Ship To',
    'Carrier',
    'Service',
    'Tracking #',
    'Order Total',
    'Best Rate',
    'Label Cost',
    'Ship Margin',
    'Label Created',
    'Age (hrs)',
    'Raw API (JSON)',
    'Best Rate JSON',
  ];

  const lines: string[] = [header.join(',')];
  const now = Date.now();

  for (const { order, overrides } of rows) {
    const items = Array.isArray(order.items)
      ? (order.items as Array<Record<string, unknown>>)
      : [];
    const firstItem = items[0] ?? null;
    const itemName = firstItem?.name ?? '';
    const itemSku = firstItem?.sku ?? '';
    const totalQty = items.reduce((s, it) => s + (Number(it.quantity) || 0), 0);
    const shipTo = [order.shipToCity, order.shipToState].filter(Boolean).join(', ');

    const bestRateObj = overrides?.bestRateJson as Record<string, unknown> | null | undefined;
    const bestRateAmount = bestRateObj
      ? ((bestRateObj.shipping_amount as Record<string, unknown> | undefined)?.amount ??
        bestRateObj.cost ?? '')
      : '';

    const ship = shipmentsByOrder.get(order.id) ?? null;
    const labelCost = ship?.labelCost ?? '';
    const tracking = ship?.trackingNumber ?? overrides?.trackingNumber ?? '';
    const labelCreated = ship?.shipDate ?? '';
    const carrier = ship?.carrierCode ?? order.carrierCode ?? '';
    const service = ship?.serviceCode ?? order.serviceCode ?? '';

    let shipMargin = '';
    if (labelCost !== '' && bestRateAmount !== '' && bestRateAmount != null) {
      const m = Number(labelCost) - Number(bestRateAmount);
      if (Number.isFinite(m)) shipMargin = m.toFixed(2);
    }

    let ageHrs: string | number = '';
    if (order.orderDate) {
      const t = new Date(order.orderDate).getTime();
      if (!Number.isNaN(t)) ageHrs = Math.round((now - t) / 3_600_000);
    }

    lines.push(
      [
        order.id,
        order.orderNumber,
        order.orderDate,
        order.storeId,
        order.clientId,
        order.orderStatus,
        order.shipToName,
        itemName,
        itemSku,
        totalQty || '',
        order.weightOz,
        shipTo,
        carrier,
        service,
        tracking,
        order.orderTotal,
        bestRateAmount,
        labelCost,
        shipMargin,
        labelCreated,
        ageHrs,
        order.raw ? JSON.stringify(order.raw) : '',
        bestRateObj ? JSON.stringify(bestRateObj) : '',
      ]
        .map(csvEscape)
        .join(',')
    );
  }

  const body = lines.join('\r\n') + '\r\n';
  const timestamp = new Date().toISOString().slice(0, 10);
  const statusLabel = q.status ? `-${q.status}` : '';

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename=orders${statusLabel}-${timestamp}.csv`,
    },
  });
});

export default app;
