import { isQueueSendActiveStatus, type QueueSendStatusName } from './queue-send-status';
import type { QueueSendJobItemInput, QueueSendJobItemState } from './queue-send-item-state';
import type { PrintQueueListScope, QueueSendOrderInput } from '../print-queue';
import type { LabelCreateTimingBreakdown } from '../labels';

export const PRINT_QUEUE_SEND_STATUS_KEY = 'print_queue.batch_send.last_run';
export const PRINT_QUEUE_SEND_JOB_STATUS_PREFIX = 'print_queue.batch_send.job.';

export type QueueSendSnapshotStatus = QueueSendStatusName;

export type QueueSendTimingBreakdown = {
  totalMs: number;
  labelSource?: 'provided' | 'existing' | 'created' | 'recovered' | 'in_progress_recovered' | 'skipped_preflight' | 'failed';
  existingLabelLookupMs?: number;
  labelPurchaseMs?: number;
  labelCreateTimings?: LabelCreateTimingBreakdown;
  inProgressRecoveryMs?: number;
  recoveryLookupMs?: number;
  queueWriteMs?: number;
};

export type QueueSendSnapshotResult = {
  orderId: number;
  orderNumber?: string | number | null;
  success: boolean;
  skipped?: boolean;
  skipReason?: string | null;
  queueEntryId?: string;
  alreadyQueued?: boolean;
  trackingNumber?: string | null;
  error?: string;
  retryEligible?: boolean;
  retryReason?: string | null;
  timings?: QueueSendTimingBreakdown;
};

export type QueueSendSnapshotJob = {
  jobId: string;
  status: QueueSendSnapshotStatus;
  clientIds: number[];
  progress: number;
  total: number;
  current: number;
  queued: number;
  skipped: number;
  failed: number;
  message: string;
  clientId?: number | null;
  createdAt: number;
  updatedAt: number;
  results: QueueSendSnapshotResult[];
  queuedEntryIds: string[];
  errorMessage?: string;
  itemStates?: QueueSendJobItemInput[];
  workerOrders?: QueueSendOrderInput[];
  workerConcurrency?: number | null;
  workerScope?: PrintQueueListScope | null;
  recoveryAttempts?: number;
};

export type QueueSendResultSnapshot = QueueSendSnapshotResult;

export type QueueSendItemSnapshot = {
  orderId: number;
  clientId: number | null;
  state: QueueSendJobItemState;
  blockedReason: string | null;
  errorMessage: string | null;
  queueEntryId: string | null;
  trackingNumber: string | null;
};

export type QueueSendJobSnapshot = {
  version: 1;
  durableKey: typeof PRINT_QUEUE_SEND_STATUS_KEY;
  jobId: string;
  status: QueueSendSnapshotStatus;
  active: boolean;
  clientIds: number[];
  progress: number;
  total: number;
  current: number;
  queued: number;
  skipped: number;
  failed: number;
  message: string;
  clientId: number | null;
  queuedEntryIds: string[];
  errorMessage: string | null;
  results: QueueSendResultSnapshot[];
  resultSamples: QueueSendResultSnapshot[];
  itemStates: QueueSendItemSnapshot[];
  workerOrders: QueueSendOrderInput[];
  workerConcurrency: number | null;
  workerScope: PrintQueueListScope | null;
  recoveryAttempts: number;
  createdAt: string;
  updatedAt: string;
  persistedAt: string;
};

export function queueSendJobStatusKey(jobId: string): string {
  return `${PRINT_QUEUE_SEND_JOB_STATUS_PREFIX}${jobId}`;
}

function toQueueSendResultSnapshot(result: QueueSendSnapshotResult): QueueSendResultSnapshot {
  return {
    orderId: result.orderId,
    orderNumber: result.orderNumber ?? null,
    success: result.success,
    skipped: result.skipped === true,
    skipReason: result.skipReason ?? null,
    queueEntryId: result.queueEntryId,
    alreadyQueued: result.alreadyQueued,
    trackingNumber: result.trackingNumber ?? null,
    error: result.error,
    retryEligible: result.retryEligible,
    retryReason: result.retryReason ?? null,
    timings: result.timings,
  };
}

export function toQueueSendItemSnapshot(item: QueueSendJobItemInput): QueueSendItemSnapshot {
  return {
    orderId: item.orderId,
    clientId: item.clientId ?? null,
    state: item.state,
    blockedReason: item.blockedReason ?? null,
    errorMessage: item.errorMessage ?? null,
    queueEntryId: item.queueEntryId ?? null,
    trackingNumber: item.trackingNumber ?? null,
  };
}

export function queueSendSnapshotResults(snapshot: QueueSendJobSnapshot): QueueSendResultSnapshot[] {
  return Array.isArray(snapshot.results) ? snapshot.results : snapshot.resultSamples;
}

export function toQueueSendSnapshot(
  job: QueueSendSnapshotJob,
  options: { now?: number | Date } = {},
): QueueSendJobSnapshot {
  const results = job.results.map(toQueueSendResultSnapshot);
  const itemStates = (job.itemStates ?? []).map(toQueueSendItemSnapshot);
  const persistedAt = options.now instanceof Date
    ? options.now
    : new Date(options.now ?? Date.now());

  return {
    version: 1,
    durableKey: PRINT_QUEUE_SEND_STATUS_KEY,
    jobId: job.jobId,
    status: job.status,
    active: isQueueSendActiveStatus(job.status),
    clientIds: [...job.clientIds],
    progress: job.progress,
    total: job.total,
    current: job.current,
    queued: job.queued,
    skipped: job.skipped,
    failed: job.failed,
    message: job.message,
    clientId: job.clientId ?? null,
    queuedEntryIds: [...job.queuedEntryIds],
    errorMessage: job.errorMessage ?? null,
    results,
    resultSamples: results.slice(-10),
    itemStates,
    workerOrders: [...(job.workerOrders ?? [])],
    workerConcurrency: job.workerConcurrency ?? null,
    workerScope: job.workerScope ?? null,
    recoveryAttempts: Math.max(0, Math.floor(Number(job.recoveryAttempts ?? 0) || 0)),
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
    persistedAt: persistedAt.toISOString(),
  };
}
