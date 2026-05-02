import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  addToQueue,
  clearQueue,
  getQueueSendJobStatus,
  getMergeJobStatus,
  listQueue,
  removeFromQueue,
  startQueueSendJob,
  startPrintJob,
} from '../services/print-queue';

const app = new Hono();

const listQ = z.object({
  clientId: z.coerce.number().int().optional(),
  includePrinted: z
    .union([z.boolean(), z.enum(['1', 'true', '0', 'false'])])
    .optional()
    .transform((v) => v === true || v === '1' || v === 'true'),
});

app.get('/', zValidator('query', listQ), async (c) => {
  const q = c.req.valid('query');
  return c.json(await listQueue(q.clientId, q.includePrinted));
});

const addBody = z.object({
  client_id: z.number().int(),
  order_id: z.string().min(1),
  order_number: z.string().nullable().optional(),
  label_url: z.string().min(1),
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
  });
  return c.json({
    queue_entry_id: entry.id,
    queued_at: entry.queuedAt.toISOString(),
    already_queued: alreadyQueued,
  });
});

const queueSendLabelBody = z.object({
  serviceCode: z.string().optional(),
  carrierCode: z.string().optional(),
  packageCode: z.string().optional(),
  customPackageId: z.number().int().positive().nullable().optional(),
  shippingProviderId: z.number().int().positive().nullable().optional(),
  weightOz: z.number().positive().optional(),
  length: z.number().nonnegative().optional(),
  width: z.number().nonnegative().optional(),
  height: z.number().nonnegative().optional(),
  confirmation: z.string().optional(),
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
  const result = startQueueSendJob({
    concurrency: b.concurrency,
    orders: b.orders.map((order) => ({
      orderId: order.order_id,
      clientId: order.client_id,
      orderNumber: order.order_number ?? null,
      labelUrl: order.label_url ?? null,
      label: order.label
        ? {
            serviceCode: order.label.serviceCode ?? '',
            carrierCode: order.label.carrierCode,
            packageCode: order.label.packageCode,
            customPackageId: order.label.customPackageId,
            shippingProviderId: order.label.shippingProviderId,
            weightOz: order.label.weightOz,
            length: order.label.length,
            width: order.label.width,
            height: order.label.height,
            confirmation: order.label.confirmation,
            testLabel: order.label.testLabel,
          }
        : undefined,
      skuGroupId: order.sku_group_id,
      primarySku: order.primary_sku ?? null,
      itemDescription: order.item_description ?? null,
      orderQty: order.order_qty ?? 1,
      multiSkuData: order.multi_sku_data ?? null,
    })),
  });
  return c.json({ job_id: result.jobId, total: result.total });
});

app.get('/batch-send/status/:jobId', (c) => {
  const job = getQueueSendJobStatus(c.req.param('jobId'));
  if (!job) return c.json({ error: 'Job not found' }, 404);
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
  });
});

app.post(
  '/clear',
  zValidator(
    'json',
    z.object({ client_id: z.number().int().optional() }).optional()
  ),
  async (c) => {
    const body = c.req.valid('json');
    const cleared = await clearQueue(body?.client_id);
    return c.json({ cleared_count: cleared });
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
    const result = await startPrintJob({
      clientId: b.client_id,
      queueEntryIds: b.queue_entry_ids,
      mergeHeaders: b.merge_headers,
      requestOrigin: new URL(c.req.url).origin,
    });
    return c.json({ job_id: result.jobId, total: result.total });
  }
);

app.get('/print/status/:jobId', (c) => {
  const job = getMergeJobStatus(c.req.param('jobId'));
  if (!job) return c.json({ error: 'Job not found' }, 404);
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
  });
});

app.get('/print/download/:jobId', (c) => {
  const job = getMergeJobStatus(c.req.param('jobId'));
  if (!job || job.status !== 'done' || !job.mergedPdfBase64 || !job.fileName) {
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

app.delete(
  '/:entryId',
  zValidator(
    'json',
    z.object({ client_id: z.number().int().optional() }).optional()
  ),
  async (c) => {
    const entryId = c.req.param('entryId');
    const body = c.req.valid('json');
    await removeFromQueue(entryId, body?.client_id);
    return c.json({ removed_entry: entryId });
  }
);

export default app;
