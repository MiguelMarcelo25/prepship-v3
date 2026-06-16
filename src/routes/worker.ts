import { Hono } from 'hono';
import {
  getApiRuntimeStatus,
  getPersistedWorkerStatus,
} from '../services/worker-status';
import { getSyncJobQueueStatus } from '../services/sync-job-queue';
import { readWorkerStatusEvents } from '../services/worker-status-events';
import { requireAdmin } from '../middleware/auth';

const app = new Hono();

app.get('/status', async (c) => {
  const [worker, queue] = await Promise.all([
    getPersistedWorkerStatus(),
    getSyncJobQueueStatus(),
  ]);
  const workerSchedulerActive = Boolean(
    worker.status?.schedulerEnabled && !worker.stale
  );
  return c.json({
    api: getApiRuntimeStatus(),
    worker,
    queue: {
      ...queue,
      enabled: queue.enabled || workerSchedulerActive,
      started: queue.started || workerSchedulerActive,
    },
  });
});

// PS-256: durable worker-status history (heartbeats / job transitions / staleness alerts).
// Admin-gated (the base /worker mount is requireAuth only). Returns [] when the durable
// flag (WORKER_STATUS_EVENTS_DURABLE) is OFF — no DB touched.
app.get('/status-history', requireAdmin, async (c) => {
  const limitParam = Number.parseInt(c.req.query('limit') ?? '', 10);
  const limit = Number.isFinite(limitParam) ? limitParam : undefined;
  const eventType = c.req.query('eventType') || undefined;
  const events = await readWorkerStatusEvents({ limit, eventType });
  return c.json({ events });
});

export default app;
