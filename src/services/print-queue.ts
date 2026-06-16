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
import { extractShipstationLabelUrl } from '../lib/shipstation/labels';
import { ensureShipmentConfirmationLifecycle } from './fulfillment/outbox';
import { createLabelV2, type CreateLabelInputDto } from './labels';
import { GLOBAL_SCOPE } from '../lib/client-store-scope';
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
// PS-256 (restart-safe print-queue merged PDF): durable side-store for the immutable merged PDF
// artifact so the view/download/signed-url routes survive a server restart. Env-gated default OFF
// (DURABLE_PRINT_QUEUE_PDF) — the OFF path is a true no-op, so existing behavior is unchanged.
import {
  persistMergedPdf,
  getMergedPdfBase64,
  cleanupOldMergedPdfs,
} from './print-queue-pdf-store';

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

export type MergeJob = {
  jobId: string;
  status: 'pending' | 'running' | 'done' | 'error';
  clientIds: number[];
  progress: number;
  total: number;
  current: number;
  message: string;
  mergedPdfBase64?: string;
  fileName?: string;
  errorMessage?: string;
  labelErrors?: string[];
  // PS-194: the entries that ACTUALLY merged into the batch PDF. Previously
  // computed inside runMergeJob and discarded after the count — so the FE's
  // Confirm-Printed gate ran on a session-only Set that a page refresh wiped.
  // Persisted on the job + durable snapshot and returned on the status DTO so
  // the gate is backend truth.
  successfulEntryIds: string[];
  // PS-195: every entry this merge covers — clearQueue refuses to delete an
  // entry that sits inside a pending/running merge job.
  entryIds: string[];
  createdAt: number;
};

export type QueueSendOrderInput = {
  orderId: number;
  clientId: number;
  orderNumber?: string | null;
  labelUrl?: unknown | null;
  label?: Omit<CreateLabelInputDto, 'orderId' | 'orderNumber'> & {
    orderId?: number;
    orderNumber?: string;
  };
  skuGroupId: string;
  primarySku?: string | null;
  itemDescription?: string | null;
  orderQty?: number;
  multiSkuData?: { sku: string; description?: string; qty: number }[] | null;
  scope?: PrintQueueListScope;
};

export type QueueSendJobResult = {
  orderId: number;
  success: boolean;
  queueEntryId?: string;
  alreadyQueued?: boolean;
  labelUrl?: string | null;
  trackingNumber?: string | null;
  error?: string;
  // PS-191: backend-owned retry eligibility on purchase failures (structural
  // proof-error classification — classifyLabelPurchaseRetry). The FE prompts
  // a re-rate on eligible failures; it never auto-repurchases.
  retryEligible?: boolean;
  retryReason?: string | null;
};

export type QueueSendJob = {
  jobId: string;
  status: 'pending' | 'running' | 'done' | 'error';
  clientIds: number[];
  progress: number;
  total: number;
  current: number;
  queued: number;
  failed: number;
  message: string;
  clientId?: number | null;
  createdAt: number;
  updatedAt: number;
  results: QueueSendJobResult[];
  queuedEntryIds: string[];
  errorMessage?: string;
};

export const PRINT_QUEUE_SEND_STATUS_KEY = 'print_queue.batch_send.last_run';
export const PRINT_QUEUE_MERGE_STATUS_KEY = 'print_queue.pdf_merge.last_run';
const PRINT_QUEUE_SEND_JOB_STATUS_PREFIX = 'print_queue.batch_send.job.';

type QueueSendResultSnapshot = {
  orderId: number;
  success: boolean;
  queueEntryId?: string;
  alreadyQueued?: boolean;
  trackingNumber?: string | null;
  error?: string;
  // PS-191: backend-owned retry eligibility on purchase failures (derived
  // structurally from the proof-error shape — see classifyLabelPurchaseRetry).
  // The FE renders these; it never regex-parses error text, and a retryable
  // failure only PROMPTS the operator — nothing auto-repurchases.
  retryEligible?: boolean;
  retryReason?: string | null;
};

export type QueueSendJobSnapshot = {
  version: 1;
  durableKey: typeof PRINT_QUEUE_SEND_STATUS_KEY;
  jobId: string;
  status: QueueSendJob['status'];
  active: boolean;
  clientIds: number[];
  progress: number;
  total: number;
  current: number;
  queued: number;
  failed: number;
  message: string;
  clientId: number | null;
  queuedEntryIds: string[];
  errorMessage: string | null;
  resultSamples: QueueSendResultSnapshot[];
  createdAt: string;
  updatedAt: string;
  persistedAt: string;
};

export type MergeJobSnapshot = {
  version: 1;
  durableKey: typeof PRINT_QUEUE_MERGE_STATUS_KEY;
  jobId: string;
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
  // PS-194: optional for back-compat with snapshots persisted before the
  // field existed — readers default to [].
  successfulEntryIds?: string[];
  createdAt: string;
  persistedAt: string;
};

export type PrintQueueListScope = {
  scopeClientIds?: number[];
  scopeStoreIds?: number[];
  scopeRestricted?: boolean;
};

function queueSendJobStatusKey(jobId: string): string {
  return `${PRINT_QUEUE_SEND_JOB_STATUS_PREFIX}${jobId}`;
}

const mergeJobs = new Map<string, MergeJob>();
const queueSendJobs = new Map<string, QueueSendJob>();
const QUEUE_SEND_ORDER_TIMEOUT_MS = 30_000;

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

function toQueueSendSnapshot(job: QueueSendJob): QueueSendJobSnapshot {
  return {
    version: 1,
    durableKey: PRINT_QUEUE_SEND_STATUS_KEY,
    jobId: job.jobId,
    status: job.status,
    active: job.status === 'pending' || job.status === 'running',
    clientIds: [...job.clientIds],
    progress: job.progress,
    total: job.total,
    current: job.current,
    queued: job.queued,
    failed: job.failed,
    message: job.message,
    clientId: job.clientId ?? null,
    queuedEntryIds: [...job.queuedEntryIds],
    errorMessage: job.errorMessage ?? null,
    resultSamples: job.results.slice(-10).map((result) => ({
      orderId: result.orderId,
      success: result.success,
      queueEntryId: result.queueEntryId,
      alreadyQueued: result.alreadyQueued,
      trackingNumber: result.trackingNumber ?? null,
      error: result.error,
      // PS-191: retry verdict survives into the durable snapshot too.
      retryEligible: result.retryEligible,
      retryReason: result.retryReason ?? null,
    })),
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
    persistedAt: new Date().toISOString(),
  };
}

function toMergeSnapshot(job: MergeJob): MergeJobSnapshot {
  return {
    version: 1,
    durableKey: PRINT_QUEUE_MERGE_STATUS_KEY,
    jobId: job.jobId,
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
    // PS-194: capped well above the 200-entry batch limit; the durable
    // snapshot is what lets Confirm-Printed survive a page refresh.
    successfulEntryIds: (job.successfulEntryIds ?? []).slice(0, 500),
    createdAt: new Date(job.createdAt).toISOString(),
    persistedAt: new Date().toISOString(),
  };
}

export async function persistQueueSendJobSnapshot(
  job: QueueSendJob,
  options: { required?: boolean } = {},
): Promise<void> {
  try {
    const value = JSON.stringify(toQueueSendSnapshot(job));
    const jobKey = queueSendJobStatusKey(job.jobId);
    await db
      .insert(settings)
      .values([
        { key: PRINT_QUEUE_SEND_STATUS_KEY, value },
        { key: jobKey, value },
      ])
      .onConflictDoUpdate({
        target: settings.key,
        set: { value },
      });
  } catch (err) {
    console.warn(
      '[print-queue] failed to persist batch-send status:',
      err instanceof Error ? err.message : err
    );
    if (options.required) {
      throw new PrintQueueDurableStatusError();
    }
  }
}

export async function getQueueSendJobSnapshot(jobId: string): Promise<QueueSendJobSnapshot | null> {
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

export async function persistMergeJobSnapshot(job: MergeJob): Promise<void> {
  try {
    const value = JSON.stringify(toMergeSnapshot(job));
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
}

export async function getLatestQueueSendJobSnapshot(): Promise<QueueSendJobSnapshot | null> {
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

export async function getLatestMergeJobSnapshot(): Promise<MergeJobSnapshot | null> {
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

function shouldPersistProgress(current: number, total: number): boolean {
  return current === total || current % 10 === 0;
}

// PS-256: durable merged PDFs are retained LONGER than the 30-min in-memory job retention so a
// download still works through a restart window (an operator who reopens the batch after the
// process recycled). 4h is well past the in-memory eviction yet bounded so old binaries don't
// accumulate. Best-effort + env-gated default OFF (no-op when OFF).
const DURABLE_PDF_RETENTION_MS = 4 * 60 * 60 * 1000;

function cleanOldJobs() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of mergeJobs.entries()) {
    if (job.createdAt < cutoff) mergeJobs.delete(id);
  }
  for (const [id, job] of queueSendJobs.entries()) {
    if (job.createdAt < cutoff) queueSendJobs.delete(id);
  }
  // Per user override unlock shipped data on 2026-06-16: PS-256 — prune old rows from the durable
  // merged-PDF side-store (the NEW print_queue_merged_pdfs table only). DELETEs nothing from
  // orders/shipments; best-effort + env-gated default OFF.
  void cleanupOldMergedPdfs(DURABLE_PDF_RETENTION_MS);
}

async function withConcurrency<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  maxConcurrent = 5
): Promise<void> {
  const queue = [...items];
  const running = new Set<Promise<void>>();
  while (queue.length > 0 || running.size > 0) {
    while (running.size < maxConcurrent && queue.length > 0) {
      const item = queue.shift();
      if (item !== undefined) {
        const task = fn(item).finally(() => running.delete(task));
        running.add(task);
      }
    }
    if (running.size > 0) {
      await Promise.race(running);
    }
  }
}

function updateQueueSendProgress(job: QueueSendJob) {
  job.progress = job.total > 0 ? Math.round((job.current / job.total) * 100) : 100;
  job.updatedAt = Date.now();
  job.message =
    job.status === 'done'
      ? `Queued ${job.queued}/${job.total}${job.failed ? `, ${job.failed} failed` : ''}`
      : `Sending to queue ${job.current}/${job.total}`;
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
    .select({ labelUrl: shipments.labelUrl })
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

  if (!row?.labelUrl) return null;
  return normalizePrintQueueLabelUrl(row.labelUrl);
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

function normalizeClientIds(values: number[]): number[] {
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

function timeoutAfter(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

async function repairMissingConfirmationForQueuedLabel(orderId: number | string): Promise<void> {
  const parsedOrderId = Number(orderId);
  if (!Number.isInteger(parsedOrderId) || parsedOrderId <= 0) return;
  try {
    // Per user override unlock shipped data on 2026-06-01: queueing an
    // existing shipped label may repair only the missing confirmation lifecycle;
    // it never creates labels, buys postage, or marks printed. Any marketplace
    // confirmation is performed by the normal fulfillment outbox connector.
    const result = await ensureShipmentConfirmationLifecycle({
      orderId: parsedOrderId,
      dryRun: false,
      processNow: true,
    });
    if (
      result.plan.plannedAction === 'create_outbox_pending' &&
      result.processed &&
      result.processed.failed > 0
    ) {
      console.warn(
        `[print-queue] repaired confirmation processing failed orderId=${parsedOrderId}:`,
        result.processed,
      );
    }
  } catch (err) {
    console.warn(
      `[print-queue] missing confirmation repair failed orderId=${parsedOrderId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

async function processQueueSendOrder(
  order: QueueSendOrderInput,
  scope: PrintQueueListScope = {}
): Promise<QueueSendJobResult> {
  let labelUrl: unknown = order.labelUrl ?? null;
  let trackingNumber: string | null = null;

  if (!labelUrl) {
    let existingLabelUrl = await findExistingQueueableLabelForOrder(order.orderId);
    if (existingLabelUrl) {
      labelUrl = existingLabelUrl;
    } else if (!order.label) {
      throw new Error('Missing label payload');
    } else {
      try {
        // PS-233: the print-queue worker is a TRUSTED internal caller — the
        // operator's scope was already enforced when the entry was queued, and
        // the queue routes are gated by print_queue:write (portal roles can't
        // reach them). GLOBAL_SCOPE = no per-resource restriction here.
        const created = await createLabelV2({
          ...order.label,
          orderId: order.orderId,
          orderNumber: order.orderNumber ?? order.label.orderNumber,
        }, GLOBAL_SCOPE);
        labelUrl = created.labelUrl;
        trackingNumber = created.trackingNumber;
      } catch (err) {
        existingLabelUrl = getExistingLabelUrl(err);
        // Per user override unlock shipped data on 2026-05-23: recover labels
        // that were persisted before a later post-label queue step failed.
        const recoverCreatedLabelUrl = existingLabelUrl ?? await findExistingQueueableLabelForOrder(order.orderId);
        if (!recoverCreatedLabelUrl) throw err;
        labelUrl = recoverCreatedLabelUrl;
      }
    }
  }

  if (!labelUrl) throw new Error('Label was created without a queueable URL');
  const queueableLabelUrl = normalizePrintQueueLabelUrl(labelUrl);

  const { entry, alreadyQueued } = await addToQueue({
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
  });

  return {
    orderId: order.orderId,
    success: true,
    queueEntryId: entry.id,
    alreadyQueued,
    labelUrl: queueableLabelUrl,
    trackingNumber,
  };
}

// ─── CRUD ─────────────────────────────────────────────────────────────

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
  // caller sent no real identity — absent, or the degraded ORDER:/order-<id>
  // fallback identifier-only callers use — rebuild it from the order's items
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
    })
    .returning();

  await repairMissingConfirmationForQueuedLabel(input.orderId);

  return { entry: entry!, alreadyQueued };
}

export async function startQueueSendJob(input: {
  orders: QueueSendOrderInput[];
  concurrency?: number;
  scope?: PrintQueueListScope;
}): Promise<{ jobId: string; total: number }> {
  if (!input.orders.length) throw new Error('orders must be non-empty');

  cleanOldJobs();
  const jobId = randomUUID();
  const clientIds = normalizeClientIds(input.orders.map((order) => order.clientId));
  const firstClientId = input.orders.find((order) => Number.isFinite(order.clientId))?.clientId ?? null;
  const job: QueueSendJob = {
    jobId,
    status: 'pending',
    clientIds,
    progress: 0,
    total: input.orders.length,
    current: 0,
    queued: 0,
    failed: 0,
    message: `Starting queue send of ${input.orders.length} order${input.orders.length === 1 ? '' : 's'}...`,
    clientId: firstClientId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    results: [],
    queuedEntryIds: [],
  };
  queueSendJobs.set(jobId, job);

  await persistQueueSendJobSnapshot(job, { required: true });
  void runQueueSendJob(jobId, input.orders, input.concurrency, input.scope);
  return { jobId, total: input.orders.length };
}

export function getQueueSendJobStatus(jobId: string): QueueSendJob | null {
  cleanOldJobs();
  return queueSendJobs.get(jobId) ?? null;
}

async function runQueueSendJob(
  jobId: string,
  orders: QueueSendOrderInput[],
  requestedConcurrency = 5,
  scope: PrintQueueListScope = {}
) {
  const job = queueSendJobs.get(jobId);
  if (!job) return;

  const concurrency = Math.max(1, Math.min(8, Math.floor(requestedConcurrency || 5)));
  job.status = 'running';
  updateQueueSendProgress(job);
  void persistQueueSendJobSnapshot(job);

  try {
    await withConcurrency(
      orders,
      async (order) => {
        try {
          const result = await Promise.race([
            processQueueSendOrder(order, order.scope ?? scope),
            timeoutAfter(
              QUEUE_SEND_ORDER_TIMEOUT_MS,
              `Timed out while sending order ${order.orderNumber ?? order.orderId} to queue`
            ),
          ]);

          job.queued += 1;
          if (result.queueEntryId) job.queuedEntryIds.push(result.queueEntryId);
          job.results.push(result);
        } catch (err) {
          job.failed += 1;
          // PS-191: classify retry eligibility STRUCTURALLY (proof-error code
          // + details.reason) — never by parsing the message. The FE surfaces
          // a "refresh the rate and click again" prompt for eligible failures
          // and must never auto-repurchase.
          const retry = classifyLabelPurchaseRetry(err);
          job.results.push({
            orderId: order.orderId,
            success: false,
            error: err instanceof Error ? err.message : 'Unknown error',
            retryEligible: retry.retryEligible,
            retryReason: retry.retryReason,
          });
        } finally {
          job.current += 1;
          updateQueueSendProgress(job);
          if (shouldPersistProgress(job.current, job.total)) {
            void persistQueueSendJobSnapshot(job);
          }
        }
      },
      concurrency
    );

    const seenOrderIds = new Set(job.results.map((result) => result.orderId));
    for (const order of orders) {
      if (seenOrderIds.has(order.orderId)) continue;
      job.failed += 1;
      job.current += 1;
      job.results.push({
        orderId: order.orderId,
        success: false,
        error: 'Queue send did not report a result',
      });
    }
    if (job.current > job.total) job.current = job.total;
    job.status = 'done';
    updateQueueSendProgress(job);
    await persistQueueSendJobSnapshot(job);
  } catch (err) {
    job.status = 'error';
    job.errorMessage = err instanceof Error ? err.message : 'Queue send failed';
    job.message = job.errorMessage;
    job.updatedAt = Date.now();
    await persistQueueSendJobSnapshot(job);
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
// in-flight print — those entries are refused, not deleted.
function inFlightMergeEntryIds(): Set<string> {
  const ids = new Set<string>();
  for (const job of mergeJobs.values()) {
    if (job.status !== 'pending' && job.status !== 'running') continue;
    for (const entryId of job.entryIds ?? []) ids.add(entryId);
  }
  return ids;
}

// PS-195: clears are EXPLICITLY TARGETED — the caller names the queued entry
// ids it intends to remove (the route schema already rejects id-less
// requests). Deletion stays bounded to status='queued' within client/scope,
// and entries belonging to a running merge job are skipped and reported.
export async function clearQueue(input: {
  entryIds: string[];
  clientId?: number;
  scope?: PrintQueueListScope;
}): Promise<{ cleared: number; blockedInFlight: number }> {
  if (!input.entryIds.length) return { cleared: 0, blockedInFlight: 0 };
  const inFlight = inFlightMergeEntryIds();
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
 * never needs printing — the shipment-tracking poller moves the entry
 * 'queued' → 'delivered' so it leaves the ACTIVE queue (which filters
 * status='queued') but stays in History with auto_retired_at. This is the
 * ONLY writer of the 'delivered' status. Strictly narrower than the operator
 * actions above: the WHERE pins status='queued' so 'printed' history is never
 * touched, and nothing is ever DELETED (the no-op policy in
 * removeQueueEntriesForOrder still holds — order status alone never removes a
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

// ─── PDF MERGE ────────────────────────────────────────────────────────

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
  // sort here — this is what guarantees the merged PDF comes out in order
  // (1231, 1239, 1247, …). Natural sort handles numeric and mixed-format
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
    status: 'pending',
    clientIds: normalizeClientIds(entries.map((entry) => entry.clientId)),
    progress: 0,
    total: entries.length,
    current: 0,
    message: `Starting merge of ${entries.length} label${entries.length === 1 ? '' : 's'}…`,
    createdAt: Date.now(),
    labelErrors: [],
    successfulEntryIds: [],
    entryIds: entries.map((entry) => entry.id),
  };
  mergeJobs.set(jobId, job);

  void persistMergeJobSnapshot(job);
  void runMergeJob(jobId, entries, input.mergeHeaders !== false, input.requestOrigin);
  return { jobId, total: entries.length };
}

export function getMergeJobStatus(jobId: string): MergeJob | null {
  return mergeJobs.get(jobId) ?? null;
}

// Per user override unlock shipped data on 2026-06-16: PS-256 — the PDF-serving routes
// (view / download / signed-url) obtain the merged batch PDF here. The in-memory mergeJobs Map
// is the fast default; on a MISS (job evicted/never in this process, OR present but with empty
// bytes) we fall back to the durable snapshot + side-store: if the snapshot says the merge
// completed, we rehydrate the bytes from print_queue_merged_pdfs so the batch survives a server
// restart instead of 404ing. Env-gated default OFF — when the flag is OFF this returns exactly
// the in-memory job (current behavior), since getMergedPdfBase64 is a no-op returning null. This
// only RE-READS the already-generated PDF artifact; it never re-generates labels, buys postage,
// notifies a marketplace, or mutates any shipped/cancelled order or shipment.
export async function getMergeJobForServe(jobId: string): Promise<MergeJob | null> {
  const inMemory = mergeJobs.get(jobId) ?? null;
  if (inMemory && inMemory.status === 'done' && inMemory.mergedPdfBase64) {
    return inMemory; // fast path — bytes already in process memory
  }

  // In-memory miss (or done-without-bytes). Only attempt a durable rehydrate when the durable
  // snapshot confirms THIS job completed — otherwise leave the caller's miss as-is.
  const snapshot = await getLatestMergeJobSnapshot();
  if (!snapshot || snapshot.jobId !== jobId || snapshot.status !== 'done') {
    return inMemory;
  }

  const base64 = await getMergedPdfBase64(jobId);
  if (!base64) return inMemory; // flag OFF or no durable bytes — unchanged behavior

  return {
    jobId: snapshot.jobId,
    status: 'done',
    clientIds: [...snapshot.clientIds],
    progress: snapshot.progress,
    total: snapshot.total,
    current: snapshot.current,
    message: snapshot.message,
    mergedPdfBase64: base64,
    fileName: snapshot.fileName ?? undefined,
    errorMessage: snapshot.errorMessage ?? undefined,
    labelErrors: snapshot.labelErrors,
    successfulEntryIds: snapshot.successfulEntryIds ?? [],
    entryIds: [],
    createdAt: Date.parse(snapshot.createdAt) || Date.now(),
  };
}

// PS-109 — canonical product-name resolution for the batch header. When a queued
// entry's multi_sku_data line (or the entry's primary item) has only a SKU and no real
// product name — a legacy row enqueued before the batch-send description fix — resolve
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

async function runMergeJob(
  jobId: string,
  entries: PrintQueueEntry[],
  mergeHeaders: boolean,
  requestOrigin?: string
) {
  const job = mergeJobs.get(jobId)!;
  job.status = 'running';
  void persistMergeJobSnapshot(job);
  job.message = 'Initializing PDF merge…';

  try {
    const { PDFDocument, rgb, StandardFonts } = await import('pdf-lib');
    const merged = await PDFDocument.create();
    const font = await merged.embedFont(StandardFonts.HelveticaBold);
    const fontReg = await merged.embedFont(StandardFonts.Helvetica);

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
    // PS-073 (per user override unlock shipped data on 2026-06-02):
    // resolve privacy-safe recipient names for each batch group via a
    // single render-time join to orders.shipToName (client-scoped). Used
    // only for the names reference / Batch Manifest; never mutates orders.
    const recipientsByGroup = await loadBatchRecipientsByGroup(entriesByGroup);
    const packageDimsByOrderId = await loadPackageDimsByOrderId(entriesByGroup);
    // PS-129: orders that became held (cancelled upstream / externally shipped) AFTER being
    // queued must not be merged into the print batch.
    const shippingHoldsByOrderId = await loadShippingHoldsByOrderId(entriesByGroup);
    let lastGroup: string | null = null;
    // PS-194: the job carries the live array — progress snapshots and the
    // final done-persist serialize whatever has merged so far, and the status
    // DTO exposes it for the FE Confirm-Printed gate.
    const successfulEntryIds: string[] = [];
    job.successfulEntryIds = successfulEntryIds;
    const failedEntryIds = new Set<string>();

    for (let i = 0; i < sorted.length; i += 1) {
      const e = sorted[i]!;
      job.current = i;
      job.progress = Math.round((i / sorted.length) * 90);
      if (shouldPersistProgress(i, sorted.length)) {
        void persistMergeJobSnapshot(job);
      }
      job.message = `Merging label ${i + 1} of ${sorted.length}…`;

      // PS-129: skip + clearly fail any entry whose order is now on a shipping hold
      // (cancelled upstream / externally shipped). Mirrors the existing per-entry failure
      // handling so one held order never blocks the rest of the batch.
      const holdReason = shippingHoldsByOrderId.get(Number(e.orderId));
      if (holdReason) {
        job.labelErrors!.push(`Order ${e.orderNumber ?? e.orderId}: ${holdReason} — excluded from print batch`);
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
        if (mergeHeaders && groupId !== lastGroup) {
          const groupRecipients = recipientsByGroup.get(groupId) ?? [];
          const headerPage = merged.addPage([288, 432]);
          const { manifestNeeded } = drawHeader(
            headerPage,
            e,
            groupSizes.get(groupId) ?? 1,
            font,
            fontReg,
            rgb,
            isMockLabel,
            groupRecipients,
            BATCH_NAMES_HEADER_THRESHOLD,
            packageDimsByOrderId.get(Number(e.orderId)) ?? null
          );
          // PS-073: large/overflow batches get a dedicated Batch Manifest
          // page inserted immediately after the header (before this group's
          // labels) instead of cramming names onto the 4x6 header.
          if (manifestNeeded && groupRecipients.length > 0) {
            const { comboLine, totalUnits } = buildComboSummaryLine(e);
            addBatchManifestPages(
              () => merged.addPage([288, 432]),
              {
                recipients: groupRecipients,
                totalOrders: groupSizes.get(groupId) ?? groupRecipients.length,
                totalUnits,
                comboLine,
                isTest: isMockLabel,
              },
              font,
              fontReg,
              rgb
            );
          }
          lastGroup = groupId;
        }
      };
      const addMockFallback = (reason: string) => {
        addGroupHeaderIfNeeded();
        const page = merged.addPage([288, 432]);
        drawMockFallbackLabel(page, e, font, fontReg, rgb, reason);
        successfulEntryIds.push(e.id);
      };
      try {
        const res = await fetch(labelFetchUrl, {
          headers: { Accept: 'application/pdf' },
          signal: AbortSignal.timeout(15_000),
        });
        if (res.status === 404 || res.status === 410) {
          if (isMockLabel) {
            addMockFallback(`Mock label not found (HTTP ${res.status})`);
            continue;
          }
          job.labelErrors!.push(
            `Label expired for order ${e.orderNumber ?? e.orderId} (HTTP ${res.status}).`
          );
          failedEntryIds.add(e.id);
          continue;
        }
        if (!res.ok) {
          if (isMockLabel) {
            addMockFallback(`Mock label fetch failed (HTTP ${res.status})`);
            continue;
          }
          job.labelErrors!.push(
            `Failed to fetch label for order ${e.orderNumber ?? e.orderId} (HTTP ${res.status}).`
          );
          failedEntryIds.add(e.id);
          continue;
        }
        pdfBytes = new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        if (isMockLabel) {
          addMockFallback((err as Error).message || 'Mock label fetch failed');
          continue;
        }
        job.labelErrors!.push(
          `Network error for order ${e.orderNumber ?? e.orderId}: ${(err as Error).message}`
        );
        failedEntryIds.add(e.id);
        continue;
      }

      try {
        const labelDoc = await PDFDocument.load(pdfBytes!);
        if (labelDoc.getPageCount() === 0) {
          throw new Error('PDF contained no pages');
        }
        addGroupHeaderIfNeeded();
        // Per user override unlock shipped data on 2026-06-02: display-only —
        // normalize each label onto the standard 4x6 print page (see
        // appendNormalizedLabelPages) so an oversized carrier label (e.g. FedEx
        // Home Delivery) prints the same size as USPS/UPS instead of dwarfing
        // them. No label bytes, postage, or shipped/cancelled data are mutated.
        await appendNormalizedLabelPages(merged, labelDoc);
        successfulEntryIds.push(e.id);
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

    if (merged.getPageCount() === 0) {
      throw new Error(
        `All labels failed to load — no PDF produced.\n${job.labelErrors!.slice(0, 3).join('\n')}`
      );
    }

    job.progress = 95;
    void persistMergeJobSnapshot(job);
    job.message = 'Finalizing PDF…';
    const bytes = await merged.save();
    job.mergedPdfBase64 = Buffer.from(bytes).toString('base64');

    const now = new Date();
    const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    job.fileName = `batch_print_${ts}.pdf`;

    // PDF generation/open/download is not proof of physical printing. Entries
    // remain active until the operator explicitly confirms they printed.

    const failed = failedEntryIds.size;
    const success = successfulEntryIds.length;
    const doneMessage =
      failed > 0
        ? `Done - ${success} merged (${failed} failed - re-create those labels and re-queue).`
        : `Done - ${success} label${success === 1 ? '' : 's'} merged.`;
    job.status = 'done';
    job.progress = 100;
    job.current = success;
    job.message = doneMessage;
    await persistMergeJobSnapshot(job);
    // Per user override unlock shipped data on 2026-06-16: PS-256 — persist the
    // already-generated merged batch PDF to a durable side-store so the
    // view/download/signed-url routes can still serve it after a server restart
    // (today the bytes live only in process memory and a restart 404s them). This
    // only STORES the immutable PDF artifact + re-reads it; it never re-generates
    // labels, buys postage, notifies a marketplace, or mutates any shipped/cancelled
    // order or shipment row. Best-effort + env-gated default OFF — never blocks the
    // merge hot path.
    void persistMergedPdf(jobId, job.fileName ?? null, job.mergedPdfBase64);
    job.message =
      failed > 0
        ? `Done — ${success} merged (${failed} failed — re-create those labels and re-queue).`
        : `Done — ${success} label${success === 1 ? '' : 's'} merged.`;
  } catch (err) {
    job.status = 'error';
    job.errorMessage = (err as Error).message;
    job.message = `Error: ${job.errorMessage}`;
    await persistMergeJobSnapshot(job);
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
// order number) — so a cross-client id collision can never surface either
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
// to the entry's own clientId. No migration needed — already-queued rows
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
      // resolveScopedRecipient — defense-in-depth vs orderId collision.
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
// — read-only, display-only. Per user override unlock shipped data on
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
// order is now on a shipping hold — cancelled locally/upstream (canonical_status) or shipped
// externally (PS-128) — so the merged print job EXCLUDES them. The batch SEND path already
// blocks creation via createLabelV2's guard; this covers a label that was already queued and
// only later became held. Read-only; never mutates orders.
//
// Per user override unlock shipped data on 2026-06-11: 'local_shipped' is deliberately NOT a
// print-queue hold. It is a label-CREATION guard (never buy second postage) — createLabelV2
// marks the order shipped BEFORE its queue entry exists, so every normally-labeled order is
// locally shipped by the time it reaches the queue. Treating it as a hold hid every fresh
// label from the active queue and failed it at merge with "Already shipped — excluded from
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
