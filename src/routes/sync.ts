import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { getSyncStatus } from '../services/order-sync';
import { getShipmentSyncStatus } from '../services/shipment-sync';
import {
  getApiRuntimeStatus,
  getPersistedWorkerStatus,
} from '../services/worker-status';
import { enqueueManualOrderSyncJob, getSyncJobQueueStatus } from '../services/sync-job-queue';
import { SYNC_CADENCE_MINUTES } from '../lib/sync-cadence';
import {
  readShipmentSyncWatchdogStatus,
} from '../services/shipment-sync-watchdog';

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
  const result = await enqueueManualOrderSyncJob(body);
  const response = {
    ...result,
    status: result.queueState,
    message: result.queued
      ? 'Order sync queued'
      : result.error
        ? result.error
        : result.queueState === 'running'
          ? 'Order sync is already running'
          : result.queueState === 'retrying'
            ? 'Order sync is waiting to retry'
            : 'Order sync is already queued',
  };
  return c.json(response, result.error ? 503 : 202);
});

app.get('/status', async (c) => {
  const [orders, shipments, worker, queue] = await Promise.all([
    getSyncStatus({ includeOrderCount: false }),
    getShipmentSyncStatus({ includeShipmentCount: false }),
    getPersistedWorkerStatus(),
    getSyncJobQueueStatus(),
  ]);
  const watchdog = await readShipmentSyncWatchdogStatus();
  const queueStatus = queue;
  const syncState = orders.queueState === 'running'
    ? 'running'
    : orders.queueState === 'queued'
      ? 'queued'
      : orders.queueState === 'retrying'
        ? 'retrying'
        : orders.health === 'error'
          ? 'error'
          : orders.latestSyncedAt
            ? 'completed'
            : 'idle';
  return c.json({
    // Legacy top-level fields kept for existing frontend callers.
    ...orders,
    status:
      syncState === 'running' || syncState === 'queued' || syncState === 'retrying'
        ? 'syncing'
        : syncState === 'error'
          ? 'error'
          : syncState === 'completed'
            ? 'done'
            : 'idle',
    syncState,
    mode: orders.latestSyncedAt ? 'incremental' : 'idle',
    error:
      orders.health === 'error'
        ? 'One or more ShipStation accounts failed their latest sync.'
        : null,
    page: 0,
    total: 0,
    count: 0,
    lastSync:
      orders.lastSyncedAt && Number.isFinite(Date.parse(orders.lastSyncedAt))
        ? Date.parse(orders.lastSyncedAt)
        : null,
    lastSyncAt: orders.lastSyncedAt,
    latestSync:
      orders.latestSyncedAt && Number.isFinite(Date.parse(orders.latestSyncedAt))
        ? Date.parse(orders.latestSyncedAt)
        : null,
    // PS-132: derived from the shared cadence source (src/lib/sync-cadence.ts) so the
    // reported cadence can never drift from what the job queue actually schedules.
    cadenceMinutes: SYNC_CADENCE_MINUTES,
    ratePrefetchRunning: false,
    ratePrefetchJob: null,
    orders,
    shipments,
    worker,
    queue: queueStatus,
    watchdog,
    api: getApiRuntimeStatus(),
  });
});

export default app;
