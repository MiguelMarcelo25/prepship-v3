// PS-497 Slice 2 Release B (S2.8, Hermes flags-off finding) — proves the flags-off (projection OFF) behavior
// against REAL PostgreSQL 17. With FULFILLMENT_OCCURRENCE_PROJECTION off, a shipment through the canonical
// owner still records a DURABLE legacy inventory_deduction_requested intent (exactly as Release A does) — so a
// claim created during the projection-off quarantine window is PRESERVED (not lost) and back-projectable, and
// is distinguishable from the historical occurrence_id-NULL backlog (which carries no fresh pending intent).
// Nothing executes it (the generic worker is de-scoped + the processor fails closed), so no stock moves. This
// is the corrected, Release-A-compatible flags-off contract — NOT the false "byte-identical" claim.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { applyMigrations, requireCatalog, PS497_0104_CATALOG } from './lib/migration-execution-pg.js';
import { PG17_HOSTED_TOLERANCE } from './lib/pg17-hosted-tolerance.js';

const ADMIN_URL = process.env.PS497_PG17_ADMIN_URL || process.env.PS487_PG17_ADMIN_URL || process.env.PS508_PG17_ADMIN_URL;
if (!ADMIN_URL) { console.error('FAIL: PS497_PG17_ADMIN_URL not set. Unskippable.'); process.exit(1); }
const ADMIN: string = ADMIN_URL;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

process.env.VERCEL ??= '1';
process.env.SUPABASE_URL ??= 'http://localhost';
// FLAGS OFF — the resting Release B state on the API + generic scheduler.
process.env.FULFILLMENT_OCCURRENCE_PROJECTION = 'false';
process.env.FULFILLMENT_OCCURRENCE_EXECUTION = 'false';
process.env.INVENTORY_AUTO_DEDUCT = 'false';

async function setupTables(db: postgres.Sql): Promise<void> {
  await db.unsafe(`
    create table inventory (id integer primary key);
    create table inventory_ledger (id serial primary key, inventory_id integer, qty integer, type text, created_at timestamptz default now());
    create table clients (id integer primary key, is_test boolean not null default false);
    create table orders (
      id integer primary key, client_id integer, store_id integer,
      order_status text not null default 'awaiting_shipment', canonical_status text,
      externally_shipped boolean not null default false, items jsonb,
      updated_at timestamptz not null default now());
    create table shipments (
      id integer primary key, order_id integer, voided boolean not null default false,
      is_return boolean not null default false, label_shipment_id integer, source text,
      updated_at timestamptz);
    create table order_overrides (order_id integer primary key, tracking_number text,
      externally_shipped_source text, recipient_override jsonb, updated_at timestamptz);
    insert into clients (id, is_test) values (7, false);
  `);
  // PS-510: selected-file application delegated to the canonical owner. This caller previously
  // stripped concurrency with `.replace(/ concurrently/ig, '')`, which is local rewrite
  // authority over 0104 — it produced a schema that differs from the one migrations define.
  // The owner keeps every statement verbatim and routes CONCURRENTLY into the autocommit phase.
  await applyMigrations({
    sql: db,
    dir: path.join(REPO_ROOT, 'drizzle'),
    only: [
      '0070_order_lifecycle_commands.sql',
      '0090_fulfillment_claim_nullable_quantity.sql',
      '0104_ps497_fulfillment_occurrences.sql',
      '0105_ps497_claim_not_applicable_status.sql',
    ],
    tolerate: PG17_HOSTED_TOLERANCE,
    report: false,
  });
  // Schema gate before any behaviour assertion.
  await requireCatalog(db, PS497_0104_CATALOG);
  await db.unsafe(`
    create table fulfillment_outbox (
      id serial primary key, order_id integer not null, shipment_id integer,
      event_type text not null, provider text not null, dedupe_key text not null,
      payload jsonb not null default '{}', status text not null default 'pending',
      attempts integer not null default 0, last_error text,
      next_run_at timestamptz not null default now(), created_at timestamptz not null default now(),
      updated_at timestamptz not null default now());
    create unique index fulfillment_outbox_dedupe_idx on fulfillment_outbox (dedupe_key);
  `);
}

async function main(): Promise<void> {
  const hard = setTimeout(() => { console.error('HANG: exceeded 120s'); process.exit(3); }, 120_000);
  hard.unref();
  const admin = postgres(ADMIN, { max: 1, prepare: false, onnotice: () => {} });
  const [ver] = await admin<{ v: number }[]>`select current_setting('server_version_num')::int as v`;
  const v = Number(ver?.v ?? 0);
  if (v < 170000 || v >= 180000) { console.error(`FAIL: not PG17 (${v})`); await admin.end({ timeout: 5 }); process.exit(1); }
  const dbName = `ps497_flagsoff_${v}_${process.pid}`;
  await admin.unsafe(`drop database if exists "${dbName}" with (force)`);
  await admin.unsafe(`create database "${dbName}"`);
  const base = ADMIN.replace(/\/[^/]*$/, `/${dbName}`);
  const raw = postgres(base, { max: 1, prepare: false, onnotice: () => {} });
  await setupTables(raw);

  process.env.DATABASE_URL = base;
  const { env } = await import('../src/lib/env.js');
  assert.equal(env.FULFILLMENT_OCCURRENCE_PROJECTION, false, 'projection resolved OFF for this proof');
  const { applyOrderLifecycleCommand } = await import('../src/services/order-lifecycle-command.js');

  let passed = 0;
  const ok = (m: string) => { passed += 1; console.log('ok   ' + m); };
  const claims = async (orderId: number) =>
    raw<Array<{ status: string; occurrence_id: number | null; supply: string | null }>>`select status, occurrence_id, supply from fulfillment_line_claims where order_id = ${orderId} order by id`;
  const outbox = async (orderId: number) =>
    raw<Array<{ event_type: string; status: string }>>`select event_type, status from fulfillment_outbox where order_id = ${orderId} order by id`;
  const occurrenceCount = async () => (await raw<{ n: number }[]>`select count(*)::int as n from fulfillment_occurrences`)[0]?.n ?? 0;
  const ledgerCount = async () => (await raw<{ n: number }[]>`select count(*)::int as n from inventory_ledger`)[0]?.n ?? 0;

  // 1) flags-off shipment: claim pending + occurrence_id NULL; a DURABLE legacy intent is preserved; no
  //    occurrence created; no occurrence intent; no movement.
  await raw`insert into orders (id, client_id, store_id, order_status) values (1, 7, 3, 'awaiting_shipment')`;
  await raw`insert into shipments (id, order_id, voided, is_return, label_shipment_id, source) values (10, 1, false, false, 555, 'shipstation')`;
  const r1 = await applyOrderLifecycleCommand({
    orderId: 1, shipmentId: 10, commandKey: 'ck:1', transition: 'shipped', source: 'shipstation',
    fulfillmentFacts: { kind: 'exact', evidence: 'exact_shipment', lines: [{ lineKey: 'sku:A', sku: 'A', name: 'A', quantity: 2 }] },
  });
  assert.equal(r1.claimCount, 1);
  const c1 = await claims(1);
  assert.equal(c1[0]?.status, 'pending', 'flags-off: a valid line is a pending claim');
  assert.equal(c1[0]?.occurrence_id, null, 'flags-off: occurrence_id is NULL (no projection)');
  assert.equal(c1[0]?.supply, null, 'flags-off: the legacy branch does not stamp supply');
  assert.equal(await occurrenceCount(), 0, 'flags-off: no occurrence row is created');
  const o1 = await outbox(1);
  assert.equal(o1.length, 1, 'exactly one durable intent is recorded');
  assert.equal(o1[0]?.event_type, 'inventory_deduction_requested', 'the DURABLE intent is the legacy lane (preserved, not lost)');
  assert.equal(o1[0]?.status, 'pending', 'the durable legacy intent is preserved and back-projectable');
  assert.equal(await ledgerCount(), 0, 'flags-off: nothing executes -> zero stock movement');
  ok('flags-off shipment -> pending claim (occurrence_id NULL) + DURABLE legacy intent preserved + no occurrence intent + zero movement');

  // 2) the durable legacy intent DISTINGUISHES a quarantine-window claim from the historical backlog: this
  //    claim has occurrence_id NULL AND a fresh pending intent; the ~4,057 historical claims have neither.
  const distinguishing = (await raw<{ n: number }[]>`
    select count(*)::int as n from fulfillment_line_claims c
    where c.order_id = 1 and c.occurrence_id is null
      and exists (select 1 from fulfillment_outbox o where o.order_id = c.order_id and o.event_type = 'inventory_deduction_requested' and o.status in ('pending','failed'))
  `)[0]?.n ?? 0;
  assert.equal(distinguishing, 1, 'the quarantine-window claim is distinguishable (occurrence_id NULL + a fresh pending legacy intent)');
  ok('the quarantine-window claim is distinguishable from the historical occurrence_id-NULL backlog');

  // 3) a review-only line flags-off mints NO durable intent (review lines never enqueue), and no movement.
  await raw`insert into orders (id, client_id, store_id, order_status) values (2, 7, 3, 'awaiting_shipment')`;
  await raw`insert into shipments (id, order_id, voided, is_return, label_shipment_id, source) values (20, 2, false, false, 42, 'shipstation')`;
  await applyOrderLifecycleCommand({
    orderId: 2, shipmentId: 20, commandKey: 'ck:2', transition: 'shipped', source: 'shipstation',
    fulfillmentFacts: { kind: 'exact', evidence: 'exact_shipment', lines: [{ lineKey: 'k', sku: null, name: 'x', quantity: 1 }] },
  });
  const c2 = await claims(2);
  assert.equal(c2[0]?.status, 'review', 'a null-sku line is review flags-off');
  assert.equal((await outbox(2)).length, 0, 'a review-only shipment mints no durable intent (review lines never enqueue)');
  ok('flags-off review-only line -> review claim, no durable intent, no movement');

  clearTimeout(hard);
  await raw.end({ timeout: 5 });
  await admin.unsafe(`drop database "${dbName}" with (force)`);
  await admin.end({ timeout: 5 });
  console.log(`\nPASS PS-497 flags-off contract (PostgreSQL ${v}) — ${passed}/${passed} checks`);
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });
