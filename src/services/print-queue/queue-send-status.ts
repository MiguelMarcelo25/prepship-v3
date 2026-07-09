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
  itemStates?: Array<{ orderId: number; state: string }>;
};

export type QueueSendProgressCounters = {
  totalOrders: number;
  orderAttemptsTotal: number;
  completedOrderAttempts: number;
  current: number;
  total: number;
  queued: number;
  skipped: number;
  failed: number;
  providerPending: number;
  inProgress: number;
};

export type DerivedQueueSendStatus = QueueSendProgressCounters & {
  status: QueueSendStatusName;
  active: boolean;
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

const QUEUE_SEND_TERMINAL_ITEM_STATES = new Set([
  'queued',
  'preflight_blocked',
  'skipped_preflight',
  'failed_retryable',
  'failed_terminal',
]);
const QUEUE_SEND_SKIPPED_ITEM_STATES = new Set(['preflight_blocked', 'skipped_preflight']);
const QUEUE_SEND_FAILED_ITEM_STATES = new Set(['failed_retryable', 'failed_terminal']);
const QUEUE_SEND_PROVIDER_PENDING_ITEM_STATES = new Set(['provider_pending', 'provider_pending_recovery']);
const QUEUE_SEND_IN_PROGRESS_ITEM_STATES = new Set([
  'validating_rate',
  'acquiring_lock',
  'provider_pending',
  'provider_pending_recovery',
  'purchased',
  'shipment_persisted',
]);

export function deriveQueueSendProgressCounters(
  snapshot: QueueSendSnapshotLike,
): QueueSendProgressCounters {
  const total = finiteCount(snapshot.total);
  const latestStateByOrder = new Map<number, string>();
  for (const item of snapshot.itemStates ?? []) {
    if (Number.isInteger(item.orderId) && item.orderId > 0) latestStateByOrder.set(item.orderId, item.state);
  }
  const states = [...latestStateByOrder.values()];
  const count = (accepted: Set<string>) => states.filter((state) => accepted.has(state)).length;
  const completedFromItems = count(QUEUE_SEND_TERMINAL_ITEM_STATES);
  const rawCurrent = Math.max(finiteCount(snapshot.current), completedFromItems);
  const current = total > 0 ? Math.min(total, rawCurrent) : rawCurrent;

  return {
    totalOrders: total,
    orderAttemptsTotal: total,
    completedOrderAttempts: current,
    current,
    total,
    queued: Math.max(finiteCount(snapshot.queued), states.filter((state) => state === 'queued').length),
    skipped: Math.max(finiteCount(snapshot.skipped), count(QUEUE_SEND_SKIPPED_ITEM_STATES)),
    failed: Math.max(finiteCount(snapshot.failed), count(QUEUE_SEND_FAILED_ITEM_STATES)),
    providerPending: count(QUEUE_SEND_PROVIDER_PENDING_ITEM_STATES),
    inProgress: count(QUEUE_SEND_IN_PROGRESS_ITEM_STATES),
  };
}

function activeMessage(snapshot: QueueSendSnapshotLike, counters: QueueSendProgressCounters): string {
  const base = snapshot.status === 'pending' && counters.current === 0
    ? snapshot.message ?? `Starting queue send of ${counters.total} orders...`
    : `Sending to queue ${counters.current}/${counters.total}`;
  if (counters.providerPending > 0) return `${base} (${counters.providerPending} provider pending)`;
  if (counters.inProgress > 0) return `${base} (${counters.inProgress} in progress)`;
  return base;
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
  const counters = deriveQueueSendProgressCounters(snapshot);
  const { total, current, queued, skipped, failed } = counters;
  const status = normalizeStatus(snapshot.status);

  if (isQueueSendActiveStatus(status) && total > 0 && current >= total) {
    return {
      status: 'done',
      active: false,
      ...counters,
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
      ...counters,
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
    ...counters,
    message: status === 'done'
      ? doneMessage(queued, total, skipped, failed)
      : isQueueSendActiveStatus(status)
        ? activeMessage(snapshot, counters)
        : snapshot.message ?? snapshot.errorMessage ?? 'Queue send failed',
    errorMessage: snapshot.errorMessage ?? null,
    staleReason: null,
  };
}
