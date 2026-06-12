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
  isPrintQueueAccessError,
  isPrintQueueDurableStatusError,
  isPrintQueueLabelUrlError,
  getMergeJobStatus,
  listQueue,
  removeFromQueue,
  startQueueSendJob,
  startPrintJob,
  type MergeJobSnapshot,
  type PrintQueueListScope,
  type QueueSendJobSnapshot,
} from '../services/print-queue';
import { getAuthDomain, requireInternalPermission } from '../middleware/auth';
import {
  getInternalOpsClientStoreScope,
  type ClientStoreScope,
} from '../lib/client-store-scope';
import { env } from '../lib/env';

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

function serveMergedPdf(c: Context, jobId: string, disposition: 'inline' | 'attachment') {
  const job = getMergeJobStatus(jobId);
  if (
    !job ||
    job.status !== 'done' ||
    !job.mergedPdfBase64
  ) {
    return c.json({ error: 'PDF not found or not ready' }, 404);
  }

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

app.get('/print/view/:jobId', async (c) => {
  const jobId = c.req.param('jobId');
  const verification = verifyPrintQueuePdfToken(c.req.query('token'), jobId);
  if (!verification.ok) {
    return c.json({ error: verification.code, code: verification.code }, verification.status);
  }
  const disposition =
    c.req.query('disposition') === 'attachment' ? 'attachment' : 'inline';
  return serveMergedPdf(c, jobId, disposition);
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
  serviceCode: z.string().optional(),
  carrierCode: z.string().optional(),
  carrierName: z.string().optional(),
  serviceName: z.string().optional(),
  serviceType: z.string().optional(),
  packageCode: z.string().optional(),
  customPackageId: z.number().int().positive().nullable().optional(),
  shippingProviderId: z.number().int().positive().nullable().optional(),
  weightOz: z.number().positive().optional(),
  length: z.number().nonnegative().optional(),
  width: z.number().nonnegative().optional(),
  height: z.number().nonnegative().optional(),
  confirmation: z.string().optional(),
  insuranceProvider: z.string().nullable().optional(),
  insuredValue: z.number().nullable().optional(),
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
    .min(1)
    .max(200),
});

app.post('/batch-send', zValidator('json', queueSendBody), async (c) => {
  const b = c.req.valid('json');
  const scope = printQueueScopeFromContext(c);
  try {
    await assertPrintQueueClientsVisible(
      b.orders.map((order) => order.client_id),
      scope
    );
    const result = await startQueueSendJob({
      concurrency: b.concurrency,
      scope,
      orders: b.orders.map((order) => ({
        orderId: order.order_id,
        clientId: order.client_id,
        orderNumber: order.order_number ?? null,
        labelUrl: order.label_url ?? null,
        label: order.label
          ? {
              serviceCode: order.label.serviceCode ?? '',
              carrierCode: order.label.carrierCode,
              carrierName: order.label.carrierName,
              serviceName: order.label.serviceName,
              serviceType: order.label.serviceType,
              packageCode: order.label.packageCode,
              customPackageId: order.label.customPackageId,
              shippingProviderId: order.label.shippingProviderId,
              weightOz: order.label.weightOz,
              length: order.label.length,
              width: order.label.width,
              height: order.label.height,
              confirmation: order.label.confirmation,
              insuranceProvider: order.label.insuranceProvider ?? undefined,
              insuredValue: order.label.insuredValue ?? undefined,
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
    return c.json({ job_id: result.jobId, total: result.total });
  } catch (err) {
    return printQueueSafeClientErrorResponse(c, err, {
      action: 'batch-send',
      requestedOrderIds: b.orders.map((order) => order.order_id),
      requestedClientIds: b.orders.map((order) => order.client_id),
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
      return c.json({
        job_id: durableJob.jobId,
        status: durableJob.status,
        progress: durableJob.progress,
        total: durableJob.total,
        current: durableJob.current,
        queued: durableJob.queued,
        failed: durableJob.failed,
        message: durableJob.message,
        client_id: durableJob.clientId,
        queued_entry_ids: durableJob.queuedEntryIds,
        results: durableJob.resultSamples,
        error: durableJob.errorMessage,
        durableJob,
      });
    }
    return c.json({ error: 'Job not found' }, 404);
  }
  if (!(await canViewQueueSendJob(job, scope))) {
    return c.json({ error: 'Job not found' }, 404);
  }
  return c.json({
    job_id: job.jobId,
    status: job.status,
    progress: job.progress,
    total: job.total,
    current: job.current,
    queued: job.queued,
    failed: job.failed,
    message: job.message,
    client_id: job.clientId ?? null,
    queued_entry_ids: job.queuedEntryIds,
    results: job.results,
    error: job.errorMessage ?? null,
    durableJob: durableJob?.jobId === job.jobId ? durableJob : null,
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
  const job = getMergeJobStatus(jobId);
  if (
    !job ||
    !(await canViewMergeJob(job, scope)) ||
    job.status !== 'done' ||
    !job.mergedPdfBase64
  ) {
    return c.json({ error: 'PDF not found or not ready' }, 404);
  }

  const { token, expiresAt } = signPrintQueuePdfToken(jobId);
  const disposition = q.disposition ?? 'inline';
  const url = new URL(c.req.url);
  url.pathname = `/print-queue/print/view/${encodeURIComponent(jobId)}`;
  url.search = new URLSearchParams({ token, disposition }).toString();
  const fileName = sanitizePdfFilename(job.fileName, `prepship-batch-print-${jobId}.pdf`);

  return c.json({
    url: url.toString(),
    expires_at: new Date(expiresAt).toISOString(),
    expires_in_seconds: Math.floor(SIGNED_PDF_TTL_MS / 1000),
    filename: fileName,
    disposition,
  });
});

app.get('/print/download/:jobId', async (c) => {
  const jobId = c.req.param('jobId');
  const job = getMergeJobStatus(jobId);
  if (!job || !(await canViewMergeJob(job, printQueueScopeFromContext(c)))) {
    return c.json({ error: 'Job not found or not ready' }, 404);
  }
  return serveMergedPdf(c, jobId, 'attachment');
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
