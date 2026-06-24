import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { rateCache } from '../db/schema/rates';
import {
  CACHE_TTL_MS,
  getCarrierAccountsForRateContext,
  getDirectCarrierRatesForRateInput,
  getRates,
  loadDirectCarrierVisibilityEvaluator,
  rateCacheKey,
  resolveRateInput,
  sanitizeRateCacheRowForEligibility,
} from '../services/rates';
import { combineCarrierUniverses, rateTotal } from '../services/rates-combined';
import { buildRateBrowseTimingDiagnostics } from '../services/rate-browser-timing-diagnostics';
// PS-293: the SHIPP house-tuple stamp is the ONE owner shared with the rates-backfill, so a HUGRAB
// house order gets the same nextBestNonHouseRate/houseMargin whether it was rated by /rates/browse or
// the backend backfill (no "two competing rate truths").
import { stampHouseTuple } from '../services/shipping-workflow/house-tuple-stamp';
import { redactRateBrowserMoney } from '../services/rate-browser-money-redaction';
import {
  buildResidentialEvidenceFromOrder,
  residentialEvidenceRateInput,
  type ResidentialEvidence,
} from '../services/shipping-workflow/residential-evidence';
// PS-276 (slice 2b-2b): the live address-classification resolver (cache-or-USPS), env-gated OFF.
import { resolveAddressClassification } from '../services/shipping-workflow/resolve-address-classification';
import { planStrictRecalculateDecision } from '../services/rates-recalculate';
import { persistStrictRecalculateOutcome } from '../services/rates-recalculate-persist';
import { listCarrierAccounts } from '../services/carrier-connector-orchestrator';
import {
  getActiveBackfillJob,
  getBackfillJob,
  getBackfillJobSnapshot,
  getLatestBackfillJob,
  getLatestBackfillJobSnapshot,
  startBackfillBestRates,
} from '../services/rates-backfill';
import multiCarrierHandler from '../lib/imported-handlers/rates-multi';
import { runNodeHandler } from '../lib/node-handler';
import { hasAppPermission, requireInternalPermission } from '../middleware/auth';
// PS-250 (Card 5): the shared order-scope owner — so a rate route can't read/persist
// against another tenant's order (cross-tenant IDOR on /browse).
import { scopeFromContext, orderScopePredicate } from '../lib/order-scope';
import { loadShippingAutomationRules } from '../services/shipping-automation';
import {
  buildBestRateWorkflowDto,
  isBestRateComplete,
  type BestRateWorkflowCarrierStatus,
} from '../services/shipping-workflow/best-rate-workflow-dto';
import {
  finalizeBestRateWithQuote,
  storeRateQuoteSnapshot,
  withSelectedRateKeys,
  selectedRateOpaqueKey,
  BACKEND_RATE_PROOF_SOURCE,
} from '../services/shipping-workflow/rate-quote-snapshot-store';
import {
  getCarrierEligibilityMode,
  evaluateOrderCarrierEligibility,
} from '../services/shipping-workflow/carrier-eligibility-policy';
import {
  resolveHugrabLabelPurchasePreflight,
  resolveShippCustomsValueProofSource,
} from '../services/shipping-workflow/hugrab-label-purchase-preflight';
import { normalizeRateShipFromOrigin } from '../services/shipping-workflow/rate-ship-from-origin';
import {
  isHugrabShippingContext,
  SHIPPING_SERVICE_ELIGIBILITY_VERSION,
} from '../lib/shipping-service-eligibility';
import { orderOverrides, orders } from '../db/schema/orders';
import { clients } from '../db/schema/clients';
import { isEbayMarketplaceOrder } from '../services/ebay-order-detection';

const app = new Hono();

app.all('/multi', runNodeHandler(multiCarrierHandler));

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

// PS-277 (slice 1): browse-to-SOT writeback canary. OFF by default — when 'on', a PLAIN browse
// (modal open) that returns a fresh LIVE complete best for an awaiting order reconciles the
// persisted SOT, so opening the Rate Browser corrects the BEST RATE column instead of leaving a
// stale number beside the live one. Flip after a canary (live write on a high-frequency endpoint).
function browseSotWritebackEnabled(): boolean {
  return process.env.BROWSE_SOT_WRITEBACK === 'on';
}

function hugrabShippCustomsValueProofEnabled(): boolean {
  return process.env.HUGRAB_SHIPP_CUSTOMS_VALUE_PROOF === 'on';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim();
    return text ? text : null;
  }
  return null;
}

function readMoneyObjectAmount(value: unknown): number {
  if (!isPlainRecord(value)) return 0;
  const amount = Number(value.amount ?? 0);
  return Number.isFinite(amount) ? amount : 0;
}

function readRateInsuranceCost(rate: Record<string, unknown>): number {
  const meta = isPlainRecord(rate.insuranceCost) ? rate.insuranceCost : null;
  const metaAmount = Number(meta?.amount ?? NaN);
  if (Number.isFinite(metaAmount)) return metaAmount;
  return readMoneyObjectAmount(rate.insurance_amount);
}

function readRateInsuranceProvenance(rate: Record<string, unknown>): string | null {
  const meta = isPlainRecord(rate.insuranceCost) ? rate.insuranceCost : null;
  return readText(meta?.provenance ?? rate.insuranceProvenance ?? rate.insurance_provenance ?? null);
}

function stampHugrabCoverageDisplayFields<T extends Record<string, unknown>>(
  rate: T,
  context: {
    isHugrab: boolean;
    insuranceProvider: string | null;
    insuredValue: number | null;
    shippCustomsValueProofEnabled: boolean;
  },
): T {
  const provider = readText(rate.provider ?? rate.carrierProvider ?? rate.carrier_code ?? null);
  const accountIdentity = readText(
    rate.accountIdentity ?? rate.carrierNickname ?? rate.carrier_nickname ?? rate._carrierName ?? null,
  );
  const serviceCode = readText(rate.serviceCode ?? rate.service_code ?? null);
  const proofSource = resolveShippCustomsValueProofSource({
    enabled: context.shippCustomsValueProofEnabled,
    provider,
    accountIdentity,
    serviceCode,
    insuredValue: context.insuredValue,
  });
  const preflight = resolveHugrabLabelPurchasePreflight({
    isHugrab: context.isHugrab,
    insuranceProvider: context.insuranceProvider,
    insuredValue: context.insuredValue,
    insuranceCost: readRateInsuranceCost(rate),
    insuranceProvenance: readRateInsuranceProvenance(rate),
    provider,
    accountIdentity,
    serviceCode,
    isDirectVerifiedAccount: context.insuranceProvider === 'carrier' && provider !== 'shipp',
    insuranceCoverageProofSource: proofSource,
  });
  return {
    ...rate,
    insuranceProvider: context.insuranceProvider,
    insuredValue: context.insuredValue,
    insuranceCoverageStatus: preflight.status,
    insuranceBadgeLabel: preflight.insuranceBadgeLabel,
    insuranceBadgeTone: preflight.insuranceBadgeTone,
    insuranceCoverageProofSource: preflight.insuranceCoverageProofSource,
    hugrabPurchaseAllowed: preflight.allow,
    hugrabPurchaseBlockReason: preflight.status === 'not_required' ? '' : preflight.reason,
  };
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
  return publicRatesResult(row, canViewFinancials);
}

const rateBody = z.object({
  weightOz: z.number().positive(),
  fromZip: z.string().min(3).optional(),
  shipFrom: z.object({}).catchall(z.unknown()).optional(),
  toZip: z.string().min(3),
  toCountry: z.string().optional(),
  toState: z.string().optional(),
  toCity: z.string().optional(),
  toAddress: z.string().optional(),
  toName: z.string().optional(),
  residential: z.boolean().optional(),
  dimsL: z.number().positive().optional(),
  dimsW: z.number().positive().optional(),
  dimsH: z.number().positive().optional(),
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

app.post('/', zValidator('json', rateBody), async (c) => {
  const body = normalizeRateShipFromOrigin(c.req.valid('json'));
  const canViewFinancials = canViewRateFinancials(c);
  const { forceRefresh, signature, confirmation, ...input } = body;
  const result = await getRates(
    { ...input, confirmation: confirmation ?? signature ?? null },
    { forceRefresh }
  );
  return c.json(publicRatesResult(result, canViewFinancials));
});

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

// PS-203 (stage 3): rateTotal + dedupeBrowseRates moved to the canonical
// combined-selection owner (src/services/rates-combined.ts) — imported above.

function orderedCarrierIds(carrierIds: string[] | undefined, preferredCarrierId?: string): string[] | undefined {
  const unique = [...new Set((carrierIds ?? []).filter(Boolean))];
  if (!preferredCarrierId || !unique.includes(preferredCarrierId)) return unique.length ? unique : undefined;
  return [preferredCarrierId, ...unique.filter((carrierId) => carrierId !== preferredCarrierId)];
}

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

app.post('/browse', zValidator('json', browseBody), async (c) => {
  const browseStartedAt = Date.now();
  const body = normalizeRateShipFromOrigin(c.req.valid('json'));
  const canViewFinancials = canViewRateFinancials(c);
  // PS-250 (Card 5): an order-scoped browse must belong to the caller. A restricted
  // (client_user) caller passing another tenant's orderId gets 404 — blocking the
  // cross-tenant rate read, residential-evidence load, AND the order_overrides persist
  // below (all keyed off body.orderId). Admin/global scope = unrestricted (no-op).
  if (body.orderId) {
    const browseScope = scopeFromContext(c);
    const [inScope] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.id, body.orderId), orderScopePredicate(browseScope)))
      .limit(1);
    if (!inScope) return c.json({ error: 'Order not found' }, 404);
  }
  const {
    forceRefresh,
    forceLive,
    cachedOnly,
    carrierId,
    carrierIds,
    preferredCarrierId,
    signature,
    confirmation,
    ...rest
  } = body;
  const requestedCarrierIds = carrierIds?.length ? carrierIds : carrierId ? [carrierId] : undefined;
  const preferred = preferredCarrierId ?? carrierId ?? requestedCarrierIds?.[0];
  const orderedIds = orderedCarrierIds(requestedCarrierIds, preferred);
  // PS-197 (residential parity): when the browse is for a real order, the BACKEND loads the
  // order's residential/commercial EVIDENCE (manual override > raw ShipStation source flag,
  // plus company/name for the heuristic tier) and feeds the canonical classifier through the
  // proper tiers — instead of trusting the FE's collapsed `residential: boolean` (which can
  // only ever be a source-signal and silently forced r=1 on #1461-style orders). The label
  // boundary already classifies from this same order evidence (PS-127), so browse == label
  // classification BY CONSTRUCTION. Best-effort: any load failure falls back to the FE boolean.
  let orderForBrowse: {
    sourceProvider: string | null;
    raw: unknown;
    clientId: number | null;
    storeId: number | null;
    orderNumber: string | null;
    clientName: string | null;
  } | null = null;
  let residentialEvidence: ResidentialEvidence | null = null;
  if (body.orderId) {
    try {
      const [ord] = await db
        .select({
          sourceProvider: orders.sourceProvider,
          raw: orders.raw,
          shipToName: orders.shipToName,
          clientId: orders.clientId,
          storeId: orders.storeId,
          orderNumber: orders.orderNumber,
          clientName: clients.name,
        })
        .from(orders)
        .leftJoin(clients, eq(clients.id, orders.clientId))
        .where(eq(orders.id, body.orderId))
        .limit(1);
      if (ord) {
        orderForBrowse = ord;
        const [ovr] = await db
          .select({ residential: orderOverrides.residential })
          .from(orderOverrides)
          .where(eq(orderOverrides.orderId, body.orderId))
          .limit(1);
        // PS-276: ONE residential-evidence builder, shared with rates-backfill so the live
        // Rate Browser and the persisted BEST RATE column feed the classifier the SAME manual
        // override + source flag (the #1585 residential asymmetry fix — backfill used to drop
        // the manual override that this path honors).
        // PS-276 (slice 2b-2b): resolve the carrier address-validation evidence (cache-or-USPS),
        // env-gated ADDRESS_RESOLVER (OFF -> {} -> classifier unchanged). Async UPSTREAM so the pure
        // classifier stays sync + the fingerprint matches the backfill path.
        const browseRawShipTo = ((ord.raw as { shipTo?: Record<string, unknown> } | null)?.shipTo) ?? {};
        const browseResolved = await resolveAddressClassification({
          street1: typeof browseRawShipTo.street1 === 'string' ? browseRawShipTo.street1 : null,
          city: typeof browseRawShipTo.city === 'string' ? browseRawShipTo.city : null,
          state: typeof browseRawShipTo.state === 'string' ? browseRawShipTo.state : null,
          postalCode: typeof browseRawShipTo.postalCode === 'string' ? browseRawShipTo.postalCode : null,
          country: typeof browseRawShipTo.country === 'string' ? browseRawShipTo.country : null,
        });
        residentialEvidence = buildResidentialEvidenceFromOrder({
          rawShipTo: (ord.raw as { shipTo?: unknown } | null)?.shipTo,
          manualOverrideResidential: ovr?.residential,
          shipToName: ord.shipToName,
          resolved: browseResolved,
        });
      }
    } catch (err) {
      console.warn('[rates/browse] order residential-evidence load skipped:', err instanceof Error ? err.message : err);
    }
  }
  const browseRateInput = {
    ...rest,
    confirmation: confirmation ?? signature ?? null,
    carrierIds: orderedIds,
    // Order-backed marketplace context: gates eBay Logistics to eBay orders and feeds the eBay
    // connector the order JSON it needs (ship-to + order id). Null/undefined off an order (e.g.
    // the Rate Shop calculator), which correctly excludes eBay there.
    sourceProvider: orderForBrowse?.sourceProvider ?? null,
    rawOrder: orderForBrowse?.raw ?? undefined,
    // eBay's direct carrier prices a specific eBay order; gate it on whether this IS an eBay
    // marketplace order (sync-path-agnostic — an eBay order synced via ShipStation still qualifies,
    // where the old sourceProvider==='ebay' gate wrongly excluded it). Falsy off any order so eBay
    // never clutters non-eBay orders.
    isEbayMarketplaceOrder: isEbayMarketplaceOrder({
      clientName: orderForBrowse?.clientName ?? null,
      sourceProvider: orderForBrowse?.sourceProvider ?? null,
      externalOrderId: (rest as { externalOrderId?: string | null }).externalOrderId ?? null,
      raw: orderForBrowse?.raw ?? null,
    }),
    // Carry the authoritative eBay order number so the eBay connector (externalOrderId ?? orderNumber)
    // always has the eBay orderId, even when the FE didn't pass one.
    orderNumber: orderForBrowse?.orderNumber ?? (rest as { orderNumber?: string | null }).orderNumber ?? null,
    // Evidence decides — the collapsed FE boolean is dropped (residential: undefined) so the
    // classifier's manual_override / source tiers attribute correctly. See residential-evidence.ts.
    ...(residentialEvidence ? residentialEvidenceRateInput(residentialEvidence, rest.toName) : {}),
  };
  // PS-perf (QA audit 2026-06-23): the ShipStation N-carrier fan-out (getRates) and the
  // direct-carrier fan-out (getDirectCarrierRatesForRateInput) are INDEPENDENT but were awaited
  // back-to-back, so their latencies ADDED (a primary cause of the 10-20s Browse Rates wait).
  // Overlap them. The direct path needs the REQUEST-LEVEL effective insurance the ShipStation
  // resolver computes, so resolve it ONCE up front via the SAME shared resolver getRates uses
  // internally (resolveRateInput). That resolver is config/cache-only and DETERMINISTIC on the
  // input (its own contract — it must stay deterministic so the cache key matches the cached-bulk
  // lookup), so resolvedForBrowse.effectiveInsurance* is byte-identical to result.effectiveInsurance*
  // — only the wall-clock changes (max instead of sum), never a quoted amount.
  const isCachedOnlyLookup = Boolean(cachedOnly && !forceRefresh && !forceLive);
  const resolvedForBrowse = await resolveRateInput(browseRateInput);
  let shipStationDurationMs = 0;
  let directCarrierDurationMs = 0;
  const [result, directRates] = await Promise.all([
    (async () => {
      const startedAt = Date.now();
      const r = await getRates(browseRateInput, {
        forceRefresh: forceRefresh || forceLive,
        cachedOnly: isCachedOnlyLookup,
      });
      shipStationDurationMs = Date.now() - startedAt;
      return r;
    })(),
    // PS-206: cachedOnly is honored across the WHOLE combined universe — a cached-only probe must
    // not live-quote direct carriers; the service returns terminal 'uncached' coverage diagnostics
    // for every visible direct account instead, and the Rate Browser decides its live follow-up
    // from that coverage identity (never from a carrier count).
    (async () => {
      const startedAt = Date.now();
      const r = await getDirectCarrierRatesForRateInput({
        ...rest,
        confirmation: confirmation ?? signature ?? null,
        carrierIds: requestedCarrierIds,
        insuranceProvider: resolvedForBrowse.effectiveInsuranceProvider ?? rest.insuranceProvider ?? null,
        insuredValue: resolvedForBrowse.effectiveInsuredValue ?? rest.insuredValue ?? null,
        effectiveInsuranceProvider: resolvedForBrowse.effectiveInsuranceProvider ?? null,
        effectiveInsuredValue: resolvedForBrowse.effectiveInsuredValue ?? null,
        effectiveInsuranceSource: resolvedForBrowse.effectiveInsuranceSource ?? null,
      }, { cachedOnly: isCachedOnlyLookup });
      directCarrierDurationMs = Date.now() - startedAt;
      return r;
    })(),
  ]);
  // PS-106 (Per user override unlock shipped data on 2026-06-06): carrier-family eligibility.
  // ShipStation candidates are filtered separately from PS-124 backend-owned direct-carrier
  // candidates. In `enforce` we drop them (the operator then sees only their direct carriers); in
  // `audit_only` we keep them and log a would-block. Best-effort: any failure (no order, settings
  // outage) simply allows the rates. The label purchase boundary is the authoritative block. This
  // only filters result.rates and is independent of the direct fan-out, so it runs after both.
  let carrierEligibility: { mode: string; wouldBlock: boolean; ruleId?: string } | null = null;
  let shipStationBlocked = false;
  if (body.orderId) {
    try {
      // PS-197: reuse the order row already loaded for the residential-evidence step above.
      const ord = orderForBrowse;
      if (ord) {
        const mode = await getCarrierEligibilityMode();
        const elig = evaluateOrderCarrierEligibility({ carrierFamily: 'shipstation', order: ord, mode });
        carrierEligibility = { mode, wouldBlock: elig.wouldBlock, ...(elig.ruleId ? { ruleId: elig.ruleId } : {}) };
        if (elig.wouldBlock) {
          if (!elig.allowed) shipStationBlocked = true;
          else console.warn(`[carrier-eligibility] AUDIT would-block browse: order=${body.orderId} source=${elig.orderSource} mode=${mode} rule=${elig.ruleId}`);
        }
      }
    } catch {
      /* best-effort: allow; purchase boundary remains authoritative */
    }
  }
  const requestedSet = requestedCarrierIds?.length ? new Set(requestedCarrierIds) : null;
  const filtered = shipStationBlocked
    ? []
    : requestedSet
      ? result.rates.filter((r) => requestedSet.has(r.carrier_id))
      : result.rates;
  const accounts = await getCarrierAccountsForRateContext({
    storeId: rest.storeId ?? null,
    clientId: rest.clientId ?? null,
  }).catch(() => []);
  // PS-203 (stage 3): the merge, the SINGLE cheapest pick (uniform charge basis —
  // direct rates now carry the same markup rules as ShipStation), the per-carrier
  // statuses, and the PS-111 combined-universe completeness are owned by the pure
  // rates-combined module. The backfill delegates to the SAME owner, so a
  // persisted best rate can never again be a ShipStation-only self-certified win.
  const combined = combineCarrierUniverses({
    ssRates: filtered,
    ssCacheKey: result.cacheKey,
    ssCached: result.cached,
    ssDiagnostics: result.carrierDiagnostics ?? [],
    directRates: directRates.rates,
    directDiagnostics: directRates.diagnostics,
    requestedCarrierIds,
    accountNamesByCarrierId: new Map(
      accounts.map((account) => [
        account.carrier_id,
        account.friendly_name ?? account.nickname ?? account.carrier_code ?? account.carrier_id,
      ])
    ),
    accountCarrierIds: accounts.map((account) => account.carrier_id),
    isCachedOnlyLookup,
  });
  const {
    combinedRates,
    cheapest,
    secondCheapest,
    combinedRequestKey,
    combinedCarrierStatuses,
    directCarrierDiagnostics,
    combinedCarrierDiagnostics,
    bestRateComplete,
  } = combined;
  const bestRateMetadata = cheapest
    ? {
        ...cheapest,
        requestFingerprint: combinedRequestKey,
        cacheKey: combinedRequestKey,
        cacheCreatedAt: result.fetchedAt,
        cacheExpiresAt: new Date(
          new Date(result.fetchedAt).getTime() + CACHE_TTL_MS
        ).toISOString(),
        effectiveInsuranceProvider: result.effectiveInsuranceProvider,
        effectiveInsuredValue: result.effectiveInsuredValue,
        effectiveInsuranceSource: result.effectiveInsuranceSource,
        insuranceProvider: result.effectiveInsuranceProvider,
        insuredValue: result.effectiveInsuredValue,
        isComplete: bestRateComplete,
        rateCount: combinedRates.length,
        matchType: result.cached ? 'cache' : 'live',
      }
    : null;
  // PS-105 (Per user override unlock shipped data on 2026-06-06): stamp each rate
  // with an opaque selection key and persist a backend-owned quote snapshot keyed
  // by an opaque rateQuoteId, so a later label purchase can validate the operator's
  // selection server-side WITHOUT the frontend carrying full proof internals. The
  // snapshot expires with the analytics-cache TTL; selectedRateProof stays as the
  // compatibility fallback until the frontend migrates.
  // PS-244: route the live /rates/browse producer through the SINGLE rate-finalization owner
  // (finalizeBestRateWithQuote) instead of stamping the selection key + quote snapshot inline,
  // so browse and the backfill producer can NEVER diverge. selectedRateKey/rateQuoteId are
  // byte-identical (shared pure fns); the best rate now also carries the backend-owned
  // proofSource (previously the frontend injected it). The locked label-purchase ENFORCEMENT
  // boundary is untouched — still dual-path (snapshot preferred, legacy selectedRateProof
  // fallback); that flip is deferred.
  //
  // PS-183: the cache-expiry TTL stays BACKEND-owned (CACHE_TTL_MS over the quote's fetchedAt,
  // the same expiry the rate cache enforces) so the FE never mints its own "now + 6h" freshness.
  const browseCacheExpiresAt = new Date(
    new Date(result.fetchedAt).getTime() + CACHE_TTL_MS
  ).toISOString();
  let responseRates: Array<Record<string, unknown>> = withSelectedRateKeys(combinedRates);
  let rateQuoteId: string | undefined;
  let bestRateOut = cheapest;
  let secondBestRateOut: Record<string, unknown> | null = null;
  if (cheapest) {
    const finalized = await finalizeBestRateWithQuote({
      bestRate: cheapest as Record<string, unknown>,
      rates: combinedRates as Array<Record<string, unknown>>,
      cacheKey: combinedRequestKey,
      bestRateComplete,
      fetchedAt: result.fetchedAt,
    });
    rateQuoteId = finalized.rateQuoteId;
    responseRates = finalized.rates;
    const finalizedSecondBestRate = secondCheapest
      ? {
          ...(secondCheapest as Record<string, unknown>),
          selectedRateKey: selectedRateOpaqueKey(secondCheapest),
          ...(rateQuoteId ? { rateQuoteId } : {}),
          proofSource: BACKEND_RATE_PROOF_SOURCE,
        }
      : null;
    secondBestRateOut =
      finalizedSecondBestRate && bestRateComplete
        ? {
            ...finalizedSecondBestRate,
            isComplete: bestRateComplete,
            requestFingerprint: combinedRequestKey,
            cacheKey: combinedRequestKey,
            cacheCreatedAt: result.fetchedAt,
            cacheExpiresAt: browseCacheExpiresAt,
            effectiveInsuranceProvider: result.effectiveInsuranceProvider,
            effectiveInsuredValue: result.effectiveInsuredValue,
            effectiveInsuranceSource: result.effectiveInsuranceSource,
            insuranceProvider: result.effectiveInsuranceProvider,
            insuredValue: result.effectiveInsuredValue,
            eligibilityVersion: SHIPPING_SERVICE_ELIGIBILITY_VERSION,
            rateCount: combinedRates.length,
            matchType: result.cached ? 'cache' : 'live',
          }
        : null;
    bestRateOut = {
      ...finalized.bestRate,
      secondBestRate: secondBestRateOut,
      isComplete: bestRateComplete,
      requestFingerprint: combinedRequestKey,
      cacheKey: combinedRequestKey,
      cacheCreatedAt: result.fetchedAt,
      cacheExpiresAt: browseCacheExpiresAt,
      effectiveInsuranceProvider: result.effectiveInsuranceProvider,
      effectiveInsuredValue: result.effectiveInsuredValue,
      effectiveInsuranceSource: result.effectiveInsuranceSource,
      insuranceProvider: result.effectiveInsuranceProvider,
      insuredValue: result.effectiveInsuredValue,
      eligibilityVersion: SHIPPING_SERVICE_ELIGIBILITY_VERSION,
      rateCount: combinedRates.length,
      matchType: result.cached ? 'cache' : 'live',
    } as typeof cheapest;
  }
  // PS-220 (projected house-margin): SHIPP is DRP's house carrier. When the saved winner is SHIPP
  // AND the client is opted in, capture the cheapest ELIGIBLE non-SHIPP competitor HERE —
  // combinedRates is the only place the full competitor list survives (the orders route discards it,
  // the purchase snapshot expires). Stamp it onto bestRateOut so the awaiting-only persist
  // (order_overrides.best_rate_json) carries it with zero re-fetch; realized capture at label
  // purchase reads it back. No competitor => pass-through (houseMargin 0). Best-effort: never breaks browse.
  // PS-293: delegate the house-tuple stamp to the shared owner (the SAME one the rates-backfill calls).
  // stampHouseTuple is the gate + projection + best-effort try/catch — it returns bestRateOut unchanged
  // for a non-SHIPP winner or a non-opted-in client (default-OFF inert), so this is byte-identical.
  if (bestRateOut && cheapest) {
    bestRateOut = await stampHouseTuple(bestRateOut as Record<string, unknown>, {
      cheapest,
      combinedRates,
      clientId: (rest as { clientId?: unknown }).clientId,
      storeId: (rest as { storeId?: unknown }).storeId,
      insuranceProvider: result.effectiveInsuranceProvider ?? null,
      insuredValue: result.effectiveInsuredValue ?? null,
    }) as typeof cheapest;
  }
  const hugrabCoverageDisplayContext = {
    isHugrab: isHugrabShippingContext({
      clientId: orderForBrowse?.clientId ?? rest.clientId ?? null,
      storeId: orderForBrowse?.storeId ?? rest.storeId ?? null,
    }),
    insuranceProvider: result.effectiveInsuranceProvider ?? null,
    insuredValue: result.effectiveInsuredValue ?? null,
    shippCustomsValueProofEnabled: hugrabShippCustomsValueProofEnabled(),
  };
  responseRates = responseRates.map((rate) =>
    stampHugrabCoverageDisplayFields(rate as Record<string, unknown>, hugrabCoverageDisplayContext),
  );
  if (bestRateOut) {
    bestRateOut = stampHugrabCoverageDisplayFields(
      bestRateOut as Record<string, unknown>,
      hugrabCoverageDisplayContext,
    ) as typeof cheapest;
  }
  if (secondBestRateOut) {
    secondBestRateOut = stampHugrabCoverageDisplayFields(
      secondBestRateOut,
      hugrabCoverageDisplayContext,
    );
    if (bestRateOut) {
      bestRateOut = {
        ...(bestRateOut as Record<string, unknown>),
        secondBestRate: secondBestRateOut,
      } as typeof cheapest;
    }
  }
  // PS-197b: on-demand uninsured manual baseline (ShipStation-only — mirrors what ShipStation's
  // own Rate Browser shows). Reference display ONLY: no withSelectedRateKeys, no snapshot, no
  // rate-quote id — structurally non-purchasable (the purchase boundary rejects proof-less rates).
  // Best-effort: a baseline failure never breaks the label-safe browse.
  let manualEstimate: { rates: unknown[]; fetchedAt: string; cached: boolean } | null = null;
  if (body.manualEstimate === true) {
    try {
      const manual = await getRates(
        // Same input as the label-safe browse (incl. the PS-197 residential evidence) so the
        // ONLY difference between the two quotes is the insurance — a true apples-to-apples
        // baseline.
        browseRateInput,
        {
          rawManualEstimate: true,
          forceRefresh: forceRefresh || forceLive,
          cachedOnly: Boolean(cachedOnly && !forceRefresh && !forceLive),
        },
      );
      const manualFiltered = requestedSet
        ? manual.rates.filter((r) => requestedSet.has(r.carrier_id))
        : manual.rates;
      manualEstimate = {
        rates: canViewFinancials ? manualFiltered : (redactRateBrowserMoney(manualFiltered) as unknown[]),
        fetchedAt: manual.fetchedAt,
        cached: manual.cached,
      };
    } catch (err) {
      console.warn('[rates/browse] manual-estimate baseline failed (reference only):', err instanceof Error ? err.message : err);
    }
  }
  // PS-175 (Phase 3): the STRICT recalculation decision is BACKEND-owned —
  // computed from the SAME combined carrier statuses + best rate this response
  // returns (byte-compatible port of the FE rule, which becomes a deploy-skew
  // fallback until Phase 6 deletes it). Part 2: when the request carries an
  // orderId, the OUTCOME is also persisted server-side (order_overrides only;
  // refuses non-awaiting orders — the same lock the guarded routes enforce).
  // The FE skips its own strict persist calls when `persisted: true`.
  let strictRecalculation: Record<string, unknown> | null = null;
  if (body.strictRecalculate === true) {
    const bestProviderMatch = cheapest ? /^se-(\d+)$/i.exec(String(cheapest.carrier_id ?? '')) : null;
    const bestProviderId = bestProviderMatch ? Number.parseInt(bestProviderMatch[1]!, 10) : null;
    const strictDecision = planStrictRecalculateDecision({
      liveBestAmount: cheapest ? rateTotal(cheapest) : null,
      providerAccountId: bestProviderId != null && Number.isFinite(bestProviderId) ? bestProviderId : null,
      serviceCode: cheapest ? (String(cheapest.service_code ?? '').trim() || null) : null,
      carrierStatuses: combinedCarrierStatuses,
    });
    let persist: { persisted: boolean; reason?: string } = { persisted: false, reason: 'no orderId on request' };
    if (typeof body.orderId === 'number' && body.orderId > 0) {
      try {
        persist = await persistStrictRecalculateOutcome({
          orderId: body.orderId,
          decision: strictDecision,
          bestRate: (bestRateOut as Record<string, unknown> | null) ?? null,
          dimsL: body.dimsL ?? null,
          dimsW: body.dimsW ?? null,
          dimsH: body.dimsH ?? null,
          weightOz: body.weightOz ?? null,
          rateCount: combinedRates.length,
          fetchedAt: result.fetchedAt,
          requestFingerprint: combinedRequestKey,
          // PS-271 (Layer 4 honesty): feed the route's honest combined-universe completeness so a
          // thin-but-accepted strict best is NOT persisted as complete.
          bestRateComplete,
        });
      } catch (err) {
        // Persist is best-effort from the response's perspective: the FE falls
        // back to its own strict endpoints when persisted !== true.
        persist = { persisted: false, reason: err instanceof Error ? err.message.slice(0, 200) : 'persist failed' };
      }
    }
    strictRecalculation = {
      ...strictDecision,
      requestKey: combinedRequestKey,
      ...persist,
    };
  } else if (
    // PS-277 (slice 1): a PLAIN browse reconciles the SOT (env-gated, OFF by default). Only when a
    // fresh LIVE complete best exists for an order — never on a cached-only probe, never when the FE
    // already drove the strict-recalculate persist above. Reuses the awaiting-only persist owner
    // (refuses shipped/cancelled), so opening the browser corrects the column without a manual recalc.
    browseSotWritebackEnabled() &&
    typeof body.orderId === 'number' && body.orderId > 0 &&
    bestRateOut != null && bestRateComplete && !result.cached
  ) {
    const reconcileMatch = cheapest ? /^se-(\d+)$/i.exec(String(cheapest.carrier_id ?? '')) : null;
    const reconcileProviderId = reconcileMatch ? Number.parseInt(reconcileMatch[1]!, 10) : null;
    const reconcileDecision = planStrictRecalculateDecision({
      liveBestAmount: cheapest ? rateTotal(cheapest) : null,
      providerAccountId: reconcileProviderId != null && Number.isFinite(reconcileProviderId) ? reconcileProviderId : null,
      serviceCode: cheapest ? (String(cheapest.service_code ?? '').trim() || null) : null,
      carrierStatuses: combinedCarrierStatuses,
    });
    if (reconcileDecision.action === 'apply') {
      try {
        await persistStrictRecalculateOutcome({
          orderId: body.orderId,
          decision: reconcileDecision,
          bestRate: (bestRateOut as Record<string, unknown> | null) ?? null,
          dimsL: body.dimsL ?? null,
          dimsW: body.dimsW ?? null,
          dimsH: body.dimsH ?? null,
          weightOz: body.weightOz ?? null,
          rateCount: combinedRates.length,
          fetchedAt: result.fetchedAt,
          requestFingerprint: combinedRequestKey,
          // PS-271 (Layer 4 honesty): the reconcile path only fires when bestRateComplete is true
          // (guarded above), but thread it explicitly so the persisted truth never diverges.
          bestRateComplete,
        });
      } catch (err) {
        // Best-effort: a browse never fails on a reconcile-write error (the column just stays as-is).
        console.warn('[rates/browse] SOT reconcile write failed (best-effort):', err instanceof Error ? err.message : err);
      }
    }
  }
  const rateBrowseTiming = buildRateBrowseTimingDiagnostics({
    startedAtMs: browseStartedAt,
    completedAtMs: Date.now(),
    shipStationDurationMs,
    directCarrierDurationMs,
    carrierDiagnostics: combinedCarrierDiagnostics,
  });
  const payload = {
    ...result,
    ...(strictRecalculation ? { strictRecalculation } : {}),
    ...(manualEstimate ? { manualEstimate } : {}),
    requestKey: combinedRequestKey,
    cacheKey: combinedRequestKey,
    cacheExpiresAt: browseCacheExpiresAt,
    effectiveInsuranceProvider: result.effectiveInsuranceProvider,
    effectiveInsuredValue: result.effectiveInsuredValue,
    effectiveInsuranceSource: result.effectiveInsuranceSource,
    rateQuoteId,
    carrierEligibility,
    // PS-206: honest source reporting (the old ternary's live/live arms were a
    // no-op). ShipStation cache + LIVE direct quotes that contributed rates is
    // 'mixed'; a cached-only lookup (direct skipped as 'uncached') stays
    // 'cache'; anything that live-quoted ShipStation is 'live'.
    source: result.cached
      ? (!isCachedOnlyLookup && directRates.rates.length > 0 ? 'mixed' : 'cache')
      : 'live',
    cacheAgeMs: result.cacheAgeMs,
    rates: responseRates,
    bestRate: bestRateOut,
    secondBestRate: secondBestRateOut,
    carrierStatuses: combinedCarrierStatuses,
    carrierDiagnostics: combinedCarrierDiagnostics,
    rateBrowseTiming,
    bestRateWorkflow: buildBestRateWorkflowDto({
      currentRequestFingerprint: combinedRequestKey,
      backendRequestKey: combinedRequestKey,
      savedBestRate: bestRateMetadata,
      source: cheapest ? (result.cached ? 'cache' : 'live') : 'none',
      carrierStatuses: combinedCarrierStatuses,
    }),
    directCarrierErrors: directRates.errors,
    directCarrierMetas: directRates.metas,
    directCarrierDiagnostics,
  };
  return c.json(publicRatesResult(payload, canViewFinancials));
});

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

app.post('/cached/bulk', zValidator('json', bulkBody), async (c) => {
  const { items } = c.req.valid('json');
  const canViewFinancials = canViewRateFinancials(c);
  const automationRules = await loadShippingAutomationRules();
  // PS-203 (stage 2): one account-table load per request; each item's order
  // context is checked against the REQUIRED carrier universe below.
  const hasVisibleDirectCarriers = await loadDirectCarrierVisibilityEvaluator();
  const itemsWithKeys = await Promise.all(items.map(async (it) => {
    if (it.cacheKey) {
      return {
        item: it,
        computedCacheKey: it.cacheKey,
        effectiveInsuranceProvider: null,
        effectiveInsuredValue: null,
        effectiveInsuranceSource: null,
      };
    }
    if (it.weightOz === undefined || it.toZip === undefined) {
      return {
        item: it,
        computedCacheKey: null,
        effectiveInsuranceProvider: null,
        effectiveInsuredValue: null,
        effectiveInsuranceSource: null,
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
      it.toCountry === undefined
    ) {
      return {
        item: it,
        computedCacheKey: null,
        effectiveInsuranceProvider: null,
        effectiveInsuredValue: null,
        effectiveInsuranceSource: null,
      };
    }
    const resolved = await resolveRateInput({
      weightOz: it.weightOz,
      toZip: it.toZip,
      toCountry: it.toCountry,
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
  const results = itemsWithKeys.map(({ item: it, computedCacheKey, effectiveInsuranceProvider, effectiveInsuredValue, effectiveInsuranceSource }) => {
    const exactHit = computedCacheKey ? exactRowsByKey.get(computedCacheKey) : null;
    if (exactHit) {
      const eligibleHit = sanitizeRateCacheRowForEligibility(exactHit, {
        clientId: it.clientId ?? null,
        storeId: it.storeId ?? null,
      }, {
        // POLICY (DJ, 2026-06-04): default confirmation is 'none' (matches the
        // awaiting/modal default). Eligibility-only here; cached prices are
        // already baked, and the 'none' cache key never collides with old 'delivery' rows.
        confirmation: 'none',
        insuranceProvider: effectiveInsuranceProvider ?? (it.insuranceProvider && it.insuredValue ? it.insuranceProvider as any : 'none'),
        insuredValue: effectiveInsuredValue ?? (typeof it.insuranceValue === 'string' ? Number(it.insuranceValue) : it.insuredValue ?? it.insuranceValue ?? null),
      }, automationRules);
      const meta = cacheMetadata(eligibleHit, 'exact', {
        requiredDirectCarriersUncovered:
          hasVisibleDirectCarriers({ clientId: it.clientId ?? null, storeId: it.storeId ?? null }) &&
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
      const eligibleHit = sanitizeRateCacheRowForEligibility(roughHit, {
        clientId: it.clientId ?? null,
        storeId: it.storeId ?? null,
      }, {
        // POLICY (DJ, 2026-06-04): default confirmation is 'none' (matches the
        // awaiting/modal default). Eligibility-only here; cached prices are
        // already baked, and the 'none' cache key never collides with old 'delivery' rows.
        confirmation: 'none',
        insuranceProvider: effectiveInsuranceProvider ?? (it.insuranceProvider && it.insuredValue ? it.insuranceProvider as any : 'none'),
        insuredValue: effectiveInsuredValue ?? (typeof it.insuranceValue === 'string' ? Number(it.insuranceValue) : it.insuredValue ?? it.insuranceValue ?? null),
      }, automationRules);
      const meta = cacheMetadata(eligibleHit, 'rough', {
        requiredDirectCarriersUncovered:
          hasVisibleDirectCarriers({ clientId: it.clientId ?? null, storeId: it.storeId ?? null }) &&
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
});

app.get('/cached', zValidator('query', cachedQuery), async (c) => {
  const q = c.req.valid('query');
  const canViewFinancials = canViewRateFinancials(c);
  // weightOz + toZip are required by the schema, so the non-null
  // assertion is safe.
  const rows = await selectRateCachePublicRowsByWeightZip(q.weightOz!, q.toZip!);
  return c.json({ data: rows.map((row) => publicRateCacheRow(row, canViewFinancials)) });
});

app.get('/carriers', async (c) => {
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
});

app.get('/carriers-for-store', zValidator('query', carriersForStoreQuery), async (c) => {
  const { storeId, clientId } = c.req.valid('query');
  const canViewAccountMetadata = canViewRateAccountMetadata(c);
  const carriers = await getCarrierAccountsForRateContext({
    storeId: storeId ?? null,
    clientId: clientId ?? null,
  });
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
  return c.json({ carriers: publicCarriers, data, storeId: storeId ?? null, clientId: clientId ?? null });
});

app.post(
  '/backfill-best',
  // PS-250 (Card 5): a global best-rate backfill is an admin/internal op, not tenant-scoped.
  requireInternalPermission('scope:global'),
  zValidator(
    'json',
    z
      .object({
        clientId: z.number().int().optional(),
        limit: z.number().int().positive().max(10000).optional(),
        maxAgeHours: z.number().int().min(0).max(24 * 30).optional(),
      })
      .optional()
  ),
  async (c) => {
    const body = c.req.valid('json') ?? {};
    const job = startBackfillBestRates(body);
    return c.json({ job_id: job.jobId, status: job.status });
  }
);

app.get('/backfill-best/status/:jobId', async (c) => {
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
        failureSamples: durableJob.failureSamples,
        startedAt: Date.parse(durableJob.startedAt),
        finishedAt: durableJob.finishedAt ? Date.parse(durableJob.finishedAt) : null,
        durableJob,
      });
    }
    return c.json({ error: 'Job not found', durableJob }, 404);
  }
  return c.json(job);
});

app.get('/backfill-best/active', (c) => {
  return c.json({ job: getActiveBackfillJob() });
});

app.get('/backfill-best/latest', async (c) => {
  return c.json({
    job: getLatestBackfillJob(),
    durableJob: await getLatestBackfillJobSnapshot(),
  });
});

// PS-250 (Card 5): wiping the WHOLE rate cache is a global admin op — not reachable by a tenant-scoped caller.
app.delete('/cache', requireInternalPermission('scope:global'), async (c) => {
  const counts = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(rateCache);
  await db.delete(rateCache);
  return c.json({ deleted: counts[0]?.count ?? 0 });
});

// v2 parity: POST /rates/cache-clear-and-refetch — clears rate cache and
// kicks off a best-rate backfill. v2 exposed this at /cache/clear-and-refetch;
// mounting under /rates/ keeps the auth + route ownership clean.
app.post('/cache-clear-and-refetch', requireInternalPermission('scope:global'), async (c) => {
  const counts = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(rateCache);
  await db.delete(rateCache);
  const { startBackfillBestRates } = await import('../services/rates-backfill');
  const job = startBackfillBestRates({ maxAgeHours: 0 });
  return c.json({
    cleared: counts[0]?.count ?? 0,
    refetchStarted: true,
    jobId: job.jobId,
  });
});

export default app;
