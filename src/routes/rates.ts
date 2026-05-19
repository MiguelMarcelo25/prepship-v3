import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { rateCache } from '../db/schema/rates';
import { getCarrierAccountsForRateContext, getRates, rateCacheKey } from '../services/rates';
import {
  getActiveBackfillJob,
  getBackfillJob,
  getLatestBackfillJob,
  getLatestBackfillJobSnapshot,
  startBackfillBestRates,
} from '../services/rates-backfill';
import { ssRequest } from '../lib/shipstation';
import type { CarriersResponse } from '../lib/shipstation/types';
import multiCarrierHandler from '../lib/imported-handlers/rates-multi';
import { runNodeHandler } from '../lib/node-handler';

const app = new Hono();

app.all('/multi', runNodeHandler(multiCarrierHandler));

const rateCachePublicColumns = {
  cacheKey: rateCache.cacheKey,
  weightOz: rateCache.weightOz,
  toZip: rateCache.toZip,
  rates: rateCache.rates,
  bestRate: rateCache.bestRate,
  weightVersion: rateCache.weightVersion,
  fetchedAt: rateCache.fetchedAt,
};

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
  forceRefresh: z.boolean().optional(),
});

app.post('/', zValidator('json', rateBody), async (c) => {
  const body = c.req.valid('json');
  const { forceRefresh, signature, confirmation, ...input } = body;
  const result = await getRates(
    { ...input, confirmation: confirmation ?? signature ?? null },
    { forceRefresh }
  );
  return c.json(result);
});

const browseBody = rateBody.extend({
  carrierId: z.string().min(1).optional(),
  preferredCarrierId: z.string().min(1).optional(),
  forceLive: z.boolean().optional(),
  cachedOnly: z.boolean().optional(),
});

function rateTotal(rate: { shipping_amount?: { amount?: number }; other_amount?: { amount?: number }; confirmation_amount?: { amount?: number } }): number {
  return (
    Number(rate.shipping_amount?.amount ?? 0) +
    Number(rate.other_amount?.amount ?? 0) +
    Number(rate.confirmation_amount?.amount ?? 0)
  );
}

function orderedCarrierIds(carrierIds: string[] | undefined, preferredCarrierId?: string): string[] | undefined {
  const unique = [...new Set((carrierIds ?? []).filter(Boolean))];
  if (!preferredCarrierId || !unique.includes(preferredCarrierId)) return unique.length ? unique : undefined;
  return [preferredCarrierId, ...unique.filter((carrierId) => carrierId !== preferredCarrierId)];
}

app.post('/browse', zValidator('json', browseBody), async (c) => {
  const body = c.req.valid('json');
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
  return c.json({
    ...result,
    requestKey: result.cacheKey,
    source: result.cached ? 'cache' : filtered.length ? 'live' : 'live',
    cacheAgeMs: result.cacheAgeMs,
    rates: filtered,
    bestRate: cheapest,
    carrierStatuses: statusCarrierIds.map((id) => {
      const diagnostic = diagnosticsByCarrierId.get(id);
      const hasRates = carriersWithRates.has(id);
      const status = hasRates
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
    }),
  });
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
    storeId: z.number().int().nullable().optional(),
    clientId: z.number().int().nullable().optional(),
    sourceClientId: z.number().int().nullable().optional(),
    confirmation: z.string().nullable().optional(),
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
  const exactKeys = [
    ...new Set(
      items
        .map((it) => {
          if (it.cacheKey) return it.cacheKey;
          if (it.weightOz === undefined || it.toZip === undefined) return null;
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
            it.toCountry === undefined
          ) {
            return null;
          }
          return rateCacheKey({
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
          });
        })
        .filter((key): key is string => Boolean(key)),
    ),
  ];
  const pairs = items
    .filter((it) => it.weightOz !== undefined && it.toZip !== undefined)
    .map((it) => ({
      weightOz: it.weightOz!,
      toZip: it.toZip!.toUpperCase(),
    }));

  const exactRows = exactKeys.length
    ? await db
        .select(rateCachePublicColumns)
        .from(rateCache)
        .where(or(...exactKeys.map((key) => eq(rateCache.cacheKey, key))))
        .orderBy(sql`${rateCache.fetchedAt} desc`)
    : [];
  const roughRows = pairs.length
    ? await db
        .select(rateCachePublicColumns)
        .from(rateCache)
        .where(
          or(
            ...pairs.map((pair) =>
              and(
                eq(rateCache.weightOz, pair.weightOz),
                eq(rateCache.toZip, pair.toZip)
              )
            )
          )
        )
        .orderBy(sql`${rateCache.fetchedAt} desc`)
    : [];
  const exactRowsByKey = new Map<string, typeof exactRows[number]>();
  for (const row of exactRows) {
    if (!exactRowsByKey.has(row.cacheKey)) exactRowsByKey.set(row.cacheKey, row);
  }
  const rowsByPair = new Map<string, typeof roughRows[number]>();
  for (const row of roughRows) {
    const key = `${row.weightOz}|${row.toZip}`;
    if (!rowsByPair.has(key)) rowsByPair.set(key, row);
  }
  const results = items.map((it) => {
    const computedCacheKey =
      it.cacheKey ??
      (it.weightOz !== undefined && it.toZip !== undefined
        ? rateCacheKey({
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
          })
        : null);
    const exactHit = computedCacheKey ? exactRowsByKey.get(computedCacheKey) : null;
    if (exactHit) {
      return {
        cacheKey: computedCacheKey,
        weightOz: it.weightOz,
        toZip: it.toZip,
        hit: exactHit,
        matchQuality: 'exact' as const,
        approximate: false,
      };
    }
    const toZip = it.toZip?.toUpperCase();
    return {
      weightOz: it.weightOz,
      toZip: it.toZip,
      cacheKey: computedCacheKey,
      hit:
        it.weightOz !== undefined && toZip
          ? rowsByPair.get(`${it.weightOz}|${toZip}`) ?? null
          : null,
      matchQuality: 'rough' as const,
      approximate: true,
    };
  });
  return c.json({ data: results });
});

app.get('/cached', zValidator('query', cachedQuery), async (c) => {
  const q = c.req.valid('query');
  // weightOz + toZip are required by the schema, so the non-null
  // assertion is safe.
  const rows = await db
    .select(rateCachePublicColumns)
    .from(rateCache)
    .where(
      and(
        eq(rateCache.weightOz, q.weightOz!),
        eq(rateCache.toZip, q.toZip!.toUpperCase())
      )
    )
    .limit(25);
  return c.json({ data: rows });
});

app.get('/carriers', async (c) => {
  const data = await ssRequest<CarriersResponse>('/v2/carriers', {
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
  const carriers = await getCarrierAccountsForRateContext({
    storeId: storeId ?? null,
    clientId: clientId ?? null,
  });
  const data = carriers.map((ca) => ({
    carrierId: ca.carrier_id,
    carrierCode: ca.carrier_code,
    nickname: ca.nickname ?? ca.friendly_name ?? null,
    friendlyName: ca.friendly_name ?? ca.nickname ?? null,
    sourceClientId: ca.source_client_id,
    sourceClientName: ca.source_client_name,
    carrier_id: ca.carrier_id,
    carrier_code: ca.carrier_code,
    friendly_name: ca.friendly_name ?? ca.nickname ?? null,
    source_client_id: ca.source_client_id,
    source_client_name: ca.source_client_name,
  }));
  return c.json({ carriers, data, storeId: storeId ?? null, clientId: clientId ?? null });
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
