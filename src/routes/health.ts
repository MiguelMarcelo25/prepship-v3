import { Hono } from 'hono';
import postgres from 'postgres';
import { performance } from 'node:perf_hooks';
import { env } from '../lib/env';
import { readPrintQueueWorkerHealth } from '../services/print-queue-worker-health';
import { readShipmentSyncWatchdogStatus } from '../services/shipment-sync-watchdog';
import { getPersistedWorkerStatus } from '../services/worker-status';
import { evaluateWorkerJobSkipHealth } from '../services/worker-job-skip-health';
import { readInventoryClaimReviewHealth } from '../services/inventory-claim-review-health';
// PS-503: the pool that actually serves traffic. `healthSql` below has its own
// sockets, so it cannot observe this one dying.
import { sql as mainSql } from '../db/client';
import { createMainPoolHealthTracker } from '../services/main-pool-health';

const app = new Hono();
const DB_HEALTH_TIMEOUT_MS = env.DB_HEALTH_TIMEOUT_MS;
const DB_HEALTH_STATEMENT_TIMEOUT_MS = Math.max(1_000, DB_HEALTH_TIMEOUT_MS - 1_000);
const DB_HEALTH_CONNECT_TIMEOUT_SECONDS = Math.max(1, Math.ceil(DB_HEALTH_TIMEOUT_MS / 1_000));
const EVENT_LOOP_HEALTH_TIMEOUT_MS = 500;
const EVENT_LOOP_DELAY_BUDGET_MS = 250;

const healthSql = postgres(env.DATABASE_URL, {
  prepare: false,
  max: 3,
  idle_timeout: 10,
  // Audit 1.9: bound read-only-poisoned session lifetime (see db/client.ts).
  max_lifetime: env.DB_MAX_LIFETIME_SECONDS,
  connect_timeout: DB_HEALTH_CONNECT_TIMEOUT_SECONDS,
  connection: { statement_timeout: DB_HEALTH_STATEMENT_TIMEOUT_MS },
});

type CancelableQuery<T> = Promise<T> & { cancel?: () => void };

type ReadinessComponentName =
  | 'db'
  | 'dbWrite'
  | 'mainPool'
  | 'orders'
  | 'syncFreshness'
  | 'fulfillmentOutbox'
  | 'printQueue'
  | 'printQueueWorker'
  | 'inventoryClaimReview'
  | 'eventLoop';

type ReadinessComponent = {
  name: ReadinessComponentName;
  status: 'ok' | 'fail';
  latencyMs: number;
  details?: Record<string, number | string>;
};

async function withTimeout<T>(
  query: CancelableQuery<T>,
  timeoutMs: number
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      query,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          query.cancel?.();
          reject(
            new Error(`DB health check timed out after ${timeoutMs}ms`)
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function checkComponent(
  name: ReadinessComponentName,
  action: () => Promise<{ details?: Record<string, number | string> } | void>
): Promise<ReadinessComponent> {
  const startedAt = Date.now();
  try {
    const result = await action();
    return {
      name,
      status: 'ok',
      latencyMs: Date.now() - startedAt,
      ...(result?.details ? { details: result.details } : {}),
    };
  } catch {
    return {
      name,
      status: 'fail',
      latencyMs: Date.now() - startedAt,
    };
  }
}

const checkDb = () =>
  checkComponent('db', async () => {
    await withTimeout(healthSql`select 1`, DB_HEALTH_TIMEOUT_MS);
  });

const mainPoolTracker = createMainPoolHealthTracker(env.DB_MAIN_POOL_SATURATION_TOLERANCE);

/**
 * PS-503: probe the pool that actually serves requests.
 *
 * Every other probe here runs on `healthSql`, which owns separate sockets. On
 * 2026-08-11 the Supavisor pooler closed the MAIN pool's connections twice
 * (`write CONNECTION_CLOSED …pooler.supabase.com:6543`); readiness answered 200
 * in ~0.7s through both outages because `healthSql` was untouched.
 *
 * Deliberately not written with `checkComponent`: that helper discards the error
 * (`catch {}`), and the error is the whole signal. A closed socket must fail
 * readiness at once, while a merely busy pool must not — the main pool is shared
 * with live traffic, so failing on first timeout would turn a load spike into a
 * restart loop. See services/main-pool-health.ts for the classification.
 */
async function checkMainPool(): Promise<ReadinessComponent> {
  const startedAt = Date.now();
  try {
    await withTimeout(mainSql`select 1`, env.DB_MAIN_POOL_HEALTH_TIMEOUT_MS);
    mainPoolTracker.recordSuccess();
    return {
      name: 'mainPool',
      status: 'ok',
      latencyMs: Date.now() - startedAt,
      // PS-504: a healthy pool that dropped sockets earlier is still evidence.
      // Omitted entirely while the counters are clean, so a normal response
      // stays quiet.
      ...lifetimeDetails(),
    };
  } catch (error) {
    const verdict = mainPoolTracker.recordFailure(error);
    return {
      name: 'mainPool',
      // A tolerated saturation stays green, but still reports why, so an
      // operator can see the pool straining before it trips.
      status: verdict.healthy ? 'ok' : 'fail',
      latencyMs: Date.now() - startedAt,
      details: {
        poolState: verdict.failure ?? 'unknown',
        consecutiveSaturated: verdict.consecutiveSaturated,
        ...(lifetimeDetails().details ?? {}),
      },
    };
  }
}

/**
 * PS-504: lifetime main-pool failure counts. Returns nothing while clean, so
 * `/health` stays silent on a healthy service and any appearance of these keys
 * means a real dropped socket has happened since boot.
 */
function lifetimeDetails(): { details?: Record<string, number | string> } {
  const { unreachableCount, saturatedCount } = mainPoolTracker.snapshot();
  if (unreachableCount === 0 && saturatedCount === 0) return {};
  return { details: { unreachableCount, saturatedCount } };
}

async function checkPrintQueueWorker(): Promise<ReadinessComponent> {
  const startedAt = Date.now();
  try {
    const health = await readPrintQueueWorkerHealth();
    return {
      name: 'printQueueWorker',
      status: health.status,
      latencyMs: Date.now() - startedAt,
      details: {
        reasonCodes: health.reasons.join(',') || 'none',
        heartbeatAgeSeconds: health.facts.heartbeatAgeSeconds ?? -1,
        pgBossCreated: health.facts.pgBossCreated,
        pgBossRetry: health.facts.pgBossRetry,
        pgBossActive: health.facts.pgBossActive,
        pgBossFailed: health.facts.pgBossFailed,
        newestFailureAgeSeconds: health.facts.pgBossNewestFailureAgeSeconds ?? -1,
        oldestPendingAgeSeconds: health.facts.pgBossOldestPendingAgeSeconds ?? -1,
        oldestActiveAgeSeconds: health.facts.pgBossOldestActiveAgeSeconds ?? -1,
        durableActive: health.facts.durableActive,
        durableCurrent: health.facts.durableCurrent,
        durableTotal: health.facts.durableTotal,
        durableOldestActiveAgeSeconds:
          health.facts.durableOldestActiveAgeSeconds ?? -1,
        providerPending: health.facts.providerPending,
        lastWorkerJobStatus: health.facts.lastWorkerJobStatus ?? 'none',
        lastWorkerJobAgeSeconds: health.facts.lastWorkerJobAgeSeconds ?? -1,
      },
    };
  } catch {
    return {
      name: 'printQueueWorker',
      status: 'fail',
      latencyMs: Date.now() - startedAt,
      details: { reasonCodes: 'health_probe_failed' },
    };
  }
}

async function checkSyncFreshness(): Promise<ReadinessComponent> {
  const startedAt = Date.now();
  try {
    const health = await readShipmentSyncWatchdogStatus();
    return {
      name: 'syncFreshness',
      status: health.verdict.alert ? 'fail' : 'ok',
      latencyMs: Date.now() - startedAt,
      details: {
        state: health.verdict.state,
        reason: health.verdict.reason,
        orderAgeSeconds: health.verdict.orderAgeSeconds ?? -1,
        shipmentAgeSeconds: health.verdict.shipmentAgeSeconds ?? -1,
        currentJob: health.worker.currentJob ?? 'none',
        currentJobId: health.worker.currentJobId ?? 'none',
        currentGenerationId: health.worker.currentGenerationId ?? 'none',
        currentLane: health.worker.currentLane ?? 'none',
        currentJobAgeSeconds: health.worker.currentJobAgeSeconds ?? -1,
        currentJobDeadlineAt: health.worker.currentJobDeadlineAt ?? 'none',
        lastCompletedOrderSyncAt: health.worker.lastCompletedOrderSyncAt ?? 'none',
        lastCompletedShipmentSyncAt: health.worker.lastCompletedShipmentSyncAt ?? 'none',
      },
    };
  } catch {
    return {
      name: 'syncFreshness',
      status: 'fail',
      latencyMs: Date.now() - startedAt,
      details: { state: 'probe_failed', reason: 'sync freshness probe failed closed' },
    };
  }
}

async function checkFulfillmentOutboxWorker(): Promise<ReadinessComponent> {
  const startedAt = Date.now();
  try {
    const worker = await getPersistedWorkerStatus();
    const health = evaluateWorkerJobSkipHealth(
      worker.status?.jobs['prepship.sync.fulfillment-outbox'],
      Date.now(),
      worker.status?.startedAt ?? null,
    );
    return {
      name: 'fulfillmentOutbox',
      status: health.status,
      latencyMs: Date.now() - startedAt,
      details: {
        reasonCode: health.reasonCode,
        consecutiveSkips: health.consecutiveSkips,
        firstSkippedAt: health.firstSkippedAt ?? 'none',
        skipAgeSeconds: health.skipAgeSeconds ?? -1,
        lastRunAt: health.lastRunAt ?? 'none',
        lastRunAgeSeconds: health.lastRunAgeSeconds ?? -1,
      },
    };
  } catch {
    return {
      name: 'fulfillmentOutbox',
      status: 'fail',
      latencyMs: Date.now() - startedAt,
      details: { reasonCode: 'health_probe_failed' },
    };
  }
}

const checkEventLoopDelay = () =>
  checkComponent('eventLoop', async () => {
    const startedAt = performance.now();
    await withTimeout(
      new Promise<void>((resolve) => setTimeout(resolve, 0)) as CancelableQuery<void>,
      EVENT_LOOP_HEALTH_TIMEOUT_MS
    );
    const delayMs = Math.round(performance.now() - startedAt);
    if (delayMs > EVENT_LOOP_DELAY_BUDGET_MS) {
      throw new Error('event loop delay budget exceeded');
    }
    return { details: { delayMs, budgetMs: EVENT_LOOP_DELAY_BUDGET_MS } };
  });

// Audit 2.9 (2026-07-13): /ready and /deep used to be IDENTICAL — every Render
// readiness poll ran a count(*) over all of print_queue_orders forever, and a
// degraded-but-serviceable dependency (an orders SELECT timing out under load)
// could flap the instance out of rotation mid-incident, exactly when capacity
// matters most. Readiness now checks only what "can this instance serve" needs:
// DB reachable, DB WRITABLE (the read-only-poisoned-session restart lever), and
// the event loop responsive. The table aggregates stay on /deep for diagnostics.
async function checkReadyReadiness() {
  const components = await Promise.all([
    checkDb(),
    checkDbWrite(),
    // PS-503: runs on the main pool, so it adds no load to healthSql's max:3.
    checkMainPool(),
    checkEventLoopDelay(),
  ]);
  return {
    ok: components.every((component) => component.status === 'ok'),
    components,
  };
}

const checkDbWrite = () =>
  checkComponent('dbWrite', async () => {
      // Audit 1.9 (2026-07-13, read-only incident hardening): a session that
      // captured default_transaction_read_only=on during a Supabase disk event
      // passes `select 1` forever — only a WRITE exposes it. A failing write
      // probe marks the service unhealthy so Render restarts it and the pools
      // reconnect writable. Single-row upsert on the settings PK: HOT-update
      // cheap, no table growth.
      await withTimeout(
        healthSql`
          insert into settings (key, value)
          values ('health.write_probe', now()::text)
          on conflict (key) do update set value = excluded.value
        `,
        DB_HEALTH_TIMEOUT_MS
      );
  });

// Deep diagnostics: everything readiness checks PLUS the dependency probes and
// table aggregates (operator/ops surface, not the Render rotation signal).
async function checkDeepReadiness() {
  // Deploy validation (2026-07-14): keep concurrent DB probes below the
  // dedicated health pool's max of 3. Adding dbWrite made this four DB queries
  // at once; on Render the dependency probes stayed client-queued until their
  // 12s timeout and never reached Postgres. Stage the cheap serving checks
  // first, then run the two diagnostic table probes together.
  // PS-503: checkMainPool runs on the MAIN pool, so it does not count against
  // the max:3 budget this staging protects.
  const [db, dbWrite, mainPool, eventLoop] = await Promise.all([
    checkDb(),
    checkDbWrite(),
    checkMainPool(),
    checkEventLoopDelay(),
  ]);
  const [orders, printQueue, printQueueWorker] = await Promise.all([
    checkComponent('orders', async () => {
      await withTimeout(healthSql`select 1 from orders limit 1`, DB_HEALTH_TIMEOUT_MS);
    }),
    checkComponent('printQueue', async () => {
      const [summary] = await withTimeout(
        healthSql`
          select
            count(*)::int as total_count,
            count(*) filter (where status = 'queued')::int as queued_count
          from print_queue_orders
        `,
        DB_HEALTH_TIMEOUT_MS
      );

      return {
        details: {
          totalCount: Number(summary?.total_count ?? 0),
          queuedCount: Number(summary?.queued_count ?? 0),
        },
      };
    }),
    checkPrintQueueWorker(),
  ]);
  // PS-497: inventory deduction stopped on 2026-07-16 and ran 22 days before anyone noticed,
  // because a claim that lands in `status='review'` is written and never read —
  // `fulfillment-deductions.ts` selects `status='pending'` only. A backlog nothing consumes
  // and nothing reports is invisible by construction, which is the actual reason this went
  // unnoticed for three weeks rather than three hours.
  //
  // Runs SEQUENTIALLY, after the batch above, exactly like syncFreshness and
  // fulfillmentOutbox. `healthSql` is a max:3 pool and that batch already uses it; adding a
  // fourth concurrent probe would queue against a full pool and could exhaust
  // DB_HEALTH_TIMEOUT_MS, failing /deep — which answers 503 and makes Render restart the
  // service. That is the restart loop this probe exists to avoid, so it must not cause one.
  // health-deep-readiness-guard.mjs pins the batch shape and caught exactly this.
  //
  // Reported, NEVER gated: the component always returns ok. Same shape as the printQueue
  // probe above — publish the numbers, let the watchdog and operators decide what they mean.
  // The query itself lives in inventory-claim-review-health.ts so a guard can EXECUTE it
  // against a seeded database rather than read it as text. The first guard for this probe
  // asserted the SQL's source shape and was defeated by appending `and false` to the
  // predicate: permanent zero backlog, all ten assertions still green.
  const inventoryClaimReview = await checkComponent('inventoryClaimReview', async () => {
    const details = await withTimeout(
      readInventoryClaimReviewHealth(((strings: TemplateStringsArray) => healthSql(strings)) as never),
      DB_HEALTH_TIMEOUT_MS
    );
    return { details };
  });
  const syncFreshness = await checkSyncFreshness();
  const fulfillmentOutbox = await checkFulfillmentOutboxWorker();
  const components = [
    db,
    dbWrite,
    mainPool,
    orders,
    printQueue,
    printQueueWorker,
    inventoryClaimReview,
    syncFreshness,
    fulfillmentOutbox,
    eventLoop,
  ];

  return {
    ok: components.every((component) => component.status === 'ok'),
    components,
  };
}

function readinessResponseBody(readiness: { ok: boolean; components: ReadinessComponent[] }) {
  return {
    status: readiness.ok ? 'ready' : 'degraded',
    components: readiness.components,
    // PS-215: the external-shipped classifier flags are operational state the
    // Shipped-table invariant depends on (rows resting on "Shipment sync
    // error" usually mean the classifier isn't running). Surfacing them here
    // makes a silently-disabled deploy visible at a glance instead of being
    // discovered through a wall of amber badges.
    externalShippedClassifier: {
      schedulerEnabled: env.ENABLE_EXTERNAL_SHIPPED_CLASSIFIER_SCHEDULER === true,
      autoApplyEnabled: env.ENABLE_EXTERNAL_SHIPPED_AUTO_APPLY === true,
      // Per user override unlock shipped data on 2026-06-27: expose the
      // automatic shipped/cancelled classifier window so Render config drift is
      // visible before old Cancelled rows rest on Shipment sync error.
      lookbackDays: env.EXTERNAL_SHIPPED_CLASSIFIER_LOOKBACK_DAYS,
    },
    ts: new Date().toISOString(),
  };
}

app.get('/', (c) =>
  c.json({
    status: 'ok',
    ts: new Date().toISOString(),
  })
);

app.get('/ready', async (c) => {
  // Audit 2.9: cheap liveness-critical probes only (see checkReadyReadiness).
  const readiness = await checkReadyReadiness();
  return c.json(readinessResponseBody(readiness), readiness.ok ? 200 : 503);
});

app.get('/deep', async (c) => {
  const readiness = await checkDeepReadiness();
  return c.json(readinessResponseBody(readiness), readiness.ok ? 200 : 503);
});

export default app;
