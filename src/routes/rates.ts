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
  rateCacheKey,
  resolveRateInput,
  sanitizeRateCacheRowForEligibility,
} from '../services/rates';
import { planStrictRecalculateDecision } from '../services/rates-recalculate';
import { listCarrierAccounts } from '../services/carrier-connector-orchestrator';
import {
  getActiveBackfillJob,
  getBackfillJob,
  getLatestBackfillJob,
  getLatestBackfillJobSnapshot,
  startBackfillBestRates,
} from '../services/rates-backfill';
import multiCarrierHandler from '../lib/imported-handlers/rates-multi';
import { runNodeHandler } from '../lib/node-handler';
import { hasAppPermission } from '../middleware/auth';
import { loadShippingAutomationRules } from '../services/shipping-automation';
import {
  buildBestRateWorkflowDto,
  isBestRateComplete,
  type BestRateWorkflowCarrierStatus,
} from '../services/shipping-workflow/best-rate-workflow-dto';
import {
  storeRateQuoteSnapshot,
  withSelectedRateKeys,
  selectedRateOpaqueKey,
} from '../services/shipping-workflow/rate-quote-snapshot-store';
import {
  getCarrierEligibilityMode,
  evaluateOrderCarrierEligibility,
} from '../services/shipping-workflow/carrier-eligibility-policy';
import { orderOverrides, orders } from '../db/schema/orders';

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

const RATE_MONEY_FIELD_KEYS = [
  'shipping_amount',
  'other_amount',
  'insurance_amount',
  'confirmation_amount',
  'original_amount',
  'list_amount',
  'retail_amount',
  'negotiated_amount',
  'cost',
  'labelCost',
  'rawCost',
  'amount',
] as const;

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

function redactRateMoneyFields<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => redactRateMoneyFields(entry)) as T;
  }
  if (typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const redacted: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(source)) {
    redacted[key] = RATE_MONEY_FIELD_KEYS.includes(key as never)
      ? null
      : redactRateMoneyFields(nestedValue);
  }
  return redacted as T;
}

function publicRatesResult<T extends { rates?: unknown; bestRate?: unknown }>(
  result: T,
  canViewFinancials: boolean
): T {
  if (canViewFinancials) return result;
  return {
    ...result,
    rates: redactRateMoneyFields(result.rates),
    bestRate: redactRateMoneyFields(result.bestRate),
  };
}

function publicRateCacheRow<T extends { rates?: unknown; bestRate?: unknown }>(
  row: T | null | undefined,
  canViewFinancials: boolean
): T | null {
  if (!row) return null;
  return publicRatesResult(row, canViewFinancials);
}

const rateBody = z.object({
  weightOz: z.number().positive(),
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
  const body = c.req.valid('json');
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

function rateTotal(rate: { shipping_amount?: { amount?: number }; other_amount?: { amount?: number }; confirmation_amount?: { amount?: number }; insurance_amount?: { amount?: number } }): number {
  return (
    Number(rate.shipping_amount?.amount ?? 0) +
    Number(rate.other_amount?.amount ?? 0) +
    Number(rate.confirmation_amount?.amount ?? 0) +
    Number(rate.insurance_amount?.amount ?? 0)
  );
}

function orderedCarrierIds(carrierIds: string[] | undefined, preferredCarrierId?: string): string[] | undefined {
  const unique = [...new Set((carrierIds ?? []).filter(Boolean))];
  if (!preferredCarrierId || !unique.includes(preferredCarrierId)) return unique.length ? unique : undefined;
  return [preferredCarrierId, ...unique.filter((carrierId) => carrierId !== preferredCarrierId)];
}

function dedupeBrowseRates<T extends Record<string, any>>(rates: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const rate of rates) {
    const key = [
      String(rate.carrier_id ?? rate.carrierId ?? '').toLowerCase(),
      String(rate.service_code ?? rate.serviceCode ?? rate.service ?? '').toLowerCase(),
      Number(rate.shipping_amount?.amount ?? rate.shipmentCost ?? rate.cost ?? rate.amount ?? 0).toFixed(4),
      Number(rate.other_amount?.amount ?? rate.otherCost ?? 0).toFixed(4),
      String(rate.requestFingerprint ?? rate.cacheKey ?? ''),
    ].join('|');
    if (!byKey.has(key)) byKey.set(key, rate);
  }
  return [...byKey.values()];
}

function cacheMetadata(row: typeof rateCachePublicColumns | any, matchQuality: 'exact' | 'rough' | 'miss') {
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
  const isComplete = fresh && rates.length > 0 && diagnostics.every((diagnostic: any) => (
    diagnostic?.status === 'ok' || diagnostic?.status === 'cached' || diagnostic?.status === 'empty'
  ));
  return {
    matchType: matchQuality,
    matchQuality: matchQuality === 'exact' ? 'exact' as const : 'rough' as const,
    approximate: matchQuality === 'rough' ? true : false,
    isComplete,
    rateCount: rates.length,
    cacheCreatedAt: fetchedAt.toISOString(),
    cacheExpiresAt: cacheExpiresAt.toISOString(),
    requestFingerprint: row.cacheKey,
  };
}

app.post('/browse', zValidator('json', browseBody), async (c) => {
  const body = c.req.valid('json');
  const canViewFinancials = canViewRateFinancials(c);
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
  let orderForBrowse: { sourceProvider: string | null; raw: unknown } | null = null;
  let residentialEvidence: {
    manualOverrideResidential: boolean | null;
    sourceResidential: boolean | null;
    toCompany: string | null;
    toName: string | null;
  } | null = null;
  if (body.orderId) {
    try {
      const [ord] = await db
        .select({ sourceProvider: orders.sourceProvider, raw: orders.raw, shipToName: orders.shipToName })
        .from(orders)
        .where(eq(orders.id, body.orderId))
        .limit(1);
      if (ord) {
        orderForBrowse = ord;
        const [ovr] = await db
          .select({ residential: orderOverrides.residential })
          .from(orderOverrides)
          .where(eq(orderOverrides.orderId, body.orderId))
          .limit(1);
        const rawShipTo = ((ord.raw as { shipTo?: Record<string, unknown> } | null)?.shipTo) ?? {};
        residentialEvidence = {
          manualOverrideResidential: typeof ovr?.residential === 'boolean' ? ovr.residential : null,
          sourceResidential: typeof rawShipTo.residential === 'boolean' ? rawShipTo.residential : null,
          toCompany: typeof rawShipTo.company === 'string' ? rawShipTo.company : null,
          toName: ord.shipToName ?? null,
        };
      }
    } catch (err) {
      console.warn('[rates/browse] order residential-evidence load skipped:', err instanceof Error ? err.message : err);
    }
  }
  const browseRateInput = {
    ...rest,
    confirmation: confirmation ?? signature ?? null,
    carrierIds: orderedIds,
    ...(residentialEvidence
      ? {
          // Evidence decides — the collapsed FE boolean is dropped so the classifier's
          // manual_override / shipstation_source tiers attribute correctly.
          residential: undefined,
          manualOverrideResidential: residentialEvidence.manualOverrideResidential,
          sourceResidential: residentialEvidence.sourceResidential,
          ...(residentialEvidence.toCompany != null ? { toCompany: residentialEvidence.toCompany } : {}),
          ...(residentialEvidence.toName && !rest.toName ? { toName: residentialEvidence.toName } : {}),
        }
      : {}),
  };
  const result = await getRates(
    browseRateInput,
    {
      forceRefresh: forceRefresh || forceLive,
      cachedOnly: Boolean(cachedOnly && !forceRefresh && !forceLive),
    }
  );
  // PS-106 (Per user override unlock shipped data on 2026-06-06): carrier-family
  // eligibility. ShipStation candidates are filtered separately from PS-124
  // backend-owned direct-carrier candidates. In
  // `enforce` we drop them (the operator then sees only their direct carriers); in
  // `audit_only` we keep them and log a would-block. Best-effort: any failure (no
  // order, settings outage) simply allows the rates. The label purchase boundary is
  // the authoritative block regardless.
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
  const directRates = await getDirectCarrierRatesForRateInput({
    ...rest,
    confirmation: confirmation ?? signature ?? null,
    carrierIds: requestedCarrierIds,
  });
  const combinedRates = dedupeBrowseRates([...filtered, ...directRates.rates]);
  const directCarrierIds = [...new Set(directRates.diagnostics.map((diagnostic) => diagnostic.carrierId).filter(Boolean))];
  const combinedRequestKey = directCarrierIds.length
    ? `${result.cacheKey}:direct:${directCarrierIds.sort().join(',')}`
    : result.cacheKey;
  const cheapest = [...combinedRates].sort(
    (a, b) => rateTotal(a) - rateTotal(b)
  )[0] ?? null;
  const accounts = await getCarrierAccountsForRateContext({
    storeId: rest.storeId ?? null,
    clientId: rest.clientId ?? null,
  }).catch(() => []);
  const accountNameByCarrierId = new Map(
    accounts.map((account) => [
      account.carrier_id,
      account.friendly_name ?? account.nickname ?? account.carrier_code ?? account.carrier_id,
    ])
  );
  const statusCarrierIds = requestedCarrierIds?.length
    ? requestedCarrierIds
    : accounts.map((account) => account.carrier_id);
  const carriersWithRates = new Set(combinedRates.map((rate) => rate.carrier_id));
  const diagnosticsByCarrierId = new Map(
    (result.carrierDiagnostics ?? []).map((diagnostic) => [diagnostic.carrierId, diagnostic])
  );
  const statusWhenFound = result.cached ? 'cached' : 'live';
  const isCachedOnlyLookup = Boolean(cachedOnly && !forceRefresh && !forceLive);
  const missingStatus = isCachedOnlyLookup ? 'loading' : 'unavailable';
  const carrierStatuses: BestRateWorkflowCarrierStatus[] = statusCarrierIds.map((id) => {
    const diagnostic = diagnosticsByCarrierId.get(id);
    const hasRates = carriersWithRates.has(id);
    const status: BestRateWorkflowCarrierStatus['status'] = hasRates
      ? statusWhenFound
      : diagnostic?.status === 'failed'
        ? 'error'
        : diagnostic?.status === 'empty'
          ? 'unavailable'
          : diagnostic?.status === 'loading'
            ? 'loading'
            : missingStatus;
    return {
      carrierId: id,
      carrierName: accountNameByCarrierId.get(id) ?? diagnostic?.nickname ?? id,
      carrierCode: diagnostic?.carrierCode,
      nickname: diagnostic?.nickname,
      status,
      rateCount: hasRates ? combinedRates.filter((rate) => rate.carrier_id === id).length : diagnostic?.rateCount ?? 0,
      durationMs: diagnostic?.durationMs,
      error: diagnostic?.error,
    };
  });
  const directCarrierStatuses: BestRateWorkflowCarrierStatus[] = directRates.diagnostics.map((diagnostic) => ({
    carrierId: diagnostic.carrierId,
    carrierName: diagnostic.nickname ?? diagnostic.carrierId,
    carrierCode: diagnostic.carrierCode,
    nickname: diagnostic.nickname,
    status:
      diagnostic.status === 'ok'
        ? 'live'
        : diagnostic.status === 'failed'
          ? 'error'
          : diagnostic.status === 'empty'
            ? 'unavailable'
            : diagnostic.status === 'cached'
              ? 'cached'
              : 'loading',
    rateCount: diagnostic.rateCount,
    durationMs: diagnostic.durationMs,
    error: diagnostic.error,
  }));
  const combinedCarrierStatuses = [...carrierStatuses, ...directCarrierStatuses];
  const directCarrierDiagnostics = directRates.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    source: 'direct',
  }));
  const combinedCarrierDiagnostics = [
    ...(result.carrierDiagnostics ?? []).map((diagnostic) => ({
      ...diagnostic,
      source: 'shipstation',
    })),
    ...directCarrierDiagnostics,
  ];
  // PS-111: completeness is BACKEND-OWNED and derived from carrier diagnostics — a
  // best rate is complete only when every eligible carrier reached a terminal result
  // (none loading, none errored). Never hardcode true: a rate found while a carrier is
  // still loading or failed is PARTIAL, and the workflow DTO + frontend must see that.
  const bestRateComplete = isBestRateComplete(combinedCarrierStatuses);
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
  const ratesWithKeys = withSelectedRateKeys(combinedRates);
  const rateQuoteId = await storeRateQuoteSnapshot({
    cacheKey: combinedRequestKey,
    rates: ratesWithKeys,
    fetchedAt: result.fetchedAt,
  });
  // Stamp the opaque rateQuoteId onto each rate + the best rate so the frontend can
  // pass back { rateQuoteId, selectedRateKey } at label/queue time instead of full
  // proof internals (selectedRateProof remains as the compatibility fallback).
  const responseRates = rateQuoteId ? ratesWithKeys.map((rate) => ({ ...rate, rateQuoteId })) : ratesWithKeys;
  // PS-183: the cache-expiry TTL is BACKEND-owned (CACHE_TTL_MS over the quote's
  // fetchedAt — the same expiry the rate cache itself enforces). Stamped on the
  // response + best rate so the FE never mints its own "now + 6h" freshness.
  const browseCacheExpiresAt = new Date(
    new Date(result.fetchedAt).getTime() + CACHE_TTL_MS
  ).toISOString();
  const bestRateOut = cheapest
    ? {
        ...cheapest,
        selectedRateKey: selectedRateOpaqueKey(cheapest),
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
        ...(rateQuoteId ? { rateQuoteId } : {}),
      }
    : cheapest;
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
        rates: canViewFinancials ? manualFiltered : (redactRateMoneyFields(manualFiltered) as unknown[]),
        fetchedAt: manual.fetchedAt,
        cached: manual.cached,
      };
    } catch (err) {
      console.warn('[rates/browse] manual-estimate baseline failed (reference only):', err instanceof Error ? err.message : err);
    }
  }
  // PS-175 (Phase 3 part 1): the STRICT recalculation decision is BACKEND-owned —
  // computed from the SAME combined carrier statuses + best rate this response
  // returns (byte-compatible port of the FE rule, which becomes a deploy-skew
  // fallback until Phase 6 deletes it). Decision only; persistence stays with the
  // existing strict endpoints until Phase 3 part 2.
  let strictRecalculation: Record<string, unknown> | null = null;
  if (body.strictRecalculate === true) {
    const bestProviderMatch = cheapest ? /^se-(\d+)$/i.exec(String(cheapest.carrier_id ?? '')) : null;
    const bestProviderId = bestProviderMatch ? Number.parseInt(bestProviderMatch[1]!, 10) : null;
    strictRecalculation = {
      ...planStrictRecalculateDecision({
        liveBestAmount: cheapest ? rateTotal(cheapest) : null,
        providerAccountId: bestProviderId != null && Number.isFinite(bestProviderId) ? bestProviderId : null,
        serviceCode: cheapest ? (String(cheapest.service_code ?? '').trim() || null) : null,
        carrierStatuses: combinedCarrierStatuses,
      }),
      requestKey: combinedRequestKey,
    };
  }
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
    source: result.cached ? 'cache' : filtered.length ? 'live' : 'live',
    cacheAgeMs: result.cacheAgeMs,
    rates: responseRates,
    bestRate: bestRateOut,
    carrierStatuses: combinedCarrierStatuses,
    carrierDiagnostics: combinedCarrierDiagnostics,
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
      const meta = cacheMetadata(eligibleHit, 'exact');
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
      const meta = cacheMetadata(eligibleHit, 'rough');
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

app.get('/backfill-best/status/:jobId', (c) => {
  const job = getBackfillJob(c.req.param('jobId'));
  if (!job) return c.json({ error: 'Job not found' }, 404);
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

app.delete('/cache', async (c) => {
  const counts = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(rateCache);
  await db.delete(rateCache);
  return c.json({ deleted: counts[0]?.count ?? 0 });
});

// v2 parity: POST /rates/cache-clear-and-refetch — clears rate cache and
// kicks off a best-rate backfill. v2 exposed this at /cache/clear-and-refetch;
// mounting under /rates/ keeps the auth + route ownership clean.
app.post('/cache-clear-and-refetch', async (c) => {
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
