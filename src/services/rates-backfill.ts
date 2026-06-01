import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { orders, orderOverrides } from '../db/schema/orders';
import { settings } from '../db/schema/settings';
import { CACHE_TTL_MS, getRates } from './rates';
import type { Rate } from '../lib/shipstation';
import { EXCLUDED_STORE_IDS } from '../config/prepship';

type ServiceTier = 'overnight' | 'two_day' | 'standard';

function classifyTier(code?: string | null): ServiceTier {
  if (!code) return 'standard';
  const c = code.toLowerCase();
  if (
    c.includes('next_day') ||
    c.includes('overnight') ||
    c.includes('priority_mail_express')
  ) {
    return 'overnight';
  }
  if (
    c.includes('2day') ||
    c.includes('2nd_day') ||
    c.includes('second_day')
  ) {
    return 'two_day';
  }
  return 'standard';
}

function pickBestForTier(rates: Rate[], tier: ServiceTier): Rate | null {
  const pool = tier === 'standard'
    ? rates
    : rates.filter((r) => classifyTier(r.service_code) === tier);
  // Fall back to all rates if no match in requested tier (customer gets
  // shipped something — cheapest-available beats nothing).
  const candidates = pool.length ? pool : rates;
  if (!candidates.length) return null;
  return [...candidates].sort(
    (a, b) => a.shipping_amount.amount - b.shipping_amount.amount
  )[0]!;
}

function toPositiveNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getBackfillOrderDims(row: {
  rateDimsL: number | null;
  rateDimsW: number | null;
  rateDimsH: number | null;
  raw: Record<string, unknown> | null;
}): { length: number; width: number; height: number } | null {
  const raw = row.raw ?? {};
  const rawDims = raw.dimensions && typeof raw.dimensions === 'object'
    ? raw.dimensions as Record<string, unknown>
    : {};
  const length = toPositiveNumber(row.rateDimsL) ?? toPositiveNumber(rawDims.length);
  const width = toPositiveNumber(row.rateDimsW) ?? toPositiveNumber(rawDims.width);
  const height = toPositiveNumber(row.rateDimsH) ?? toPositiveNumber(rawDims.height);
  if (length == null || width == null || height == null) return null;
  return { length, width, height };
}

export type BackfillJob = {
  jobId: string;
  status: 'pending' | 'running' | 'done' | 'error';
  total: number;
  processed: number;
  updated: number;
  skipped: number;
  failed: number;
  message: string;
  error: string | null;
  failureSamples: string[];
  startedAt: number;
  finishedAt: number | null;
};

type BackfillOptions = {
  clientId?: number;
  limit?: number;
  maxAgeHours?: number;
};

export const RATE_BACKFILL_STATUS_KEY = 'rate_backfill_best_rates.last_run';

export type BackfillJobSnapshot = {
  version: 1;
  durableKey: typeof RATE_BACKFILL_STATUS_KEY;
  jobId: string;
  status: BackfillJob['status'];
  active: boolean;
  total: number;
  processed: number;
  updated: number;
  skipped: number;
  failed: number;
  message: string;
  error: string | null;
  failureSamples: string[];
  options: BackfillOptions;
  startedAt: string;
  finishedAt: string | null;
  persistedAt: string;
};

const PER_ORDER_TIMEOUT_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      }
    );
  });
}

const jobs = new Map<string, BackfillJob>();
let activeJobId: string | null = null;
let latestJobId: string | null = null;

export function getBackfillJob(jobId: string): BackfillJob | null {
  return jobs.get(jobId) ?? null;
}

export function getActiveBackfillJob(): BackfillJob | null {
  return activeJobId ? (jobs.get(activeJobId) ?? null) : null;
}

export function getLatestBackfillJob(): BackfillJob | null {
  return latestJobId ? (jobs.get(latestJobId) ?? null) : null;
}

function toBackfillSnapshot(
  job: BackfillJob,
  opts: BackfillOptions,
): BackfillJobSnapshot {
  return {
    version: 1,
    durableKey: RATE_BACKFILL_STATUS_KEY,
    jobId: job.jobId,
    status: job.status,
    active: activeJobId === job.jobId && job.status === 'running',
    total: job.total,
    processed: job.processed,
    updated: job.updated,
    skipped: job.skipped,
    failed: job.failed,
    message: job.message,
    error: job.error,
    failureSamples: [...job.failureSamples],
    options: {
      clientId: opts.clientId,
      limit: opts.limit,
      maxAgeHours: opts.maxAgeHours,
    },
    startedAt: new Date(job.startedAt).toISOString(),
    finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
    persistedAt: new Date().toISOString(),
  };
}

async function persistBackfillJobSnapshot(
  job: BackfillJob,
  opts: BackfillOptions,
): Promise<void> {
  try {
    const value = JSON.stringify(toBackfillSnapshot(job, opts));
    await db
      .insert(settings)
      .values({
        key: RATE_BACKFILL_STATUS_KEY,
        value,
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: {
          value,
        },
      });
  } catch (err) {
    console.warn(
      '[rates-backfill] failed to persist durable status:',
      err instanceof Error ? err.message : err,
    );
  }
}

export async function getLatestBackfillJobSnapshot(): Promise<BackfillJobSnapshot | null> {
  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, RATE_BACKFILL_STATUS_KEY))
      .limit(1);
    if (!row?.value) return null;
    return JSON.parse(row.value) as BackfillJobSnapshot;
  } catch (err) {
    console.warn(
      '[rates-backfill] failed to read durable status:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export function startBackfillBestRates(opts: BackfillOptions): BackfillJob {
  if (activeJobId && jobs.get(activeJobId)?.status === 'running') {
    return jobs.get(activeJobId)!;
  }
  const jobId = randomUUID();
  const job: BackfillJob = {
    jobId,
    status: 'pending',
    total: 0,
    processed: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    message: 'Starting…',
    error: null,
    failureSamples: [],
    startedAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(jobId, job);
  activeJobId = jobId;
  latestJobId = jobId;
  void persistBackfillJobSnapshot(job, opts);
  void runBackfill(jobId, opts);
  return job;
}

async function runBackfill(
  jobId: string,
  opts: BackfillOptions
) {
  const job = jobs.get(jobId)!;
  job.status = 'running';
  job.message = 'Querying orders...';
  await persistBackfillJobSnapshot(job, opts);

  try {
    const staleCutoff =
      opts.maxAgeHours !== undefined
        ? new Date(Date.now() - opts.maxAgeHours * 60 * 60 * 1000)
        : null;
    const hardLimit = Math.max(1, Math.min(opts.limit ?? 5000, 10000));
    const needsRatePredicate = staleCutoff
      ? or(isNull(orderOverrides.bestRateAt), lt(orderOverrides.bestRateAt, staleCutoff))
      : isNull(orderOverrides.bestRateAt);

    const rows = await db
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        clientId: orders.clientId,
        storeId: orders.storeId,
        weightOz: orders.weightOz,
        shipToPostalCode: orders.shipToPostalCode,
        shipToState: orders.shipToState,
        shipToCity: orders.shipToCity,
        serviceCode: orders.serviceCode,
        raw: orders.raw,
        rateDimsL: orderOverrides.rateDimsL,
        rateDimsW: orderOverrides.rateDimsW,
        rateDimsH: orderOverrides.rateDimsH,
        overridesBestRateAt: orderOverrides.bestRateAt,
      })
      .from(orders)
      .leftJoin(orderOverrides, eq(orderOverrides.orderId, orders.id))
      .where(
        and(
          eq(orders.orderStatus, 'awaiting_shipment'),
          opts.clientId !== undefined
            ? eq(orders.clientId, opts.clientId)
            : undefined,
          notInArray(orders.storeId, [...EXCLUDED_STORE_IDS]),
          sql`${orders.weightOz} is not null and ${orders.weightOz} > 0`,
          sql`${orders.shipToPostalCode} is not null and ${orders.shipToPostalCode} <> ''`,
          needsRatePredicate,
          // Skip test-client orders — no real ShipStation rate calls for sandbox data.
          sql`not exists (select 1 from clients c where c.id = ${orders.clientId} and c.is_test = true)`
        )
      )
      .orderBy(desc(orders.orderDate))
      .limit(hardLimit);

    job.total = rows.length;
    job.message = `Found ${rows.length} orders; fetching rates…`;
    await persistBackfillJobSnapshot(job, opts);

    const CONCURRENCY = 4;
    const processOne = async (row: (typeof rows)[number]) => {
      if (jobs.get(jobId)?.status !== 'running') return;

      const raw = (row.raw ?? {}) as Record<string, unknown> & {
        shipTo?: { country?: string; residential?: boolean };
        dimensions?: { length?: number; width?: number; height?: number; units?: string };
      };
      const toCountry = raw.shipTo?.country ?? 'US';
      const dims = getBackfillOrderDims(row);
      if (!dims) {
        job.skipped++;
        if (job.failureSamples.length < 5) {
          job.failureSamples.push(
            `order ${row.id} (${row.orderNumber}, w=${row.weightOz}, ${row.shipToCity}, ${row.shipToState} ${row.shipToPostalCode}): missing real dimensions`
          );
        }
        job.processed++;
        if (job.processed % 10 === 0 || job.processed === job.total) {
          job.message = `${job.processed}/${job.total} — ${job.updated} updated, ${job.skipped} skipped, ${job.failed} failed`;
        }
        if (job.processed % 50 === 0 || job.processed === job.total) {
          void persistBackfillJobSnapshot(job, opts);
        }
        return;
      }
      const dimsLabel = `${dims.length}x${dims.width}x${dims.height}`;
      try {
        const result = await withTimeout(
          getRates({
            weightOz: Number(row.weightOz),
            toZip: row.shipToPostalCode!,
            toState: row.shipToState ?? undefined,
            toCity: row.shipToCity ?? undefined,
            toCountry,
            residential: raw.shipTo?.residential ?? undefined,
            dimsL: dims.length,
            dimsW: dims.width,
            dimsH: dims.height,
            storeId: row.storeId,
            clientId: row.clientId,
          }),
          PER_ORDER_TIMEOUT_MS,
          `getRates(order=${row.id})`
        );

          const best = result.bestRate;

          if (!best) {
          job.skipped++;
          if (job.failureSamples.length < 5) {
            job.failureSamples.push(
              `order ${row.id} (${row.orderNumber}, w=${row.weightOz}, ${row.shipToCity}, ${row.shipToState} ${row.shipToPostalCode}): no rates returned`
            );
          }
        } else {
          const now = new Date();
          const bestWithMetadata = {
            ...best,
            requestFingerprint: result.cacheKey,
            cacheKey: result.cacheKey,
            cacheCreatedAt: result.fetchedAt,
            cacheExpiresAt: new Date(new Date(result.fetchedAt).getTime() + CACHE_TTL_MS).toISOString(),
            isComplete: result.carrierDiagnostics.every((diagnostic) => diagnostic.status !== 'failed' && diagnostic.status !== 'loading'),
            rateCount: result.rates.length,
            matchType: result.cached ? 'exact' : 'live',
          };
          await db
            .insert(orderOverrides)
            .values({
              orderId: row.id,
              bestRateJson: bestWithMetadata as unknown,
              bestRateDims: dimsLabel,
              bestRateAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: orderOverrides.orderId,
              set: {
                bestRateJson: bestWithMetadata as unknown,
                bestRateDims: dimsLabel,
                bestRateAt: now,
                updatedAt: now,
              },
            });
          job.updated++;
        }
      } catch (err) {
        job.failed++;
        const msg = (err as Error).message ?? 'unknown';
        if (job.failureSamples.length < 5) {
          job.failureSamples.push(
            `order ${row.id} (w=${row.weightOz}, ${row.shipToCity}, ${row.shipToState} ${row.shipToPostalCode}): ${msg.slice(0, 1500)}`
          );
        }
      }

      job.processed++;
      if (job.processed % 10 === 0 || job.processed === job.total) {
        job.message = `${job.processed}/${job.total} — ${job.updated} updated, ${job.skipped} skipped, ${job.failed} failed`;
      }
      if (job.processed % 50 === 0 || job.processed === job.total) {
        void persistBackfillJobSnapshot(job, opts);
      }
    };

    let idx = 0;
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (idx < rows.length) {
        const i = idx++;
        if (jobs.get(jobId)?.status !== 'running') break;
        await processOne(rows[i]!);
      }
    });
    await Promise.all(workers);

    job.status = 'done';
    job.finishedAt = Date.now();
    job.message = `Done — ${job.updated} updated, ${job.skipped} skipped, ${job.failed} failed (of ${job.total})`;
    await persistBackfillJobSnapshot(job, opts);
  } catch (err) {
    job.status = 'error';
    job.error = (err as Error).message;
    job.message = `Error: ${job.error}`;
    job.finishedAt = Date.now();
    await persistBackfillJobSnapshot(job, opts);
  } finally {
    if (activeJobId === jobId) activeJobId = null;
  }
}
