// Per user override unlock shipped data on 2026-06-17 (PS-272): queue-maintenance reaper; clears stale pgboss active rows only, never shipped/cancelled order/shipment data.
import { randomUUID } from 'node:crypto';
import PgBoss from 'pg-boss';
import { sql as pg } from '../db/client';
import { env } from '../lib/env';
import { withDeadline } from '../lib/with-deadline';
import { reapStaleQueuedCadenceJobs, reapStuckActiveJobs } from './sync-stuck-job-reaper';
import { jobSingletonSeconds } from '../lib/job-singleton-seconds';
import {
  getSyncJobLaneBlocker,
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
  runRateCacheEvictionTick,
  runReapStaleRateJobsTick,
  runShopifyOrderSyncTick,
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
  buildManualShipmentSyncJobPayload,
  shipmentSyncOptionsFromJobPayload,
  type ManualShipmentSyncRequest,
} from './manual-shipment-sync-job';
import {
  recordWorkerHeartbeat,
  recordWorkerJobFailure,
  recordWorkerJobSkipped,
  recordWorkerJobStart,
  recordWorkerJobSuccess,
  setWorkerMode,
} from './worker-status';
import { SYNC_CADENCE_MS } from '../lib/sync-cadence';
import { SYNC_JOB_HANDLER_TIMEOUT_MS } from '../lib/sync-job-deadline';
import {
  markShipStationSyncRunFailed,
  type ShipStationSyncRunIdentity,
} from './shipstation-sync-account-state';
import { runShipStationCarrierAccountSnapshotTick } from './shipstation-carrier-account-snapshot-worker';
import {
  resolveSyncJobAdmission,
  SHIPSTATION_SYNC_JOBS,
  syncQueuePolicyForJob,
} from './sync-job-admission';

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
const JOBS = {
  orders: SHIPSTATION_SYNC_JOBS.orders,
  shopifyOrders: 'prepship.sync.shopify-orders',
  shipments: SHIPSTATION_SYNC_JOBS.shipments,
  rateBackfill: 'prepship.sync.rate-backfill',
  inventoryImport: 'prepship.sync.inventory-import',
  syncProducts: 'prepship.sync.products',
  fulfillmentOutbox: 'prepship.sync.fulfillment-outbox',
  reportingRefresh: 'prepship.reporting.refresh',
  externalShippedClassifier: 'prepship.shipping.external-shipped-classifier',
  shipmentTracking: 'prepship.tracking.poll',
  walmartFees: 'prepship.fees.walmart-sync',
  rateMaintenance: 'prepship.maintenance.rate-cache',
  queueMaintenance: 'prepship.maintenance.job-queue',
  carrierAccountSnapshots: 'prepship.maintenance.carrier-account-snapshots',
} as const;

type JobName = (typeof JOBS)[keyof typeof JOBS];

type PgBossJobLike = {
  id?: unknown;
  data?: unknown;
  singletonKey?: unknown;
  createdOn?: unknown;
};

type SyncJobHandlerContext = {
  identity: ShipStationSyncRunIdentity;
  signal: AbortSignal;
};

let boss: PgBoss | null = null;
let started = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
const activeJobsByLane = new Map<SyncJobLane, JobName>();
const BUSY_DEFER_SECONDS = 60;
const ORDER_STARVATION_DEFER_THRESHOLD = 3;
const ORDER_STARVATION_DEFER_SECONDS = 10;
const BUSY_DEFER_JOB_NAMES = new Set<JobName>([JOBS.orders, JOBS.shipments]);

function queueOptionsFor(name: JobName): PgBoss.Queue {
  return {
    name,
    policy: syncQueuePolicyForJob(name),
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 30 * 60,
    retentionDays: 7,
  };
}

async function ensureQueue(targetBoss: PgBoss, name: JobName): Promise<void> {
  const options = queueOptionsFor(name);
  await targetBoss.createQueue(name, options);
  if (options.policy !== 'stately') return;
  // Per user override unlock shipped data on 2026-07-14: createQueue is a
  // no-op for existing pg-boss queues, so updateQueue is required to move the
  // two ShipStation queues to the canonical stately coalescing policy.
  await targetBoss.updateQueue(name, options);
}

const SCHEDULE_CRON = {
  everyMinute: '* * * * *',
  everyThreeMinutes: '*/3 * * * *',
  everyFiveMinutes: '*/5 * * * *',
  everyTenMinutes: '*/10 * * * *',
  everyFifteenMinutes: '*/15 * * * *',
  everyThirtyMinutes: '*/30 * * * *',
  hourly: '0 * * * *',
  dailyAtNineUtc: '0 9 * * *',
} as const;

export type ManualOrderSyncEnqueueResult = {
  queued: boolean;
  jobId: string | null;
  queueStarted: boolean;
  jobName: typeof JOBS.orders;
  mode: 'incremental' | 'full';
  requestedAt: string;
  error: string | null;
};

export type ManualShipmentSyncEnqueueResult = {
  queued: boolean;
  jobId: string | null;
  queueStarted: boolean;
  jobName: typeof JOBS.shipments;
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

function isDeferredShipStationOrderSync(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const source = data as { deferredLane?: unknown; deferCount?: unknown };
  return source.deferredLane === 'shipstation-sync' && Number(source.deferCount) > 0;
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
    const createdOnIso = createdOn.toISOString();
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
        AND created_on > ${createdOnIso}::timestamptz
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
    const admission = resolveSyncJobAdmission(JOBS.shipments, {
      kind: 'watchdog-shipment',
    });
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
        singletonKey: admission.singletonKey,
        singletonSeconds: 60,
        priority: admission.priority,
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
    const admission = resolveSyncJobAdmission(JOBS.orders, {
      kind: 'manual-order',
      mode: payload.mode,
    });
    // Per user override unlock shipped data on 2026-07-02: this only
    // enqueues the existing backend order-sync worker lane. The request no
    // longer runs ShipStation import inline, buys labels, prints postage, or
    // mutates marketplace notifications.
    const id = await targetBoss.send(
      JOBS.orders,
      payload,
      {
        singletonKey: admission.singletonKey,
        singletonSeconds: 60,
        priority: admission.priority,
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
    await ensureQueue(transientBoss, JOBS.orders);
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

async function sendManualShipmentSyncJob(
  targetBoss: PgBoss,
  queueStarted: boolean,
  request: ManualShipmentSyncRequest,
): Promise<ManualShipmentSyncEnqueueResult> {
  const payload = buildManualShipmentSyncJobPayload(request);
  try {
    const admission = resolveSyncJobAdmission(JOBS.shipments, {
      kind: 'manual-shipment',
    });
    const id = await targetBoss.send(
      JOBS.shipments,
      payload,
      {
        singletonKey: admission.singletonKey,
        singletonSeconds: 60,
        priority: admission.priority,
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
      jobName: JOBS.shipments,
      requestedAt: payload.requestedAt,
      error: null,
    };
  } catch (err) {
    return {
      queued: false,
      jobId: null,
      queueStarted,
      jobName: JOBS.shipments,
      requestedAt: payload.requestedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function enqueueManualShipmentSyncJob(
  request: ManualShipmentSyncRequest = {},
): Promise<ManualShipmentSyncEnqueueResult> {
  const payload = buildManualShipmentSyncJobPayload(request);
  if (boss && started) return sendManualShipmentSyncJob(boss, true, request);

  const transientBoss = new PgBoss({
    connectionString: env.DATABASE_URL,
    schema: env.PG_BOSS_SCHEMA,
    application_name: 'prepship-api-manual-shipment-sync',
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
    await ensureQueue(transientBoss, JOBS.shipments);
    return await sendManualShipmentSyncJob(transientBoss, false, request);
  } catch (err) {
    return {
      queued: false,
      jobId: null,
      queueStarted: false,
      jobName: JOBS.shipments,
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
    await ensureQueue(transientBoss, JOBS.shipments);
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
    const admission = resolveSyncJobAdmission(name, {
      kind: 'busy-defer',
      orderStarvation,
    });
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
        singletonKey: admission.singletonKey,
        singletonSeconds: delaySeconds,
        retryLimit: 2,
        retryDelay: 30,
        retryBackoff: true,
        expireInMinutes: 30,
        retentionDays: 7,
        priority: admission.priority,
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

async function reconcileDurableSchedule(
  name: JobName,
  cron: string,
  intervalMs: number,
  enabled: boolean,
): Promise<void> {
  if (!boss) return;
  if (!enabled) {
    await boss.unschedule(name);
    console.log(`[job-queue] durable schedule disabled: ${name}`);
    return;
  }

  const admission = resolveSyncJobAdmission(name, { kind: 'cadence' });

  // Per user override unlock shipped data on 2026-07-14: pg-boss persists
  // cadence in Postgres. The canonical admission owner gives equivalent
  // cadence/manual/defer wake-ups one key on stately ShipStation queues.
  // This schedules work only; shipped/cancelled protections remain in handlers.
  await boss.schedule(
    name,
    cron,
    { requestedBy: 'pg-boss-cron' },
    {
      tz: 'UTC',
      singletonKey: admission.singletonKey,
      singletonSeconds: jobSingletonSeconds(intervalMs),
      priority: admission.priority,
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
      expireInMinutes: 30,
      retentionDays: 7,
    },
  );
  console.log(`[job-queue] durable schedule ${name}: ${cron} UTC`);
}

async function reconcileDurableSchedules(): Promise<void> {
  const hasShipStationCredentials = Boolean(
    env.SHIPSTATION_API_KEY && env.SHIPSTATION_API_SECRET,
  );

  await reconcileDurableSchedule(
    JOBS.fulfillmentOutbox,
    SCHEDULE_CRON.everyMinute,
    FULFILLMENT_OUTBOX_INTERVAL_MS,
    true,
  );
  await reconcileDurableSchedule(
    JOBS.reportingRefresh,
    SCHEDULE_CRON.everyThirtyMinutes,
    REPORTING_REFRESH_INTERVAL_MS,
    true,
  );
  await reconcileDurableSchedule(
    JOBS.rateMaintenance,
    SCHEDULE_CRON.everyFiveMinutes,
    5 * 60_000,
    true,
  );
  await reconcileDurableSchedule(
    JOBS.queueMaintenance,
    SCHEDULE_CRON.everyTenMinutes,
    10 * 60_000,
    true,
  );
  await reconcileDurableSchedule(
    JOBS.carrierAccountSnapshots,
    SCHEDULE_CRON.everyMinute,
    60_000,
    true,
  );
  await reconcileDurableSchedule(
    JOBS.shopifyOrders,
    SCHEDULE_CRON.everyThreeMinutes,
    ORDER_SYNC_INTERVAL_MS,
    env.SHOPIFY_SYNC_ENABLED,
  );
  await reconcileDurableSchedule(
    JOBS.externalShippedClassifier,
    SCHEDULE_CRON.everyThreeMinutes,
    EXTERNAL_SHIPPED_CLASSIFIER_INTERVAL_MS,
    env.ENABLE_EXTERNAL_SHIPPED_CLASSIFIER_SCHEDULER,
  );
  await reconcileDurableSchedule(
    JOBS.shipmentTracking,
    SCHEDULE_CRON.everyFifteenMinutes,
    SHIPMENT_TRACKING_INTERVAL_MS,
    env.ENABLE_SHIPMENT_TRACKING_SCHEDULER && Boolean(env.SHIPSTATION_API_KEY_V2),
  );
  await reconcileDurableSchedule(
    JOBS.walmartFees,
    SCHEDULE_CRON.dailyAtNineUtc,
    WALMART_FEES_INTERVAL_MS,
    env.ENABLE_WALMART_FEES_SCHEDULER,
  );
  await reconcileDurableSchedule(
    JOBS.orders,
    SCHEDULE_CRON.everyThreeMinutes,
    ORDER_SYNC_INTERVAL_MS,
    hasShipStationCredentials,
  );
  await reconcileDurableSchedule(
    JOBS.shipments,
    SCHEDULE_CRON.everyThreeMinutes,
    SHIPMENT_SYNC_INTERVAL_MS,
    hasShipStationCredentials,
  );
  await reconcileDurableSchedule(
    JOBS.inventoryImport,
    SCHEDULE_CRON.everyThirtyMinutes,
    INVENTORY_IMPORT_FROM_ORDERS_INTERVAL_MS,
    hasShipStationCredentials,
  );
  await reconcileDurableSchedule(
    JOBS.syncProducts,
    SCHEDULE_CRON.hourly,
    INVENTORY_SYNC_PRODUCTS_INTERVAL_MS,
    hasShipStationCredentials,
  );
  await reconcileDurableSchedule(
    JOBS.rateBackfill,
    SCHEDULE_CRON.everyTenMinutes,
    RATE_BACKFILL_INTERVAL_MS,
    hasShipStationCredentials && isRateBackfillSchedulerEnabled(),
  );
}

function busyDeferCount(jobData: unknown): number {
  if (!jobData || typeof jobData !== 'object') return 0;
  const count = Number((jobData as { deferCount?: unknown }).deferCount);
  return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
}

// Handler deadline is below pg-boss's 30-minute expiry. Timed-out order work
// also receives an AbortSignal so stale attempts stop before later persistence.
async function registerWorker(
  name: JobName,
  handler: (jobData: unknown, context: SyncJobHandlerContext) => Promise<unknown> | unknown
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
        const identity: ShipStationSyncRunIdentity = {
          queueJobId: String(job?.id ?? `${name}:${startedAt}`),
          attemptId: randomUUID(),
        };
        const abortController = new AbortController();
        console.log(`[job-queue] started ${name} (${job?.id ?? 'unknown'})`);
        try {
          await recordWorkerJobStart(name);
        } catch (err) {
          if (activeJobsByLane.get(lane) === name) activeJobsByLane.delete(lane);
          throw err;
        }

        // Per user override unlock shipped data on 2026-07-14: a deadline
        // rejects the queue attempt, but lane ownership follows the original
        // handler promise. A retry cannot overlap abandoned shipment/order work.
        const handlerPromise = Promise.resolve().then(() =>
          handler(job?.data, { identity, signal: abortController.signal }),
        );
        const clearActiveLane = () => {
          if (activeJobsByLane.get(lane) === name) activeJobsByLane.delete(lane);
        };
        void handlerPromise.then(clearActiveLane, clearActiveLane);

        try {
          // PS-265: the queue attempt remains deadline-bounded. Cooperative
          // cancellation stops the work; lane ownership prevents zombie overlap
          // until the original promise actually settles.
          const result = await withDeadline(
            () => handlerPromise,
            SYNC_JOB_HANDLER_TIMEOUT_MS,
            name,
            { onTimeout: (error) => abortController.abort(error) },
          );
          const durationMs = Date.now() - startedAt;
          console.log(`[job-queue] completed ${name} in ${durationMs}ms`);
          await recordWorkerJobSuccess(name, startedAt, result);
          return { ok: true, durationMs };
        } catch (err) {
          const durationMs = Date.now() - startedAt;
          if (name === JOBS.orders) {
            // Per user override unlock shipped data on 2026-07-10: timeout
            // closes matching sync metadata only; no order/shipment row mutation.
            await markShipStationSyncRunFailed(identity, Date.now(), err).catch((closeoutError) => {
              console.warn(
                '[job-queue] order sync account closeout failed:',
                closeoutError instanceof Error ? closeoutError.message : closeoutError,
              );
            });
          }
          console.error(
            `[job-queue] failed ${name} after ${durationMs}ms:`,
            err instanceof Error ? err.message : err
          );
          await recordWorkerJobFailure(name, startedAt, err);
          throw err;
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
    await ensureQueue(boss, name);
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
  await registerWorker(JOBS.orders, async (jobData, { identity, signal }) => {
    const options = orderSyncOptionsFromJobPayload(jobData);
    if (isDeferredShipStationOrderSync(jobData)) {
      // Per user override unlock shipped data on 2026-05-23, reconfirmed on
      // 2026-07-07: a busy-defer row is just a retry wake-up after the
      // ShipStation lane was blocked. Keep it to awaiting freshness so deferred
      // wake-ups cannot become another long status catch-up that starves labels.
      options.skipStatusPasses = true;
    }
    const result = await syncOrders({ ...options, runIdentity: identity, signal });
    if (result.synced > 0 && isRateBackfillSchedulerEnabled()) {
      runBackfillTick();
    }
    return result;
  });
  // Audit SY-3 (2026-07-13): thread the deadline signal into the shipments and
  // Shopify handlers too (orders already had it) — withDeadline races and
  // ABANDONS the work, so without checkpoints an abandoned walk kept writing
  // (pages, enrichment, cursors) after its lane lock was released and the
  // pg-boss retry started a second writer. The label_shipment_id UNIQUE index
  // is the DB backstop; this stops the zombie at the source.
  await registerWorker(JOBS.shopifyOrders, (_jobData, { signal }) =>
    runShopifyOrderSyncTick(signal),
  );
  await registerWorker(JOBS.shipments, (jobData, { signal }) =>
    syncShipments({ ...shipmentSyncOptionsFromJobPayload(jobData), signal }),
  );
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
  await registerWorker(JOBS.rateMaintenance, async () => {
    await runReapStaleRateJobsTick();
    await runRateCacheEvictionTick();
  });
  await registerWorker(JOBS.queueMaintenance, async () => {
    const active = await reapStuckActiveJobs();
    const queued = await reapStaleQueuedCadenceJobs();
    return { active, queued };
  });
  await registerWorker(
    JOBS.carrierAccountSnapshots,
    runShipStationCarrierAccountSnapshotTick,
  );

  heartbeatTimer = setInterval(() => {
    void recordWorkerHeartbeat();
  }, 30_000);

  const activeReap = await reapStuckActiveJobs();
  const queuedReap = await reapStaleQueuedCadenceJobs();
  if (activeReap.reaped > 0) {
    console.log(`[job-queue] stuck-active reaper cleared ${activeReap.reaped} orphan(s): ${activeReap.names.join(', ')}`);
  }
  if (queuedReap.reaped > 0) {
    console.log(`[job-queue] stale-cadence reaper cleared ${queuedReap.reaped} queued tick(s): ${queuedReap.names.join(', ')}`);
  }

  await reconcileDurableSchedules();
  console.log('[job-queue] pg-boss scheduler started with durable Postgres cadence');
}

export async function stopQueuedSyncScheduler(): Promise<void> {
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
      enabled: true,
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
    enabled: true,
    started,
    schema: env.PG_BOSS_SCHEMA,
    queues,
    activeLanes: Array.from(activeJobsByLane, ([lane, jobName]) => ({ lane, jobName })),
  };
}
