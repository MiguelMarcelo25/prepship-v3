/**
 * PS-487 AC-6 — concurrency proof against REAL PostgreSQL 17 (Hermes proof #6). PGlite is a single
 * connection and cannot prove mutual exclusion, so this runs two INDEPENDENT connections and shows:
 *
 *  1. while a transaction that ran the REAL classifier holds the per-client finalization advisory
 *     lock (36421, clientId), a second connection attempting to take that same lock — which is what
 *     the finalization CLOSE path does — BLOCKS (fails under lock_timeout). So a period cannot
 *     finalize between classification and the direct insert that runs in the same transaction.
 *  2. once the classifying transaction commits, the second connection acquires the lock — the lock
 *     is transaction-scoped and releases on commit, not leaked.
 *  3. the reconciler's zero-baseline path fails CLOSED when its finalization is absent/unlocked
 *     (BILLING_ZERO_BASELINE_FINALIZATION_NOT_LOCKED), never a silent insert.
 *
 * Unskippable: absent PS487_PG17_ADMIN_URL (or PS508_PG17_ADMIN_URL) this FAILS rather than skips,
 * and it refuses any server that is not PostgreSQL 17. No production database is reachable.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

const ADMIN_URL = process.env.PS487_PG17_ADMIN_URL || process.env.PS508_PG17_ADMIN_URL;
if (!ADMIN_URL) {
  console.error('FAIL: PS487_PG17_ADMIN_URL (or PS508_PG17_ADMIN_URL) is not set. This proof is unskippable.');
  process.exit(1);
}
const ADMIN: string = ADMIN_URL;

function migration(path: string): string {
  return readFileSync(path, 'utf8');
}

const CLIENT = 1;
const WINDOW = { dateFrom: '2026-07-01T00:00:00.000Z', dateTo: '2026-08-01T00:00:00.000Z' };

async function setupSchema(db: postgres.Sql): Promise<void> {
  await db.unsafe(`
    create table clients (id integer primary key, name text not null default 'Test');
    create table orders (id integer primary key, canonical_billing_total numeric(12,2) not null default 0);
    create table billing_line_items (
      id serial primary key,
      client_id integer not null references clients(id) on delete cascade,
      order_id integer references orders(id),
      order_number text,
      shipment_id integer,
      ship_date timestamptz,
      line_type text not null,
      description text not null,
      qty numeric(10,2) not null default 1,
      unit_cost numeric(10,2) not null,
      total_cost numeric(10,2) not null,
      package_id integer,
      invoiced boolean not null default false,
      created_at timestamptz not null default now()
    );
    create table billing_summary_metrics (
      client_id integer not null,
      period_from date not null,
      period_to date not null,
      grand_total numeric(14,2) not null default 0,
      updated_at timestamptz not null default now(),
      primary key (client_id, period_from, period_to)
    );
  `);
  await db.unsafe(migration('drizzle/0059_billing_finalized_lock.sql'));
  await db.unsafe(migration('drizzle/0065_billing_close_workflow.sql'));
  await db.unsafe(migration('drizzle/0071_billing_weekend_rollforward.sql'));
  await db.unsafe(migration('drizzle/0074_billing_current_period_adjustments.sql'));
  await db.unsafe(`
    insert into clients (id, name) values (${CLIENT}, 'AC-6 concurrency');
    insert into orders (id) values (91);
    insert into billing_finalizations
      (id, client_id, period_start, period_end, line_count, order_count, subtotal, finalized_by)
    values ('final-jul', ${CLIENT}, '2026-07-01', '2026-07-08', 1, 1, 6.77, 'test');
  `);
}

/**
 * A second connection probes the finalization CLOSE lock (36421, clientId). The close path takes
 * the BLOCKING `pg_advisory_xact_lock`, but lock_timeout does NOT interrupt advisory-lock waits, so
 * to prove exclusivity WITHOUT hanging we use the non-blocking try-variant: it returns false in
 * exactly the case the blocking acquire would wait (another transaction holds the lock), and true
 * when it is free. The lock it takes on success is transaction-scoped and released as the probe's
 * own transaction commits, so the probe never mutates state.
 */
async function attemptFinalizationLock(conn: postgres.Sql): Promise<'acquired' | 'blocked'> {
  const rows = await conn.begin(async (tx) =>
    tx.unsafe(`select pg_try_advisory_xact_lock(36421, ${CLIENT}) as got`));
  const got = Array.isArray(rows) ? (rows[0] as { got?: boolean } | undefined)?.got : undefined;
  return got ? 'acquired' : 'blocked';
}


async function main(): Promise<void> {
  const hardTimeout = setTimeout(() => {
    console.error('HANG: ps-487-ac6-concurrency-pg17 exceeded 60s');
    process.exit(3);
  }, 60_000);
  hardTimeout.unref();
  process.env.NODE_ENV ??= 'test';
  process.env.VERCEL ??= '1';
  process.env.SUPABASE_URL ??= 'https://example.supabase.co';

  const admin = postgres(ADMIN, { max: 1, onnotice: () => {} });
  const [ver] = await admin<{ v: number }[]>`select current_setting('server_version_num')::int as v`;
  const v = Number(ver?.v ?? 0);
  if (v < 170000 || v >= 180000) {
    console.error(`FAIL: expected PostgreSQL 17 (server_version_num 170000-179999), got ${v}.`);
    await admin.end({ timeout: 5 });
    process.exit(1);
  }
  const dbName = `ps487_ac6_conc_${Date.now()}`;
  await admin.unsafe(`create database "${dbName}"`);
  const base = ADMIN.replace(/\/[^/]*$/, `/${dbName}`);
  process.env.DATABASE_URL = base;

  const setup = postgres(base, { max: 1, onnotice: () => {} });
  await setupSchema(setup);
  await setup.end({ timeout: 5 });

  // Connection A runs the REAL classifier inside a transaction (acquires 36421/CLIENT + FOR UPDATE
  // on the finalization). Connection B is fully independent.
  const connA = postgres(base, { max: 1, onnotice: () => {} });
  const connB = postgres(base, { max: 1, onnotice: () => {} });
  const dbA = drizzle(connA, { casing: 'snake_case' });
  const policy = await import('../src/services/billing-finalization-policy.js');

  let passed = 0;
  const ok = (m: string) => { passed += 1; console.log('ok   ' + m); };

  let whileHeld: 'acquired' | 'blocked' | 'unset' = 'unset';
  await dbA.transaction(async (tx) => {
    const classified = await policy.classifyReturnLinesByFinalization({
      clientId: CLIENT,
      ...WINDOW,
      lines: [{ orderId: 91, clientId: CLIENT, billingEffectiveDate: '2026-07-02' }],
    }, tx as never);
    assert.equal(classified.finalizedLines.length, 1, 'the July-2 line classifies as finalized');
    assert.equal(classified.finalizedLines[0]?.finalizationId, 'final-jul');
    // The classifying transaction now holds 36421/CLIENT. A concurrent finalization must not land.
    whileHeld = await attemptFinalizationLock(connB);
  });
  assert.equal(whileHeld, 'blocked',
    'while classify holds the client lock, a finalization CANNOT take it (blocked under lock_timeout)');
  ok('concurrency: a finalization cannot land between classification and insertion — the client advisory lock (36421) blocks it');

  const afterCommit = await attemptFinalizationLock(connB);
  assert.equal(afterCommit, 'acquired',
    'after the classifying transaction commits, the lock releases and finalization proceeds');
  ok('lock is transaction-scoped: it releases on commit (not leaked), so finalization proceeds afterward');

  // Loss of the required lock / finalization fails CLOSED: a zero-baseline candidate whose
  // finalization is absent is refused, never silently inserted.
  let failedClosed = false;
  try {
    await policy.reconcileFinalizedBillingOrderAdjustments({
      clientId: CLIENT,
      ...WINDOW,
      candidates: [{ orderId: 91, currentTotal: '6.77', zeroBaselineFinalizationId: 'ghost-finalization' }],
      now: new Date('2026-07-22T18:00:00.000Z'),
    }, dbA as never, async () => {});
  } catch (error) {
    failedClosed = (error as { code?: string }).code === 'BILLING_ZERO_BASELINE_FINALIZATION_NOT_LOCKED';
    if (!failedClosed) throw error;
  }
  assert.ok(failedClosed, 'a zero-baseline candidate whose finalization is not locked must fail closed');
  ok('fail-closed on real PG17: a zero-baseline return whose finalization this run does not lock is REFUSED');

  clearTimeout(hardTimeout);
  await connA.end({ timeout: 5 });
  await connB.end({ timeout: 5 });
  await admin.unsafe(`drop database "${dbName}" with (force)`);
  await admin.end({ timeout: 5 });
  console.log(`\nPASS PS-487 AC-6 concurrency (PostgreSQL ${v}) — ${passed}/${passed} checks`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
