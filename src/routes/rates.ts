import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { rateCache } from '../db/schema/rates';
import {
  CACHE_TTL_MS,
  getCarrierAccountsForRateContext,
  getRates,
  rateCacheKey,
  resolveRateInput,
  sanitizeRateCacheRowForEligibility,
} from '../services/rates';
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
  type BestRateWorkflowCarrierStatus,
} from '../services/shipping-workflow/best-rate-workflow-dto';

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
  const result = await getRates(
    { ...rest, confirmation: confirmation ?? signature ?? null, carrierIds: orderedIds },
    {
      forceRefresh: forceRefresh || forceLive,
      cachedOnly: Boolean(cachedOnly && !forceRefresh && !forceLive),
    }
  );
  const requestedSet = requestedCarrierIds?.length ? new Set(requestedCarrierIds) : null;
  const filtered = requestedSet
    ? result.rates.filter((r) => requestedSet.has(r.carrier_id))
    : result.rates;
  const cheapest = [...filtered].sort(
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
  const carriersWithRates = new Set(filtered.map((rate) => rate.carrier_id));
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
      rateCount: hasRates ? filtered.filter((rate) => rate.carrier_id === id).length : diagnostic?.rateCount ?? 0,
      durationMs: diagnostic?.durationMs,
      error: diagnostic?.error,
    };
  });
  const bestRateMetadata = cheapest
    ? {
        ...cheapest,
        requestFingerprint: result.cacheKey,
        cacheKey: result.cacheKey,
        cacheCreatedAt: result.fetchedAt,
        cacheExpiresAt: new Date(
          new Date(result.fetchedAt).getTime() + CACHE_TTL_MS
        ).toISOString(),
        isComplete: true,
        rateCount: filtered.length,
        matchType: result.cached ? 'cache' : 'live',
      }
    : null;
  const payload = {
    ...result,
    requestKey: result.cacheKey,
    source: result.cached ? 'cache' : filtered.length ? 'live' : 'live',
    cacheAgeMs: result.cacheAgeMs,
    rates: filtered,
    bestRate: cheapest,
    carrierStatuses,
    bestRateWorkflow: buildBestRateWorkflowDto({
      currentRequestFingerprint: result.cacheKey,
      backendRequestKey: result.cacheKey,
      savedBestRate: bestRateMetadata,
      source: cheapest ? (result.cached ? 'cache' : 'live') : 'none',
      carrierStatuses,
    }),
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
    if (it.cacheKey) return { item: it, computedCacheKey: it.cacheKey };
    if (it.weightOz === undefined || it.toZip === undefined) return { item: it, computedCacheKey: null };
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
      return { item: it, computedCacheKey: null };
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
    return { item: it, computedCacheKey: rateCacheKey(resolved) };
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
  const results = itemsWithKeys.map(({ item: it, computedCacheKey }) => {
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
        insuranceProvider: it.insuranceProvider && it.insuredValue ? it.insuranceProvider as any : 'none',
        insuredValue: typeof it.insuranceValue === 'string' ? Number(it.insuranceValue) : it.insuredValue ?? it.insuranceValue ?? null,
      }, automationRules);
      const meta = cacheMetadata(eligibleHit, 'exact');
      return {
        orderId: it.orderId,
        cacheKey: computedCacheKey,
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
        insuranceProvider: it.insuranceProvider && it.insuredValue ? it.insuranceProvider as any : 'none',
        insuredValue: typeof it.insuranceValue === 'string' ? Number(it.insuranceValue) : it.insuredValue ?? it.insuranceValue ?? null,
      }, automationRules);
      const meta = cacheMetadata(eligibleHit, 'rough');
      return {
        orderId: it.orderId,
        cacheKey: computedCacheKey,
        fallbackCacheKey: roughHit.cacheKey,
        weightOz: it.weightOz,
        toZip: it.toZip,
        hit: publicRateCacheRow(eligibleHit, canViewFinancials),
        ...meta,
      };
    }
    const meta = cacheMetadata(null, 'miss');
    return {
      orderId: it.orderId,
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
