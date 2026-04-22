import { randomUUID } from 'node:crypto';
import { and, eq, gte, isNotNull, lte, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { shipments } from '../db/schema/shipments';
import { billingRefRates } from '../db/schema/billing';
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

const jobs = new Map<string, RefRatesJob>();
let activeJobId: string | null = null;
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

export function getRefRatesJob(jobId: string): RefRatesJob | null {
  return jobs.get(jobId) ?? null;
}

export function getActiveRefRatesJob(): RefRatesJob | null {
  return activeJobId ? (jobs.get(activeJobId) ?? null) : null;
}

export function startRefRatesFetch(opts: {
  daysBack?: number;
  limit?: number;
} = {}): RefRatesJob {
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
  void runFetch(jobId, opts);
  return job;
}

async function runFetch(
  jobId: string,
  opts: { daysBack?: number; limit?: number }
) {
  const job = jobs.get(jobId)!;
  job.status = 'running';
  job.message = 'Finding unique shipment weight/zip pairs…';

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
      where s.weight_oz is not null
        and s.weight_oz > 0
        and o.ship_to_postal_code is not null
        and o.ship_to_postal_code <> ''
        and s.ship_date >= ${since.toISOString()}::timestamptz
        and s.voided = false
      limit ${hardLimit}
    `);

    job.total = rawPairs.length;
    job.message = `Fetching live rates for ${rawPairs.length} unique weight/zip pairs…`;

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
    }

    job.status = 'done';
    job.finishedAt = Date.now();
    job.message = `Done — ${job.inserted} rates inserted, ${job.failed} failed (of ${job.total})`;
  } catch (err) {
    job.status = 'error';
    job.error = (err as Error).message;
    job.message = `Error: ${job.error}`;
    job.finishedAt = Date.now();
  } finally {
    if (activeJobId === jobId) activeJobId = null;
  }
}
