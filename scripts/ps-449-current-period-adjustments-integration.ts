/**
 * PS-449 migrated behavior proof. Offline only: PGlite applies the real
 * billing lock/close/calendar/adjustment migrations and the test injects that
 * database into the canonical reconciliation policy. No configured database
 * or provider is contacted. Timestamptz fixtures are explicit UTC instants from
 * the billing-day owner and the PGlite session zone is pinned NON-UTC, so the
 * proof is host-timezone-independent.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { BILLING_LOS_ANGELES_TIME_ZONE, billingDayRange } from '../src/lib/time/billing-day.js';

function migration(path: string): string {
  return readFileSync(path, 'utf8');
}

async function expectToken(token: string, run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(run, (error: unknown) =>
    error instanceof Error && error.message.includes(token));
}

async function frozenBytes(pg: PGlite, clientId: number, orderId: number): Promise<string> {
  const result = await pg.query<{ frozen: string }>(`
    select coalesce(json_agg(frozen order by frozen.id)::text, '[]') as frozen
    from (
      select id, client_id, order_id, ship_date, billing_effective_date,
        billing_policy_version, line_type, description, qty::text,
        unit_cost::text, total_cost::text, invoiced, created_at
      from billing_line_items
      where client_id = $1 and order_id = $2
    ) frozen
  `, [clientId, orderId]);
  return result.rows[0]?.frozen ?? '[]';
}

async function main(): Promise<void> {
  process.env.NODE_ENV ??= 'test';
  process.env.VERCEL ??= '1';
  process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
  process.env.SUPABASE_URL ??= 'https://example.supabase.co';

  const pg = new PGlite();
  // Adversarial DB session zone (the product's billing DISPLAY zone). PGlite defaults the session
  // to the host offset, which made bare date literals drift by hours per host. Every timestamptz
  // the owner reads or writes is an explicit instant, so a non-UTC session must change nothing.
  await pg.exec(`set time zone '${BILLING_LOS_ANGELES_TIME_ZONE}'`);
  await pg.exec(`
    create table clients (id integer primary key, name text not null default 'Test');
    create table orders (
      id integer primary key,
      canonical_billing_total numeric(12,2) not null
    );
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
      order_count integer not null default 0,
      pick_pack_total numeric(14,2) not null default 0,
      additional_total numeric(14,2) not null default 0,
      package_total numeric(14,2) not null default 0,
      shipping_total numeric(14,2) not null default 0,
      storage_total numeric(14,2) not null default 0,
      grand_total numeric(14,2) not null default 0,
      updated_at timestamptz not null default now(),
      primary key (client_id, period_from, period_to)
    );
  `);
  await pg.exec(migration('drizzle/0059_billing_finalized_lock.sql'));
  await pg.exec(migration('drizzle/0065_billing_close_workflow.sql'));
  await pg.exec(migration('drizzle/0071_billing_weekend_rollforward.sql'));
  await pg.exec(migration('drizzle/0074_billing_current_period_adjustments.sql'));

  // Timestamptz fixtures are the EXPLICIT UTC-MIDNIGHT INSTANTS the product stores
  // (billingDayRange().fromUtc / .toUtcExclusive, what finalizeBillingPeriod inserts). A bare
  // '2026-07-01' literal into timestamptz is read in the DB session zone and drifts by hours on
  // a non-UTC host. billing_summary_metrics.period_from/to are DATE columns: a bare day is exact.
  const PERIOD = billingDayRange('2026-07-01', '2026-07-07'); // half-open [07-01, 07-08)
  const FROZEN = billingDayRange('2026-07-01', '2026-07-01');
  const NET = billingDayRange('2026-07-22', '2026-07-22'); // current-period net-credit close
  if (!PERIOD || !FROZEN || !NET) throw new Error('fixture days must parse');
  await pg.exec(`
    insert into clients (id, name) values (1, 'Credit/debit client'), (2, 'Net credit client');
    insert into orders (id, canonical_billing_total) values (101, 100), (202, 10);
  `);
  await pg.query(`
    insert into billing_line_items
      (client_id, order_id, order_number, ship_date, line_type, description, unit_cost, total_cost)
    values
      (1, 101, 'PS449-101', $1::timestamptz, 'pick_pack', 'Frozen prep', 40, 40),
      (1, 101, 'PS449-101', $1::timestamptz, 'shipping', 'Frozen shipping', 60, 60),
      (2, 202, 'PS449-202', $1::timestamptz, 'pick_pack', 'Frozen prep', 10, 10)
  `, [FROZEN.fromUtc]);
  await pg.exec(`update billing_line_items set invoiced = true where order_id in (101, 202)`);
  await pg.query(`
    insert into billing_finalizations
      (id, client_id, period_start, period_end, line_count, order_count, subtotal, finalized_by)
    values
      ('final-101', 1, $1::timestamptz, $2::timestamptz, 2, 1, 100, 'test'),
      ('final-202', 2, $1::timestamptz, $2::timestamptz, 1, 1, 10, 'test')
  `, [PERIOD.fromUtc, PERIOD.toUtcExclusive]);
  await pg.exec(`
    insert into billing_summary_metrics
      (client_id, period_from, period_to, grand_total)
    values (1, '2026-07-01', '2026-08-01', 100);
  `);

  // Fixture integrity: the stored bounds are the exact instants, whatever the session zone.
  const stored = await pg.query<{ id: string; start: string; end: string; tz: string }>(`
    select id, extract(epoch from period_start)::bigint::text as start,
      extract(epoch from period_end)::bigint::text as "end", current_setting('TimeZone') as tz
    from billing_finalizations order by id
  `);
  const epoch = (iso: string) => String(Date.parse(iso) / 1000);
  assert.notEqual(stored.rows[0]?.tz, 'UTC', 'the session zone under test must be non-UTC');
  assert.deepEqual(stored.rows.map((r) => ({ id: r.id, start: r.start, end: r.end })), [
    { id: 'final-101', start: epoch(PERIOD.fromUtc), end: epoch(PERIOD.toUtcExclusive) },
    { id: 'final-202', start: epoch(PERIOD.fromUtc), end: epoch(PERIOD.toUtcExclusive) },
  ], 'finalized bounds are UTC-midnight instants, not shifted by the session zone');
  console.log(`ok   fixture: [${PERIOD.fromDay}..${PERIOD.toDay}] stored as exact UTC-midnight`
    + ` instants under session TimeZone=${stored.rows[0]?.tz}`);

  const policy = await import('../src/services/billing-finalization-policy.js');
  const database = drizzle(pg, { casing: 'snake_case' });
  const noSchemaProbe = async () => {};
  const before = await frozenBytes(pg, 1, 101);

  await pg.exec(`update orders set canonical_billing_total = 75 where id = 101`);
  const credited = await policy.reconcileFinalizedBillingOrderAdjustments({
    clientId: 1,
    dateFrom: '2026-07-01T00:00:00.000Z',
    dateTo: '2026-07-08T00:00:00.000Z',
    candidates: [{ orderId: 101, currentTotal: '75.00' }],
    actorId: 'test:ps-449',
    now: new Date('2026-07-22T18:00:00.000Z'),
  }, database as never, noSchemaProbe);
  assert.deepEqual(credited, {
    finalizedOrderCount: 1,
    adjustedOrderCount: 1,
    untouchedOrderCount: 0,
    creditCount: 1,
    debitCount: 0,
  });
  assert.equal(await frozenBytes(pg, 1, 101), before, 'finalized rows must remain byte-identical');

  const credit = await pg.query<{
    adjustment_kind: string;
    amount: string;
    posting_version: string;
    source_order_id: number;
    effective_day: string;
    total_cost: string;
    source_finalization_id: string;
  }>(`
    select n.adjustment_kind, n.amount::text, n.posting_version, n.source_order_id,
      to_char(n.effective_date at time zone 'UTC', 'YYYY-MM-DD') as effective_day,
      l.total_cost::text, l.source_finalization_id
    from billing_credit_notes n
    join billing_line_items l on l.billing_adjustment_id = n.id
    where n.client_id = 1
  `);
  assert.deepEqual(credit.rows[0], {
    adjustment_kind: 'credit',
    amount: '25.00',
    posting_version: 'current_period_v2',
    source_order_id: 101,
    effective_day: '2026-07-22',
    total_cost: '-25.00',
    source_finalization_id: 'final-101',
  });

  const untouched = await policy.reconcileFinalizedBillingOrderAdjustments({
    clientId: 1,
    dateFrom: '2026-07-01T00:00:00.000Z',
    dateTo: '2026-07-08T00:00:00.000Z',
    candidates: [{ orderId: 101, currentTotal: '75.00' }],
    now: new Date('2026-07-22T18:00:00.000Z'),
  }, database as never, noSchemaProbe);
  assert.equal(untouched.adjustedOrderCount, 0);
  assert.equal(untouched.untouchedOrderCount, 1);

  await pg.exec(`update orders set canonical_billing_total = 125 where id = 101`);
  const debited = await policy.reconcileFinalizedBillingOrderAdjustments({
    clientId: 1,
    dateFrom: '2026-07-01T00:00:00.000Z',
    dateTo: '2026-07-08T00:00:00.000Z',
    candidates: [{ orderId: 101, currentTotal: '125.00' }],
    now: new Date('2026-07-22T18:00:00.000Z'),
  }, database as never, noSchemaProbe);
  assert.equal(debited.debitCount, 1);
  const signed = await pg.query<{ total: string }>(`
    select sum(total_cost)::text as total
    from billing_line_items
    where client_id = 1 and line_type = 'billing_adjustment'
  `);
  assert.equal(signed.rows[0]?.total, '25.00', 'signed corrections must converge to canonical 125');
  assert.equal(await frozenBytes(pg, 1, 101), before, 'debit reconciliation must not rewrite frozen rows');

  const cache = await pg.query<{ count: number }>(`
    select count(*)::int as count from billing_summary_metrics where client_id = 1
  `);
  assert.equal(cache.rows[0]?.count, 0, 'current-period projection must invalidate overlapping summary cache');

  const adjustmentId = credit.rows.length ? await pg.query<{ id: number }>(`
    select id from billing_line_items
    where client_id = 1 and line_type = 'billing_adjustment'
    order by id limit 1
  `) : null;
  const firstAdjustmentId = adjustmentId?.rows[0]?.id;
  assert.ok(firstAdjustmentId);
  await expectToken('BILLING_ADJUSTMENT_IMMUTABLE', () =>
    pg.exec(`update billing_line_items set description = 'rewritten' where id = ${firstAdjustmentId}`));
  await expectToken('BILLING_ADJUSTMENT_IMMUTABLE', () =>
    pg.exec(`delete from billing_line_items where id = ${firstAdjustmentId}`));

  const netCredit = await policy.reconcileFinalizedBillingOrderAdjustments({
    clientId: 2,
    dateFrom: '2026-07-01T00:00:00.000Z',
    dateTo: '2026-07-08T00:00:00.000Z',
    candidates: [{ orderId: 202, currentTotal: '0.00' }],
    now: new Date('2026-07-22T18:00:00.000Z'),
  }, database as never, noSchemaProbe);
  assert.equal(netCredit.creditCount, 1);
  await pg.exec(`
    update billing_line_items
    set invoiced = true
    where client_id = 2 and line_type = 'billing_adjustment'
  `);
  await pg.query(`
    insert into billing_finalizations
      (id, client_id, period_start, period_end, line_count, order_count, subtotal, finalized_by)
    values ('current-net-credit', 2, $1::timestamptz, $2::timestamptz, 1, 0, -10, 'test')
  `, [NET.fromUtc, NET.toUtcExclusive]);
  const netFinalized = await pg.query<{ subtotal: string }>(`
    select subtotal::text from billing_finalizations where id = 'current-net-credit'
  `);
  assert.equal(netFinalized.rows[0]?.subtotal, '-10.00', 'net-credit current periods remain finalizable');

  await expectToken('BILLING_ADJUSTMENT_PROJECTION_MISSING', () => pg.exec(`
    insert into billing_credit_notes (
      id, finalization_id, client_id, amount, adjustment_kind,
      adjustment_source, posting_version, effective_date,
      billing_policy_version, reason, idempotency_key, created_by
    ) values (
      'orphan-note', 'final-101', 1, 1, 'debit', 'manual',
      'current_period_v2', '2026-07-22T00:00:00.000Z', 'legacy_calendar_v1',
      'Missing projection', 'orphan-note-key', 'test'
    )
  `));

  await expectToken('BILLING_ADJUSTMENT_LEGACY_WRITE_DISABLED', () => pg.exec(`
    insert into billing_credit_notes (
      id, finalization_id, client_id, amount, reason,
      idempotency_key, created_by
    ) values (
      'legacy-rollback-note', 'final-101', 1, 1,
      'Rollback compatibility proof', 'legacy-rollback-key', 'test'
    )
  `));

  await pg.close();
  console.log('PASS PS-449 current-period signed adjustment integration');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
