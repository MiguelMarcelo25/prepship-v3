import { randomUUID } from 'node:crypto';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { orders, orderOverrides } from '../db/schema/orders';
import { getRates } from './rates';

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
  startedAt: number;
  finishedAt: number | null;
};

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
          sql`${orders.shipToPostalCode} is not null`,
          or(
            isNull(orderOverrides.bestRateAt),
            lt(orderOverrides.bestRateAt, staleCutoff)
          )
        )
      )
      .limit(hardLimit);

    job.total = rows.length;
    job.message = `Found ${rows.length} orders; fetching rates…`;

    for (const row of rows) {
      if (jobs.get(jobId)?.status !== 'running') break;

      const raw = (row.raw ?? {}) as Record<string, unknown> & {
        shipTo?: { country?: string; residential?: boolean };
      };
      const toCountry = raw.shipTo?.country ?? 'US';
      try {
        const result = await getRates({
          weightOz: Number(row.weightOz),
          toZip: row.shipToPostalCode!,
          toState: row.shipToState ?? undefined,
          toCity: row.shipToCity ?? undefined,
          toCountry,
          residential: raw.shipTo?.residential ?? undefined,
        });

        if (!result.bestRate) {
          job.skipped++;
        } else {
          const now = new Date();
          await db
            .insert(orderOverrides)
            .values({
              orderId: row.id,
              bestRateJson: result.bestRate as unknown,
              bestRateAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: orderOverrides.orderId,
              set: {
                bestRateJson: result.bestRate as unknown,
                bestRateAt: now,
                updatedAt: now,
              },
            });
          job.updated++;
        }
      } catch (err) {
        job.failed++;
        const msg = (err as Error).message ?? 'unknown';
        if (job.failed <= 3) {
          job.message = `Order ${row.id}: ${msg.slice(0, 120)}`;
        }
      }

      job.processed++;
      if (job.processed % 10 === 0 || job.processed === job.total) {
        job.message = `${job.processed}/${job.total} — ${job.updated} updated, ${job.skipped} skipped, ${job.failed} failed`;
      }
    }

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
