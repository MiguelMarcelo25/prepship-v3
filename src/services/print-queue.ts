import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import { printQueue, type PrintQueueEntry } from '../db/schema/print-queue';

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

const mergeJobs = new Map<string, MergeJob>();

function cleanOldJobs() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of mergeJobs.entries()) {
    if (job.createdAt < cutoff) mergeJobs.delete(id);
  }
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

// ─── PDF MERGE ────────────────────────────────────────────────────────

export async function startPrintJob(input: {
  clientId?: number;
  queueEntryIds: string[];
  mergeHeaders?: boolean;
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

  void runMergeJob(jobId, entries, input.mergeHeaders !== false);
  return { jobId, total: entries.length };
}

export function getMergeJobStatus(jobId: string): MergeJob | null {
  return mergeJobs.get(jobId) ?? null;
}

async function runMergeJob(
  jobId: string,
  entries: PrintQueueEntry[],
  mergeHeaders: boolean
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

    for (let i = 0; i < sorted.length; i += 1) {
      const e = sorted[i]!;
      job.current = i;
      job.progress = Math.round((i / sorted.length) * 90);
      job.message = `Merging label ${i + 1} of ${sorted.length}…`;

      let pdfBytes: Uint8Array | null = null;
      try {
        const res = await fetch(e.labelUrl, {
          headers: { Accept: 'application/pdf' },
          signal: AbortSignal.timeout(15_000),
        });
        if (res.status === 404 || res.status === 410) {
          job.labelErrors!.push(
            `Label expired for order ${e.orderNumber ?? e.orderId} (HTTP ${res.status}).`
          );
          continue;
        }
        if (!res.ok) {
          job.labelErrors!.push(
            `Failed to fetch label for order ${e.orderNumber ?? e.orderId} (HTTP ${res.status}).`
          );
          continue;
        }
        pdfBytes = new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        job.labelErrors!.push(
          `Network error for order ${e.orderNumber ?? e.orderId}: ${(err as Error).message}`
        );
        continue;
      }

      const groupId = e.skuGroupId ?? '__ungrouped__';
      if (mergeHeaders && groupId !== lastGroup) {
        const headerPage = merged.addPage([288, 432]);
        drawHeader(headerPage, e, groupSizes.get(groupId) ?? 1, font, fontReg, rgb);
        lastGroup = groupId;
      }

      try {
        const labelDoc = await PDFDocument.load(pdfBytes!);
        const indices = labelDoc.getPageIndices();
        const pages = await merged.copyPages(labelDoc, indices);
        for (const p of pages) merged.addPage(p);
      } catch (err) {
        job.labelErrors!.push(
          `PDF parse error for order ${e.orderNumber ?? e.orderId}: ${(err as Error).message}`
        );
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

    await db
      .update(printQueue)
      .set({ status: 'printed', lastPrintedAt: now, printCount: 1 })
      .where(inArray(printQueue.id, entries.map((e) => e.id)));

    const failed = job.labelErrors!.length;
    const success = entries.length - failed;
    job.status = 'done';
    job.progress = 100;
    job.current = entries.length;
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

function drawHeader(
  page: ReturnType<import('pdf-lib').PDFDocument['addPage']>,
  entry: PrintQueueEntry,
  totalOrders: number,
  font: import('pdf-lib').PDFFont,
  fontReg: import('pdf-lib').PDFFont,
  rgb: typeof import('pdf-lib').rgb
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

  let y = height - 60;
  const drawWrapped = (
    text: string,
    startY: number,
    fontSize: number,
    f: typeof font,
    color: ReturnType<typeof rgb>,
    lineGap = 6
  ) => {
    const words = text.split(' ');
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
    y = drawWrapped(sku, y, 24, font, rgb(0.1, 0.1, 0.1), 5);
    y -= 10;
    if (entry.itemDescription) {
      y = drawWrapped(entry.itemDescription, y, 15, fontReg, rgb(0.35, 0.35, 0.35), 4);
      y -= 8;
    }
    y = drawWrapped(`QTY: ${entry.orderQty} per order`, y, 22, font, rgb(0.1, 0.1, 0.1));
  }

  const dividerY = height * 0.32;
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
