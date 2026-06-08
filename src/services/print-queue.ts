import { randomUUID } from 'node:crypto';
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
import {
  collapseIdentityLines,
  resolveQueueLineIdentity,
  headerCardTitle,
  NO_SKU_PICK_NOTE,
  type CollapsedQueueLine,
} from './print-queue-identity';

// Per user override unlock shipped data on 2026-06-02: display-only print
// layout. Append a label PDF's pages to the merged print document, normalizing
// each onto the standard 4x6 (288x432) print page so an oversized carrier label
// (e.g. FedEx Home Delivery, which returns a larger page) prints the SAME size
// as the USPS/UPS labels instead of dwarfing them.
//
//  - A page already at 4x6 (within tolerance) is copied byte-for-byte — zero
//    risk to the working USPS/UPS labels.
//  - A rotated page is also copied as-is so its orientation is never altered.
//  - Only an oversized, un-rotated page is embedded and scaled to FIT the 4x6
//    page (aspect-ratio preserved, centered).
//
// Mutates nothing but the in-memory merged print PDF — no label bytes, postage,
// shipments, or shipped/cancelled order data are touched.
export async function appendNormalizedLabelPages(
  merged: import('pdf-lib').PDFDocument,
  labelDoc: import('pdf-lib').PDFDocument,
): Promise<void> {
  const TARGET_W = 288;
  const TARGET_H = 432;
  const SIZE_TOL = 8;
  const labelPages = labelDoc.getPages();
  const indices = labelDoc.getPageIndices();
  for (const [i, src] of labelPages.entries()) {
    const { width, height } = src.getSize();
    const rotation = (((src.getRotation().angle ?? 0) % 360) + 360) % 360;
    const isStandard =
      Math.abs(width - TARGET_W) <= SIZE_TOL && Math.abs(height - TARGET_H) <= SIZE_TOL;
    if (isStandard || rotation !== 0) {
      const [copied] = await merged.copyPages(labelDoc, [indices[i]!]);
      if (copied) merged.addPage(copied);
      continue;
    }
    const [embedded] = await merged.embedPages([src]);
    if (!embedded) continue;
    const scale = Math.min(TARGET_W / embedded.width, TARGET_H / embedded.height);
    const drawWidth = embedded.width * scale;
    const drawHeight = embedded.height * scale;
    const page = merged.addPage([TARGET_W, TARGET_H]);
    page.drawPage(embedded, {
      x: (TARGET_W - drawWidth) / 2,
      y: (TARGET_H - drawHeight) / 2,
      width: drawWidth,
      height: drawHeight,
    });
  }
}

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

function cleanOldJobs() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of mergeJobs.entries()) {
    if (job.createdAt < cutoff) mergeJobs.delete(id);
  }
  for (const [id, job] of queueSendJobs.entries()) {
    if (job.createdAt < cutoff) queueSendJobs.delete(id);
  }
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

function normalizeScopeIds(values: number[] | undefined): number[] {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );
}

function intArraySql(values: number[]): SQL {
  return sql`array[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::int[]`;
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
        const created = await createLabelV2({
          ...order.label,
          orderId: order.orderId,
          orderNumber: order.orderNumber ?? order.label.orderNumber,
        });
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
  const totalQty = entries.reduce((s, e) => s + (e.orderQty ?? 1), 0);
  return {
    queuedOrders: entries.map((e) => ({
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
      queued_at: e.queuedAt.toISOString(),
    })),
    totalOrders: entries.length,
    totalQty,
  };
}

export async function addToQueue(
  input: AddToQueueInput
): Promise<{ entry: PrintQueueEntry; alreadyQueued: boolean }> {
  await assertPrintQueueClientsVisible([input.clientId], input.scope);
  const labelUrl = normalizePrintQueueLabelUrl(input.labelUrl);

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
      skuGroupId: input.skuGroupId,
      primarySku: input.primarySku ?? null,
      itemDescription: input.itemDescription ?? null,
      orderQty: input.orderQty ?? 1,
      multiSkuData: input.multiSkuData ?? null,
      status: 'queued',
      printCount: 0,
      queuedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [printQueue.orderId, printQueue.clientId],
      set: {
        labelUrl,
        skuGroupId: input.skuGroupId,
        primarySku: input.primarySku ?? null,
        itemDescription: input.itemDescription ?? null,
        orderQty: input.orderQty ?? 1,
        multiSkuData: input.multiSkuData ?? null,
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
          job.results.push({
            orderId: order.orderId,
            success: false,
            error: err instanceof Error ? err.message : 'Unknown error',
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

export async function clearQueue(clientId?: number, scope: PrintQueueListScope = {}) {
  const conds = [eq(printQueue.status, 'queued')];
  if (clientId !== undefined) conds.push(eq(printQueue.clientId, clientId));
  conds.push(printQueueScopePredicate(scope));
  const rows = await db
    .delete(printQueue)
    .where(and(...conds))
    .returning({ id: printQueue.id });
  return rows.length;
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
  };
  mergeJobs.set(jobId, job);

  void persistMergeJobSnapshot(job);
  void runMergeJob(jobId, entries, input.mergeHeaders !== false, input.requestOrigin);
  return { jobId, total: entries.length };
}

export function getMergeJobStatus(jobId: string): MergeJob | null {
  return mergeJobs.get(jobId) ?? null;
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
    let lastGroup: string | null = null;
    const successfulEntryIds: string[] = [];
    const failedEntryIds = new Set<string>();

    for (let i = 0; i < sorted.length; i += 1) {
      const e = sorted[i]!;
      job.current = i;
      job.progress = Math.round((i / sorted.length) * 90);
      if (shouldPersistProgress(i, sorted.length)) {
        void persistMergeJobSnapshot(job);
      }
      job.message = `Merging label ${i + 1} of ${sorted.length}…`;

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

function safePdfText(value: unknown): string {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u00D7]/g, 'x')
    .replace(/[^\x20-\x7E]/g, '');
}

// PS-070 — resolve the pickable lines for a queue entry. Blank-SKU eBay lines
// are NO LONGER dropped: collapseIdentityLines keeps them keyed by title/id so
// multi-SKU combos stay complete and a no-SKU order still has a real identity.
// When there's no multi_sku_data, synthesize a single line from the primary
// sku / item description and run it through the same resolver, so a no-SKU
// order falls back to its title (or an explicit UNRESOLVED) — never the old
// "UNKNOWN SKU".
function collapseQueueSkuLines(
  entry: Pick<PrintQueueEntry, 'multiSkuData' | 'primarySku' | 'itemDescription' | 'orderQty'>,
): CollapsedQueueLine[] {
  const fromMulti = collapseIdentityLines(entry.multiSkuData);
  if (fromMulti.length > 0) return fromMulti;

  const sku = String(entry.primarySku ?? '').trim();
  const description = String(entry.itemDescription ?? '').trim();
  if (!sku && !description) return [];
  return collapseIdentityLines([{ sku, description, qty: entry.orderQty }]);
}

// ───────────────────────────────────────────────────────────────────
// PS-073 — Customer-name reference + Batch Manifest support.
// Per user override unlock shipped data on 2026-06-02: the Print Queue
// batch header/merge reads orders.shipToName (a shipped-data read path)
// to print a privacy-safe recipient-name rescue surface. This block adds
// ONLY read/derivation of recipient names + order numbers. It must never
// surface addresses, emails, phones, tracking numbers, label URLs, raw
// provider payloads, tokens, or secrets, and it does not mutate any
// shipped/cancelled order, shipment, or label record.
// ───────────────────────────────────────────────────────────────────

// Batches at or below this many orders show recipient names directly on
// the 4x6 batch header; larger batches get a dedicated Batch Manifest
// page instead so the header stays legible (see planBatchNamesDisplay).
export const BATCH_NAMES_HEADER_THRESHOLD = 30;

// The ONLY recipient fields allowed past this boundary. Intentionally
// minimal so address/email/phone/tracking can never ride along.
export type BatchRecipient = { name: string; orderNumber: string };

// Resolve a privacy-safe display name. Returns the recipient name when
// present, otherwise a safe order-number fallback — never PII.
export function resolveRecipientDisplayName(input: {
  shipToName?: string | null;
  orderNumber?: string | null;
  orderId?: string | null;
}): BatchRecipient {
  const orderNumber = String(input.orderNumber ?? input.orderId ?? '').trim();
  const name = String(input.shipToName ?? '').trim();
  if (name) return { name, orderNumber };
  return {
    name: orderNumber ? `Order ${orderNumber}` : 'Unnamed recipient',
    orderNumber,
  };
}

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

// Deterministic, case-insensitive ordering so the printed list is stable
// across renders (name, then order number to break ties).
export function sortBatchRecipients(list: BatchRecipient[]): BatchRecipient[] {
  return [...list].sort((a, b) => {
    const byName = a.name.toLocaleLowerCase().localeCompare(b.name.toLocaleLowerCase());
    return byName !== 0 ? byName : a.orderNumber.localeCompare(b.orderNumber);
  });
}

// Flag duplicate recipient names so the manifest can disambiguate them
// with their order number.
export function annotateDuplicateNames(
  list: BatchRecipient[]
): Array<BatchRecipient & { duplicate: boolean }> {
  const counts = new Map<string, number>();
  for (const r of list) {
    const key = r.name.toLocaleLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return list.map((r) => ({
    ...r,
    duplicate: (counts.get(r.name.toLocaleLowerCase()) ?? 0) > 1,
  }));
}

// Decide whether names go on the header or spill to a manifest page.
// Above the threshold the header shows a compact pointer only (no list)
// so we never cram 40-60+ names onto a 4x6 slip.
export function planBatchNamesDisplay(
  count: number,
  threshold = BATCH_NAMES_HEADER_THRESHOLD
): { onHeader: boolean; needsManifest: boolean } {
  if (count <= threshold) return { onHeader: true, needsManifest: false };
  return { onHeader: false, needsManifest: true };
}

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

function drawMockFallbackLabel(
  page: ReturnType<import('pdf-lib').PDFDocument['addPage']>,
  entry: PrintQueueEntry,
  font: import('pdf-lib').PDFFont,
  fontReg: import('pdf-lib').PDFFont,
  rgb: typeof import('pdf-lib').rgb,
  reason: string
) {
  const { width, height } = page.getSize();
  const pad = 14;
  const red = rgb(0.85, 0, 0);
  const black = rgb(0, 0, 0);
  const gray = rgb(0.38, 0.38, 0.38);

  page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(1, 1, 1) });
  page.drawRectangle({ x: 0, y: height - 36, width, height: 36, color: red });
  page.drawText('VOID - TEST LABEL - DO NOT SHIP', {
    x: pad,
    y: height - 24,
    size: 10,
    font,
    color: rgb(1, 1, 1),
  });

  page.drawText('PrepShip Test Label', { x: pad, y: height - 62, size: 16, font, color: black });
  page.drawText(safePdfText(`Order: ${entry.orderNumber ?? entry.orderId}`), { x: pad, y: height - 84, size: 10, font: fontReg, color: black });
  // PS-070 — never print a confident "SKU: Unknown SKU"; show the real sku or a
  // safe no-SKU/unresolved note (the title is drawn just below).
  const fallbackIdentity = resolveQueueLineIdentity({ sku: entry.primarySku, description: entry.itemDescription });
  page.drawText(safePdfText(fallbackIdentity.sku ? `SKU: ${fallbackIdentity.sku}` : fallbackIdentity.skuLineText), { x: pad, y: height - 104, size: 10, font: fontReg, color: black });
  page.drawText(safePdfText(`Qty: ${entry.orderQty ?? 1}`), { x: pad, y: height - 124, size: 10, font: fontReg, color: black });
  if (entry.itemDescription) {
    page.drawText(safePdfText(entry.itemDescription).slice(0, 48), { x: pad, y: height - 144, size: 8, font: fontReg, color: gray });
  }

  page.drawRectangle({ x: pad, y: 122, width: width - pad * 2, height: 72, borderColor: black, borderWidth: 1 });
  let x = pad + 8;
  for (let i = 0; i < 70; i += 1) {
    const barWidth = i % 3 === 0 ? 2 : 1;
    if (i % 4 !== 0) {
      page.drawRectangle({ x, y: 132, width: barWidth, height: 52, color: black });
    }
    x += barWidth + 2;
    if (x > width - pad - 8) break;
  }

  page.drawText('Fallback mock PDF page', { x: pad, y: 86, size: 9, font, color: black });
  page.drawText(safePdfText(reason).slice(0, 70), { x: pad, y: 70, size: 7, font: fontReg, color: gray });
}

// PS-073 — SVG path for a filled rounded rectangle, used for the prominent
// "BATCH HEADER" pill (the approved mock shows a rounded bar, not a full-bleed
// strip). pdf-lib's drawSvgPath places (0,0) at the given (x,y) and draws with
// y increasing DOWNWARD, so pass the pill's TOP-edge y and it fills downward.
function roundedRectSvgPath(w: number, h: number, r: number): string {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  return [
    `M ${rad} 0`,
    `H ${w - rad}`,
    `Q ${w} 0 ${w} ${rad}`,
    `V ${h - rad}`,
    `Q ${w} ${h} ${w - rad} ${h}`,
    `H ${rad}`,
    `Q 0 ${h} 0 ${h - rad}`,
    `V ${rad}`,
    `Q 0 0 ${rad} 0`,
    'Z',
  ].join(' ');
}

function drawHeader(
  page: ReturnType<import('pdf-lib').PDFDocument['addPage']>,
  entry: PrintQueueEntry,
  totalOrders: number,
  font: import('pdf-lib').PDFFont,
  fontReg: import('pdf-lib').PDFFont,
  rgb: typeof import('pdf-lib').rgb,
  // 2026-05-14: drawHeader now takes an isTest flag so it can stamp
  // a small red "TEST" marker on the BATCH HEADER bar when the
  // entry's label URL is a mock (i.e. the operator is running the
  // test-order flow rather than a real shipment). Layout below the
  // bar is identical between test and real — only the marker changes
  // — so what an operator sees in test prints faithfully predicts
  // what their boss will see in real prints.
  isTest = false,
  // PS-073 (per user override unlock shipped data on 2026-06-02):
  // recipients holds the privacy-safe name list for THIS batch group
  // (already client-scoped + sorted); threshold governs header-vs-
  // manifest. Returns whether a Batch Manifest page is still required
  // (i.e. names did not fit on the header).
  recipients: BatchRecipient[] = [],
  threshold = BATCH_NAMES_HEADER_THRESHOLD,
  // Compact "LxWxH" package hint (e.g. 11x8x6) drawn under the QTY line so the
  // packer knows what size box to use. null/empty omits the line entirely.
  packageDims: string | null = null
): { manifestNeeded: boolean } {
  const { width, height } = page.getSize();
  const cx = width / 2;
  const pad = 16;

  page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(1, 1, 1) });
  // PS-073 — prominent rounded "BATCH HEADER" pill (matches the approved mock)
  // instead of a full-bleed strip. Inset with side margins + a small top margin;
  // the pill still occupies the top ~40pt band so content below is unchanged.
  const barH = 30;
  const barTop = height - 6; // PDF y of the pill's top edge
  const barW = width - pad * 2;
  page.drawSvgPath(roundedRectSvgPath(barW, barH, 8), {
    x: pad,
    y: barTop,
    color: rgb(0.1, 0.1, 0.1),
  });
  const headerTitle = 'BATCH HEADER';
  const headerTitleSize = 15;
  const headerBaseline = barTop - barH / 2 - headerTitleSize / 2 + 2;
  page.drawText(headerTitle, {
    x: cx - font.widthOfTextAtSize(headerTitle, headerTitleSize) / 2,
    y: headerBaseline,
    size: headerTitleSize,
    font,
    color: rgb(1, 1, 1),
  });
  // Test-mode stamp: small red "TEST" at the right end of the pill. Doesn't
  // shift any other content.
  if (isTest) {
    const testLabel = 'TEST';
    const testSize = 11;
    page.drawText(testLabel, {
      x: pad + barW - 12 - font.widthOfTextAtSize(testLabel, testSize),
      y: barTop - barH / 2 - testSize / 2 + 1,
      size: testSize,
      font,
      color: rgb(1, 0.45, 0.45),
    });
  }

  const ink = rgb(0.1, 0.1, 0.1);
  const sub = rgb(0.45, 0.45, 0.45);

  // Truncate text with an ellipsis so long names/SKUs never overrun
  // their column or the page edge.
  const fitText = (text: string, size: number, f: typeof font, maxW: number): string => {
    let t = safePdfText(text);
    if (f.widthOfTextAtSize(t, size) <= maxW) return t;
    while (t.length > 1 && f.widthOfTextAtSize(`${t}...`, size) > maxW) t = t.slice(0, -1);
    return `${t}...`;
  };

  // PS — wrap the FULL text across multiple lines so a long product name is
  // shown COMPLETELY instead of being shrunk + cut off with "...". Greedy
  // word-wrap at the given size; a single word wider than the column is
  // hard-broken. Only the LAST kept line is ellipsized, and only if the text
  // exceeds `maxLines` (a safety cap so a many-SKU combo can't overrun the
  // 4x6). Per user override unlock shipped data on 2026-06-02: display-only
  // change to the PS-073 batch header — reads no new fields, mutates nothing.
  const wrapText = (
    text: string,
    size: number,
    f: typeof font,
    maxW: number,
    maxLines: number,
  ): string[] => {
    const clean = safePdfText(text).replace(/\s+/g, ' ').trim();
    if (!clean) return [''];
    if (f.widthOfTextAtSize(clean, size) <= maxW) return [clean];

    // Hard-break a single word that is itself wider than the column.
    const breakLongWord = (word: string, out: string[]): string => {
      let w = word;
      while (w.length > 1 && f.widthOfTextAtSize(w, size) > maxW) {
        let lo = 1;
        let hi = w.length;
        let fit = 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (f.widthOfTextAtSize(w.slice(0, mid), size) <= maxW) {
            fit = mid;
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
        out.push(w.slice(0, fit));
        w = w.slice(fit);
      }
      return w;
    };

    const lines: string[] = [];
    let current = '';
    for (const word of clean.split(' ')) {
      const candidate = current ? `${current} ${word}` : word;
      if (f.widthOfTextAtSize(candidate, size) <= maxW) {
        current = candidate;
        continue;
      }
      if (current) {
        lines.push(current);
        current = '';
      }
      current = f.widthOfTextAtSize(word, size) > maxW ? breakLongWord(word, lines) : word;
    }
    if (current) lines.push(current);

    if (lines.length <= maxLines) return lines;

    // Over the cap: keep the first maxLines lines, ellipsize the last kept one.
    const kept = lines.slice(0, maxLines);
    let last = kept.pop() ?? '';
    while (last.length > 1 && f.widthOfTextAtSize(`${last}...`, size) > maxW) {
      last = last.slice(0, -1);
    }
    kept.push(`${last}...`);
    return kept;
  };

  // ── 1) Item/pick cards (top): product name left, xN right, sku below.
  // Every SKU in a multi-SKU combo gets its own outlined card; a single
  // SKU still renders as one card so the layout is consistent.
  const cards: CollapsedQueueLine[] = (() => {
    const lines = collapseQueueSkuLines(entry);
    if (lines.length > 0) return lines;
    // PS-070 — no usable sku/title/id: flag UNRESOLVED, never a fake pickable SKU.
    const qtyValue = Number(entry.orderQty);
    const id = resolveQueueLineIdentity({});
    return [{
      sku: id.sku,
      description: id.title,
      qty: Number.isFinite(qtyValue) && qtyValue > 0 ? Math.trunc(qtyValue) : 1,
      groupToken: id.groupToken,
      kind: id.kind,
      cardTitle: id.cardTitle,
      skuLineText: id.skuLineText,
    }];
  })();

  // Cap how many cards render so a high-SKU combo can't push the order
  // count into negative space (the count has a font-size floor). Hidden
  // SKUs are summarised in a "+N more" line; the QTY total below still
  // counts ALL SKUs, and the manifest combo line lists every SKU.
  const MAX_HEADER_CARDS = 6;
  const visibleCards = cards.slice(0, MAX_HEADER_CARDS);
  const hiddenCardCount = cards.length - visibleCards.length;

  // Card/text sizes scale down as the SKU count grows so the mock's bold
  // card look is preserved for the common 1-2 SKU case while many-SKU
  // combos still fit. (Big, prominent product-name cards per the design.)
  const n = cards.length;
  const cardH = n <= 2 ? 42 : n === 3 ? 38 : n <= 5 ? 33 : 28;
  const cardGap = n <= 3 ? 8 : n <= 5 ? 6 : 5;
  const titleSize = n <= 2 ? 18 : n === 3 ? 16 : n <= 5 ? 14 : 12.5;
  const skuSize = n <= 3 ? 10.5 : 9;
  const qtySize = n <= 2 ? 19 : n <= 5 ? 16 : 15;

  // PS-073 — adaptive product-name font. A short/normal name keeps the bold
  // default size (the design default — e.g. "Leeds Line V2"); only a LONG name
  // steps the font down so the full name stays visible without ballooning into
  // an oversized multi-line block. The driver is the name's NATURAL wrapped
  // line count at the default size (measured with a high cap so it never
  // ellipsizes here), not the SKU count. Floor keeps it legible.
  const TITLE_MIN_SIZE = n <= 2 ? 11 : 10;
  const fitTitleSize = (text: string, maxW: number): number => {
    const naturalLines = wrapText(text, titleSize, font, maxW, 99).length;
    if (naturalLines <= 2) return titleSize; // short/normal -> default, no shrink
    // Long name: drop ~1.5pt per extra line beyond 2, clamped to [min, default].
    const stepped = titleSize - (naturalLines - 2) * 1.5;
    return Math.max(TITLE_MIN_SIZE, Math.min(titleSize, stepped));
  };

  let y = height - 40 - 12;
  for (const item of visibleCards) {
    const boxW = width - pad * 2;
    const qtyText = `x${item.qty}`;
    const qtyW = font.widthOfTextAtSize(qtyText, qtySize);

    // PS — show the FULL product name. Wrap it across as many lines as needed
    // and grow the card to fit, instead of shrinking to one line and cutting
    // it off with "...". `maxTitleLines` caps height per SKU count so a
    // many-SKU combo still fits a 4x6; the common 1-2 SKU case (lots of free
    // space) gets enough lines to show everything.
    const maxTitleLines = n <= 2 ? 6 : n === 3 ? 3 : n <= 5 ? 2 : 1;
    const titleMaxW = boxW - 24 - qtyW - 8;
    // PS-109: never render the SKU as the product name; show "Unnamed item" when no
    // real name is available, with the real "sku: X" still on the line below.
    const titleText = headerCardTitle(item);
    // Shrink only when the name is genuinely long (see fitTitleSize); short
    // names render at the default size unchanged.
    const itemTitleSize = fitTitleSize(titleText, titleMaxW);
    const titleLines = wrapText(titleText, itemTitleSize, font, titleMaxW, maxTitleLines);

    // Dynamic card height: keep the original fixed height for a single-line
    // title (so single-line cards — and the recipient-names vertical budget —
    // are byte-identical to before) and add ONE line-height per EXTRA wrapped
    // line. This is what stops a wrapped name from silently stealing space
    // from the names list when it isn't needed.
    const titleLineH = Math.round(itemTitleSize * 1.18);
    const dynCardH = cardH + Math.max(0, titleLines.length - 1) * titleLineH;

    // PS-073 — rounded item card (matches the approved mock). drawSvgPath takes
    // the TOP-edge y and fills downward, so pass `y` (the card's top).
    page.drawSvgPath(roundedRectSvgPath(boxW, dynCardH, 6), {
      x: pad,
      y,
      color: rgb(0.94, 0.98, 1),
      borderColor: rgb(0.55, 0.7, 0.9),
      borderWidth: 1.25,
    });

    // Product NAME is the prominent card title; sku sits smaller below.
    // PS-070 — cardTitle prefers the product title; skuLineText is either a real
    // "sku: X" or a safe "no SKU — eBay item" / UNRESOLVED note, never a
    // confident "sku: UNKNOWN SKU". The first title line keeps the original
    // baseline; extra wrapped lines flow downward into the grown card.
    const firstTitleBaseline = y - Math.round(cardH * 0.46);
    let ty = firstTitleBaseline;
    for (const line of titleLines) {
      page.drawText(line, { x: pad + 12, y: ty, size: itemTitleSize, font, color: ink });
      ty -= titleLineH;
    }
    // QTY stays aligned with the first title line, top-right.
    page.drawText(qtyText, { x: pad + boxW - 12 - qtyW, y: firstTitleBaseline, size: qtySize, font, color: ink });
    // sku line sits at the bottom of the (possibly taller) card — same offset
    // from the bottom edge as the original layout.
    const skuBaseline = y - dynCardH + Math.round(skuSize * 0.7) + 5;
    page.drawText(fitText(item.skuLineText || (item.sku ? `sku: ${item.sku}` : NO_SKU_PICK_NOTE), skuSize, fontReg, boxW - 24), {
      x: pad + 12,
      y: skuBaseline,
      size: skuSize,
      font: fontReg,
      color: sub,
    });
    y -= dynCardH + cardGap;
  }
  if (hiddenCardCount > 0) {
    page.drawText(safePdfText(`+${hiddenCardCount} more SKU${hiddenCardCount === 1 ? '' : 's'} (full combo on manifest)`), {
      x: pad + 2,
      y: y - 9,
      size: 9,
      font: fontReg,
      color: sub,
    });
    y -= 15;
  }

  // ── 2) Total units per order ──
  const totalUnits = cards.reduce((sum, item) => sum + item.qty, 0);
  y -= 2;
  page.drawText(`QTY: ${totalUnits} total unit${totalUnits === 1 ? '' : 's'} per order`, {
    x: pad,
    y: y - 13,
    size: 13.5,
    font,
    color: ink,
  });
  y -= 24;

  // ── 2b) Package size hint (helps the packer pick the right box) ──
  // Drawn directly under the QTY line. Omitted when no dimensions are known so
  // the layout below (ORDERS count + names) reflows exactly as before.
  if (packageDims) {
    page.drawText(safePdfText(`Package: ${packageDims}`), {
      x: pad,
      y: y - 11,
      size: 11.5,
      font: fontReg,
      color: sub,
    });
    y -= 18;
  }

  // ── Decide names placement (header list vs manifest pointer) ──
  const regionTop = y;
  const regionBottom = 14; // floor above the footer line at y=4
  const plan = planBatchNamesDisplay(recipients.length, threshold);
  const nameRowH = 11.5;
  const namesTitleH = 18;
  const listBoxPad = 8;
  const dividerGap = 14;
  const labelSize = 15;
  const MIN_COUNT_FONT = 40;
  const MAX_COUNT_FONT = 60;
  const available = regionTop - regionBottom;
  const pointerH = 22;

  let renderNamesOnHeader = plan.onHeader && recipients.length > 0;
  let manifestPointer = plan.needsManifest;

  // Adaptive column count for the names list. Small batches keep the approved
  // 2-column look; larger batches (e.g. 20-30 names) widen to 3-4 columns so
  // the list stays SHORT enough to fit on the header without crushing the
  // ORDERS count below MIN_COUNT_FONT. Without this a header-sized batch
  // (<= threshold) could still spill to a manifest purely because 2 columns
  // made the list too tall. Cols never exceed 4 so names stay legible on the
  // 256pt-wide content area (≈64pt/col at 4).
  const maxNamesZoneH = available - dividerGap - labelSize - 4 - 10 - MIN_COUNT_FONT;
  const maxNameRows = Math.max(1, Math.floor((maxNamesZoneH - namesTitleH - listBoxPad) / nameRowH));
  let cols = 2;
  while (cols < 4 && Math.ceil(recipients.length / cols) > maxNameRows) cols += 1;
  const nameRows = Math.ceil(recipients.length / cols);
  let namesZoneH = renderNamesOnHeader ? namesTitleH + nameRows * nameRowH + listBoxPad : 0;

  // ── 3) Big ORDERS count — top-anchored, sized to leave room for the names
  // section DIRECTLY below it (matches the approved 2nd-image mock). The count
  // font is capped so the count + names stay compact at the top and the leftover
  // space falls to the BOTTOM of the page, instead of pinning names to the page
  // floor with a big gap between the count and the list.
  const reservedBelowCount = renderNamesOnHeader ? namesZoneH + dividerGap : manifestPointer ? pointerH : 0;
  let countFontSize = Math.floor(available - reservedBelowCount - labelSize - 4 - 10);
  if (renderNamesOnHeader && countFontSize < MIN_COUNT_FONT) {
    // names would crush the count below the legible floor -> spill to a manifest.
    renderNamesOnHeader = false;
    manifestPointer = true;
    namesZoneH = 0;
    countFontSize = Math.floor(available - (manifestPointer ? pointerH : 0) - labelSize - 16);
  }
  countFontSize = Math.max(MIN_COUNT_FONT, Math.min(MAX_COUNT_FONT, countFontSize));
  const manifestNeeded = manifestPointer;

  const countStr = String(totalOrders);
  const countW = font.widthOfTextAtSize(countStr, countFontSize);
  const countBlockH = countFontSize + 4 + labelSize;
  const countBlockTop = regionTop - 6;
  page.drawText(countStr, {
    x: cx - countW / 2,
    y: countBlockTop - countFontSize,
    size: countFontSize,
    font,
    color: rgb(0.05, 0.05, 0.05),
  });
  const labelStr = `ORDER${totalOrders === 1 ? '' : 'S'}`;
  page.drawText(labelStr, {
    x: cx - font.widthOfTextAtSize(labelStr, labelSize) / 2,
    y: countBlockTop - countFontSize - labelSize - 4,
    size: labelSize,
    font,
    color: rgb(0.4, 0.4, 0.4),
  });
  const countBlockBottom = countBlockTop - countBlockH;

  // ── 4) Names reference area — DIRECTLY below the ORDERS count ──
  if (renderNamesOnHeader) {
    const zoneTop = countBlockBottom - dividerGap;
    // thin divider between the count and the names section.
    page.drawLine({
      start: { x: pad, y: zoneTop + 6 },
      end: { x: width - pad, y: zoneTop + 6 },
      thickness: 0.75,
      color: rgb(0.85, 0.85, 0.85),
    });
    page.drawText(safePdfText(`Names in this batch (${recipients.length})`), {
      x: pad,
      y: zoneTop - 13,
      size: 12.5,
      font,
      color: ink,
    });
    const listTop = zoneTop - namesTitleH;
    const listBoxH = nameRows * nameRowH + listBoxPad;
    page.drawSvgPath(roundedRectSvgPath(width - pad * 2, listBoxH, 6), {
      x: pad,
      y: listTop,
      color: rgb(0.99, 0.99, 0.99),
      borderColor: rgb(0.85, 0.85, 0.85),
      borderWidth: 1,
    });
    const colW = (width - pad * 2) / cols;
    const nameSize = 9;
    recipients.forEach((recipient, i) => {
      const col = i % cols;
      const rowIdx = Math.floor(i / cols);
      const tx = pad + 10 + col * colW;
      const ty = listTop - 11 - rowIdx * nameRowH;
      page.drawText(fitText(recipient.name.toLocaleUpperCase(), nameSize, fontReg, colW - 16), {
        x: tx,
        y: ty,
        size: nameSize,
        font: fontReg,
        color: rgb(0.2, 0.2, 0.2),
      });
    });
  } else if (manifestPointer && recipients.length > 0) {
    page.drawText(safePdfText(`Names: see Batch Manifest page (${recipients.length}) >`), {
      x: pad,
      y: countBlockBottom - 16,
      size: 11,
      font,
      color: rgb(0.2, 0.2, 0.2),
    });
  }

  // PS-073 footer (matches the approved mock): the names list is a secondary
  // rescue/reference surface — primary picking info stays at the top. Sits below
  // the names region floor (regionBottom) so it never overlaps the list.
  const footerText = 'Reference only - primary picking info stays at top';
  const footerSize = 7.5;
  page.drawText(safePdfText(footerText), {
    x: cx - fontReg.widthOfTextAtSize(footerText, footerSize) / 2,
    y: 4,
    size: footerSize,
    font: fontReg,
    color: rgb(0.55, 0.55, 0.55),
  });

  return { manifestNeeded };
}

// Module-level ellipsis truncation (mirrors drawHeader's local fitText)
// so the manifest can clip long names without overrunning columns.
function ellipsizePdf(
  text: string,
  size: number,
  f: import('pdf-lib').PDFFont,
  maxW: number
): string {
  let t = safePdfText(text);
  if (f.widthOfTextAtSize(t, size) <= maxW) return t;
  while (t.length > 1 && f.widthOfTextAtSize(`${t}...`, size) > maxW) t = t.slice(0, -1);
  return `${t}...`;
}

// PS-073: how many recipient names fit on a single Batch Manifest page
// (3 columns x 24 rows). Drives pagination for very large batches.
const MANIFEST_NAMES_PER_PAGE = 72;

// PS-073 (per user override unlock shipped data on 2026-06-02):
// Draw ONE Batch Manifest page. Lists recipient names for a batch group
// with order numbers used ONLY to disambiguate duplicate/fallback names.
// Never renders addresses, emails, phones, tracking, or label data.
function drawManifestPage(
  page: ReturnType<import('pdf-lib').PDFDocument['addPage']>,
  opts: {
    comboLine: string;
    totalOrders: number;
    totalUnits: number;
    recipients: Array<BatchRecipient & { duplicate: boolean }>;
    pageIndex: number;
    pageCount: number;
    isTest: boolean;
    font: import('pdf-lib').PDFFont;
    fontReg: import('pdf-lib').PDFFont;
    rgb: typeof import('pdf-lib').rgb;
  }
) {
  const { font, fontReg, rgb } = opts;
  const { width, height } = page.getSize();
  const cx = width / 2;
  const pad = 16;
  const ink = rgb(0.1, 0.1, 0.1);
  const sub = rgb(0.45, 0.45, 0.45);

  page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(1, 1, 1) });
  page.drawRectangle({ x: 0, y: height - 40, width, height: 40, color: rgb(0.1, 0.1, 0.1) });
  const titleText = 'BATCH MANIFEST';
  page.drawText(titleText, {
    x: cx - font.widthOfTextAtSize(titleText, 13) / 2,
    y: height - 27,
    size: 13,
    font,
    color: rgb(1, 1, 1),
  });
  if (opts.isTest) {
    const testLabel = 'TEST';
    const testSize = 11;
    page.drawText(testLabel, {
      x: width - pad - font.widthOfTextAtSize(testLabel, testSize),
      y: height - 26,
      size: testSize,
      font,
      color: rgb(1, 0.45, 0.45),
    });
  }

  let y = height - 40 - 18;
  page.drawText(ellipsizePdf(opts.comboLine, 11, font, width - pad * 2), {
    x: pad,
    y,
    size: 11,
    font,
    color: ink,
  });
  y -= 16;
  page.drawText(
    safePdfText(`${opts.totalOrders} order${opts.totalOrders === 1 ? '' : 's'} | QTY: ${opts.totalUnits} total unit${opts.totalUnits === 1 ? '' : 's'} per order`),
    { x: pad, y, size: 10, font: fontReg, color: sub }
  );
  y -= 16;
  if (opts.pageCount > 1) {
    page.drawText(safePdfText(`Page ${opts.pageIndex + 1} of ${opts.pageCount}`), {
      x: pad,
      y,
      size: 9,
      font: fontReg,
      color: sub,
    });
    y -= 12;
  }
  page.drawLine({
    start: { x: pad, y: y - 2 },
    end: { x: width - pad, y: y - 2 },
    thickness: 1,
    color: rgb(0.85, 0.85, 0.85),
  });
  y -= 16;

  // 3-column name grid. Duplicate / fallback names get their order
  // number appended so identical names stay distinguishable.
  const cols = 3;
  const colW = (width - pad * 2) / cols;
  const rowH = 12;
  const nameSize = 8.5;
  const listTop = y;
  opts.recipients.forEach((recipient, i) => {
    const col = i % cols;
    const rowIdx = Math.floor(i / cols);
    const tx = pad + 4 + col * colW;
    const ty = listTop - rowIdx * rowH;
    const needsOrderNo = recipient.duplicate && recipient.orderNumber
      && !recipient.name.startsWith('Order ');
    // Reserve the disambiguating suffix width FIRST, then ellipsize only
    // the name part — so the (#orderNumber) that distinguishes duplicate
    // names is never the thing that gets truncated away.
    const suffix = needsOrderNo ? safePdfText(` (#${recipient.orderNumber})`.toLocaleUpperCase()) : '';
    const suffixW = suffix ? fontReg.widthOfTextAtSize(suffix, nameSize) : 0;
    const namePart = ellipsizePdf(
      recipient.name.toLocaleUpperCase(),
      nameSize,
      fontReg,
      Math.max(12, colW - 8 - suffixW)
    );
    page.drawText(`${namePart}${suffix}`, {
      x: tx,
      y: ty,
      size: nameSize,
      font: fontReg,
      color: rgb(0.2, 0.2, 0.2),
    });
  });
}

// Append all Batch Manifest pages for one group to the document, splitting
// across pages when a group has more names than fit on a single page.
function addBatchManifestPages(
  addPage: () => ReturnType<import('pdf-lib').PDFDocument['addPage']>,
  meta: {
    recipients: BatchRecipient[];
    totalOrders: number;
    totalUnits: number;
    comboLine: string;
    isTest: boolean;
  },
  font: import('pdf-lib').PDFFont,
  fontReg: import('pdf-lib').PDFFont,
  rgb: typeof import('pdf-lib').rgb
) {
  const annotated = annotateDuplicateNames(meta.recipients);
  const pageCount = Math.max(1, Math.ceil(annotated.length / MANIFEST_NAMES_PER_PAGE));
  for (let p = 0; p < pageCount; p += 1) {
    const slice = annotated.slice(p * MANIFEST_NAMES_PER_PAGE, (p + 1) * MANIFEST_NAMES_PER_PAGE);
    drawManifestPage(addPage(), {
      comboLine: meta.comboLine,
      totalOrders: meta.totalOrders,
      totalUnits: meta.totalUnits,
      recipients: slice,
      pageIndex: p,
      pageCount,
      isTest: meta.isTest,
      font,
      fontReg,
      rgb,
    });
  }
}

// Build a short item-combo summary line (e.g. "Booster Gel x1 + HU-10 x2")
// for the manifest header from the representative entry of a group.
function buildComboSummaryLine(entry: PrintQueueEntry): { comboLine: string; totalUnits: number } {
  const lines = collapseQueueSkuLines(entry);
  const id = resolveQueueLineIdentity({});
  const cards: CollapsedQueueLine[] = lines.length > 0
    ? lines
    : [{
        sku: id.sku,
        description: id.title,
        qty: Math.max(1, Math.trunc(Number(entry.orderQty) || 1)),
        groupToken: id.groupToken,
        kind: id.kind,
        cardTitle: id.cardTitle,
        skuLineText: id.skuLineText,
      }];
  const comboLine = cards
    // PS-070 — show the title for no-SKU lines, never a bare "UNKNOWN SKU".
    .map((c) => `${headerCardTitle(c)} x${c.qty}`)
    .join(' + ');
  const totalUnits = cards.reduce((sum, c) => sum + c.qty, 0);
  return { comboLine, totalUnits };
}

// PS-073: test-only renderer. Builds the header (+ manifest pages when
// needed) for a single batch group using IN-MEMORY fixture data so guards
// can certify layout/behaviour WITHOUT fetching labels, buying postage,
// touching the network, or reading the database. Fixtures must use fake
// names only.
export async function renderBatchHeaderPdfForTest(input: {
  entry: PrintQueueEntry;
  totalOrders: number;
  recipients: BatchRecipient[];
  isTest?: boolean;
  threshold?: number;
  packageDims?: string | null;
}): Promise<Uint8Array> {
  const { PDFDocument, rgb, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontReg = await doc.embedFont(StandardFonts.Helvetica);

  const sortedRecipients = sortBatchRecipients(input.recipients);
  const headerPage = doc.addPage([288, 432]);
  const { manifestNeeded } = drawHeader(
    headerPage,
    input.entry,
    input.totalOrders,
    font,
    fontReg,
    rgb,
    input.isTest ?? false,
    sortedRecipients,
    input.threshold ?? BATCH_NAMES_HEADER_THRESHOLD,
    input.packageDims ?? null
  );

  if (manifestNeeded) {
    const { comboLine, totalUnits } = buildComboSummaryLine(input.entry);
    addBatchManifestPages(
      () => doc.addPage([288, 432]),
      {
        recipients: sortedRecipients,
        totalOrders: input.totalOrders,
        totalUnits,
        comboLine,
        isTest: input.isTest ?? false,
      },
      font,
      fontReg,
      rgb
    );
  }

  return doc.save();
}
