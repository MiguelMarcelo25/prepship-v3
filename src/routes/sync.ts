import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { getSyncStatus, syncOrders } from '../services/order-sync';
import { startBackfillBestRates } from '../services/rates-backfill';

const app = new Hono();

const triggerBody = z
  .object({
    sinceIso: z.string().datetime().optional(),
    sinceMs: z.number().int().nonnegative().optional(),
    pageSize: z.number().int().min(1).max(500).optional(),
    fullResync: z.boolean().optional(),
    // v2's button sends { full: true }. Accept it as an alias so the UI
    // can request a real full re-sync instead of silently falling back to
    // incremental.
    full: z.boolean().optional(),
  })
  .optional()
  .default({});

app.post('/orders', zValidator('json', triggerBody), async (c) => {
  const body = c.req.valid('json') ?? {};
  const fullSync = body.fullResync === true || body.full === true;
  const sinceMs = fullSync
    ? 0
    : body.sinceMs !== undefined
      ? body.sinceMs
    : body.sinceIso
      ? Date.parse(body.sinceIso)
      : undefined;
  const result = await syncOrders({
    sinceMs,
    awaitingSinceMs: fullSync ? 0 : sinceMs,
    pageSize: body.pageSize,
  });
  const shouldBackfillRates = fullSync || result.synced > 0;
  const rateBackfillJob = shouldBackfillRates
    ? (() => {
        const job = startBackfillBestRates({ limit: 1000 });
        return { jobId: job.jobId, status: job.status };
      })()
    : null;

  return c.json({ ...result, rateBackfillJob });
});

app.get('/status', async (c) => {
  const status = await getSyncStatus();
  return c.json(status);
});

export default app;
