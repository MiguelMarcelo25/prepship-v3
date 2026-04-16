import { randomUUID } from "node:crypto";
import type { QueueRepository } from "./queue-repository.ts";
import type { AddToQueueInput, PrintQueueEntry, PrintQueueSummary } from "../domain/queue.ts";
import { InputValidationError } from "../../../../../../packages/contracts/src/common/input-validation.ts";

// ─── In-memory PDF merge job tracker ─────────────────────────────────────────
export interface MergeJob {
  jobId: string;
  status: 'pending' | 'running' | 'done' | 'error';
  progress: number;  // 0–100
  total: number;
  current: number;
  message: string;
  mergedPdfBase64?: string;
  fileName?: string;
  errorMessage?: string;
  createdAt: number;
}

const mergeJobs = new Map<string, MergeJob>();

// Clean up jobs older than 30 minutes
function cleanOldJobs(): void {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of mergeJobs.entries()) {
    if (job.createdAt < cutoff) mergeJobs.delete(id);
  }
}

export class QueueServices {
  private readonly repo: QueueRepository;

  constructor(repo: QueueRepository) {
    this.repo = repo;
  }

  // ── CRITICAL #1: GET /api/queue — hydrate from DB ────────────────────────
  async getQueueForClient(clientId: number, includePrinted = false): Promise<{ ok: true; queuedOrders: object[]; totalOrders: number; totalQty: number }> {
    if (!clientId || !Number.isFinite(clientId)) {
      throw new InputValidationError("client_id is required");
    }

    // Return queued + optionally printed (for history view)
    const allEntries = includePrinted
      ? await this.repo.getByClient(clientId)
      : await this.repo.getByClient(clientId, 'queued');
    const entries = allEntries;
    const totalQty = entries.reduce((sum, e) => sum + (e.orderQty ?? 1), 0);

    return {
      ok: true,
      queuedOrders: entries.map(e => ({
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
        last_printed_at: e.lastPrintedAt ? new Date(e.lastPrintedAt * 1000).toISOString() : null,
        queued_at: new Date(e.queuedAt * 1000).toISOString(),
      })),
      totalOrders: entries.length,
      totalQty,
    };
  }

  // ── CRITICAL #2: Atomic add-to-queue ─────────────────────────────────────
  async addToQueue(body: unknown): Promise<{ ok: true; queue_entry_id: string; queued_at: string; already_queued: boolean }> {
    const raw = body as Record<string, unknown>;

    if (!raw.order_id || typeof raw.order_id !== 'string') {
      throw new InputValidationError("order_id is required");
    }
    if (!raw.client_id || !Number.isFinite(Number(raw.client_id))) {
      throw new InputValidationError("client_id is required");
    }
    if (!raw.label_url || typeof raw.label_url !== 'string') {
      throw new InputValidationError("label_url is required");
    }
    if (!raw.sku_group_id || typeof raw.sku_group_id !== 'string') {
      throw new InputValidationError("sku_group_id is required");
    }

    const clientId = Number(raw.client_id);
    const orderId = raw.order_id;

    // Check if already queued (for already_queued flag in response)
    const existing = await this.repo.findByOrderId(orderId, clientId);
    const alreadyQueued = existing !== null && existing.status === 'queued';

    // Always upsert — this ensures label_url is updated if re-queued with fresh URL
    // (e.g. after void + re-create). UPSERT in DB handles the ON CONFLICT logic.
    const input: AddToQueueInput = {
      clientId,
      orderId,
      orderNumber: typeof raw.order_number === 'string' ? raw.order_number : undefined,
      labelUrl: raw.label_url,
      skuGroupId: raw.sku_group_id,
      primarySku: typeof raw.primary_sku === 'string' ? raw.primary_sku : undefined,
      itemDescription: typeof raw.item_description === 'string' ? raw.item_description : undefined,
      orderQty: typeof raw.order_qty === 'number' ? raw.order_qty : 1,
      multiSkuData: Array.isArray(raw.multi_sku_data) ? raw.multi_sku_data as never : undefined,
    };

    const entry = await this.repo.add(input);

    return {
      ok: true,
      queue_entry_id: entry.id,
      queued_at: new Date(entry.queuedAt * 1000).toISOString(),
      already_queued: alreadyQueued,
    };
  }

  async removeFromQueue(entryId: string, clientId: number): Promise<{ ok: true; removed_entry: string }> {
    const entry = await this.repo.findById(entryId);
    if (!entry) throw new Error(`Queue entry not found: ${entryId}`);
    if (entry.clientId !== clientId) throw new Error("Unauthorized");
    await this.repo.remove(entryId);
    return { ok: true, removed_entry: entryId };
  }

  async clearQueue(clientId: number): Promise<{ ok: true; cleared_count: number }> {
    if (!clientId || !Number.isFinite(clientId)) {
      throw new InputValidationError("client_id is required");
    }
    const count = await this.repo.clearByClient(clientId);
    return { ok: true, cleared_count: count };
  }

  // ── CRITICAL #5: Async PDF merge — start job, return jobId ───────────────
  async startPrintJob(body: unknown): Promise<{ ok: true; job_id: string; total: number }> {
    const raw = body as Record<string, unknown>;
    if (!raw.client_id) throw new InputValidationError("client_id is required");
    if (!Array.isArray(raw.queue_entry_ids) || raw.queue_entry_ids.length === 0) {
      throw new InputValidationError("queue_entry_ids must be a non-empty array");
    }

    const clientId = Number(raw.client_id);
    const entryIds = raw.queue_entry_ids as string[];
    const mergeHeaders = raw.merge_headers !== false;

    // Fetch all entries to validate
    const entries: PrintQueueEntry[] = [];
    for (const id of entryIds) {
      const entry = await this.repo.findById(id);
      if (!entry) throw new Error(`Queue entry not found: ${id}`);
      if (entry.clientId !== clientId) throw new Error(`Unauthorized entry: ${id}`);
      entries.push(entry);
    }

    cleanOldJobs();

    const jobId = randomUUID();
    const job: MergeJob = {
      jobId,
      status: 'pending',
      progress: 0,
      total: entries.length,
      current: 0,
      message: `Starting merge of ${entries.length} label${entries.length !== 1 ? 's' : ''}…`,
      createdAt: Date.now(),
    };
    mergeJobs.set(jobId, job);

    // Run async (do not await)
    void this.runMergeJob(jobId, entries, mergeHeaders, clientId);

    return { ok: true, job_id: jobId, total: entries.length };
  }

  getMergeJobStatus(jobId: string): MergeJob | null {
    return mergeJobs.get(jobId) ?? null;
  }

  // ── Private: actual PDF merge logic ──────────────────────────────────────
  private async runMergeJob(
    jobId: string,
    entries: PrintQueueEntry[],
    mergeHeaders: boolean,
    clientId: number,
  ): Promise<void> {
    const job = mergeJobs.get(jobId)!;
    job.status = 'running';
    job.message = 'Initializing PDF merge…';

    try {
      // Dynamic import of pdf-lib to avoid top-level import issues
      const { PDFDocument, rgb, StandardFonts } = await import("pdf-lib");

      const mergedPdf = await PDFDocument.create();
      const font = await mergedPdf.embedFont(StandardFonts.HelveticaBold);
      const fontRegular = await mergedPdf.embedFont(StandardFonts.Helvetica);

      // Sort entries by skuGroupId — all orders in the same group become consecutive.
      // Header page emits ONCE per group, not once per label.
      const sortedEntries = [...entries].sort((a, b) =>
        (a.skuGroupId ?? '').localeCompare(b.skuGroupId ?? '')
      );

      // Pre-compute group sizes so header shows "1 of N ORDERS"
      const groupSizes = new Map<string, number>();
      for (const e of sortedEntries) {
        const g = e.skuGroupId ?? '__ungrouped__';
        groupSizes.set(g, (groupSizes.get(g) ?? 0) + 1);
      }

      let lastGroupId: string | null = null;

      for (let i = 0; i < sortedEntries.length; i++) {
        const entry = sortedEntries[i]!;
        job.current = i;
        job.progress = Math.round((i / sortedEntries.length) * 90);
        job.message = `Merging label ${i + 1} of ${sortedEntries.length}…`;

        // ── CRITICAL #4: ShipStation URL 404/410 error handling ────────────
        // No caching — fetch directly, handle 404/410 gracefully
        let labelPdfBytes: Uint8Array | null = null;
        let labelError: string | null = null;

        try {
          // Resolve relative URLs (e.g. /api/labels/mock/:id) against local API
          const labelFetchUrl = entry.labelUrl.startsWith('/')
            ? `http://127.0.0.1:${process.env.API_PORT ?? '4010'}${entry.labelUrl}`
            : entry.labelUrl;
          const response = await fetch(labelFetchUrl, {
            headers: {
              'Accept': 'application/pdf',
              'x-app-token': process.env.SESSION_TOKEN ?? '',
            },
            signal: AbortSignal.timeout(15_000),
          });

          if (response.status === 404 || response.status === 410) {
            labelError = `Label expired for order ${entry.orderNumber ?? entry.orderId} (HTTP ${response.status}). Re-create label and re-queue.`;
          } else if (!response.ok) {
            labelError = `Failed to fetch label for order ${entry.orderNumber ?? entry.orderId} (HTTP ${response.status}).`;
          } else {
            const buffer = await response.arrayBuffer();
            labelPdfBytes = new Uint8Array(buffer);
          }
        } catch (fetchErr) {
          const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
          labelError = `Network error fetching label for order ${entry.orderNumber ?? entry.orderId}: ${msg}`;
        }

        if (labelError) {
          // Track the error but do NOT add an error page to the PDF.
          // Error-only PDFs produced by pdf-lib are missing %%EOF and Chrome rejects them.
          console.warn(`[queue] ${labelError}`);
          (job as any).labelErrors = [...((job as any).labelErrors ?? []), labelError];
          continue;
        }

        // Add header page ONCE at the start of each new SKU group (not before every label).
        // Structure: [Group Header] [Label 1] [Label 2] ... [Group Header] [Label 1] ...
        const groupId = entry.skuGroupId ?? '__ungrouped__';
        if (mergeHeaders && groupId !== lastGroupId) {
          const groupSize = groupSizes.get(groupId) ?? 1;
          const headerPage = mergedPdf.addPage([288, 432]); // 4"×6" at 72dpi
          this.drawHeaderPage(headerPage, entry, 1, groupSize, font, fontRegular, rgb);
          lastGroupId = groupId;
        }

        // Embed the label PDF
        try {
          const labelDoc = await PDFDocument.load(labelPdfBytes!);
          const pageIndices = labelDoc.getPageIndices();
          const copiedPages = await mergedPdf.copyPages(labelDoc, pageIndices);
          for (const page of copiedPages) {
            mergedPdf.addPage(page);
          }
        } catch (pdfErr) {
          const errMsg = pdfErr instanceof Error ? pdfErr.message : String(pdfErr);
          (job as any).labelErrors = [...((job as any).labelErrors ?? []), `PDF parse error for ${entry.orderNumber ?? entry.orderId}: ${errMsg}`];
        }
      }

      job.progress = 95;
      job.message = 'Finalizing PDF…';

      // If no pages were added (all labels failed), fail with a clear error instead of
      // producing a broken PDF (pdf-lib omits %%EOF on empty docs, Chrome rejects it).
      const pageCount = mergedPdf.getPageCount();
      if (pageCount === 0) {
        const errors: string[] = (job as any).labelErrors ?? [];
        throw new Error(
          `All labels failed to load — no PDF produced.\n${errors.slice(0, 3).join('\n')}${errors.length > 3 ? `\n…and ${errors.length - 3} more` : ''}`
        );
      }

      const pdfBytes = await mergedPdf.save();
      const pdfBuf = Buffer.from(pdfBytes);
      const base64 = pdfBuf.toString('base64');

      const now = new Date();
      const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
      const fileName = `batch_print_${ts}.pdf`;

      // Mark entries as printed
      const printedAt = Math.floor(Date.now() / 1000);
      await this.repo.markPrinted(entries.map(e => e.id), printedAt);

      const failedCount = ((job as any).labelErrors ?? []).length;
      const successCount = entries.length - failedCount;
      job.status = 'done';
      job.progress = 100;
      job.current = entries.length;
      job.message = failedCount > 0
        ? `Done — ${successCount} label${successCount !== 1 ? 's' : ''} merged (${failedCount} failed — re-create and re-queue those orders).`
        : `Done — ${successCount} label${successCount !== 1 ? 's' : ''} merged.`;
      job.mergedPdfBase64 = base64;
      job.fileName = fileName;

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      job.status = 'error';
      job.errorMessage = message;
      job.message = `Error: ${message}`;
    }
  }

  private drawHeaderPage(
    page: ReturnType<import("pdf-lib").PDFDocument['addPage']>,
    entry: PrintQueueEntry,
    orderIndex: number,
    totalOrders: number,
    font: import("pdf-lib").PDFFont,
    fontRegular: import("pdf-lib").PDFFont,
    rgb: typeof import("pdf-lib").rgb,
  ): void {
    const { width, height } = page.getSize();
    const cx = width / 2;
    const pad = 16;

    // Helper: draw wrapped text, returns new y after drawing
    const drawWrapped = (
      text: string, startY: number, fontSize: number, f: typeof font, color: ReturnType<typeof rgb>, lineGap = 6,
    ): number => {
      const words = text.split(' ');
      let line = '';
      let y = startY;
      for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        if (f.widthOfTextAtSize(test, fontSize) > width - pad * 2 && line) {
          page.drawText(line, { x: cx - f.widthOfTextAtSize(line, fontSize) / 2, y, size: fontSize, font: f, color });
          y -= fontSize + lineGap;
          line = word;
        } else {
          line = test;
        }
      }
      if (line) {
        page.drawText(line, { x: cx - f.widthOfTextAtSize(line, fontSize) / 2, y, size: fontSize, font: f, color });
        y -= fontSize + lineGap;
      }
      return y;
    };

    // White background
    page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(1, 1, 1) });

    // Header band
    page.drawRectangle({ x: 0, y: height - 40, width, height: 40, color: rgb(0.1, 0.1, 0.1) });
    page.drawText('BATCH HEADER', {
      x: cx - font.widthOfTextAtSize('BATCH HEADER', 13) / 2,
      y: height - 27, size: 13, font, color: rgb(1, 1, 1),
    });

    // ── Top section: SKU info (upper 3/4 of page) ──────────────────────────
    // Top section occupies y = height-48 down to y = height*0.25+20
    let y = height - 60;

    if (entry.multiSkuData && entry.multiSkuData.length > 0) {
      y = drawWrapped('MULTI-SKU', y, 26, font, rgb(0.1, 0.1, 0.1));
      y -= 8;
      for (const item of entry.multiSkuData) {
        y = drawWrapped(`${item.sku}  x${item.qty}`, y, 15, fontRegular, rgb(0.3, 0.3, 0.3));
      }
      y -= 6;
      const totalQty = entry.multiSkuData.reduce((s, i) => s + i.qty, 0);
      y = drawWrapped(`QTY: ${totalQty} per order`, y, 22, font, rgb(0.1, 0.1, 0.1));
    } else {
      const sku = entry.primarySku ?? 'UNKNOWN SKU';
      y = drawWrapped(sku, y, 24, font, rgb(0.1, 0.1, 0.1), 5);
      y -= 10;
      if (entry.itemDescription) {
        y = drawWrapped(entry.itemDescription, y, 15, fontRegular, rgb(0.35, 0.35, 0.35), 4);
        y -= 8;
      }
      y = drawWrapped(`QTY: ${entry.orderQty} per order`, y, 22, font, rgb(0.1, 0.1, 0.1));
    }

    // ── Divider between top info and order count block ─────────────────────
    const dividerY = height * 0.32;
    page.drawLine({
      start: { x: pad, y: dividerY + 2 }, end: { x: width - pad, y: dividerY + 2 },
      thickness: 1, color: rgb(0.85, 0.85, 0.85),
    });

    // ── Bottom 1/4: large order count ─────────────────────────────────────
    // Big number takes up ~1/4 of page height
    const countFontSize = Math.min(height * 0.22, 90);
    const labelSize = 15; // ~1/4 of 432pt page ≈ 95pt
    const countStr = String(totalOrders);
    const countW = font.widthOfTextAtSize(countStr, countFontSize);
    // Center the count block vertically in the bottom section
    const bottomSectionHeight = dividerY; // from 0 to dividerY
    const countBlockHeight = countFontSize + labelSize + 10;
    const countY = (bottomSectionHeight + countBlockHeight) / 2;
    page.drawText(countStr, {
      x: cx - countW / 2,
      y: countY - countFontSize,
      size: countFontSize, font, color: rgb(0.05, 0.05, 0.05),
    });

    const labelStr = `ORDER${totalOrders !== 1 ? 'S' : ''}`;
    page.drawText(labelStr, {
      x: cx - font.widthOfTextAtSize(labelStr, labelSize) / 2,
      y: countY - countFontSize - labelSize - 4,
      size: labelSize, font, color: rgb(0.4, 0.4, 0.4),
    });
  }
}
