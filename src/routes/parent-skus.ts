import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { asc, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { parentSkus } from '../db/schema/parent-skus';

const app = new Hono();

const listQ = z.object({
  clientId: z.coerce.number().int().optional(),
});

app.get('/', zValidator('query', listQ), async (c) => {
  const { clientId } = c.req.valid('query');
  const rows = await db
    .select()
    .from(parentSkus)
    .where(clientId !== undefined ? eq(parentSkus.clientId, clientId) : undefined)
    .orderBy(asc(parentSkus.name));
  return c.json({ data: rows });
});

const createBody = z.object({
  clientId: z.number().int().positive(),
  name: z.string().min(1),
  sku: z.string().nullable().optional(),
  baseUnitQty: z.number().int().positive().optional(),
});

app.post('/', zValidator('json', createBody), async (c) => {
  const body = c.req.valid('json');
  const [row] = await db.insert(parentSkus).values(body).returning();
  return c.json(row, 201);
});

app.patch(
  '/:id{[0-9]+}',
  zValidator('json', createBody.partial()),
  async (c) => {
    const id = Number(c.req.param('id'));
    const body = c.req.valid('json');
    const [row] = await db
      .update(parentSkus)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(parentSkus.id, id))
      .returning();
    if (!row) return c.json({ error: 'Parent SKU not found' }, 404);
    return c.json(row);
  }
);

app.delete('/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const [row] = await db
    .delete(parentSkus)
    .where(eq(parentSkus.id, id))
    .returning();
  if (!row) return c.json({ error: 'Parent SKU not found' }, 404);
  return c.json({ deleted: true });
});

export default app;
