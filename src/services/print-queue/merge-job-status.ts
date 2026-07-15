import { PRINT_QUEUE_WORKER_RUNNING_LEASE_MS } from '../../lib/print-queue-worker-deadline';

export type MergeJobStatusName = 'pending' | 'running' | 'done' | 'error';

// Never classify a worker generation as stale before its configured execution
// deadline and cancellation-acknowledgement grace have elapsed.
export const MERGE_JOB_DURABLE_STALE_AFTER_MS = PRINT_QUEUE_WORKER_RUNNING_LEASE_MS;

type MergeJobSnapshotLike = {
  status: string;
  message?: string | null;
  errorMessage?: string | null;
  persistedAt?: string | number | Date | null;
};

export type DerivedMergeJobStatus = {
  status: MergeJobStatusName;
  active: boolean;
  message: string;
  errorMessage: string | null;
  staleReason: 'worker_missing_stale_snapshot' | null;
};

function isActive(status: MergeJobStatusName): boolean {
  return status === 'pending' || status === 'running';
}

function normalizeStatus(status: string): MergeJobStatusName {
  return status === 'pending' || status === 'running' || status === 'done' || status === 'error'
    ? status
    : 'error';
}

function timestampMs(value: MergeJobSnapshotLike['persistedAt']): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function deriveMergeJobSnapshotStatus(
  snapshot: MergeJobSnapshotLike,
  options: {
    now?: number;
    inMemoryJobPresent: boolean;
    staleAfterMs?: number;
  },
): DerivedMergeJobStatus {
  const status = normalizeStatus(snapshot.status);
  const updatedAtMs = timestampMs(snapshot.persistedAt);
  const ageMs = updatedAtMs == null
    ? Number.POSITIVE_INFINITY
    : Math.max(0, (options.now ?? Date.now()) - updatedAtMs);
  const staleAfterMs = options.staleAfterMs ?? MERGE_JOB_DURABLE_STALE_AFTER_MS;

  if (!options.inMemoryJobPresent && isActive(status) && ageMs > staleAfterMs) {
    const errorMessage =
      'PDF merge worker disappeared before completion. Verify the print queue, then start a new merge.';
    return {
      status: 'error',
      active: false,
      message: 'PDF merge interrupted/stale - no additional labels or postage were created.',
      errorMessage,
      staleReason: 'worker_missing_stale_snapshot',
    };
  }

  return {
    status,
    active: isActive(status),
    message: snapshot.message ?? snapshot.errorMessage ?? 'PDF merge failed',
    errorMessage: snapshot.errorMessage ?? null,
    staleReason: null,
  };
}
