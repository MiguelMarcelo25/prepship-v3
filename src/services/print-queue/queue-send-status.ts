export type QueueSendStatusName = 'pending' | 'running' | 'done' | 'error' | 'interrupted';

// PS-347: one order can spend a full timeout window in the first wave. If the
// in-memory worker is gone and the durable snapshot has not moved after two
// windows plus buffer, status is unknown/interrupted, not a live running job.
export const QUEUE_SEND_DURABLE_STALE_AFTER_MS = 210_000;

type QueueSendSnapshotLike = {
  status: string;
  current: number;
  total: number;
  queued: number;
  skipped?: number;
  failed: number;
  message?: string | null;
  errorMessage?: string | null;
  updatedAt?: string | number | Date | null;
};

export type DerivedQueueSendStatus = {
  status: QueueSendStatusName;
  active: boolean;
  current: number;
  total: number;
  queued: number;
  skipped: number;
  failed: number;
  message: string;
  errorMessage: string | null;
  staleReason: 'worker_missing_stale_snapshot' | null;
};

export function isQueueSendActiveStatus(status: string | null | undefined): boolean {
  return status === 'pending' || status === 'running';
}

function finiteCount(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function timestampMs(value: QueueSendSnapshotLike['updatedAt']): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeStatus(status: string): QueueSendStatusName {
  return status === 'pending' ||
    status === 'running' ||
    status === 'done' ||
    status === 'error' ||
    status === 'interrupted'
    ? status
    : 'error';
}

function doneMessage(queued: number, total: number, skipped: number, failed: number): string {
  return `Queued ${queued}/${total}${skipped ? `, ${skipped} skipped` : ''}${failed ? `, ${failed} failed` : ''}`;
}

export function deriveQueueSendSnapshotStatus(
  snapshot: QueueSendSnapshotLike,
  options: {
    now?: number;
    inMemoryJobPresent: boolean;
    staleAfterMs?: number;
  },
): DerivedQueueSendStatus {
  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? QUEUE_SEND_DURABLE_STALE_AFTER_MS;
  const total = finiteCount(snapshot.total);
  const rawCurrent = finiteCount(snapshot.current);
  const current = total > 0 ? Math.min(total, rawCurrent) : rawCurrent;
  const queued = finiteCount(snapshot.queued);
  const skipped = finiteCount(snapshot.skipped);
  const failed = finiteCount(snapshot.failed);
  const status = normalizeStatus(snapshot.status);

  if (isQueueSendActiveStatus(status) && total > 0 && current >= total) {
    return {
      status: 'done',
      active: false,
      current,
      total,
      queued,
      skipped,
      failed,
      message: doneMessage(queued, total, skipped, failed),
      errorMessage: snapshot.errorMessage ?? null,
      staleReason: null,
    };
  }

  const updatedAtMs = timestampMs(snapshot.updatedAt);
  const ageMs = updatedAtMs == null ? Number.POSITIVE_INFINITY : Math.max(0, now - updatedAtMs);
  if (!options.inMemoryJobPresent && isQueueSendActiveStatus(status) && ageMs > staleAfterMs) {
    return {
      status: 'interrupted',
      active: false,
      current,
      total,
      queued,
      skipped,
      failed,
      message:
        'Queue job interrupted/stale - check the print queue before retrying; no additional per-order failures were reported.',
      errorMessage:
        snapshot.errorMessage ??
        'Queue job interrupted before it could finish. Check the queue and retry only after verification.',
      staleReason: 'worker_missing_stale_snapshot',
    };
  }

  return {
    status,
    active: isQueueSendActiveStatus(status),
    current,
    total,
    queued,
    skipped,
    failed,
    message: snapshot.message ?? (status === 'done' ? doneMessage(queued, total, skipped, failed) : `Sending to queue ${current}/${total}`),
    errorMessage: snapshot.errorMessage ?? null,
    staleReason: null,
  };
}
