import PgBoss from 'pg-boss';
import { env } from '../lib/env';
import {
  runBackfillTick,
  runFulfillmentOutboxTick,
  runExternalShippedClassifierTick,
  runInventoryImportFromOrders,
  runOrderSync,
  runReportingRefreshTick,
  runShipmentSync,
  runSyncProductsTick,
} from './sync-scheduler';
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
} as const;

type JobName = (typeof JOBS)[keyof typeof JOBS];

type Timer = ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>;

let boss: PgBoss | null = null;
let started = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let activeJobName: JobName | null = null;
const timers: Timer[] = [];

function isRateBackfillSchedulerEnabled(): boolean {
  return env.ENABLE_RATE_BACKFILL_SCHEDULER && !env.DISABLE_RATE_BACKFILL_SCHEDULER;
}

function jobSingletonSeconds(intervalMs: number): number {
  return Math.max(30, Math.floor(intervalMs / 1000) - 5);
}

async function enqueueJob(name: JobName, intervalMs: number): Promise<void> {
  if (!boss) return;
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

async function registerWorker(
  name: JobName,
  handler: () => Promise<void> | void
): Promise<void> {
  if (!boss) return;
  await boss.work(
    name,
    { batchSize: 1, pollingIntervalSeconds: 5 },
    async ([job]) => {
      if (activeJobName) {
        console.log(
          `[job-queue] ${name} skipped because ${activeJobName} is already running`
        );
        await recordWorkerJobSkipped(name, `${activeJobName} already running`);
        return { ok: true, skipped: true, activeJobName };
      }

      activeJobName = name;
      const startedAt = Date.now();
      console.log(`[job-queue] started ${name} (${job?.id ?? 'unknown'})`);
      await recordWorkerJobStart(name);
      try {
        const result = await handler();
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
        activeJobName = null;
      }
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
      expireInMinutes: 30,
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
    expireInMinutes: 30,
    retentionDays: 7,
    deleteAfterDays: 7,
    monitorStateIntervalSeconds: 60,
  });

  boss.on('error', (err) => {
    console.error('[job-queue] pg-boss error:', err.message);
  });

  await boss.start();
  await setWorkerMode('worker-scheduler');
  await createQueues();

  await registerWorker(JOBS.orders, runOrderSync);
  await registerWorker(JOBS.shipments, runShipmentSync);
  await registerWorker(JOBS.inventoryImport, runInventoryImportFromOrders);
  await registerWorker(JOBS.syncProducts, runSyncProductsTick);
  await registerWorker(JOBS.fulfillmentOutbox, runFulfillmentOutboxTick);
  await registerWorker(JOBS.reportingRefresh, runReportingRefreshTick);
  await registerWorker(JOBS.externalShippedClassifier, runExternalShippedClassifierTick);
  await registerWorker(JOBS.rateBackfill, async () => runBackfillTick());

  heartbeatTimer = setInterval(() => {
    void recordWorkerHeartbeat();
  }, 30_000);

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
  activeJobName = null;
  started = false;
  await setWorkerMode('disabled');
  console.log('[job-queue] stopped');
}

export async function getSyncJobQueueStatus(): Promise<{
  enabled: boolean;
  started: boolean;
  schema: string;
  queues: Array<{ name: string; size: number | null }>;
}> {
  if (!boss || !started) {
    return {
      enabled: env.USE_PG_BOSS_SCHEDULER,
      started: false,
      schema: env.PG_BOSS_SCHEMA,
      queues: Object.values(JOBS).map((name) => ({ name, size: null })),
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
  };
}
