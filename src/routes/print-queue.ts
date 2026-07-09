import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  addToQueue,
  assertPrintQueueClientsVisible,
  canViewMergeJob,
  canViewQueueSendJob,
  clearQueue,
  confirmPrintedQueueEntries,
  getLatestMergeJobSnapshot,
  getLatestQueueSendJobSnapshot,
  getQueueSendJobSnapshot,
  getQueueSendJobStatus,
  isPrintQueueAlreadyFinalizedError,
  isPrintQueueAccessError,
  isPrintQueueDurableStatusError,
  isPrintQueueLabelUrlError,
  getMergeJobStatus,
  queueSendSnapshotResults,
  // PS-256: durable-aware accessor — falls back to the persisted merged-PDF side-store on an
  // in-memory miss so the view/download/signed-url routes serve the batch after a server restart.
  getMergeJobForServe,
  getMergeJobChunkForServe,
  listQueue,
  removeFromQueue,
  startQueueSendJob,
  startPrintJob,
  type MergeJob,
  type MergeJobChunk,
  type MergeJobSnapshot,
  type PrintQueueListScope,
  type QueueSendJobSnapshot,
} from '../services/print-queue';
import { deriveQueueSendSnapshotStatus } from '../services/print-queue/queue-send-status';
import { getAuthDomain, requireInternalPermission } from '../middleware/auth';
import {
  getInternalOpsClientStoreScope,
  type ClientStoreScope,
} from '../lib/client-store-scope';
import { env } from '../lib/env';
// PS-279: server-side owner of the Send-to-Queue route decision (the money-path
// direct-buy-vs-backend-job ladder). Consumed only by the INERT /route-plan route
// below, which is gated on PRINT_QUEUE_BACKEND_ORCHESTRATION (default OFF).
import { planQueueRouteForOrders } from '../services/print-queue/queue-route-orchestrator';

const app = new Hono();
const DURABLE_STATUS_TIMEOUT_MS = 1500;
const SIGNED_PDF_TTL_MS = 5 * 60 * 1000;
const SIGNED_PDF_CACHE_SECONDS = 300;

type SignedPdfTokenPayload = {
  jobId: string;
  exp: number;
  purpose: 'print_queue_pdf';
};

function base64Url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

function signPrintQueuePdfToken(jobId: string, now = Date.now()): { token: string; expiresAt: number } {
  const expiresAt = now + SIGNED_PDF_TTL_MS;
  const payload: SignedPdfTokenPayload = {
    jobId,
    exp: expiresAt,
    purpose: 'print_queue_pdf',
  };
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signature = createHmac('sha256', env.SUPABASE_JWT_SECRET)
    .update(encodedPayload)
    .digest('base64url');
  return { token: `${encodedPayload}.${signature}`, expiresAt };
}

function verifyPrintQueuePdfToken(token: string | undefined, jobId: string): {
  ok: true;
  payload: SignedPdfTokenPayload;
} | {
  ok: false;
  code: 'PDF_LINK_MISSING' | 'PDF_LINK_INVALID' | 'PDF_LINK_EXPIRED';
  status: 401 | 403 | 410;
} {
  if (!token) return { ok: false, code: 'PDF_LINK_MISSING', status: 401 };
  const [encodedPayload, signature, extra] = token.split('.');
  if (!encodedPayload || !signature || extra) {
    return { ok: false, code: 'PDF_LINK_INVALID', status: 403 };
  }

  const expected = createHmac('sha256', env.SUPABASE_JWT_SECRET)
    .update(encodedPayload)
    .digest('base64url');
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return { ok: false, code: 'PDF_LINK_INVALID', status: 403 };
  }

  let payload: SignedPdfTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, code: 'PDF_LINK_INVALID', status: 403 };
  }

  if (
    payload.purpose !== 'print_queue_pdf' ||
    payload.jobId !== jobId ||
    typeof payload.exp !== 'number'
  ) {
    return { ok: false, code: 'PDF_LINK_INVALID', status: 403 };
  }
  if (Date.now() > payload.exp) {
    return { ok: false, code: 'PDF_LINK_EXPIRED', status: 410 };
  }

  return { ok: true, payload };
}

function isUuidOnlyFilename(filename: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\.pdf)?$/i.test(filename.trim());
}

function sanitizePdfFilename(filename: string | null | undefined, fallback: string): string {
  const raw = (filename ?? '').trim() || fallback;
  const sanitized = raw
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 140);
  const candidate = sanitized || fallback;
  const withExtension = candidate.toLowerCase().endsWith('.pdf') ? candidate : `${candidate}.pdf`;
  return isUuidOnlyFilename(withExtension) ? fallback : withExtension;
}

function pdfDispositionHeader(disposition: 'inline' | 'attachment', filename: string): string {
  return `${disposition}; filename="${filename.replace(/"/g, '')}"`;
}

// PS-256: durable-aware — getMergeJobForServe returns the in-memory job by default, and on a
// miss rehydrates the bytes from the persisted merged-PDF side-store (when the flag is ON and the
// durable snapshot confirms the merge completed) so the batch survives a server restart. With the
// flag OFF this is exactly the previous in-memory-only behavior.
type MergeChunkLike = {
  chunkNumber: number;
  status: MergeJobChunk['status'];
  labelCount: number;
  fileName?: string | null;
  fileSize?: number | null;
  errorMessage?: string | null;
};

type SignedMergeChunkDto = {
  chunk_number: number;
  status: MergeJobChunk['status'];
  label_count: number;
  file_name: string;
  file_size: number | null;
  error: string | null;
  url: string | null;
  expires_at: string | null;
  disposition: 'inline' | 'attachment';
};

function hasDoneMergeChunks(job: MergeJob): boolean {
  return (job.chunks ?? []).some((chunk) => chunk.status === 'done');
}

function buildSignedMergeChunkDtos(
  c: Context,
  jobId: string,
  chunks: readonly MergeChunkLike[] | undefined,
  disposition: 'inline' | 'attachment',
): SignedMergeChunkDto[] {
  return [...(chunks ?? [])]
    .sort((a, b) => a.chunkNumber - b.chunkNumber)
    .map((chunk) => {
      let url: string | null = null;
      let expiresAt: string | null = null;
      const fileName = sanitizePdfFilename(
        chunk.fileName,
        `prepship-batch-print-${jobId}-part-${chunk.chunkNumber}.pdf`,
      );
      if (chunk.status === 'done') {
        const signed = signPrintQueuePdfToken(jobId);
        const signedUrl = new URL(c.req.url);
        signedUrl.pathname = `/print-queue/print/view/${encodeURIComponent(jobId)}/chunks/${chunk.chunkNumber}`;
        signedUrl.search = new URLSearchParams({
          token: signed.token,
          disposition,
        }).toString();
        url = signedUrl.toString();
        expiresAt = new Date(signed.expiresAt).toISOString();
      }
      return {
        chunk_number: chunk.chunkNumber,
        status: chunk.status,
        label_count: chunk.labelCount,
        file_name: fileName,
        file_size: chunk.fileSize ?? null,
        error: chunk.errorMessage ?? null,
        url,
        expires_at: expiresAt,
        disposition,
      };
    });
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function serveMergeChunkIndexHtml(
  c: Context,
  jobId: string,
  job: MergeJob,
  disposition: 'inline' | 'attachment',
): Response {
  const chunks = buildSignedMergeChunkDtos(c, jobId, job.chunks, disposition);
  const rows = chunks
    .map((chunk) => {
      const fileSize = chunk.file_size ? `${Math.ceil(chunk.file_size / 1024)} KB` : 'pending';
      const labelCount = `${chunk.label_count} label${chunk.label_count === 1 ? '' : 's'}`;
      const href = chunk.url ? escapeHtml(chunk.url) : '#';
      const linkText = `${escapeHtml(chunk.file_name)} (${labelCount}, ${fileSize})`;
      const disabled = chunk.url ? '' : ' aria-disabled="true"';
      return `<li><a href="${href}" target="_blank" rel="noopener"${disabled}>${linkText}</a></li>`;
    })
    .join('');
  const title = `PrepShip print batch ${escapeHtml(jobId)}`;
  return new Response(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 32px; color: #172033; }
      h1 { font-size: 18px; margin: 0 0 8px; }
      p { color: #5b667a; font-size: 13px; margin: 0 0 18px; }
      li { margin: 10px 0; }
      a { color: #0b84d8; font-weight: 700; text-decoration: none; }
      a:hover { text-decoration: underline; }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(job.fileName ?? 'PrepShip print batch')}</h1>
    <p>This batch is split into ${chunks.length} restart-safe PDF chunks.</p>
    <ol>${rows}</ol>
  </body>
</html>`, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': `private, max-age=${SIGNED_PDF_CACHE_SECONDS}`,
      'x-content-type-options': 'nosniff',
    },
  });
}

async function serveMergedPdf(c: Context, jobId: string, disposition: 'inline' | 'attachment') {
  const job = await getMergeJobForServe(jobId);
  if (!job || job.status !== 'done') {
    return c.json({ error: 'PDF not found or not ready' }, 404);
  }
  if (!job.mergedPdfBase64 && hasDoneMergeChunks(job)) {
    return serveMergeChunkIndexHtml(c, jobId, job, disposition);
  }
  if (!job.mergedPdfBase64) return c.json({ error: 'PDF not found or not ready' }, 404);

  const bytes = Buffer.from(job.mergedPdfBase64, 'base64');
  const fileName = sanitizePdfFilename(job.fileName, `prepship-batch-print-${jobId}.pdf`);
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': pdfDispositionHeader(disposition, fileName),
      'content-length': String(bytes.byteLength),
      'cache-control': `private, max-age=${SIGNED_PDF_CACHE_SECONDS}`,
      'x-content-type-options': 'nosniff',
    },
  });
}

app.get('/print/view/:jobId/chunks/:chunkNumber', async (c) => {
  const jobId = c.req.param('jobId');
  const chunkNumber = Number(c.req.param('chunkNumber'));
  if (!Number.isInteger(chunkNumber) || chunkNumber <= 0) {
    return c.json({ error: 'Invalid PDF chunk' }, 400);
  }
  const verification = verifyPrintQueuePdfToken(c.req.query('token'), jobId);
  if (!verification.ok) {
    return c.json({ error: verification.code, code: verification.code }, verification.status);
  }
  const disposition =
    c.req.query('disposition') === 'attachment' ? 'attachment' : 'inline';
  const result = await getMergeJobChunkForServe(jobId, chunkNumber);
  if (!result?.chunk.mergedPdfBase64) {
    return c.json({ error: 'PDF chunk not found or not ready' }, 404);
  }

  const bytes = Buffer.from(result.chunk.mergedPdfBase64, 'base64');
  const fileName = sanitizePdfFilename(
    result.chunk.fileName,
    `prepship-batch-print-${jobId}-part-${chunkNumber}.pdf`,
  );
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': pdfDispositionHeader(disposition, fileName),
      'content-length': String(bytes.byteLength),
      'cache-control': `private, max-age=${SIGNED_PDF_CACHE_SECONDS}`,
      'x-content-type-options': 'nosniff',
    },
  });
});

app.get('/print/view/:jobId', async (c) => {
  const jobId = c.req.param('jobId');
  const verification = verifyPrintQueuePdfToken(c.req.query('token'), jobId);
  if (!verification.ok) {
    return c.json({ error: verification.code, code: verification.code }, verification.status);
  }
  const disposition =
    c.req.query('disposition') === 'attachment' ? 'attachment' : 'inline';
  return await serveMergedPdf(c, jobId, disposition);
});

app.use('*', requireInternalPermission('print_queue:write'));

function printQueueScopeFromContext(c: Context): PrintQueueListScope {
  const scope: ClientStoreScope = getInternalOpsClientStoreScope({
    email: c.get('email' as never) as string | undefined,
    role: c.get('role' as never) as string | undefined,
    permissions: c.get('permissions' as never) as string[] | undefined,
    clientIds: c.get('clientIds' as never) as number[] | undefined,
    storeIds: c.get('storeIds' as never) as number[] | undefined,
  });
  return {
    scopeClientIds: scope.clientIds,
    scopeStoreIds: scope.storeIds,
    scopeRestricted: scope.isRestricted,
  };
}

type PrintQueueAuthDiagnostics = {
  action: string;
  requestedOrderIds?: number[];
  requestedClientIds?: number[];
};

function printQueueLabelUrlErrorResponse(c: Context, err: unknown) {
  if (!isPrintQueueLabelUrlError(err)) throw err;
  return c.json({ error: err.message, code: err.code }, err.status);
}

function uniquePositiveInts(values: Array<number | undefined>): number[] {
  return Array.from(
    new Set(
      values
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );
}

function redactEmailForLog(email: string | undefined): string | null {
  if (!email) return null;
  const [local = '', domain = ''] = email.split('@');
  const visible = local.slice(0, Math.min(2, local.length));
  return domain ? `${visible}***@${domain}` : `${visible}***`;
}

function printQueueAuthVarsFromContext(c: Context) {
  return {
    userId: c.get('userId' as never) as string | undefined,
    email: c.get('email' as never) as string | undefined,
    role: c.get('role' as never) as string | undefined,
    permissions: c.get('permissions' as never) as string[] | undefined,
  };
}

function logPrintQueueAuthDenied(
  c: Context,
  err: unknown,
  diagnostics?: PrintQueueAuthDiagnostics
) {
  if (!isPrintQueueAccessError(err)) return;

  const auth = printQueueAuthVarsFromContext(c);
  const scope = printQueueScopeFromContext(c);

  console.warn('[print-queue:auth-denied]', {
    requestId:
      c.req.header('x-request-id') ??
      c.req.header('x-correlation-id') ??
      null,
    method: c.req.method,
    route: c.req.path,
    action: diagnostics?.action ?? 'unknown',
    userId: auth.userId ?? null,
    email: redactEmailForLog(auth.email),
    role: auth.role ?? null,
    permissions: Array.isArray(auth.permissions) ? [...auth.permissions].sort() : [],
    authDomain: getAuthDomain({ role: auth.role }),
    requestedOrderIds: uniquePositiveInts(diagnostics?.requestedOrderIds ?? []),
    requestedClientIds: uniquePositiveInts(diagnostics?.requestedClientIds ?? []),
    allowedClientIds: scope.scopeClientIds ?? [],
    allowedStoreIds: scope.scopeStoreIds ?? [],
    scopeRestricted: scope.scopeRestricted === true,
    code: err.code,
  });
}

function printQueueSafeClientErrorResponse(
  c: Context,
  err: unknown,
  diagnostics?: PrintQueueAuthDiagnostics
) {
  if (isPrintQueueLabelUrlError(err)) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  if (isPrintQueueAccessError(err)) {
    logPrintQueueAuthDenied(c, err, diagnostics);
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  if (isPrintQueueDurableStatusError(err)) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  if (isPrintQueueAlreadyFinalizedError(err)) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  throw err;
}

async function withDurableStatusTimeout<T>(read: () => Promise<T>): Promise<T | null> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      read(),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), DURABLE_STATUS_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function canViewQueueSendSnapshot(
  snapshot: QueueSendJobSnapshot,
  scope: PrintQueueListScope,
): Promise<boolean> {
  try {
    await assertPrintQueueClientsVisible(snapshot.clientIds, scope);
    return true;
  } catch {
    return false;
  }
}

async function canViewMergeSnapshot(
  snapshot: MergeJobSnapshot,
  scope: PrintQueueListScope,
): Promise<boolean> {
  try {
    await assertPrintQueueClientsVisible(snapshot.clientIds, scope);
    return true;
  } catch {
    return false;
  }
}

const listQ = z.object({
  clientId: z.coerce.number().int().optional(),
  includePrinted: z
    .union([z.boolean(), z.enum(['1', 'true', '0', 'false'])])
    .optional()
    .transform((v) => v === true || v === '1' || v === 'true'),
});

app.get('/', zValidator('query', listQ), async (c) => {
  const q = c.req.valid('query');
  return c.json(await listQueue(q.clientId, q.includePrinted, printQueueScopeFromContext(c)));
});

const addBody = z.object({
  client_id: z.number().int(),
  order_id: z.string().min(1),
  order_number: z.string().nullable().optional(),
  // Per user override unlock shipped data on 2026-05-23: route accepts unknown
  // label payloads so service validation can return a typed queue-label error.
  label_url: z.unknown(),
  sku_group_id: z.string().min(1),
  primary_sku: z.string().nullable().optional(),
  item_description: z.string().nullable().optional(),
  order_qty: z.number().int().positive().optional(),
  multi_sku_data: z
    .array(z.object({ sku: z.string(), description: z.string().optional(), qty: z.number() }))
    .nullable()
    .optional(),
});

app.post('/add', zValidator('json', addBody), async (c) => {
  const b = c.req.valid('json');
  try {
    const { entry, alreadyQueued } = await addToQueue({
      clientId: b.client_id,
      orderId: b.order_id,
      orderNumber: b.order_number ?? null,
      labelUrl: b.label_url,
      skuGroupId: b.sku_group_id,
      primarySku: b.primary_sku ?? null,
      itemDescription: b.item_description ?? null,
      orderQty: b.order_qty ?? 1,
      multiSkuData: b.multi_sku_data ?? null,
      scope: printQueueScopeFromContext(c),
    });
    return c.json({
      queue_entry_id: entry.id,
      queued_at: entry.queuedAt.toISOString(),
      already_queued: alreadyQueued,
    });
  } catch (err) {
    return printQueueSafeClientErrorResponse(c, err, {
      action: 'add',
      requestedClientIds: [b.client_id],
    });
  }
});

const queueSendLabelBody = z.object({
  provider: z.string().optional(),
  serviceCode: z.string().optional(),
  carrierCode: z.string().optional(),
  carrierName: z.string().optional(),
  serviceName: z.string().optional(),
  serviceType: z.string().optional(),
  packageCode: z.string().optional(),
  packageName: z.string().nullable().optional(),
  customPackageId: z.number().int().positive().nullable().optional(),
  shippingProviderId: z.number().int().positive().nullable().optional(),
  weightOz: z.number().positive().optional(),
  length: z.number().nonnegative().optional(),
  width: z.number().nonnegative().optional(),
  height: z.number().nonnegative().optional(),
  confirmation: z.string().optional(),
  insuranceProvider: z.string().nullable().optional(),
  insuredValue: z.number().nullable().optional(),
  notifyCustomer: z.boolean().optional(),
  testLabel: z.boolean().optional(),
  // The backend-issued selected-rate proof the frontend captured for this order.
  // Without this field zValidator strips it from the body, the durable queue
  // worker calls createLabelV2 with selectedRateProof: undefined, and
  // assertSelectedRateProofForLabelPurchase rejects with
  // missing_current_fingerprint -> the user's recurring "Rate changed or
  // expired" loop on real orders. .passthrough() preserves the full selectedRate
  // object so the backend can recompute its fingerprint at the purchase boundary.
  selectedRateProof: z
    .object({
      requestFingerprint: z.string().nullable().optional(),
      selectedRate: z.unknown().optional(),
      eligibleRates: z.array(z.unknown()).nullable().optional(),
    })
    .passthrough()
    .optional(),
  // PS-105: backend-owned rate quote snapshot id + chosen rate authority key.
  // Preferred over selectedRateProof when a missing label must be created to queue.
  rateQuoteId: z.string().min(1).nullable().optional(),
  selectedRateKey: z.string().min(1).nullable().optional(),
});

const queueSendBody = z.object({
  concurrency: z.number().int().min(1).max(8).optional(),
  orders: z
    .array(
      z.object({
        order_id: z.number().int().positive(),
        client_id: z.number().int(),
        order_number: z.string().nullable().optional(),
        label_url: z.string().min(1).nullable().optional(),
        label: queueSendLabelBody.optional(),
        sku_group_id: z.string().min(1),
        primary_sku: z.string().nullable().optional(),
        item_description: z.string().nullable().optional(),
        order_qty: z.number().int().positive().optional(),
        multi_sku_data: z
          .array(z.object({ sku: z.string(), description: z.string().optional(), qty: z.number() }))
          .nullable()
          .optional(),
      })
    )
    .max(1000)
    .default([]),
  preflight_skips: z
    .array(
      z.object({
        order_id: z.number().int().positive(),
        client_id: z.number().int(),
        order_number: z.union([z.string(), z.number()]).nullable().optional(),
        reason: z.string().min(1),
        retry_eligible: z.boolean().optional(),
        retry_reason: z.string().nullable().optional(),
      })
    )
    .max(1000)
    .default([]),
})
  .refine((body) => body.orders.length + body.preflight_skips.length > 0, {
    message: 'orders or preflight_skips must be non-empty',
  })
  .refine((body) => body.orders.length + body.preflight_skips.length <= 1000, {
    message: 'orders plus preflight_skips must be <= 1000',
  });

app.post('/batch-send', zValidator('json', queueSendBody), async (c) => {
  const b = c.req.valid('json');
  const scope = printQueueScopeFromContext(c);
  try {
    await assertPrintQueueClientsVisible(
      [
        ...b.orders.map((order) => order.client_id),
        ...b.preflight_skips.map((skip) => skip.client_id),
      ],
      scope
    );
    const result = await startQueueSendJob({
      concurrency: b.concurrency,
      scope,
      preflightSkips: b.preflight_skips.map((skip) => ({
        orderId: skip.order_id,
        clientId: skip.client_id,
        orderNumber: skip.order_number ?? null,
        reason: skip.reason,
        retryEligible: skip.retry_eligible === true,
        retryReason: skip.retry_reason ?? null,
      })),
      orders: b.orders.map((order) => ({
        orderId: order.order_id,
        clientId: order.client_id,
        orderNumber: order.order_number ?? null,
        labelUrl: order.label_url ?? null,
        label: order.label
          ? {
              provider: order.label.provider,
              serviceCode: order.label.serviceCode ?? '',
              carrierCode: order.label.carrierCode,
              carrierName: order.label.carrierName,
              serviceName: order.label.serviceName,
              serviceType: order.label.serviceType,
              packageCode: order.label.packageCode,
              packageName: order.label.packageName,
              customPackageId: order.label.customPackageId,
              shippingProviderId: order.label.shippingProviderId,
              weightOz: order.label.weightOz,
              length: order.label.length,
              width: order.label.width,
              height: order.label.height,
              confirmation: order.label.confirmation,
              insuranceProvider: order.label.insuranceProvider ?? undefined,
              insuredValue: order.label.insuredValue ?? undefined,
              notifyCustomer: order.label.notifyCustomer,
              testLabel: order.label.testLabel,
              // Forward the selected-rate proof so the durable queue worker can
              // satisfy assertSelectedRateProofForLabelPurchase. Omitting it here
              // is what dropped the proof and produced missing_current_fingerprint.
              selectedRateProof: order.label.selectedRateProof,
              // PS-105: forward the backend-owned snapshot id + rate key too, so the
              // worker's createLabelV2 can prefer it (selectedRateProof stays as
              // the compatibility fallback). Dropping these would force legacy-only.
              rateQuoteId: order.label.rateQuoteId,
              selectedRateKey: order.label.selectedRateKey,
            }
          : undefined,
        skuGroupId: order.sku_group_id,
        primarySku: order.primary_sku ?? null,
        itemDescription: order.item_description ?? null,
        orderQty: order.order_qty ?? 1,
        multiSkuData: order.multi_sku_data ?? null,
        scope,
      })),
    });
    return c.json({ job_id: result.jobId, total: result.total, skipped: result.skipped });
  } catch (err) {
    return printQueueSafeClientErrorResponse(c, err, {
      action: 'batch-send',
      requestedOrderIds: [
        ...b.orders.map((order) => order.order_id),
        ...b.preflight_skips.map((skip) => skip.order_id),
      ],
      requestedClientIds: [
        ...b.orders.map((order) => order.client_id),
        ...b.preflight_skips.map((skip) => skip.client_id),
      ],
    });
  }
});

app.get('/batch-send/status/:jobId', async (c) => {
  const jobId = c.req.param('jobId');
  const scope = printQueueScopeFromContext(c);
  const job = getQueueSendJobStatus(jobId);
  const durableJob =
    await withDurableStatusTimeout(() => getQueueSendJobSnapshot(jobId)) ??
    await withDurableStatusTimeout(getLatestQueueSendJobSnapshot);
  if (!job) {
    if (durableJob?.jobId === jobId && await canViewQueueSendSnapshot(durableJob, scope)) {
      const durableStatus = deriveQueueSendSnapshotStatus(durableJob, {
        inMemoryJobPresent: false,
      });
      // Per user override unlock shipped data on 2026-06-30: durable fallback
      // returns full per-order batch results; resultSamples remains a compact
      // legacy preview for older UI/debug consumers.
      const durableResults = queueSendSnapshotResults(durableJob);
      return c.json({
        job_id: durableJob.jobId,
        status: durableStatus.status,
        progress_semantics: 'order_attempts',
        progress: durableStatus.total > 0
          ? Math.round((durableStatus.current / durableStatus.total) * 100)
          : durableJob.progress,
        total: durableStatus.total,
        current: durableStatus.current,
        total_orders: durableStatus.totalOrders,
        order_attempts_total: durableStatus.orderAttemptsTotal,
        completed_order_attempts: durableStatus.completedOrderAttempts,
        queued: durableStatus.queued,
        skipped: durableStatus.skipped,
        failed: durableStatus.failed,
        provider_pending: durableStatus.providerPending,
        in_progress: durableStatus.inProgress,
        message: durableStatus.message,
        client_id: durableJob.clientId,
        queued_entry_ids: durableJob.queuedEntryIds,
        results: durableResults,
        result_samples: durableJob.resultSamples,
        item_states: durableJob.itemStates ?? [],
        error: durableStatus.errorMessage,
        stale: durableStatus.staleReason != null,
        stale_reason: durableStatus.staleReason,
        durableJob,
      });
    }
    return c.json({ error: 'Job not found' }, 404);
  }
  if (!(await canViewQueueSendJob(job, scope))) {
    return c.json({ error: 'Job not found' }, 404);
  }
  const jobStatus = deriveQueueSendSnapshotStatus(job, {
    inMemoryJobPresent: true,
  });
  return c.json({
    job_id: job.jobId,
    status: jobStatus.status,
    progress_semantics: 'order_attempts',
    progress: jobStatus.total > 0
      ? Math.round((jobStatus.current / jobStatus.total) * 100)
      : job.progress,
    total: jobStatus.total,
    current: jobStatus.current,
    total_orders: jobStatus.totalOrders,
    order_attempts_total: jobStatus.orderAttemptsTotal,
    completed_order_attempts: jobStatus.completedOrderAttempts,
    queued: jobStatus.queued,
    skipped: job.skipped,
    failed: jobStatus.failed,
    provider_pending: jobStatus.providerPending,
    in_progress: jobStatus.inProgress,
    message: jobStatus.message,
    client_id: job.clientId ?? null,
    queued_entry_ids: job.queuedEntryIds,
    results: job.results,
    item_states: job.itemStates,
    error: jobStatus.errorMessage,
    stale: false,
    stale_reason: null,
    durableJob: durableJob?.jobId === job.jobId ? durableJob : null,
  });
});

// PS-279: backend-owned Send-to-Queue ROUTE PLAN. INERT unless
// PRINT_QUEUE_BACKEND_ORCHESTRATION is ON — when OFF it returns 503
// FEATURE_DISABLED before any work (no DB, no provider call, no postage), and the
// existing /batch-send route above is unchanged. When ON it RETURNS the route plan
// only (it does not start a job and never buys postage); the FE buy-path cutover is
// DEFERRED to a DJ canary. The classifier is the pure ported never-buy ladder.
const routePlanBody = z.object({
  existingLabelOnly: z.boolean().optional(),
  batchTestMode: z.boolean().optional(),
  orders: z
    .array(
      z.object({
        order_id: z.number().int().positive(),
        has_queueable_label: z.boolean(),
        is_test: z.boolean(),
        is_direct_carrier: z.boolean(),
        backend_queue_route: z.string().nullable().optional(),
        explicit_payload_provider_id: z.number().int().nullable().optional(),
      }),
    )
    .min(1)
    .max(200),
});

app.post('/route-plan', zValidator('json', routePlanBody), async (c) => {
  if (!env.PRINT_QUEUE_BACKEND_ORCHESTRATION) {
    return c.json(
      {
        error: 'Backend Send-to-Queue orchestration is disabled',
        code: 'FEATURE_DISABLED',
      },
      503,
    );
  }
  const b = c.req.valid('json');
  const plan = planQueueRouteForOrders(
    b.orders.map((order) => ({
      orderId: order.order_id,
      route: {
        hasQueueableLabel: order.has_queueable_label,
        isTest: order.is_test,
        isDirectCarrier: order.is_direct_carrier,
        backendQueueRoute: order.backend_queue_route ?? null,
        explicitPayloadProviderId: order.explicit_payload_provider_id ?? null,
      },
    })),
    {
      existingLabelOnly: b.existingLabelOnly,
      batchTestMode: b.batchTestMode,
      // PS-306/PS-317: when ON, a direct-carrier order needing a label routes to the backend
      // create job (createLabelV2) instead of the FE 'direct-create' buy. Default OFF → identical.
      directViaBackend: env.PRINT_QUEUE_DIRECT_VIA_BACKEND,
    },
  );
  return c.json({
    plans: plan.plans.map((p) => ({ order_id: p.orderId, route: p.route })),
    backend_order_ids: plan.backendOrderIds,
    direct_create_order_ids: plan.directCreateOrderIds,
  });
});

app.post(
  '/clear',
  zValidator(
    'json',
    z.object({
      client_id: z.number().int().optional(),
      // PS-195: blanket clears are gone — the caller must name EXACTLY which
      // queued entries it intends to remove. A clear without explicit ids is
      // rejected by the schema, so a stale UI can no longer wipe a queue it
      // is not looking at (or entries mid-merge in someone else's print job).
      queue_entry_ids: z.array(z.string().min(1)).min(1).max(500),
      confirmation: z.literal('REMOVE_UNPRINTED_LABELS'),
    })
  ),
  async (c) => {
    const body = c.req.valid('json');
    const result = await clearQueue({
      entryIds: body.queue_entry_ids,
      clientId: body.client_id,
      scope: printQueueScopeFromContext(c),
    });
    return c.json({
      cleared_count: result.cleared,
      blocked_in_flight: result.blockedInFlight,
    });
  }
);

app.post(
  '/confirm-printed',
  zValidator(
    'json',
    z.object({
      client_id: z.number().int().optional(),
      queue_entry_ids: z.array(z.string().min(1)).min(1),
      confirmation: z.literal('PRINTED'),
    })
  ),
  async (c) => {
    const body = c.req.valid('json');
    const result = await confirmPrintedQueueEntries({
      entryIds: body.queue_entry_ids,
      clientId: body.client_id,
      scope: printQueueScopeFromContext(c),
    });
    return c.json({
      confirmed_count: result.confirmedCount,
      confirmed_entry_ids: result.confirmedEntryIds,
    });
  }
);

app.post(
  '/print',
  zValidator(
    'json',
    z.object({
      client_id: z.number().int().optional(),
      queue_entry_ids: z.array(z.string().min(1)).min(1),
      merge_headers: z.boolean().optional(),
    })
  ),
  async (c) => {
    const b = c.req.valid('json');
    try {
      const result = await startPrintJob({
        clientId: b.client_id,
        queueEntryIds: b.queue_entry_ids,
        mergeHeaders: b.merge_headers,
        requestOrigin: new URL(c.req.url).origin,
        scope: printQueueScopeFromContext(c),
      });
      return c.json({ job_id: result.jobId, total: result.total });
    } catch (err) {
      return printQueueSafeClientErrorResponse(c, err, {
        action: 'print',
        requestedClientIds: b.client_id ? [b.client_id] : undefined,
      });
    }
  }
);

app.get('/print/status/:jobId', async (c) => {
  const jobId = c.req.param('jobId');
  const scope = printQueueScopeFromContext(c);
  const job = getMergeJobStatus(jobId);
  const durableJob = await withDurableStatusTimeout(getLatestMergeJobSnapshot);
  if (!job) {
    if (durableJob?.jobId === jobId && await canViewMergeSnapshot(durableJob, scope)) {
      return c.json({
        job_id: durableJob.jobId,
        status: durableJob.status,
        progress: durableJob.progress,
        total: durableJob.total,
        current: durableJob.current,
        message: durableJob.message,
        file_name: durableJob.fileName,
        chunk_count: durableJob.chunks?.length ?? 0,
        chunks: buildSignedMergeChunkDtos(c, durableJob.jobId, durableJob.chunks ?? [], 'inline'),
        error: durableJob.errorMessage,
        label_errors: durableJob.labelErrors,
        // PS-194: the entries that actually merged — the FE Confirm-Printed
        // gate consumes this DTO field, never a session-only set.
        successful_entry_ids: durableJob.successfulEntryIds ?? [],
        durableJob,
      });
    }
    return c.json({ error: 'Job not found' }, 404);
  }
  if (!(await canViewMergeJob(job, scope))) {
    return c.json({ error: 'Job not found' }, 404);
  }
  return c.json({
    job_id: job.jobId,
    status: job.status,
    progress: job.progress,
    total: job.total,
    current: job.current,
    message: job.message,
    file_name: job.fileName ?? null,
    chunk_count: job.chunks?.length ?? 0,
    chunks: buildSignedMergeChunkDtos(c, job.jobId, job.chunks, 'inline'),
    error: job.errorMessage ?? null,
    label_errors: job.labelErrors ?? [],
    // PS-194: see above — backend-owned Confirm-Printed evidence.
    successful_entry_ids: job.successfulEntryIds ?? [],
    durableJob: durableJob?.jobId === job.jobId ? durableJob : null,
  });
});

// PS-194: the most recent merge job (durable snapshot — survives worker
// restarts AND the operator's page refresh). The FE re-seeds its
// Confirm-Printed gate from successful_entry_ids on load, so "which labels
// actually went through a printed PDF" is backend truth instead of a
// session-only useState Set that a refresh wiped.
app.get('/print/last', async (c) => {
  const scope = printQueueScopeFromContext(c);
  const durableJob = await withDurableStatusTimeout(getLatestMergeJobSnapshot);
  if (!durableJob || !(await canViewMergeSnapshot(durableJob, scope))) {
    return c.json({ job: null });
  }
  return c.json({
    job: {
      job_id: durableJob.jobId,
      status: durableJob.status,
      file_name: durableJob.fileName,
      chunk_count: durableJob.chunks?.length ?? 0,
      chunks: buildSignedMergeChunkDtos(c, durableJob.jobId, durableJob.chunks ?? [], 'inline'),
      successful_entry_ids: durableJob.successfulEntryIds ?? [],
      created_at: durableJob.createdAt,
      persisted_at: durableJob.persistedAt,
    },
  });
});

const signedPdfQuery = z.object({
  disposition: z.enum(['inline', 'attachment']).optional(),
});

app.get('/print/signed-url/:jobId', zValidator('query', signedPdfQuery), async (c) => {
  const jobId = c.req.param('jobId');
  const q = c.req.valid('query');
  const scope = printQueueScopeFromContext(c);
  // PS-256: durable-aware so a signed link can still be minted for a batch whose bytes were
  // evicted by a restart (the rehydrated job carries the persisted clientIds for the scope gate).
  const job = await getMergeJobForServe(jobId);
  if (
    !job ||
    !(await canViewMergeJob(job, scope)) ||
    job.status !== 'done' ||
    (!job.mergedPdfBase64 && !hasDoneMergeChunks(job))
  ) {
    return c.json({ error: 'PDF not found or not ready' }, 404);
  }

  const { token, expiresAt } = signPrintQueuePdfToken(jobId);
  const disposition = q.disposition ?? 'inline';
  const url = new URL(c.req.url);
  url.pathname = `/print-queue/print/view/${encodeURIComponent(jobId)}`;
  url.search = new URLSearchParams({ token, disposition }).toString();
  const fileName = sanitizePdfFilename(job.fileName, `prepship-batch-print-${jobId}.pdf`);
  const chunks = buildSignedMergeChunkDtos(c, jobId, job.chunks, disposition);

  return c.json({
    url: url.toString(),
    expires_at: new Date(expiresAt).toISOString(),
    expires_in_seconds: Math.floor(SIGNED_PDF_TTL_MS / 1000),
    filename: fileName,
    disposition,
    chunk_count: chunks.length,
    chunks,
  });
});

app.get('/print/download/:jobId', async (c) => {
  const jobId = c.req.param('jobId');
  // PS-256: durable-aware so a download still works after a restart evicts the in-memory bytes.
  const job = await getMergeJobForServe(jobId);
  if (!job || !(await canViewMergeJob(job, printQueueScopeFromContext(c)))) {
    return c.json({ error: 'Job not found or not ready' }, 404);
  }
  return await serveMergedPdf(c, jobId, 'attachment');
});

// DELETE /print-queue/:entryId — removes a single queue entry by id.
//
// No body is required. The FE (v2-apiClient.removeFromQueue) calls
// this with `api.delete()` and no payload at all. We previously had
// `zValidator('json', schema.optional())` which tried to JSON-parse
// the body BEFORE the schema's `.optional()` clause could exempt it
// — empty body → "Malformed JSON in request body" 400. Result: the
// X button on every queue entry was broken.
//
// client_id used to be a body field for cross-client safety, but
// since the entryId is itself a UUID (effectively unguessable) and
// auth middleware already verifies the session, we drop it. The
// underlying removeFromQueue still throws if the entry doesn't
// exist, which surfaces as a 500 if someone passes a bad id.
app.delete('/:entryId', async (c) => {
  const entryId = c.req.param('entryId');
  await removeFromQueue(entryId, undefined, printQueueScopeFromContext(c));
  return c.json({ removed_entry: entryId });
});

export default app;
