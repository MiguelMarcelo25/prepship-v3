import { randomUUID } from 'node:crypto';
import { and, eq, gte, isNotNull, lte, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { shipments } from '../db/schema/shipments';
import { billingRefRates } from '../db/schema/billing';
import { settings } from '../db/schema/settings';
import { getRates } from './rates';

// v2 had a "RateShopper" job that fetched live ShipStation rates for every
// recent shipment's weight/zip and stored them in ref_rates, used later for
// cost-vs-charge comparison on invoices. v4 now runs the equivalent here.
//
// For each unique (weightOz, toZip, carrier) seen in the last `daysBack`
// shipments, call getRates() with a default 6×6×6 package, then persist the
// cheapest rate per carrier for that weight+zip combination.

export type RefRatesJob = {
  jobId: string;
  status: 'pending' | 'running' | 'done' | 'error';
  total: number;
  processed: number;
  inserted: number;
  failed: number;
  message: string;
  error: string | null;
  failureSamples: string[];
  startedAt: number;
  finishedAt: number | null;
};

type RefRatesOptions = {
  daysBack?: number;
  limit?: number;
};

export const REF_RATES_FETCH_STATUS_KEY = 'billing_ref_rates_fetch.last_run';

export type RefRatesJobSnapshot = {
  version: 1;
  durableKey: typeof REF_RATES_FETCH_STATUS_KEY;
  jobId: string;
  status: RefRatesJob['status'];
  active: boolean;
  total: number;
  processed: number;
  inserted: number;
  failed: number;
  message: string;
  error: string | null;
  failureSamples: string[];
  options: RefRatesOptions;
  startedAt: string;
  finishedAt: string | null;
  persistedAt: string;
};

const jobs = new Map<string, RefRatesJob>();
let activeJobId: string | null = null;
// Preserved separately so the status endpoint can still show the most
// recent job's failure samples / inserted count after it finishes.
let lastJobId: string | null = null;
const PER_FETCH_TIMEOUT_MS = 20_000;

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

// PS-139: removed dead export getRefRatesJob (0 callers; routes use getActiveRefRatesJob /
// getLatestRefRatesJobSnapshot).
export function getActiveRefRatesJob(): RefRatesJob | null {
  // Falls back to the most recent finished job if none is active, so the
  // status endpoint can surface its failure samples for debugging.
  const id = activeJobId ?? lastJobId;
  return id ? (jobs.get(id) ?? null) : null;
}

function toRefRatesSnapshot(
  job: RefRatesJob,
  opts: RefRatesOptions,
): RefRatesJobSnapshot {
  return {
    version: 1,
    durableKey: REF_RATES_FETCH_STATUS_KEY,
    jobId: job.jobId,
    status: job.status,
    active: activeJobId === job.jobId && job.status === 'running',
    total: job.total,
    processed: job.processed,
    inserted: job.inserted,
    failed: job.failed,
    message: job.message,
    error: job.error,
    failureSamples: [...job.failureSamples],
    options: {
      daysBack: opts.daysBack,
      limit: opts.limit,
    },
    startedAt: new Date(job.startedAt).toISOString(),
    finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
    persistedAt: new Date().toISOString(),
  };
}

async function persistRefRatesJobSnapshot(
  job: RefRatesJob,
  opts: RefRatesOptions,
): Promise<void> {
  try {
    const value = JSON.stringify(toRefRatesSnapshot(job, opts));
    await db
      .insert(settings)
      .values({
        key: REF_RATES_FETCH_STATUS_KEY,
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
      '[ref-rates-fetch] failed to persist durable status:',
      err instanceof Error ? err.message : err,
    );
  }
}

export async function getLatestRefRatesJobSnapshot(): Promise<RefRatesJobSnapshot | null> {
  try {
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, REF_RATES_FETCH_STATUS_KEY))
      .limit(1);
    if (!row?.value) return null;
    return JSON.parse(row.value) as RefRatesJobSnapshot;
  } catch (err) {
    console.warn(
      '[ref-rates-fetch] failed to read durable status:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export function startRefRatesFetch(opts: RefRatesOptions = {}): RefRatesJob {
  if (activeJobId && jobs.get(activeJobId)?.status === 'running') {
    return jobs.get(activeJobId)!;
  }
  const jobId = randomUUID();
  const job: RefRatesJob = {
    jobId,
    status: 'pending',
    total: 0,
    processed: 0,
    inserted: 0,
    failed: 0,
    message: 'Starting…',
    error: null,
    failureSamples: [],
    startedAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(jobId, job);
  activeJobId = jobId;
  void persistRefRatesJobSnapshot(job, opts);
  void runFetch(jobId, opts);
  return job;
}

async function runFetch(
  jobId: string,
  opts: RefRatesOptions
) {
  const job = jobs.get(jobId)!;
  job.status = 'running';
  job.message = 'Finding unique shipment weight/zip pairs...';
  await persistRefRatesJobSnapshot(job, opts);

  try {
    const daysBack = Math.max(1, Math.min(opts.daysBack ?? 30, 180));
    const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    const hardLimit = Math.max(1, Math.min(opts.limit ?? 200, 1000));

    // Distinct (weightOz, zipTo) pairs in the window.
    const pairs = await db
      .select({
        weightOz: shipments.weightOz,
        // shipments table doesn't store ship_to zip; v2 joined orders for this.
        // Use raw SQL to pull the unique pair via join.
      })
      .from(shipments)
      .where(
        and(
          isNotNull(shipments.weightOz),
          gte(shipments.shipDate, since),
          lte(shipments.shipDate, new Date())
        )
      )
      .limit(0); // placeholder — real query below

    const rawPairs = await db.execute<{
      weight_oz: number;
      zip_to: string;
    }>(sql`
      select distinct
        s.weight_oz::int as weight_oz,
        o.ship_to_postal_code as zip_to
      from shipments s
      join orders o on o.id = s.order_id
      left join clients c on c.id = o.client_id
      where s.weight_oz is not null
        and s.weight_oz > 0
        and o.ship_to_postal_code is not null
        and o.ship_to_postal_code <> ''
        and s.ship_date >= ${since.toISOString()}::timestamptz
        and s.voided = false
        and (c.id is null or c.is_test = false)
      limit ${hardLimit}
    `);

    job.total = rawPairs.length;
    job.message = `Fetching live rates for ${rawPairs.length} unique weight/zip pairs…`;
    await persistRefRatesJobSnapshot(job, opts);

    for (const pair of rawPairs) {
      if (jobs.get(jobId)?.status !== 'running') break;
      try {
        const result = await withTimeout(
          getRates({
            weightOz: pair.weight_oz,
            toZip: pair.zip_to,
            toCountry: 'US',
            dimsL: 6,
            dimsW: 6,
            dimsH: 6,
          }),
          PER_FETCH_TIMEOUT_MS,
          `ref-rates(w=${pair.weight_oz}, zip=${pair.zip_to})`
        );

        // Keep the cheapest rate per (carrier, service)
        const byKey = new Map<
          string,
          { carrier: string; service: string; cost: number }
        >();
        for (const r of result.rates) {
          const total =
            (r.shipping_amount?.amount ?? 0) + (r.other_amount?.amount ?? 0);
          const key = `${r.carrier_code}|${r.service_code}`;
          const prev = byKey.get(key);
          if (!prev || total < prev.cost) {
            byKey.set(key, {
              carrier: r.carrier_code,
              service: r.service_code,
              cost: total,
            });
          }
        }

        for (const entry of byKey.values()) {
          await db.insert(billingRefRates).values({
            weightOz: pair.weight_oz,
            zipTo: pair.zip_to,
            carrier: entry.carrier,
            service: entry.service,
            cost: entry.cost.toFixed(2),
            source: 'shipstation_live',
            fetchedAt: new Date(),
          });
          job.inserted += 1;
        }
      } catch (err) {
        job.failed += 1;
        const msg = (err as Error).message ?? 'unknown';
        if (job.failureSamples.length < 5) {
          job.failureSamples.push(
            `w=${pair.weight_oz} zip=${pair.zip_to}: ${msg.slice(0, 200)}`
          );
        }
      }
      job.processed += 1;
      if (job.processed % 10 === 0 || job.processed === job.total) {
        job.message = `${job.processed}/${job.total} — ${job.inserted} rates inserted, ${job.failed} failed`;
      }
      if (job.processed % 25 === 0 || job.processed === job.total) {
        void persistRefRatesJobSnapshot(job, opts);
      }
    }

    job.status = 'done';
    job.finishedAt = Date.now();
    job.message = `Done — ${job.inserted} rates inserted, ${job.failed} failed (of ${job.total})`;
    await persistRefRatesJobSnapshot(job, opts);
  } catch (err) {
    job.status = 'error';
    job.error = (err as Error).message;
    job.message = `Error: ${job.error}`;
    job.finishedAt = Date.now();
    await persistRefRatesJobSnapshot(job, opts);
  } finally {
    if (activeJobId === jobId) activeJobId = null;
    lastJobId = jobId;
  }
}
