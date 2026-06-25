/**
 * PS-120 leak fix — REAL integration test for reapStaleOrderRateJobs against in-memory Postgres
 * (PGlite). Proves the durable, age-based reaper: rows whose updated_at is older than maxAgeMs are
 * deleted, fresh in-flight rows survive, the returned count is exact, and a second run is a no-op
 * (idempotent). Scoped to order_rate_jobs ONLY — never touches orders/shipments (lockdown-safe).
 * Offline/deterministic.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import * as schema from '../src/db/schema/index.js';
import { orderRateJobs } from '../src/db/schema/order-rate-jobs.js';
import { reapStaleOrderRateJobs } from '../src/services/shipping-workflow/reap-stale-rate-jobs.js';
import { touchPendingOrderRateJobs } from '../src/services/shipping-workflow/order-rate-job-status.js';

type Conn = Parameters<typeof reapStaleOrderRateJobs>[1];

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

async function main(): Promise<void> {
  const client = new PGlite();
  const pg = drizzle(client, { schema, casing: 'snake_case' });
  const conn = pg as unknown as Conn;

  // Mirror order-rate-job-status.ts's ensureOrderRateJobsSchema CREATE TABLE (minus the FK to orders
  // + RLS, which a standalone test doesn't need).
  await pg.execute(sql`CREATE TABLE order_rate_jobs (
    order_id integer PRIMARY KEY,
    state text NOT NULL,
    request_fingerprint text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);

  // Two STALE stamps (20 min + 1 day old) and one FRESH (2 min old). maxAgeMs = 15 min.
  await pg.execute(sql`INSERT INTO order_rate_jobs (order_id, state, request_fingerprint, updated_at) VALUES
    (1, 'pending', 'fp1', now() - interval '20 minutes'),
    (2, 'rating',  'fp2', now() - interval '1 day'),
    (3, 'pending', 'fp3', now() - interval '2 minutes')`);

  const FIFTEEN_MIN = 15 * 60 * 1000;

  // ── Reap ──
  const reaped = await reapStaleOrderRateJobs(FIFTEEN_MIN, conn);
  check('reap returns the exact count of stale rows (2)', reaped === 2);

  const remaining = await pg.select().from(orderRateJobs);
  check('only the FRESH row (order 3) survives', remaining.length === 1 && remaining[0]!.orderId === 3);
  check('both STALE rows (orders 1 + 2) are gone',
    !remaining.some((r) => r.orderId === 1 || r.orderId === 2));

  // ── Idempotent: re-running reaps nothing (the fresh row is still fresh) ──
  const reapedAgain = await reapStaleOrderRateJobs(FIFTEEN_MIN, conn);
  check('a second reap is a no-op (0)', reapedAgain === 0);
  check('the fresh row still survives after the second reap',
    (await pg.select().from(orderRateJobs)).length === 1);

  // ── touchPendingOrderRateJobs (RC4 heartbeat) refreshes ONLY 'pending' rows ──
  await pg.execute(sql`INSERT INTO order_rate_jobs (order_id, state, request_fingerprint, updated_at) VALUES
    (10, 'pending', 'fp10', now() - interval '5 minutes'),
    (11, 'rating',  'fp11', now() - interval '5 minutes')`);
  const ageMs = (v: unknown) => Date.now() - new Date(v as string).getTime();
  const touched = await touchPendingOrderRateJobs([10, 11], conn);
  check('touch refreshes ONLY the pending row (count 1)', touched === 1);
  const afterTouch = await pg.select().from(orderRateJobs);
  const r10 = afterTouch.find((r) => r.orderId === 10);
  const r11 = afterTouch.find((r) => r.orderId === 11);
  check('pending row 10 updated_at is now fresh (< 1 min old)', !!r10 && ageMs(r10.updatedAt) < 60_000);
  check('rating row 11 updated_at is UNCHANGED (still ~5 min old)', !!r11 && ageMs(r11.updatedAt) > 60_000);
  check('touch of an empty id list is a no-op (0)', (await touchPendingOrderRateJobs([], conn)) === 0);

  // ── A tiny maxAge reaps even the fresh rows (clock-driven, not state-driven) ──
  const reapedAll = await reapStaleOrderRateJobs(0, conn);
  check('maxAge=0 reaps all remaining rows', reapedAll >= 1);
  check('table is empty after reaping everything', (await pg.select().from(orderRateJobs)).length === 0);

  await client.close();
  if (failures > 0) {
    console.error(`\nPS-120 reap-stale-rate-jobs integration test FAILED with ${failures} failure(s).`);
    process.exit(1);
  }
  console.log('\nPS-120 reap-stale-rate-jobs integration test passed.');
}

void main().catch((err) => {
  console.error('PS-120 reap-stale-rate-jobs integration test crashed:', err);
  process.exit(1);
});
