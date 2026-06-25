/**
 * reap-stale-rate-jobs.ts — durable, age-based reaper for order_rate_jobs (PS-120 leak fix).
 *
 * clearOrderRateJob() deletes per-order, but is only ever called from the in-memory backfill that
 * stamped the row — so a worker crash / Render redeploy / OOM between the up-front `pending` stamp
 * and the clear orphans every in-flight stamp forever (observed: 88 leaked pending/rating rows,
 * oldest 13 days). This reaper makes leak-collection a property of the TABLE + CLOCK: it deletes any
 * job row not touched within maxAgeMs, surviving process death uniformly. Runs on a scheduler tick
 * and once at boot (see sync-scheduler wiring).
 *
 * SCOPE: order_rate_jobs ONLY (the awaiting rate-workflow table). It never reads or writes `orders`
 * or `shipments`, so it sits entirely outside the shipped/cancelled lockdown.
 */
import { lt } from 'drizzle-orm';
import { db } from '../../db/client';
import { orderRateJobs } from '../../db/schema/order-rate-jobs';
import { ensureOrderRateJobsSchema } from './order-rate-job-status';

// Comfortably above the live per-order rate budget (LIVE_PER_ORDER_TIMEOUT_MS 90s + 1 retry +
// limiter queue wait) so a genuinely in-flight stamp is never reaped early. Env-tunable; floored
// at 5 min. The /orders reader's 6-min display filter (RATE_JOB_STALE_MS) stays as defense-in-depth.
export const ORDER_RATE_JOB_REAP_MS = Math.max(
  300_000,
  Number.parseInt(process.env.ORDER_RATE_JOB_REAP_MS ?? '900000', 10) || 900_000,
);

/**
 * Delete every order_rate_jobs row whose updated_at is older than maxAgeMs. Returns the count
 * reaped (for logging). Idempotent + safe to run concurrently with the backfill: a row being
 * actively (re)stamped has a fresh updated_at and is never in range.
 */
export async function reapStaleOrderRateJobs(
  maxAgeMs: number = ORDER_RATE_JOB_REAP_MS,
  conn: typeof db = db,
): Promise<number> {
  // The prod path ensures the table exists; an injected test conn (pglite) creates it itself.
  if (conn === db) await ensureOrderRateJobsSchema();
  const cutoff = new Date(Date.now() - Math.max(0, maxAgeMs));
  const deleted = await conn
    .delete(orderRateJobs)
    .where(lt(orderRateJobs.updatedAt, cutoff))
    .returning({ orderId: orderRateJobs.orderId });
  return deleted.length;
}
