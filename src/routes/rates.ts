import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { rateCache } from '../db/schema/rates';
import {
  CACHE_TTL_MS,
  getCarrierAccountsForRateContext,
  getDirectCarrierAccountsForRateContext,
  getRates,
  loadCarrierMarkups,
  loadDirectCarrierVisibilityEvaluator,
  markRateCacheRowForDisplay,
  rateCacheKey,
  resolveRateInput,
  sanitizeRateCacheRowForEligibility,
} from '../services/rates';
import { redactRateBrowserMoney } from '../services/rate-browser-money-redaction';
import { listCarrierAccounts } from '../services/carrier-connector-orchestrator';
import {
  getBackfillJob,
  getBackfillJobSnapshot,
  getLatestBackfillJobSnapshot,
  getRateBackfillGenerationState,
  reconcileBackfillJobWithGeneration,
  enqueueBackfillBestRates,
} from '../services/rates-backfill';
import multiCarrierHandler from '../lib/imported-handlers/rates-multi';
import { runNodeHandler } from '../lib/node-handler';
import {
  hasAppPermission,
  requireBusinessRoutePolicy,
  requireInternalPermission,
  requirePermission,
} from '../middleware/auth';
// PS-250 (Card 5): the shared order-scope owner — so a rate route can't read/persist
// against another tenant's order (cross-tenant IDOR on /browse).
import { scopeFromContext, orderScopePredicate } from '../lib/order-scope';
import { loadShippingAutomationRules } from '../services/shipping-automation';
import {
  buildBestRateWorkflowDto,
  isBestRateComplete,
  type BestRateWorkflowCarrierStatus,
} from '../services/shipping-workflow/best-rate-workflow-dto';
import { storeRateQuoteSnapshot } from '../services/shipping-workflow/rate-quote-snapshot-store';
import {
  getRateBrowseWorkflow,
  startRateBrowseWorkflow,
} from '../services/rate-browse-workflow';
import {
  getRateRecalculateBatch,
  retryRateRecalculateBatch,
  startRateRecalculateBatch,
  type RateRecalculateBatchSnapshot,
  type RateRecalculateBatchStartItem,
} from '../services/rate-recalculate-batch';
import { produceRateBrowsePayload } from '../services/rate-browse-response-producer';
import { stampRateBrowserDisplayAliases } from '../services/rate-browser-display-fields';
import { normalizeRateShipFromOrigin } from '../services/shipping-workflow/rate-ship-from-origin';
import { orderOverrides, orders } from '../db/schema/orders';
import { clients } from '../db/schema/clients';
import { getShopifyRatesForOrder, ShopifyRatesError } from '../services/shopify-rates';
import { logStructured, reportError, runWithLogContext } from '../lib/structured-log';
import { isPoBoxAddress } from '../services/shipping-workflow/address-classification';
import {
  authorizeRateRequestScope,
  authorizeRateRequestScopes,
  type RateRequestScopeDecision,
  type RateRequestScopeInput,
} from '../services/rate-request-authorization';
import { HazmatShippingError } from '../services/shipping-workflow/hazmat-shipping-policy.js';

const app = new Hono();

app.all(
  '/multi',
  requireInternalPermission('credentials:read'),
  runNodeHandler(multiCarrierHandler),
);

const rateCachePublicColumns = {
  cacheKey: rateCache.cacheKey,
  weightOz: rateCache.weightOz,
  toZip: rateCache.toZip,
  rates: rateCache.rates,
  bestRate: rateCache.bestRate,
  diagnostics: rateCache.diagnostics,
  weightVersion: rateCache.weightVersion,
  fetchedAt: rateCache.fetchedAt,
};

const legacyRateCachePublicColumns = {
  cacheKey: rateCache.cacheKey,
  weightOz: rateCache.weightOz,
  toZip: rateCache.toZip,
  rates: rateCache.rates,
  bestRate: rateCache.bestRate,
  weightVersion: rateCache.weightVersion,
  fetchedAt: rateCache.fetchedAt,
};

type RateCachePublicRow = {
  cacheKey: string;
  weightOz: number | null;
  toZip: string | null;
  rates: unknown[];
  bestRate: unknown;
  diagnostics: unknown[] | null;
  weightVersion: number | null;
  fetchedAt: Date;
};

function isMissingRateCacheDiagnosticsColumnError(err: unknown): boolean {
  const row = err as { code?: string; message?: string };
  const message = String(row?.message ?? '');
  return row?.code === '42703' && /diagnostics/i.test(message);
}

async function selectRateCachePublicRowsByKeys(cacheKeys: string[]): Promise<RateCachePublicRow[]> {
  if (!cacheKeys.length) return [];
  const predicate = or(...cacheKeys.map((key) => eq(rateCache.cacheKey, key)));
  try {
    return await db
      .select(rateCachePublicColumns)
      .from(rateCache)
      .where(predicate)
      .orderBy(sql`${rateCache.fetchedAt} desc`);
  } catch (err) {
    if (!isMissingRateCacheDiagnosticsColumnError(err)) throw err;
    console.warn(
      '[rates] rate_cache.diagnostics column missing; reading cached/bulk rows without diagnostics'
    );
    const rows = await db
      .select(legacyRateCachePublicColumns)
      .from(rateCache)
      .where(predicate)
      .orderBy(sql`${rateCache.fetchedAt} desc`);
    return rows.map((row) => ({ ...row, diagnostics: null }));
  }
}

async function selectRateCachePublicRowsByWeightZip(weightOz: number, toZip: string): Promise<RateCachePublicRow[]> {
  try {
    return await db
      .select(rateCachePublicColumns)
      .from(rateCache)
      .where(
        and(
          eq(rateCache.weightOz, weightOz),
          eq(rateCache.toZip, toZip.toUpperCase())
        )
      )
      .limit(25);
  } catch (err) {
    if (!isMissingRateCacheDiagnosticsColumnError(err)) throw err;
    console.warn(
      '[rates] rate_cache.diagnostics column missing; reading cached rows without diagnostics'
    );
    const rows = await db
      .select(legacyRateCachePublicColumns)
      .from(rateCache)
      .where(
        and(
          eq(rateCache.weightOz, weightOz),
          eq(rateCache.toZip, toZip.toUpperCase())
        )
      )
      .limit(25);
    return rows.map((row) => ({ ...row, diagnostics: null }));
  }
}

function canViewRateFinancials(c: Context): boolean {
  return hasAppPermission(
    {
      email: c.get('email' as never) as string | undefined,
      role: c.get('role' as never) as string | undefined,
      permissions: c.get('permissions' as never) as string[] | undefined,
    },
    'financials:read'
  );
}

function canViewRateAccountMetadata(c: Context): boolean {
  return hasAppPermission(
    {
      email: c.get('email' as never) as string | undefined,
      role: c.get('role' as never) as string | undefined,
      permissions: c.get('permissions' as never) as string[] | undefined,
    },
    'credentials:read'
  );
}

function rateScopeError(
  c: Context,
  decision: Exclude<RateRequestScopeDecision, { allowed: true }>,
  input: RateRequestScopeInput,
) {
  if (input.orderId != null) {
    return c.json({ error: 'Order not found' }, 404);
  }
  return c.json(
    {
      error: decision.source === 'missing-context'
        ? 'A scoped client or store context is required'
        : 'Rate context out of scope',
    },
    403,
  );
}

async function ensureRateScope(c: Context, input: RateRequestScopeInput) {
  const decision = await authorizeRateRequestScope(scopeFromContext(c), input);
  return decision.allowed ? null : rateScopeError(c, decision, input);
}

function publicRatesResult<T extends { rates?: unknown; bestRate?: unknown; secondBestRate?: unknown }>(
  result: T,
  canViewFinancials: boolean
): T {
  if (canViewFinancials) return result;
  return {
    ...result,
    rates: redactRateBrowserMoney(result.rates),
    bestRate: redactRateBrowserMoney(result.bestRate),
    secondBestRate: redactRateBrowserMoney(result.secondBestRate),
  };
}

function publicRateCacheRow<T extends { rates?: unknown; bestRate?: unknown; secondBestRate?: unknown }>(
  row: T | null | undefined,
  canViewFinancials: boolean
): T | null {
  if (!row) return null;
  const displayRow = {
    ...row,
    rates: stampRateBrowserDisplayAliases(row.rates),
    bestRate: stampRateBrowserDisplayAliases(row.bestRate),
    secondBestRate: stampRateBrowserDisplayAliases(row.secondBestRate),
  } as T;
  return publicRatesResult(displayRow, canViewFinancials);
}

const rateBody = z.object({
  weightOz: z.number().positive(),
  fromZip: z.string().min(3).optional(),
  shipFrom: z.object({}).catchall(z.unknown()).optional(),
  shipFromLocationId: z.number().int().positive().nullable().optional(),
  toZip: z.string().min(3),
  toCountry: z.string().optional(),
  toState: z.string().optional(),
  toCity: z.string().optional(),
  toAddress: z.string().optional(),
  toAddress2: z.string().optional(),
  toName: z.string().optional(),
  residential: z.boolean().optional(),
  dimsL: z.number().positive().optional(),
  dimsW: z.number().positive().optional(),
  dimsH: z.number().positive().optional(),
  customPackageId: z.number().int().positive().nullable().optional(),
  carrierIds: z.array(z.string()).optional(),
  storeId: z.number().int().nullable().optional(),
  clientId: z.number().int().nullable().optional(),
  confirmation: z.string().nullable().optional(),
  signature: z.string().nullable().optional(),
  insuranceProvider: z.string().nullable().optional(),
  insurance: z.string().nullable().optional(),
  insuredValue: z.number().nullable().optional(),
  insuranceValue: z.union([z.number(), z.string()]).nullable().optional(),
  forceRefresh: z.boolean().optional(),
});

app.post(
  '/',
  requireBusinessRoutePolicy('rates.quote'),
  zValidator('json', rateBody),
  async (c) => {
  const body = normalizeRateShipFromOrigin(c.req.valid('json'));
  const scopeError = await ensureRateScope(c, body);
  if (scopeError) return scopeError;
  const canViewFinancials = canViewRateFinancials(c);
  const { forceRefresh, signature, confirmation, ...input } = body;
  try {
    const result = await getRates(
      { ...input, confirmation: confirmation ?? signature ?? null },
      { forceRefresh, priority: 'interactive' }
    );
    return c.json(publicRatesResult(result, canViewFinancials));
  } catch (error) {
    reportError('rate.quote.failed', error, { operation: 'rate_quote' });
    throw error;
  }
  },
);

const browseBody = rateBody.extend({
  carrierId: z.string().min(1).optional(),
  preferredCarrierId: z.string().min(1).optional(),
  forceLive: z.boolean().optional(),
  cachedOnly: z.boolean().optional(),
  // PS-106/PS-124: order context so /browse can apply carrier-family eligibility
  // and backend-owned direct-carrier combined Best Rate selection.
  orderId: z.number().int().positive().nullable().optional(),
  externalOrderId: z.string().nullable().optional(),
  orderNumber: z.string().nullable().optional(),
  purchaseOrderId: z.string().nullable().optional(),
  includeVisibleDirectCarriers: z.boolean().optional(),
  includeAllDirectCarriers: z.boolean().optional(),
  // PS-197b: on-demand UNINSURED manual baseline (parity with ShipStation's own Rate Browser)
  // returned as a reference-only `manualEstimate` block — no selection keys, no snapshot, never
  // purchasable. One extra read-only quote, only when explicitly requested.
  manualEstimate: z.boolean().optional(),
  // PS-175 (Phase 3 part 1): ask the backend for the STRICT recalculation decision
  // (apply/blocked/clear) computed from THIS response's carriers + best rate.
  strictRecalculate: z.boolean().optional(),
});

const rateRecalculateBatchItemBody = z.object({
  orderId: z.number().int().positive(),
  request: browseBody.nullable(),
});

const rateRecalculateBatchBody = z.object({
  items: z.array(rateRecalculateBatchItemBody).min(1).max(100),
}).superRefine((value, ctx) => {
  const ids = value.items.map((item) => item.orderId);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Batch order IDs must be unique' });
  }
});

const rateRecalculateBatchRetryBody = z.object({
  items: z.array(z.object({
    orderId: z.number().int().positive(),
    request: browseBody,
  })).min(1).max(100),
});

const shopifyRatesBody = z.object({
  orderId: z.number().int().positive(),
  weightOz: z.number().positive().optional(),
  dims: z
    .object({
      length: z.number().positive().optional(),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
    })
    .optional(),
  dimsL: z.number().positive().optional(),
  dimsW: z.number().positive().optional(),
  dimsH: z.number().positive().optional(),
  packageName: z.string().trim().min(1).optional(),
  refresh: z.boolean().optional(),
});

// PS-203 (stage 3): rateTotal + dedupeBrowseRates moved to the canonical
// combined-selection owner (src/services/rates-combined.ts) — imported above.

function orderedCarrierIds(carrierIds: string[] | undefined, preferredCarrierId?: string): string[] | undefined {
  const unique = [...new Set((carrierIds ?? []).filter(Boolean))];
  if (!preferredCarrierId || !unique.includes(preferredCarrierId)) return unique.length ? unique : undefined;
  return [preferredCarrierId, ...unique.filter((carrierId) => carrierId !== preferredCarrierId)];
}

function publicRateBrowseWorkflowSnapshot(
  snapshot: Awaited<ReturnType<typeof startRateBrowseWorkflow>>,
  canViewFinancials: boolean,
) {
  const result = snapshot.result
    ? publicRatesResult(snapshot.result as { rates?: unknown; bestRate?: unknown; secondBestRate?: unknown }, canViewFinancials)
    : null;
  return {
    job_id: snapshot.jobId,
    status: snapshot.phase,
    progress: {
      total_carriers: snapshot.totalCarriers,
      completed_carriers: snapshot.completedCarriers,
      successful_carriers: snapshot.successfulCarriers,
      failed_carriers: snapshot.failedCarriers,
      rates_count: snapshot.ratesCount,
    },
    message: snapshot.message,
    request_key: snapshot.requestKey,
    order_id: snapshot.orderId,
    result,
    diagnostics: snapshot.diagnostics,
    error: snapshot.error,
    started_at: snapshot.startedAt,
    updated_at: snapshot.updatedAt,
    finished_at: snapshot.finishedAt,
  };
}

function publicRateRecalculateBatchSnapshot(snapshot: RateRecalculateBatchSnapshot) {
  return {
    batch_id: snapshot.batchId,
    status: snapshot.status,
    counters: {
      total: snapshot.counters.total,
      completed: snapshot.counters.completed,
      remaining: snapshot.counters.remaining,
      running: snapshot.counters.running,
      updated: snapshot.counters.updated,
      cleared: snapshot.counters.cleared,
      skipped: snapshot.counters.skipped,
      retryable_failed: snapshot.counters.retryableFailed,
      terminal_failed: snapshot.counters.terminalFailed,
    },
    items: snapshot.items.map((item) => ({
      order_id: item.orderId,
      workflow_job_id: item.workflowJobId,
      status: item.status,
      reason_code: item.reasonCode,
      message: item.message,
      retryable: item.retryable,
      started_at: item.startedAt,
      updated_at: item.updatedAt,
      finished_at: item.finishedAt,
    })),
    started_at: snapshot.startedAt,
    updated_at: snapshot.updatedAt,
    finished_at: snapshot.finishedAt,
  };
}

async function ensureRateRecalculateBatchScope(c: Context, orderIds: number[]) {
  const decision = await authorizeRateRequestScopes(
    scopeFromContext(c),
    orderIds.map((orderId) => ({ orderId })),
  );
  return decision.allowed
    ? null
    : rateScopeError(c, decision, { orderId: orderIds[0] });
}

app.post(
  '/browse/workflow/batch',
  requireBusinessRoutePolicy('rates.browse.workflow.batch.start'),
  zValidator('json', rateRecalculateBatchBody),
  async (c) => {
    const { items } = c.req.valid('json');
    const orderIds = items.map((item) => item.orderId);
    const scopeError = await ensureRateRecalculateBatchScope(c, orderIds);
    if (scopeError) return scopeError;

    // Read the authoritative order/client flags in the same scoped query. A
    // process-local test-client cache must not decide whether durable live-rate
    // work is admitted.
    const orderRows = await db
      .select({
        orderId: orders.id,
        clientId: orders.clientId,
        orderStatus: orders.orderStatus,
        isTestClient: clients.isTest,
      })
      .from(orders)
      .leftJoin(clients, eq(clients.id, orders.clientId))
      .where(and(inArray(orders.id, orderIds), orderScopePredicate(scopeFromContext(c))));
    const orderById = new Map(orderRows.map((row) => [row.orderId, row]));
    if (orderById.size !== new Set(orderIds).size) {
      return c.json({ error: 'Order not found' }, 404);
    }

    const startItems: RateRecalculateBatchStartItem[] = items.map((item) => {
      const order = orderById.get(item.orderId)!;
      if (order.orderStatus !== 'awaiting_shipment') {
        return {
          orderId: item.orderId,
          initialOutcome: {
            status: 'skipped',
            reasonCode: 'skipped_immutable_order',
            message: 'Only awaiting-shipment orders can be recalculated.',
            retryable: false,
          },
        };
      }
      if (order.isTestClient === true) {
        return {
          orderId: item.orderId,
          initialOutcome: {
            status: 'skipped',
            reasonCode: 'skipped_test_order',
            message: 'Test orders use backend fixture rates.',
            retryable: false,
          },
        };
      }
      if (!item.request) {
        return {
          orderId: item.orderId,
          initialOutcome: {
            status: 'failed_retryable',
            reasonCode: 'missing_shipment_inputs',
            message: 'Weight, dimensions, and ship-to postal code are required before recalculation.',
            retryable: true,
          },
        };
      }
      return {
        orderId: item.orderId,
        body: {
          ...normalizeRateShipFromOrigin(item.request),
          orderId: item.orderId,
          forceLive: true,
          forceRefresh: true,
          includeVisibleDirectCarriers: true,
          strictRecalculate: true,
        },
      };
    });

    const snapshot = await startRateRecalculateBatch({
      items: startItems,
      canViewFinancials: canViewRateFinancials(c),
    });
    return c.json(publicRateRecalculateBatchSnapshot(snapshot), 202);
  },
);

app.get('/browse/workflow/batch/:batchId', requirePermission('rates:quote'), async (c) => {
  const snapshot = await getRateRecalculateBatch(c.req.param('batchId'));
  if (!snapshot) return c.json({ error: 'Rate recalculation batch not found' }, 404);
  const scopeError = await ensureRateRecalculateBatchScope(
    c,
    snapshot.items.map((item) => item.orderId),
  );
  if (scopeError) return scopeError;
  return c.json(publicRateRecalculateBatchSnapshot(snapshot));
});

app.post(
  '/browse/workflow/batch/:batchId/retry',
  requireBusinessRoutePolicy('rates.browse.workflow.batch.retry'),
  zValidator('json', rateRecalculateBatchRetryBody),
  async (c) => {
    const batchId = c.req.param('batchId');
    const current = await getRateRecalculateBatch(batchId);
    if (!current) return c.json({ error: 'Rate recalculation batch not found' }, 404);
    const scopeError = await ensureRateRecalculateBatchScope(
      c,
      current.items.map((item) => item.orderId),
    );
    if (scopeError) return scopeError;
    const requested = c.req.valid('json').items;
    const knownIds = new Set(current.items.map((item) => item.orderId));
    if (requested.some((item) => !knownIds.has(item.orderId))) {
      return c.json({ error: 'Retry contains an order outside this batch' }, 400);
    }
    const requestedIds = requested.map((item) => item.orderId);
    const retryOrderRows = await db
      .select({
        orderId: orders.id,
        orderStatus: orders.orderStatus,
        isTestClient: clients.isTest,
      })
      .from(orders)
      .leftJoin(clients, eq(clients.id, orders.clientId))
      .where(and(inArray(orders.id, requestedIds), orderScopePredicate(scopeFromContext(c))));
    if (retryOrderRows.length !== new Set(requestedIds).size) {
      return c.json({ error: 'Order not found' }, 404);
    }
    if (retryOrderRows.some((order) => order.orderStatus !== 'awaiting_shipment')) {
      return c.json({ error: 'Only awaiting-shipment orders can be retried' }, 409);
    }
    if (retryOrderRows.some((order) => order.isTestClient === true)) {
      return c.json({ error: 'Test orders cannot start live rate retries' }, 409);
    }
    const retried = await retryRateRecalculateBatch(batchId, {
      canViewFinancials: canViewRateFinancials(c),
      items: requested.map((item) => ({
        orderId: item.orderId,
        body: {
          ...normalizeRateShipFromOrigin(item.request),
          orderId: item.orderId,
          forceLive: true,
          forceRefresh: true,
          includeVisibleDirectCarriers: true,
          strictRecalculate: true,
        },
      })),
    });
    return c.json(publicRateRecalculateBatchSnapshot(retried!), 202);
  },
);

app.post(
  '/browse/workflow',
  requireBusinessRoutePolicy('rates.browse.workflow.start'),
  zValidator('json', browseBody),
  async (c) => {
  const body = normalizeRateShipFromOrigin(c.req.valid('json'));
  const canViewFinancials = canViewRateFinancials(c);
  const scopeError = await ensureRateScope(c, body);
  if (scopeError) return scopeError;

  try {
    const snapshot = await runWithLogContext(
      { orderId: body.orderId ?? null },
      () => startRateBrowseWorkflow({
        body: body as Record<string, unknown>,
        canViewFinancials,
        orderId: body.orderId ?? null,
        requestKey: null,
        priority: 'manual',
        includeCachedPartial: body.forceLive === true,
      }),
    );
    return c.json(publicRateBrowseWorkflowSnapshot(snapshot, canViewFinancials));
  } catch (error) {
    reportError('rate.browse_workflow.start_failed', error, {
      operation: 'rate_browse_workflow',
      orderId: body.orderId ?? null,
    });
    throw error;
  }
  },
);

app.get('/browse/workflow/:jobId', requirePermission('rates:quote'), async (c) => {
  const snapshot = await getRateBrowseWorkflow(c.req.param('jobId'));
  if (!snapshot) return c.json({ error: 'Rate browse workflow job not found' }, 404);
  const scopeError = await ensureRateScope(c, {
    orderId: snapshot.orderId,
    clientId: snapshot.clientId,
    storeId: snapshot.storeId,
  });
  if (scopeError) return scopeError;
  return c.json(publicRateBrowseWorkflowSnapshot(snapshot, canViewRateFinancials(c)));
});

app.post('/shopify', requireBusinessRoutePolicy('rates.shopify.quote'), zValidator('json', shopifyRatesBody), async (c) => {
  const body = c.req.valid('json');
  const browseScope = scopeFromContext(c);
  const [inScope] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.id, body.orderId), orderScopePredicate(browseScope)))
    .limit(1);
  if (!inScope) return c.json({ error: 'Order not found' }, 404);

  try {
    const result = await runWithLogContext(
      { orderId: body.orderId },
      () => getShopifyRatesForOrder({
        orderId: body.orderId,
        weightOz: body.weightOz,
        dims: {
          length: body.dims?.length ?? body.dimsL,
          width: body.dims?.width ?? body.dimsW,
          height: body.dims?.height ?? body.dimsH,
        },
        packageName: body.packageName,
        refresh: body.refresh,
      }),
    );
    return c.json(result);
  } catch (err) {
    if (err instanceof ShopifyRatesError) {
      logStructured('warn', 'rate.shopify.rejected', {
        operation: 'shopify_rate_quote',
        orderId: body.orderId,
        status: err.status,
        errorCode: err.code,
      });
      return c.json({ error: err.message, code: err.code, ...(err.details ?? {}) }, err.status as 400);
    }
    reportError('rate.shopify.failed', err, {
      operation: 'shopify_rate_quote',
      orderId: body.orderId,
      status: 500,
    });
    return c.json({ error: err instanceof Error ? err.message : 'Shopify Rates failed' }, 500);
  }
});

// PS-203 (stage 2): does the cached row's diagnostic set cover any DIRECT
// carrier (synthetic se-1xxxxxxx ids ≥ 10,000,000)? Today's rate_cache rows are
// ShipStation-only, so this is false — but stage 3's combined cache rows will
// carry direct diagnostics and pass without touching this rule again.
function rateCacheRowCoversDirectCarriers(row: any): boolean {
  const diagnostics = Array.isArray(row?.diagnostics) ? row.diagnostics : [];
  return diagnostics.some((diagnostic: any) => {
    const match = /^se-(\d+)$/i.exec(String(diagnostic?.carrierId ?? ''));
    return match != null && Number.parseInt(match[1]!, 10) >= 10_000_000;
  });
}

function cacheMetadata(
  row: typeof rateCachePublicColumns | any,
  matchQuality: 'exact' | 'rough' | 'miss',
  options: { requiredDirectCarriersUncovered?: boolean } = {},
) {
  if (!row || matchQuality === 'miss') {
    return {
      matchType: 'miss' as const,
      matchQuality: 'miss' as const,
      approximate: false,
      isComplete: false,
      rateCount: 0,
      cacheCreatedAt: null,
      cacheExpiresAt: null,
      requestFingerprint: null,
    };
  }
  const rates = Array.isArray(row.rates) ? row.rates : [];
  const diagnostics = Array.isArray(row.diagnostics) ? row.diagnostics : [];
  const fetchedAt = row.fetchedAt instanceof Date ? row.fetchedAt : new Date(row.fetchedAt);
  const cacheExpiresAt = new Date(fetchedAt.getTime() + CACHE_TTL_MS);
  const fresh = cacheExpiresAt.getTime() > Date.now();
  // PS-203 (stage 2): completeness is relative to the REQUIRED carrier universe,
  // not just the carriers the row happened to query. A ShipStation-only row for
  // an order whose scope has visible direct carriers (Shipp / Walmart Shipping)
  // is NOT complete — persisting its winner is how the $10.44-vs-$9.27 premature
  // best rate happened. The FE's cache fast-path already requires isComplete, so
  // this alone stops the poisoning.
  const coversRequiredUniverse = options.requiredDirectCarriersUncovered !== true;
  const isComplete = fresh && rates.length > 0 && coversRequiredUniverse &&
    diagnostics.every((diagnostic: any) => (
      diagnostic?.status === 'ok' || diagnostic?.status === 'cached' || diagnostic?.status === 'empty'
    ));
  return {
    matchType: matchQuality,
    matchQuality: matchQuality === 'exact' ? 'exact' as const : 'rough' as const,
    approximate: matchQuality === 'rough' ? true : false,
    isComplete,
    ...(options.requiredDirectCarriersUncovered === true
      ? { requiredCarrierUniverse: 'missing-direct' as const }
      : {}),
    rateCount: rates.length,
    cacheCreatedAt: fetchedAt.toISOString(),
    cacheExpiresAt: cacheExpiresAt.toISOString(),
    requestFingerprint: row.cacheKey,
  };
}

app.post(
  '/browse',
  requireBusinessRoutePolicy('rates.browse'),
  zValidator('json', browseBody),
  async (c) => {
  const browseStartedAt = Date.now();
  const body = normalizeRateShipFromOrigin(c.req.valid('json'));
  const canViewFinancials = canViewRateFinancials(c);
  const scopeError = await ensureRateScope(c, body);
  if (scopeError) return scopeError;
  try {
    const payload = await runWithLogContext(
      { orderId: body.orderId ?? null },
      () => produceRateBrowsePayload({
        body,
        canViewFinancials,
        browseStartedAt,
      }),
    );
    return c.json(publicRatesResult(payload, canViewFinancials));
  } catch (error) {
    if (error instanceof HazmatShippingError) {
      const status = error.code.includes('INVALID') ? 422 : 409;
      logStructured('warn', 'rate.browse.hazmat_rejected', {
        operation: 'rate_browse',
        orderId: body.orderId ?? null,
        errorCode: error.code,
      });
      return c.json({ error: error.message, code: error.code, ...(error.details ?? {}) }, status);
    }
    reportError('rate.browse.failed', error, {
      operation: 'rate_browse',
      orderId: body.orderId ?? null,
    });
    throw error;
  }
  },
);
// v2-parity: supports v2's param aliases (wt, zip, l, w, h) AND the modern
// names. Adds optional dims + residential + storeId filters so the rate
// browser's cache hits return match-quality rates instead of a generic
// weight+zip bucket.
const cachedQuery = z
  .object({
    weightOz: z.coerce.number().positive().optional(),
    wt: z.coerce.number().positive().optional(),
    toZip: z.string().min(3).optional(),
    zip: z.string().min(3).optional(),
    dimsL: z.coerce.number().positive().optional(),
    l: z.coerce.number().positive().optional(),
    dimsW: z.coerce.number().positive().optional(),
    w: z.coerce.number().positive().optional(),
    dimsH: z.coerce.number().positive().optional(),
    h: z.coerce.number().positive().optional(),
    residential: z
      .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
      .optional(),
    storeId: z.coerce.number().int().optional(),
    clientId: z.coerce.number().int().optional(),
    signature: z.string().nullable().optional(),
  })
  .transform((v) => ({
    weightOz: v.weightOz ?? v.wt,
    toZip: v.toZip ?? v.zip,
    dimsL: v.dimsL ?? v.l,
    dimsW: v.dimsW ?? v.w,
    dimsH: v.dimsH ?? v.h,
    residential:
      typeof v.residential === 'boolean'
        ? v.residential
        : v.residential === 'true' || v.residential === '1'
          ? true
          : v.residential === 'false' || v.residential === '0'
            ? false
            : undefined,
    storeId: v.storeId,
    clientId: v.clientId,
    signature: v.signature,
  }))
  .refine(
    (v) => v.weightOz !== undefined && v.toZip !== undefined,
    { message: 'weightOz (or wt) and toZip (or zip) are required' }
  );

// Bulk lookup of cached rates. Exact cacheKey matches are authoritative;
// legacy weight+ZIP matches stay available but are explicitly approximate.
const bulkItemBody = z
  .object({
    cacheKey: z.string().min(1).optional(),
    weightOz: z.number().positive().optional(),
    toZip: z.string().min(3).optional(),
    toCountry: z.string().optional(),
    toAddress: z.string().optional(),
    toAddress2: z.string().optional(),
    residential: z.boolean().optional(),
    dimsL: z.number().positive().optional(),
    dimsW: z.number().positive().optional(),
    dimsH: z.number().positive().optional(),
    carrierIds: z.array(z.string()).optional(),
    orderId: z.number().int().optional(),
    storeId: z.number().int().nullable().optional(),
    clientId: z.number().int().nullable().optional(),
    sourceClientId: z.number().int().nullable().optional(),
    confirmation: z.string().nullable().optional(),
    insuranceProvider: z.string().nullable().optional(),
    insurance: z.string().nullable().optional(),
    insuredValue: z.number().nullable().optional(),
    insuranceValue: z.union([z.number(), z.string()]).nullable().optional(),
  })
  .refine(
    (item) => Boolean(item.cacheKey) || (item.weightOz !== undefined && item.toZip !== undefined),
    { message: 'Each item needs cacheKey or weightOz + toZip' },
  );

const bulkBody = z.object({
  items: z
    .array(bulkItemBody)
    .min(1)
    .max(200),
});

app.post(
  '/cached/bulk',
  requireBusinessRoutePolicy('rates.cache.bulk-read'),
  zValidator('json', bulkBody),
  async (c) => {
  const { items } = c.req.valid('json');
  const scopeDecision = await authorizeRateRequestScopes(scopeFromContext(c), items);
  if (!scopeDecision.allowed) {
    const scopedInput =
      items.find((item) => item.orderId != null) ??
      items.find((item) => item.clientId != null || item.storeId != null) ??
      {};
    return rateScopeError(c, scopeDecision, scopedInput);
  }
  const canViewFinancials = canViewRateFinancials(c);
  const automationRules = await loadShippingAutomationRules();
  // PS-203 (stage 2): one account-table load per request; each item's order
  // context is checked against the REQUIRED carrier universe below.
  const hasVisibleDirectCarriers = await loadDirectCarrierVisibilityEvaluator();
  const orderIds = [...new Set(items.map((item) => item.orderId).filter((id): id is number => id != null))];
  const scopedOrderRows = orderIds.length
    ? await db
        .select({
          id: orders.id,
          clientId: orders.clientId,
          storeId: orders.storeId,
          sourceProvider: orders.sourceProvider,
          sourceAccountId: orders.sourceAccountId,
          raw: orders.raw,
        })
        .from(orders)
        .where(and(
          or(...orderIds.map((id) => eq(orders.id, id))),
          orderScopePredicate(scopeFromContext(c)),
        ))
    : [];
  const orderContextById = new Map(scopedOrderRows.map((row) => [row.id, row]));
  const destinationForItem = (item: typeof items[number]) => {
    const orderContext = item.orderId != null ? orderContextById.get(item.orderId) : null;
    const rawShipTo = ((orderContext?.raw as { shipTo?: Record<string, unknown> } | null)?.shipTo) ?? {};
    return {
      street1: item.toAddress ?? (typeof rawShipTo.street1 === 'string' ? rawShipTo.street1 : null),
      street2: item.toAddress2 ?? (typeof rawShipTo.street2 === 'string' ? rawShipTo.street2 : null),
      country: item.toCountry ?? (typeof rawShipTo.country === 'string' ? rawShipTo.country : null),
    };
  };
  const directContextForItem = (item: typeof items[number]) => {
    const orderContext = item.orderId != null ? orderContextById.get(item.orderId) : null;
    return {
      clientId: orderContext?.clientId ?? item.clientId ?? null,
      storeId: orderContext?.storeId ?? item.storeId ?? null,
      sourceProvider: orderContext?.sourceProvider ?? null,
      sourceAccountId: orderContext?.sourceAccountId ?? null,
    };
  };
  const itemsWithKeys = await Promise.all(items.map(async (it) => {
    const destination = destinationForItem(it);
    const destinationPoBox = isPoBoxAddress(destination);
    if (it.cacheKey) {
      return {
        item: it,
        computedCacheKey: it.cacheKey,
        effectiveInsuranceProvider: null,
        effectiveInsuredValue: null,
        effectiveInsuranceSource: null,
        destinationPoBox,
      };
    }
    if (it.weightOz === undefined || it.toZip === undefined) {
      return {
        item: it,
        computedCacheKey: null,
        effectiveInsuranceProvider: null,
        effectiveInsuredValue: null,
        effectiveInsuranceSource: null,
        destinationPoBox,
      };
    }
    if (
      it.dimsL === undefined &&
      it.dimsW === undefined &&
      it.dimsH === undefined &&
      it.residential === undefined &&
      it.storeId === undefined &&
      it.clientId === undefined &&
      it.sourceClientId === undefined &&
      it.carrierIds === undefined &&
      it.confirmation === undefined &&
      it.insuranceProvider === undefined &&
      it.insurance === undefined &&
      it.insuredValue === undefined &&
      it.insuranceValue === undefined &&
      it.toCountry === undefined &&
      it.toAddress === undefined &&
      it.toAddress2 === undefined
    ) {
      return {
        item: it,
        computedCacheKey: null,
        effectiveInsuranceProvider: null,
        effectiveInsuredValue: null,
        effectiveInsuranceSource: null,
        destinationPoBox,
      };
    }
    const resolved = await resolveRateInput({
      weightOz: it.weightOz,
      toZip: it.toZip,
      toCountry: it.toCountry,
      toAddress: destination.street1 ?? undefined,
      toAddress2: destination.street2 ?? undefined,
      residential: it.residential,
      dimsL: it.dimsL,
      dimsW: it.dimsW,
      dimsH: it.dimsH,
      carrierIds: it.carrierIds,
      storeId: it.storeId,
      clientId: it.clientId,
      sourceClientId: it.sourceClientId,
      confirmation: it.confirmation,
      insuranceProvider: it.insuranceProvider ?? it.insurance,
      insuredValue: typeof it.insuranceValue === 'string' ? Number(it.insuranceValue) : it.insuredValue ?? it.insuranceValue,
    });
    return {
      item: it,
      computedCacheKey: rateCacheKey(resolved),
      effectiveInsuranceProvider: resolved.effectiveInsuranceProvider ?? resolved.insuranceProvider ?? null,
      effectiveInsuredValue: resolved.effectiveInsuredValue ?? resolved.insuredValue ?? null,
      effectiveInsuranceSource: resolved.effectiveInsuranceSource ?? null,
      destinationPoBox: resolved.destinationPoBox ?? destinationPoBox,
    };
  }));
  const exactKeys = [
    ...new Set(
      itemsWithKeys.map(({ computedCacheKey }) => computedCacheKey).filter((key): key is string => Boolean(key)),
    ),
  ];
  const exactRows = await selectRateCachePublicRowsByKeys(exactKeys);
  const exactRowsByKey = new Map<string, typeof exactRows[number]>();
  for (const row of exactRows) {
    if (!exactRowsByKey.has(row.cacheKey)) exactRowsByKey.set(row.cacheKey, row);
  }
  const roughLookupItems = itemsWithKeys.filter(({ item: it }) => (
    it.weightOz !== undefined && it.toZip !== undefined
  ));
  const roughRowsByWeightZip = new Map<string, RateCachePublicRow | null>();
  await Promise.all(roughLookupItems.map(async ({ item: it }) => {
    const key = `${it.weightOz}|${it.toZip!.toUpperCase()}`;
    if (roughRowsByWeightZip.has(key)) return;
    const rows = await selectRateCachePublicRowsByWeightZip(it.weightOz!, it.toZip!);
    roughRowsByWeightZip.set(key, rows[0] ?? null);
  }));
  // Audit R-6: current markups for read-time pricing of every served row.
  const displayMarkups = await loadCarrierMarkups();
  const results = itemsWithKeys.map(({ item: it, computedCacheKey, effectiveInsuranceProvider, effectiveInsuredValue, effectiveInsuranceSource, destinationPoBox }) => {
    const exactHit = computedCacheKey ? exactRowsByKey.get(computedCacheKey) : null;
    if (exactHit) {
      const eligibleHit = markRateCacheRowForDisplay(sanitizeRateCacheRowForEligibility(exactHit, {
        clientId: it.clientId ?? null,
        storeId: it.storeId ?? null,
        destinationPoBox,
      }, {
        // POLICY (DJ, 2026-06-04): default confirmation is 'none' (matches the
        // awaiting/modal default). Eligibility-only here; cached prices are
        // already baked, and the 'none' cache key never collides with old 'delivery' rows.
        confirmation: 'none',
        insuranceProvider: effectiveInsuranceProvider ?? (it.insuranceProvider && it.insuredValue ? it.insuranceProvider as any : 'none'),
        insuredValue: effectiveInsuredValue ?? (typeof it.insuranceValue === 'string' ? Number(it.insuranceValue) : it.insuredValue ?? it.insuranceValue ?? null),
      }, automationRules, displayMarkups), displayMarkups);
      const meta = cacheMetadata(eligibleHit, 'exact', {
        requiredDirectCarriersUncovered:
          hasVisibleDirectCarriers(directContextForItem(it)) &&
          !rateCacheRowCoversDirectCarriers(eligibleHit),
      });
      return {
        orderId: it.orderId,
        cacheKey: computedCacheKey,
        effectiveInsuranceProvider,
        effectiveInsuredValue,
        effectiveInsuranceSource,
        weightOz: it.weightOz,
        toZip: it.toZip,
        hit: publicRateCacheRow(eligibleHit, canViewFinancials),
        ...meta,
      };
    }
    const roughKey = it.weightOz !== undefined && it.toZip !== undefined
      ? `${it.weightOz}|${it.toZip.toUpperCase()}`
      : null;
    const roughHit = roughKey ? roughRowsByWeightZip.get(roughKey) : null;
    if (roughHit) {
      const eligibleHit = markRateCacheRowForDisplay(sanitizeRateCacheRowForEligibility(roughHit, {
        clientId: it.clientId ?? null,
        storeId: it.storeId ?? null,
        destinationPoBox,
      }, {
        // POLICY (DJ, 2026-06-04): default confirmation is 'none' (matches the
        // awaiting/modal default). Eligibility-only here; cached prices are
        // already baked, and the 'none' cache key never collides with old 'delivery' rows.
        confirmation: 'none',
        insuranceProvider: effectiveInsuranceProvider ?? (it.insuranceProvider && it.insuredValue ? it.insuranceProvider as any : 'none'),
        insuredValue: effectiveInsuredValue ?? (typeof it.insuranceValue === 'string' ? Number(it.insuranceValue) : it.insuredValue ?? it.insuranceValue ?? null),
      }, automationRules, displayMarkups), displayMarkups);
      const meta = cacheMetadata(eligibleHit, 'rough', {
        requiredDirectCarriersUncovered:
          hasVisibleDirectCarriers(directContextForItem(it)) &&
          !rateCacheRowCoversDirectCarriers(eligibleHit),
      });
      return {
        orderId: it.orderId,
        cacheKey: computedCacheKey,
        fallbackCacheKey: roughHit.cacheKey,
        effectiveInsuranceProvider,
        effectiveInsuredValue,
        effectiveInsuranceSource,
        weightOz: it.weightOz,
        toZip: it.toZip,
        hit: publicRateCacheRow(eligibleHit, canViewFinancials),
        ...meta,
      };
    }
    const meta = cacheMetadata(null, 'miss');
    return {
      orderId: it.orderId,
      effectiveInsuranceProvider,
      effectiveInsuredValue,
      effectiveInsuranceSource,
      weightOz: it.weightOz,
      toZip: it.toZip,
      cacheKey: computedCacheKey,
      hit: null,
      ...meta,
    };
  });
  return c.json({ data: results });
  },
);

app.get('/cached', zValidator('query', cachedQuery), async (c) => {
  const q = c.req.valid('query');
  const scopeError = await ensureRateScope(c, {
    clientId: q.clientId,
    storeId: q.storeId,
  });
  if (scopeError) return scopeError;
  const canViewFinancials = canViewRateFinancials(c);
  // weightOz + toZip are required by the schema, so the non-null
  // assertion is safe.
  const rows = await selectRateCachePublicRowsByWeightZip(q.weightOz!, q.toZip!);
  // Audit R-6: read-time markups on the cached fast-paint lane (see helper above).
  const cachedDisplayMarkups = await loadCarrierMarkups();
  const sanitizedRows = rows.map((row) => markRateCacheRowForDisplay(sanitizeRateCacheRowForEligibility(row, {
    clientId: null,
    storeId: q.storeId ?? null,
  }, undefined, undefined, cachedDisplayMarkups), cachedDisplayMarkups));
  return c.json({ data: sanitizedRows.map((row) => publicRateCacheRow(row, canViewFinancials)) });
});

app.get('/carriers', requireInternalPermission('credentials:read'), async (c) => {
  const data = await listCarrierAccounts('shipstation', {
    dedupeKey: 'carriers:list',
  });
  return c.json(data);
});

// v2 parity: GET /carriers-for-store?storeId=N&clientId=N returns only the
// carrier accounts for the resolved client/store credential source. This keeps
// the order Rate Browser from mixing DRP and KFG ShipStation accounts.
const carriersForStoreQuery = z.object({
  storeId: z.coerce.number().int().optional(),
  clientId: z.coerce.number().int().optional(),
  orderId: z.coerce.number().int().positive(),
});

app.get('/carriers-for-store', zValidator('query', carriersForStoreQuery), async (c) => {
  const { orderId } = c.req.valid('query');
  const canViewAccountMetadata = canViewRateAccountMetadata(c);
  const [accountContext] = await db
    .select({
      storeId: orders.storeId,
      clientId: orders.clientId,
      sourceProvider: orders.sourceProvider,
      sourceAccountId: orders.sourceAccountId,
    })
    .from(orders)
    .where(and(eq(orders.id, orderId), orderScopePredicate(scopeFromContext(c))))
    .limit(1);
  if (!accountContext) return c.json({ error: 'Order not found' }, 404);
  const [shipStationCarriers, directCarriers] = await Promise.all([
    getCarrierAccountsForRateContext(accountContext),
    getDirectCarrierAccountsForRateContext(accountContext),
  ]);
  const carriers = [...shipStationCarriers, ...directCarriers];
  const publicCarriers = carriers.map((ca) => ({
    ...ca,
    source_client_id: canViewAccountMetadata ? ca.source_client_id : null,
    source_client_name: canViewAccountMetadata ? ca.source_client_name : null,
  }));
  const data = carriers.map((ca) => ({
    carrierId: ca.carrier_id,
    carrierCode: ca.carrier_code,
    nickname: ca.nickname ?? ca.friendly_name ?? null,
    friendlyName: ca.friendly_name ?? ca.nickname ?? null,
    sourceClientId: canViewAccountMetadata ? ca.source_client_id : null,
    sourceClientName: canViewAccountMetadata ? ca.source_client_name : null,
    carrier_id: ca.carrier_id,
    carrier_code: ca.carrier_code,
    friendly_name: ca.friendly_name ?? ca.nickname ?? null,
    source_client_id: canViewAccountMetadata ? ca.source_client_id : null,
    source_client_name: canViewAccountMetadata ? ca.source_client_name : null,
  }));
  return c.json({
    carriers: publicCarriers,
    data,
    storeId: accountContext.storeId,
    clientId: accountContext.clientId,
    orderId,
  });
});

app.post(
  '/backfill-best',
  // PS-250 (Card 5): a global best-rate backfill is an admin/internal op, not tenant-scoped.
  requireBusinessRoutePolicy('rates.backfill.start'),
  zValidator(
    'json',
    z
      .object({
        mode: z.enum(['cache_first', 'full_live_audit', 'preexpiry_refresh']).optional(),
        clientId: z.number().int().optional(),
        limit: z.number().int().positive().max(10000).optional(),
        maxAgeHours: z.number().int().min(0).max(24 * 30).optional(),
      })
      .optional()
  ),
  async (c) => {
    const body = c.req.valid('json') ?? {};
    const job = await enqueueBackfillBestRates(body, 'manual');
    return c.json({ job_id: job.jobId, status: job.status });
  }
);

app.get('/backfill-best/status/:jobId', requireInternalPermission('scope:global'), async (c) => {
  const jobId = c.req.param('jobId');
  const job = getBackfillJob(c.req.param('jobId'));
  if (!job) {
    const durableJob = await getBackfillJobSnapshot(jobId);
    if (durableJob?.jobId === jobId) {
      return c.json({
        jobId: durableJob.jobId,
        status: durableJob.status,
        mode: durableJob.mode,
        total: durableJob.total,
        processed: durableJob.processed,
        updated: durableJob.updated,
        skipped: durableJob.skipped,
        failed: durableJob.failed,
        message: durableJob.message,
        error: durableJob.error,
        skipSamples: durableJob.skipSamples,
        failureSamples: durableJob.failureSamples,
        startedAt: Date.parse(durableJob.startedAt),
        finishedAt: durableJob.finishedAt ? Date.parse(durableJob.finishedAt) : null,
        durableJob,
      });
    }
    return c.json({ error: 'Job not found', durableJob }, 404);
  }
  const generation = await getRateBackfillGenerationState(jobId);
  return c.json(reconcileBackfillJobWithGeneration(job, generation));
});

app.get('/backfill-best/active', requireInternalPermission('scope:global'), async (c) => {
  const durableJob = await getLatestBackfillJobSnapshot();
  const generation = durableJob
    ? await getRateBackfillGenerationState(durableJob.jobId)
    : null;
  return c.json({
    job: durableJob?.active ? durableJob : null,
    generation: generation?.status === 'active' ? generation : null,
  });
});

app.get('/backfill-best/latest', requireInternalPermission('scope:global'), async (c) => {
  const durableJob = await getLatestBackfillJobSnapshot();
  const generation = durableJob
    ? await getRateBackfillGenerationState(durableJob.jobId)
    : null;
  return c.json({
    job: durableJob,
    durableJob,
    generation,
  });
});

// PS-250 (Card 5): wiping the WHOLE rate cache is a global admin op — not reachable by a tenant-scoped caller.
app.delete('/cache', requireBusinessRoutePolicy('rates.cache.delete'), async (c) => {
  const counts = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(rateCache);
  await db.delete(rateCache);
  return c.json({ deleted: counts[0]?.count ?? 0 });
});

// v2 parity: POST /rates/cache-clear-and-refetch — clears rate cache and
// kicks off a best-rate backfill. v2 exposed this at /cache/clear-and-refetch;
// mounting under /rates/ keeps the auth + route ownership clean.
app.post('/cache-clear-and-refetch', requireBusinessRoutePolicy('rates.cache.clear-refetch'), async (c) => {
  const counts = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(rateCache);
  await db.delete(rateCache);
  const job = await enqueueBackfillBestRates({ maxAgeHours: 0 }, 'manual');
  return c.json({
    cleared: counts[0]?.count ?? 0,
    refetchStarted: true,
    jobId: job.jobId,
  });
});

export default app;
