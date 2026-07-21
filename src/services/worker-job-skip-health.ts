export const PERSISTENT_WORKER_JOB_SKIP_THRESHOLD = 3;

type WorkerJobForSkipHealth = {
  status?: string;
  summary?: Record<string, unknown> | null;
};

export type WorkerJobSkipSummary = {
  reason: string;
  consecutiveSkips: number;
  firstSkippedAt: string;
};

export type WorkerJobSkipHealth = {
  status: 'ok' | 'fail';
  reasonCode: 'none' | 'skip_below_threshold' | 'persistent_skip';
  consecutiveSkips: number;
  firstSkippedAt: string | null;
  skipAgeSeconds: number | null;
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
  threshold: number = PERSISTENT_WORKER_JOB_SKIP_THRESHOLD,
): WorkerJobSkipHealth {
  if (job?.status !== 'skipped') {
    return {
      status: 'ok',
      reasonCode: 'none',
      consecutiveSkips: 0,
      firstSkippedAt: null,
      skipAgeSeconds: null,
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
  const persistent = consecutiveSkips >= threshold;

  return {
    status: persistent ? 'fail' : 'ok',
    reasonCode: persistent ? 'persistent_skip' : 'skip_below_threshold',
    consecutiveSkips,
    firstSkippedAt,
    skipAgeSeconds,
  };
}
