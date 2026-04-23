import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, ilike, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { inventory, inventoryLedger } from '../db/schema/inventory';
import { offsetOf, paginated, paginationSchema } from '../lib/pagination';
import { applyMovement, inventoryStats } from '../services/inventory';
import { ssV1Request } from '../lib/shipstation/v1-client';

const app = new Hono();

const listQuery = paginationSchema.extend({
  clientId: z.coerce.number().int().optional(),
  search: z.string().optional(),
  lowStock: z.coerce.boolean().optional(),
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
      eq(inventory.active, true),
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

  return c.json(paginated(rows, countRows[0]?.count ?? 0, q));
});

// Global ledger query — flattens the ledger across all SKUs with filters.
// Safe: the id-scoped `/:id{[0-9]+}/ledger` below won't match the literal
// string "ledger" because the regex constrains :id to digits.
const ledgerQuery = paginationSchema.extend({
  clientId: z.coerce.number().int().optional(),
  sku: z.string().optional(),
  type: z.string().optional(),
});

app.get('/ledger', zValidator('query', ledgerQuery), async (c) => {
  const q = c.req.valid('query');
  const where = and(
    ...[
      q.clientId !== undefined ? eq(inventory.clientId, q.clientId) : undefined,
      q.sku ? eq(inventory.sku, q.sku) : undefined,
      q.type ? eq(inventoryLedger.type, q.type) : undefined,
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
    z.object({ days: z.coerce.number().int().positive().max(3650).optional() })
  ),
  async (c) => {
    const id = Number(c.req.param('id'));
    const { days } = c.req.valid('query');

    const [row] = await db
      .select({ sku: inventory.sku, name: inventory.name, clientId: inventory.clientId })
      .from(inventory)
      .where(eq(inventory.id, id))
      .limit(1);
    if (!row) return c.json({ error: 'Inventory item not found' }, 404);

    const since = days
      ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
      : null;

    const rows = await db.execute<{
      order_id: number;
      order_number: string;
      order_date: string | null;
      order_status: string;
      qty: number;
    }>(sql`
      select
        o.id                                     as order_id,
        o.order_number                           as order_number,
        o.order_date                             as order_date,
        o.order_status                           as order_status,
        coalesce((item->>'quantity')::int, 0)    as qty
      from orders o,
           jsonb_array_elements(o.items) item
      where item ? 'sku'
        and item->>'sku' = ${row.sku}
        ${row.clientId !== null ? sql`and o.client_id = ${row.clientId}` : sql``}
        ${since ? sql`and o.order_date >= ${since}::timestamptz` : sql``}
      order by o.order_date desc nulls last
      limit 500
    `);

    return c.json({ sku: row.sku, name: row.name, orders: rows });
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
});

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
      createdBy: email,
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
    const [row] = await db
      .update(inventory)
      .set({ parentSkuId, updatedAt: new Date() })
      .where(eq(inventory.id, id))
      .returning();
    if (!row) return c.json({ error: 'Inventory item not found' }, 404);
    return c.json(row);
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
      type: 'adjust',
      qty: body.qty,
      note: body.note,
      createdBy: email,
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
app.post('/import-from-orders', async (c) => {
  const rows = await db.execute<{
    sku: string;
    name: string | null;
    image_url: string | null;
    client_id: number | null;
  }>(sql`
    select distinct on (item->>'sku', o.client_id)
      item->>'sku'                               as sku,
      coalesce(item->>'name', '')                as name,
      nullif(item->>'imageUrl', '')              as image_url,
      o.client_id                                as client_id
    from orders o,
         jsonb_array_elements(o.items) item
    where item ? 'sku'
      and item->>'sku' is not null
      and item->>'sku' <> ''
  `);

  let inserted = 0;
  let skipped = 0;

  for (const r of rows) {
    const [existing] = await db
      .select({ id: inventory.id })
      .from(inventory)
      .where(
        and(
          eq(inventory.sku, r.sku),
          r.client_id !== null
            ? eq(inventory.clientId, r.client_id)
            : isNull(inventory.clientId)
        )
      )
      .limit(1);

    if (existing) {
      skipped += 1;
      continue;
    }
    await db.insert(inventory).values({
      sku: r.sku,
      name: r.name || null,
      imageUrl: r.image_url,
      clientId: r.client_id,
    });
    inserted += 1;
  }

  return c.json({
    inserted,
    skipped,
    message: `Imported ${inserted} new SKUs from orders (${skipped} already existed)`,
  });
});

// Pull product catalog from ShipStation v1 and upsert as inventory rows.
// stockQty stays 0 (ShipStation doesn't expose inventory levels in the
// standard API). Match by (clientId IS NULL, sku) since we don't know
// which store a product belongs to.
app.post('/sync-products', async (c) => {
  type SSProduct = {
    productId: number;
    sku: string | null;
    name: string | null;
    weightOz?: number | null;
    length?: number | null;
    width?: number | null;
    height?: number | null;
    active?: boolean;
    thumbnailUrl?: string | null;
    imageUrl?: string | null;
  };
  type SSProductsList = {
    products: SSProduct[];
    total: number;
    page: number;
    pages: number;
  };

  let page = 1;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  while (true) {
    const res = await ssV1Request<SSProductsList>(
      `/products?pageSize=500&page=${page}`,
      { dedupeKey: `products:list:${page}` }
    );

    for (const p of res.products) {
      const sku = (p.sku ?? '').trim();
      if (!sku) {
        skipped += 1;
        continue;
      }

      const [existing] = await db
        .select({ id: inventory.id })
        .from(inventory)
        .where(and(eq(inventory.sku, sku), isNull(inventory.clientId)))
        .limit(1);

      const fields = {
        name: p.name ?? null,
        weightOz: p.weightOz ?? 0,
        length: p.length ?? null,
        width: p.width ?? null,
        height: p.height ?? null,
        active: p.active ?? true,
        imageUrl: p.thumbnailUrl ?? p.imageUrl ?? null,
      };

      if (existing) {
        await db
          .update(inventory)
          .set({ ...fields, updatedAt: new Date() })
          .where(eq(inventory.id, existing.id));
        updated += 1;
      } else {
        await db.insert(inventory).values({ sku, ...fields });
        inserted += 1;
      }
    }

    if (page >= res.pages || !res.products.length) break;
    page += 1;
  }

  return c.json({
    inserted,
    updated,
    skipped,
    message: `Synced ${inserted + updated} products (${inserted} new, ${updated} updated, ${skipped} without SKU)`,
  });
});

export default app;
