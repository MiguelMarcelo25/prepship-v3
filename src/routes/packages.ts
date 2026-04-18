import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { packages } from '../db/schema/packages';

const app = new Hono();

const body = z.object({
  name: z.string().min(1),
  type: z.string().optional(),
  length: z.number().nonnegative(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
  tareWeightOz: z.number().nonnegative().default(0),
  source: z.string().optional(),
  carrierCode: z.string().nullable().optional(),
  packageCode: z.string().nullable().optional(),
  domestic: z.boolean().nullable().optional(),
  international: z.boolean().nullable().optional(),
  stockQty: z.number().int().nonnegative().optional(),
  reorderLevel: z.number().int().nonnegative().optional(),
  unitCost: z.string().optional(),
  isDefault: z.boolean().optional(),
});

app.get('/', async (c) => {
  const rows = await db.select().from(packages);
  return c.json(rows);
});

app.get('/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const [row] = await db.select().from(packages).where(eq(packages.id, id)).limit(1);
  if (!row) return c.json({ error: 'Package not found' }, 404);
  return c.json(row);
});

app.post('/', zValidator('json', body), async (c) => {
  const v = c.req.valid('json');
  const [row] = await db.insert(packages).values(v).returning();
  return c.json(row, 201);
});

app.patch('/:id{[0-9]+}', zValidator('json', body.partial()), async (c) => {
  const id = Number(c.req.param('id'));
  const v = c.req.valid('json');
  const [row] = await db
    .update(packages)
    .set({ ...v, updatedAt: new Date() })
    .where(eq(packages.id, id))
    .returning();
  if (!row) return c.json({ error: 'Package not found' }, 404);
  return c.json(row);
});

app.delete('/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const [row] = await db.delete(packages).where(eq(packages.id, id)).returning();
  if (!row) return c.json({ error: 'Package not found' }, 404);
  return c.json({ deleted: true });
});

export default app;
