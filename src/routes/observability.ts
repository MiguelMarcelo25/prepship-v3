import { Hono } from 'hono';
import { getApiTimingSnapshot } from '../lib/http/api-metrics';
import { env } from '../lib/env';

const app = new Hono();

app.get('/api-timing', (c) => c.json(getApiTimingSnapshot()));

app.get('/status', (c) => {
  const memory = process.memoryUsage();
  const timing = getApiTimingSnapshot();
  const hotRoutes = timing.routes.slice(0, 10).map((route) => ({
    method: route.method,
    path: route.path,
    count: route.count,
    errorCount: route.errorCount,
    p95Ms: route.p95Ms,
    p99Ms: route.p99Ms,
    maxMs: route.maxMs,
    lastStatus: route.lastStatus,
    lastObservedAt: route.lastObservedAt,
  }));

  return c.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    process: {
      nodeEnv: env.NODE_ENV,
      uptimeSeconds: Math.round(process.uptime()),
      memory: {
        rssBytes: memory.rss,
        heapTotalBytes: memory.heapTotal,
        heapUsedBytes: memory.heapUsed,
        externalBytes: memory.external,
        arrayBuffersBytes: memory.arrayBuffers,
      },
    },
    runtime: {
      runSyncScheduler: env.RUN_SYNC_SCHEDULER,
      usePgBossScheduler: env.USE_PG_BOSS_SCHEDULER,
      runOrdersPerformanceMaintenance:
        env.RUN_ORDERS_PERFORMANCE_MAINTENANCE === true,
      rateBackfillSchedulerEnabled: env.ENABLE_RATE_BACKFILL_SCHEDULER,
      rateBackfillSchedulerDisabled: env.DISABLE_RATE_BACKFILL_SCHEDULER,
    },
    apiTiming: {
      routeCount: timing.routeCount,
      window: timing.window,
      hotRoutes,
    },
  });
});

export default app;
