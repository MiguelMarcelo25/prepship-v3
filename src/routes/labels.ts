import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  LabelRateLimitError,
  createBatchV2,
  createLabelV2,
  createShopifyShippingLabelForOrder,
  createReturnLabelV2,
  getMockLabel,
  getMockLabelAsync,
  lookupLabel,
  pollShopifyShippingLabelPurchase,
  retrieveLabelV2,
  voidLabelV2,
} from '../services/labels';
import { generateMockLabelHtml } from '../services/mock-label-generator';
import { verifyMockLabelSignature } from '../lib/mock-label-access';
// PS-191: structural retry-eligibility classification for purchase failures.
import { classifyLabelPurchaseRetry } from '../services/shipping-workflow/rate-fingerprint';
// PS-233 (Per user override unlock shipped data on 2026-06-13): thread the caller
// scope into every label service + block portal roles from the mutation routes.
import { requireInternalPermission } from '../middleware/auth';
import { getClientStoreScope, type ClientStoreScope } from '../lib/client-store-scope';
import { recordLabelOperationLog } from '../lib/label-operation-log';
// PS-234: durable audit trail for label create/void/return.
import { recordAuditEvent, auditActorFromContext } from '../services/audit-log';
import { ShopifyRatesError } from '../services/shopify-rates';

const app = new Hono();

// PS-233: derive the caller's client/store scope from the verified JWT claims so
// the label services can refuse cross-tenant orders/shipments (404, no leak).
function labelsScopeFromContext(c: Context): ClientStoreScope {
  return getClientStoreScope({
    email: c.get('email' as never) as string | undefined,
    role: c.get('role' as never) as string | undefined,
    permissions: c.get('permissions' as never) as string[] | undefined,
    clientIds: c.get('clientIds' as never) as number[] | undefined,
    storeIds: c.get('storeIds' as never) as number[] | undefined,
  });
}

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

const selectedRateProofInput = z
  .object({
    requestFingerprint: z.string().min(1).optional(),
    selectedRate: z.unknown().optional(),
    eligibleRates: z.array(z.unknown()).optional(),
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
  insuranceProvider: z.string().optional(),
  insurance: z.string().optional(),
  insuredValue: z.number().nonnegative().nullable().optional(),
  insuranceValue: z.union([z.number(), z.string()]).nullable().optional(),
  testLabel: z.boolean().optional(),
  shipTo: addressInput,
  shipFrom: addressInput,
  selectedRateProof: selectedRateProofInput,
  // PS-105: backend-owned rate quote snapshot id + chosen rate authority key.
  rateQuoteId: z.string().min(1).nullable().optional(),
  selectedRateKey: z.string().min(1).nullable().optional(),
});

const shopifyCreateBody = z.object({
  orderId: z.number().int().positive(),
  weightOz: z.number().positive().optional(),
  length: z.number().positive().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  packageName: z.string().trim().min(1).nullable().optional(),
  customPackageId: z.number().int().positive().nullable().optional(),
  notifyCustomer: z.boolean().optional(),
  testLabel: z.boolean().optional(),
});

const batchBody = z.object({
  orderIds: z.array(z.number().int().positive()).min(1).max(100),
  serviceCode: z.string().min(1),
  carrierCode: z.string().optional(),
  packageCode: z.string().optional(),
  confirmation: z.string().optional(),
  insuranceProvider: z.string().optional(),
  insurance: z.string().optional(),
  insuredValue: z.number().nonnegative().nullable().optional(),
  insuranceValue: z.union([z.number(), z.string()]).nullable().optional(),
  testLabel: z.boolean().optional(),
  shippingProviderId: z.number().int().positive(),
  selectedRateProof: selectedRateProofInput,
});

const returnBody = z
  .object({ reason: z.string().optional() })
  .optional()
  .default({});

type CreateErr = Error & { code?: string; details?: Record<string, unknown>; rateLimited?: boolean; retryAfterMs?: number };
type CreateLabelRouteBody = z.infer<typeof createBody>;
type ShopifyCreateLabelRouteBody = z.infer<typeof shopifyCreateBody>;

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
  if (
    e.code === 'SELECTED_RATE_PROOF_INVALID' ||
    // PS-204 account-binding rejections are the same SelectedRateProofError
    // class with a more specific code — operator-actionable 400s, not 500s.
    e.code === 'DIRECT_CARRIER_ON_SHIPSTATION_PATH' ||
    e.code === 'SELECTED_RATE_ACCOUNT_MISMATCH'
  ) {
    // PS-191: structured retry eligibility on every purchase-failure response.
    // The FE branches on these fields — it must never regex the message — and
    // a retry-eligible failure only ever PROMPTS the operator to re-rate and
    // click again; nothing auto-purchases.
    const retry = classifyLabelPurchaseRetry(e);
    return c.json(
      {
        error: message,
        code: e.code,
        retryEligible: retry.retryEligible,
        retryReason: retry.retryReason,
        ...details,
      },
      400
    );
  }
  // PS-106: direct-store order blocked from a ShipStation carrier (enforce mode).
  if (e.code === 'CARRIER_FAMILY_NOT_ELIGIBLE') {
    return c.json({ error: message, code: e.code }, 400);
  }
  // Label/print-queue audit (2026-06-11): PS-128/PS-129 upstream shipping-safety block
  // (already shipped/cancelled upstream) is an operator-actionable conflict — ShippingSafetyError
  // carries status=409 by design (shipping-safety.ts:69-70). It was falling through to an opaque 500;
  // surface it as 409 + code so the operator sees WHY the buy was blocked (and never re-tries blindly).
  const safetyStatus = (e as { status?: number }).status;
  if (e.name === 'ShippingSafetyError' && typeof safetyStatus === 'number') {
    return c.json({ error: message, code: e.code, ...details }, (safetyStatus ?? 409) as 409);
  }
  // PS-135(a): rate-quote vs label residential mismatch is operator-actionable (re-rate), not a 500.
  if (e.code === 'RATE_LABEL_RESIDENTIAL_MISMATCH') {
    return c.json({ error: message, code: e.code, ...details }, 409);
  }
  // PS-186: a `testLabel: true` request for a NON-test client is rejected by the canonical
  // test-label policy — operator-actionable conflict (the order is real; create a real label).
  if (e.code === 'TEST_LABEL_REJECTED') {
    return c.json({ error: message, code: e.code, ...details }, 409);
  }
  // PS-190: structured label-conflict codes — same HTTP statuses the legacy
  // message-based mapping below produced (kept as a fallback for older error
  // shapes); the FE branches on `code` instead of substring-matching messages.
  if (e.code === 'LABEL_EXISTS' || e.code === 'ORDER_NOT_EDITABLE') {
    return c.json({ error: message, code: e.code, ...details }, 400);
  }
  if (e instanceof ShopifyRatesError) {
    return c.json({ error: message, code: e.code, ...details }, e.status as 400);
  }
  const invalid = [
    'orderId and serviceCode required',
    'shippingProviderId required for v2 label creation',
    'Order weight required to create label',
  ];
  const status =
    e.code === 'SHIPPING_SERVICE_NOT_ELIGIBLE' ? 400
    : invalid.includes(message) ? 400
    : message === 'Order not found' ? 404
    : message === 'Label already exists for this order' ? 400
    : message.startsWith('Cannot create label for') ? 400
    : 500;
  return c.json({ error: message, ...details }, status);
}

function createErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error';
}

async function createShopifyLabelRouteResponse(c: Context, body: ShopifyCreateLabelRouteBody): Promise<Response> {
  const startedAt = Date.now();
  try {
    const result = await createShopifyShippingLabelForOrder(body, labelsScopeFromContext(c));
    recordLabelOperationLog({
      action: 'label_create',
      status: 'success',
      orderId: body.orderId,
      orderNumber: null,
      cause: result.trackingNumber ? `Shopify label created: ${result.trackingNumber}` : 'Shopify label created',
      trackingNumber: result.trackingNumber ?? undefined,
      timingMs: result.timings?.totalMs ?? Date.now() - startedAt,
      source: result.provider,
    });
    await recordAuditEvent({
      ...auditActorFromContext(c),
      eventType: 'label',
      resourceType: 'order',
      resourceId: body.orderId,
      action: 'shopify_label_create',
      details: {
        shipmentId: result.shipmentId,
        tracking: result.trackingNumber,
        cost: result.cost,
        provider: result.provider,
        purchaseResultId: result.purchaseResultId,
        fulfillmentOrderId: result.fulfillmentOrderId,
      },
    });
    return c.json(result, 201);
  } catch (err) {
    recordLabelOperationLog({
      action: 'label_create',
      status: 'error',
      orderId: body.orderId,
      orderNumber: null,
      cause: createErrorMessage(err),
      timingMs: Date.now() - startedAt,
    });
    return handleCreateError(c, err);
  }
}

async function createLabelRouteResponse(c: Context, body: CreateLabelRouteBody): Promise<Response> {
  const startedAt = Date.now();
  try {
    const result = await createLabelV2(body, labelsScopeFromContext(c));
    recordLabelOperationLog({
      action: 'label_create',
      status: 'success',
      orderId: body.orderId,
      orderNumber: body.orderNumber ?? null,
      cause: result.trackingNumber ? `Label created: ${result.trackingNumber}` : 'Label created',
      trackingNumber: result.trackingNumber,
      timingMs: result.timings?.totalMs ?? Date.now() - startedAt,
      source: result.apiVersion,
    });
    await recordAuditEvent({
      ...auditActorFromContext(c),
      eventType: 'label',
      resourceType: 'order',
      resourceId: body.orderId,
      action: 'label_create',
      details: { shipmentId: result.shipmentId, tracking: result.trackingNumber, cost: result.cost },
    });
    return c.json(result, 201);
  } catch (err) {
    recordLabelOperationLog({
      action: 'label_create',
      status: 'error',
      orderId: body.orderId,
      orderNumber: body.orderNumber ?? null,
      cause: createErrorMessage(err),
      timingMs: Date.now() - startedAt,
    });
    return handleCreateError(c, err);
  }
}

// POST /labels — create single label (v2-parity flat body)
// PS-233: requireInternalPermission blocks portal roles (client_user /
// read_only_support) from buying postage at all; the scope passed to the service
// then refuses any order outside an internal caller's scope.
app.post('/', requireInternalPermission('print_queue:write'), zValidator('json', createBody), async (c) => {
  return createLabelRouteResponse(c, c.req.valid('json'));
});

// POST /labels/create — explicit v2 path alias
app.post('/create', requireInternalPermission('print_queue:write'), zValidator('json', createBody), async (c) => {
  return createLabelRouteResponse(c, c.req.valid('json'));
});

// POST /labels/shopify - buy a Shopify Shipping label from a backend-issued Shopify rate quote.
// Hidden from portal roles by requireInternalPermission; the service re-checks Shopify source,
// selected-rate proof, shipped/cancelled editability, and shipping safety before postage.
app.post('/shopify', requireInternalPermission('print_queue:write'), zValidator('json', shopifyCreateBody), async (c) => {
  return createShopifyLabelRouteResponse(c, c.req.valid('json'));
});

app.get('/shopify/:purchaseResultId', requireInternalPermission('print_queue:write'), async (c) => {
  try {
    const result = await pollShopifyShippingLabelPurchase(c.req.param('purchaseResultId'), labelsScopeFromContext(c));
    return c.json(result, result.pending ? 202 : 200);
  } catch (err) {
    return handleCreateError(c, err);
  }
});

// POST /labels/create-batch — bulk creation
app.post('/create-batch', requireInternalPermission('print_queue:write'), zValidator('json', batchBody), async (c) => {
  try {
    const body = c.req.valid('json');
    const result = await createBatchV2(body, labelsScopeFromContext(c));
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

// POST /labels/:shipmentId/void — void a label at its OWNING provider.
// PS-211: outcomes are structured statuses from the service ('voided' /
// 'already_voided' succeed; 'not_supported' / 'not_voidable' / 'provider_failed'
// leave the local record active). HTTP codes follow the status so callers and
// scripts can branch without parsing message strings.
app.post('/:shipmentId{[0-9]+}/void', requireInternalPermission('print_queue:write'), async (c) => {
  const id = Number(c.req.param('shipmentId'));
  try {
    const result = await voidLabelV2(id, labelsScopeFromContext(c));
    await recordAuditEvent({
      ...auditActorFromContext(c),
      eventType: 'label',
      resourceType: 'shipment',
      resourceId: id,
      action: 'label_void',
      details: { status: result.status, success: result.success },
    });
    const httpStatus =
      result.status === 'provider_failed' ? 502
      : result.status === 'not_supported' || result.status === 'not_voidable' ? 409
      : 200;
    if (result.status === 'provider_failed') {
      // Per user override unlock shipped data on 2026-07-06 (PS-399): include
      // sanitized provider detail in the error field consumed by ApiRequestError.
      return c.json(
        {
          ...result,
          error: result.message,
          code: 'LABEL_VOID_PROVIDER_FAILED',
          providerFailure: {
            provider: result.provider,
            status: result.status,
            detail: result.message,
          },
        },
        httpStatus,
      );
    }
    return c.json(result, httpStatus);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const status = message === 'Shipment not found' ? 404 : 500;
    return c.json({ error: message }, status);
  }
});

// POST /labels/:shipmentId/return — create a return label
app.post(
  '/:shipmentId{[0-9]+}/return',
  requireInternalPermission('print_queue:write'),
  zValidator('json', returnBody),
  async (c) => {
    const id = Number(c.req.param('shipmentId'));
    try {
      const body = c.req.valid('json');
      const result = await createReturnLabelV2(id, body, labelsScopeFromContext(c));
      await recordAuditEvent({
        ...auditActorFromContext(c),
        eventType: 'label',
        resourceType: 'shipment',
        resourceId: id,
        action: 'label_return',
        details: { returnTracking: result.returnTrackingNumber },
      });
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
  if (
    !verifyMockLabelSignature(
      shipmentId,
      c.req.query('exp'),
      c.req.query('sig')
    )
  ) {
    return c.json({ error: 'Mock label link expired' }, 403);
  }
  // Try the hot in-memory cache first; fall back to DB so mocks survive restarts.
  const data = getMockLabel(shipmentId) ?? await getMockLabelAsync(shipmentId);
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
    const result = await retrieveLabelV2(lookup, fresh, labelsScopeFromContext(c));
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
  const rows = await lookupLabel(lookup, labelsScopeFromContext(c));
  if (!rows.length) return c.json({ error: 'No labels found' }, 404);
  return c.json({ data: rows });
});

export default app;
