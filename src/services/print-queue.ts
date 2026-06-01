import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client';
import { clients } from '../db/schema/clients';
import { printQueue, type PrintQueueEntry } from '../db/schema/print-queue';
import { settings } from '../db/schema/settings';
import { shipments } from '../db/schema/shipments';
import { extractShipstationLabelUrl } from '../lib/shipstation/labels';
import {
  enqueueMissingShipmentConfirmations,
  processFulfillmentOutboxOnce,
} from './fulfillment/outbox';
import { createLabelV2, type CreateLabelInputDto } from './labels';

export type AddToQueueInput = {
  clientId: number;
  orderId: string;
  orderNumber?: string | null;
  labelUrl: unknown;
  skuGroupId: string;
  primarySku?: string | null;
  itemDescription?: string | null;
  orderQty?: number;
  multiSkuData?: { sku: string; qty: number }[] | null;
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
  multiSkuData?: { sku: string; qty: number }[] | null;
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
    const result = await enqueueMissingShipmentConfirmations({
      orderId: parsedOrderId,
      limit: 5,
      maxAgeHours: 24 * 14,
    });
    if (result.enqueued > 0) {
      void processFulfillmentOutboxOnce({ orderId: parsedOrderId, limit: 5 }).catch((err) => {
        console.warn(
          `[print-queue] repaired confirmation processing failed orderId=${parsedOrderId}:`,
          err instanceof Error ? err.message : err,
        );
      });
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
  await repairMissingConfirmationForQueuedLabel(order.orderId);

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
    for (const e of sorted) {
      const g = e.skuGroupId ?? '__ungrouped__';
      groupSizes.set(g, (groupSizes.get(g) ?? 0) + 1);
    }
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
          const headerPage = merged.addPage([288, 432]);
          drawHeader(headerPage, e, groupSizes.get(groupId) ?? 1, font, fontReg, rgb, isMockLabel);
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
        const indices = labelDoc.getPageIndices();
        if (indices.length === 0) {
          throw new Error('PDF contained no pages');
        }
        const pages = await merged.copyPages(labelDoc, indices);
        addGroupHeaderIfNeeded();
        for (const p of pages) merged.addPage(p);
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
  page.drawText(safePdfText(`SKU: ${entry.primarySku ?? 'Unknown SKU'}`), { x: pad, y: height - 104, size: 10, font: fontReg, color: black });
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
  isTest = false
) {
  const { width, height } = page.getSize();
  const cx = width / 2;
  const pad = 16;

  page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(1, 1, 1) });
  page.drawRectangle({
    x: 0,
    y: height - 40,
    width,
    height: 40,
    color: rgb(0.1, 0.1, 0.1),
  });
  page.drawText('BATCH HEADER', {
    x: cx - font.widthOfTextAtSize('BATCH HEADER', 13) / 2,
    y: height - 27,
    size: 13,
    font,
    color: rgb(1, 1, 1),
  });
  // Test-mode stamp: small red "TEST" on the right side of the
  // BATCH HEADER bar. Doesn't shift any other content — the bar is
  // a fixed-height strip and "TEST" sits in the otherwise-empty
  // right gutter of that strip.
  if (isTest) {
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

  // 2026-05-14: divider moved from 32% to 42% from the bottom of the
  // page (i.e. raised ~43 px up) so the empty gap between the QTY
  // line and the divider closes up. The previous 32% left ~130 px
  // of dead white space below QTY on a 432-tall slip — the boss's
  // reference image has the divider sitting around 60 % down from
  // the top, which corresponds to ~40 % up from the bottom.
  // Computed up here (before the top content) so we can vertically
  // center the SKU/description/QTY block inside the available zone.
  const dividerY = height * 0.42;

  // Wrap-aware drawer. Returns the y value AFTER the last line.
  const drawWrapped = (
    text: string,
    startY: number,
    fontSize: number,
    f: typeof font,
    color: ReturnType<typeof rgb>,
    lineGap = 6
  ) => {
    const words = safePdfText(text).split(' ').filter(Boolean);
    let line = '';
    let cy = startY;
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (f.widthOfTextAtSize(test, fontSize) > width - pad * 2 && line) {
        page.drawText(line, {
          x: cx - f.widthOfTextAtSize(line, fontSize) / 2,
          y: cy,
          size: fontSize,
          font: f,
          color,
        });
        cy -= fontSize + lineGap;
        line = word;
      } else {
        line = test;
      }
    }
    if (line) {
      page.drawText(line, {
        x: cx - f.widthOfTextAtSize(line, fontSize) / 2,
        y: cy,
        size: fontSize,
        font: f,
        color,
      });
      cy -= fontSize + lineGap;
    }
    return cy;
  };

  // Measurement-only twin of drawWrapped — counts how many lines the
  // given text would consume at the given size+font without rendering
  // anything. Used so we can compute total content height up-front
  // and vertically center the block.
  const countWrappedLines = (
    text: string,
    fontSize: number,
    f: typeof font
  ): number => {
    const words = safePdfText(text).split(' ').filter(Boolean);
    if (words.length === 0) return 0;
    let line = '';
    let lines = 0;
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (f.widthOfTextAtSize(test, fontSize) > width - pad * 2 && line) {
        lines += 1;
        line = word;
      } else {
        line = test;
      }
    }
    if (line) lines += 1;
    return lines;
  };

  // Compute the total height of the content block (SKU + optional
  // description + QTY, or MULTI-SKU + items + QTY). Mirrors the
  // sizes/gaps used in the draw block below, so changes to one must
  // be mirrored in the other.
  let contentHeight: number;
  if (entry.multiSkuData && entry.multiSkuData.length > 0) {
    contentHeight =
      26 + 6 + // MULTI-SKU title
      8 +      // gap
      entry.multiSkuData.length * (15 + 6) + // each item line
      6 +      // gap
      22 + 6;  // QTY line
  } else {
    const skuText = entry.primarySku ?? 'UNKNOWN SKU';
    const skuLines = countWrappedLines(skuText, 28, font);
    const descLines = entry.itemDescription
      ? countWrappedLines(entry.itemDescription, 15, fontReg)
      : 0;
    contentHeight =
      skuLines * (28 + 5) + // SKU lines
      12 +                  // gap
      (descLines > 0 ? descLines * (15 + 4) + 8 : 0) + // description lines + gap
      22 + 6;               // QTY line
  }

  // Top section spans from below the BATCH HEADER bar (height-40)
  // down to the divider top (dividerY+2). Boss wants the content
  // block to sit LOWER in that zone — closer to the divider — not
  // dead-centered. We compute the naturally-centered padding then
  // add a 50 pt nudge downward (= more padding above). A cap keeps
  // the QTY line from kissing the divider on long descriptions:
  // the block can shift down freely until only 8 pt of gap remains
  // above the divider, then it stops.
  const topSectionTop = height - 40;
  const topSectionBottom = dividerY + 2;
  const topSectionHeight = topSectionTop - topSectionBottom;
  const naturalPadding = Math.max(10, (topSectionHeight - contentHeight) / 2);
  const maxPadding = Math.max(10, topSectionHeight - contentHeight - 8);
  const verticalPadding = Math.min(maxPadding, naturalPadding + 50);
  let y = topSectionTop - verticalPadding;

  if (entry.multiSkuData && entry.multiSkuData.length > 0) {
    y = drawWrapped('MULTI-SKU', y, 26, font, rgb(0.1, 0.1, 0.1));
    y -= 8;
    for (const item of entry.multiSkuData) {
      y = drawWrapped(`${item.sku}  x${item.qty}`, y, 15, fontReg, rgb(0.3, 0.3, 0.3));
    }
    y -= 6;
    const totalQty = entry.multiSkuData.reduce((s, i) => s + i.qty, 0);
    y = drawWrapped(`QTY: ${totalQty} per order`, y, 22, font, rgb(0.1, 0.1, 0.1));
  } else {
    const sku = entry.primarySku ?? 'UNKNOWN SKU';
    // SKU 28 / description 15 / QTY 22 — hierarchy goes SKU > QTY > description.
    y = drawWrapped(sku, y, 28, font, rgb(0.1, 0.1, 0.1), 5);
    y -= 12;
    if (entry.itemDescription) {
      y = drawWrapped(entry.itemDescription, y, 15, fontReg, rgb(0.35, 0.35, 0.35), 4);
      y -= 8;
    }
    y = drawWrapped(`QTY: ${entry.orderQty} per order`, y, 22, font, rgb(0.1, 0.1, 0.1));
  }

  page.drawLine({
    start: { x: pad, y: dividerY + 2 },
    end: { x: width - pad, y: dividerY + 2 },
    thickness: 1,
    color: rgb(0.85, 0.85, 0.85),
  });

  const countFontSize = Math.min(height * 0.22, 90);
  const labelSize = 15;
  const countStr = String(totalOrders);
  const countW = font.widthOfTextAtSize(countStr, countFontSize);
  const bottomSectionHeight = dividerY;
  const countBlockHeight = countFontSize + labelSize + 10;
  const countY = (bottomSectionHeight + countBlockHeight) / 2;

  page.drawText(countStr, {
    x: cx - countW / 2,
    y: countY - countFontSize,
    size: countFontSize,
    font,
    color: rgb(0.05, 0.05, 0.05),
  });
  const labelStr = `ORDER${totalOrders === 1 ? '' : 'S'}`;
  page.drawText(labelStr, {
    x: cx - font.widthOfTextAtSize(labelStr, labelSize) / 2,
    y: countY - countFontSize - labelSize - 4,
    size: labelSize,
    font,
    color: rgb(0.4, 0.4, 0.4),
  });
}
