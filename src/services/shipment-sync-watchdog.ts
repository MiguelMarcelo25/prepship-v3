import { sql as pg } from '../db/client.js';
import { env } from '../lib/env.js';
import { getSyncStatus } from './order-sync';
import { getShipmentSyncStatus } from './shipment-sync';
import { getSetting, setSetting } from './settings';
import { enqueueShipmentSyncWatchdogJob } from './sync-job-queue';
import {
  reapStaleQueuedCadenceJobs,
  reapStuckActiveJobs,
  type ReapResult,
} from './sync-stuck-job-reaper';
import { getPersistedWorkerStatus } from './worker-status';

export const SHIPMENT_SYNC_JOB_NAME = 'prepship.sync.shipments';

const SNAPSHOT_KEY = 'shipment_sync.watchdog.snapshot';
const LAST_ACTION_KEY = 'shipment_sync.watchdog.last_action';
const RESTART_ATTEMPTS_KEY = 'shipment_sync.watchdog.restart_attempts';

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
  | 'shipment_job_stuck'
  | 'shipment_backlog'
  | 'shipment_stale'
  | 'missing_shipments'
  | 'all_stale';

export type ShipmentSyncWatchdogRecommendedAction =
  | 'none'
  | 'reap_stale_jobs'
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
  shipmentStale: boolean;
  workerStale: boolean;
  queueBacklog: number;
  consecutiveBacklogChecks: number;
  missingShipmentRate: number;
};

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
  orders: { lastSyncedAt: string | null };
  shipments: { lastSyncedAt: string | null };
  worker: {
    heartbeatAgeSeconds: number | null;
    stale: boolean;
    currentJob: string | null;
  };
  queue: ShipmentSyncQueueHealth;
  missingShipments: ShipmentSyncMissingHealth;
  verdict: ShipmentSyncWatchdogVerdict;
  lastAction: ShipmentSyncWatchdogAction | null;
  recovery: ShipmentSyncWatchdogAction | null;
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

export function evaluateShipmentSyncWatchdog(
  input: {
    nowMs: number;
    orderLastSyncedAt: string | null;
    shipmentLastSyncedAt: string | null;
    workerHeartbeatAgeSeconds: number | null;
    queue: ShipmentSyncWatchdogQueueInput;
    missingShipments: ShipmentSyncWatchdogMissingInput;
    consecutiveBacklogChecks: number;
  },
  thresholds: ShipmentSyncWatchdogThresholds = SHIPMENT_SYNC_WATCHDOG_DEFAULT_THRESHOLDS,
): ShipmentSyncWatchdogVerdict {
  const orderAgeSeconds = dateAgeSeconds(input.orderLastSyncedAt, input.nowMs);
  const shipmentAgeSeconds = dateAgeSeconds(input.shipmentLastSyncedAt, input.nowMs);
  const workerStale =
    input.workerHeartbeatAgeSeconds === null ||
    input.workerHeartbeatAgeSeconds > thresholds.workerHeartbeatStaleSeconds;
  const orderFresh =
    orderAgeSeconds !== null && orderAgeSeconds <= thresholds.orderFreshSeconds;
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

  const base = {
    orderAgeSeconds,
    shipmentAgeSeconds,
    orderFresh,
    shipmentStale,
    workerStale,
    queueBacklog,
    consecutiveBacklogChecks: input.consecutiveBacklogChecks,
    missingShipmentRate,
  };

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

  if (shipmentStale && !orderFresh) {
    return {
      ...base,
      state: 'all_stale',
      alert: true,
      reason: 'order sync and shipment sync are both stale',
      recommendedAction: 'alert_only',
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
          WHERE NOT EXISTS (
            SELECT 1
            FROM shipments s
            WHERE
              (
                s.order_id = o.id
                OR (s.order_id IS NULL AND s.order_number = o.order_number)
              )
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
      queue,
      missingShipments,
      consecutiveBacklogChecks,
    },
    thresholds,
  );

  return {
    enabled: env.SHIPMENT_SYNC_WATCHDOG_ENABLED,
    checkedAt: new Date(nowMs).toISOString(),
    thresholds,
    orders: { lastSyncedAt: orders.lastSyncedAt },
    shipments: { lastSyncedAt: shipments.lastSyncedAt },
    worker: {
      heartbeatAgeSeconds: worker.heartbeatAgeSeconds,
      stale: worker.stale,
      currentJob: worker.status?.currentJob ?? null,
    },
    queue,
    missingShipments,
    verdict,
    lastAction,
    recovery: null,
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

function maybeEscalateAction(
  status: ShipmentSyncWatchdogStatus,
  nowMs: number,
): ShipmentSyncWatchdogRecommendedAction {
  const action = status.verdict.recommendedAction;
  const lastAction = status.lastAction;
  if (
    action === 'enqueue_shipment_sync' &&
    lastAction?.action === 'enqueue_shipment_sync' &&
    lastAction.status === 'completed'
  ) {
    const lastMs = Date.parse(lastAction.at);
    if (Number.isFinite(lastMs) && nowMs - lastMs >= status.thresholds.noProgressRestartMs) {
      return 'restart_worker';
    }
  }
  return action;
}

async function triggerRenderWorkerRestart(
  status: ShipmentSyncWatchdogStatus,
  nowMs: number,
): Promise<ShipmentSyncWatchdogAction> {
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

  if (action === 'enqueue_shipment_sync') {
    const enqueued = await enqueueShipmentSyncWatchdogJob();
    return {
      action,
      status: enqueued.error ? 'failed' : 'completed',
      at: new Date(nowMs).toISOString(),
      reason: enqueued.error
        ? `shipment sync enqueue failed: ${enqueued.error}`
        : enqueued.enqueued
          ? 'shipment sync recovery job enqueued'
          : 'shipment sync recovery job already queued',
      details: enqueued,
    };
  }

  if (action === 'restart_worker') {
    return triggerRenderWorkerRestart(status, nowMs);
  }

  return null;
}

function isStatusNudgeRecoveryAction(
  action: ShipmentSyncWatchdogRecommendedAction,
): action is 'enqueue_shipment_sync' | 'reap_stale_jobs' {
  return action === 'enqueue_shipment_sync' || action === 'reap_stale_jobs';
}

export async function nudgeShipmentSyncWatchdogRecovery(
  status: ShipmentSyncWatchdogStatus,
  options: { nowMs?: number; source?: 'status' } = {},
): Promise<ShipmentSyncWatchdogAction | null> {
  if (!env.SHIPMENT_SYNC_WATCHDOG_ENABLED || !status.verdict.alert) return null;

  const action = status.verdict.recommendedAction;
  if (!isStatusNudgeRecoveryAction(action)) return null;

  const nowMs = options.nowMs ?? Date.now();
  const cooldown = shouldCooldown(status, action, nowMs);
  if (cooldown) return cooldown;

  let recovery: ShipmentSyncWatchdogAction;
  // Per user override unlock shipped data on 2026-07-01: protected sync-status
  // reads may nudge only pg-boss shipment-sync recovery. This never buys labels,
  // creates postage, notifies marketplaces, or modifies orders/shipments rows.
  if (action === 'reap_stale_jobs') {
    const [active, cadence]: [ReapResult, ReapResult] = await Promise.all([
      reapStuckActiveJobs(),
      reapStaleQueuedCadenceJobs(),
    ]);
    recovery = {
      action,
      status: 'completed',
      at: new Date(nowMs).toISOString(),
      reason: `safe pg-boss reapers ran from ${options.source ?? 'status'} nudge`,
      details: { active, cadence },
    };
  } else {
    const enqueued = await enqueueShipmentSyncWatchdogJob();
    recovery = {
      action,
      status: enqueued.error ? 'failed' : 'completed',
      at: new Date(nowMs).toISOString(),
      reason: enqueued.error
        ? `shipment sync enqueue failed: ${enqueued.error}`
        : enqueued.enqueued
          ? `shipment sync recovery job enqueued from ${options.source ?? 'status'} nudge`
          : 'shipment sync recovery job already queued',
      details: enqueued,
    };
  }

  await recordWatchdogAction(recovery);
  return recovery;
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

  let recovery: ShipmentSyncWatchdogAction | null = null;
  if (options.recover !== false && env.SHIPMENT_SYNC_WATCHDOG_ENABLED) {
    recovery = await runRecoveryAction(status, nowMs);
    if (recovery && recovery.action !== 'cooldown') {
      await recordWatchdogAction(recovery);
    }
  }

  const finalStatus = { ...status, recovery };
  await persistWatchdogSnapshot(finalStatus);
  return finalStatus;
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
      () => void runShipmentSyncWatchdogTick({ recover: true, source: 'timer' }),
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
