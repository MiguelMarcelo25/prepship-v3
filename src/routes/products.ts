import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { products } from '../db/schema/products';
import { offsetOf, paginated, paginationSchema } from '../lib/pagination';

const app = new Hono();

const listQ = paginationSchema.extend({
  search: z.string().optional(),
});

app.get('/', zValidator('query', listQ), async (c) => {
  const q = c.req.valid('query');
  const where = q.search
    ? or(
        ilike(products.sku, `%${q.search}%`),
        ilike(products.name, `%${q.search}%`)
      )
    : undefined;

  const [rows, countRows] = await Promise.all([
    db
      .select()
      .from(products)
      .where(where)
      .orderBy(desc(products.updatedAt))
      .limit(q.pageSize)
      .offset(offsetOf(q)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(products)
      .where(where),
  ]);

  return c.json(paginated(rows, countRows[0]?.count ?? 0, q));
});

const bulkQ = z.object({
  skus: z.string().min(1),
});

app.get('/bulk', zValidator('query', bulkQ), async (c) => {
  const skus = c.req
    .valid('query')
    .skus.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!skus.length) return c.json({ data: [] });
  const rows = await db
    .select()
    .from(products)
    .where(inArray(products.sku, skus))
    .orderBy(asc(products.sku));
  return c.json({ data: rows });
});

app.get('/by-sku/:sku', async (c) => {
  const sku = c.req.param('sku');
  const [row] = await db.select().from(products).where(eq(products.sku, sku)).limit(1);
  if (!row) return c.json({ error: 'Product not found' }, 404);
  return c.json(row);
});

app.get('/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const [row] = await db.select().from(products).where(eq(products.id, id)).limit(1);
  if (!row) return c.json({ error: 'Product not found' }, 404);
  return c.json(row);
});

const body = z.object({
  sku: z.string().min(1).optional(),
  name: z.string().nullable().optional(),
  imageUrl: z.string().url().nullable().optional(),
  weightOz: z.number().nonnegative().optional(),
  length: z.number().nonnegative().optional(),
  width: z.number().nonnegative().optional(),
  height: z.number().nonnegative().optional(),
  defaultPackageCode: z.string().nullable().optional(),
});

app.post('/', zValidator('json', body.required({ sku: true })), async (c) => {
  const v = c.req.valid('json');
  const [row] = await db.insert(products).values(v).returning();
  return c.json(row, 201);
});

app.patch('/:id{[0-9]+}', zValidator('json', body), async (c) => {
  const id = Number(c.req.param('id'));
  const v = c.req.valid('json');
  const [row] = await db
    .update(products)
    .set({ ...v, updatedAt: new Date() })
    .where(eq(products.id, id))
    .returning();
  if (!row) return c.json({ error: 'Product not found' }, 404);
  return c.json(row);
});

// Save defaults (upsert by SKU) — back-compat with the old /products/save-defaults
const saveDefaultsBody = z.object({
  sku: z.string().min(1),
  name: z.string().nullable().optional(),
  weightOz: z.number().nonnegative().optional(),
  length: z.number().nonnegative().optional(),
  width: z.number().nonnegative().optional(),
  height: z.number().nonnegative().optional(),
  defaultPackageCode: z.string().nullable().optional(),
});

app.post('/save-defaults', zValidator('json', saveDefaultsBody), async (c) => {
  const v = c.req.valid('json');
  const [row] = await db
    .insert(products)
    .values(v)
    .onConflictDoUpdate({
      target: products.sku,
      set: {
        name: v.name,
        weightOz: v.weightOz,
        length: v.length,
        width: v.width,
        height: v.height,
        defaultPackageCode: v.defaultPackageCode,
        updatedAt: new Date(),
      },
    })
    .returning();
  return c.json(row);
});

app.delete('/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const [row] = await db.delete(products).where(eq(products.id, id)).returning();
  if (!row) return c.json({ error: 'Product not found' }, 404);
  return c.json({ deleted: true });
});

export default app;
