import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { locations } from '../db/schema/locations';
import { setDefaultLocation } from '../services/locations';

const app = new Hono();

const body = z.object({
  name: z.string().min(1),
  company: z.string().nullable().optional(),
  street1: z.string().nullable().optional(),
  street2: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  postalCode: z.string().nullable().optional(),
  country: z.string().default('US'),
  phone: z.string().nullable().optional(),
  active: z.boolean().optional(),
});

app.get('/', async (c) => {
  const rows = await db
    .select()
    .from(locations)
    .orderBy(desc(locations.isDefault), desc(locations.updatedAt));
  return c.json(rows);
});

app.get('/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const [row] = await db.select().from(locations).where(eq(locations.id, id)).limit(1);
  if (!row) return c.json({ error: 'Location not found' }, 404);
  return c.json(row);
});

app.post('/', zValidator('json', body), async (c) => {
  const v = c.req.valid('json');
  const [row] = await db.insert(locations).values(v).returning();
  return c.json(row, 201);
});

app.patch('/:id{[0-9]+}', zValidator('json', body.partial()), async (c) => {
  const id = Number(c.req.param('id'));
  const v = c.req.valid('json');
  const [row] = await db
    .update(locations)
    .set({ ...v, updatedAt: new Date() })
    .where(eq(locations.id, id))
    .returning();
  if (!row) return c.json({ error: 'Location not found' }, 404);
  return c.json(row);
});

app.delete('/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const [row] = await db.delete(locations).where(eq(locations.id, id)).returning();
  if (!row) return c.json({ error: 'Location not found' }, 404);
  return c.json({ deleted: true });
});

app.post('/:id{[0-9]+}/default', async (c) => {
  const id = Number(c.req.param('id'));
  const row = await setDefaultLocation(id);
  return c.json(row);
});

export default app;
