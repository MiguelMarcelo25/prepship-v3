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
import { getSyncJobQueueStatus } from '../services/sync-job-queue';
import { SYNC_CADENCE_MINUTES } from '../lib/sync-cadence';
import {
  nudgeShipmentSyncWatchdogRecovery,
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
  const [orders, shipments, worker, queue] = await Promise.all([
    getSyncStatus({ includeOrderCount: false }),
    getShipmentSyncStatus({ includeShipmentCount: false }),
    getPersistedWorkerStatus(),
    getSyncJobQueueStatus(),
  ]);
  const watchdog = await readShipmentSyncWatchdogStatus();
  if (watchdog.enabled && watchdog.verdict.alert) {
    void nudgeShipmentSyncWatchdogRecovery(watchdog, { source: 'status' }).catch((err) => {
      console.warn(
        '[sync/status] shipment watchdog recovery nudge failed:',
        err instanceof Error ? err.message : err,
      );
    });
  }
  const workerSchedulerActive = Boolean(
    worker.status?.schedulerEnabled && !worker.stale
  );
  const queueStatus = {
    ...queue,
    enabled: queue.enabled || workerSchedulerActive,
    started: queue.started || workerSchedulerActive,
  };
  return c.json({
    // Legacy top-level fields kept for existing frontend callers.
    ...orders,
    status: orders.lastSyncedAt ? 'done' : 'idle',
    mode: orders.lastSyncedAt ? 'incremental' : 'idle',
    error: null as string | null,
    page: 0,
    total: 0,
    count: 0,
    lastSync:
      orders.lastSyncedAt && Number.isFinite(Date.parse(orders.lastSyncedAt))
        ? Date.parse(orders.lastSyncedAt)
        : null,
    lastSyncAt: orders.lastSyncedAt,
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
