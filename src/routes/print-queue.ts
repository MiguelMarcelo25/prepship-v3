import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
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
import { getClientStoreScope, type ClientStoreScope } from '../lib/client-store-scope';

const app = new Hono();
const DURABLE_STATUS_TIMEOUT_MS = 1500;

function printQueueScopeFromContext(c: Context): PrintQueueListScope {
  const scope: ClientStoreScope = getClientStoreScope({
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

function printQueueLabelUrlErrorResponse(c: Context, err: unknown) {
  if (!isPrintQueueLabelUrlError(err)) throw err;
  return c.json({ error: err.message, code: err.code }, err.status);
}

function printQueueSafeClientErrorResponse(c: Context, err: unknown) {
  if (isPrintQueueLabelUrlError(err)) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  if (isPrintQueueAccessError(err)) {
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
    .array(z.object({ sku: z.string(), qty: z.number() }))
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
    return printQueueLabelUrlErrorResponse(c, err);
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
          .array(z.object({ sku: z.string(), qty: z.number() }))
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
    return printQueueSafeClientErrorResponse(c, err);
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
      confirmation: z.literal('REMOVE_UNPRINTED_LABELS'),
    })
  ),
  async (c) => {
    const body = c.req.valid('json');
    const cleared = await clearQueue(body.client_id, printQueueScopeFromContext(c));
    return c.json({ cleared_count: cleared });
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
      return printQueueLabelUrlErrorResponse(c, err);
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
    durableJob: durableJob?.jobId === job.jobId ? durableJob : null,
  });
});

app.get('/print/download/:jobId', async (c) => {
  const job = getMergeJobStatus(c.req.param('jobId'));
  if (
    !job ||
    !(await canViewMergeJob(job, printQueueScopeFromContext(c))) ||
    job.status !== 'done' ||
    !job.mergedPdfBase64 ||
    !job.fileName
  ) {
    return c.json({ error: 'Job not found or not ready' }, 404);
  }
  const bytes = Buffer.from(job.mergedPdfBase64, 'base64');
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="${job.fileName}"`,
      'content-length': String(bytes.byteLength),
    },
  });
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
