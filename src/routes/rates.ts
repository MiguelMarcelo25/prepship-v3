import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { rateCache } from '../db/schema/rates';
import { getRates } from '../services/rates';
import {
  getActiveBackfillJob,
  getBackfillJob,
  startBackfillBestRates,
} from '../services/rates-backfill';
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

const browseBody = rateBody
  .omit({ carrierIds: true })
  .extend({ carrierId: z.string().min(1) });

app.post('/browse', zValidator('json', browseBody), async (c) => {
  const body = c.req.valid('json');
  const { forceRefresh, carrierId, ...rest } = body;
  const result = await getRates(
    { ...rest, carrierIds: [carrierId] },
    { forceRefresh }
  );
  const filtered = result.rates.filter((r) => r.carrier_id === carrierId);
  const cheapest = [...filtered].sort(
    (a, b) => a.shipping_amount.amount - b.shipping_amount.amount
  )[0] ?? null;
  return c.json({
    ...result,
    rates: filtered,
    bestRate: cheapest,
  });
});

const cachedQuery = z.object({
  weightOz: z.coerce.number().positive(),
  toZip: z.string().min(3),
});

// Bulk lookup of cached rates for many (weightOz, toZip) pairs in one call.
const bulkBody = z.object({
  items: z
    .array(z.object({ weightOz: z.number(), toZip: z.string().min(3) }))
    .min(1)
    .max(200),
});

app.post('/cached/bulk', zValidator('json', bulkBody), async (c) => {
  const { items } = c.req.valid('json');
  const results = await Promise.all(
    items.map(async (it) => {
      const rows = await db
        .select()
        .from(rateCache)
        .where(
          and(
            eq(rateCache.weightOz, it.weightOz),
            eq(rateCache.toZip, it.toZip.toUpperCase())
          )
        )
        .limit(1);
      return { weightOz: it.weightOz, toZip: it.toZip, hit: rows[0] ?? null };
    })
  );
  return c.json({ data: results });
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

app.post(
  '/backfill-best',
  zValidator(
    'json',
    z
      .object({
        clientId: z.number().int().optional(),
        limit: z.number().int().positive().max(10000).optional(),
        maxAgeHours: z.number().int().positive().max(24 * 30).optional(),
      })
      .optional()
  ),
  async (c) => {
    const body = c.req.valid('json') ?? {};
    const job = startBackfillBestRates(body);
    return c.json({ job_id: job.jobId, status: job.status });
  }
);

app.get('/backfill-best/status/:jobId', (c) => {
  const job = getBackfillJob(c.req.param('jobId'));
  if (!job) return c.json({ error: 'Job not found' }, 404);
  return c.json(job);
});

app.get('/backfill-best/active', (c) => {
  return c.json({ job: getActiveBackfillJob() });
});

app.delete('/cache', async (c) => {
  const counts = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(rateCache);
  await db.delete(rateCache);
  return c.json({ deleted: counts[0]?.count ?? 0 });
});

export default app;
