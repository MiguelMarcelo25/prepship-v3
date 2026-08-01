import { sql as pg } from '../db/client.js';
import { tryAdvisoryTransactionLock } from '../lib/advisory-session-lock';
import { env } from '../lib/env.js';
import {
  getSyncStatus,
  type OrderStatusCatchupSnapshot,
  type OrderSyncAccountDiagnostic,
} from './order-sync';
import { getShipmentSyncStatus } from './shipment-sync';
import { getSetting, setSetting } from './settings';
import {
  enqueueOrderSyncWatchdogJob,
  enqueueShipmentSyncWatchdogJob,
  readEligibleUnstartedQueueAgeSeconds,
} from './sync-job-queue';
import {
  reapStaleQueuedCadenceJobs,
  reapStuckActiveJobs,
  type ReapResult,
} from './sync-stuck-job-reaper';
import { getPersistedWorkerStatus, type WorkerStatusSnapshot } from './worker-status';
import {
  notifyShipmentSyncWatchdogEscalation,
  type ShipmentSyncWatchdogAlertNotification,
} from './shipment-sync-watchdog-alert';
import { pruneWorkerStatusEventsIfDue } from './worker-status-events';

export const ORDER_SYNC_JOB_NAME = 'prepship.sync.orders';
export const SHIPMENT_SYNC_JOB_NAME = 'prepship.sync.shipments';

const SNAPSHOT_KEY = 'shipment_sync.watchdog.snapshot';
const LAST_ACTION_KEY = 'shipment_sync.watchdog.last_action';
const RESTART_ATTEMPTS_KEY = 'shipment_sync.watchdog.restart_attempts';
const WATCHDOG_TICK_LOCK = 'shipment_sync.watchdog.tick';

export type ShipmentSyncWatchdogThresholds = {
  workerHeartbeatStaleSeconds: number;
  orderFreshSeconds: number;
  shipmentStaleSeconds: number;
  activeJobStuckSeconds: number;
  queueBacklogThreshold: number;
  queueBacklogConsecutiveChecks: number;
  missingShipmentCountThreshold: number;
  missingShipmentRateThreshold: number;
  recentMissingLookbackHours: number;
  recoveryCooldownMs: number;
  noProgressRestartMs: number;
  restartCooldownMs: number;
  maxRestartsPerHour: number;
};

export const SHIPMENT_SYNC_WATCHDOG_DEFAULT_THRESHOLDS: ShipmentSyncWatchdogThresholds = {
  workerHeartbeatStaleSeconds: 5 * 60,
  orderFreshSeconds: 15 * 60,
  shipmentStaleSeconds: 30 * 60,
  activeJobStuckSeconds: 15 * 60,
  queueBacklogThreshold: 5,
  queueBacklogConsecutiveChecks: 2,
  missingShipmentCountThreshold: 5,
  missingShipmentRateThreshold: 0.25,
  recentMissingLookbackHours: 24,
  recoveryCooldownMs: 5 * 60_000,
  noProgressRestartMs: 20 * 60_000,
  restartCooldownMs: 15 * 60_000,
  maxRestartsPerHour: 2,
};

export type ShipmentSyncWatchdogQueueInput = {
  created: number;
  retry: number;
  active: number;
  failed: number;
  activeMaxAgeSeconds: number | null;
};

export type ShipmentSyncWatchdogMissingInput = {
  recentShippedOrders: number;
  missingActiveShipments: number;
};

export type ShipmentSyncWatchdogState =
  | 'ok'
  | 'worker_stale'
  | 'order_stale'
  | 'order_account_stale'
  | 'order_status_backlog'
  | 'sync_lane_stuck'
  | 'shipment_job_stuck'
  | 'shipment_backlog'
  | 'shipment_stale'
  | 'missing_shipments'
  | 'all_stale';

export type ShipmentSyncWatchdogRecommendedAction =
  | 'none'
  | 'reap_stale_jobs'
  | 'enqueue_order_sync'
  | 'enqueue_shipment_sync'
  | 'restart_worker'
  | 'alert_only';

export type ShipmentSyncWatchdogVerdict = {
  state: ShipmentSyncWatchdogState;
  alert: boolean;
  reason: string;
  recommendedAction: ShipmentSyncWatchdogRecommendedAction;
  orderAgeSeconds: number | null;
  shipmentAgeSeconds: number | null;
  orderFresh: boolean;
  orderStale: boolean;
  shipmentStale: boolean;
  workerStale: boolean;
  currentJobAgeSeconds: number | null;
  queueBacklog: number;
  consecutiveBacklogChecks: number;
  missingShipmentRate: number;
  orderStatusBacklog: boolean;
  orderStatusBacklogCount: number;
  staleOrderAccountCount: number;
};

export type ShipmentSyncWatchdogAccountAlert = Pick<
  OrderSyncAccountDiagnostic,
  | 'accountId'
  | 'displayName'
  | 'ownerClientId'
  | 'state'
  | 'lastSyncedAt'
  | 'ageSeconds'
  | 'runAgeSeconds'
  | 'lastFailureAt'
  | 'lastError'
  | 'backlogPasses'
  | 'backlogPages'
>;

export type ShipmentSyncQueueHealth = ShipmentSyncWatchdogQueueInput & {
  oldestCreatedAt: string | null;
  newestCreatedAt: string | null;
  oldestActiveStartedAt: string | null;
  error: string | null;
};

export type ShipmentSyncMissingHealth = ShipmentSyncWatchdogMissingInput & {
  lookbackHours: number;
  error: string | null;
};

export type ShipmentSyncWatchdogAction = {
  action: ShipmentSyncWatchdogRecommendedAction | 'cooldown';
  status: 'completed' | 'skipped' | 'failed';
  at: string;
  reason: string;
  details?: Record<string, unknown>;
};

export type ShipmentSyncWatchdogStatus = {
  enabled: boolean;
  checkedAt: string;
  thresholds: ShipmentSyncWatchdogThresholds;
  orders: {
    lastSyncedAt: string | null;
    ageSeconds: number | null;
    fresh: boolean;
    stale: boolean;
    blockedBy: string | null;
    lastJobStatus: string | null;
    lastJobFinishedAt: string | null;
    statusCatchup: OrderStatusCatchupSnapshot;
    staleAccountCount: number;
    accountAlerts: ShipmentSyncWatchdogAccountAlert[];
  };
  shipments: { lastSyncedAt: string | null };
  worker: {
    heartbeatAgeSeconds: number | null;
    stale: boolean;
    currentJob: string | null;
    currentJobId: string | null;
    currentGenerationId: string | null;
    currentLane: string | null;
    currentJobStartedAt: string | null;
    currentJobAgeSeconds: number | null;
    currentJobDeadlineAt: string | null;
    currentJobTimeoutMs: number | null;
    lastCompletedOrderSyncAt: string | null;
    lastCompletedShipmentSyncAt: string | null;
  };
  queue: ShipmentSyncQueueHealth;
  missingShipments: ShipmentSyncMissingHealth;
  verdict: ShipmentSyncWatchdogVerdict;
  lastAction: ShipmentSyncWatchdogAction | null;
  recovery: ShipmentSyncWatchdogAction | null;
  alertNotification: ShipmentSyncWatchdogAlertNotification | null;
};

type WatchdogSnapshot = {
  queueBacklogActive?: boolean;
  consecutiveBacklogChecks?: number;
};

type QueueStateRow = {
  state: string;
  count: number | string;
  oldest_created_on: string | Date | null;
  newest_created_on: string | Date | null;
  oldest_active_started_on: string | Date | null;
  active_max_age_seconds: number | string | null;
};

type MissingShipmentRow = {
  recent_shipped_orders: number | string;
  missing_active_shipments: number | string;
};

function positiveNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

export function shipmentSyncWatchdogThresholdsFromEnv(): ShipmentSyncWatchdogThresholds {
  return {
    workerHeartbeatStaleSeconds: positiveNumber(
      env.SHIPMENT_SYNC_WATCHDOG_WORKER_STALE_SECONDS,
      SHIPMENT_SYNC_WATCHDOG_DEFAULT_THRESHOLDS.workerHeartbeatStaleSeconds,
    ),
    orderFreshSeconds: positiveNumber(
      env.SHIPMENT_SYNC_WATCHDOG_ORDER_FRESH_SECONDS,
      SHIPMENT_SYNC_WATCHDOG_DEFAULT_THRESHOLDS.orderFreshSeconds,
    ),
    shipmentStaleSeconds: positiveNumber(
      env.SHIPMENT_SYNC_WATCHDOG_SHIPMENT_STALE_SECONDS,
      SHIPMENT_SYNC_WATCHDOG_DEFAULT_THRESHOLDS.shipmentStaleSeconds,
    ),
    activeJobStuckSeconds: positiveNumber(
      env.SHIPMENT_SYNC_WATCHDOG_ACTIVE_JOB_STUCK_SECONDS,
      SHIPMENT_SYNC_WATCHDOG_DEFAULT_THRESHOLDS.activeJobStuckSeconds,
    ),
    queueBacklogThreshold: nonNegativeNumber(
      env.SHIPMENT_SYNC_WATCHDOG_QUEUE_BACKLOG_THRESHOLD,
      SHIPMENT_SYNC_WATCHDOG_DEFAULT_THRESHOLDS.queueBacklogThreshold,
    ),
    queueBacklogConsecutiveChecks: positiveNumber(
      env.SHIPMENT_SYNC_WATCHDOG_QUEUE_BACKLOG_CHECKS,
      SHIPMENT_SYNC_WATCHDOG_DEFAULT_THRESHOLDS.queueBacklogConsecutiveChecks,
    ),
    missingShipmentCountThreshold: nonNegativeNumber(
      env.SHIPMENT_SYNC_WATCHDOG_MISSING_COUNT_THRESHOLD,
      SHIPMENT_SYNC_WATCHDOG_DEFAULT_THRESHOLDS.missingShipmentCountThreshold,
    ),
    missingShipmentRateThreshold: Math.min(
      1,
      positiveNumber(
        env.SHIPMENT_SYNC_WATCHDOG_MISSING_RATE_THRESHOLD,
        SHIPMENT_SYNC_WATCHDOG_DEFAULT_THRESHOLDS.missingShipmentRateThreshold,
      ),
    ),
    recentMissingLookbackHours: positiveNumber(
      env.SHIPMENT_SYNC_WATCHDOG_RECENT_HOURS,
      SHIPMENT_SYNC_WATCHDOG_DEFAULT_THRESHOLDS.recentMissingLookbackHours,
    ),
    recoveryCooldownMs: positiveNumber(
      env.SHIPMENT_SYNC_WATCHDOG_RECOVERY_COOLDOWN_MS,
      SHIPMENT_SYNC_WATCHDOG_DEFAULT_THRESHOLDS.recoveryCooldownMs,
    ),
    noProgressRestartMs: positiveNumber(
      env.SHIPMENT_SYNC_WATCHDOG_NO_PROGRESS_RESTART_MS,
      SHIPMENT_SYNC_WATCHDOG_DEFAULT_THRESHOLDS.noProgressRestartMs,
    ),
    restartCooldownMs: positiveNumber(
      env.SHIPMENT_SYNC_WATCHDOG_RESTART_COOLDOWN_MS,
      SHIPMENT_SYNC_WATCHDOG_DEFAULT_THRESHOLDS.restartCooldownMs,
    ),
    maxRestartsPerHour: nonNegativeNumber(
      env.SHIPMENT_SYNC_WATCHDOG_MAX_RESTARTS_PER_HOUR,
      SHIPMENT_SYNC_WATCHDOG_DEFAULT_THRESHOLDS.maxRestartsPerHour,
    ),
  };
}

function dateAgeSeconds(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.max(0, Math.round((nowMs - ms) / 1000)) : null;
}

function dateOrNull(value: string | Date | null): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function missingRate(input: ShipmentSyncWatchdogMissingInput): number {
  if (input.recentShippedOrders <= 0) return 0;
  return input.missingActiveShipments / input.recentShippedOrders;
}

function orderBlockedBy(workerStatus: WorkerStatusSnapshot | null): {
  blockedBy: string | null;
  lastJobStatus: string | null;
  lastJobFinishedAt: string | null;
} {
  const job = workerStatus?.jobs?.[ORDER_SYNC_JOB_NAME] ?? null;
  const reason =
    job?.summary && typeof job.summary.reason === 'string'
      ? job.summary.reason.trim()
      : '';
  let blockedBy: string | null = null;
  if (job?.status === 'skipped' && reason) {
    const laneMatch = /^(.*?) already running in .* lane$/i.exec(reason);
    const lockMatch = /^(cross-process .* lane lock) held$/i.exec(reason);
    blockedBy = lockMatch?.[1] ?? laneMatch?.[1] ?? reason;
  }
  return {
    blockedBy,
    lastJobStatus: job?.status ?? null,
    lastJobFinishedAt: job?.finishedAt ?? null,
  };
}

function orderAccountAlerts(
  accounts: OrderSyncAccountDiagnostic[],
): ShipmentSyncWatchdogAccountAlert[] {
  return accounts
    .filter((account) => account.stale)
    .map((account) => ({
      accountId: account.accountId,
      displayName: account.displayName,
      ownerClientId: account.ownerClientId,
      state: account.state,
      lastSyncedAt: account.lastSyncedAt,
      ageSeconds: account.ageSeconds,
      runAgeSeconds: account.runAgeSeconds,
      lastFailureAt: account.lastFailureAt,
      lastError: account.lastError,
      backlogPasses: account.backlogPasses,
      backlogPages: account.backlogPages,
    }));
}

export function evaluateShipmentSyncWatchdog(
  input: {
    nowMs: number;
    orderLastSyncedAt: string | null;
    shipmentLastSyncedAt: string | null;
    workerHeartbeatAgeSeconds: number | null;
    workerCurrentLane?: string | null;
    workerCurrentJobAgeSeconds?: number | null;
    queue: ShipmentSyncWatchdogQueueInput;
    missingShipments: ShipmentSyncWatchdogMissingInput;
    consecutiveBacklogChecks: number;
    orderStatusCatchupBacklog?: boolean;
    orderStatusCatchupBacklogCount?: number;
    /** PS-431: backlogged passes whose cursor has stopped advancing. */
    orderStatusCatchupStalledCount?: number;
    staleOrderAccountCount?: number;
  },
  thresholds: ShipmentSyncWatchdogThresholds = SHIPMENT_SYNC_WATCHDOG_DEFAULT_THRESHOLDS,
): ShipmentSyncWatchdogVerdict {
  const orderAgeSeconds = dateAgeSeconds(input.orderLastSyncedAt, input.nowMs);
  const shipmentAgeSeconds = dateAgeSeconds(input.shipmentLastSyncedAt, input.nowMs);
  const workerStale =
    input.workerHeartbeatAgeSeconds === null ||
    input.workerHeartbeatAgeSeconds > thresholds.workerHeartbeatStaleSeconds;
  const staleOrderAccountCount = Math.max(
    0,
    Math.floor(Number(input.staleOrderAccountCount ?? 0) || 0),
  );
  const orderFresh =
    orderAgeSeconds !== null &&
    orderAgeSeconds <= thresholds.orderFreshSeconds &&
    staleOrderAccountCount === 0;
  const orderStale = !orderFresh;
  const shipmentStale =
    shipmentAgeSeconds === null || shipmentAgeSeconds > thresholds.shipmentStaleSeconds;
  const queueBacklog = input.queue.created + input.queue.retry;
  const persistentBacklog =
    queueBacklog > thresholds.queueBacklogThreshold &&
    input.consecutiveBacklogChecks >= thresholds.queueBacklogConsecutiveChecks;
  const missingShipmentRate = missingRate(input.missingShipments);
  const missingShipmentsHigh =
    input.missingShipments.missingActiveShipments >= thresholds.missingShipmentCountThreshold &&
    missingShipmentRate >= thresholds.missingShipmentRateThreshold;
  const orderStatusBacklog = input.orderStatusCatchupBacklog === true;
  const orderStatusBacklogCount = Math.max(0, Number(input.orderStatusCatchupBacklogCount ?? 0) || 0);
  // PS-431: a backlog that is still draining is normal paginated progress, not a
  // fault. Only a backlog whose cursor has stopped advancing escalates. The state
  // itself stays reported either way -- PS-409 requires catch-up to be visible
  // rather than implied-healthy, and that visibility is the state, not the alarm.
  const orderStatusStalledCount = Math.max(
    0,
    Number(input.orderStatusCatchupStalledCount ?? 0) || 0,
  );
  const currentJobAgeSeconds = input.workerCurrentJobAgeSeconds ?? null;

  const base = {
    orderAgeSeconds,
    shipmentAgeSeconds,
    orderFresh,
    orderStale,
    shipmentStale,
    workerStale,
    currentJobAgeSeconds,
    queueBacklog,
    consecutiveBacklogChecks: input.consecutiveBacklogChecks,
    missingShipmentRate,
    orderStatusBacklog,
    orderStatusBacklogCount,
    orderStatusStalledCount,
    staleOrderAccountCount,
  };

  if (
    input.workerCurrentLane === 'shipstation-sync'
    && currentJobAgeSeconds !== null
    && currentJobAgeSeconds > thresholds.activeJobStuckSeconds
  ) {
    return {
      ...base,
      state: 'sync_lane_stuck',
      alert: true,
      reason: `shared sync lane held ${currentJobAgeSeconds}s`,
      recommendedAction: 'restart_worker',
    };
  }

  if (
    input.queue.active > 0 &&
    input.queue.activeMaxAgeSeconds !== null &&
    input.queue.activeMaxAgeSeconds > thresholds.activeJobStuckSeconds
  ) {
    return {
      ...base,
      state: 'shipment_job_stuck',
      alert: true,
      reason: `shipment sync active job held ${input.queue.activeMaxAgeSeconds}s`,
      recommendedAction: 'reap_stale_jobs',
    };
  }

  if (workerStale) {
    return {
      ...base,
      state: 'worker_stale',
      alert: true,
      reason: `worker heartbeat stale (${input.workerHeartbeatAgeSeconds ?? 'none'}s)`,
      recommendedAction: 'restart_worker',
    };
  }

  if (persistentBacklog) {
    return {
      ...base,
      state: 'shipment_backlog',
      alert: true,
      reason: `shipment sync backlog ${queueBacklog} for ${input.consecutiveBacklogChecks} checks`,
      recommendedAction: 'reap_stale_jobs',
    };
  }

  if (shipmentStale && orderFresh) {
    return {
      ...base,
      state: 'shipment_stale',
      alert: true,
      reason: `order sync is fresh (${orderAgeSeconds}s) but shipment sync is stale (${shipmentAgeSeconds ?? 'none'}s)`,
      recommendedAction: 'enqueue_shipment_sync',
    };
  }

  if (missingShipmentsHigh && orderFresh) {
    return {
      ...base,
      state: 'missing_shipments',
      alert: true,
      reason:
        `${input.missingShipments.missingActiveShipments}/${input.missingShipments.recentShippedOrders} ` +
        'recent shipped orders lack active shipment rows',
      recommendedAction: 'enqueue_shipment_sync',
    };
  }

  if (orderStatusBacklog && !shipmentStale) {
    const stalled = orderStatusStalledCount > 0;
    return {
      ...base,
      state: 'order_status_backlog',
      alert: stalled,
      reason: stalled
        ? `order status catch-up is not draining: ${orderStatusStalledCount} pass(es) stalled on the same page`
        : `order status catch-up is working through ${orderStatusBacklogCount} partial pass(es)`,
      recommendedAction: 'enqueue_order_sync',
    };
  }

  if (staleOrderAccountCount > 0 && !shipmentStale) {
    return {
      ...base,
      state: 'order_account_stale',
      alert: true,
      reason: `${staleOrderAccountCount} order sync account(s) are stale or failed`,
      recommendedAction: 'enqueue_order_sync',
    };
  }

  if (shipmentStale && !orderFresh) {
    return {
      ...base,
      state: 'all_stale',
      alert: true,
      reason: 'order sync and shipment sync are both stale',
      recommendedAction: 'enqueue_order_sync',
    };
  }

  if (orderStale) {
    return {
      ...base,
      state: 'order_stale',
      alert: true,
      reason: `order sync is stale (${orderAgeSeconds ?? 'none'}s) while shipment sync is fresh`,
      recommendedAction: 'enqueue_order_sync',
    };
  }

  return {
    ...base,
    state: 'ok',
    alert: false,
    reason: 'order sync and shipment sync are healthy',
    recommendedAction: 'none',
  };
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

async function readWatchdogSnapshot(): Promise<WatchdogSnapshot | null> {
  return parseJson<WatchdogSnapshot>(await getSetting(SNAPSHOT_KEY));
}

async function readLastAction(): Promise<ShipmentSyncWatchdogAction | null> {
  return parseJson<ShipmentSyncWatchdogAction>(await getSetting(LAST_ACTION_KEY));
}

export async function recordWatchdogAction(action: ShipmentSyncWatchdogAction): Promise<void> {
  await setSetting(LAST_ACTION_KEY, JSON.stringify(action));
}

async function readRestartAttempts(): Promise<number[]> {
  const parsed = parseJson<unknown>(await getSetting(RESTART_ATTEMPTS_KEY));
  if (!Array.isArray(parsed)) return [];
  return parsed.map((value) => Number(value)).filter((value) => Number.isFinite(value));
}

async function writeRestartAttempts(attempts: number[]): Promise<void> {
  await setSetting(RESTART_ATTEMPTS_KEY, JSON.stringify(attempts));
}

export async function readShipmentSyncQueueHealth(): Promise<ShipmentSyncQueueHealth> {
  try {
    const jobTable = `${env.PG_BOSS_SCHEMA}.job`;
    const rows = await pg<QueueStateRow[]>`
      SELECT
        state,
        count(*)::int AS count,
        min(created_on) AS oldest_created_on,
        max(created_on) AS newest_created_on,
        min(started_on) FILTER (WHERE state = 'active') AS oldest_active_started_on,
        max(extract(epoch from (now() - started_on))) FILTER (
          WHERE state = 'active' AND started_on IS NOT NULL
        ) AS active_max_age_seconds
      FROM ${pg(jobTable)}
      WHERE name = ${SHIPMENT_SYNC_JOB_NAME}
      GROUP BY state
    `;

    const counts: Record<string, number> = {};
    let oldestCreatedAt: string | null = null;
    let newestCreatedAt: string | null = null;
    let oldestActiveStartedAt: string | null = null;
    let activeMaxAgeSeconds: number | null = null;

    for (const row of rows) {
      counts[row.state] = Number(row.count) || 0;
      const oldest = dateOrNull(row.oldest_created_on);
      const newest = dateOrNull(row.newest_created_on);
      const activeStarted = dateOrNull(row.oldest_active_started_on);
      if (oldest && (!oldestCreatedAt || oldest < oldestCreatedAt)) oldestCreatedAt = oldest;
      if (newest && (!newestCreatedAt || newest > newestCreatedAt)) newestCreatedAt = newest;
      if (activeStarted && (!oldestActiveStartedAt || activeStarted < oldestActiveStartedAt)) {
        oldestActiveStartedAt = activeStarted;
      }
      const activeAge = Number(row.active_max_age_seconds);
      if (Number.isFinite(activeAge)) {
        activeMaxAgeSeconds = Math.max(activeMaxAgeSeconds ?? 0, Math.round(activeAge));
      }
    }

    return {
      created: counts.created ?? 0,
      retry: counts.retry ?? 0,
      active: counts.active ?? 0,
      failed: counts.failed ?? 0,
      activeMaxAgeSeconds,
      oldestCreatedAt,
      newestCreatedAt,
      oldestActiveStartedAt,
      error: null,
    };
  } catch (err) {
    return {
      created: 0,
      retry: 0,
      active: 0,
      failed: 0,
      activeMaxAgeSeconds: null,
      oldestCreatedAt: null,
      newestCreatedAt: null,
      oldestActiveStartedAt: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function readRecentShippedMissingShipmentRows(
  lookbackHours: number,
): Promise<ShipmentSyncMissingHealth> {
  try {
    // Per user override unlock shipped data on 2026-07-01: PS-361 reads shipped
    // orders and shipment SOT rows for health diagnostics only. No production
    // order/shipment data is modified by this query.
    const [row] = await pg<MissingShipmentRow[]>`
      SELECT
        count(*)::int AS recent_shipped_orders,
        (count(*) FILTER (
          -- Audit M3 (2026-07-13): split the OR into two NOT EXISTS arms.
          -- NOT EXISTS(A OR B) == NOT EXISTS(A) AND NOT EXISTS(B), but the OR
          -- form forces a per-row subplan scan of shipments (pg_stat measured
          -- this query family at 2.5-3.4s per call); the split arms each probe
          -- their own partial index (shipments_order_latest_idx /
          -- shipments_order_number_latest_idx) in milliseconds.
          WHERE NOT EXISTS (
            SELECT 1
            FROM shipments s
            WHERE s.order_id = o.id
              AND coalesce(s.voided, false) = false
              AND coalesce(s.is_return, false) = false
          )
          AND NOT EXISTS (
            SELECT 1
            FROM shipments s
            WHERE s.order_id IS NULL
              AND s.order_number = o.order_number
              AND coalesce(s.voided, false) = false
              AND coalesce(s.is_return, false) = false
          )
        ))::int AS missing_active_shipments
      FROM orders o
      WHERE o.order_status = 'shipped'
        AND coalesce(o.externally_shipped, false) = false
        AND o.order_date >= now() - (${Math.max(1, Math.trunc(lookbackHours))} * interval '1 hour')
    `;
    return {
      recentShippedOrders: Number(row?.recent_shipped_orders ?? 0) || 0,
      missingActiveShipments: Number(row?.missing_active_shipments ?? 0) || 0,
      lookbackHours,
      error: null,
    };
  } catch (err) {
    return {
      recentShippedOrders: 0,
      missingActiveShipments: 0,
      lookbackHours,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function buildShipmentSyncWatchdogStatus(
  options: { nowMs?: number; advanceBacklogCounter?: boolean } = {},
): Promise<ShipmentSyncWatchdogStatus> {
  const nowMs = options.nowMs ?? Date.now();
  const thresholds = shipmentSyncWatchdogThresholdsFromEnv();
  const snapshot = await readWatchdogSnapshot();
  const [orders, shipments, worker, queue, missingShipments, lastAction] = await Promise.all([
    getSyncStatus({ includeOrderCount: false }),
    getShipmentSyncStatus({ includeShipmentCount: false }),
    getPersistedWorkerStatus(),
    readShipmentSyncQueueHealth(),
    readRecentShippedMissingShipmentRows(thresholds.recentMissingLookbackHours),
    readLastAction(),
  ]);

  const backlogActive = queue.created + queue.retry > thresholds.queueBacklogThreshold;
  const previousConsecutive = snapshot?.queueBacklogActive
    ? Math.max(0, Number(snapshot.consecutiveBacklogChecks ?? 0))
    : 0;
  const consecutiveBacklogChecks = backlogActive
    ? options.advanceBacklogCounter
      ? previousConsecutive + 1
      : Math.max(1, previousConsecutive)
    : 0;

  const verdict = evaluateShipmentSyncWatchdog(
    {
      nowMs,
      orderLastSyncedAt: orders.lastSyncedAt,
      shipmentLastSyncedAt: shipments.lastSyncedAt,
      workerHeartbeatAgeSeconds: worker.heartbeatAgeSeconds,
      workerCurrentLane: worker.activeLane?.lane ?? null,
      workerCurrentJobAgeSeconds: worker.activeLane?.ageSeconds ?? null,
      queue,
      missingShipments,
      consecutiveBacklogChecks,
      orderStatusCatchupBacklog: orders.statusCatchup.hasBacklog,
      orderStatusCatchupBacklogCount: orders.statusCatchup.backlogCount,
      orderStatusCatchupStalledCount: orders.statusCatchup.stalledCount,
      staleOrderAccountCount: orders.staleAccountCount,
    },
    thresholds,
  );
  const orderBlocker = orderBlockedBy(worker.status);
  const accountAlerts = orderAccountAlerts(orders.accounts);

  return {
    enabled: env.SHIPMENT_SYNC_WATCHDOG_ENABLED,
    checkedAt: new Date(nowMs).toISOString(),
    thresholds,
    orders: {
      lastSyncedAt: orders.lastSyncedAt,
      ageSeconds: verdict.orderAgeSeconds,
      fresh: verdict.orderFresh && !orders.statusCatchup.hasBacklog,
      stale: !verdict.orderFresh || orders.statusCatchup.hasBacklog,
      statusCatchup: orders.statusCatchup,
      staleAccountCount: orders.staleAccountCount,
      accountAlerts,
      ...orderBlocker,
    },
    shipments: { lastSyncedAt: shipments.lastSyncedAt },
    worker: {
      heartbeatAgeSeconds: worker.heartbeatAgeSeconds,
      stale: worker.stale,
      currentJob: worker.activeLane?.jobName ?? worker.status?.currentJob ?? null,
      currentJobId: worker.activeLane?.jobId ?? null,
      currentGenerationId: worker.activeLane?.generationId ?? null,
      currentLane: worker.activeLane?.lane ?? null,
      currentJobStartedAt: worker.activeLane?.startedAt ?? null,
      currentJobAgeSeconds: worker.activeLane?.ageSeconds ?? null,
      currentJobDeadlineAt: worker.activeLane?.deadlineAt ?? null,
      currentJobTimeoutMs: worker.activeLane?.timeoutMs ?? null,
      lastCompletedOrderSyncAt: worker.status?.syncWatermarks?.ordersCompletedAt ?? null,
      lastCompletedShipmentSyncAt: worker.status?.syncWatermarks?.shipmentsCompletedAt ?? null,
    },
    queue,
    missingShipments,
    verdict,
    lastAction,
    recovery: null,
    alertNotification: null,
  };
}

export async function readShipmentSyncWatchdogStatus(): Promise<ShipmentSyncWatchdogStatus> {
  return buildShipmentSyncWatchdogStatus({ advanceBacklogCounter: false });
}

function shouldCooldown(
  status: ShipmentSyncWatchdogStatus,
  action: ShipmentSyncWatchdogRecommendedAction,
  nowMs: number,
): ShipmentSyncWatchdogAction | null {
  const lastAction = status.lastAction;
  if (!lastAction || lastAction.action === 'cooldown') return null;
  if (lastAction.status !== 'completed') return null;
  if (lastAction.action !== action) return null;
  const lastMs = Date.parse(lastAction.at);
  if (!Number.isFinite(lastMs)) return null;
  const cooldownMs = action === 'restart_worker'
    ? status.thresholds.restartCooldownMs
    : status.thresholds.recoveryCooldownMs;
  if (nowMs - lastMs >= cooldownMs) return null;
  return {
    action: 'cooldown',
    status: 'skipped',
    at: new Date(nowMs).toISOString(),
    reason: `${action} cooldown active`,
    details: { lastActionAt: lastAction.at, cooldownMs },
  };
}

export function heartbeatGatedWatchdogAction(
  action: ShipmentSyncWatchdogRecommendedAction,
  workerStale: boolean,
): ShipmentSyncWatchdogRecommendedAction {
  return action === 'restart_worker' && !workerStale ? 'alert_only' : action;
}

function maybeEscalateAction(
  status: ShipmentSyncWatchdogStatus,
  nowMs: number,
): ShipmentSyncWatchdogRecommendedAction {
  let action = status.verdict.recommendedAction;
  const lastAction = status.lastAction;
  if (
    (action === 'enqueue_shipment_sync' || action === 'enqueue_order_sync') &&
    lastAction?.action === action &&
    lastAction.status === 'completed'
  ) {
    const lastMs = Date.parse(lastAction.at);
    if (Number.isFinite(lastMs) && nowMs - lastMs >= status.thresholds.noProgressRestartMs) {
      action = 'restart_worker';
    }
  }
  return heartbeatGatedWatchdogAction(action, status.verdict.workerStale);
}

async function triggerRenderWorkerRestart(
  status: ShipmentSyncWatchdogStatus,
  nowMs: number,
): Promise<ShipmentSyncWatchdogAction> {
  if (!status.verdict.workerStale) {
    return {
      action: 'restart_worker',
      status: 'skipped',
      at: new Date(nowMs).toISOString(),
      reason: 'worker heartbeat is fresh; restart blocked',
    };
  }

  if (!env.SHIPMENT_SYNC_WATCHDOG_ALLOW_RESTARTS) {
    return {
      action: 'restart_worker',
      status: 'skipped',
      at: new Date(nowMs).toISOString(),
      reason: 'restart disabled by SHIPMENT_SYNC_WATCHDOG_ALLOW_RESTARTS',
    };
  }

  const renderApiKey = env.RENDER_API_KEY ?? '';
  const serviceId =
    env.SHIPMENT_SYNC_WATCHDOG_RENDER_SERVICE_ID ??
    env.RENDER_WORKER_SERVICE_ID ??
    env.RENDER_SERVICE_ID ??
    '';
  if (!renderApiKey || !serviceId) {
    return {
      action: 'restart_worker',
      status: 'skipped',
      at: new Date(nowMs).toISOString(),
      reason: 'Render restart credentials/service id are not configured',
    };
  }

  const attempts = (await readRestartAttempts()).filter(
    (timestamp) => nowMs - timestamp < 60 * 60_000,
  );
  if (attempts.length >= status.thresholds.maxRestartsPerHour) {
    await writeRestartAttempts(attempts);
    return {
      action: 'restart_worker',
      status: 'skipped',
      at: new Date(nowMs).toISOString(),
      reason: 'max restarts per hour reached',
      details: { attemptsLastHour: attempts.length },
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(
      `https://api.render.com/v1/services/${encodeURIComponent(serviceId)}/deploys`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${renderApiKey}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
        signal: controller.signal,
      },
    );
    const ok = response.status >= 200 && response.status < 300;
    if (ok) await writeRestartAttempts([...attempts, nowMs]);
    return {
      action: 'restart_worker',
      status: ok ? 'completed' : 'failed',
      at: new Date(nowMs).toISOString(),
      reason: ok ? 'restart-requested through Render API' : `Render API returned HTTP ${response.status}`,
      details: { renderStatus: response.status },
    };
  } catch (err) {
    return {
      action: 'restart_worker',
      status: 'failed',
      at: new Date(nowMs).toISOString(),
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runRecoveryAction(
  status: ShipmentSyncWatchdogStatus,
  nowMs: number,
): Promise<ShipmentSyncWatchdogAction | null> {
  const action = maybeEscalateAction(status, nowMs);
  if (action === 'none') return null;
  if (action === 'alert_only') {
    return {
      action,
      status: 'completed',
      at: new Date(nowMs).toISOString(),
      reason: status.verdict.reason,
    };
  }

  const cooldown = shouldCooldown(status, action, nowMs);
  if (cooldown) return cooldown;

  if (action === 'reap_stale_jobs') {
    const [active, cadence]: [ReapResult, ReapResult] = await Promise.all([
      reapStuckActiveJobs(),
      reapStaleQueuedCadenceJobs(),
    ]);
    return {
      action,
      status: 'completed',
      at: new Date(nowMs).toISOString(),
      reason: 'safe pg-boss reapers ran',
      details: { active, cadence },
    };
  }

  if (action === 'enqueue_order_sync' || action === 'enqueue_shipment_sync') {
    return runSyncEnqueueRecovery(action, nowMs);
  }

  if (action === 'restart_worker') {
    return triggerRenderWorkerRestart(status, nowMs);
  }

  return null;
}

/**
 * PS-485: how long a recovery job may sit eligible-but-unstarted before the watchdog
 * stops calling the enqueue a success.
 *
 * The stately queues run on a ~3 minute cadence, so a recovery job untouched for five
 * minutes is not "queued", it is queued into a queue nothing is consuming. Five minutes
 * also matches the leadership acquire-escalation window, so the two agree on when an
 * unconsumed queue has stopped being a transient handoff.
 */
export const WATCHDOG_UNCONSUMED_QUEUE_SECONDS = 5 * 60;

/**
 * PS-485. Decide what an enqueue attempt actually achieved.
 *
 * Extracted and exported because the bug was a reporting decision, and the old inline
 * version could not be tested: any result without an `error` became
 * `status: 'completed'`, including `queued: false` -- "already queued" -- which is
 * exactly what the watchdog reported for 29 minutes while nothing consumed the queue.
 *
 * "Already queued" is only good news if something is going to run it. The age of the
 * oldest eligible unstarted job is what distinguishes the two, and it is the signal the
 * watchdog never looked at.
 */
export function decideSyncEnqueueRecovery(input: {
  action: 'enqueue_order_sync' | 'enqueue_shipment_sync';
  enqueued: { queued: boolean; error: string | null };
  unconsumedForSeconds: number | null;
  nowMs: number;
}): { status: 'completed' | 'failed'; reason: string } {
  const label = input.action === 'enqueue_order_sync' ? 'order sync' : 'shipment sync';
  if (input.enqueued.error) {
    return { status: 'failed', reason: `${label} enqueue failed: ${input.enqueued.error}` };
  }
  const unconsumedFor = input.unconsumedForSeconds;
  if (unconsumedFor !== null && unconsumedFor >= WATCHDOG_UNCONSUMED_QUEUE_SECONDS) {
    return {
      status: 'failed',
      reason:
        `${label} queue is NOT being consumed: oldest eligible job has waited `
        + `${unconsumedFor}s unstarted. Enqueuing more work cannot help; the consumer `
        + 'is missing (check ShipStation stately consumer leadership).',
    };
  }
  return {
    status: 'completed',
    reason: input.enqueued.queued
      ? `${label} recovery job enqueued`
      : `${label} recovery job already queued`,
  };
}

async function runSyncEnqueueRecovery(
  action: 'enqueue_order_sync' | 'enqueue_shipment_sync',
  nowMs: number,
): Promise<ShipmentSyncWatchdogAction> {
  if (action === 'enqueue_order_sync') {
    // Per user override unlock shipped data on 2026-07-15: watchdog recovery
    // uses the status-capable order-sync payload so a reported catch-up backlog
    // can converge. It only enqueues the existing worker; it does not buy labels,
    // create postage, notify marketplaces, or directly modify rows here.
    const enqueued = await enqueueOrderSyncWatchdogJob();
    const unconsumedForSeconds = await readEligibleUnstartedQueueAgeSeconds(ORDER_SYNC_JOB_NAME)
      .catch(() => null);
    const outcome = decideSyncEnqueueRecovery({
      action, enqueued, unconsumedForSeconds, nowMs,
    });
    return {
      action,
      status: outcome.status,
      at: new Date(nowMs).toISOString(),
      reason: outcome.reason,
      details: { ...enqueued, unconsumedForSeconds },
    };
  }

  const enqueued = await enqueueShipmentSyncWatchdogJob();
  const unconsumedForSeconds = await readEligibleUnstartedQueueAgeSeconds(SHIPMENT_SYNC_JOB_NAME)
    .catch(() => null);
  const outcome = decideSyncEnqueueRecovery({
    action,
    // the shipment result names the same fact `enqueued`
    enqueued: { queued: enqueued.enqueued, error: enqueued.error },
    unconsumedForSeconds,
    nowMs,
  });
  return {
    action,
    status: outcome.status,
    at: new Date(nowMs).toISOString(),
    reason: outcome.reason,
    details: { ...enqueued, unconsumedForSeconds },
  };
}

async function persistWatchdogSnapshot(status: ShipmentSyncWatchdogStatus): Promise<void> {
  await setSetting(
    SNAPSHOT_KEY,
    JSON.stringify({
      checkedAt: status.checkedAt,
      state: status.verdict.state,
      queueBacklogActive:
        status.queue.created + status.queue.retry > status.thresholds.queueBacklogThreshold,
      consecutiveBacklogChecks: status.verdict.consecutiveBacklogChecks,
      orderLastSyncedAt: status.orders.lastSyncedAt,
      orderAgeSeconds: status.orders.ageSeconds,
      orderFresh: status.orders.fresh,
      orderBlockedBy: status.orders.blockedBy,
      orderStatusCatchup: {
        updatedAt: status.orders.statusCatchup.updatedAt,
        hasBacklog: status.orders.statusCatchup.hasBacklog,
        backlogCount: status.orders.statusCatchup.backlogCount,
      },
      staleOrderAccountCount: status.orders.staleAccountCount,
      accountAlerts: status.orders.accountAlerts,
      shipmentLastSyncedAt: status.shipments.lastSyncedAt,
      workerHeartbeatAgeSeconds: status.worker.heartbeatAgeSeconds,
      queue: status.queue,
      missingShipments: status.missingShipments,
      reason: status.verdict.reason,
    }),
  );
}

export async function runShipmentSyncWatchdogTick(
  options: { recover?: boolean; nowMs?: number; source?: 'timer' | 'cron' | 'manual' } = {},
): Promise<ShipmentSyncWatchdogStatus> {
  // Audit SY-4: the process timer plus the cron GET/POST drivers share one
  // cross-process lock. Health, cooldown, recovery, and snapshot persistence
  // therefore form one serialized tick instead of racing stale observations.
  //
  // PS-471 (2026-07-30): acquire it WITHOUT blocking. A held lock means a tick
  // is already running, so this round is redundant by definition and skipping
  // costs nothing. The blocking acquire this replaces caused a ~90-minute
  // outage: ticks queued behind a stranded transaction, each pinning a
  // Supavisor connection for up to statement_timeout, until pooler capacity was
  // gone and no request could reach the database at all.
  const outcome = await tryAdvisoryTransactionLock(WATCHDOG_TICK_LOCK, async () => {
    const nowMs = options.nowMs ?? Date.now();
    const status = await buildShipmentSyncWatchdogStatus({
      nowMs,
      advanceBacklogCounter: true,
    });

    if (status.verdict.alert) {
      console.error(
        `[shipment-sync-watchdog] ${status.verdict.state}: ${status.verdict.reason} ` +
          `(action=${status.verdict.recommendedAction}, source=${options.source ?? 'timer'})`,
      );
    }
    for (const account of status.orders.accountAlerts) {
      console.error(
        `[shipment-sync-watchdog] account=${account.accountId} state=${account.state}: ` +
          `${account.lastError ?? `${account.displayName} order sync is stale`}`,
      );
    }

    let recovery: ShipmentSyncWatchdogAction | null = null;
    if (options.recover !== false && env.SHIPMENT_SYNC_WATCHDOG_ENABLED) {
      recovery = await runRecoveryAction(status, nowMs);
      if (recovery && recovery.action !== 'cooldown') {
        await recordWatchdogAction(recovery);
      }
    }

    // Per user override unlock shipped data on 2026-07-15: PS-431 emits only
    // sanitized watchdog lifecycle metadata. It does not include order,
    // shipment, account, label, customer, or provider payloads and performs no
    // shipped/cancelled mutation.
    const alertNotification = await notifyShipmentSyncWatchdogEscalation({
      checkedAt: status.checkedAt,
      state: status.verdict.state,
      verdictReason: status.verdict.reason,
      recovery,
      source: options.source ?? 'timer',
      nowMs,
    });
    const finalStatus = { ...status, recovery, alertNotification };
    await persistWatchdogSnapshot(finalStatus);

    // PS-431: bound the durable worker-event log. This tick is already serialized by
    // WATCHDOG_TICK_LOCK, so the prune cannot run concurrently with itself, and it is
    // internally throttled to ~6h so most ticks skip it outright. No-op while
    // WORKER_STATUS_EVENTS_DURABLE is off. Deliberately AFTER the snapshot: retention
    // housekeeping must never delay or fail the health verdict it shares a tick with.
    const pruned = await pruneWorkerStatusEventsIfDue();
    if (pruned) console.log(`[shipment-sync-watchdog] pruned ${pruned} old worker-status event(s)`);

    return finalStatus;
  });
  if (outcome.acquired) return outcome.value;

  // Lock held elsewhere. Report what is true right now, but do NOT advance the
  // backlog counter, run recovery, or persist a snapshot -- the tick holding the
  // lock owns all three, and duplicating them is what the lock exists to stop.
  console.warn(
    `[shipment-sync-watchdog] tick skipped (source=${options.source ?? 'timer'}): `
      + 'another tick already holds the lock',
  );
  return buildShipmentSyncWatchdogStatus({
    nowMs: options.nowMs ?? Date.now(),
    advanceBacklogCounter: false,
  });
}

let watchdogTimer: ReturnType<typeof setInterval> | null = null;

export function startShipmentSyncWatchdog(
  intervalMs: number = env.SHIPMENT_SYNC_WATCHDOG_INTERVAL_MS,
): () => void {
  if (!env.SHIPMENT_SYNC_WATCHDOG_ENABLED) {
    return () => undefined;
  }
  if (!watchdogTimer) {
    void runShipmentSyncWatchdogTick({ recover: true, source: 'timer' }).catch((err) => {
      console.warn('[shipment-sync-watchdog] initial tick failed:', err instanceof Error ? err.message : err);
    });
    watchdogTimer = setInterval(
      () => {
        // Per user override unlock shipped data on 2026-07-25: contain a
        // scheduled watchdog timeout at the timer boundary. The tick remains
        // observational/recovery-only and all shipped-data guards are unchanged.
        void runShipmentSyncWatchdogTick({ recover: true, source: 'timer' }).catch((err) => {
          console.warn('[shipment-sync-watchdog] scheduled tick failed:', err instanceof Error ? err.message : err);
        });
      },
      Math.max(30_000, intervalMs),
    );
    if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref();
  }
  return () => {
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  };
}
