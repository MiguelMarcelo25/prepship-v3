// PS-497 Slice 2 Release B (S2.4) — the owner cutover proven end-to-end against REAL PostgreSQL 17.
// Runs the SOLE claim inserter (applyOrderLifecycleCommandInTransaction / voidOrderShipmentLifecycleInTransaction)
// with FULFILLMENT_OCCURRENCE_PROJECTION on and asserts: occurrence stamped, supply GATES status, occurrence-
// scoped idempotency, occurrence outbox intent minted ONLY for in-scope deductible prepship lines, external ->
// not_applicable (no intent), two converging writers -> one claim set, reverse inherits lineage. Flags-off is
// byte-identical to Release A (occurrence_id NULL) and is covered by the Release A legacy path.
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

// Offline/app env + the occurrence flags ON, set BEFORE the dynamic imports so `env` picks them up.
process.env.VERCEL ??= '1';
process.env.SUPABASE_URL ??= 'http://localhost';
process.env.FULFILLMENT_OCCURRENCE_PROJECTION = 'true';
process.env.FULFILLMENT_OCCURRENCE_EXECUTION = 'true';
process.env.INVENTORY_AUTO_DEDUCT = 'true';
process.env.FULFILLMENT_OCCURRENCE_SCOPE_MODE = 'broad';
process.env.FULFILLMENT_OCCURRENCE_SCOPE_CLIENT_IDS = '7';

async function setupTables(db: postgres.Sql): Promise<void> {
  await db.unsafe(`
    create table inventory (id integer primary key);
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
  // fulfillment_outbox (drizzle schema shape) — the owner enqueues occurrence intents here.
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
  const dbName = `ps497_owner_${v}_${process.pid}`;
  await admin.unsafe(`drop database if exists "${dbName}" with (force)`);
  await admin.unsafe(`create database "${dbName}"`);
  const base = ADMIN.replace(/\/[^/]*$/, `/${dbName}`);
  const raw = postgres(base, { max: 1, prepare: false, onnotice: () => {} });
  await setupTables(raw);

  process.env.DATABASE_URL = base;
  const { db } = await import('../src/db/client.js');
  const { applyOrderLifecycleCommand, voidOrderShipmentLifecycleInTransaction } = await import('../src/services/order-lifecycle-command.js');

  let passed = 0;
  const ok = (m: string) => { passed += 1; console.log('ok   ' + m); };
  const claimsFor = async (orderId: number) =>
    raw<Array<{ line_key: string; status: string; supply: string | null; occurrence_id: number | null; canonical_line_identity: string | null; idempotency_key: string; direction: string }>>`
      select line_key, status, supply, occurrence_id, canonical_line_identity, idempotency_key, direction
      from fulfillment_line_claims where order_id = ${orderId} order by id`;
  const outboxFor = async (orderId: number) =>
    raw<Array<{ event_type: string; dedupe_key: string }>>`select event_type, dedupe_key from fulfillment_outbox where order_id = ${orderId} order by id`;

  // 1) prepship exact shipment -> occurrence stamped, pending, occurrence idempotency, one occurrence intent.
  await raw`insert into orders (id, client_id, store_id, order_status) values (1, 7, 3, 'awaiting_shipment')`;
  await raw`insert into shipments (id, order_id, voided, is_return, label_shipment_id, source) values (10, 1, false, false, 555, 'shipstation')`;
  const r1 = await applyOrderLifecycleCommand({
    orderId: 1, shipmentId: 10, commandKey: 'ck:1', transition: 'shipped', source: 'shipstation',
    fulfillmentFacts: { kind: 'exact', evidence: 'exact_shipment', lines: [{ lineKey: 'sku:A', sku: 'A', name: 'A', quantity: 2 }] },
  });
  const c1 = await claimsFor(1);
  assert.equal(r1.claimCount, 1);
  assert.equal(c1[0]?.status, 'pending');
  assert.equal(c1[0]?.supply, 'prepship');
  assert.ok(c1[0]?.occurrence_id != null, 'occurrence_id stamped');
  assert.equal(c1[0]?.canonical_line_identity, 'sku:A');
  assert.equal(c1[0]?.idempotency_key, `inventory:deduct:occ:${c1[0]?.occurrence_id}:line:sku:A`);
  const o1 = await outboxFor(1);
  assert.equal(o1.length, 1);
  assert.equal(o1[0]?.event_type, 'fulfillment_occurrence_deduction_requested');
  ok('prepship exact -> occurrence stamped, pending, occurrence-scoped idempotency, one occurrence intent minted');

  // 2) external_shipped whole-order -> supply external -> not_applicable, NO intent.
  await raw`insert into orders (id, client_id, store_id, order_status) values (2, 7, 3, 'awaiting_shipment')`;
  const r2 = await applyOrderLifecycleCommand({
    orderId: 2, shipmentId: null, commandKey: 'ck:2', transition: 'external_shipped', source: 'webhook',
    fulfillmentFacts: { kind: 'exact', evidence: 'exact_shipment', lines: [{ lineKey: 'sku:B', sku: 'B', name: 'B', quantity: 1 }] },
  });
  const c2 = await claimsFor(2);
  assert.equal(c2[0]?.status, 'not_applicable');
  assert.equal(c2[0]?.supply, 'external');
  assert.equal((await outboxFor(2)).length, 0, 'external mints no occurrence intent');
  void r2;
  ok('external_shipped -> supply external -> not_applicable, zero occurrence intent (never deducts)');

  // 3) two converging writers on ONE occurrence (same provider label) -> one claim set (onConflict collapses).
  await raw`insert into orders (id, client_id, store_id, order_status) values (3, 7, 3, 'awaiting_shipment')`;
  await raw`insert into shipments (id, order_id, voided, is_return, label_shipment_id, source) values (31, 3, false, false, 999, 'shipstation')`;
  await raw`insert into shipments (id, order_id, voided, is_return, label_shipment_id, source) values (32, 3, false, false, 999, 'shipstation')`;
  await applyOrderLifecycleCommand({ orderId: 3, shipmentId: 31, commandKey: 'ck:3a', transition: 'shipped', source: 'shipstation',
    fulfillmentFacts: { kind: 'exact', evidence: 'exact_shipment', lines: [{ lineKey: 'sku:C', sku: 'C', name: 'C', quantity: 1 }] } });
  await applyOrderLifecycleCommand({ orderId: 3, shipmentId: 32, commandKey: 'ck:3b', transition: 'shipped', source: 'shipstation',
    fulfillmentFacts: { kind: 'exact', evidence: 'exact_shipment', lines: [{ lineKey: 'sku:C', sku: 'C', name: 'C', quantity: 1 }] } });
  const c3 = await claimsFor(3);
  const occ3 = new Set(c3.map((c) => c.occurrence_id));
  assert.equal(occ3.size, 1, 'both converging writers share one occurrence');
  assert.equal(c3.filter((c) => c.direction === 'deduct').length, 1, 'the second writer collapses to the same claim (onConflict)');
  // Hermes #4: the SECOND (zero-winner) writer inserts nothing (onConflictDoNothing returns []), so it derives
  // enqueue eligibility from ZERO returned winners and mints NO second occurrence intent.
  const o3 = await outboxFor(3);
  assert.equal(o3.filter((o) => o.event_type === 'fulfillment_occurrence_deduction_requested').length, 1,
    'a zero-winner converging writer mints no additional occurrence intent (enqueue authority is the returned winners)');
  ok('two converging writers on one occurrence -> single occurrence + single claim set + EXACTLY ONE intent (zero-winner mints nothing)');

  // 4) missing sku -> review, supply stays prepship, no intent (supply gates, does not annotate).
  await raw`insert into orders (id, client_id, store_id, order_status) values (4, 7, 3, 'awaiting_shipment')`;
  await raw`insert into shipments (id, order_id, voided, is_return, label_shipment_id, source) values (40, 4, false, false, 41, 'shipstation')`;
  await applyOrderLifecycleCommand({ orderId: 4, shipmentId: 40, commandKey: 'ck:4', transition: 'shipped', source: 'shipstation',
    fulfillmentFacts: { kind: 'exact', evidence: 'exact_shipment', lines: [{ lineKey: 'k', sku: null, name: 'x', quantity: 1 }] } });
  const c4 = await claimsFor(4);
  assert.equal(c4[0]?.status, 'review');
  assert.equal(c4[0]?.supply, 'prepship');
  assert.equal((await outboxFor(4)).length, 0);
  ok('prepship + missing sku -> review, supply stays prepship, no intent');

  // 5) out-of-scope client -> claim still pending (projection), but NO occurrence intent (enqueue scope fence).
  await raw`insert into orders (id, client_id, store_id, order_status) values (5, 8, 3, 'awaiting_shipment')`;
  await raw`insert into shipments (id, order_id, voided, is_return, label_shipment_id, source) values (50, 5, false, false, 51, 'shipstation')`;
  await applyOrderLifecycleCommand({ orderId: 5, shipmentId: 50, commandKey: 'ck:5', transition: 'shipped', source: 'shipstation',
    fulfillmentFacts: { kind: 'exact', evidence: 'exact_shipment', lines: [{ lineKey: 'sku:E', sku: 'E', name: 'E', quantity: 1 }] } });
  const c5 = await claimsFor(5);
  assert.equal(c5[0]?.status, 'pending', 'projection still stamps + gates disposition');
  assert.equal((await outboxFor(5)).length, 0, 'out-of-scope client mints no occurrence intent (enqueue scope fence)');
  ok('out-of-scope client (8, not in {7}) -> claim pending but NO occurrence intent (enqueue scope-fenced)');

  // 6) reverse inherits lineage: apply a claim, mark it applied, then void -> reverse claim carries the
  //    original occurrence lineage + occurrence-scoped reverse idempotency.
  await raw`update fulfillment_line_claims set status = 'applied' where order_id = 1 and direction = 'deduct'`;
  await db.transaction((tx) => voidOrderShipmentLifecycleInTransaction(tx, { orderId: 1, shipmentId: 10, source: 'void-test', reversePackage: false }));
  const rev = (await claimsFor(1)).find((c) => c.direction === 'reverse');
  assert.ok(rev, 'a reverse claim exists');
  assert.equal(rev?.occurrence_id, c1[0]?.occurrence_id, 'reverse inherits the original occurrence lineage');
  assert.equal(rev?.canonical_line_identity, 'sku:A');
  assert.equal(rev?.idempotency_key, `inventory:reverse:occ:${c1[0]?.occurrence_id}:line:sku:A`);
  ok('reverse inherits the original applied claim occurrence lineage + occurrence-scoped reverse idempotency');

  clearTimeout(hard);
  await raw.end({ timeout: 5 });
  await admin.unsafe(`drop database "${dbName}" with (force)`);
  await admin.end({ timeout: 5 });
  console.log(`\nPASS PS-497 owner cutover (PostgreSQL ${v}) — ${passed}/${passed} checks`);
  process.exit(0); // db (drizzle) keeps a postgres-js socket open; force a clean exit.
}

main().catch((error) => { console.error(error); process.exit(1); });
