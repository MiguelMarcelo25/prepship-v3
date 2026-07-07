import { Hono } from 'hono';
import { getApiTimingSnapshot } from '../lib/http/api-metrics';
import { getLabelOperationLogSnapshot } from '../lib/label-operation-log';
import { env } from '../lib/env';
import { sql } from '../db/client';
import { getRateProofCanaryStats } from '../services/shipping-workflow/rate-proof-enforcement';

const app = new Hono();

app.get('/api-timing', (c) =>
  c.json({
    ...getApiTimingSnapshot(),
    labelOperationLogs: getLabelOperationLogSnapshot(),
  })
);

// PS-244 Phase 4: read-only canary surface for the label-purchase snapshot
// enforcement flip. Reports the mode + how often a supplied snapshot ref resolves
// (snapshot_enforced) vs. falls back to the FE proof (snapshot_fallback, by reason).
// DJ flips RATE_PROOF_ENFORCEMENT=strict once snapshot_fallback stays ~0.
app.get('/rate-proof-canary', (c) => c.json(getRateProofCanaryStats()));

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
    database,
    apiTiming: {
      routeCount: timing.routeCount,
      window: timing.window,
      hotRoutes,
    },
  });
});

export default app;
