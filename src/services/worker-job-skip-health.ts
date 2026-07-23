import { SYNC_CADENCE_MS } from '../lib/sync-cadence';

export const WORKER_JOB_STALE_CADENCE_MULTIPLIER = 3;
export const WORKER_JOB_STALE_AFTER_MS =
  SYNC_CADENCE_MS.fulfillmentOutbox * WORKER_JOB_STALE_CADENCE_MULTIPLIER;

type WorkerJobForSkipHealth = {
  status?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  summary?: Record<string, unknown> | null;
};

export type WorkerJobSkipSummary = {
  reason: string;
  consecutiveSkips: number;
  firstSkippedAt: string;
};

export type WorkerJobSkipHealth = {
  status: 'ok' | 'fail';
  reasonCode: 'none' | 'skip_below_age_threshold' | 'persistent_skip' | 'job_stale';
  consecutiveSkips: number;
  firstSkippedAt: string | null;
  skipAgeSeconds: number | null;
  lastRunAt: string | null;
  lastRunAgeSeconds: number | null;
};

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function nextWorkerJobSkipSummary(
  prior: WorkerJobForSkipHealth | null | undefined,
  reason: string,
  now: string,
): WorkerJobSkipSummary {
  const sameSkipReason =
    prior?.status === 'skipped' && prior.summary?.reason === reason;
  const priorCount = sameSkipReason
    ? positiveInteger(prior.summary?.consecutiveSkips)
    : null;
  const priorFirstSkippedAt =
    sameSkipReason && typeof prior.summary?.firstSkippedAt === 'string'
      ? prior.summary.firstSkippedAt
      : null;

  return {
    reason,
    consecutiveSkips: (priorCount ?? 0) + 1,
    firstSkippedAt: priorFirstSkippedAt ?? now,
  };
}

export function evaluateWorkerJobSkipHealth(
  job: WorkerJobForSkipHealth | null | undefined,
  nowMs: number = Date.now(),
  observationStartedAt: string | null = null,
  staleAfterMs: number = WORKER_JOB_STALE_AFTER_MS,
): WorkerJobSkipHealth {
  const lastRunAt = job?.finishedAt ?? job?.startedAt ?? observationStartedAt;
  const lastRunMs = lastRunAt ? Date.parse(lastRunAt) : Number.NaN;
  const lastRunAgeSeconds = Number.isFinite(lastRunMs)
    ? Math.max(0, Math.round((nowMs - lastRunMs) / 1_000))
    : null;
  const staleAfterSeconds = Math.ceil(staleAfterMs / 1_000);

  if (job?.status !== 'skipped') {
    const stale = lastRunAgeSeconds !== null && lastRunAgeSeconds > staleAfterSeconds;
    return {
      status: stale ? 'fail' : 'ok',
      reasonCode: stale ? 'job_stale' : 'none',
      consecutiveSkips: 0,
      firstSkippedAt: null,
      skipAgeSeconds: null,
      lastRunAt,
      lastRunAgeSeconds,
    };
  }

  const consecutiveSkips = positiveInteger(job.summary?.consecutiveSkips) ?? 1;
  const firstSkippedAt =
    typeof job.summary?.firstSkippedAt === 'string'
      ? job.summary.firstSkippedAt
      : null;
  const firstSkippedMs = firstSkippedAt ? Date.parse(firstSkippedAt) : Number.NaN;
  const skipAgeSeconds = Number.isFinite(firstSkippedMs)
    ? Math.max(0, Math.round((nowMs - firstSkippedMs) / 1_000))
    : null;
  const persistent = skipAgeSeconds !== null && skipAgeSeconds > staleAfterSeconds;

  return {
    status: persistent ? 'fail' : 'ok',
    reasonCode: persistent ? 'persistent_skip' : 'skip_below_age_threshold',
    consecutiveSkips,
    firstSkippedAt,
    skipAgeSeconds,
    lastRunAt,
    lastRunAgeSeconds,
  };
}
