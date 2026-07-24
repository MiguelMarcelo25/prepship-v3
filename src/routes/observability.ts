import { Hono } from 'hono';
import { getApiTimingSnapshot } from '../lib/http/api-metrics';
import {
  clearLabelOperationLogs,
  deleteLabelOperationLog,
  getLabelOperationLogSnapshot,
} from '../lib/label-operation-log';
import { env } from '../lib/env';
import { sql } from '../db/client';
import { getRateProofEnforcementStats } from '../services/shipping-workflow/rate-proof-enforcement';

const app = new Hono();

app.get('/api-timing', (c) =>
  c.json({
    ...getApiTimingSnapshot(),
    labelOperationLogs: getLabelOperationLogSnapshot(),
  })
);

app.delete('/label-operation-logs/:id', (c) => {
  const removed = deleteLabelOperationLog(c.req.param('id'));
  return c.json({
    removed,
    labelOperationLogs: getLabelOperationLogSnapshot(),
  }, removed ? 200 : 404);
});

app.delete('/label-operation-logs', (c) => {
  const removed = clearLabelOperationLogs();
  return c.json({
    removed,
    labelOperationLogs: getLabelOperationLogSnapshot(),
  });
});

// Read-only strict-enforcement diagnostics. Rejected or missing backend snapshot
// references are counted, but never fall back to frontend-carried proof.
app.get('/rate-proof-enforcement', (c) => c.json(getRateProofEnforcementStats()));
// Compatibility alias for existing monitoring. The payload is strict-only.
app.get('/rate-proof-canary', (c) => c.json(getRateProofEnforcementStats()));

async function getDatabaseStatus() {
  const startedAt = performance.now();
  try {
    await Promise.race([
      sql`select 1 as ok`,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('database health check timed out')), 2_500),
      ),
    ]);

    return {
      ok: true,
      durationMs: Math.round(performance.now() - startedAt),
    };
  } catch {
    return {
      ok: false,
      durationMs: Math.round(performance.now() - startedAt),
      error: 'Database health check failed',
    };
  }
}

app.get('/status', async (c) => {
  const memory = process.memoryUsage();
  const timing = getApiTimingSnapshot();
  const database = await getDatabaseStatus();
  const hotRoutes = timing.routes.slice(0, 10).map((route) => ({
    method: route.method,
    path: route.path,
    count: route.count,
    errorCount: route.errorCount,
    errorRate: route.errorRate,
    p50Ms: route.p50Ms,
    p95Ms: route.p95Ms,
    p99Ms: route.p99Ms,
    maxMs: route.maxMs,
    lastDurationMs: route.lastDurationMs,
    lastStatus: route.lastStatus,
    lastObservedAt: route.lastObservedAt,
    budgetMs: route.budgetMs,
    confidence: route.confidence,
    health: route.health,
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
      usePgBossScheduler: true,
      runOrdersPerformanceMaintenance:
        env.RUN_ORDERS_PERFORMANCE_MAINTENANCE === true,
      rateBackfillSchedulerEnabled: env.ENABLE_RATE_BACKFILL_SCHEDULER,
      rateBackfillSchedulerDisabled: env.DISABLE_RATE_BACKFILL_SCHEDULER,
    },
    database,
    apiTiming: {
      startedAt: timing.startedAt,
      routeCount: timing.routeCount,
      window: timing.window,
      summary: timing.summary,
      hotRoutes,
    },
  });
});

export default app;
