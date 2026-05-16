import { Hono } from 'hono';
import {
  getApiRuntimeStatus,
  getPersistedWorkerStatus,
} from '../services/worker-status';
import { getSyncJobQueueStatus } from '../services/sync-job-queue';

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

export default app;
