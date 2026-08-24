/**
 * PS-487 AC-6 — finalized-period return fence, owner-boundary proof. Offline only: PGlite applies
 * the real billing lock/close/adjustment migrations and injects that database into the canonical
 * finalization owner (billing-finalization-policy). No configured database or provider is
 * contacted. Covers Hermes proofs 1-5 and 7 (escaping-order, idempotency, existing-finalized
 * parity, open-period control, half-open boundaries + a mixed range, safety) plus the fail-closed
 * zero-baseline validation. The two-connection concurrency proof (#6) lives in the PG17 test.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

function migration(path: string): string {
  return readFileSync(path, 'utf8');
}

async function expectToken(token: string, run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(run, (error: unknown) =>
    error instanceof Error
    && (error.message.includes(token) || (error as { code?: unknown }).code === token));
}

async function signedAdjustmentTotal(pg: PGlite, clientId: number): Promise<string> {
  const r = await pg.query<{ total: string }>(`
    select coalesce(sum(total_cost), 0)::text as total
    from billing_line_items
    where client_id = $1 and line_type = 'billing_adjustment'
  `, [clientId]);
  return r.rows[0]?.total ?? '0';
}

async function frozenBytes(pg: PGlite, clientId: number): Promise<string> {
  const r = await pg.query<{ frozen: string }>(`
    select coalesce(json_agg(f order by f.id)::text, '[]') as frozen
    from (
      select id, client_id, order_id, total_cost::text, invoiced
      from billing_line_items
      where client_id = $1 and invoiced = true
    ) f
  `, [clientId]);
  return r.rows[0]?.frozen ?? '[]';
}

async function main(): Promise<void> {
  process.env.NODE_ENV ??= 'test';
  process.env.VERCEL ??= '1';
  process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
  process.env.SUPABASE_URL ??= 'https://example.supabase.co';

  const pg = new PGlite();
  await pg.exec(`
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
  await pg.exec(migration('drizzle/0059_billing_finalized_lock.sql'));
  await pg.exec(migration('drizzle/0065_billing_close_workflow.sql'));
  await pg.exec(migration('drizzle/0071_billing_weekend_rollforward.sql'));
  await pg.exec(migration('drizzle/0074_billing_current_period_adjustments.sql'));

  // Client 1: an ESCAPING order (91) — a finalized July 1-8 period with NO invoiced line for order
  // 91. Also a baseline order (90) WITH an invoiced frozen line in the same period, for parity.
  await pg.exec(`
    insert into clients (id, name) values (1, 'AC-6 client');
    insert into orders (id) values (90), (91), (92);
    insert into billing_line_items
      (client_id, order_id, order_number, ship_date, billing_effective_date, line_type, description, unit_cost, total_cost, invoiced)
    values
      (1, 90, 'AC6-90', '2026-07-02', '2026-07-02', 'pick_pack', 'Frozen prep 90', 40, 40, true);
    insert into billing_finalizations
      (id, client_id, period_start, period_end, line_count, order_count, subtotal, finalized_by)
    values ('final-jul', 1, '2026-07-01', '2026-07-08', 1, 1, 40, 'test');
  `);

  const policy = await import('../src/services/billing-finalization-policy.js');
  const database = drizzle(pg, { casing: 'snake_case' });
  const noSchemaProbe = async () => {};
  const WINDOW = { dateFrom: '2026-07-01T00:00:00.000Z', dateTo: '2026-08-01T00:00:00.000Z' };
  const NOW = new Date('2026-07-22T18:00:00.000Z');
  let passed = 0;
  const ok = (m: string) => { passed += 1; console.log('ok   ' + m); };

  // ---- classifier: open vs finalized + half-open boundaries + mixed range -------------------
  const classified = await policy.classifyReturnLinesByFinalization({
    clientId: 1,
    ...WINDOW,
    lines: [
      { orderId: 91, clientId: 1, billingEffectiveDate: '2026-07-01', tag: 'at-start' },      // == period_start -> finalized
      { orderId: 91, clientId: 1, billingEffectiveDate: '2026-07-07', tag: 'last-included' },  // < period_end   -> finalized
      { orderId: 91, clientId: 1, billingEffectiveDate: '2026-07-08', tag: 'at-end' },         // == period_end  -> OPEN (half-open)
      { orderId: 92, clientId: 1, billingEffectiveDate: '2026-07-20', tag: 'open-month' },      // open period    -> open
    ],
  }, database as never);
  const tagsOf = (arr: Array<{ line: { tag: string } }>) => arr.map((e) => e.line.tag).sort();
  assert.deepEqual(tagsOf(classified.finalizedLines), ['at-start', 'last-included'],
    'period_start and the last included day are finalized');
  assert.deepEqual(tagsOf(classified.openLines.map((l) => ({ line: l }))), ['at-end', 'open-month'],
    'period_end (half-open) and an open month are OPEN');
  assert.ok(classified.finalizedLines.every((f) => f.finalizationId === 'final-jul'));
  ok('classifier: half-open period_start<=date<period_end + a range spanning finalized+open routes each line independently');

  // ---- proof 1: escaping order -> exactly one signed debit; frozen rows unchanged ------------
  const frozenBefore = await frozenBytes(pg, 1);
  const escaping = await policy.reconcileFinalizedBillingOrderAdjustments({
    clientId: 1, ...WINDOW,
    candidates: [{ orderId: 91, currentTotal: '6.77', zeroBaselineFinalizationId: 'final-jul' }],
    actorId: 'test:ac6', now: NOW,
  }, database as never, noSchemaProbe);
  assert.equal(escaping.debitCount, 1, 'escaping return -> one debit');
  assert.equal(escaping.creditCount, 0);
  assert.equal(escaping.adjustedOrderCount, 1);
  const escNote = await pg.query<{ amount: string; kind: string; fid: string; total: string }>(`
    select n.amount::text as amount, n.adjustment_kind as kind, n.finalization_id as fid, l.total_cost::text as total
    from billing_credit_notes n join billing_line_items l on l.billing_adjustment_id = n.id
    where n.client_id = 1 and n.source_order_id = 91
  `);
  assert.equal(escNote.rows.length, 1);
  assert.deepEqual({ amount: escNote.rows[0]?.amount, kind: escNote.rows[0]?.kind, fid: escNote.rows[0]?.fid, total: escNote.rows[0]?.total },
    { amount: '6.77', kind: 'debit', fid: 'final-jul', total: '6.77' });
  assert.equal(await frozenBytes(pg, 1), frozenBefore, 'the finalized invoice rows are byte-identical');
  ok('proof 1 escaping-order: zero direct inserts, exactly one signed debit against a $0.00 baseline, frozen rows unchanged');

  // ---- proof 2: idempotency — re-run produces no second adjustment ---------------------------
  const rerun = await policy.reconcileFinalizedBillingOrderAdjustments({
    clientId: 1, ...WINDOW,
    candidates: [{ orderId: 91, currentTotal: '6.77', zeroBaselineFinalizationId: 'final-jul' }],
    now: NOW,
  }, database as never, noSchemaProbe);
  assert.equal(rerun.adjustedOrderCount, 0, 'idempotent: no second adjustment');
  assert.equal(rerun.untouchedOrderCount, 1);
  const escCount = await pg.query<{ n: number }>(`select count(*)::int as n from billing_credit_notes where client_id = 1 and source_order_id = 91`);
  assert.equal(escCount.rows[0]?.n, 1, 'still exactly one adjustment after a re-run');
  ok('proof 2 idempotency: re-running the same regeneration adds no second adjustment (prior signed total netted out)');

  // ---- proof 3: existing finalized-order (baseline) parity -----------------------------------
  await pg.exec(`update orders set canonical_billing_total = 55 where id = 90`);
  const baseline = await policy.reconcileFinalizedBillingOrderAdjustments({
    clientId: 1, ...WINDOW,
    candidates: [{ orderId: 90, currentTotal: '55.00' }], // no zeroBaselineFinalizationId -> frozenRows path
    now: NOW,
  }, database as never, noSchemaProbe);
  assert.equal(baseline.debitCount, 1, 'baseline order still reconciled via the frozenRows path');
  const baseNote = await pg.query<{ n: number; amount: string }>(`
    select count(*)::int as n, coalesce(max(amount)::text,'') as amount from billing_credit_notes where client_id = 1 and source_order_id = 90`);
  assert.equal(baseNote.rows[0]?.n, 1);
  assert.equal(baseNote.rows[0]?.amount, '15.00', 'canonical 55 - frozen 40 = 15 debit');
  ok('proof 3 existing-finalized parity: an invoiced-baseline order still runs the established delta path, no duplicate authority');

  // ---- proof 4: open-period control — a candidate with no overlapping finalization -----------
  const openCtrl = await policy.reconcileFinalizedBillingOrderAdjustments({
    clientId: 1, ...WINDOW,
    candidates: [{ orderId: 92, currentTotal: '9.99' }], // order 92 has no finalized period
    now: NOW,
  }, database as never, noSchemaProbe);
  assert.equal(openCtrl.adjustedOrderCount, 0, 'open-period candidate produces no adjustment');
  const openCount = await pg.query<{ n: number }>(`select count(*)::int as n from billing_credit_notes where client_id = 1 and source_order_id = 92`);
  assert.equal(openCount.rows[0]?.n, 0);
  ok('proof 4 open-period control: an order with no overlapping finalization is never adjusted here (it inserts normally upstream)');

  // ---- fail-closed: a zero-baseline candidate pointing at an UNLOCKED finalization ------------
  await expectToken('BILLING_ZERO_BASELINE_FINALIZATION_NOT_LOCKED', () =>
    policy.reconcileFinalizedBillingOrderAdjustments({
      clientId: 1, ...WINDOW,
      candidates: [{ orderId: 91, currentTotal: '1.00', zeroBaselineFinalizationId: 'does-not-exist' }],
      now: NOW,
    }, database as never, noSchemaProbe));
  ok('fail-closed: a zero-baseline candidate whose finalization this run does not lock is REFUSED, never silently inserted');

  // ---- proof 7: safety — no finalized invoice or historical billing row mutated --------------
  assert.equal(await frozenBytes(pg, 1), frozenBefore, 'no finalized/invoiced row was updated or deleted across the run');
  await expectToken('BILLING_ADJUSTMENT_IMMUTABLE', async () => {
    const id = (await pg.query<{ id: number }>(`select id from billing_line_items where client_id=1 and line_type='billing_adjustment' order by id limit 1`)).rows[0]?.id;
    return pg.exec(`update billing_line_items set description='rewritten' where id = ${id}`);
  });
  ok('proof 7 safety: finalized invoice rows are byte-identical and the appended adjustments are immutable');

  await pg.close();
  console.log(`\nPASS PS-487 AC-6 finalized-period fence — ${passed}/${passed} checks`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
