import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { getSyncStatus, syncOrders } from '../services/order-sync';
import { getShipmentSyncStatus } from '../services/shipment-sync';
import { startBackfillBestRates } from '../services/rates-backfill';
import {
  getApiRuntimeStatus,
  getPersistedWorkerStatus,
} from '../services/worker-status';

const app = new Hono();

const triggerBody = z
  .object({
    sinceIso: z.string().datetime().optional(),
    sinceMs: z.number().int().nonnegative().optional(),
    pageSize: z.number().int().min(1).max(500).optional(),
    fullResync: z.boolean().optional(),
    // v2's button sends { full: true } for legacy sync. Keep accepting it,
    // but reserve full historical order backfills for explicit fullResync.
    full: z.boolean().optional(),
  })
  .optional()
  .default({});

app.post('/orders', zValidator('json', triggerBody), async (c) => {
  const body = c.req.valid('json') ?? {};
  const fullResync = body.fullResync === true;
  const legacyFull = body.full === true;
  const sinceMs = fullResync
    ? 0
    : body.sinceMs !== undefined
      ? body.sinceMs
    : body.sinceIso
      ? Date.parse(body.sinceIso)
      : undefined;
  const result = await syncOrders({
    sinceMs,
    awaitingSinceMs: fullResync ? 0 : sinceMs,
    pageSize: body.pageSize,
  });
  const shouldBackfillRates = fullResync || legacyFull || result.synced > 0;
  const rateBackfillJob = shouldBackfillRates
    ? (() => {
        const job = startBackfillBestRates({ limit: 1000 });
        return { jobId: job.jobId, status: job.status };
      })()
    : null;

  return c.json({ ...result, rateBackfillJob });
});

app.get('/status', async (c) => {
  const [orders, shipments, worker] = await Promise.all([
    getSyncStatus(),
    getShipmentSyncStatus(),
    getPersistedWorkerStatus(),
  ]);
  return c.json({
    // Legacy top-level fields kept for existing frontend callers.
    ...orders,
    orders,
    shipments,
    worker,
    api: getApiRuntimeStatus(),
  });
});

export default app;
