import { randomUUID } from 'node:crypto';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { orders, orderOverrides } from '../db/schema/orders';
import { packages } from '../db/schema/packages';
import { getRates } from './rates';
import type { Rate } from '../lib/shipstation';

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

export function getBackfillJob(jobId: string): BackfillJob | null {
  return jobs.get(jobId) ?? null;
}

export function getActiveBackfillJob(): BackfillJob | null {
  return activeJobId ? (jobs.get(activeJobId) ?? null) : null;
}

export function startBackfillBestRates(opts: {
  clientId?: number;
  limit?: number;
  maxAgeHours?: number;
}): BackfillJob {
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
  void runBackfill(jobId, opts);
  return job;
}

async function runBackfill(
  jobId: string,
  opts: { clientId?: number; limit?: number; maxAgeHours?: number }
) {
  const job = jobs.get(jobId)!;
  job.status = 'running';
  job.message = 'Querying orders…';

  try {
    const maxAgeHours = opts.maxAgeHours ?? 24;
    const staleCutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
    const hardLimit = Math.max(1, Math.min(opts.limit ?? 5000, 10000));

    const rows = await db
      .select({
        id: orders.id,
        weightOz: orders.weightOz,
        shipToPostalCode: orders.shipToPostalCode,
        shipToState: orders.shipToState,
        shipToCity: orders.shipToCity,
        serviceCode: orders.serviceCode,
        raw: orders.raw,
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
          sql`${orders.weightOz} is not null and ${orders.weightOz} > 0`,
          sql`${orders.shipToPostalCode} is not null and ${orders.shipToPostalCode} <> ''`,
          or(
            isNull(orderOverrides.bestRateAt),
            lt(orderOverrides.bestRateAt, staleCutoff)
          )
        )
      )
      .limit(hardLimit);

    job.total = rows.length;
    job.message = `Found ${rows.length} orders; fetching rates…`;

    // Resolve a default L/W/H once per job — every carrier requires dims.
    // Prefer the packages row marked default; otherwise a safe 6×6×6.
    const [defaultPkg] = await db
      .select({
        length: packages.length,
        width: packages.width,
        height: packages.height,
      })
      .from(packages)
      .where(eq(packages.isDefault, true))
      .limit(1);
    const fallbackDims = {
      length: defaultPkg?.length && defaultPkg.length > 0 ? defaultPkg.length : 6,
      width: defaultPkg?.width && defaultPkg.width > 0 ? defaultPkg.width : 6,
      height: defaultPkg?.height && defaultPkg.height > 0 ? defaultPkg.height : 6,
    };

    const CONCURRENCY = 16;
    const processOne = async (row: (typeof rows)[number]) => {
      if (jobs.get(jobId)?.status !== 'running') return;

      const raw = (row.raw ?? {}) as Record<string, unknown> & {
        shipTo?: { country?: string; residential?: boolean };
        dimensions?: { length?: number; width?: number; height?: number; units?: string };
      };
      const toCountry = raw.shipTo?.country ?? 'US';
      // ShipStation dimensions are almost always in inches; if any are 0/missing,
      // use the default-package fallback for that axis.
      const rawDims = raw.dimensions ?? {};
      const dimsL = rawDims.length && rawDims.length > 0 ? rawDims.length : fallbackDims.length;
      const dimsW = rawDims.width && rawDims.width > 0 ? rawDims.width : fallbackDims.width;
      const dimsH = rawDims.height && rawDims.height > 0 ? rawDims.height : fallbackDims.height;
      try {
        const result = await withTimeout(
          getRates({
            weightOz: Number(row.weightOz),
            toZip: row.shipToPostalCode!,
            toState: row.shipToState ?? undefined,
            toCity: row.shipToCity ?? undefined,
            toCountry,
            residential: raw.shipTo?.residential ?? undefined,
            dimsL,
            dimsW,
            dimsH,
          }),
          PER_ORDER_TIMEOUT_MS,
          `getRates(order=${row.id})`
        );

        const tier = classifyTier(row.serviceCode);
        const best = pickBestForTier(result.rates, tier);

        if (!best) {
          job.skipped++;
        } else {
          const now = new Date();
          await db
            .insert(orderOverrides)
            .values({
              orderId: row.id,
              bestRateJson: best as unknown,
              bestRateAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: orderOverrides.orderId,
              set: {
                bestRateJson: best as unknown,
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
  } catch (err) {
    job.status = 'error';
    job.error = (err as Error).message;
    job.message = `Error: ${job.error}`;
    job.finishedAt = Date.now();
  } finally {
    if (activeJobId === jobId) activeJobId = null;
  }
}
