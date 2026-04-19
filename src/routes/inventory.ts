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

app.get('/stats', async (c) => {
  const clientId = c.req.query('clientId');
  const parsed = clientId !== undefined ? Number(clientId) : undefined;
  const stats = await inventoryStats(
    Number.isFinite(parsed as number) ? (parsed as number) : undefined
  );
  return c.json(stats);
});

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

const createBody = z.object({
  clientId: z.number().int().nullable().optional(),
  sku: z.string().min(1),
  name: z.string().optional(),
  imageUrl: z.string().url().nullable().optional(),
  stockQty: z.number().int().nonnegative().optional(),
  reorderLevel: z.number().int().nonnegative().optional(),
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
