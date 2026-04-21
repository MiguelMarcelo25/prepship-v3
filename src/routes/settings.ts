import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { asc, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { settings } from '../db/schema/settings';

const app = new Hono();

app.get('/', async (c) => {
  const rows = await db.select().from(settings).orderBy(asc(settings.key));
  return c.json({ data: rows });
});

app.get('/:key', async (c) => {
  const key = c.req.param('key');
  const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  if (!row) return c.json({ key, value: null });
  return c.json(row);
});

const putBody = z.object({ value: z.string() });

app.put('/:key', zValidator('json', putBody), async (c) => {
  const key = c.req.param('key');
  const { value } = c.req.valid('json');
  const [row] = await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .returning();
  return c.json(row);
});

app.delete('/:key', async (c) => {
  const key = c.req.param('key');
  const [row] = await db.delete(settings).where(eq(settings.key, key)).returning();
  if (!row) return c.json({ error: 'Setting not found' }, 404);
  return c.json({ deleted: true });
});

export default app;
