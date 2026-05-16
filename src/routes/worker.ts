import { Hono } from 'hono';
import {
  getApiRuntimeStatus,
  getPersistedWorkerStatus,
} from '../services/worker-status';
import { getSyncJobQueueStatus } from '../services/sync-job-queue';
import { getReportingMetricsStatus } from '../services/reporting-metrics';

const app = new Hono();

app.get('/status', async (c) => {
  const [worker, queue, reporting] = await Promise.all([
    getPersistedWorkerStatus(),
    getSyncJobQueueStatus(),
    getReportingMetricsStatus().catch((err) => ({
      tablesReady: false,
      error: err instanceof Error ? err.message : String(err),
    })),
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
    reporting,
  });
});

export default app;
