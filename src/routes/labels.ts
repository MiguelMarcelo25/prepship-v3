import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  LabelRateLimitError,
  createBatchV2,
  createLabelV2,
  createReturnLabelV2,
  getMockLabel,
  lookupLabel,
  retrieveLabelV2,
  voidLabelV2,
} from '../services/labels';
import { generateMockLabelHtml } from '../services/mock-label-generator';

const app = new Hono();

const addressInput = z
  .object({
    name: z.string().nullish(),
    company: z.string().nullish(),
    street1: z.string().nullish(),
    street2: z.string().nullish(),
    city: z.string().nullish(),
    state: z.string().nullish(),
    postalCode: z.string().nullish(),
    country: z.string().nullish(),
    phone: z.string().nullish(),
  })
  .optional();

const createBody = z.object({
  orderId: z.number().int().positive(),
  orderNumber: z.string().optional(),
  carrierCode: z.string().optional(),
  serviceCode: z.string().min(1),
  packageCode: z.string().optional(),
  customPackageId: z.number().int().positive().nullable().optional(),
  shippingProviderId: z.number().int().positive().nullable().optional(),
  weightOz: z.number().positive().optional(),
  length: z.number().nonnegative().optional(),
  width: z.number().nonnegative().optional(),
  height: z.number().nonnegative().optional(),
  confirmation: z.string().optional(),
  testLabel: z.boolean().optional(),
  shipTo: addressInput,
  shipFrom: addressInput,
});

const batchBody = z.object({
  orderIds: z.array(z.number().int().positive()).min(1).max(100),
  serviceCode: z.string().min(1),
  carrierCode: z.string().optional(),
  packageCode: z.string().optional(),
  confirmation: z.string().optional(),
  testLabel: z.boolean().optional(),
  shippingProviderId: z.number().int().positive(),
});

const returnBody = z
  .object({ reason: z.string().optional() })
  .optional()
  .default({});

type CreateErr = Error & { details?: Record<string, unknown>; rateLimited?: boolean; retryAfterMs?: number };

function handleCreateError(c: Context, err: unknown): Response {
  const e = err as CreateErr;
  const message = e instanceof Error ? e.message : 'Unknown error';
  const details = (e as { details?: Record<string, unknown> }).details ?? {};
  if (e instanceof LabelRateLimitError || e.rateLimited) {
    const retryAfterMs = e instanceof LabelRateLimitError ? e.retryAfterMs : e.retryAfterMs ?? 60000;
    const retryAfter = Math.ceil(retryAfterMs / 1000);
    return c.json(
      { error: message, retryAfter, rateLimited: true, ...details },
      429
    );
  }
  const invalid = [
    'orderId and serviceCode required',
    'shippingProviderId required for v2 label creation',
    'Order weight required to create label',
  ];
  const status =
    invalid.includes(message) ? 400
    : message === 'Order not found' ? 404
    : message === 'Label already exists for this order' ? 400
    : message.startsWith('Cannot create label for') ? 400
    : 500;
  return c.json({ error: message, ...details }, status);
}

// POST /labels — create single label (v2-parity flat body)
app.post('/', zValidator('json', createBody), async (c) => {
  try {
    const body = c.req.valid('json');
    const result = await createLabelV2(body);
    return c.json(result, 201);
  } catch (err) {
    return handleCreateError(c, err);
  }
});

// POST /labels/create — explicit v2 path alias
app.post('/create', zValidator('json', createBody), async (c) => {
  try {
    const body = c.req.valid('json');
    const result = await createLabelV2(body);
    return c.json(result, 201);
  } catch (err) {
    return handleCreateError(c, err);
  }
});

// POST /labels/create-batch — bulk creation
app.post('/create-batch', zValidator('json', batchBody), async (c) => {
  try {
    const body = c.req.valid('json');
    const result = await createBatchV2(body);
    return c.json(result);
  } catch (err) {
    const e = err as Error & { rateLimited?: boolean; retryAfterMs?: number };
    const message = e instanceof Error ? e.message : 'Unknown error';
    if (e.rateLimited) {
      return c.json(
        { error: message, retryAfter: Math.ceil((e.retryAfterMs ?? 60000) / 1000), rateLimited: true },
        429
      );
    }
    return c.json({ error: message }, 500);
  }
});

// POST /labels/:shipmentId/void — void a label
app.post('/:shipmentId{[0-9]+}/void', async (c) => {
  const id = Number(c.req.param('shipmentId'));
  try {
    const result = await voidLabelV2(id);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const status = message === 'Shipment not found' ? 404 : message === 'Label already voided' ? 400 : 500;
    return c.json({ error: message }, status);
  }
});

// POST /labels/:shipmentId/return — create a return label
app.post(
  '/:shipmentId{[0-9]+}/return',
  zValidator('json', returnBody),
  async (c) => {
    const id = Number(c.req.param('shipmentId'));
    try {
      const body = c.req.valid('json');
      const result = await createReturnLabelV2(id, body);
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      const status = message === 'Shipment not found' ? 404 : 500;
      return c.json({ error: message }, status);
    }
  }
);

// GET /labels/mock/:shipmentId — dev/test mock label (serves PDF when available, else HTML)
app.get('/mock/:shipmentId', async (c) => {
  const param = c.req.param('shipmentId');
  if (!/^-?\d+$/.test(param)) {
    return c.json({ error: 'Not found' }, 404);
  }
  const shipmentId = Number(param);
  const data = getMockLabel(shipmentId);
  if (!data) {
    return c.text('Mock label not found (server may have restarted)', 404, {
      'content-type': 'text/plain',
    });
  }
  if (data.pdfBase64) {
    const pdfBytes = Buffer.from(data.pdfBase64, 'base64');
    return new Response(pdfBytes, {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="mock-label-${shipmentId}.pdf"`,
        'content-length': String(pdfBytes.byteLength),
      },
    });
  }
  const html = generateMockLabelHtml(data);
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
});

// GET /labels/:lookup/retrieve — fetch label URL (fresh=true bypasses cache)
app.get('/:lookup/retrieve', async (c) => {
  const raw = c.req.param('lookup');
  const asNum = Number(raw);
  const lookup = Number.isFinite(asNum) && String(asNum) === raw ? asNum : raw;
  const fresh = c.req.query('fresh') === 'true';
  try {
    const result = await retrieveLabelV2(lookup, fresh);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const status =
      message.startsWith('No active label found') ||
      message.startsWith('Label was created') ||
      message === 'Label URL not available. The label may have been voided or deleted.'
        ? 404
        : 500;
    return c.json({ error: message }, status);
  }
});

// GET /labels/:lookup — list shipments matching the lookup (kept for back-compat)
app.get('/:lookup', async (c) => {
  const lookup = c.req.param('lookup');
  const rows = await lookupLabel(lookup);
  if (!rows.length) return c.json({ error: 'No labels found' }, 404);
  return c.json({ data: rows });
});

export default app;
