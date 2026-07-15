import { sql as pg } from '../db/client.js';
import { env } from '../lib/env.js';
import { getPersistedWorkerStatus } from './worker-status';
import {
  evaluatePrintQueueWorkerHealth,
  PRINT_QUEUE_SEND_JOB_NAME,
  type PrintQueueWorkerHealthFacts,
  type PrintQueueWorkerHealthVerdict,
} from './print-queue-worker-policy';

type QueueHealthRow = {
  created_count: number | string;
  retry_count: number | string;
  active_count: number | string;
  failed_count: number | string;
  newest_failure_age_seconds: number | string | null;
  oldest_pending_age_seconds: number | string | null;
  oldest_active_age_seconds: number | string | null;
};

type DurableHealthRow = {
  active_count: number | string;
  total_count: number | string;
  current_count: number | string;
  oldest_active_age_seconds: number | string | null;
  provider_pending_count: number | string;
};

export type PrintQueueWorkerHealth = PrintQueueWorkerHealthVerdict & {
  facts: PrintQueueWorkerHealthFacts & {
    pgBossFailed: number;
    durableTotal: number;
    durableCurrent: number;
  };
};

function numberOrZero(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function nullableAge(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : null;
}

async function readPgBossHealth(): Promise<{ ok: boolean; row: QueueHealthRow | null }> {
  try {
    const jobTable = `${env.PG_BOSS_SCHEMA}.job`;
    const [row] = await pg<QueueHealthRow[]>`
      SELECT
        count(*) FILTER (WHERE state = 'created')::int AS created_count,
        count(*) FILTER (WHERE state = 'retry')::int AS retry_count,
        count(*) FILTER (WHERE state = 'active')::int AS active_count,
        count(*) FILTER (WHERE state = 'failed')::int AS failed_count,
        min(extract(epoch from (now() - coalesce(completed_on, started_on, created_on)))) FILTER (
          WHERE state = 'failed'
        ) AS newest_failure_age_seconds,
        max(extract(epoch from (now() - created_on))) FILTER (
          WHERE state IN ('created', 'retry')
        ) AS oldest_pending_age_seconds,
        max(extract(epoch from (now() - started_on))) FILTER (
          WHERE state = 'active' AND started_on IS NOT NULL
        ) AS oldest_active_age_seconds
      FROM ${pg(jobTable)}
      WHERE name = ${PRINT_QUEUE_SEND_JOB_NAME}
    `;
    return { ok: true, row: row ?? null };
  } catch {
    return { ok: false, row: null };
  }
}

async function readDurableHealth(): Promise<{ ok: boolean; row: DurableHealthRow | null }> {
  try {
    // Per user override unlock shipped data on 2026-07-15: PS-430 reads only
    // durable Print Queue orchestration/item state. It never reads or mutates
    // shipped/cancelled order history, shipments, labels, or postage.
    const [row] = await pg<DurableHealthRow[]>`
      SELECT
        count(*) FILTER (
          WHERE status IN ('pending', 'running') OR active = true
        )::int AS active_count,
        coalesce(sum(total) FILTER (
          WHERE status IN ('pending', 'running') OR active = true
        ), 0)::int AS total_count,
        coalesce(sum(current) FILTER (
          WHERE status IN ('pending', 'running') OR active = true
        ), 0)::int AS current_count,
        max(extract(epoch from (now() - updated_at))) FILTER (
          WHERE status IN ('pending', 'running') OR active = true
        ) AS oldest_active_age_seconds,
        (
          SELECT count(*)::int
          FROM print_queue_batch_job_items
          WHERE state IN ('provider_pending', 'provider_pending_recovery')
        ) AS provider_pending_count
      FROM print_queue_send_jobs
    `;
    return { ok: true, row: row ?? null };
  } catch {
    return { ok: false, row: null };
  }
}

export async function readPrintQueueWorkerHealth(): Promise<PrintQueueWorkerHealth> {
  const [queue, durable, worker] = await Promise.all([
    readPgBossHealth(),
    readDurableHealth(),
    getPersistedWorkerStatus().catch(() => null),
  ]);
  const queueRow = queue.row;
  const durableRow = durable.row;
  const printWorker = worker?.snapshots['print-worker'] ?? null;
  const lastWorkerJob = printWorker?.status.jobs[PRINT_QUEUE_SEND_JOB_NAME] ?? null;
  const lastWorkerJobAt = lastWorkerJob?.finishedAt ?? lastWorkerJob?.startedAt ?? null;
  const lastWorkerJobAtMs = lastWorkerJobAt ? Date.parse(lastWorkerJobAt) : Number.NaN;
  const facts: PrintQueueWorkerHealth['facts'] = {
    expected: env.PRINT_QUEUE_WORKER_ENABLED,
    heartbeatAgeSeconds: printWorker?.heartbeatAgeSeconds ?? null,
    queueReadOk: queue.ok,
    durableReadOk: durable.ok,
    pgBossCreated: numberOrZero(queueRow?.created_count),
    pgBossRetry: numberOrZero(queueRow?.retry_count),
    pgBossActive: numberOrZero(queueRow?.active_count),
    pgBossFailed: numberOrZero(queueRow?.failed_count),
    pgBossNewestFailureAgeSeconds: nullableAge(queueRow?.newest_failure_age_seconds),
    pgBossOldestPendingAgeSeconds: nullableAge(queueRow?.oldest_pending_age_seconds),
    pgBossOldestActiveAgeSeconds: nullableAge(queueRow?.oldest_active_age_seconds),
    durableActive: numberOrZero(durableRow?.active_count),
    durableTotal: numberOrZero(durableRow?.total_count),
    durableCurrent: numberOrZero(durableRow?.current_count),
    durableOldestActiveAgeSeconds: nullableAge(durableRow?.oldest_active_age_seconds),
    providerPending: numberOrZero(durableRow?.provider_pending_count),
    lastWorkerJobStatus: lastWorkerJob?.status ?? null,
    lastWorkerJobAgeSeconds: Number.isFinite(lastWorkerJobAtMs)
      ? Math.max(0, Math.round((Date.now() - lastWorkerJobAtMs) / 1000))
      : null,
  };
  return { ...evaluatePrintQueueWorkerHealth(facts), facts };
}
