// Per user override unlock shipped data on 2026-06-17 (PS-272): queue-maintenance reaper; clears stale pgboss active rows only, never shipped/cancelled order/shipment data.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import PgBoss from 'pg-boss';
import postgres from 'postgres';
import { sql as pg } from '../db/client';
import { env } from '../lib/env';
import { withPgBossPoolLifetime } from '../lib/pg-boss-pool-lifetime';
import { DeadlineExceededError, withDeadline } from '../lib/with-deadline';
import {
  requireCancellationAcknowledgement,
  terminateWorkerForUnacknowledgedCancellation,
} from '../lib/sync-job-cancellation';
import { reapStaleQueuedCadenceJobs, reapStuckActiveJobs } from './sync-stuck-job-reaper';
import { jobSingletonSeconds } from '../lib/job-singleton-seconds';
import { OrderSyncCooperativeYieldError } from '../lib/order-sync-cooperative-yield';
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
  buildOrderSyncWatchdogJobPayload,
  buildManualOrderSyncJobPayload,
  orderSyncOptionsFromJobPayload,
  type ManualOrderSyncJobPayload,
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
import { classifyWorkerResolvedResult } from './worker-result-classification';
import { SYNC_CADENCE_MS } from '../lib/sync-cadence';
import {
  SYNC_JOB_CANCELLATION_GRACE_MS,
  SYNC_JOB_HANDLER_TIMEOUT_MS,
} from '../lib/sync-job-deadline';
import {
  markShipStationSyncRunFailed,
  type ShipStationSyncRunIdentity,
} from './shipstation-sync-account-state';
import { runShipStationCarrierAccountSnapshotTick } from './shipstation-carrier-account-snapshot-worker';
import { isSupabaseTransactionPoolerUrl } from './print-queue-worker-policy';
import {
  FULFILLMENT_OUTBOX_JOB_NAME,
  rateBackfillOperationalBlocker,
  resolveSyncJobAdmission,
  runnableOperationalSyncQueueSizes,
  SHIPSTATION_SYNC_JOBS,
  shipmentSyncRequestHasRecoveryPriority,
  shouldYieldOrderSyncToFulfillmentOutbox,
  shouldYieldOrderSyncToShipmentRecovery,
  shouldYieldShipmentSyncToOrders,
  SYNC_STARVATION_DEFER_THRESHOLD,
  syncQueuePolicyForJob,
  type OperationalSyncQueueRow,
  type SyncJobAdmissionIntent,
} from './sync-job-admission';
import { RATE_BACKFILL_JOB_NAME } from './rate-backfill-job-producer';
import {
  parseDurableRateBackfillJobPayload,
  rateBackfillPriority,
} from './rate-backfill-job-types';
import { runDurableRateBackfillJob } from './rates-backfill';
import { runLocalTariffCalibrationTick } from './local-tariff-calibration';
import {
  hasPendingOrderSyncWork,
  orderSyncQueueBlocker,
  readOrderSyncQueueTruth,
  type OrderSyncQueueState,
} from './order-sync-queue-state';

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
  rateBackfill: RATE_BACKFILL_JOB_NAME,
  inventoryImport: 'prepship.sync.inventory-import',
  syncProducts: 'prepship.sync.products',
  fulfillmentOutbox: FULFILLMENT_OUTBOX_JOB_NAME,
  reportingRefresh: 'prepship.reporting.refresh',
  externalShippedClassifier: 'prepship.shipping.external-shipped-classifier',
  shipmentTracking: 'prepship.tracking.poll',
  walmartFees: 'prepship.fees.walmart-sync',
  rateMaintenance: 'prepship.maintenance.rate-cache',
  queueMaintenance: 'prepship.maintenance.job-queue',
  carrierAccountSnapshots: 'prepship.maintenance.carrier-account-snapshots',
  localTariffCalibration: 'prepship.rates.local-tariff-calibration',
} as const;

export const SYNC_STATUS_JOB_NAMES = {
  shipstationOrders: JOBS.orders,
  shopifyOrders: JOBS.shopifyOrders,
  shipstationShipments: JOBS.shipments,
} as const;

export type SyncJobAttemptSnapshot = {
  name: string;
  state: string;
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  skipped: boolean;
  deferred: boolean;
  blockedBy: string | null;
  reason: string | null;
};

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
let shipStationConsumerLeadership: ShipStationConsumerLeadershipController | null = null;
const activeJobsByLane = new Map<SyncJobLane, JobName>();
const BUSY_DEFER_SECONDS = 60;
const ORDER_STARVATION_DEFER_SECONDS = 10;
// Per user override unlock shipped data on 2026-07-23: queue wake-up control
// only. These entries never mutate orders, shipments, labels, or providers.
const BUSY_DEFER_JOB_NAMES = new Set<JobName>([
  JOBS.orders,
  JOBS.shipments,
  JOBS.inventoryImport,
  JOBS.syncProducts,
  JOBS.rateBackfill,
  JOBS.fulfillmentOutbox,
]);
const SHIPSTATION_CONSUMER_LEADER_LOCK = 'prepship.worker.shipstation-stately-consumers';
const SHIPSTATION_CONSUMER_LEADER_RETRY_MS = 5_000;
const SHIPSTATION_CONSUMER_LEADER_HEALTH_MS = 15_000;

/**
 * PS-485: how long this process may fail to ACQUIRE leadership before it treats the
 * lock as unreachable and asks the supervisor for a clean restart.
 *
 * The incident this bounds (2026-08-01): a deploy restarted the service, the outgoing
 * instance's leadership session left its advisory lock alive, and the incoming instance
 * called tryAcquire() every 5s for 29 MINUTES without ever acquiring it. Because the
 * three stately queues (orders, shipments, fulfillment-outbox) only get consumers once
 * leadership is held, all three had NO consumer for that entire window while every
 * non-gated queue kept running normally. Order sync froze at 03:02:04 and only moved
 * after DJ restarted the worker by hand.
 *
 * The remedy already exists for the sibling case: restartAfterLostConnection() calls
 * requestRestart() precisely because "a lost leadership session can leave its
 * server-side advisory lock alive". Losing the lock and never getting it have the SAME
 * cause and the SAME fix; only the first was wired up.
 *
 * Five minutes is deliberately well past a normal deploy handoff -- during one the
 * outgoing leader legitimately holds the lock while it drains, and restarting then
 * would be wrong. It is far short of the 29 minutes this actually cost.
 */
const SHIPSTATION_CONSUMER_LEADER_ACQUIRE_ESCALATE_MS = 5 * 60_000;
/** Log once well before escalating, so the silent stretch is at least visible. */
const SHIPSTATION_CONSUMER_LEADER_ACQUIRE_WARN_MS = 60_000;
const SHARED_LANE_PRIORITY_POLL_MS = 5_000;

export type ActiveShipStationSyncJob = {
  id: string;
  name: string;
};

export type ShipStationConsumerLeadershipConnection = {
  ping(): Promise<void>;
  tryAcquire(): Promise<boolean>;
  unlock(): Promise<void>;
  release(): void;
};

type ShipStationConsumerLeadershipDependencies = {
  reserveConnection(): Promise<ShipStationConsumerLeadershipConnection>;
  recoverActiveJobs(): Promise<void>;
  readActiveJobs(): Promise<ActiveShipStationSyncJob[]>;
  registerConsumers(): Promise<void>;
  unregisterConsumers(): Promise<void>;
  requestRestart(reason: string): void;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
  /** PS-485: injectable so the acquire-timeout escalation is testable without a clock. */
  now(): number;
  info(message: string): void;
  warn(message: string, error: unknown): void;
  error(message: string, error: unknown): void;
};

export type ShipStationConsumerLeadershipSnapshot = {
  started: boolean;
  stopping: boolean;
  ownsLock: boolean;
  consumersRegistered: boolean;
  scheduledDelayMs: number | null;
  /** PS-485: ms since acquisition first failed, null while leadership is held. */
  acquireFailingForMs: number | null;
};

/**
 * Per user override unlock shipped data on 2026-07-16: this controller changes
 * only queue-consumer leadership and never writes order or shipment data.
 *
 * Canonical lifecycle owner for the ShipStation stately-consumer leadership
 * session. Queue registration, handoff, connection loss, retry, and shutdown
 * all pass through this controller so they can be proven at one boundary.
 */
export class ShipStationConsumerLeadershipController {
  private connection: ShipStationConsumerLeadershipConnection | null = null;
  private timer: unknown = null;
  private scheduledDelayMs: number | null = null;
  private operation: Promise<void> = Promise.resolve();
  private started = false;
  private stopping = false;
  private consumersRegistered = false;
  private handoffLogged = false;
  /** PS-485: when this process first failed to acquire leadership, null once held. */
  private acquireFailingSinceMs: number | null = null;
  private acquireWarnLogged = false;

  constructor(
    private readonly dependencies: ShipStationConsumerLeadershipDependencies,
    private readonly retryMs = SHIPSTATION_CONSUMER_LEADER_RETRY_MS,
    private readonly healthMs = SHIPSTATION_CONSUMER_LEADER_HEALTH_MS,
  ) {}

  snapshot(): ShipStationConsumerLeadershipSnapshot {
    return {
      started: this.started,
      stopping: this.stopping,
      ownsLock: Boolean(this.connection),
      consumersRegistered: this.consumersRegistered,
      scheduledDelayMs: this.scheduledDelayMs,
      // PS-485: how long acquisition has been failing. This is the signal that was
      // entirely invisible during the 29-minute stall -- the process looked healthy
      // by every other measure while consuming nothing.
      acquireFailingForMs: this.acquireFailingSinceMs === null
        ? null
        : Math.max(0, this.dependencies.now() - this.acquireFailingSinceMs),
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    await this.enqueueMaintenance();
  }

  async runMaintenanceNow(): Promise<void> {
    if (!this.started || this.stopping) return;
    this.clearScheduledTimer();
    await this.enqueueMaintenance();
  }

  async notifyConnectionClosed(): Promise<void> {
    if (!this.started || this.stopping || !this.connection) return;
    await this.enqueue(async () => {
      if (!this.connection || this.stopping) return;
      this.dependencies.error(
        '[job-queue] ShipStation consumer leadership connection closed',
        new Error('leadership_session_closed'),
      );
      this.clearScheduledTimer();
      await this.restartAfterLostConnection('shipstation_consumer_leadership_closed');
    });
  }

  async stop(): Promise<void> {
    if (!this.started && !this.connection && !this.consumersRegistered) return;
    this.stopping = true;
    this.clearScheduledTimer();
    await this.operation.catch(() => undefined);
    try {
      await this.unregisterConsumers();
    } catch (error) {
      this.dependencies.warn(
        '[job-queue] ShipStation consumers could not unregister cleanly',
        error,
      );
    }
    await this.releaseLeadership();
    this.handoffLogged = false;
    this.started = false;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.operation.catch(() => undefined).then(task);
    this.operation = next;
    return next;
  }

  private enqueueMaintenance(): Promise<void> {
    return this.enqueue(() => this.maintain());
  }

  private clearScheduledTimer(): void {
    if (this.timer === null) return;
    this.dependencies.clearTimer(this.timer);
    this.timer = null;
    this.scheduledDelayMs = null;
  }

  private schedule(delayMs: number): void {
    if (this.stopping || !this.started || this.timer !== null) return;
    this.scheduledDelayMs = delayMs;
    this.timer = this.dependencies.setTimer(() => {
      this.timer = null;
      this.scheduledDelayMs = null;
      void this.enqueueMaintenance();
    }, delayMs);
  }

  /**
   * PS-485. Track how long acquisition has been failing, warn once, then escalate.
   *
   * Escalation is the same lever restartAfterLostConnection() already pulls: ask the
   * supervisor to restart so the OS closes every socket, which is what actually frees
   * a stale server-side advisory lock. A platform restart is free and uncapped, unlike
   * the watchdog's Render-API deploy path.
   */
  private noteAcquireFailure(): void {
    const nowMs = this.dependencies.now();
    if (this.acquireFailingSinceMs === null) {
      this.acquireFailingSinceMs = nowMs;
      return;
    }
    const failingMs = nowMs - this.acquireFailingSinceMs;
    if (!this.acquireWarnLogged && failingMs >= SHIPSTATION_CONSUMER_LEADER_ACQUIRE_WARN_MS) {
      this.acquireWarnLogged = true;
      this.dependencies.warn(
        `[job-queue] ShipStation consumer leadership not acquired for ${Math.round(failingMs / 1000)}s; `
        + 'the stately queues (orders, shipments, fulfillment-outbox) have NO consumer while this persists',
        null,
      );
    }
    if (failingMs >= SHIPSTATION_CONSUMER_LEADER_ACQUIRE_ESCALATE_MS) {
      // Reset so a restart that does not clear the lock re-arms rather than
      // escalating on every subsequent tick.
      this.acquireFailingSinceMs = nowMs;
      this.acquireWarnLogged = false;
      this.dependencies.error(
        '[job-queue] ShipStation consumer leadership unreachable; requesting supervisor restart',
        new Error('shipstation_consumer_leadership_acquire_timeout'),
      );
      this.dependencies.requestRestart('shipstation_consumer_leadership_acquire_timeout');
    }
  }

  private async unregisterConsumers(): Promise<void> {
    if (!this.consumersRegistered) return;
    try {
      await this.dependencies.unregisterConsumers();
    } finally {
      this.consumersRegistered = false;
    }
  }

  private async dropLostConnection(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    if (!connection) return;
    try {
      await this.unregisterConsumers();
    } finally {
      connection.release();
    }
  }

  private async restartAfterLostConnection(reason: string): Promise<void> {
    await this.dropLostConnection();
    // Per user override unlock shipped data on 2026-05-23: a lost
    // leadership session can leave its server-side advisory lock alive after
    // a network abort. Restart the worker so the OS closes every stale socket
    // and the durable queue can elect a clean consumer generation. This is
    // queue control-plane recovery only; it does not mutate orders,
    // shipments, labels, postage, or marketplace state.
    this.schedule(this.retryMs);
    this.dependencies.requestRestart(reason);
  }

  private async releaseLeadership(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    if (!connection) return;
    try {
      await connection.unlock();
    } catch (error) {
      this.dependencies.warn(
        '[job-queue] ShipStation consumer leadership release skipped',
        error,
      );
    } finally {
      connection.release();
    }
  }

  private async maintain(): Promise<void> {
    if (this.stopping || !this.started) return;

    try {
      if (this.connection) {
        try {
          await this.connection.ping();
        } catch (error) {
          this.dependencies.error(
            '[job-queue] ShipStation consumer leadership connection lost',
            error,
          );
          await this.restartAfterLostConnection('shipstation_consumer_leadership_ping_failed');
          return;
        }
      }

      if (!this.connection) {
        const reserved = await this.dependencies.reserveConnection();
        try {
          if (!(await reserved.tryAcquire())) {
            reserved.release();
            // PS-485: an unbounded silent retry here cost 29 minutes of dead sync.
            // Failing to acquire is normal DURING a deploy handoff and pathological
            // after one, and the two are only distinguishable by how long it lasts.
            this.noteAcquireFailure();
            this.schedule(this.retryMs);
            return;
          }
          this.acquireFailingSinceMs = null;
          this.acquireWarnLogged = false;
          this.connection = reserved;
        } catch (error) {
          reserved.release();
          throw error;
        }
      }

      if (!this.consumersRegistered) {
        // Per user override unlock shipped data on 2026-07-18: recover only
        // allow-listed orphaned pg-boss control rows before applying the active
        // deploy handoff fence. This handoff loop stays alive even when the
        // queue-maintenance consumer is itself orphaned.
        await this.dependencies.recoverActiveJobs();
        const activeJobs = await this.dependencies.readActiveJobs();
        if (activeJobs.length > 0) {
          if (!this.handoffLogged) {
            this.dependencies.info(
              `[job-queue] ShipStation consumers waiting for active deploy handoff: ${activeJobs.map((job) => `${job.name}:${job.id}`).join(', ')}`,
            );
            this.handoffLogged = true;
          }
          this.schedule(this.retryMs);
          return;
        }

        await this.dependencies.registerConsumers();
        this.consumersRegistered = true;
        this.handoffLogged = false;
        this.dependencies.info('[job-queue] ShipStation stately consumer leadership acquired');
      }

      this.schedule(this.healthMs);
    } catch (error) {
      this.dependencies.error(
        '[job-queue] ShipStation consumer leadership check failed',
        error,
      );
      this.schedule(this.retryMs);
    }
  }
}

export function resolveShipStationConsumerLeaderDatabaseUrl(input: {
  databaseUrl: string;
  dedicatedDatabaseUrl?: string;
}): string {
  const dedicated = input.dedicatedDatabaseUrl?.trim();
  const fallback = isSupabaseTransactionPoolerUrl(input.databaseUrl)
    ? input.databaseUrl.replace(':6543/', ':5432/')
    : input.databaseUrl;
  const selected = dedicated || fallback;
  if (isSupabaseTransactionPoolerUrl(selected)) {
    throw new Error(
      'ShipStation consumer leadership cannot use the Supabase transaction pooler on port 6543; configure a direct or session-mode port 5432 URL.',
    );
  }
  return selected;
}

// Per user override unlock shipped data on 2026-07-16: this dedicated session
// owns only pg-boss consumer leadership. It never reads or mutates orders,
// shipments, labels, postage, marketplace notifications, or customer data.
const shipStationConsumerLeaderSql = postgres(
  resolveShipStationConsumerLeaderDatabaseUrl({
    databaseUrl: env.DATABASE_URL,
    dedicatedDatabaseUrl: env.SHIPSTATION_CONSUMER_LEADER_DATABASE_URL,
  }),
  {
    prepare: false,
    max: 1,
    idle_timeout: 0,
    max_lifetime: null,
    connect_timeout: env.DB_CONNECT_TIMEOUT_SECONDS,
    connection: {
      application_name: 'prepship-shipstation-consumer-leader',
      statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
    },
    // Per user override unlock shipped data on 2026-07-16: stop polling the
    // stately queues as soon as the leadership session closes. The periodic
    // ping remains a fallback, but an old worker no longer waits for that tick
    // before surrendering its consumers during a connection-loss handoff.
    onclose: () => {
      const leadership = shipStationConsumerLeadership;
      if (!leadership) return;
      void leadership.notifyConnectionClosed().catch((error) => {
        console.error(
          '[job-queue] ShipStation leadership close handler failed:',
          error instanceof Error ? error.message : error,
        );
      });
    },
  },
);

// Leadership handoff is queue control-plane state. Its active-job read must
// stay available while DB-heavy sync work occupies the shared application
// pool, otherwise the new deploy owns leadership but never registers the
// order/shipment/outbox consumers.
const shipStationConsumerStatePoolerCompatibility = { max_pipeline: 1 } as const;
const shipStationConsumerStateSql = postgres(env.DATABASE_URL, {
  prepare: false,
  max: 1,
  idle_timeout: env.DB_IDLE_TIMEOUT_SECONDS,
  max_lifetime: env.DB_MAX_LIFETIME_SECONDS,
  connect_timeout: env.DB_CONNECT_TIMEOUT_SECONDS,
  connection: {
    application_name: 'prepship-shipstation-consumer-state',
    statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
  },
  ...shipStationConsumerStatePoolerCompatibility,
});

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
  // shared-lane control queues to the canonical stately coalescing policy.
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
  dailyAtEightUtc: '0 8 * * *',
  dailyAtNineUtc: '0 9 * * *',
} as const;

export type ManualOrderSyncEnqueueResult = {
  queued: boolean;
  jobId: string | null;
  queueState: Exclude<OrderSyncQueueState, 'idle'> | 'already_queued' | 'error';
  blockerJobId: string | null;
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

function safeJobOutput(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function safeJobReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 160 && /^[a-z0-9_.:\- ]+$/i.test(normalized)
    ? normalized
    : null;
}

export function syncJobAttemptSnapshotFromRow(row: {
  name: string;
  state: string;
  created_on?: unknown;
  started_on?: unknown;
  completed_on?: unknown;
  output?: unknown;
}): SyncJobAttemptSnapshot {
  const output = safeJobOutput(row.output);
  return {
    name: row.name,
    state: row.state,
    createdAt: dateFromUnknown(row.created_on)?.toISOString() ?? null,
    startedAt: dateFromUnknown(row.started_on)?.toISOString() ?? null,
    completedAt: dateFromUnknown(row.completed_on)?.toISOString() ?? null,
    skipped: output.skipped === true,
    deferred: output.deferred === true,
    blockedBy: safeJobReason(output.blockedBy),
    reason: safeJobReason(output.reason),
  };
}

export async function readLatestSyncJobAttemptSnapshots(): Promise<SyncJobAttemptSnapshot[]> {
  try {
    const jobTable = `${env.PG_BOSS_SCHEMA}.job`;
    const rows = await pg<Array<{
      name: string;
      state: string;
      created_on: Date | string | null;
      started_on: Date | string | null;
      completed_on: Date | string | null;
      output: unknown;
    }>>`
      SELECT DISTINCT ON (name)
        name, state, created_on, started_on, completed_on, output
      FROM ${pg(jobTable)}
      WHERE name = ANY(${Object.values(SYNC_STATUS_JOB_NAMES)})
      ORDER BY name, created_on DESC, id DESC
    `;
    return rows.map(syncJobAttemptSnapshotFromRow);
  } catch (error) {
    console.warn(
      '[job-queue] latest sync attempt status unavailable:',
      error instanceof Error ? error.message : error,
    );
    return [];
  }
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

async function sendOrderSyncJob(
  targetBoss: PgBoss,
  queueStarted: boolean,
  payload: ManualOrderSyncJobPayload,
  intent: Extract<SyncJobAdmissionIntent, { kind: 'manual-order' | 'watchdog-order' }>,
): Promise<ManualOrderSyncEnqueueResult> {
  try {
    const admission = resolveSyncJobAdmission(JOBS.orders, intent);
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
    const blocker = id
      ? null
      : orderSyncQueueBlocker(await readOrderSyncQueueTruth());
    return {
      queued: Boolean(id),
      jobId: id ? String(id) : blocker?.jobId ?? null,
      queueState: id ? 'queued' : blocker?.state ?? 'already_queued',
      blockerJobId: blocker?.jobId ?? null,
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
      queueState: 'error',
      blockerJobId: null,
      queueStarted,
      jobName: JOBS.orders,
      mode: payload.mode,
      requestedAt: payload.requestedAt,
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
  return sendOrderSyncJob(targetBoss, queueStarted, payload, {
    kind: 'manual-order',
    mode: payload.mode,
  });
}

async function sendOrderSyncWatchdogJob(
  targetBoss: PgBoss,
  queueStarted: boolean,
): Promise<ManualOrderSyncEnqueueResult> {
  // Per user override unlock shipped data on 2026-07-15: unlike the manual
  // refresh payload, this recovery wake-up retains canonical status passes.
  return sendOrderSyncJob(
    targetBoss,
    queueStarted,
    buildOrderSyncWatchdogJobPayload(),
    { kind: 'watchdog-order' },
  );
}

export async function enqueueManualOrderSyncJob(
  request: ManualOrderSyncRequest = {},
): Promise<ManualOrderSyncEnqueueResult> {
  if (boss && started) {
    return sendManualOrderSyncJob(boss, true, request);
  }

  const transientBoss = new PgBoss(withPgBossPoolLifetime({
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
  }, env.DB_MAX_LIFETIME_SECONDS));

  try {
    await transientBoss.start();
    await ensureQueue(transientBoss, JOBS.orders);
    return await sendManualOrderSyncJob(transientBoss, false, request);
  } catch (err) {
    const payload = buildManualOrderSyncJobPayload(request);
    return {
      queued: false,
      jobId: null,
      queueState: 'error',
      blockerJobId: null,
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

export async function enqueueOrderSyncWatchdogJob(): Promise<ManualOrderSyncEnqueueResult> {
  if (boss && started) {
    return sendOrderSyncWatchdogJob(boss, true);
  }

  const transientBoss = new PgBoss(withPgBossPoolLifetime({
    connectionString: env.DATABASE_URL,
    schema: env.PG_BOSS_SCHEMA,
    application_name: 'prepship-api-order-sync-watchdog',
    max: 1,
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 30 * 60,
    retentionDays: 7,
    deleteAfterDays: 7,
    supervise: false,
  }, env.DB_MAX_LIFETIME_SECONDS));

  try {
    await transientBoss.start();
    await ensureQueue(transientBoss, JOBS.orders);
    return await sendOrderSyncWatchdogJob(transientBoss, false);
  } catch (err) {
    const payload = buildOrderSyncWatchdogJobPayload();
    return {
      queued: false,
      jobId: null,
      queueState: 'error',
      blockerJobId: null,
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

  const transientBoss = new PgBoss(withPgBossPoolLifetime({
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
  }, env.DB_MAX_LIFETIME_SECONDS));

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

  const transientBoss = new PgBoss(withPgBossPoolLifetime({
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
  }, env.DB_MAX_LIFETIME_SECONDS));

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
  jobData?: unknown,
): Promise<string | null> {
  if (!boss || !BUSY_DEFER_JOB_NAMES.has(name)) return null;
  try {
    const deferCount = Math.max(0, Math.trunc(priorDeferCount)) + 1;
    const orderStarvation =
      name === JOBS.orders && deferCount >= SYNC_STARVATION_DEFER_THRESHOLD;
    const fulfillmentOutboxRecovery = name === JOBS.fulfillmentOutbox;
    const recoveryPriority = orderStarvation || fulfillmentOutboxRecovery;
    const delaySeconds = orderStarvation ? ORDER_STARVATION_DEFER_SECONDS : BUSY_DEFER_SECONDS;
    const isRateBackfill = name === JOBS.rateBackfill;
    const ratePayload = isRateBackfill
      ? parseDurableRateBackfillJobPayload(jobData)
      : null;
    const admission = isRateBackfill
      ? {
          singletonKey:
            `rate-backfill-defer:${ratePayload?.generationId ?? ratePayload?.jobId ?? 'cadence'}`
            + `:${ratePayload?.chunkIndex ?? 0}`,
          priority: rateBackfillPriority(ratePayload),
        }
      : resolveSyncJobAdmission(name, {
          kind: 'busy-defer',
          recoveryPriority,
        });
    const deferredMetadata = {
      requestedAt: new Date().toISOString(),
      deferredBecause: blockedBy,
      deferredLane: lane,
      deferCount,
      orderStarvation,
      fulfillmentOutboxRecovery,
    };
    // Per user override unlock shipped data on 2026-05-23: reconfirmed on
    // 2026-07-21; this only creates a coalesced replacement pg-boss wake-up
    // when the shared database lane is busy. The stately outbox key permits one
    // created replacement beside the active attempt; no provider handler runs
    // here. Rate payloads retain their
    // exact awaiting-only target IDs. This does not touch orders, shipments,
    // labels, postage, or marketplace notifications.
    const deferredPayload =
      ratePayload
        ? { ...ratePayload, ...deferredMetadata }
        : jobData && typeof jobData === 'object' && !Array.isArray(jobData)
          ? { ...(jobData as Record<string, unknown>), ...deferredMetadata }
          : deferredMetadata;
    const id = await boss.sendAfter(
      name,
      deferredPayload,
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
    // A null pg-boss id means the canonical singleton wake-up already exists.
    // Treat that as successful coalescing instead of retrying the active row
    // and creating a second source of retry pressure.
    return id ?? `coalesced:${admission.singletonKey}`;
  } catch (err) {
    console.error(
      `[job-queue] failed to defer ${name}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

// Per user override unlock shipped data on 2026-05-23: queue-control fail-closed
// assertion only; it cannot call fulfillment providers or mutate order data.
function assertDurableBusyDeferral(
  name: JobName,
  deferredJobId: string | null,
): void {
  if (deferredJobId) return;
  if (name === JOBS.rateBackfill) {
    throw new Error('durable rate-backfill deferral failed; retrying original queue job');
  }
  if (name === JOBS.fulfillmentOutbox) {
    throw new Error('durable fulfillment-outbox deferral failed; retrying original queue job');
  }
  if (BUSY_DEFER_JOB_NAMES.has(name)) {
    throw new Error(`durable ${name} deferral failed; retrying original queue job`);
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

  const admission = name === JOBS.rateBackfill
    ? { singletonKey: 'rate-backfill-cadence', priority: rateBackfillPriority(null) }
    : resolveSyncJobAdmission(name, { kind: 'cadence' });
  const priority = admission.priority;

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
      priority,
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
    JOBS.localTariffCalibration,
    SCHEDULE_CRON.dailyAtEightUtc,
    24 * 60 * 60_000,
    env.ENABLE_LOCAL_TARIFF_CALIBRATION_SCHEDULER && Boolean(env.SHIPSTATION_API_KEY_V2),
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

async function pendingOperationalBlockerForRateBackfill(): Promise<string | null> {
  const jobTable = `${env.PG_BOSS_SCHEMA}.job`;
  // Per user override unlock shipped data on 2026-07-18: rate admission reads
  // queue control-plane rows only. Future shipment/order defer wake-ups are not
  // runnable blockers; active work remains protected by the local/advisory lane.
  const rows = await shipStationConsumerStateSql<OperationalSyncQueueRow[]>`
    SELECT
      name,
      state,
      start_after AS "startAfter"
    FROM ${shipStationConsumerStateSql(jobTable)}
    WHERE name = ANY(${[JOBS.orders, JOBS.shipments] as string[]})
      AND state IN ('created', 'retry')
  `;
  return rateBackfillOperationalBlocker(
    runnableOperationalSyncQueueSizes(rows),
  );
}

async function pendingShipmentRecoveryBlockerForOrders(): Promise<string | null> {
  const jobTable = `${env.PG_BOSS_SCHEMA}.job`;
  const rows = await shipStationConsumerStateSql<OperationalSyncQueueRow[]>`
    SELECT
      name,
      state,
      start_after AS "startAfter",
      priority,
      data->>'deferCount' AS "deferCount"
    FROM ${shipStationConsumerStateSql(jobTable)}
    WHERE name = ${JOBS.shipments}
      AND state IN ('active', 'created', 'retry')
  `;
  return shouldYieldOrderSyncToShipmentRecovery(rows)
    ? JOBS.shipments
    : null;
}

async function pendingFulfillmentOutboxBlockerForOrders(
  priorOrderDeferCount: number = 0,
): Promise<string | null> {
  const jobTable = `${env.PG_BOSS_SCHEMA}.job`;
  const rows = await shipStationConsumerStateSql<OperationalSyncQueueRow[]>`
    SELECT
      name,
      state,
      start_after AS "startAfter",
      priority,
      data->>'deferCount' AS "deferCount"
    FROM ${shipStationConsumerStateSql(jobTable)}
    WHERE name = ${JOBS.fulfillmentOutbox}
      AND state IN ('active', 'created', 'retry')
  `;
  return shouldYieldOrderSyncToFulfillmentOutbox(rows, Date.now(), priorOrderDeferCount)
    ? JOBS.fulfillmentOutbox
    : null;
}

async function runOrderSyncWithOutboxPriority(
  jobData: unknown,
  identity: ShipStationSyncRunIdentity,
  parentSignal: AbortSignal,
): Promise<unknown> {
  const priorDeferCount = busyDeferCount(jobData);
  const preempt = new AbortController();
  const stopMonitor = new AbortController();
  const workSignal = AbortSignal.any([parentSignal, preempt.signal]);
  const monitorSignal = AbortSignal.any([parentSignal, stopMonitor.signal]);
  const monitor = (async () => {
    while (!monitorSignal.aborted) {
      const outboxBlocker = await pendingFulfillmentOutboxBlockerForOrders(priorDeferCount);
      if (outboxBlocker) {
        // Per user override unlock shipped data on 2026-05-23: reconfirmed on
        // 2026-07-21; cooperatively stop only this bounded order attempt so the
        // already-durable outbox wake-up gets the shared lane. Order cursors and
        // normal transaction boundaries remain authoritative; no shipped lock
        // is bypassed.
        // Per user override unlock shipped data on 2026-07-22: identify this
        // durable queue-control deferral separately from real provider or
        // persistence failures so account health remains truthful.
        preempt.abort(new OrderSyncCooperativeYieldError());
        return;
      }
      await sleep(SHARED_LANE_PRIORITY_POLL_MS, undefined, {
        signal: monitorSignal,
      });
    }
  })();

  try {
    const options = orderSyncOptionsFromJobPayload(jobData);
    // Per user override unlock shipped data on 2026-05-23: reconfirmed on
    // 2026-07-21; a durable retry preserves the originating payload's scope.
    // Manual incremental refresh remains Awaiting-only, while cadence/watchdog
    // retries retain status catch-up. The cooperative outbox monitor below is
    // now the canonical starvation guard for long status passes.
    // Per user override unlock shipped data on 2026-07-14: order ingestion no
    // longer starts a detached broad rate backfill outside its durable queue
    // lane. The import owner enqueues only newly imported Awaiting IDs; pg-boss
    // owns both that targeted handoff and the separate broad cadence.
    return await syncOrders({ ...options, runIdentity: identity, signal: workSignal });
  } catch (err) {
    if (!preempt.signal.aborted || parentSignal.aborted) throw err;
    const deferredJobId = await deferBusySyncJob(
      JOBS.orders,
      JOBS.fulfillmentOutbox,
      syncJobLaneFor(JOBS.orders),
      priorDeferCount,
      jobData,
    );
    if (!deferredJobId) {
      throw new Error('Order sync outbox-priority deferral failed; retrying original queue job');
    }
    return {
      ok: true,
      skipped: true,
      deferred: true,
      deferredJobId,
      blockedBy: JOBS.fulfillmentOutbox,
      reason: 'yielded_to_pending_fulfillment_outbox',
    };
  } finally {
    stopMonitor.abort();
    await monitor.catch((err) => {
      if (!monitorSignal.aborted) throw err;
    });
  }
}

async function runShipmentSyncWithOrderPriority(
  jobData: unknown,
  parentSignal: AbortSignal,
): Promise<unknown> {
  const priorDeferCount = busyDeferCount(jobData);
  const recoveryRequested = shipmentSyncRequestHasRecoveryPriority(jobData);
  const preempt = new AbortController();
  const stopMonitor = new AbortController();
  const workSignal = AbortSignal.any([parentSignal, preempt.signal]);
  const monitorSignal = AbortSignal.any([parentSignal, stopMonitor.signal]);
  const monitor = (async () => {
    while (!monitorSignal.aborted) {
      const queueTruth = await readOrderSyncQueueTruth();
      if (shouldYieldShipmentSyncToOrders({
        ordersPending: hasPendingOrderSyncWork(queueTruth),
        priorDeferCount,
        recoveryRequested,
      })) {
        // Per user override unlock shipped data on 2026-07-18: this cancels
        // only the current bounded shipment worker attempt. Existing database
        // transactions finish or roll back normally; no protection is bypassed.
        preempt.abort(new Error('Shipment sync yielded to pending order refresh'));
        return;
      }
      await sleep(SHARED_LANE_PRIORITY_POLL_MS, undefined, {
        signal: monitorSignal,
      });
    }
  })();

  try {
    return await syncShipments({
      ...shipmentSyncOptionsFromJobPayload(jobData),
      signal: workSignal,
    });
  } catch (err) {
    if (!preempt.signal.aborted || parentSignal.aborted) throw err;
    const deferredJobId = await deferBusySyncJob(
      JOBS.shipments,
      JOBS.orders,
      syncJobLaneFor(JOBS.shipments),
      priorDeferCount,
      jobData,
    );
    if (!deferredJobId) {
      throw new Error('Shipment sync priority deferral failed; retrying original queue job');
    }
    return {
      ok: true,
      skipped: true,
      deferred: true,
      deferredJobId,
      blockedBy: JOBS.orders,
      reason: 'yielded_to_pending_order_sync',
    };
  } finally {
    stopMonitor.abort();
    await monitor.catch((err) => {
      if (!monitorSignal.aborted) throw err;
    });
  }
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

      if (name === JOBS.orders) {
        const fulfillmentOutboxBlocker = await pendingFulfillmentOutboxBlockerForOrders(
          busyDeferCount(job?.data),
        );
        const shipmentBlocker = fulfillmentOutboxBlocker
          ? null
          : await pendingShipmentRecoveryBlockerForOrders();
        const recoveryBlocker = fulfillmentOutboxBlocker ?? shipmentBlocker;
        if (recoveryBlocker) {
          // Per user override unlock shipped data on 2026-05-23: reconfirmed on
          // 2026-07-21; this yields only the queue attempt. The canonical sync
          // handlers and shipped / cancelled protections remain unchanged.
          await recordWorkerJobSkipped(name, `${recoveryBlocker} recovery pending`);
          const deferredJobId = await deferBusySyncJob(
            name,
            recoveryBlocker,
            syncJobLaneFor(name),
            busyDeferCount(job?.data),
            job?.data,
          );
          if (!deferredJobId) {
            throw new Error('order-sync fairness deferral failed; retrying original queue job');
          }
          return {
            ok: true,
            skipped: true,
            deferred: true,
            deferredJobId,
            blockedBy: recoveryBlocker,
            reason: fulfillmentOutboxBlocker
              ? 'fulfillment_outbox_recovery_pending'
              : 'shipment_recovery_pending',
          };
        }
      }

      const lane = syncJobLaneFor(name);
      if (name === JOBS.rateBackfill) {
        const operationalBlocker = await pendingOperationalBlockerForRateBackfill();
        if (operationalBlocker) {
          console.log(
            `[job-queue] ${name} yielded because ${operationalBlocker} is pending in ${lane} lane`
          );
          await recordWorkerJobSkipped(
            name,
            `${operationalBlocker} pending in ${lane} lane`,
          );
          const deferredJobId = await deferBusySyncJob(
            name,
            operationalBlocker,
            lane,
            busyDeferCount(job?.data),
            job?.data,
          );
          if (!deferredJobId) {
            throw new Error('durable rate-backfill yield failed; retrying original queue job');
          }
          return {
            ok: true,
            skipped: true,
            deferred: true,
            deferredJobId,
            blockedBy: operationalBlocker,
            lane,
            reason: 'operational_sync_pending',
          };
        }
      }

      const blockedBy = getSyncJobLaneBlocker(activeJobsByLane, name);
      if (blockedBy) {
        console.log(
          `[job-queue] ${name} skipped because ${blockedBy} is already running in ${lane} lane`
        );
        await recordWorkerJobSkipped(name, `${blockedBy} already running in ${lane} lane`);
        const deferredJobId = await deferBusySyncJob(
          name,
          blockedBy,
          lane,
          busyDeferCount(job?.data),
          job?.data,
        );
        assertDurableBusyDeferral(name, deferredJobId);
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
        const ratePayload = name === JOBS.rateBackfill
          ? parseDurableRateBackfillJobPayload(job?.data)
          : null;
        console.log(`[job-queue] started ${name} (${job?.id ?? 'unknown'})`);
        try {
          await recordWorkerJobStart(name, {
            jobId: identity.queueJobId,
            generationId: ratePayload?.generationId ?? ratePayload?.jobId ?? null,
            lane,
            startedAtMs: startedAt,
            timeoutMs: SYNC_JOB_HANDLER_TIMEOUT_MS,
          });
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
          const classification = classifyWorkerResolvedResult(result);
          if (classification.status === 'failed') {
            throw new Error(`${name}: ${classification.error ?? 'all attempted work failed'}`);
          }
          const durationMs = Date.now() - startedAt;
          console.log(`[job-queue] completed ${name} in ${durationMs}ms`);
          await recordWorkerJobSuccess(name, startedAt, result);
          return { ok: true, durationMs };
        } catch (err) {
          if (err instanceof DeadlineExceededError) {
            // Per user override unlock shipped data on 2026-07-17 (PS-436):
            // keep the advisory fence while cooperative work receives a bounded
            // cancellation grace. If it ignores abort, do not return from this
            // callback (which would release the lane): fail closed by terminating
            // the worker and let Render/pg-boss recover the durable job.
            await requireCancellationAcknowledgement({
              work: handlerPromise,
              graceMs: SYNC_JOB_CANCELLATION_GRACE_MS,
              beforeTerminate: () =>
                recordWorkerJobFailure(name, startedAt, err).catch(() => undefined),
              terminate: () => terminateWorkerForUnacknowledgedCancellation({
                jobName: name,
                jobId: identity.queueJobId,
                graceMs: SYNC_JOB_CANCELLATION_GRACE_MS,
              }),
            });
          }
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
        const deferredJobId = await deferBusySyncJob(
          name,
          blockedBy,
          lane,
          busyDeferCount(job?.data),
          job?.data,
        );
        assertDurableBusyDeferral(name, deferredJobId);
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

async function readActiveShipStationSyncJobs(): Promise<ActiveShipStationSyncJob[]> {
  const jobTable = `${env.PG_BOSS_SCHEMA}.job`;
  return shipStationConsumerStateSql<ActiveShipStationSyncJob[]>`
    SELECT id::text AS id, name
    FROM ${shipStationConsumerStateSql(jobTable)}
    WHERE state = 'active'
      AND name = ANY(${[JOBS.orders, JOBS.shipments, JOBS.fulfillmentOutbox] as string[]})
    ORDER BY started_on ASC NULLS LAST
  `;
}

async function registerShipStationStatelyWorkers(): Promise<void> {
  if (!boss) return;

  try {
    // Per user override unlock shipped data on 2026-07-02: pg-boss owns
    // queue locking, deadlines, and worker-status writes. Call the canonical
    // ShipStation sync services directly so queued mode does not also take the
    // legacy interval-scheduler advisory lock and starve worker heartbeats.
    // Per user override unlock shipped data on 2026-05-23: reconfirmed on
    // 2026-07-21; one leadership owner consumes all stately shared-lane queues,
    // including the outbox. This avoids deploy-overlap consumer races while
    // provider execution remains inside the unchanged fulfillment handler.
    await registerWorker(JOBS.orders, (jobData, { identity, signal }) =>
      runOrderSyncWithOutboxPriority(jobData, identity, signal),
    );
    // Audit SY-3 (2026-07-13): thread the queue deadline signal into shipment
    // sync so abandoned page walks stop before a retry can become a second writer.
    await registerWorker(JOBS.shipments, (jobData, { signal }) =>
      runShipmentSyncWithOrderPriority(jobData, signal),
    );
    await registerWorker(JOBS.fulfillmentOutbox, runFulfillmentOutboxTick);
  } catch (err) {
    await Promise.allSettled([
      boss.offWork(JOBS.orders),
      boss.offWork(JOBS.shipments),
      boss.offWork(JOBS.fulfillmentOutbox),
    ]);
    throw err;
  }
}

async function unregisterShipStationStatelyWorkers(): Promise<void> {
  if (!boss) return;
  await Promise.allSettled([
    boss.offWork(JOBS.orders),
    boss.offWork(JOBS.shipments),
    boss.offWork(JOBS.fulfillmentOutbox),
  ]);
}

function leadershipError(error: unknown): unknown {
  return error instanceof Error ? error.message : error;
}

function createShipStationConsumerLeadership(): ShipStationConsumerLeadershipController {
  return new ShipStationConsumerLeadershipController({
    reserveConnection: async () => {
      const reserved = await shipStationConsumerLeaderSql.reserve();
      return {
        ping: async () => {
          await reserved`select 1`;
        },
        tryAcquire: async () => {
          const [row] = await reserved<{ acquired: boolean }[]>`
            select pg_try_advisory_lock(hashtext(${SHIPSTATION_CONSUMER_LEADER_LOCK})) as acquired
          `;
          return Boolean(row?.acquired);
        },
        unlock: async () => {
          await reserved`
            select pg_advisory_unlock(hashtext(${SHIPSTATION_CONSUMER_LEADER_LOCK}))
          `;
        },
        release: () => reserved.release(),
      };
    },
    recoverActiveJobs: async () => {
      const recovery = await reapStuckActiveJobs();
      if (recovery.reaped > 0) {
        console.log(
          `[job-queue] leadership handoff reaper cleared ${recovery.reaped} orphan(s): ${recovery.names.join(', ')}`,
        );
      }
    },
    readActiveJobs: readActiveShipStationSyncJobs,
    registerConsumers: async () => {
      await registerShipStationStatelyWorkers();
    },
    unregisterConsumers: unregisterShipStationStatelyWorkers,
    requestRestart: (reason) => {
      console.error(`[job-queue] unhealthy; requesting supervisor restart (${reason})`);
      process.exit(1);
    },
    now: () => Date.now(),
    setTimer: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return timer;
    },
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    info: (message) => console.log(message),
    warn: (message, error) => console.warn(`${message}:`, leadershipError(error)),
    error: (message, error) => console.error(`${message}:`, leadershipError(error)),
  });
}

async function maintainShipStationConsumerLeadership(): Promise<void> {
  if (!boss || !started) return;
  shipStationConsumerLeadership ??= createShipStationConsumerLeadership();
  await shipStationConsumerLeadership.start();
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

  boss = new PgBoss(withPgBossPoolLifetime({
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
  }, env.DB_MAX_LIFETIME_SECONDS));

  boss.on('error', (err) => {
    console.error('[job-queue] pg-boss error:', err.message);
  });

  await boss.start();
  await setWorkerMode('worker-scheduler');
  await createQueues();

  // Per user override unlock shipped data on 2026-07-16: pg-boss v10 stately
  // queues need one polling consumer across deploy overlap. The database-backed
  // leader waits for an existing active generation before registering these two
  // consumers, preventing the repeated stately singleton 23505 conflict.
  await maintainShipStationConsumerLeadership();
  // Audit SY-3 (2026-07-13): Shopify also receives the queue deadline signal.
  await registerWorker(JOBS.shopifyOrders, (_jobData, { signal }) =>
    runShopifyOrderSyncTick(signal),
  );
  await registerWorker(JOBS.inventoryImport, runInventoryImportFromOrders);
  await registerWorker(JOBS.syncProducts, (_jobData, { signal }) =>
    runSyncProductsTick(signal),
  );
  await registerWorker(JOBS.reportingRefresh, runReportingRefreshTick);
  // Per user override unlock shipped data on 2026-07-02: queued mode already
  // owns the external-shipped lane via pg-boss + advisory locks. Call the
  // bounded classifier job directly so a stale legacy interval-scheduler lock
  // cannot make the queued worker wait until the outer 10-minute deadline.
  await registerWorker(JOBS.externalShippedClassifier, runExternalShippedClassifierJob);
  await registerWorker(JOBS.shipmentTracking, runShipmentTrackingTick);
  await registerWorker(JOBS.walmartFees, runWalmartFeesTick);
  await registerWorker(JOBS.rateBackfill, (jobData, { identity, signal }) => {
    const explicitRequest = parseDurableRateBackfillJobPayload(jobData);
    return explicitRequest
      ? runDurableRateBackfillJob(explicitRequest, signal)
      : runBackfillTick(identity.queueJobId, signal);
  });
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
  await registerWorker(JOBS.localTariffCalibration, (_jobData, { signal }) =>
    runLocalTariffCalibrationTick(signal),
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
  // Per user override unlock shipped data on 2026-07-16: unregister the two
  // ShipStation pollers before releasing their advisory leadership session.
  // Any still-active pg-boss row remains the durable handoff fence for the
  // next worker generation while the rest of this boss shuts down gracefully.
  await shipStationConsumerLeadership?.stop();
  shipStationConsumerLeadership = null;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  try {
    if (boss) {
      await boss.stop({ graceful: true, timeout: 30_000 });
    }
  } finally {
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
