import { randomUUID } from 'node:crypto';
import { normalizeScopeIds, intArraySql } from '../lib/scope-sql';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client';
import { clients } from '../db/schema/clients';
import { orders } from '../db/schema/orders';
import { orderItems } from '../db/schema/order-items';
import { printQueue, type PrintQueueEntry } from '../db/schema/print-queue';
import { settings } from '../db/schema/settings';
import { shipments } from '../db/schema/shipments';
import { env } from '../lib/env';
import { recordLabelOperationLog } from '../lib/label-operation-log';
import { extractShipstationLabelUrl, ssListRecentLabels } from '../lib/shipstation/labels';
import { matchRecoverableLabel } from './print-queue-label-recovery';
import { resolveSecondaryShipstationLabelKey } from './print-queue-secondary-ss-account';
import { ensureShipmentConfirmationLifecycle, processFulfillmentOutboxOnce } from './fulfillment/outbox';
import {
  createLabelV2,
  createShopifyShippingLabelForOrder,
  type CreateLabelInputDto,
  type CreateShopifyShippingLabelInputDto,
  type LabelCreateTimingBreakdown,
} from './labels';
import { SHOPIFY_SHIPPING_PROVIDER } from './shopify-shipping-labels';
import { isLabelPurchaseLockActive } from '../lib/label-purchase-lock';
import type { ClientStoreScope } from '../lib/client-store-scope';
// Per user override unlock shipped data on 2026-07-07: batch-print pipeline — the merge job's
// label fetches now go through a bounded prefetch pool (default concurrency 1 = serial, byte-
// identical on the wire). Fetch mechanics only; ordering/grouping/error branches stay below.
// (env is already imported above for the existing flags.)
import { startLabelPrefetch, type PrefetchResult } from './print-queue-label-prefetch';
// PS-191: structural retry-eligibility classification for purchase failures.
import { classifyLabelPurchaseRetry } from './shipping-workflow/rate-fingerprint';
import { decideShippingSafety } from './fulfillment/shipping-safety';
import {
  collapseIdentityLines,
  resolveQueueLineIdentity,
  headerCardTitle,
  buildQueueSkuIdentityFromItems,
  NO_SKU_PICK_NOTE,
  type CollapsedQueueLine,
} from './print-queue-identity';
// PS-256/PS-428 (restart-safe print-queue merged PDF): the durable side-store owns immutable
// completed chunks so view/download/signed-url routes and worker retries survive process restarts.
import {
  getMergedPdfBase64,
  getMergedPdfChunkBase64,
  getMergedPdfChunks,
  persistMergedPdfChunk,
  cleanupOldMergedPdfs,
  type MergedPdfChunkMetadata,
} from './print-queue-pdf-store';
import { type QueueSendStatusName } from './print-queue/queue-send-status';
import { setJsonSettings } from './settings-json';
import {
  getLatestQueueSendJobRecord,
  getQueueSendJobItemRecords,
  getQueueSendJobRecord,
  persistQueueSendJobCounters,
  persistQueueSendJobItems,
  persistQueueSendJobRecord,
  updateQueueSendJobItemState,
  type QueueSendJobItemInput,
  type QueueSendJobItemState,
} from './print-queue/queue-send-job-store';
import {
  getActivePrintMergeEntryIds,
  getLatestMergeJobRecord,
  getMergeJobRecord,
  persistMergeJobRecord,
  type PrintMergeJobClaim,
  type PrintMergeWorkerInput,
} from './print-queue/merge-job-store';
// Per user override unlock shipped data on 2026-06-30: durable batch-send
// snapshots now delegate to a focused backend module that preserves every
// per-order result, so long queue runs remain auditable after worker fallback.
import {
  PRINT_QUEUE_SEND_STATUS_KEY,
  queueSendJobStatusKey,
  queueSendSnapshotResults,
  toQueueSendSnapshot,
  type QueueSendJobSnapshot,
  type QueueSendItemSnapshot,
} from './print-queue/queue-send-snapshot';
import { preflightQueueSendOrders } from './print-queue/queue-send-preflight';
import {
  enqueuePrintMergeWorkerJob,
  enqueueQueueSendWorkerJob,
} from './print-queue-worker';
import {
  QueueSendJobInterruptedError,
  runQueueSendPool,
  runQueueSendSingleFlight,
} from './print-queue/queue-send-execution';
export {
  PRINT_QUEUE_SEND_STATUS_KEY,
  queueSendJobStatusKey,
  queueSendSnapshotResults,
  toQueueSendSnapshot,
} from './print-queue/queue-send-snapshot';
export type {
  QueueSendJobSnapshot,
  QueueSendResultSnapshot,
} from './print-queue/queue-send-snapshot';

// PS-138: the pure PDF-rendering helpers live in ./print-queue-pdf. runMergeJob + the staying
// recipient/DB loaders import them here; the external surface is re-exported so the 8 guard/cert
// scripts that import these names from '../src/services/print-queue' keep resolving unchanged.
import {
  appendNormalizedLabelPages,
  renderBatchHeaderPdfForTest,
  drawHeader,
  addBatchManifestPages,
  drawMockFallbackLabel,
  buildComboSummaryLine,
  BATCH_NAMES_HEADER_THRESHOLD,
  resolveRecipientDisplayName,
  sortBatchRecipients,
  annotateDuplicateNames,
  planBatchNamesDisplay,
  type BatchRecipient,
} from './print-queue-pdf';
export {
  appendNormalizedLabelPages,
  renderBatchHeaderPdfForTest,
  resolveRecipientDisplayName,
  sortBatchRecipients,
  annotateDuplicateNames,
  planBatchNamesDisplay,
  BATCH_NAMES_HEADER_THRESHOLD,
};
export type { BatchRecipient };

// PS-138: appendNormalizedLabelPages moved to ./print-queue-pdf (imported + re-exported above).

export type AddToQueueInput = {
  clientId: number;
  orderId: string;
  orderNumber?: string | null;
  labelUrl: unknown;
  skuGroupId: string;
  primarySku?: string | null;
  itemDescription?: string | null;
  orderQty?: number;
  multiSkuData?: { sku: string; description?: string; qty: number }[] | null;
  scope?: PrintQueueListScope;
};

export type MergeJobChunk = {
  chunkNumber: number;
  status: 'pending' | 'running' | 'done' | 'error';
  labelCount: number;
  fileName?: string;
  fileSize?: number;
  pdfUrl?: string | null;
  errorMessage?: string | null;
  entryIds: string[];
  successfulEntryIds: string[];
  mergedPdfBase64?: string;
  createdAt: number;
};

export type MergeJob = {
  jobId: string;
  generation: number;
  status: 'pending' | 'running' | 'done' | 'error';
  clientIds: number[];
  progress: number;
  total: number;
  current: number;
  message: string;
  mergedPdfBase64?: string;
  fileName?: string;
  chunks: MergeJobChunk[];
  errorMessage?: string;
  labelErrors?: string[];
  // PS-194: the entries that ACTUALLY merged into the batch PDF. Previously
  // computed inside runMergeJob and discarded after the count â€” so the FE's
  // Confirm-Printed gate ran on a session-only Set that a page refresh wiped.
  // Persisted on the job + durable snapshot and returned on the status DTO so
  // the gate is backend truth.
  successfulEntryIds: string[];
  // PS-195: every entry this merge covers â€” clearQueue refuses to delete an
  // entry that sits inside a pending/running merge job.
  entryIds: string[];
  createdAt: number;
  updatedAt: number;
};

type QueueSendCarrierLabelInput = Omit<CreateLabelInputDto, 'orderId' | 'orderNumber'> & {
  orderId?: number;
  orderNumber?: string;
};

type QueueSendShopifyLabelInput = Omit<CreateShopifyShippingLabelInputDto, 'orderId'> & {
  provider?: typeof SHOPIFY_SHIPPING_PROVIDER | 'shopify';
  orderId?: number;
  orderNumber?: string;
};

export type QueueSendOrderInput = {
  orderId: number;
  clientId: number;
  orderNumber?: string | null;
  labelUrl?: unknown | null;
  label?: QueueSendCarrierLabelInput | QueueSendShopifyLabelInput;
  skuGroupId: string;
  primarySku?: string | null;
  itemDescription?: string | null;
  orderQty?: number;
  multiSkuData?: { sku: string; description?: string; qty: number }[] | null;
  scope?: PrintQueueListScope;
};

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

export type QueueSendJobResult = {
  orderId: number;
  orderNumber?: string | number | null;
  success: boolean;
  skipped?: boolean;
  skipReason?: string | null;
  queueEntryId?: string;
  alreadyQueued?: boolean;
  labelUrl?: string | null;
  trackingNumber?: string | null;
  error?: string;
  // PS-191: backend-owned retry eligibility on purchase failures (structural
  // proof-error classification â€” classifyLabelPurchaseRetry). The FE prompts
  // a re-rate on eligible failures; it never auto-repurchases.
  retryEligible?: boolean;
  retryReason?: string | null;
  timings?: QueueSendTimingBreakdown;
};

export type QueueSendPreflightSkipInput = {
  orderId: number;
  clientId: number | null;
  orderNumber?: string | number | null;
  reason?: string | null;
  retryEligible?: boolean;
  retryReason?: string | null;
};

export type QueueSendJob = {
  jobId: string;
  status: QueueSendStatusName;
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
  results: QueueSendJobResult[];
  queuedEntryIds: string[];
  itemStates: QueueSendItemSnapshot[];
  errorMessage?: string;
  workerOrders?: QueueSendOrderInput[];
  workerConcurrency?: number | null;
  workerScope?: PrintQueueListScope | null;
  recoveryAttempts?: number;
};

export const PRINT_QUEUE_MERGE_STATUS_KEY = 'print_queue.pdf_merge.last_run';

export type MergeJobSnapshot = {
  version: 1;
  durableKey: typeof PRINT_QUEUE_MERGE_STATUS_KEY;
  jobId: string;
  generation: number;
  status: MergeJob['status'];
  active: boolean;
  clientIds: number[];
  progress: number;
  total: number;
  current: number;
  message: string;
  fileName: string | null;
  errorMessage: string | null;
  labelErrors: string[];
  chunks: MergeJobChunkSnapshot[];
  // PS-194: optional for back-compat with snapshots persisted before the
  // field existed â€” readers default to [].
  successfulEntryIds?: string[];
  entryIds?: string[];
  createdAt: string;
  persistedAt: string;
};

export type MergeJobChunkSnapshot = {
  chunkNumber: number;
  status: MergeJobChunk['status'];
  labelCount: number;
  fileName: string | null;
  fileSize: number | null;
  pdfUrl: string | null;
  errorMessage: string | null;
  entryIds: string[];
  successfulEntryIds: string[];
  createdAt: string;
};

export type PrintQueueListScope = {
  scopeClientIds?: number[];
  scopeStoreIds?: number[];
  scopeRestricted?: boolean;
};

function queueWorkerClientStoreScope(scope: PrintQueueListScope): ClientStoreScope {
  const clientIds = normalizeScopeIds(scope.scopeClientIds);
  const storeIds = normalizeScopeIds(scope.scopeStoreIds);
  const isGlobal = scope.scopeRestricted === false;
  return {
    clientIds,
    storeIds,
    isGlobal,
    isRestricted: !isGlobal,
  };
}

const mergeJobs = new Map<string, MergeJob>();
const queueSendJobs = new Map<string, QueueSendJob>();
type QueueSendWorkerRunResult = {
  ok: true;
  jobId: string;
  skipped?: string;
  remaining: number;
};
export const PRINT_QUEUE_PDF_CHUNK_SIZE = 50;
const QUEUE_SEND_WORKER_MAX_CONCURRENCY = 4;
const QUEUE_SEND_PROVIDER_PENDING_AFTER_MS = 90_000;
const QUEUE_SEND_IN_PROGRESS_RECOVERY_MS = 60_000;
const QUEUE_SEND_IN_PROGRESS_RECOVERY_POLL_MS = 1_500;

export type PrintQueuePdfChunkPlan<T> = {
  chunkNumber: number;
  items: T[];
};

export function planPrintQueuePdfChunks<T>(
  items: T[],
  chunkSize = PRINT_QUEUE_PDF_CHUNK_SIZE,
): Array<PrintQueuePdfChunkPlan<T>> {
  const safeSize = Math.max(1, Math.trunc(chunkSize));
  const chunks: Array<PrintQueuePdfChunkPlan<T>> = [];
  for (let start = 0; start < items.length; start += safeSize) {
    chunks.push({
      chunkNumber: chunks.length + 1,
      items: items.slice(start, start + safeSize),
    });
  }
  return chunks;
}

export class PrintQueueLabelUrlError extends Error {
  status = 400 as const;
  code = 'INVALID_LABEL_URL' as const;

  constructor(message: string) {
    super(message);
    this.name = 'PrintQueueLabelUrlError';
  }
}

export function isPrintQueueLabelUrlError(err: unknown): err is PrintQueueLabelUrlError {
  return err instanceof PrintQueueLabelUrlError;
}

export class PrintQueueAccessError extends Error {
  status = 403 as const;
  code = 'PRINT_QUEUE_FORBIDDEN' as const;

  constructor(message = 'One or more print queue clients are not authorized') {
    super(message);
    this.name = 'PrintQueueAccessError';
  }
}

export function isPrintQueueAccessError(err: unknown): err is PrintQueueAccessError {
  return err instanceof PrintQueueAccessError;
}

export class PrintQueueDurableStatusError extends Error {
  status = 503 as const;
  code = 'PRINT_QUEUE_STATUS_UNAVAILABLE' as const;

  constructor(message = 'Print queue status could not be saved. Please retry in a moment.') {
    super(message);
    this.name = 'PrintQueueDurableStatusError';
  }
}

export function isPrintQueueDurableStatusError(err: unknown): err is PrintQueueDurableStatusError {
  return err instanceof PrintQueueDurableStatusError;
}

export class PrintQueueAlreadyFinalizedError extends Error {
  status = 409 as const;
  code = 'PRINT_QUEUE_ALREADY_FINALIZED' as const;

  constructor(orderRef: string | number, status: string) {
    super(
      `Order ${orderRef} already has a ${status} print-queue history row; ` +
      'it was not re-queued automatically. Confirm an intentional reprint before queueing again.',
    );
    this.name = 'PrintQueueAlreadyFinalizedError';
  }
}

export function isPrintQueueAlreadyFinalizedError(err: unknown): err is PrintQueueAlreadyFinalizedError {
  return err instanceof PrintQueueAlreadyFinalizedError;
}

class QueueSendStaleLabelAttemptError extends Error {
  readonly code = 'QUEUE_SEND_STALE_LABEL_ATTEMPT' as const;
  readonly retryReason = 'stale_label_purchase_attempt' as const;

  constructor(orderId: number) {
    super(
      `Previous label attempt for order ${orderId} timed out or was interrupted. No active purchase lock, shipment label, or queued label was found; verify ShipStation/order history, then retry Send to Queue.`
    );
    this.name = 'QueueSendStaleLabelAttemptError';
  }
}

function isQueueSendStaleLabelAttemptError(err: unknown): err is QueueSendStaleLabelAttemptError {
  return err instanceof QueueSendStaleLabelAttemptError ||
    (err as { code?: unknown } | null)?.code === 'QUEUE_SEND_STALE_LABEL_ATTEMPT';
}

// Per user override unlock shipped data on 2026-05-23: shipped-label queue
// handling unwraps known provider label URL objects while still rejecting empty/corrupt values.
function normalizePrintQueueLabelUrl(labelUrl: unknown): string {
  const normalized = typeof labelUrl === 'string'
    ? labelUrl
    : extractShipstationLabelUrl(labelUrl);
  if (typeof normalized !== 'string') {
    throw new PrintQueueLabelUrlError('Label URL must resolve to a string.');
  }
  const trimmed = normalized.trim();
  if (trimmed.length === 0) {
    throw new PrintQueueLabelUrlError('Label URL is required.');
  }
  if (trimmed === '[object Object]') {
    throw new PrintQueueLabelUrlError('Label URL is invalid. Re-create the label and try again.');
  }
  return trimmed;
}

function formatLabelUrlError(entry: PrintQueueEntry, err: unknown): string {
  const orderRef = entry.orderNumber ?? entry.orderId;
  const message = isPrintQueueLabelUrlError(err)
    ? err.message
    : err instanceof Error
      ? err.message
      : 'Invalid label URL.';
  return `Invalid label URL for order ${orderRef}: ${message}`;
}

function collectInvalidLabelErrors(entries: PrintQueueEntry[]): string[] {
  const errors: string[] = [];
  for (const entry of entries) {
    try {
      normalizePrintQueueLabelUrl(entry.labelUrl);
    } catch (err) {
      errors.push(formatLabelUrlError(entry, err));
    }
  }
  return errors;
}

function toMergeChunkSnapshot(chunk: MergeJobChunk): MergeJobChunkSnapshot {
  return {
    chunkNumber: chunk.chunkNumber,
    status: chunk.status,
    labelCount: chunk.labelCount,
    fileName: chunk.fileName ?? null,
    fileSize: chunk.fileSize ?? null,
    pdfUrl: chunk.pdfUrl ?? null,
    errorMessage: chunk.errorMessage ?? null,
    entryIds: (chunk.entryIds ?? []).slice(0, 5000),
    successfulEntryIds: (chunk.successfulEntryIds ?? []).slice(0, 5000),
    createdAt: new Date(chunk.createdAt).toISOString(),
  };
}

function mergeChunkFromSnapshot(chunk: MergeJobChunkSnapshot): MergeJobChunk {
  return {
    chunkNumber: chunk.chunkNumber,
    status: chunk.status,
    labelCount: chunk.labelCount,
    fileName: chunk.fileName ?? undefined,
    fileSize: chunk.fileSize ?? undefined,
    pdfUrl: chunk.pdfUrl,
    errorMessage: chunk.errorMessage,
    entryIds: chunk.entryIds ?? [],
    successfulEntryIds: chunk.successfulEntryIds ?? [],
    createdAt: Date.parse(chunk.createdAt) || Date.now(),
  };
}

function normalizeMergeChunkStatus(status: string): MergeJobChunk['status'] {
  return status === 'pending' || status === 'running' || status === 'done' || status === 'error'
    ? status
    : 'done';
}

function mergeChunkFromMetadata(chunk: MergedPdfChunkMetadata): MergeJobChunk {
  return {
    chunkNumber: chunk.chunkNumber,
    status: normalizeMergeChunkStatus(chunk.status),
    labelCount: chunk.labelCount,
    fileName: chunk.fileName ?? undefined,
    fileSize: chunk.fileSize,
    pdfUrl: null,
    errorMessage: chunk.errorMessage,
    entryIds: chunk.entryIds ?? [],
    successfulEntryIds: chunk.successfulEntryIds ?? [],
    createdAt: chunk.createdAt ? Date.parse(chunk.createdAt) || Date.now() : Date.now(),
  };
}

function toMergeSnapshot(job: MergeJob): MergeJobSnapshot {
  job.updatedAt = Math.max(Date.now(), job.updatedAt + 1);
  return {
    version: 1,
    durableKey: PRINT_QUEUE_MERGE_STATUS_KEY,
    jobId: job.jobId,
    generation: job.generation,
    status: job.status,
    active: job.status === 'pending' || job.status === 'running',
    clientIds: [...job.clientIds],
    progress: job.progress,
    total: job.total,
    current: job.current,
    message: job.message,
    fileName: job.fileName ?? null,
    errorMessage: job.errorMessage ?? null,
    labelErrors: (job.labelErrors ?? []).slice(-10),
    chunks: (job.chunks ?? []).map(toMergeChunkSnapshot),
    // PS-194: capped well above the 200-entry batch limit; the durable
    // snapshot is what lets Confirm-Printed survive a page refresh.
    successfulEntryIds: (job.successfulEntryIds ?? []).slice(0, 5000),
    entryIds: (job.entryIds ?? []).slice(0, 5000),
    createdAt: new Date(job.createdAt).toISOString(),
    persistedAt: new Date(job.updatedAt).toISOString(),
  };
}

export async function persistQueueSendJobSnapshot(
  job: QueueSendJob,
  options: { required?: boolean } & { persistItems?: boolean; persistLegacy?: boolean; countersOnly?: boolean } = {},
): Promise<void> {
  const snapshot = toQueueSendSnapshot(job);
  try {
    if (options.countersOnly) {
      // Audit PQ-7 (2026-07-13): per-order progress writes only the scalar
      // counters — the full jsonb snapshot (workerOrders + all results) was
      // being rewritten after EVERY order, an O(n^2) write stream on big
      // batches and exactly the load that hurts during degraded-DB windows.
      await persistQueueSendJobCounters({
        jobId: snapshot.jobId,
        status: snapshot.status,
        active: snapshot.active,
        progress: snapshot.progress,
        total: snapshot.total,
        current: snapshot.current,
        queued: snapshot.queued,
        failed: snapshot.failed,
        message: snapshot.message ?? null,
        updatedAt: snapshot.updatedAt,
      });
      return;
    }
    await persistQueueSendJobRecord(snapshot);
    if (options.persistItems !== false) {
      await persistQueueSendJobItems(snapshot.jobId, snapshot.itemStates);
    }
  } catch (err) {
    console.warn(
      '[print-queue] failed to persist durable batch-send job:',
      err instanceof Error ? err.message : err
    );
    if (options.required) {
      throw new PrintQueueDurableStatusError();
    }
    return;
  }

  if (options.persistLegacy !== false) {
    try {
      await persistLegacyQueueSendSettingsSnapshot(snapshot);
    } catch (err) {
      console.warn(
        '[print-queue] failed to persist legacy batch-send status:',
        err instanceof Error ? err.message : err
      );
    }
  }
}

async function persistLegacyQueueSendSettingsSnapshot(snapshot: QueueSendJobSnapshot): Promise<void> {
  const jobKey = queueSendJobStatusKey(snapshot.jobId);
  await setJsonSettings([
    { key: PRINT_QUEUE_SEND_STATUS_KEY, value: snapshot },
    { key: jobKey, value: snapshot },
  ]);
}

async function withFreshQueueSendItemStates(
  snapshot: QueueSendJobSnapshot,
): Promise<QueueSendJobSnapshot> {
  const records = await getQueueSendJobItemRecords(snapshot.jobId);
  if (records.length === 0) return snapshot;
  const snapshotUpdatedAt = Date.parse(snapshot.updatedAt);
  const latestItemUpdatedAt = records.reduce((latest, record) => {
    const timestamp = record.updatedAt ? Date.parse(record.updatedAt) : Number.NaN;
    return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
  }, Number.isFinite(snapshotUpdatedAt) ? snapshotUpdatedAt : 0);
  return {
    ...snapshot,
    itemStates: records.map(toQueueSendItemSnapshot),
    updatedAt: Number.isFinite(latestItemUpdatedAt)
      ? new Date(latestItemUpdatedAt).toISOString()
      : snapshot.updatedAt,
  };
}

export async function getQueueSendJobSnapshot(jobId: string): Promise<QueueSendJobSnapshot | null> {
  const durableJob = await getQueueSendJobRecord(jobId);
  if (durableJob) return withFreshQueueSendItemStates(durableJob);

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, queueSendJobStatusKey(jobId)))
      .limit(1);
    if (!row?.value) return null;
    return JSON.parse(row.value) as QueueSendJobSnapshot;
  } catch (err) {
    console.warn(
      '[print-queue] failed to read batch-send job status:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

// Per user override unlock shipped data on 2026-07-14: PDF-merge durability
// stores job/artifact metadata only; it does not create labels or mutate orders,
// shipments, postage, marketplace state, or the shipped/cancelled lock policy.
export async function persistMergeJobSnapshot(
  job: MergeJob,
  options: {
    required?: boolean;
    persistLegacy?: boolean;
    workerInput?: PrintMergeWorkerInput;
  } = {},
): Promise<boolean> {
  const snapshot = toMergeSnapshot(job);
  let persisted = false;
  try {
    persisted = await persistMergeJobRecord(snapshot, { input: options.workerInput });
    if (!persisted && options.required) {
      throw new PrintQueueDurableStatusError(
        `PDF merge generation ${job.generation} is stale and cannot write durable state.`,
      );
    }
  } catch (err) {
    console.warn(
      '[print-queue] failed to persist per-job PDF-merge status:',
      err instanceof Error ? err.message : err,
    );
    if (options.required) {
      if (err instanceof PrintQueueDurableStatusError) throw err;
      throw new PrintQueueDurableStatusError();
    }
  }

  if (!persisted || options.persistLegacy === false) return persisted;
  try {
    const value = JSON.stringify(snapshot);
    await db
      .insert(settings)
      .values({ key: PRINT_QUEUE_MERGE_STATUS_KEY, value })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value },
      });
  } catch (err) {
    console.warn(
      '[print-queue] failed to persist PDF-merge status:',
      err instanceof Error ? err.message : err
    );
  }
  return persisted;
}

export async function getLatestQueueSendJobSnapshot(): Promise<QueueSendJobSnapshot | null> {
  const durableJob = await getLatestQueueSendJobRecord();
  if (durableJob) return withFreshQueueSendItemStates(durableJob);

  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, PRINT_QUEUE_SEND_STATUS_KEY))
      .limit(1);
    if (!row?.value) return null;
    return JSON.parse(row.value) as QueueSendJobSnapshot;
  } catch (err) {
    console.warn(
      '[print-queue] failed to read batch-send durable status:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

async function getLegacyLatestMergeJobSnapshot(): Promise<MergeJobSnapshot | null> {
  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, PRINT_QUEUE_MERGE_STATUS_KEY))
      .limit(1);
    if (!row?.value) return null;
    return JSON.parse(row.value) as MergeJobSnapshot;
  } catch (err) {
    console.warn(
      '[print-queue] failed to read PDF-merge durable status:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

export async function getLatestMergeJobSnapshot(): Promise<MergeJobSnapshot | null> {
  const durableJob = await getLatestMergeJobRecord();
  return durableJob ?? getLegacyLatestMergeJobSnapshot();
}

export async function getMergeJobSnapshot(jobId: string): Promise<MergeJobSnapshot | null> {
  const durableJob = await getMergeJobRecord(jobId);
  if (durableJob) return durableJob;

  const legacyLatest = await getLegacyLatestMergeJobSnapshot();
  return legacyLatest?.jobId === jobId ? legacyLatest : null;
}

const QUEUE_SEND_PROGRESS_SNAPSHOT_OPTIONS = {
  persistItems: false,
  persistLegacy: false,
  // Audit PQ-7: progress ticks persist scalar counters only, never the full jsonb.
  countersOnly: true,
} as const;

function shouldPersistMergeProgress(current: number, total: number): boolean {
  return current === total || current % 10 === 0;
}

// PS-256: durable merged PDFs are retained LONGER than the 30-min in-memory job retention so a
// download still works through a restart window (an operator who reopens the batch after the
// process recycled). 4h is well past the in-memory eviction yet bounded so old binaries don't
// accumulate. Best-effort cleanup affects durable PDF artifacts only.
const DURABLE_PDF_RETENTION_MS = 4 * 60 * 60 * 1000;

function cleanOldJobs() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of mergeJobs.entries()) {
    if (job.createdAt < cutoff) mergeJobs.delete(id);
  }
  for (const [id, job] of queueSendJobs.entries()) {
    if (job.createdAt < cutoff) queueSendJobs.delete(id);
  }
  // Per user override unlock shipped data on 2026-06-16: PS-256 â€” prune old rows from the durable
  // merged-PDF side-store (the NEW print_queue_merged_pdfs table only). DELETEs nothing from
  // orders/shipments; best-effort artifact cleanup only.
  void cleanupOldMergedPdfs(DURABLE_PDF_RETENTION_MS);
}

function updateQueueSendProgress(job: QueueSendJob) {
  job.progress = job.total > 0 ? Math.round((job.current / job.total) * 100) : 100;
  job.updatedAt = Math.max(Date.now(), job.updatedAt + 1);
  job.message =
    job.status === 'done'
      ? `Queued ${job.queued}/${job.total}${job.skipped ? `, ${job.skipped} skipped` : ''}${job.failed ? `, ${job.failed} failed` : ''}`
      : `Sending to queue ${job.current}/${job.total}`;
}

function normalizeQueueSendWorkerConcurrency(
  value: unknown,
  readyOrderCount = QUEUE_SEND_WORKER_MAX_CONCURRENCY
): number {
  const parsed = Number(value);
  const requested = Number.isFinite(parsed) ? Math.floor(parsed) : QUEUE_SEND_WORKER_MAX_CONCURRENCY;
  const boundedReadyOrderCount = Math.max(1, Math.floor(readyOrderCount));
  return Math.max(
    1,
    Math.min(
      QUEUE_SEND_WORKER_MAX_CONCURRENCY,
      boundedReadyOrderCount,
      requested || QUEUE_SEND_WORKER_MAX_CONCURRENCY
    )
  );
}

async function markQueueSendWorkerUnavailable(job: QueueSendJob, reason: string): Promise<void> {
  const reportedOrderIds = new Set(job.results.map((result) => result.orderId));
  const unavailableResults = (job.workerOrders ?? [])
    .filter((order) => !reportedOrderIds.has(order.orderId))
    .map((order): QueueSendJobResult => ({
      orderId: order.orderId,
      orderNumber: order.orderNumber ?? null,
      success: false,
      error: reason,
      timings: { totalMs: 0, labelSource: 'failed' },
    }));
  recordQueueSendResultLogs(job, unavailableResults);
  job.status = 'error';
  job.errorMessage = reason;
  job.message = reason;
  updateQueueSendProgress(job);
  await persistQueueSendJobSnapshot(job, { required: true });
  queueSendJobs.delete(job.jobId);
}

function timestampFromSnapshot(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function queueSendJobFromSnapshot(snapshot: QueueSendJobSnapshot): QueueSendJob {
  return {
    jobId: snapshot.jobId,
    status: snapshot.status,
    clientIds: [...snapshot.clientIds],
    progress: snapshot.progress,
    total: snapshot.total,
    current: snapshot.current,
    queued: snapshot.queued,
    skipped: Number.isFinite(snapshot.skipped) ? snapshot.skipped : 0,
    failed: snapshot.failed,
    message: snapshot.message,
    clientId: snapshot.clientId,
    createdAt: timestampFromSnapshot(snapshot.createdAt),
    updatedAt: timestampFromSnapshot(snapshot.updatedAt),
    results: queueSendSnapshotResults(snapshot),
    queuedEntryIds: [...snapshot.queuedEntryIds],
    itemStates: snapshot.itemStates ?? [],
    errorMessage: snapshot.errorMessage ?? undefined,
    workerOrders: snapshot.workerOrders ?? [],
    workerConcurrency: snapshot.workerConcurrency ?? null,
    workerScope: snapshot.workerScope ?? null,
    recoveryAttempts: Math.max(0, Math.floor(Number(snapshot.recoveryAttempts ?? 0) || 0)),
  };
}

function getExistingLabelUrl(err: unknown): string | null {
  const details = (err as { details?: Record<string, unknown> })?.details;
  const labelUrl = details?.labelUrl;
  return typeof labelUrl === 'string' && labelUrl ? labelUrl : null;
}

async function findExistingQueueableLabelForOrder(orderId: number): Promise<string | null> {
  // Per user override unlock shipped data on 2026-05-23: read-only recovery for
  // shipped orders whose label exists but was not queued after creation.
  const [row] = await db
    .select({
      id: shipments.id,
      labelUrl: shipments.labelUrl,
      labelFormat: shipments.labelFormat,
      trackingNumber: shipments.trackingNumber,
      labelShipmentId: shipments.labelShipmentId,
    })
    .from(shipments)
    .where(
      and(
        eq(shipments.orderId, orderId),
        eq(shipments.voided, false),
        eq(shipments.isReturn, false)
      )
    )
    .orderBy(desc(shipments.createdAt))
    .limit(1);

  if (!row) return null;
  if (row.labelUrl) return normalizePrintQueueLabelUrl(row.labelUrl);

  // PS-288 â€” the local label_url went NULL (shipment-sync never wrote it; ~72% of synced shipped
  // shipments, so "Send to Queue" greys out even though the label was already purchased). Recover the
  // EXISTING ShipStation label by tracking number, then label_id â€” a READ of /v2/labels, never a new
  // postage purchase. No match => return null (no guess).
  const recoveryKey = { trackingNumber: row.trackingNumber, labelShipmentId: row.labelShipmentId };
  let recovered = matchRecoverableLabel(await ssListRecentLabels(), recoveryKey);

  // PS-288 (continuation) â€” the label may have been bought on the SECOND ShipStation account
  // (the KFG account â€” env SHIPSTATION_KFG_API_KEY_V2), which the PRIMARY account's recent labels
  // never list. When the primary set had no match, ALSO read the second account's recent labels and
  // re-run the SAME exact-match matchRecoverableLabel (tracking, then label_id), so a second
  // account can never produce a cross-account false positive. Still a READ of /v2/labels â€” never a
  // new postage purchase. No second account configured (or no match there) => null (no guess).
  if (!recovered) {
    const secondaryKey = resolveSecondaryShipstationLabelKey(process.env);
    if (secondaryKey) {
      recovered = matchRecoverableLabel(await ssListRecentLabels(secondaryKey), recoveryKey);
    }
  }
  if (!recovered?.labelUrl) return null;
  // Per user override unlock shipped data on 2026-06-18: PS-288 â€” backfill ONLY the recovered
  // label_url + the ALREADY-purchased label's OWN label_format (from /v2/labels) onto this existing
  // (non-voided) shipment row; only fall back to the row's stored format (then 'pdf') when the
  // recovered label didn't carry one. No other shipped/cancelled column is written, no postage is
  // bought, no shipment is created/voided. This is the documented label_url sync gap (recoverable
  // via tracking/label_id) â€” the format source is now the real label, not the stale local default.
  await db
    .update(shipments)
    .set({ labelUrl: recovered.labelUrl, labelFormat: recovered.labelFormat ?? row.labelFormat ?? 'pdf' })
    .where(eq(shipments.id, row.id));
  return normalizePrintQueueLabelUrl(recovered.labelUrl);
}

async function findExistingQueuedLabelForOrder(
  order: Pick<QueueSendOrderInput, 'orderId' | 'clientId'>,
): Promise<string | null> {
  const [row] = await db
    .select({ labelUrl: printQueue.labelUrl })
    .from(printQueue)
    .where(
      and(
        eq(printQueue.orderId, String(order.orderId)),
        eq(printQueue.clientId, order.clientId),
        eq(printQueue.status, 'queued'),
      ),
    )
    .limit(1);

  if (!row?.labelUrl) return null;
  return normalizePrintQueueLabelUrl(row.labelUrl);
}

async function findExistingQueueSendLabel(
  order: Pick<QueueSendOrderInput, 'orderId' | 'clientId'>,
): Promise<string | null> {
  // Per user override unlock shipped data on 2026-05-23: Send-to-Queue may reuse an
  // already queued label or recover an existing purchased shipment label; it never
  // creates/voids shipped history or buys duplicate postage in this lookup.
  return await findExistingQueuedLabelForOrder(order) ?? await findExistingQueueableLabelForOrder(order.orderId);
}

function printQueueScopePredicate(scope: PrintQueueListScope): SQL {
  const clientIds = normalizeScopeIds(scope.scopeClientIds);
  const storeIds = normalizeScopeIds(scope.scopeStoreIds);
  const predicates: SQL[] = [];

  if (clientIds.length) {
    predicates.push(sql`${printQueue.clientId} = any(${intArraySql(clientIds)})`);
  }
  if (storeIds.length) {
    predicates.push(sql`exists (
      select 1 from ${clients}
      where ${clients.id} = ${printQueue.clientId}
        and ${clients.storeIds} && ${intArraySql(storeIds)}
    )`);
  }
  if (!predicates.length) {
    return scope.scopeRestricted === true ? sql`false` : sql`true`;
  }
  if (predicates.length === 1) return predicates[0]!;
  return sql`(${sql.join(predicates, sql` or `)})`;
}

function printQueueClientScopePredicate(scope: PrintQueueListScope): SQL {
  const clientIds = normalizeScopeIds(scope.scopeClientIds);
  const storeIds = normalizeScopeIds(scope.scopeStoreIds);
  const predicates: SQL[] = [];

  if (clientIds.length) {
    predicates.push(sql`${clients.id} = any(${intArraySql(clientIds)})`);
  }
  if (storeIds.length) {
    predicates.push(sql`${clients.storeIds} && ${intArraySql(storeIds)}`);
  }
  if (!predicates.length) {
    return scope.scopeRestricted === true ? sql`false` : sql`true`;
  }
  if (predicates.length === 1) return predicates[0]!;
  return sql`(${sql.join(predicates, sql` or `)})`;
}

function normalizeClientIds(values: Array<number | null | undefined>): number[] {
  return Array.from(
    new Set(
      values
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );
}

export async function assertPrintQueueClientsVisible(
  clientIds: number[],
  scope: PrintQueueListScope = {}
): Promise<void> {
  const ids = normalizeClientIds(clientIds);
  if (!ids.length) return;
  if (
    scope.scopeRestricted !== true &&
    !normalizeScopeIds(scope.scopeClientIds).length &&
    !normalizeScopeIds(scope.scopeStoreIds).length
  ) {
    return;
  }

  const rows = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(inArray(clients.id, ids), printQueueClientScopePredicate(scope)));

  if (rows.length !== ids.length) {
    throw new PrintQueueAccessError();
  }
}

export async function canViewQueueSendJob(
  job: QueueSendJob,
  scope: PrintQueueListScope = {}
): Promise<boolean> {
  try {
    await assertPrintQueueClientsVisible(job.clientIds, scope);
    return true;
  } catch {
    return false;
  }
}

export async function canViewMergeJob(
  job: MergeJob,
  scope: PrintQueueListScope = {}
): Promise<boolean> {
  try {
    await assertPrintQueueClientsVisible(job.clientIds, scope);
    return true;
  } catch {
    return false;
  }
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function toQueueSendItemSnapshot(input: QueueSendJobItemInput): QueueSendItemSnapshot {
  return {
    orderId: input.orderId,
    clientId: input.clientId ?? null,
    state: input.state,
    blockedReason: input.blockedReason ?? null,
    errorMessage: input.errorMessage ?? null,
    queueEntryId: input.queueEntryId ?? null,
    trackingNumber: input.trackingNumber ?? null,
  };
}

function preflightSkipReason(skip: QueueSendPreflightSkipInput): string {
  const reason = typeof skip.reason === 'string' ? skip.reason.trim() : '';
  return reason || 'Preflight blocked before queue send';
}

function preflightSkipBlockedReason(skip: QueueSendPreflightSkipInput): string {
  const retryReason = typeof skip.retryReason === 'string' ? skip.retryReason.trim() : '';
  return retryReason || 'frontend_preflight';
}

function toQueueSendPreflightSkipResult(skip: QueueSendPreflightSkipInput): QueueSendJobResult {
  const reason = preflightSkipReason(skip);
  return {
    orderId: skip.orderId,
    orderNumber: skip.orderNumber ?? null,
    success: false,
    skipped: true,
    skipReason: reason,
    error: reason,
    retryEligible: skip.retryEligible === true,
    retryReason: preflightSkipBlockedReason(skip),
    timings: { totalMs: 0, labelSource: 'skipped_preflight' },
  };
}

function toQueueSendPreflightSkipItem(skip: QueueSendPreflightSkipInput): QueueSendJobItemInput {
  return {
    orderId: skip.orderId,
    clientId: skip.clientId ?? null,
    state: 'skipped_preflight',
    blockedReason: preflightSkipBlockedReason(skip),
    errorMessage: preflightSkipReason(skip),
  };
}

async function setQueueSendItemState(
  job: QueueSendJob,
  order: Pick<QueueSendOrderInput, 'orderId' | 'clientId'>,
  patch: {
    state: QueueSendJobItemState;
    blockedReason?: string | null;
    errorMessage?: string | null;
    queueEntryId?: string | null;
    trackingNumber?: string | null;
  },
): Promise<void> {
  const item: QueueSendJobItemInput = {
    orderId: order.orderId,
    clientId: order.clientId,
    state: patch.state,
    blockedReason: patch.blockedReason ?? null,
    errorMessage: patch.errorMessage ?? null,
    queueEntryId: patch.queueEntryId ?? null,
    trackingNumber: patch.trackingNumber ?? null,
  };
  const snapshot = toQueueSendItemSnapshot(item);
  const existingIndex = job.itemStates.findIndex((candidate) => candidate.orderId === order.orderId);
  if (existingIndex >= 0) job.itemStates[existingIndex] = snapshot;
  else job.itemStates.push(snapshot);
  job.updatedAt = Date.now();
  await updateQueueSendJobItemState(job.jobId, order.orderId, item);
}

async function timeQueueStep<T>(
  timings: QueueSendTimingBreakdown,
  key: Exclude<keyof QueueSendTimingBreakdown, 'totalMs' | 'labelSource' | 'labelCreateTimings'>,
  task: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await task();
  } finally {
    timings[key] = (timings[key] ?? 0) + elapsedSince(startedAt);
  }
}

function withTotalTiming(result: QueueSendJobResult, startedAt: number): QueueSendJobResult {
  return {
    ...result,
    timings: {
      ...(result.timings ?? {}),
      totalMs: elapsedSince(startedAt),
    },
  };
}

function isShopifyQueueLabelInput(label: QueueSendOrderInput['label']): label is QueueSendShopifyLabelInput {
  const provider = String((label as { provider?: unknown } | undefined)?.provider ?? '').trim().toLowerCase();
  return provider === 'shopify_shipping' || provider === SHOPIFY_SHIPPING_PROVIDER || provider === 'shopify';
}

function queueSendLogCause(result: QueueSendJobResult): string {
  if (result.success) {
    if (result.alreadyQueued) return 'Label already in print queue';
    switch (result.timings?.labelSource) {
      case 'created':
        return 'Label created and added to print queue';
      case 'existing':
      case 'recovered':
      case 'in_progress_recovered':
        return 'Existing label added to print queue';
      case 'provided':
        return 'Provided label added to print queue';
      default:
        return 'Added to print queue';
    }
  }
  return result.skipReason ?? result.error ?? 'Queue send failed';
}

function recordQueueSendResultLogs(job: QueueSendJob, results: QueueSendJobResult[]): void {
  for (const result of results) {
    recordLabelOperationLog({
      action: 'print_queue',
      status: result.success ? 'success' : result.skipped ? 'skipped' : 'error',
      orderId: result.orderId,
      orderNumber: result.orderNumber ?? null,
      cause: queueSendLogCause(result),
      trackingNumber: result.trackingNumber ?? null,
      queueEntryId: result.queueEntryId ?? null,
      jobId: job.jobId,
      timingMs: result.timings?.totalMs ?? null,
      source: result.timings?.labelSource ?? null,
    });
  }
}

type QueueSendOrderLifecycle = {
  setState: (
    state: QueueSendJobItemState,
    patch?: {
      blockedReason?: string | null;
      errorMessage?: string | null;
      queueEntryId?: string | null;
      trackingNumber?: string | null;
    },
  ) => Promise<void>;
};

function isLabelPurchaseInProgressError(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'LABEL_PURCHASE_IN_PROGRESS';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExistingQueueableLabel(
  order: Pick<QueueSendOrderInput, 'orderId' | 'clientId'>,
): Promise<string | null> {
  const deadline = Date.now() + QUEUE_SEND_IN_PROGRESS_RECOVERY_MS;
  while (Date.now() < deadline) {
    const labelUrl = await findExistingQueueSendLabel(order);
    if (labelUrl) return labelUrl;
    await delay(QUEUE_SEND_IN_PROGRESS_RECOVERY_POLL_MS);
  }
  return findExistingQueueSendLabel(order);
}

async function repairMissingConfirmationForQueuedLabel(orderId: number | string): Promise<void> {
  const parsedOrderId = Number(orderId);
  if (!Number.isInteger(parsedOrderId) || parsedOrderId <= 0) return;
  try {
    // Per user override unlock shipped data on 2026-06-23: queueing an existing shipped label
    // repairs only the missing confirmation lifecycle â€” it never creates labels, buys postage, or
    // marks printed. (Continues the 2026-06-01 override that introduced this repair.)
    //
    // PS-perf: the lifecycle now ENQUEUES the durable outbox row but no longer DISPATCHES it
    // synchronously (processNow:false), so a batch Send-to-Queue no longer pays a per-order marketplace
    // round-trip on the hot path. Safety: the durable row is written regardless â€” outbox.ts enqueues
    // BEFORE the processNow check, so no confirmation is ever dropped. We then kick a fire-and-forget
    // drain so the common case still confirms sub-second; the 60s outbox scheduler and
    // enqueueMissingShipmentConfirmations re-enqueue are the backstops if this process exits first.
    // (Mirrors the labels.ts marketplace-confirmation background drain.)
    await ensureShipmentConfirmationLifecycle({
      orderId: parsedOrderId,
      dryRun: false,
      processNow: false,
    });
    void Promise.resolve()
      .then(() => processFulfillmentOutboxOnce({ orderId: parsedOrderId, limit: 5 }))
      .catch(() => {});
  } catch (err) {
    console.warn(
      `[print-queue] missing confirmation repair failed orderId=${parsedOrderId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

async function processQueueSendOrder(
  order: QueueSendOrderInput,
  scope: PrintQueueListScope = {},
  lifecycle?: QueueSendOrderLifecycle,
): Promise<QueueSendJobResult> {
  const startedAt = Date.now();
  const labelPurchaseScope = queueWorkerClientStoreScope(scope);
  const timings: QueueSendTimingBreakdown = { totalMs: 0 };
  let labelUrl: unknown = order.labelUrl ?? null;
  let trackingNumber: string | null = null;

  if (labelUrl) {
    timings.labelSource = 'provided';
  }

  if (!labelUrl) {
    let existingLabelUrl = await timeQueueStep(
      timings,
      'existingLabelLookupMs',
      () => findExistingQueueSendLabel(order),
    );
    if (existingLabelUrl) {
      labelUrl = existingLabelUrl;
      timings.labelSource = 'existing';
    } else if (!order.label) {
      throw new Error('Missing label payload');
    } else {
      const labelInput = order.label;
      try {
        await lifecycle?.setState('validating_rate');
        await lifecycle?.setState('acquiring_lock');
        await lifecycle?.setState('provider_pending');
        let providerPendingTimer: NodeJS.Timeout | null = setTimeout(() => {
          void lifecycle?.setState('provider_pending_recovery', {
            errorMessage:
              `Provider purchase still pending after ${Math.round(QUEUE_SEND_PROVIDER_PENDING_AFTER_MS / 1000)}s; ` +
              'the job is recoverable and must not be retried until existing labels/locks are checked.',
          });
        }, QUEUE_SEND_PROVIDER_PENDING_AFTER_MS);
        // Per user override unlock shipped data on 2026-05-23: PS-422 preserves
        // the initiating route's client/store scope through
        // the durable worker. Possessing print_queue:write alone never widens
        // label purchase to unrelated tenants.
        const created = await timeQueueStep(
          timings,
          'labelPurchaseMs',
          async () => {
            try {
              if (isShopifyQueueLabelInput(labelInput)) {
                return await createShopifyShippingLabelForOrder({
                  orderId: order.orderId,
                  weightOz: labelInput.weightOz,
                  length: labelInput.length,
                  width: labelInput.width,
                  height: labelInput.height,
                  packageName: labelInput.packageName,
                  customPackageId: labelInput.customPackageId,
                  notifyCustomer: labelInput.notifyCustomer ?? false,
                  testLabel: labelInput.testLabel,
                }, labelPurchaseScope);
              }
              return await createLabelV2({
                ...labelInput,
                orderId: order.orderId,
                orderNumber: order.orderNumber ?? labelInput.orderNumber,
              }, labelPurchaseScope);
            } finally {
              if (providerPendingTimer) {
                clearTimeout(providerPendingTimer);
                providerPendingTimer = null;
              }
            }
          },
        );
        labelUrl = created.labelUrl;
        trackingNumber = created.trackingNumber;
        if (created.timings) timings.labelCreateTimings = created.timings;
        timings.labelSource = 'created';
        await lifecycle?.setState('shipment_persisted', {
          trackingNumber,
        });
      } catch (err) {
        if (isLabelPurchaseInProgressError(err)) {
          const recoveredAfterInProgress = await timeQueueStep(
            timings,
            'inProgressRecoveryMs',
            () => waitForExistingQueueableLabel(order),
          );
          if (recoveredAfterInProgress) {
            labelUrl = recoveredAfterInProgress;
            timings.labelSource = 'in_progress_recovered';
          } else {
            const lockActive = await isLabelPurchaseLockActive(order.orderId);
            const recoveredAfterLockCheck = await findExistingQueueSendLabel(order);
            if (recoveredAfterLockCheck) {
              labelUrl = recoveredAfterLockCheck;
              timings.labelSource = 'in_progress_recovered';
            } else if (!lockActive) {
              throw new QueueSendStaleLabelAttemptError(order.orderId);
            } else throw err;
          }
        } else {
          existingLabelUrl = getExistingLabelUrl(err);
          // Per user override unlock shipped data on 2026-05-23: recover labels
          // that were persisted before a later post-label queue step failed.
          const recoverCreatedLabelUrl = existingLabelUrl ?? await timeQueueStep(
            timings,
            'recoveryLookupMs',
            () => findExistingQueueSendLabel(order),
          );
          if (!recoverCreatedLabelUrl) throw err;
          labelUrl = recoverCreatedLabelUrl;
          timings.labelSource = 'recovered';
        }
      }
    }
  }

  if (!labelUrl) throw new Error('Label was created without a queueable URL');
  const queueableLabelUrl = normalizePrintQueueLabelUrl(labelUrl);

  const { entry, alreadyQueued } = await timeQueueStep(
    timings,
    'queueWriteMs',
    () => addToQueue({
      clientId: order.clientId,
      orderId: String(order.orderId),
      orderNumber: order.orderNumber ?? null,
      labelUrl: queueableLabelUrl,
      skuGroupId: order.skuGroupId,
      primarySku: order.primarySku ?? null,
      itemDescription: order.itemDescription ?? null,
      orderQty: order.orderQty ?? 1,
      multiSkuData: order.multiSkuData ?? null,
      scope,
    }),
  );
  await lifecycle?.setState('queued', {
    queueEntryId: entry.id,
    trackingNumber,
  });
  timings.totalMs = elapsedSince(startedAt);

  return {
    orderId: order.orderId,
    orderNumber: order.orderNumber ?? null,
    success: true,
    queueEntryId: entry.id,
    alreadyQueued,
    labelUrl: queueableLabelUrl,
    trackingNumber,
    timings,
  };
}

// â”€â”€â”€ CRUD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function listQueue(
  clientId?: number,
  includePrinted = false,
  scope: PrintQueueListScope = {}
) {
  const conds: SQL[] = [];
  if (clientId !== undefined) conds.push(eq(printQueue.clientId, clientId));
  if (!includePrinted) conds.push(eq(printQueue.status, 'queued'));
  conds.push(printQueueScopePredicate(scope));
  const where = conds.length ? and(...conds) : undefined;
  const entries = await db.select().from(printQueue).where(where);
  // PS-129: per-entry shipping hold (locally shipped/cancelled, cancelled upstream, externally shipped).
  const holds = await loadShippingHoldsForOrderIds(entries.map((e) => Number(e.orderId)));
  // Per user override unlock shipped data on 2026-06-10: the merge/print job already EXCLUDES held
  // entries server-side; align the ACTIVE queue display with it so already-shipped/blocked orders no
  // longer clutter the queue or inflate the "labels not printed" count (operator confusion). The
  // print_queue rows are untouched; history (includePrinted=true) still returns every entry.
  const visibleEntries = includePrinted
    ? entries
    : entries.filter((e) => !holds.has(Number(e.orderId)));
  const totalQty = visibleEntries.reduce((s, e) => s + (e.orderQty ?? 1), 0);
  return {
    queuedOrders: visibleEntries.map((e) => ({
      queue_entry_id: e.id,
      order_id: e.orderId,
      order_number: e.orderNumber,
      client_id: e.clientId,
      label_url: e.labelUrl,
      sku_group_id: e.skuGroupId,
      primary_sku: e.primarySku,
      item_description: e.itemDescription,
      order_qty: e.orderQty,
      multi_sku_data: e.multiSkuData,
      status: e.status,
      print_count: e.printCount,
      last_printed_at: e.lastPrintedAt?.toISOString() ?? null,
      auto_retired_at: e.autoRetiredAt?.toISOString() ?? null,
      queued_at: e.queuedAt.toISOString(),
      shipping_hold: holds.has(Number(e.orderId)),
      held_reason: holds.get(Number(e.orderId)) ?? null,
    })),
    totalOrders: visibleEntries.length,
    totalQty,
  };
}

export async function addToQueue(
  input: AddToQueueInput
): Promise<{ entry: PrintQueueEntry; alreadyQueued: boolean }> {
  await assertPrintQueueClientsVisible([input.clientId], input.scope);
  const labelUrl = normalizePrintQueueLabelUrl(input.labelUrl);

  // PS-177 (Phase 5): the queue SKU identity is backend-derivable. When the
  // caller sent no real identity â€” absent, or the degraded ORDER:/order-<id>
  // fallback identifier-only callers use â€” rebuild it from the order's items
  // (the SAME collapse/combo-key rule the FE mirrors), so grouping and pick
  // identity never depend on what the frontend happened to carry. A caller-sent
  // real identity is kept verbatim (no churn for existing flows); derivation is
  // best-effort and falls back to the caller's values on any failure.
  let identity = {
    skuGroupId: input.skuGroupId,
    primarySku: input.primarySku ?? null,
    itemDescription: input.itemDescription ?? null,
    orderQty: input.orderQty ?? 1,
    multiSkuData: input.multiSkuData ?? null,
  };
  const identityDegraded = !identity.skuGroupId || /^(ORDER:|order-)/.test(identity.skuGroupId);
  if (identityDegraded) {
    try {
      const numericOrderId = Number(input.orderId);
      if (Number.isFinite(numericOrderId)) {
        const items = await db
          .select({ sku: orderItems.sku, name: orderItems.name, quantity: orderItems.quantity })
          .from(orderItems)
          .where(eq(orderItems.orderId, numericOrderId));
        if (items.length) {
          const derived = buildQueueSkuIdentityFromItems(
            numericOrderId,
            items.map((item) => ({ sku: item.sku, name: item.name, qty: Number(item.quantity) || 1 })),
          );
          identity = {
            skuGroupId: derived.skuGroupId,
            primarySku: derived.primarySku,
            itemDescription: derived.itemDescription,
            orderQty: derived.orderQty,
            multiSkuData: derived.multiSkuData,
          };
        }
      }
    } catch (err) {
      console.warn('[print-queue] sku identity derivation failed (using caller values):', err instanceof Error ? err.message : err);
    }
  }
  if (!identity.skuGroupId) identity.skuGroupId = `ORDER:${input.orderId}`;

  const [existing] = await db
    .select()
    .from(printQueue)
    .where(
      and(
        eq(printQueue.orderId, input.orderId),
        eq(printQueue.clientId, input.clientId)
      )
    )
    .limit(1);

  const alreadyQueued = !!existing && existing.status === 'queued';
  if (existing && (existing.status === 'printed' || existing.status === 'delivered')) {
    // Per user override unlock shipped data on 2026-07-07 (PS-400): a retry may
    // recover an already-purchased label, but it must not silently revive a
    // confirmed/retired print-history row into the active queue and risk a
    // second physical print.
    throw new PrintQueueAlreadyFinalizedError(input.orderNumber ?? input.orderId, existing.status);
  }
  const id = existing?.id ?? randomUUID();

  const [entry] = await db
    .insert(printQueue)
    .values({
      id,
      clientId: input.clientId,
      orderId: input.orderId,
      orderNumber: input.orderNumber ?? null,
      labelUrl,
      skuGroupId: identity.skuGroupId,
      primarySku: identity.primarySku,
      itemDescription: identity.itemDescription,
      orderQty: identity.orderQty,
      multiSkuData: identity.multiSkuData,
      status: 'queued',
      printCount: 0,
      queuedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [printQueue.orderId, printQueue.clientId],
      set: {
        labelUrl,
        skuGroupId: identity.skuGroupId,
        primarySku: identity.primarySku,
        itemDescription: identity.itemDescription,
        orderQty: identity.orderQty,
        multiSkuData: identity.multiSkuData,
        status: 'queued',
        queuedAt: new Date(),
      },
      // Per user override unlock shipped data on 2026-07-14 (Audit PQ-9):
      // enforce finality in the UPSERT statement so a concurrent print/delivery
      // transition cannot be revived into the active queue.
      setWhere: eq(printQueue.status, 'queued'),
    })
    .returning();

  if (!entry) {
    throw new PrintQueueAlreadyFinalizedError(
      input.orderNumber ?? input.orderId,
      'finalized',
    );
  }
  await repairMissingConfirmationForQueuedLabel(input.orderId);

  return { entry, alreadyQueued };
}

export async function startQueueSendJob(input: {
  orders: QueueSendOrderInput[];
  preflightSkips?: QueueSendPreflightSkipInput[];
  concurrency?: number;
  scope?: PrintQueueListScope;
}): Promise<{ jobId: string; total: number; skipped: number }> {
  const orders = input.orders;
  const frontendPreflightSkips = input.preflightSkips ?? [];
  const requestedTotal = orders.length + frontendPreflightSkips.length;
  if (requestedTotal <= 0) throw new Error('orders or preflightSkips must be non-empty');

  cleanOldJobs();
  const preflight = orders.length > 0
    ? await preflightQueueSendOrders(orders, input.scope)
    : { readyOrders: [], blockedResults: [], itemStates: [] };
  const frontendSkippedResults = frontendPreflightSkips.map(toQueueSendPreflightSkipResult);
  const frontendSkippedItems = frontendPreflightSkips.map(toQueueSendPreflightSkipItem);
  const jobId = randomUUID();
  const clientIds = normalizeClientIds([
    ...orders.map((order) => order.clientId),
    ...frontendPreflightSkips.map((skip) => skip.clientId),
  ]);
  const firstClientId = orders.find((order) => Number.isFinite(order.clientId))?.clientId ??
    frontendPreflightSkips.find((skip) => Number.isFinite(skip.clientId))?.clientId ??
    null;
  const skippedResults = [...frontendSkippedResults, ...preflight.blockedResults];
  const itemStates = [...frontendSkippedItems, ...preflight.itemStates];
  const workerConcurrency = normalizeQueueSendWorkerConcurrency(input.concurrency, preflight.readyOrders.length || 1);
  const job: QueueSendJob = {
    jobId,
    status: preflight.readyOrders.length > 0 ? 'pending' : 'done',
    clientIds,
    progress: 0,
    total: requestedTotal,
    current: skippedResults.length,
    queued: 0,
    skipped: skippedResults.length,
    failed: 0,
    message: preflight.readyOrders.length > 0
      ? `Starting queue send of ${requestedTotal} order${requestedTotal === 1 ? '' : 's'}...`
      : `Queued 0/${requestedTotal}${skippedResults.length ? `, ${skippedResults.length} skipped` : ''}`,
    clientId: firstClientId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    results: [...skippedResults],
    queuedEntryIds: [],
    itemStates: itemStates.map(toQueueSendItemSnapshot),
    workerOrders: preflight.readyOrders,
    workerConcurrency,
    workerScope: input.scope ?? {},
    recoveryAttempts: 0,
  };
  updateQueueSendProgress(job);
  queueSendJobs.set(jobId, job);

  // Audit PQ-7: the snapshot persist above already wrote the item rows
  // (persistItems defaults true) — the explicit second write was a duplicate
  // full pass over every item at job start.
  await persistQueueSendJobSnapshot(job, { required: true });
  recordQueueSendResultLogs(job, skippedResults);
  if (preflight.readyOrders.length > 0) {
    if (!env.PRINT_QUEUE_WORKER_ENABLED) {
      await markQueueSendWorkerUnavailable(
        job,
        'Print queue worker dispatch is disabled; enable PRINT_QUEUE_WORKER_ENABLED on the API service.',
      );
      return { jobId, total: requestedTotal, skipped: skippedResults.length };
    }
    const enqueueResult = await enqueueQueueSendWorkerJob({
      jobId,
      orders: preflight.readyOrders,
      concurrency: workerConcurrency,
      scope: input.scope ?? {},
      requestedAt: new Date(job.createdAt).toISOString(),
    });
    if (enqueueResult.queued) {
      queueSendJobs.delete(jobId);
      return { jobId, total: requestedTotal, skipped: skippedResults.length };
    }
    const enqueueError = enqueueResult.error ?? 'pg-boss did not accept the job';
    console.warn('[print-queue] worker enqueue failed; job will not run in the API process:', enqueueError);
    await markQueueSendWorkerUnavailable(job, `Print queue worker unavailable: ${enqueueError}`);
  }
  return { jobId, total: requestedTotal, skipped: skippedResults.length };
}

export function getQueueSendJobStatus(jobId: string): QueueSendJob | null {
  cleanOldJobs();
  return queueSendJobs.get(jobId) ?? null;
}

export async function runQueueSendJobFromWorker(payload: {
  jobId: string;
  orders: QueueSendOrderInput[];
  concurrency?: number;
  scope?: PrintQueueListScope;
}, options: { signal?: AbortSignal } = {}): Promise<QueueSendWorkerRunResult> {
  // Per user override unlock shipped data on 2026-07-14: a pg-boss retry may
  // arrive while the timed-out promise is still settling. Join that one run;
  // this does not weaken shipped/cancelled edit locks or perform provider work.
  return runQueueSendSingleFlight(payload.jobId, async (): Promise<QueueSendWorkerRunResult> => {
    const durableJob = await getQueueSendJobRecord(payload.jobId);
    if (!durableJob) {
      throw new Error(`Queue send job ${payload.jobId} was not found`);
    }

    if (durableJob.status === 'done' || durableJob.status === 'error') {
      return {
        ok: true,
        jobId: payload.jobId,
        skipped: `already_${durableJob.status}`,
        remaining: 0,
      };
    }

    const job = queueSendJobs.get(payload.jobId) ?? queueSendJobFromSnapshot(durableJob);
    queueSendJobs.set(payload.jobId, job);

    const completedOrderIds = new Set(job.results.map((result) => result.orderId));
    const remainingOrders = payload.orders.filter((order) => !completedOrderIds.has(order.orderId));
    if (remainingOrders.length === 0) {
      if (job.current >= job.total) {
        job.status = 'done';
        updateQueueSendProgress(job);
        await persistQueueSendJobSnapshot(job, { required: true });
      }
      return {
        ok: true,
        jobId: payload.jobId,
        skipped: 'chunk_already_complete',
        remaining: 0,
      };
    }

    await runQueueSendJob(
      payload.jobId,
      remainingOrders,
      payload.concurrency,
      payload.scope,
      options.signal,
    );
    return { ok: true, jobId: payload.jobId, remaining: remainingOrders.length };
  });
}

async function runQueueSendJob(
  jobId: string,
  orders: QueueSendOrderInput[],
  requestedConcurrency = QUEUE_SEND_WORKER_MAX_CONCURRENCY,
  scope: PrintQueueListScope = {},
  signal?: AbortSignal,
) {
  const job = queueSendJobs.get(jobId);
  if (!job) return;

  const concurrency = normalizeQueueSendWorkerConcurrency(requestedConcurrency, orders.length || 1);
  job.status = 'running';
  updateQueueSendProgress(job);
  void persistQueueSendJobSnapshot(job, QUEUE_SEND_PROGRESS_SNAPSHOT_OPTIONS);

  try {
    await runQueueSendPool(
      orders,
      async (order) => {
        const orderStartedAt = Date.now();
        try {
          const result = await processQueueSendOrder(order, order.scope ?? scope, {
            setState: (state, patch) => setQueueSendItemState(job, order, { state, ...patch }),
          });
          const loggedResult = withTotalTiming(result, orderStartedAt);

          job.queued += 1;
          if (result.queueEntryId) job.queuedEntryIds.push(result.queueEntryId);
          job.results.push(loggedResult);
          recordQueueSendResultLogs(job, [loggedResult]);
          await setQueueSendItemState(job, order, {
            state: 'queued',
            queueEntryId: result.queueEntryId ?? null,
            trackingNumber: result.trackingNumber ?? null,
          });
        } catch (err) {
          job.failed += 1;
          // PS-191: classify retry eligibility STRUCTURALLY (proof-error code
          // + details.reason) â€” never by parsing the message. The FE surfaces
          // a "refresh the rate and click again" prompt for eligible failures
          // and must never auto-repurchase.
          const retry = classifyLabelPurchaseRetry(err);
          const staleLabelAttempt = isQueueSendStaleLabelAttemptError(err);
          const labelPurchaseInProgress = isLabelPurchaseInProgressError(err);
          const retryEligible = staleLabelAttempt || labelPurchaseInProgress || retry.retryEligible;
          const retryReason = staleLabelAttempt
            ? err.retryReason
            : labelPurchaseInProgress
              ? 'label_purchase_in_progress'
              : retry.retryReason;
          const message = err instanceof Error ? err.message : 'Unknown error';
          const failedResult: QueueSendJobResult = {
            orderId: order.orderId,
            orderNumber: order.orderNumber ?? null,
            success: false,
            error: message,
            retryEligible,
            retryReason,
            timings: { totalMs: elapsedSince(orderStartedAt), labelSource: 'failed' },
          };
          job.results.push(failedResult);
          recordQueueSendResultLogs(job, [failedResult]);
          await setQueueSendItemState(job, order, {
            state: retryEligible ? 'failed_retryable' : 'failed_terminal',
            blockedReason: retryReason ?? null,
            errorMessage: message,
          });
        } finally {
          job.current += 1;
          updateQueueSendProgress(job);
          await persistQueueSendJobSnapshot(job, QUEUE_SEND_PROGRESS_SNAPSHOT_OPTIONS);
        }
      },
      concurrency,
      signal,
    );

    const seenOrderIds = new Set(job.results.map((result) => result.orderId));
    for (const order of orders) {
      if (seenOrderIds.has(order.orderId)) continue;
      job.failed += 1;
      job.current += 1;
      const missingResult: QueueSendJobResult = {
        orderId: order.orderId,
        orderNumber: order.orderNumber ?? null,
        success: false,
        error: 'Queue send did not report a result',
      };
      job.results.push(missingResult);
      recordQueueSendResultLogs(job, [missingResult]);
      updateQueueSendProgress(job);
      await persistQueueSendJobSnapshot(job, QUEUE_SEND_PROGRESS_SNAPSHOT_OPTIONS);
    }
    if (job.current > job.total) job.current = job.total;
    job.status = job.current >= job.total ? 'done' : 'pending';
    updateQueueSendProgress(job);
    await persistQueueSendJobSnapshot(job, { required: true });
  } catch (err) {
    const interrupted = err instanceof QueueSendJobInterruptedError;
    job.status = interrupted ? 'interrupted' : 'error';
    job.errorMessage = err instanceof Error ? err.message : 'Queue send failed';
    job.message = job.errorMessage;
    job.updatedAt = Date.now();
    await persistQueueSendJobSnapshot(job, { required: true });
    if (interrupted) throw err;
  } finally {
    // Audit PQ-6 (2026-07-13): the worker process never pruned its job map —
    // cleanOldJobs only runs from API-process entry points, so every processed
    // job (with up to 1000 orders of payload + results) stayed resident until
    // OOM. The durable store owns terminal state; drop the in-memory copy.
    job.workerOrders = [];
    queueSendJobs.delete(jobId);
  }
}

export async function removeFromQueue(
  entryId: string,
  clientId?: number,
  scope: PrintQueueListScope = {}
) {
  const where = clientId !== undefined
    ? and(eq(printQueue.id, entryId), eq(printQueue.clientId, clientId), printQueueScopePredicate(scope))
    : and(eq(printQueue.id, entryId), printQueueScopePredicate(scope));
  const [row] = await db.delete(printQueue).where(where).returning();
  if (!row) throw new Error(`Queue entry not found: ${entryId}`);
  return row;
}

// PS-195: entry ids currently inside a PENDING/RUNNING merge job. Clearing
// one of these mid-merge would yank a label out from under an operator's
// in-flight print â€” those entries are refused, not deleted.
async function inFlightMergeEntryIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const job of mergeJobs.values()) {
    if (job.status !== 'pending' && job.status !== 'running') continue;
    for (const entryId of job.entryIds ?? []) ids.add(entryId);
  }
  for (const entryId of await getActivePrintMergeEntryIds()) ids.add(entryId);
  return ids;
}

// PS-195: clears are EXPLICITLY TARGETED â€” the caller names the queued entry
// ids it intends to remove (the route schema already rejects id-less
// requests). Deletion stays bounded to status='queued' within client/scope,
// and entries belonging to a running merge job are skipped and reported.
export async function clearQueue(input: {
  entryIds: string[];
  clientId?: number;
  scope?: PrintQueueListScope;
}): Promise<{ cleared: number; blockedInFlight: number }> {
  if (!input.entryIds.length) return { cleared: 0, blockedInFlight: 0 };
  const inFlight = await inFlightMergeEntryIds();
  const clearable = input.entryIds.filter((id) => !inFlight.has(id));
  const blockedInFlight = input.entryIds.length - clearable.length;
  if (!clearable.length) return { cleared: 0, blockedInFlight };

  const conds = [
    inArray(printQueue.id, clearable),
    eq(printQueue.status, 'queued'),
  ];
  if (input.clientId !== undefined) conds.push(eq(printQueue.clientId, input.clientId));
  conds.push(printQueueScopePredicate(input.scope ?? {}));
  const rows = await db
    .delete(printQueue)
    .where(and(...conds))
    .returning({ id: printQueue.id });
  return { cleared: rows.length, blockedInFlight };
}

export async function confirmPrintedQueueEntries(input: {
  entryIds: string[];
  clientId?: number;
  scope?: PrintQueueListScope;
}) {
  if (!input.entryIds.length) return { confirmedCount: 0, confirmedEntryIds: [] as string[] };
  const conds: SQL[] = [
    inArray(printQueue.id, input.entryIds),
    eq(printQueue.status, 'queued'),
  ];
  if (input.clientId !== undefined) conds.push(eq(printQueue.clientId, input.clientId));
  conds.push(printQueueScopePredicate(input.scope ?? {}));
  const now = new Date();
  const rows = await db
    .update(printQueue)
    .set({
      status: 'printed',
      lastPrintedAt: now,
      printCount: sql`${printQueue.printCount} + 1`,
    })
    .where(and(...conds))
    .returning({ id: printQueue.id });
  return {
    confirmedCount: rows.length,
    confirmedEntryIds: rows.map((row) => row.id),
  };
}

/**
 * Legacy no-op retained for old imports: print queue persists until explicit
 * operator action confirms printed or removes entries. Shipped/cancelled order
 * status alone must never delete active unprinted queue rows.
 */
export async function removeQueueEntriesForOrder(orderId: number): Promise<number> {
  void orderId;
  return 0;
}

/**
 * Tracking-driven retirement (per user override unlock shipped data on
 * 2026-06-11): when carrier tracking shows a package was DELIVERED, its label
 * never needs printing â€” the shipment-tracking poller moves the entry
 * 'queued' â†’ 'delivered' so it leaves the ACTIVE queue (which filters
 * status='queued') but stays in History with auto_retired_at. This is the
 * ONLY writer of the 'delivered' status. Strictly narrower than the operator
 * actions above: the WHERE pins status='queued' so 'printed' history is never
 * touched, and nothing is ever DELETED (the no-op policy in
 * removeQueueEntriesForOrder still holds â€” order status alone never removes a
 * row; only a carrier-confirmed delivery retires one, and only to History).
 */
export async function retireDeliveredQueueEntries(input: {
  entries: Array<{ entryId: string; deliveredAt: Date | null }>;
}): Promise<{ retiredCount: number; retiredEntryIds: string[] }> {
  const ids = [...new Set(input.entries.map((entry) => entry.entryId).filter(Boolean))];
  if (!ids.length) return { retiredCount: 0, retiredEntryIds: [] };
  const deliveredAtByEntry = new Map(
    input.entries.map((entry) => [entry.entryId, entry.deliveredAt] as const),
  );
  const retiredEntryIds: string[] = [];
  for (const entryId of ids) {
    const rows = await db
      .update(printQueue)
      .set({
        status: 'delivered',
        autoRetiredAt: deliveredAtByEntry.get(entryId) ?? new Date(),
      })
      .where(and(eq(printQueue.id, entryId), eq(printQueue.status, 'queued')))
      .returning({ id: printQueue.id });
    if (rows.length) retiredEntryIds.push(entryId);
  }
  return { retiredCount: retiredEntryIds.length, retiredEntryIds };
}

// â”€â”€â”€ PDF MERGE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function startPrintJob(input: {
  clientId?: number;
  queueEntryIds: string[];
  mergeHeaders?: boolean;
  requestOrigin?: string;
  scope?: PrintQueueListScope;
}): Promise<{ jobId: string; total: number }> {
  if (!input.queueEntryIds.length)
    throw new Error('queueEntryIds must be non-empty');

  const conds = [inArray(printQueue.id, input.queueEntryIds)];
  if (input.clientId !== undefined) {
    conds.push(eq(printQueue.clientId, input.clientId));
  }
  conds.push(printQueueScopePredicate(input.scope ?? {}));
  const entries = await db.select().from(printQueue).where(and(...conds));
  if (entries.length !== input.queueEntryIds.length) {
    throw new Error('One or more queue entries not found or unauthorized');
  }
  // Print labels ascending by order number. `inArray` (IN (...)) does NOT
  // preserve the caller's id order and the DB returns rows arbitrarily, so we
  // sort here â€” this is what guarantees the merged PDF comes out in order
  // (1231, 1239, 1247, â€¦). Natural sort handles numeric and mixed-format
  // order numbers; null/blank order numbers sort first, stably.
  entries.sort((a, b) =>
    String(a.orderNumber ?? '').localeCompare(String(b.orderNumber ?? ''), undefined, {
      numeric: true,
      sensitivity: 'base',
    }),
  );
  // PS-109: fill any missing product names on these entries from the canonical
  // order_items table BEFORE the headers render, so a legacy row (enqueued before the
  // batch-send description fix) shows the real product name instead of "Unnamed item".
  await enrichEntriesWithCanonicalItemNames(entries);

  const invalidLabelErrors = collectInvalidLabelErrors(entries);
  if (invalidLabelErrors.length === entries.length) {
    throw new PrintQueueLabelUrlError(
      `All selected labels have invalid URLs. ${invalidLabelErrors.slice(0, 3).join(' ')}`
    );
  }

  cleanOldJobs();
  const jobId = randomUUID();
  const job: MergeJob = {
    jobId,
    generation: 0,
    status: 'pending',
    clientIds: normalizeClientIds(entries.map((entry) => entry.clientId)),
    progress: 0,
    total: entries.length,
    current: 0,
    message: `Starting merge of ${entries.length} label${entries.length === 1 ? '' : 's'}â€¦`,
    createdAt: Date.now(),
    labelErrors: [],
    chunks: [],
    successfulEntryIds: [],
    entryIds: entries.map((entry) => entry.id),
    updatedAt: Date.now(),
  };
  try {
    await persistMergeJobSnapshot(job, {
      required: true,
      workerInput: {
        entries,
        mergeHeaders: input.mergeHeaders !== false,
        requestOrigin: input.requestOrigin,
      },
    });
  } catch (err) {
    throw err;
  }
  const queued = await enqueuePrintMergeWorkerJob(jobId);
  if (!queued.queued) {
    console.warn(
      `[print-queue] durable merge ${jobId} awaits worker recovery: ` +
      `${queued.error ?? 'pg-boss enqueue was deduplicated'}`,
    );
  }
  return { jobId, total: entries.length };
}

export function getMergeJobStatus(jobId: string): MergeJob | null {
  return mergeJobs.get(jobId) ?? null;
}

// Per user override unlock shipped data on 2026-07-15: PS-428 makes the durable artifact store
// authoritative for completed PDF chunks. Rehydration only reads already-generated artifacts;
// it never regenerates labels, buys postage, notifies a marketplace, or mutates an order or
// shipment. The in-process map remains only a short-lived fast path while a worker is active.
export async function getMergeJobForServe(jobId: string): Promise<MergeJob | null> {
  const inMemory = mergeJobs.get(jobId) ?? null;
  if (
    inMemory &&
    inMemory.status === 'done' &&
    (inMemory.mergedPdfBase64 ||
      (inMemory.chunks ?? []).some((chunk) => chunk.status === 'done' && chunk.mergedPdfBase64))
  ) {
    return inMemory; // fast path - bytes already in process memory
  }

  // In-memory miss (or done-without-bytes). Only attempt a durable rehydrate when the durable
  // snapshot confirms THIS job completed â€” otherwise leave the caller's miss as-is.
  const snapshot = await getMergeJobSnapshot(jobId);
  if (!snapshot || snapshot.status !== 'done') {
    return inMemory;
  }

  const storedChunks = await getMergedPdfChunks(jobId);
  if (storedChunks.length > 0) {
    const chunkByNumber = new Map<number, MergeJobChunk>();
    for (const chunk of snapshot.chunks ?? []) {
      chunkByNumber.set(chunk.chunkNumber, mergeChunkFromSnapshot(chunk));
    }
    for (const storedChunk of storedChunks) {
      const durableChunk = mergeChunkFromMetadata(storedChunk);
      const snapshotChunk = chunkByNumber.get(durableChunk.chunkNumber);
      chunkByNumber.set(durableChunk.chunkNumber, {
        ...snapshotChunk,
        ...durableChunk,
        entryIds: durableChunk.entryIds.length > 0 ? durableChunk.entryIds : snapshotChunk?.entryIds ?? [],
        successfulEntryIds:
          durableChunk.successfulEntryIds.length > 0
            ? durableChunk.successfulEntryIds
            : snapshotChunk?.successfulEntryIds ?? [],
      });
    }
    const chunks = [...chunkByNumber.values()].sort((a, b) => a.chunkNumber - b.chunkNumber);
    const doneChunks = chunks.filter((chunk) => chunk.status === 'done');
    if (doneChunks.length === 1) {
      const base64 = await getMergedPdfChunkBase64(jobId, doneChunks[0]!.chunkNumber);
      if (base64) doneChunks[0]!.mergedPdfBase64 = base64;
    }
    return {
      jobId: snapshot.jobId,
      generation: snapshot.generation ?? 0,
      status: 'done',
      clientIds: [...snapshot.clientIds],
      progress: snapshot.progress,
      total: snapshot.total,
      current: snapshot.current,
      message: snapshot.message,
      mergedPdfBase64: doneChunks.length === 1 ? doneChunks[0]?.mergedPdfBase64 : undefined,
      fileName: snapshot.fileName ?? undefined,
      chunks,
      errorMessage: snapshot.errorMessage ?? undefined,
      labelErrors: snapshot.labelErrors,
      successfulEntryIds: snapshot.successfulEntryIds ?? doneChunks.flatMap((chunk) => chunk.successfulEntryIds),
      entryIds: chunks.flatMap((chunk) => chunk.entryIds),
      createdAt: Date.parse(snapshot.createdAt) || Date.now(),
      updatedAt: Date.parse(snapshot.persistedAt) || Date.now(),
    };
  }

  const base64 = await getMergedPdfBase64(jobId);
  if (!base64) return inMemory; // No legacy aggregate; chunked jobs use the branch above.

  return {
    jobId: snapshot.jobId,
    generation: snapshot.generation ?? 0,
    status: 'done',
    clientIds: [...snapshot.clientIds],
    progress: snapshot.progress,
    total: snapshot.total,
    current: snapshot.current,
    message: snapshot.message,
    mergedPdfBase64: base64,
    fileName: snapshot.fileName ?? undefined,
    chunks: (snapshot.chunks ?? []).map(mergeChunkFromSnapshot),
    errorMessage: snapshot.errorMessage ?? undefined,
    labelErrors: snapshot.labelErrors,
    successfulEntryIds: snapshot.successfulEntryIds ?? [],
    entryIds: snapshot.entryIds ?? [],
    createdAt: Date.parse(snapshot.createdAt) || Date.now(),
    updatedAt: Date.parse(snapshot.persistedAt) || Date.now(),
  };
}

export async function getMergeJobChunkForServe(
  jobId: string,
  chunkNumber: number,
): Promise<{ job: MergeJob; chunk: MergeJobChunk } | null> {
  if (!Number.isInteger(chunkNumber) || chunkNumber <= 0) return null;
  const job = await getMergeJobForServe(jobId);
  if (!job || job.status !== 'done') return null;
  const chunk = (job.chunks ?? []).find((candidate) => candidate.chunkNumber === chunkNumber);
  if (!chunk || chunk.status !== 'done') return null;
  if (chunk.mergedPdfBase64) return { job, chunk };

  const base64 = await getMergedPdfChunkBase64(jobId, chunkNumber);
  if (!base64) return null;
  return {
    job,
    chunk: {
      ...chunk,
      mergedPdfBase64: base64,
    },
  };
}

// PS-109 â€” canonical product-name resolution for the batch header. When a queued
// entry's multi_sku_data line (or the entry's primary item) has only a SKU and no real
// product name â€” a legacy row enqueued before the batch-send description fix â€” resolve
// the name from the canonical order_items table so the header shows the product name
// instead of the "Unnamed item" fallback. Mutates entries in place; best-effort (a
// lookup failure leaves the safe fallback intact).
function queueSkuKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}
function lineNeedsName(line: { sku?: unknown; description?: unknown } | null | undefined): boolean {
  const sku = queueSkuKey(line?.sku);
  const desc = queueSkuKey(line?.description);
  return sku.length > 0 && (desc.length === 0 || desc === sku);
}
async function enrichEntriesWithCanonicalItemNames(entries: PrintQueueEntry[]): Promise<void> {
  const orderIds = new Set<number>();
  for (const entry of entries) {
    const lines = Array.isArray(entry.multiSkuData) ? entry.multiSkuData : [];
    const needs =
      lineNeedsName({ sku: entry.primarySku, description: entry.itemDescription }) ||
      lines.some((line) => lineNeedsName(line as { sku?: unknown; description?: unknown }));
    if (!needs) continue;
    const orderId = Number(entry.orderId);
    if (Number.isFinite(orderId)) orderIds.add(orderId);
  }
  if (!orderIds.size) return;

  let rows: Array<{ orderId: number; sku: string | null; name: string | null }> = [];
  try {
    rows = await db
      .select({ orderId: orderItems.orderId, sku: orderItems.sku, name: orderItems.name })
      .from(orderItems)
      .where(inArray(orderItems.orderId, [...orderIds]));
  } catch (err) {
    console.warn('[print-queue] canonical item-name resolve failed:', err instanceof Error ? err.message : err);
    return; // leave the safe "Unnamed item" fallback in place
  }

  const byOrder = new Map<number, Map<string, string>>();
  for (const row of rows) {
    const name = String(row.name ?? '').trim();
    const key = queueSkuKey(row.sku);
    if (!name || !key || queueSkuKey(name) === key) continue; // skip blanks + name===sku
    if (!byOrder.has(row.orderId)) byOrder.set(row.orderId, new Map());
    const map = byOrder.get(row.orderId)!;
    if (!map.has(key)) map.set(key, name);
  }

  for (const entry of entries) {
    const map = byOrder.get(Number(entry.orderId));
    if (!map) continue;
    if (Array.isArray(entry.multiSkuData)) {
      entry.multiSkuData = entry.multiSkuData.map((line) => {
        const row = line as { sku?: unknown; description?: unknown; qty?: unknown };
        if (!lineNeedsName(row)) return line;
        const name = map.get(queueSkuKey(row.sku));
        return name ? { ...row, description: name } : line;
      }) as PrintQueueEntry['multiSkuData'];
    }
    if (lineNeedsName({ sku: entry.primarySku, description: entry.itemDescription })) {
      const name = map.get(queueSkuKey(entry.primarySku));
      if (name) entry.itemDescription = name;
    }
  }
}

export async function runPrintMergeJobFromWorker(
  claim: PrintMergeJobClaim,
  options: { signal: AbortSignal },
): Promise<{ jobId: string; generation: number; chunks: number; merged: number }> {
  const snapshot = claim.snapshot;
  const job: MergeJob = {
    jobId: snapshot.jobId,
    generation: claim.generation,
    status: snapshot.status,
    clientIds: [...snapshot.clientIds],
    progress: snapshot.progress,
    total: snapshot.total,
    current: snapshot.current,
    message: snapshot.message,
    fileName: snapshot.fileName ?? undefined,
    chunks: (snapshot.chunks ?? []).map(mergeChunkFromSnapshot),
    errorMessage: snapshot.errorMessage ?? undefined,
    labelErrors: snapshot.labelErrors ?? [],
    successfulEntryIds: snapshot.successfulEntryIds ?? [],
    entryIds: snapshot.entryIds ?? claim.input.entries.map((entry) => entry.id),
    createdAt: Date.parse(snapshot.createdAt) || Date.now(),
    updatedAt: Date.now(),
  };
  mergeJobs.set(job.jobId, job);
  try {
    await runMergeJob(
      job,
      claim.input.entries,
      claim.input.mergeHeaders,
      claim.input.requestOrigin,
      options.signal,
    );
    return {
      jobId: job.jobId,
      generation: job.generation,
      chunks: job.chunks.filter((chunk) => chunk.status === 'done').length,
      merged: job.successfulEntryIds.length,
    };
  } finally {
    for (const chunk of job.chunks) delete chunk.mergedPdfBase64;
    delete job.mergedPdfBase64;
    mergeJobs.delete(job.jobId);
  }
}

async function runMergeJob(
  job: MergeJob,
  entries: PrintQueueEntry[],
  mergeHeaders: boolean,
  requestOrigin?: string,
  signal?: AbortSignal,
) {
  const jobId = job.jobId;
  job.status = 'running';
  job.message = 'Initializing PDF merge...';
  try {
    await persistMergeJobSnapshot(job, { required: true });
    const { PDFDocument, rgb, StandardFonts } = await import('pdf-lib');
    const sorted = [...entries].sort((a, b) =>
      (a.skuGroupId ?? '').localeCompare(b.skuGroupId ?? '')
    );
    const groupSizes = new Map<string, number>();
    const entriesByGroup = new Map<string, PrintQueueEntry[]>();
    for (const e of sorted) {
      const g = e.skuGroupId ?? '__ungrouped__';
      groupSizes.set(g, (groupSizes.get(g) ?? 0) + 1);
      const bucket = entriesByGroup.get(g);
      if (bucket) bucket.push(e);
      else entriesByGroup.set(g, [e]);
    }

    const recipientsByGroup = await loadBatchRecipientsByGroup(entriesByGroup);
    const packageDimsByOrderId = await loadPackageDimsByOrderId(entriesByGroup);
    const shippingHoldsByOrderId = await loadShippingHoldsByOrderId(entriesByGroup);
    // Resume from already-durable chunks after a worker restart. A chunk is
    // published as done only after its bytes are stored, so it never needs to
    // be fetched or assembled twice.
    const storedChunks = await getMergedPdfChunks(jobId);
    const completedChunks = new Map<number, MergeJobChunk>();
    for (const chunk of job.chunks ?? []) {
      if (chunk.status === 'done') completedChunks.set(chunk.chunkNumber, chunk);
    }
    for (const chunk of storedChunks) {
      if (chunk.status !== 'done' || chunk.generation > job.generation) continue;
      completedChunks.set(chunk.chunkNumber, mergeChunkFromMetadata(chunk));
    }
    const successfulEntryIds = [...new Set(
      [...completedChunks.values()].flatMap((chunk) => chunk.successfulEntryIds),
    )];
    const failedEntryIds = new Set<string>();
    for (const chunk of completedChunks.values()) {
      const successfulIds = new Set(chunk.successfulEntryIds);
      for (const entryId of chunk.entryIds) {
        if (!successfulIds.has(entryId)) failedEntryIds.add(entryId);
      }
    }
    job.successfulEntryIds = successfulEntryIds;
    job.chunks = [...completedChunks.values()].sort((a, b) => a.chunkNumber - b.chunkNumber);
    const chunkPlans = planPrintQueuePdfChunks(sorted);
    const totalChunks = Math.max(1, chunkPlans.length);
    const now = new Date();
    const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const chunkFileName = (chunkNumber: number) =>
      totalChunks === 1
        ? `batch_print_${ts}.pdf`
        : `batch_print_${ts}_part_${String(chunkNumber).padStart(2, '0')}_of_${String(totalChunks).padStart(2, '0')}.pdf`;

    const createChunkContext = async (plan: PrintQueuePdfChunkPlan<PrintQueueEntry>) => {
      const document = await PDFDocument.create();
      const font = await document.embedFont(StandardFonts.HelveticaBold);
      const fontReg = await document.embedFont(StandardFonts.Helvetica);
      const chunk: MergeJobChunk = {
        chunkNumber: plan.chunkNumber,
        status: 'running',
        labelCount: plan.items.length,
        fileName: chunkFileName(plan.chunkNumber),
        fileSize: 0,
        pdfUrl: null,
        errorMessage: null,
        entryIds: plan.items.map((entry) => entry.id),
        successfulEntryIds: [],
        createdAt: Date.now(),
      };
      job.chunks = job.chunks.filter((candidate) => candidate.chunkNumber !== plan.chunkNumber);
      job.chunks.push(chunk);
      await persistMergeJobSnapshot(job);
      return {
        document,
        font,
        fontReg,
        lastGroup: null as string | null,
        chunk,
      };
    };

    const finalizeChunk = async (
      context: Awaited<ReturnType<typeof createChunkContext>>,
    ): Promise<boolean> => {
      signal?.throwIfAborted();
      if (context.document.getPageCount() === 0 || context.chunk.successfulEntryIds.length === 0) {
        context.chunk.status = 'error';
        context.chunk.errorMessage = 'No labels merged in this PDF chunk.';
        await persistMergeJobSnapshot(job, { required: true });
        return false;
      }

      context.chunk.labelCount = context.chunk.successfulEntryIds.length;
      const bytes = await context.document.save();
      signal?.throwIfAborted();
      const base64 = Buffer.from(bytes).toString('base64');
      context.chunk.mergedPdfBase64 = base64;
      context.chunk.fileSize = bytes.byteLength;
      context.chunk.status = 'done';
      const durableChunk = await persistMergedPdfChunk({
        jobId,
        chunkNumber: context.chunk.chunkNumber,
        fileName: context.chunk.fileName ?? null,
        labelCount: context.chunk.labelCount,
        entryIds: context.chunk.entryIds,
        successfulEntryIds: context.chunk.successfulEntryIds,
        base64,
        generation: job.generation,
      });
      if (!durableChunk) {
        throw new PrintQueueDurableStatusError(
          'The merged PDF chunk could not be saved durably. Please retry the merge.',
        );
      }
      // The artifact store owns completed bytes. Do not retain every completed
      // chunk as base64 in worker memory.
      delete context.chunk.mergedPdfBase64;
      await persistMergeJobSnapshot(job, { required: true });
      return true;
    };

    let processed = 0;
    let producedChunkCount = completedChunks.size;

    for (const plan of chunkPlans) {
      signal?.throwIfAborted();
      const completed = completedChunks.get(plan.chunkNumber);
      if (
        completed &&
        completed.entryIds.length === plan.items.length &&
        completed.entryIds.every((entryId, index) => entryId === plan.items[index]?.id)
      ) {
        processed += plan.items.length;
        continue;
      }
      // Prefetch is scoped to one bounded PDF chunk. At most one chunk's label
      // bytes can be resident in the worker, rather than all selected labels.
      const prefetchItems: Array<{ id: string; url: string }> = [];
      for (const entry of plan.items) {
        if (shippingHoldsByOrderId.get(Number(entry.orderId))) continue;
        try {
          prefetchItems.push({ id: entry.id, url: resolveLabelFetchUrl(entry.labelUrl, requestOrigin) });
        } catch {
          // The per-entry branch below reports invalid URLs.
        }
      }
      const prefetch = startLabelPrefetch(prefetchItems, {
        concurrency: env.PRINT_QUEUE_MERGE_FETCH_CONCURRENCY,
        timeoutMs: 15_000,
      });
      const context = await createChunkContext(plan);

      for (const e of plan.items) {
        signal?.throwIfAborted();
        processed += 1;
        job.current = processed - 1;
        job.progress = Math.round(((processed - 1) / sorted.length) * 90);
        job.message =
          totalChunks === 1
            ? `Merging label ${processed} of ${sorted.length}...`
            : `Merging label ${processed} of ${sorted.length} (PDF chunk ${plan.chunkNumber}/${totalChunks})...`;
        if (shouldPersistMergeProgress(processed, sorted.length)) {
          void persistMergeJobSnapshot(job);
        }

        const holdReason = shippingHoldsByOrderId.get(Number(e.orderId));
        if (holdReason) {
          job.labelErrors!.push(`Order ${e.orderNumber ?? e.orderId}: ${holdReason} - excluded from print batch`);
          failedEntryIds.add(e.id);
          continue;
        }

        let pdfBytes: Uint8Array | null = null;
        let labelFetchUrl: string;
        let isMockLabel = false;
        try {
          labelFetchUrl = resolveLabelFetchUrl(e.labelUrl, requestOrigin);
          isMockLabel = isMockLabelUrl(e.labelUrl) || isMockLabelUrl(labelFetchUrl);
        } catch (err) {
          job.labelErrors!.push(formatLabelUrlError(e, err));
          failedEntryIds.add(e.id);
          continue;
        }

        const addGroupHeaderIfNeeded = () => {
          const groupId = e.skuGroupId ?? '__ungrouped__';
          if (mergeHeaders && groupId !== context.lastGroup) {
            const groupRecipients = recipientsByGroup.get(groupId) ?? [];
            const headerPage = context.document.addPage([288, 432]);
            const { manifestNeeded } = drawHeader(
              headerPage,
              e,
              groupSizes.get(groupId) ?? 1,
              context.font,
              context.fontReg,
              rgb,
              isMockLabel,
              groupRecipients,
              BATCH_NAMES_HEADER_THRESHOLD,
              packageDimsByOrderId.get(Number(e.orderId)) ?? null
            );
            if (manifestNeeded && groupRecipients.length > 0) {
              const { comboLine, totalUnits } = buildComboSummaryLine(e);
              addBatchManifestPages(
                () => context.document.addPage([288, 432]),
                {
                  recipients: groupRecipients,
                  totalOrders: groupSizes.get(groupId) ?? groupRecipients.length,
                  totalUnits,
                  comboLine,
                  isTest: isMockLabel,
                },
                context.font,
                context.fontReg,
                rgb
              );
            }
            context.lastGroup = groupId;
          }
        };

        const addMockFallback = (reason: string) => {
          addGroupHeaderIfNeeded();
          const page = context.document.addPage([288, 432]);
          drawMockFallbackLabel(page, e, context.font, context.fontReg, rgb, reason);
          successfulEntryIds.push(e.id);
          context.chunk.successfulEntryIds.push(e.id);
        };

        // Per user override unlock shipped data on 2026-07-07 (batch-print pipeline): consume the
        // prefetched result. Every branch below maps 1:1 onto the previous inline-fetch branches —
        // same messages, same mock fallbacks, same failedEntryIds bookkeeping.
        const fetched: PrefetchResult = await prefetch(e.id);
        signal?.throwIfAborted();
        if (!fetched.ok && fetched.kind === 'http' && (fetched.status === 404 || fetched.status === 410)) {
          if (isMockLabel) {
            addMockFallback(`Mock label not found (HTTP ${fetched.status})`);
            continue;
          }
          job.labelErrors!.push(
            `Label expired for order ${e.orderNumber ?? e.orderId} (HTTP ${fetched.status}).`
          );
          failedEntryIds.add(e.id);
          continue;
        }
        if (!fetched.ok && fetched.kind === 'http') {
          if (isMockLabel) {
            addMockFallback(`Mock label fetch failed (HTTP ${fetched.status})`);
            continue;
          }
          job.labelErrors!.push(
            `Failed to fetch label for order ${e.orderNumber ?? e.orderId} (HTTP ${fetched.status}).`
          );
          failedEntryIds.add(e.id);
          continue;
        }
        if (!fetched.ok) {
          if (isMockLabel) {
            addMockFallback(fetched.message || 'Mock label fetch failed');
            continue;
          }
          job.labelErrors!.push(
            `Network error for order ${e.orderNumber ?? e.orderId}: ${fetched.message}`
          );
          failedEntryIds.add(e.id);
          continue;
        }
        pdfBytes = fetched.bytes;

        try {
          const labelDoc = await PDFDocument.load(pdfBytes!);
          if (labelDoc.getPageCount() === 0) {
            throw new Error('PDF contained no pages');
          }
          addGroupHeaderIfNeeded();
          await appendNormalizedLabelPages(context.document, labelDoc);
          successfulEntryIds.push(e.id);
          context.chunk.successfulEntryIds.push(e.id);
        } catch (err) {
          if (isMockLabel) {
            addMockFallback(`Mock label PDF fallback: ${(err as Error).message}`);
            continue;
          }
          job.labelErrors!.push(
            `PDF parse error for order ${e.orderNumber ?? e.orderId}: ${(err as Error).message}`
          );
          failedEntryIds.add(e.id);
        }
      }

      job.message =
        totalChunks === 1
          ? 'Finalizing PDF...'
          : `Finalizing PDF chunk ${plan.chunkNumber}/${totalChunks}...`;
      if (await finalizeChunk(context)) producedChunkCount += 1;
    }

    if (producedChunkCount === 0) {
      throw new Error(
        `All labels failed to load - no PDF produced.\n${job.labelErrors!.slice(0, 3).join('\n')}`
      );
    }

    job.progress = 95;
    void persistMergeJobSnapshot(job);
    const doneChunks = job.chunks.filter((chunk) => chunk.status === 'done');
    delete job.mergedPdfBase64;
    job.fileName =
      doneChunks.length === 1
        ? doneChunks[0]?.fileName
        : `batch_print_${ts}_${doneChunks.length}_chunks`;

    const failed = failedEntryIds.size;
    const success = successfulEntryIds.length;
    const doneMessage =
      failed > 0
        ? `Done - ${success} merged in ${doneChunks.length} PDF chunk${doneChunks.length === 1 ? '' : 's'} (${failed} failed - re-create those labels and re-queue).`
        : `Done - ${success} label${success === 1 ? '' : 's'} merged in ${doneChunks.length} PDF chunk${doneChunks.length === 1 ? '' : 's'}.`;

    job.status = 'done';
    job.progress = 100;
    job.current = success;
    job.message = doneMessage;
    await persistMergeJobSnapshot(job, { required: true });
  } catch (err) {
    job.status = 'error';
    job.errorMessage = (err as Error).message;
    job.message = `Error: ${job.errorMessage}`;
    await persistMergeJobSnapshot(job, { required: true });
    throw err;
  }
}

function resolveApiOrigin(requestOrigin?: string): string {
  const candidates = [
    requestOrigin,
    process.env.PUBLIC_API_URL,
    process.env.RENDER_EXTERNAL_URL,
    process.env.API_BASE_URL,
    process.env.VITE_API_URL,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
    } catch {
      // Try the next configured origin.
    }
  }
  return `http://localhost:${process.env.PORT || '3000'}`;
}

function resolveLabelFetchUrl(labelUrl: unknown, requestOrigin?: string): string {
  const trimmed = normalizePrintQueueLabelUrl(labelUrl);
  try {
    return new URL(trimmed).toString();
  } catch {
    const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    return new URL(path, resolveApiOrigin(requestOrigin)).toString();
  }
}

function isMockLabelUrl(labelUrl: unknown): boolean {
  if (typeof labelUrl !== 'string') return false;
  return /(?:^|\/)(?:api\/)?labels\/mock\/-?\d+(?:$|[?#/])/.test(labelUrl);
}

// PS-138: safePdfText / collapseQueueSkuLines / BATCH_NAMES_HEADER_THRESHOLD / BatchRecipient / resolveRecipientDisplayName moved to ./print-queue-pdf (imported + re-exported above). resolveScopedRecipient (below) stays and imports them back.

// Resolve a recipient for a queued entry from an order row, gating the
// ENTIRE row on client scope. Only when the order belongs to the same
// client as the queued entry do we trust ANY of its fields (name AND
// order number) â€” so a cross-client id collision can never surface either
// the other client's name or their order number on this batch.
export function resolveScopedRecipient(
  entry: { clientId: number; orderId: string; orderNumber?: string | null },
  row: { shipToName: string | null; orderNumber: string | null; clientId: number | null } | undefined
): BatchRecipient {
  const scopedRow = row && row.clientId === entry.clientId ? row : undefined;
  return resolveRecipientDisplayName({
    shipToName: scopedRow?.shipToName ?? null,
    orderNumber: entry.orderNumber ?? scopedRow?.orderNumber ?? null,
    orderId: entry.orderId,
  });
}

// PS-138: sortBatchRecipients / annotateDuplicateNames / planBatchNamesDisplay moved to ./print-queue-pdf (imported + re-exported above).

// Render-time join: resolve recipient names for every queued entry from
// authoritative order data (orders.shipToName) keyed by orderId, scoped
// to the entry's own clientId. No migration needed â€” already-queued rows
// render names immediately. Cross-client names can never attach because
// the shipToName is only trusted when orders.clientId === entry.clientId.
async function loadBatchRecipientsByGroup(
  entriesByGroup: Map<string, PrintQueueEntry[]>
): Promise<Map<string, BatchRecipient[]>> {
  const ids = new Set<number>();
  for (const list of entriesByGroup.values()) {
    for (const e of list) {
      const idNum = Number(e.orderId);
      if (Number.isFinite(idNum)) ids.add(idNum);
    }
  }

  const orderById = new Map<
    number,
    { shipToName: string | null; orderNumber: string | null; clientId: number | null }
  >();
  if (ids.size > 0) {
    const rows = await db
      .select({
        id: orders.id,
        shipToName: orders.shipToName,
        orderNumber: orders.orderNumber,
        clientId: orders.clientId,
      })
      .from(orders)
      .where(inArray(orders.id, [...ids]));
    for (const row of rows) {
      orderById.set(row.id, {
        shipToName: row.shipToName,
        orderNumber: row.orderNumber,
        clientId: row.clientId,
      });
    }
  }

  const result = new Map<string, BatchRecipient[]>();
  for (const [groupId, list] of entriesByGroup) {
    const recipients = list.map((entry) => {
      const idNum = Number(entry.orderId);
      const row = Number.isFinite(idNum) ? orderById.get(idNum) : undefined;
      // Whole-row client-scope gate (name AND order number). See
      // resolveScopedRecipient â€” defense-in-depth vs orderId collision.
      return resolveScopedRecipient(entry, row);
    });
    result.set(groupId, sortBatchRecipients(recipients));
  }
  return result;
}

// Format shipment dimensions into a compact "LxWxH" packer hint (e.g. 11x8x6).
// Trailing ".0" is dropped but real fractions (8.5) are kept. Returns null if
// any dimension is missing/non-positive so the header simply omits the line.
export function formatPackageDims(
  l: number | null | undefined,
  w: number | null | undefined,
  h: number | null | undefined,
): string | null {
  const fmt = (n: number | null | undefined): string | null => {
    if (n == null || !Number.isFinite(n) || n <= 0) return null;
    return Number.isInteger(n) ? String(n) : String(Number(Number(n).toFixed(2)));
  };
  const L = fmt(l);
  const W = fmt(w);
  const H = fmt(h);
  if (!L || !W || !H) return null;
  return `${L}x${W}x${H}`;
}

// Render-time join: map each batched order to the package dimensions actually
// used for its label (latest active shipment). Mirrors loadBatchRecipientsByGroup
// â€” read-only, display-only. Per user override unlock shipped data on
// 2026-05-23: reads shipped dims for the batch-header packer hint; no writes.
async function loadPackageDimsByOrderId(
  entriesByGroup: Map<string, PrintQueueEntry[]>
): Promise<Map<number, string>> {
  const ids = new Set<number>();
  for (const list of entriesByGroup.values()) {
    for (const e of list) {
      const idNum = Number(e.orderId);
      if (Number.isFinite(idNum)) ids.add(idNum);
    }
  }
  const result = new Map<number, string>();
  if (ids.size === 0) return result;

  const rows = await db
    .select({
      orderId: shipments.orderId,
      dimsL: shipments.dimsL,
      dimsW: shipments.dimsW,
      dimsH: shipments.dimsH,
      createdAt: shipments.createdAt,
    })
    .from(shipments)
    .where(and(
      inArray(shipments.orderId, [...ids]),
      eq(shipments.voided, false),
      eq(shipments.isReturn, false),
    ))
    .orderBy(desc(shipments.createdAt));

  for (const row of rows) {
    const idNum = Number(row.orderId);
    if (!Number.isFinite(idNum) || result.has(idNum)) continue; // keep newest dims
    const dims = formatPackageDims(row.dimsL, row.dimsW, row.dimsH);
    if (dims) result.set(idNum, dims);
  }
  return result;
}

// PS-129 (per user override unlock shipped data on 2026-06-09): identify queue entries whose
// order is now on a shipping hold â€” cancelled locally/upstream (canonical_status) or shipped
// externally (PS-128) â€” so the merged print job EXCLUDES them. The batch SEND path already
// blocks creation via createLabelV2's guard; this covers a label that was already queued and
// only later became held. Read-only; never mutates orders.
//
// Per user override unlock shipped data on 2026-06-11: 'local_shipped' is deliberately NOT a
// print-queue hold. It is a label-CREATION guard (never buy second postage) â€” createLabelV2
// marks the order shipped BEFORE its queue entry exists, so every normally-labeled order is
// locally shipped by the time it reaches the queue. Treating it as a hold hid every fresh
// label from the active queue and failed it at merge with "Already shipped â€” excluded from
// print batch" (DJ report: order 1463 invisible in an empty queue). Printing an existing
// label purchases nothing; the creation-time block in decideShippingSafety is unchanged.
export async function loadShippingHoldsForOrderIds(ids: number[]): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  const unique = [...new Set(ids.filter((n) => Number.isFinite(n)))];
  if (unique.length === 0) return result;

  const rows = await db
    .select({
      id: orders.id,
      orderStatus: orders.orderStatus,
      canonicalStatus: orders.canonicalStatus,
      externallyShipped: orders.externallyShipped,
      sourceProvider: orders.sourceProvider,
    })
    .from(orders)
    .where(inArray(orders.id, unique));

  for (const row of rows) {
    const decision = decideShippingSafety({
      orderStatus: row.orderStatus,
      canonicalStatus: row.canonicalStatus,
      externallyShipped: row.externallyShipped,
      sourceProvider: row.sourceProvider,
      // Read-only over already-created labels / list display; only DEFINITE column signals
      // count here (no high-risk-unverified guessing).
      unverifiedPolicy: 'audit_only',
    });
    if (!decision.safe && decision.code !== 'local_shipped') {
      result.set(Number(row.id), decision.operatorStatus ?? decision.reason);
    }
  }
  return result;
}

async function loadShippingHoldsByOrderId(
  entriesByGroup: Map<string, PrintQueueEntry[]>,
): Promise<Map<number, string>> {
  const ids: number[] = [];
  for (const list of entriesByGroup.values()) {
    for (const e of list) ids.push(Number(e.orderId));
  }
  return loadShippingHoldsForOrderIds(ids);
}

// PS-138: PDF draw cluster (drawMockFallbackLabel/roundedRectSvgPath/drawHeader/ellipsizePdf/drawManifestPage/addBatchManifestPages/buildComboSummaryLine/renderBatchHeaderPdfForTest + MANIFEST_NAMES_PER_PAGE) moved to ./print-queue-pdf (imported + re-exported above).
