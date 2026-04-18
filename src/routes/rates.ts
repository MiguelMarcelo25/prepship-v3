import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { rateCache } from '../db/schema/rates';
import { getRates } from '../services/rates';
import { ssRequest } from '../lib/shipstation';
import type { CarriersResponse } from '../lib/shipstation/types';

const app = new Hono();

const rateBody = z.object({
  weightOz: z.number().positive(),
  toZip: z.string().min(3),
  toCountry: z.string().optional(),
  toState: z.string().optional(),
  toCity: z.string().optional(),
  toAddress: z.string().optional(),
  toName: z.string().optional(),
  residential: z.boolean().optional(),
  dimsL: z.number().positive().optional(),
  dimsW: z.number().positive().optional(),
  dimsH: z.number().positive().optional(),
  carrierIds: z.array(z.string()).optional(),
  forceRefresh: z.boolean().optional(),
});

app.post('/', zValidator('json', rateBody), async (c) => {
  const body = c.req.valid('json');
  const { forceRefresh, ...input } = body;
  const result = await getRates(input, { forceRefresh });
  return c.json(result);
});

const cachedQuery = z.object({
  weightOz: z.coerce.number().positive(),
  toZip: z.string().min(3),
});

app.get('/cached', zValidator('query', cachedQuery), async (c) => {
  const q = c.req.valid('query');
  const rows = await db
    .select()
    .from(rateCache)
    .where(
      and(
        eq(rateCache.weightOz, q.weightOz),
        eq(rateCache.toZip, q.toZip.toUpperCase())
      )
    )
    .limit(25);
  return c.json({ data: rows });
});

app.get('/carriers', async (c) => {
  const data = await ssRequest<CarriersResponse>('/v2/carriers', {
    dedupeKey: 'carriers:list',
  });
  return c.json(data);
});

app.delete('/cache', async (c) => {
  const counts = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(rateCache);
  await db.delete(rateCache);
  return c.json({ deleted: counts[0]?.count ?? 0 });
});

export default app;
