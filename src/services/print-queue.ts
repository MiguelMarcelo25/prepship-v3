import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import { printQueue, type PrintQueueEntry } from '../db/schema/print-queue';
import { createLabelV2, type CreateLabelInputDto } from './labels';

export type AddToQueueInput = {
  clientId: number;
  orderId: string;
  orderNumber?: string | null;
  labelUrl: string;
  skuGroupId: string;
  primarySku?: string | null;
  itemDescription?: string | null;
  orderQty?: number;
  multiSkuData?: { sku: string; qty: number }[] | null;
};

export type MergeJob = {
  jobId: string;
  status: 'pending' | 'running' | 'done' | 'error';
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
  labelUrl?: string | null;
  label?: Omit<CreateLabelInputDto, 'orderId' | 'orderNumber'> & {
    orderId?: number;
    orderNumber?: string;
  };
  skuGroupId: string;
  primarySku?: string | null;
  itemDescription?: string | null;
  orderQty?: number;
  multiSkuData?: { sku: string; qty: number }[] | null;
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

const mergeJobs = new Map<string, MergeJob>();
const queueSendJobs = new Map<string, QueueSendJob>();
const QUEUE_SEND_ORDER_TIMEOUT_MS = 30_000;

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

function timeoutAfter(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

async function processQueueSendOrder(
  order: QueueSendOrderInput
): Promise<QueueSendJobResult> {
  let labelUrl = order.labelUrl ?? null;
  let trackingNumber: string | null = null;

  if (!labelUrl) {
    if (!order.label) throw new Error('Missing label payload');
    try {
      const created = await createLabelV2({
        ...order.label,
        orderId: order.orderId,
        orderNumber: order.orderNumber ?? order.label.orderNumber,
      });
      labelUrl = created.labelUrl;
      trackingNumber = created.trackingNumber;
    } catch (err) {
      const existingLabelUrl = getExistingLabelUrl(err);
      if (!existingLabelUrl) throw err;
      labelUrl = existingLabelUrl;
    }
  }

  if (!labelUrl) throw new Error('Label was created without a queueable URL');

  const { entry, alreadyQueued } = await addToQueue({
    clientId: order.clientId,
    orderId: String(order.orderId),
    orderNumber: order.orderNumber ?? null,
    labelUrl,
    skuGroupId: order.skuGroupId,
    primarySku: order.primarySku ?? null,
    itemDescription: order.itemDescription ?? null,
    orderQty: order.orderQty ?? 1,
    multiSkuData: order.multiSkuData ?? null,
  });

  return {
    orderId: order.orderId,
    success: true,
    queueEntryId: entry.id,
    alreadyQueued,
    labelUrl,
    trackingNumber,
  };
}

// ─── CRUD ─────────────────────────────────────────────────────────────

export async function listQueue(clientId?: number, includePrinted = false) {
  const conds = [];
  if (clientId !== undefined) conds.push(eq(printQueue.clientId, clientId));
  if (!includePrinted) conds.push(eq(printQueue.status, 'queued'));
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
      labelUrl: input.labelUrl,
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
        labelUrl: input.labelUrl,
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

export function startQueueSendJob(input: {
  orders: QueueSendOrderInput[];
  concurrency?: number;
}): { jobId: string; total: number } {
  if (!input.orders.length) throw new Error('orders must be non-empty');

  cleanOldJobs();
  const jobId = randomUUID();
  const firstClientId = input.orders.find((order) => Number.isFinite(order.clientId))?.clientId ?? null;
  const job: QueueSendJob = {
    jobId,
    status: 'pending',
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

  void runQueueSendJob(jobId, input.orders, input.concurrency);
  return { jobId, total: input.orders.length };
}

export function getQueueSendJobStatus(jobId: string): QueueSendJob | null {
  cleanOldJobs();
  return queueSendJobs.get(jobId) ?? null;
}

async function runQueueSendJob(
  jobId: string,
  orders: QueueSendOrderInput[],
  requestedConcurrency = 5
) {
  const job = queueSendJobs.get(jobId);
  if (!job) return;

  const concurrency = Math.max(1, Math.min(8, Math.floor(requestedConcurrency || 5)));
  job.status = 'running';
  updateQueueSendProgress(job);

  try {
    await withConcurrency(
      orders,
      async (order) => {
        try {
          const result = await Promise.race([
            processQueueSendOrder(order),
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
  } catch (err) {
    job.status = 'error';
    job.errorMessage = err instanceof Error ? err.message : 'Queue send failed';
    job.message = job.errorMessage;
    job.updatedAt = Date.now();
  }
}

export async function removeFromQueue(entryId: string, clientId?: number) {
  const where = clientId !== undefined
    ? and(eq(printQueue.id, entryId), eq(printQueue.clientId, clientId))
    : eq(printQueue.id, entryId);
  const [row] = await db.delete(printQueue).where(where).returning();
  if (!row) throw new Error(`Queue entry not found: ${entryId}`);
  return row;
}

export async function clearQueue(clientId?: number) {
  const conds = [eq(printQueue.status, 'queued')];
  if (clientId !== undefined) conds.push(eq(printQueue.clientId, clientId));
  const rows = await db
    .delete(printQueue)
    .where(and(...conds))
    .returning({ id: printQueue.id });
  return rows.length;
}

/**
 * Remove all queue entries for a given order. Called automatically by
 * markOrderShipped (services/labels.ts) when an order moves to
 * 'shipped' or 'cancelled' so the queue doesn't accumulate orphaned
 * entries pointing at orders that no longer need printing.
 *
 * Fire-and-forget safe: failures here must not roll back the
 * order-status update or the label creation. The caller wraps this
 * in a try/catch so any DB hiccup just logs and moves on.
 *
 * orderId is stringified because print_queue_orders.orderId is text
 * (mirror of how addToQueue stores it via String(order.orderId)).
 */
export async function removeQueueEntriesForOrder(orderId: number): Promise<number> {
  const rows = await db
    .delete(printQueue)
    .where(eq(printQueue.orderId, String(orderId)))
    .returning({ id: printQueue.id });
  return rows.length;
}

// ─── PDF MERGE ────────────────────────────────────────────────────────

export async function startPrintJob(input: {
  clientId?: number;
  queueEntryIds: string[];
  mergeHeaders?: boolean;
  requestOrigin?: string;
}): Promise<{ jobId: string; total: number }> {
  if (!input.queueEntryIds.length)
    throw new Error('queueEntryIds must be non-empty');

  const conds = [inArray(printQueue.id, input.queueEntryIds)];
  if (input.clientId !== undefined) {
    conds.push(eq(printQueue.clientId, input.clientId));
  }
  const entries = await db.select().from(printQueue).where(and(...conds));
  if (entries.length !== input.queueEntryIds.length) {
    throw new Error('One or more queue entries not found or unauthorized');
  }

  cleanOldJobs();
  const jobId = randomUUID();
  const job: MergeJob = {
    jobId,
    status: 'pending',
    progress: 0,
    total: entries.length,
    current: 0,
    message: `Starting merge of ${entries.length} label${entries.length === 1 ? '' : 's'}…`,
    createdAt: Date.now(),
    labelErrors: [],
  };
  mergeJobs.set(jobId, job);

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
      job.message = `Merging label ${i + 1} of ${sorted.length}…`;

      let pdfBytes: Uint8Array | null = null;
      const labelFetchUrl = resolveLabelFetchUrl(e.labelUrl, requestOrigin);
      const isMockLabel = isMockLabelUrl(e.labelUrl) || isMockLabelUrl(labelFetchUrl);
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
    job.message = 'Finalizing PDF…';
    const bytes = await merged.save();
    job.mergedPdfBase64 = Buffer.from(bytes).toString('base64');

    const now = new Date();
    const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    job.fileName = `batch_print_${ts}.pdf`;

    if (successfulEntryIds.length > 0) {
      await db
        .update(printQueue)
        .set({ status: 'printed', lastPrintedAt: now, printCount: 1 })
        .where(inArray(printQueue.id, successfulEntryIds));
    }

    const failed = failedEntryIds.size;
    const success = successfulEntryIds.length;
    job.status = 'done';
    job.progress = 100;
    job.current = success;
    job.message =
      failed > 0
        ? `Done — ${success} merged (${failed} failed — re-create those labels and re-queue).`
        : `Done — ${success} label${success === 1 ? '' : 's'} merged.`;
  } catch (err) {
    job.status = 'error';
    job.errorMessage = (err as Error).message;
    job.message = `Error: ${job.errorMessage}`;
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

function resolveLabelFetchUrl(labelUrl: string, requestOrigin?: string): string {
  const trimmed = labelUrl.trim();
  try {
    return new URL(trimmed).toString();
  } catch {
    const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    return new URL(path, resolveApiOrigin(requestOrigin)).toString();
  }
}

function isMockLabelUrl(labelUrl: string): boolean {
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

  let y = height - 60;
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
    // 2026-05-14: subtle bump on SKU title (24 → 28) with a touch
    // more breathing room above and below. First attempt used 34
    // which overshot — the boss wants the SKU more prominent than
    // the description but not dominating the slip. Hierarchy goes
    // SKU (28) > QTY (22) > description (15).
    y -= 4;
    y = drawWrapped(sku, y, 28, font, rgb(0.1, 0.1, 0.1), 5);
    y -= 12;
    if (entry.itemDescription) {
      y = drawWrapped(entry.itemDescription, y, 15, fontReg, rgb(0.35, 0.35, 0.35), 4);
      y -= 8;
    }
    y = drawWrapped(`QTY: ${entry.orderQty} per order`, y, 22, font, rgb(0.1, 0.1, 0.1));
  }

  // 2026-05-14: divider moved from 32% to 42% from the bottom of the
  // page (i.e. raised ~43 px up) so the empty gap between the QTY
  // line and the divider closes up. The previous 32% left ~130 px
  // of dead white space below QTY on a 432-tall slip — the boss's
  // reference image has the divider sitting around 60 % down from
  // the top, which corresponds to ~40 % up from the bottom.
  const dividerY = height * 0.42;
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
