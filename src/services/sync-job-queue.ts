// Per user override unlock shipped data on 2026-06-17 (PS-272): queue-maintenance reaper; clears stale pgboss active rows only, never shipped/cancelled order/shipment data.
import PgBoss from 'pg-boss';
import { sql as pg } from '../db/client';
import { env } from '../lib/env';
import { withDeadline } from '../lib/with-deadline';
import { reapStaleQueuedCadenceJobs, reapStuckActiveJobs } from './sync-stuck-job-reaper';
import { jobSingletonSeconds } from '../lib/job-singleton-seconds';
import {
  getSyncJobLaneBlocker,
  isSyncJobNameActive,
  syncJobLaneFor,
  type SyncJobLane,
} from './sync-job-lanes';
import { withSyncLaneAdvisoryLock } from './sync-lane-lock';
import {
  runBackfillTick,
  runFulfillmentOutboxTick,
  runExternalShippedClassifierJob,
  runInventoryImportFromOrders,
  runReportingRefreshTick,
  runShipmentTrackingTick,
  runSyncProductsTick,
  runWalmartFeesTick,
} from './sync-scheduler';
import { syncOrders } from './order-sync';
import { syncShipments } from './shipment-sync';
import {
  buildManualOrderSyncJobPayload,
  orderSyncOptionsFromJobPayload,
  type ManualOrderSyncRequest,
} from './manual-order-sync-job';
import {
  recordWorkerHeartbeat,
  recordWorkerJobFailure,
  recordWorkerJobSkipped,
  recordWorkerJobStart,
  recordWorkerJobSuccess,
  setWorkerMode,
} from './worker-status';
import { SYNC_CADENCE_MS, SYNC_STARTUP_DELAY_MS } from '../lib/sync-cadence';

// PS-132: cadence is owned by src/lib/sync-cadence.ts (single source shared with the status
// endpoint). Local aliases keep the rest of this file unchanged.
const ORDER_SYNC_INTERVAL_MS = SYNC_CADENCE_MS.orders;
const SHIPMENT_SYNC_INTERVAL_MS = SYNC_CADENCE_MS.shipments;
const RATE_BACKFILL_INTERVAL_MS = SYNC_CADENCE_MS.rateBackfill;
const INVENTORY_IMPORT_FROM_ORDERS_INTERVAL_MS = SYNC_CADENCE_MS.inventoryFromOrders;
const INVENTORY_SYNC_PRODUCTS_INTERVAL_MS = SYNC_CADENCE_MS.productCatalog;
const FULFILLMENT_OUTBOX_INTERVAL_MS = SYNC_CADENCE_MS.fulfillmentOutbox;
const REPORTING_REFRESH_INTERVAL_MS = SYNC_CADENCE_MS.reportingMetrics;
const EXTERNAL_SHIPPED_CLASSIFIER_INTERVAL_MS = SYNC_CADENCE_MS.externalShippedClassifier;
const SHIPMENT_TRACKING_INTERVAL_MS = SYNC_CADENCE_MS.shipmentTracking;
const WALMART_FEES_INTERVAL_MS = SYNC_CADENCE_MS.walmartFees;
const STARTUP_DELAY_MS = SYNC_STARTUP_DELAY_MS;

const JOBS = {
  orders: 'prepship.sync.orders',
  shipments: 'prepship.sync.shipments',
  rateBackfill: 'prepship.sync.rate-backfill',
  inventoryImport: 'prepship.sync.inventory-import',
  syncProducts: 'prepship.sync.products',
  fulfillmentOutbox: 'prepship.sync.fulfillment-outbox',
  reportingRefresh: 'prepship.reporting.refresh',
  externalShippedClassifier: 'prepship.shipping.external-shipped-classifier',
  shipmentTracking: 'prepship.tracking.poll',
  walmartFees: 'prepship.fees.walmart-sync',
} as const;

type JobName = (typeof JOBS)[keyof typeof JOBS];

type Timer = ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>;
type PgBossJobLike = {
  id?: unknown;
  data?: unknown;
  singletonKey?: unknown;
  createdOn?: unknown;
};

let boss: PgBoss | null = null;
let started = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
const activeJobsByLane = new Map<SyncJobLane, JobName>();
const timers: Timer[] = [];
const BUSY_DEFER_SECONDS = 60;
const ORDER_STARVATION_DEFER_THRESHOLD = 3;
const ORDER_STARVATION_DEFER_SECONDS = 10;
const BUSY_DEFER_JOB_NAMES = new Set<JobName>([JOBS.orders, JOBS.shipments]);

export type ManualOrderSyncEnqueueResult = {
  queued: boolean;
  jobId: string | null;
  queueStarted: boolean;
  jobName: typeof JOBS.orders;
  mode: 'incremental' | 'full';
  requestedAt: string;
  error: string | null;
};

function manualOrderSyncMode(data: unknown): 'incremental' | 'full' | null {
  if (!data || typeof data !== 'object') return null;
  const source = data as { requestedBy?: unknown; mode?: unknown };
  if (source.requestedBy !== 'manual-sync') return null;
  if (source.mode === 'incremental' || source.mode === 'full') return source.mode;
  return null;
}

function dateFromUnknown(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  return null;
}

async function findSupersedingManualOrderSyncJob(
  name: JobName,
  job: PgBossJobLike | undefined,
): Promise<string | null> {
  if (name !== JOBS.orders || !job) return null;
  const mode = manualOrderSyncMode(job.data);
  if (!mode || typeof job.id !== 'string') return null;

  try {
    const jobTable = `${env.PG_BOSS_SCHEMA}.job`;
    const [current] = await pg<Array<{ created_on: Date; singleton_key: string | null }>>`
      SELECT created_on, singleton_key
      FROM ${pg(jobTable)}
      WHERE id = ${job.id}
        AND name = ${name}
      LIMIT 1
    `;
    const createdOn = dateFromUnknown(job.createdOn) ?? dateFromUnknown(current?.created_on);
    if (!createdOn) return null;
    const singletonKey =
      (typeof job.singletonKey === 'string' && job.singletonKey) ||
      current?.singleton_key ||
      `manual-${mode}`;

    const [newer] = await pg<Array<{ id: string }>>`
      SELECT id::text AS id
      FROM ${pg(jobTable)}
      WHERE name = ${name}
        AND singleton_key = ${singletonKey}
        AND state IN ('created', 'retry')
        AND created_on > ${createdOn}
      ORDER BY created_on DESC, id DESC
      LIMIT 1
    `;
    return newer?.id ?? null;
  } catch (err) {
    console.warn(
      '[job-queue] manual order-sync superseded check skipped:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

function isRateBackfillSchedulerEnabled(): boolean {
  return env.ENABLE_RATE_BACKFILL_SCHEDULER && !env.DISABLE_RATE_BACKFILL_SCHEDULER;
}

async function enqueueJob(name: JobName, intervalMs: number): Promise<void> {
  if (!boss) return;
  if (isSyncJobNameActive(activeJobsByLane, name)) {
    console.log(`[job-queue] ${name} already active in worker; skipped enqueue`);
    await recordWorkerJobSkipped(name, 'already active in worker');
    return;
  }
  try {
    const id = await boss.send(
      name,
      { requestedAt: new Date().toISOString() },
      {
        singletonKey: 'cadence',
        singletonSeconds: jobSingletonSeconds(intervalMs),
        retryLimit: 2,
        retryDelay: 30,
        retryBackoff: true,
        // PS-272: explicit per-send expiration so the job row carries an expire deadline pg-boss's own
        // expire() maintenance loop (now enabled via supervise above) can act on. expireInSeconds is
        // the canonical unit on SendOptions (ExpirationOptions); 30 min === the queue/constructor value.
        expireInMinutes: 30,
        retentionDays: 7,
      }
    );

    if (id) {
      console.log(`[job-queue] enqueued ${name} (${id})`);
    } else {
      console.log(`[job-queue] ${name} already queued/running; skipped enqueue`);
      await recordWorkerJobSkipped(name, 'already queued or running');
    }
  } catch (err) {
    console.error(
      `[job-queue] failed to enqueue ${name}:`,
      err instanceof Error ? err.message : err
    );
  }
}

export type ShipmentSyncWatchdogEnqueueResult = {
  enqueued: boolean;
  jobId: string | null;
  queueStarted: boolean;
  error: string | null;
};

async function sendShipmentSyncWatchdogJob(
  targetBoss: PgBoss,
  queueStarted: boolean,
): Promise<ShipmentSyncWatchdogEnqueueResult> {
  try {
    // Per user override unlock shipped data on 2026-07-01: PS-361 recovery
    // enqueues one shipment import tick only. It does not buy labels, create
    // postage, notify marketplaces, or mutate shipped/cancelled rows here.
    const id = await targetBoss.send(
      JOBS.shipments,
      {
        requestedAt: new Date().toISOString(),
        requestedBy: 'shipment-sync-watchdog',
      },
      {
        singletonKey: 'watchdog-recovery',
        singletonSeconds: 60,
        retryLimit: 2,
        retryDelay: 30,
        retryBackoff: true,
        expireInMinutes: 30,
        retentionDays: 7,
      },
    );
    return {
      enqueued: Boolean(id),
      jobId: id ? String(id) : null,
      queueStarted,
      error: null,
    };
  } catch (err) {
    return {
      enqueued: false,
      jobId: null,
      queueStarted,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function sendManualOrderSyncJob(
  targetBoss: PgBoss,
  queueStarted: boolean,
  request: ManualOrderSyncRequest,
): Promise<ManualOrderSyncEnqueueResult> {
  const payload = buildManualOrderSyncJobPayload(request);
  try {
    // Per user override unlock shipped data on 2026-07-02: this only
    // enqueues the existing backend order-sync worker lane. The request no
    // longer runs ShipStation import inline, buys labels, prints postage, or
    // mutates marketplace notifications.
    const id = await targetBoss.send(
      JOBS.orders,
      payload,
      {
        singletonKey: `manual-${payload.mode}`,
        singletonSeconds: 60,
        retryLimit: 2,
        retryDelay: 30,
        retryBackoff: true,
        expireInMinutes: 30,
        retentionDays: 7,
      },
    );
    return {
      queued: Boolean(id),
      jobId: id ? String(id) : null,
      queueStarted,
      jobName: JOBS.orders,
      mode: payload.mode,
      requestedAt: payload.requestedAt,
      error: null,
    };
  } catch (err) {
    return {
      queued: false,
      jobId: null,
      queueStarted,
      jobName: JOBS.orders,
      mode: payload.mode,
      requestedAt: payload.requestedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function enqueueManualOrderSyncJob(
  request: ManualOrderSyncRequest = {},
): Promise<ManualOrderSyncEnqueueResult> {
  if (!env.USE_PG_BOSS_SCHEDULER && !started) {
    const payload = buildManualOrderSyncJobPayload(request);
    return {
      queued: false,
      jobId: null,
      queueStarted: false,
      jobName: JOBS.orders,
      mode: payload.mode,
      requestedAt: payload.requestedAt,
      error: 'pg-boss scheduler is disabled; manual order sync must run through the backend job lane',
    };
  }

  if (boss && started) {
    return sendManualOrderSyncJob(boss, true, request);
  }

  const transientBoss = new PgBoss({
    connectionString: env.DATABASE_URL,
    schema: env.PG_BOSS_SCHEMA,
    application_name: 'prepship-api-manual-order-sync',
    max: 1,
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 30 * 60,
    retentionDays: 7,
    deleteAfterDays: 7,
    supervise: false,
  });

  try {
    await transientBoss.start();
    await transientBoss.createQueue(JOBS.orders, {
      name: JOBS.orders,
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 30 * 60,
      retentionDays: 7,
    });
    return await sendManualOrderSyncJob(transientBoss, false, request);
  } catch (err) {
    const payload = buildManualOrderSyncJobPayload(request);
    return {
      queued: false,
      jobId: null,
      queueStarted: false,
      jobName: JOBS.orders,
      mode: payload.mode,
      requestedAt: payload.requestedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await transientBoss.stop({ graceful: true, timeout: 5_000 }).catch(() => undefined);
  }
}

export async function enqueueShipmentSyncWatchdogJob(): Promise<ShipmentSyncWatchdogEnqueueResult> {
  if (boss && started) {
    return sendShipmentSyncWatchdogJob(boss, true);
  }

  const transientBoss = new PgBoss({
    connectionString: env.DATABASE_URL,
    schema: env.PG_BOSS_SCHEMA,
    application_name: 'prepship-api-watchdog',
    max: 1,
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 30 * 60,
    retentionDays: 7,
    deleteAfterDays: 7,
    supervise: false,
  });

  try {
    await transientBoss.start();
    await transientBoss.createQueue(JOBS.shipments, {
      name: JOBS.shipments,
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 30 * 60,
      retentionDays: 7,
    });
    return await sendShipmentSyncWatchdogJob(transientBoss, false);
  } catch (err) {
    return {
      enqueued: false,
      jobId: null,
      queueStarted: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await transientBoss.stop({ graceful: true, timeout: 5_000 }).catch(() => undefined);
  }
}

async function deferBusySyncJob(
  name: JobName,
  blockedBy: string,
  lane: SyncJobLane,
  priorDeferCount = 0,
): Promise<string | null> {
  if (!boss || !BUSY_DEFER_JOB_NAMES.has(name)) return null;
  try {
    const deferCount = Math.max(0, Math.trunc(priorDeferCount)) + 1;
    const orderStarvation =
      name === JOBS.orders && deferCount >= ORDER_STARVATION_DEFER_THRESHOLD;
    const delaySeconds = orderStarvation ? ORDER_STARVATION_DEFER_SECONDS : BUSY_DEFER_SECONDS;
    const singletonKey = orderStarvation ? 'busy-defer-priority-orders' : 'busy-defer';
    // Per user override unlock shipped data on 2026-07-01: this only creates a
    // replacement pg-boss sync tick for order/shipment import when the shared
    // ShipStation lane is busy. It does not touch orders, shipments, labels,
    // postage, or marketplace notifications.
    const id = await boss.sendAfter(
      name,
      {
        requestedAt: new Date().toISOString(),
        deferredBecause: blockedBy,
        deferredLane: lane,
        deferCount,
        orderStarvation,
      },
      {
        singletonKey,
        singletonSeconds: delaySeconds,
        retryLimit: 2,
        retryDelay: 30,
        retryBackoff: true,
        expireInMinutes: 30,
        retentionDays: 7,
        priority: orderStarvation ? 100 : 0,
      },
      delaySeconds,
    );

    if (id) {
      console.log(
        `[job-queue] deferred ${name} for ${delaySeconds}s because ${blockedBy} is running in ${lane} lane (${id})`
      );
    } else {
      console.log(`[job-queue] ${name} already has a busy-defer job queued`);
    }
    return id;
  } catch (err) {
    console.error(
      `[job-queue] failed to defer ${name}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

function scheduleEnqueue(
  name: JobName,
  initialDelayMs: number,
  intervalMs: number
): void {
  const timeout = setTimeout(() => {
    void enqueueJob(name, intervalMs);
    const interval = setInterval(
      () => void enqueueJob(name, intervalMs),
      intervalMs
    );
    timers.push(interval);
  }, initialDelayMs);
  timers.push(timeout);
}

// PS-265 — bound every job handler so a hung one (e.g. a ShipStation HTTP call
// that never returns) can't hold the active worker lane forever and deadlock the
// whole worker. Must be < pg-boss expireInMinutes (30) so the in-process timeout
// fires first. Default 10 min; override via env. The sync is watermark-based and
// idempotent, so a timed-out tick loses nothing — the next tick re-pulls the gap.
const JOB_HANDLER_TIMEOUT_MS = Math.max(
  60_000,
  Math.min(25 * 60_000, Number(process.env.JOB_HANDLER_TIMEOUT_MS) || 10 * 60_000),
);

function busyDeferCount(jobData: unknown): number {
  if (!jobData || typeof jobData !== 'object') return 0;
  const count = Number((jobData as { deferCount?: unknown }).deferCount);
  return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
}

async function registerWorker(
  name: JobName,
  handler: (jobData: unknown) => Promise<unknown> | unknown
): Promise<void> {
  if (!boss) return;
  await boss.work(
    name,
    { batchSize: 1, pollingIntervalSeconds: 5 },
    async ([job]) => {
      const supersededBy = await findSupersedingManualOrderSyncJob(
        name,
        job as PgBossJobLike | undefined,
      );
      if (supersededBy) {
        console.log(
          `[job-queue] skipped stale manual ${name} (${job?.id ?? 'unknown'}); newer job ${supersededBy} is queued`
        );
        await recordWorkerJobSkipped(name, `superseded by newer manual order sync ${supersededBy}`);
        return {
          ok: true,
          skipped: true,
          reason: 'superseded_manual_order_sync',
          supersededBy,
        };
      }

      const lane = syncJobLaneFor(name);
      const blockedBy = getSyncJobLaneBlocker(activeJobsByLane, name);
      if (blockedBy) {
        console.log(
          `[job-queue] ${name} skipped because ${blockedBy} is already running in ${lane} lane`
        );
        await recordWorkerJobSkipped(name, `${blockedBy} already running in ${lane} lane`);
        const deferredJobId = await deferBusySyncJob(name, blockedBy, lane, busyDeferCount(job?.data));
        return {
          ok: true,
          skipped: true,
          deferred: Boolean(deferredJobId),
          deferredJobId,
          blockedBy,
          lane,
        };
      }

      const laneLock = await withSyncLaneAdvisoryLock(lane, async () => {
        activeJobsByLane.set(lane, name);
        const startedAt = Date.now();
        console.log(`[job-queue] started ${name} (${job?.id ?? 'unknown'})`);
        await recordWorkerJobStart(name);
        try {
          // PS-265: deadline-bounded so a hung handler rejects here -> catch records
          // the failure -> finally ALWAYS clears the active lane (deadlock -> self-heal).
          const result = await withDeadline(
            () => handler(job?.data),
            JOB_HANDLER_TIMEOUT_MS,
            name,
          );
          const durationMs = Date.now() - startedAt;
          console.log(`[job-queue] completed ${name} in ${durationMs}ms`);
          await recordWorkerJobSuccess(name, startedAt, result);
          return { ok: true, durationMs };
        } catch (err) {
          const durationMs = Date.now() - startedAt;
          console.error(
            `[job-queue] failed ${name} after ${durationMs}ms:`,
            err instanceof Error ? err.message : err
          );
          await recordWorkerJobFailure(name, startedAt, err);
          throw err;
        } finally {
          if (activeJobsByLane.get(lane) === name) activeJobsByLane.delete(lane);
        }
      });

      if (!laneLock.acquired) {
        const blockedBy = `cross-process ${lane} lane lock`;
        console.log(`[job-queue] ${name} skipped because ${blockedBy} is held`);
        await recordWorkerJobSkipped(name, `${blockedBy} held`);
        const deferredJobId = await deferBusySyncJob(name, blockedBy, lane, busyDeferCount(job?.data));
        return {
          ok: true,
          skipped: true,
          deferred: Boolean(deferredJobId),
          deferredJobId,
          blockedBy,
          lane,
          reason: 'lane_lock_held',
        };
      }

      return laneLock.result;
    }
  );
}

async function createQueues(): Promise<void> {
  if (!boss) return;
  for (const name of Object.values(JOBS)) {
    await boss.createQueue(name, {
      name,
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
      // PS-272: explicit per-queue expiration so pg-boss's OWN expire() reaps stale 'active' rows on
      // this queue (the queue row is the authority pg-boss reads during maintenance). expireInSeconds
      // is the canonical unit on PgBoss.Queue (ExpirationOptions); 30 min === the constructor value.
      expireInSeconds: 30 * 60,
      retentionDays: 7,
    });
  }
}

export async function startQueuedSyncScheduler(): Promise<void> {
  if (started) {
    console.warn('[job-queue] already started, ignoring duplicate start');
    return;
  }
  started = true;

  boss = new PgBoss({
    connectionString: env.DATABASE_URL,
    schema: env.PG_BOSS_SCHEMA,
    application_name: 'prepship-worker',
    max: env.PG_BOSS_POOL_MAX,
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 30 * 60,
    retentionDays: 7,
    deleteAfterDays: 7,
    monitorStateIntervalSeconds: 60,
    // PS-272 (canonical source-of-truth fix): make pg-boss self-heal stale 'active' rows.
    // pg-boss only runs its built-in expire()/archive() maintenance loop when supervise is on; the
    // loop fires every maintenanceIntervalSeconds and is what actually transitions orphaned 'active'
    // rows (a worker that died mid-job during a Render redeploy) past their expireInSeconds deadline.
    // Without supervise the deadline above is inert and only the custom reaper clears orphans. With it
    // ON, pg-boss reaps them itself on a 60s cadence; the SYNC_STUCK_JOB_REAPER stays as a backstop.
    supervise: true,
    maintenanceIntervalSeconds: 60,
  });

  boss.on('error', (err) => {
    console.error('[job-queue] pg-boss error:', err.message);
  });

  await boss.start();
  await setWorkerMode('worker-scheduler');
  await createQueues();

  // Per user override unlock shipped data on 2026-07-02: pg-boss owns
  // queue locking, deadlines, and worker-status writes. Call the canonical
  // ShipStation sync services directly so queued mode does not also take the
  // legacy interval-scheduler advisory lock and starve worker heartbeats.
  await registerWorker(JOBS.orders, async (jobData) => {
    const result = await syncOrders(orderSyncOptionsFromJobPayload(jobData));
    if (result.synced > 0 && isRateBackfillSchedulerEnabled()) {
      runBackfillTick();
    }
    return result;
  });
  await registerWorker(JOBS.shipments, () => syncShipments({}));
  await registerWorker(JOBS.inventoryImport, runInventoryImportFromOrders);
  await registerWorker(JOBS.syncProducts, runSyncProductsTick);
  await registerWorker(JOBS.fulfillmentOutbox, runFulfillmentOutboxTick);
  await registerWorker(JOBS.reportingRefresh, runReportingRefreshTick);
  // Per user override unlock shipped data on 2026-07-02: queued mode already
  // owns the external-shipped lane via pg-boss + advisory locks. Call the
  // bounded classifier job directly so a stale legacy interval-scheduler lock
  // cannot make the queued worker wait until the outer 10-minute deadline.
  await registerWorker(JOBS.externalShippedClassifier, runExternalShippedClassifierJob);
  await registerWorker(JOBS.shipmentTracking, runShipmentTrackingTick);
  await registerWorker(JOBS.walmartFees, runWalmartFeesTick);
  await registerWorker(JOBS.rateBackfill, async () => runBackfillTick());

  heartbeatTimer = setInterval(() => {
    void recordWorkerHeartbeat();
  }, 30_000);

  // PS-272: default-OFF stuck-active reaper. When SYNC_STUCK_JOB_REAPER is OFF this is a true no-op
  // (no DB, no mutation). One boot pass + a 10-min cadence flips orphaned pgboss 'active' rows (from
  // a worker that died mid-job during a Render redeploy) to 'failed' so the heavy syncs can drain
  // their 'created' backlog. The interval is pushed into timers[] so stopQueuedSyncScheduler clears it.
  void reapStuckActiveJobs().then(
    (r) => r.reaped && console.log(`[job-queue] stuck-active reaper cleared ${r.reaped} orphan(s): ${r.names.join(', ')}`)
  );
  void reapStaleQueuedCadenceJobs().then(
    (r) => r.reaped && console.log(`[job-queue] stale-cadence reaper cleared ${r.reaped} queued tick(s): ${r.names.join(', ')}`)
  );
  timers.push(setInterval(() => void reapStuckActiveJobs(), 10 * 60_000));
  timers.push(setInterval(() => void reapStaleQueuedCadenceJobs(), 10 * 60_000));

  console.log('[job-queue] pg-boss scheduler started');
  console.log(
    `[job-queue] orders every ${ORDER_SYNC_INTERVAL_MS / 1000}s, shipments every ${SHIPMENT_SYNC_INTERVAL_MS / 1000}s`
  );

  scheduleEnqueue(JOBS.fulfillmentOutbox, STARTUP_DELAY_MS + 30_000, FULFILLMENT_OUTBOX_INTERVAL_MS);
  scheduleEnqueue(
    JOBS.reportingRefresh,
    STARTUP_DELAY_MS + 4 * 60 * 1000,
    REPORTING_REFRESH_INTERVAL_MS
  );

  if (env.ENABLE_EXTERNAL_SHIPPED_CLASSIFIER_SCHEDULER) {
    scheduleEnqueue(
      JOBS.externalShippedClassifier,
      STARTUP_DELAY_MS + 6 * 60 * 1000,
      EXTERNAL_SHIPPED_CLASSIFIER_INTERVAL_MS
    );
  } else {
    console.log(
      '[job-queue] external-shipped classifier disabled; set ENABLE_EXTERNAL_SHIPPED_CLASSIFIER_SCHEDULER=true to automate PS-056 dry-run/apply'
    );
  }

  if (env.ENABLE_SHIPMENT_TRACKING_SCHEDULER && env.SHIPSTATION_API_KEY_V2) {
    scheduleEnqueue(
      JOBS.shipmentTracking,
      STARTUP_DELAY_MS + 7 * 60 * 1000,
      SHIPMENT_TRACKING_INTERVAL_MS
    );
  } else {
    console.log(
      '[job-queue] shipment tracking poll disabled; set ENABLE_SHIPMENT_TRACKING_SCHEDULER=true (+ SHIPSTATION_API_KEY_V2) to poll delivery status for queued labels'
    );
  }

  // PS-200 S3: daily Walmart selling-fee sync (legacy Vercel cron replacement).
  if (env.ENABLE_WALMART_FEES_SCHEDULER) {
    scheduleEnqueue(
      JOBS.walmartFees,
      STARTUP_DELAY_MS + 9 * 60 * 1000,
      WALMART_FEES_INTERVAL_MS
    );
  } else {
    console.log(
      '[job-queue] walmart fees sync disabled via ENABLE_WALMART_FEES_SCHEDULER=false'
    );
  }

  if (!env.SHIPSTATION_API_KEY || !env.SHIPSTATION_API_SECRET) {
    console.log(
      '[job-queue] SHIPSTATION_API_KEY/SECRET not set - ShipStation sync jobs disabled'
    );
    await recordWorkerJobSkipped(
      JOBS.orders,
      'SHIPSTATION_API_KEY/SECRET not set; order sync disabled'
    );
    await recordWorkerJobSkipped(
      JOBS.shipments,
      'SHIPSTATION_API_KEY/SECRET not set; shipment sync disabled'
    );
    return;
  }

  scheduleEnqueue(JOBS.orders, STARTUP_DELAY_MS, ORDER_SYNC_INTERVAL_MS);
  scheduleEnqueue(JOBS.shipments, STARTUP_DELAY_MS + 90_000, SHIPMENT_SYNC_INTERVAL_MS);
  scheduleEnqueue(
    JOBS.inventoryImport,
    STARTUP_DELAY_MS + 2 * 60 * 1000,
    INVENTORY_IMPORT_FROM_ORDERS_INTERVAL_MS
  );
  scheduleEnqueue(
    JOBS.syncProducts,
    STARTUP_DELAY_MS + 5 * 60 * 1000,
    INVENTORY_SYNC_PRODUCTS_INTERVAL_MS
  );

  if (isRateBackfillSchedulerEnabled()) {
    scheduleEnqueue(
      JOBS.rateBackfill,
      STARTUP_DELAY_MS + 3 * 60 * 1000,
      RATE_BACKFILL_INTERVAL_MS
    );
  } else {
    console.log(
      '[job-queue] rate backfill disabled; run /rates/backfill-best manually or set ENABLE_RATE_BACKFILL_SCHEDULER=true'
    );
  }
}

export async function stopQueuedSyncScheduler(): Promise<void> {
  for (const timer of timers.splice(0)) clearInterval(timer);
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (boss) {
    await boss.stop({ graceful: true, timeout: 30_000 });
    boss = null;
  }
  activeJobsByLane.clear();
  started = false;
  await setWorkerMode('disabled');
  console.log('[job-queue] stopped');
}

export async function getSyncJobQueueStatus(): Promise<{
  enabled: boolean;
  started: boolean;
  schema: string;
  queues: Array<{ name: string; size: number | null }>;
  activeLanes: Array<{ lane: SyncJobLane; jobName: string }>;
}> {
  if (!boss || !started) {
    return {
      enabled: env.USE_PG_BOSS_SCHEDULER,
      started: false,
      schema: env.PG_BOSS_SCHEMA,
      queues: Object.values(JOBS).map((name) => ({ name, size: null })),
      activeLanes: [],
    };
  }

  const queues = await Promise.all(
    Object.values(JOBS).map(async (name) => {
      try {
        return { name, size: await boss!.getQueueSize(name) };
      } catch {
        return { name, size: null };
      }
    })
  );

  return {
    enabled: env.USE_PG_BOSS_SCHEDULER,
    started,
    schema: env.PG_BOSS_SCHEMA,
    queues,
    activeLanes: Array.from(activeJobsByLane, ([lane, jobName]) => ({ lane, jobName })),
  };
}
