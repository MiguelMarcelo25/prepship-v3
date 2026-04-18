import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { clients } from '../db/schema/clients';

const app = new Hono();

const body = z.object({
  name: z.string().min(1),
  storeIds: z.array(z.number().int()).optional(),
  contactName: z.string().nullable().optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  ssApiKey: z.string().nullable().optional(),
  ssApiSecret: z.string().nullable().optional(),
  ssApiKeyV2: z.string().nullable().optional(),
  rateSourceClientId: z.number().int().nullable().optional(),
  brandName: z.string().nullable().optional(),
  brandColor: z.string().nullable().optional(),
  brandLogo: z.string().nullable().optional(),
  active: z.boolean().optional(),
});

app.get('/', async (c) => {
  const rows = await db.select().from(clients);
  return c.json(rows);
});

app.get('/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const [row] = await db.select().from(clients).where(eq(clients.id, id)).limit(1);
  if (!row) return c.json({ error: 'Client not found' }, 404);
  return c.json(row);
});

app.post('/', zValidator('json', body), async (c) => {
  const v = c.req.valid('json');
  const [row] = await db.insert(clients).values(v).returning();
  return c.json(row, 201);
});

app.patch('/:id{[0-9]+}', zValidator('json', body.partial()), async (c) => {
  const id = Number(c.req.param('id'));
  const v = c.req.valid('json');
  const [row] = await db
    .update(clients)
    .set({ ...v, updatedAt: new Date() })
    .where(eq(clients.id, id))
    .returning();
  if (!row) return c.json({ error: 'Client not found' }, 404);
  return c.json(row);
});

app.delete('/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const [row] = await db.delete(clients).where(eq(clients.id, id)).returning();
  if (!row) return c.json({ error: 'Client not found' }, 404);
  return c.json({ deleted: true });
});

export default app;
