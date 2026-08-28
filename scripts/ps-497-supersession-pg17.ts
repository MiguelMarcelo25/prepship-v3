// PS-497 Slice 2 Release B (S2.5, Hermes #6c) — occurrence supersession proven against REAL PostgreSQL 17,
// including the concurrency the accepted map required: rollback atomicity, competing supersession, and
// executor-versus-supersession contention. Two independent connections drive genuine concurrency; the FOR
// UPDATE lock on the occurrence serializes them into a single authoritative winner.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { applyMigrations, requireCatalog, PS497_0104_CATALOG } from './lib/migration-execution-pg.js';
import { PG17_HOSTED_TOLERANCE } from './lib/pg17-hosted-tolerance.js';
import { bootstrapForeignOwnedTables } from './ps-507-qa-stack.mjs';

const ADMIN_URL = process.env.PS497_PG17_ADMIN_URL || process.env.PS487_PG17_ADMIN_URL || process.env.PS508_PG17_ADMIN_URL;
if (!ADMIN_URL) { console.error('FAIL: PS497_PG17_ADMIN_URL not set. Unskippable.'); process.exit(1); }
const ADMIN: string = ADMIN_URL;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

process.env.NODE_ENV = 'test';
process.env.VERCEL ??= '1';
process.env.SUPABASE_URL ??= 'http://localhost';
process.env.FULFILLMENT_OCCURRENCE_EXECUTION = 'true';
process.env.INVENTORY_AUTO_DEDUCT = 'true';
process.env.FULFILLMENT_OCCURRENCE_SCOPE_MODE = 'broad';
process.env.FULFILLMENT_OCCURRENCE_SCOPE_CLIENT_IDS = '7';

async function migrateAll(sql: postgres.Sql): Promise<void> {
  // PS-510: the canonical owner plans and applies the chain. This caller no longer walks the
  // migration directory, no longer rewrites CONCURRENTLY, and no longer swallows errors.
  // CONCURRENTLY statements are executed outside a transaction as written.
  // 0088/0089/0092/0102 extend `returns`, a Client-Portal-owned table this repo does not
  // create. On a bare PG17 server it does not exist, so those migrations fail with 42P01.
  // Creating it here is what ps-494 and ps-508 already do. The alternative — tolerating the
  // failure — would SKIP four real migrations and leave the schema incomplete, which is the
  // defect PS-510 exists to remove.
  await bootstrapForeignOwnedTables({ exec: (text: string) => sql.unsafe(text) }, () => {});
  await applyMigrations({
    sql,
    dir: path.join(REPO_ROOT, 'drizzle'),
    tolerate: PG17_HOSTED_TOLERANCE,
  });
  // The schema gate runs BEFORE any behaviour assertion below. Asserting behaviour against a
  // schema-fidelity-compromised database is the defect PS-510 exists to remove.
  await requireCatalog(sql, PS497_0104_CATALOG);
}

async function main(): Promise<void> {
  const hard = setTimeout(() => { console.error('HANG: exceeded 180s'); process.exit(3); }, 180_000);
  hard.unref();
  const admin = postgres(ADMIN, { max: 1, prepare: false, onnotice: () => {} });
  const [ver] = await admin<{ v: number }[]>`select current_setting('server_version_num')::int as v`;
  const v = Number(ver?.v ?? 0);
  if (v < 170000 || v >= 180000) { console.error(`FAIL: not PG17 (${v})`); await admin.end({ timeout: 5 }); process.exit(1); }
  const dbName = `ps497_supersede_${v}_${process.pid}`;
  await admin.unsafe(`drop database if exists "${dbName}" with (force)`);
  await admin.unsafe(`create database "${dbName}"`);
  const base = ADMIN.replace(/\/[^/]*$/, `/${dbName}`);
  const raw = postgres(base, { max: 1, prepare: false, onnotice: () => {} });
  await migrateAll(raw);

  process.env.DATABASE_URL = base;
  const schema = await import('../src/db/schema/index.js');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  // Two independent connections for genuine concurrency (each its own postgres-js socket).
  const rawA = postgres(base, { max: 1, prepare: false, onnotice: () => {} });
  const rawB = postgres(base, { max: 1, prepare: false, onnotice: () => {} });
  const dbA = drizzle(rawA as never, { schema, casing: 'snake_case' });
  const dbB = drizzle(rawB as never, { schema, casing: 'snake_case' });
  const { supersedeFulfillmentOccurrence } = await import('../src/services/fulfillment/supersede-fulfillment-occurrence.js');
  const { applyOccurrenceClaims } = await import('../src/services/fulfillment-deductions.js');

  let passed = 0;
  const ok = (m: string) => { passed += 1; console.log('ok   ' + m); };
  const occSuperseded = async (id: number) => (await raw<{ s: number | null }[]>`select superseded_by_occurrence_id as s from fulfillment_occurrences where id = ${id}`)[0]?.s ?? null;
  const claimStatuses = async (occId: number): Promise<string[]> => {
    const rows = await raw<{ status: string }[]>`select status from fulfillment_line_claims where occurrence_id = ${occId} order by id`;
    return rows.map((r) => r.status);
  };
  const ledgerQty = async (sku: string) => (await raw<{ s: number }[]>`select coalesce(sum(l.qty),0)::int as s from inventory_ledger l join inventory i on i.id = l.inventory_id where lower(i.sku) = lower(${sku})`)[0]?.s ?? 0;

  await raw`insert into clients (id, name, is_test) values (7, 'Real', false)`;
  await raw`insert into inventory (client_id, sku, name, active) values (7, 'A', 'A', true)`;

  const seedOcc = async (occId: number, orderId: number, orderExists = false) => {
    if (!orderExists) await raw`insert into orders (id, client_id, store_id, order_status, order_number) values (${orderId}, 7, 3, 'shipped', ${'ORD-' + orderId})`;
    await raw`insert into fulfillment_occurrences (id, order_id, occurrence_key, discriminator_kind, first_seen_source, effective_at) values (${occId}, ${orderId}, ${'occ-' + occId}, 'provider_shipment', 's', now())`;
    await raw`insert into order_lifecycle_events (id, order_id, command_key, transition, source, effective_at, occurrence_id) values (${occId}, ${orderId}, ${'ck:' + occId}, 'shipped', 't', now(), ${occId})`;
  };
  const seedClaim = async (occId: number, orderId: number, status: string) => {
    await raw`insert into fulfillment_line_claims (lifecycle_event_id, order_id, line_key, sku, name, quantity, direction, status, supply, occurrence_id, canonical_line_identity, idempotency_key)
      values (${occId}, ${orderId}, ${'sku:A:' + status}, 'A', 'A', 2, 'deduct', ${status}, 'prepship', ${occId}, ${'sku:A:' + status}, ${'inventory:deduct:occ:' + occId + ':line:sku:A:' + status})`;
  };

  // 1) basic supersession: unapplied claims transition; superseded_by set.
  await seedOcc(100, 1); await seedOcc(101, 1, true);
  await seedClaim(100, 1, 'pending'); await seedClaim(100, 1, 'review');
  const r1 = await dbA.transaction((tx) => supersedeFulfillmentOccurrence(tx, { orderId: 1, fromOccurrenceId: 100, toOccurrenceId: 101 }));
  assert.equal(r1.supersededClaims, 2);
  assert.equal(await occSuperseded(100), 101);
  assert.deepEqual((await claimStatuses(100)).sort(), ['superseded', 'superseded']);
  ok('basic supersession: unapplied claims -> superseded, superseded_by set');

  // 2) refuse when a projected claim is already applied (would strand an executed movement).
  await seedOcc(110, 2); await seedOcc(111, 2, true);
  await seedClaim(110, 2, 'applied');
  await assert.rejects(dbA.transaction((tx) => supersedeFulfillmentOccurrence(tx, { orderId: 2, fromOccurrenceId: 110, toOccurrenceId: 111 })), /applied \(executed\) claim/);
  assert.equal(await occSuperseded(110), null, 'refused supersession left the occurrence untouched');
  ok('refuse supersession of an occurrence with an applied claim');

  // 3) self-supersession refused.
  await assert.rejects(dbA.transaction((tx) => supersedeFulfillmentOccurrence(tx, { orderId: 1, fromOccurrenceId: 101, toOccurrenceId: 101 })), /with itself/);
  ok('self-supersession refused');

  // 4) cross-order refused.
  await seedOcc(120, 3); await seedOcc(130, 4);
  await assert.rejects(dbA.transaction((tx) => supersedeFulfillmentOccurrence(tx, { orderId: 3, fromOccurrenceId: 120, toOccurrenceId: 130 })), /spans orders/);
  ok('cross-order supersession refused');

  // 5) cycle refused: 140 superseded_by 141 already; superseding 141 by 140 would cycle.
  await seedOcc(140, 5); await seedOcc(141, 5, true);
  await raw`update fulfillment_occurrences set superseded_by_occurrence_id = 141 where id = 140`;
  await assert.rejects(dbA.transaction((tx) => supersedeFulfillmentOccurrence(tx, { orderId: 5, fromOccurrenceId: 141, toOccurrenceId: 140 })), /cycle/);
  ok('cycle supersession refused');

  // 6) rollback atomicity: supersede then throw -> occurrence flag + claim transitions roll back together.
  await seedOcc(150, 6); await seedOcc(151, 6, true);
  await seedClaim(150, 6, 'pending');
  await assert.rejects(dbA.transaction(async (tx) => {
    await supersedeFulfillmentOccurrence(tx, { orderId: 6, fromOccurrenceId: 150, toOccurrenceId: 151 });
    throw new Error('boom after supersede');
  }), /boom after supersede/);
  assert.equal(await occSuperseded(150), null, 'superseded_by rolled back');
  assert.deepEqual(await claimStatuses(150), ['pending'], 'claim transition rolled back');
  ok('rollback atomicity: superseded_by + claim transitions roll back together');

  // 7) competing supersession: two concurrent supersedes of the SAME `from` (different `to`) -> exactly one wins.
  await seedOcc(160, 7); await seedOcc(161, 7, true); await seedOcc(162, 7, true);
  await seedClaim(160, 7, 'pending');
  const results = await Promise.allSettled([
    dbA.transaction((tx) => supersedeFulfillmentOccurrence(tx, { orderId: 7, fromOccurrenceId: 160, toOccurrenceId: 161 })),
    dbB.transaction((tx) => supersedeFulfillmentOccurrence(tx, { orderId: 7, fromOccurrenceId: 160, toOccurrenceId: 162 })),
  ]);
  const wins = results.filter((r) => r.status === 'fulfilled').length;
  const losses = results.filter((r) => r.status === 'rejected').length;
  assert.equal(wins, 1, `exactly one supersession wins (got ${wins})`);
  assert.equal(losses, 1, 'the loser refuses (already superseded), never last-writer-wins');
  assert.deepEqual(await claimStatuses(160), ['superseded'], 'the single winner transitioned the claim exactly once');
  ok('competing supersession -> exactly one authoritative winner, the loser refuses');

  // 8) executor-vs-supersession contention: mutually exclusive — never a movement AND a superseded claim.
  await seedOcc(170, 8); await seedOcc(171, 8, true);
  await seedClaim(170, 8, 'pending');
  const before = await ledgerQty('A');
  const contended = await Promise.allSettled([
    applyOccurrenceClaims(170, dbA as never),
    dbB.transaction((tx) => supersedeFulfillmentOccurrence(tx, { orderId: 8, fromOccurrenceId: 170, toOccurrenceId: 171 })),
  ]);
  const moved = (await ledgerQty('A')) - before;
  const finalClaim = (await claimStatuses(170))[0];
  // Either the executor won (moved -2, claim applied, supersession refused-applied) OR supersession won
  // (claim superseded, no movement). NEVER both a movement and a superseded claim.
  const executorWon = moved === -2 && finalClaim === 'applied';
  const supersessionWon = moved === 0 && finalClaim === 'superseded';
  assert.ok(executorWon || supersessionWon, `mutually exclusive outcome (moved=${moved}, claim=${finalClaim}, results=${JSON.stringify(contended.map((r) => r.status))})`);
  assert.ok(!(moved !== 0 && finalClaim === 'superseded'), 'never a movement AND a superseded claim');
  ok(`executor-vs-supersession contention -> mutually exclusive (${executorWon ? 'executor won' : 'supersession won'})`);

  clearTimeout(hard);
  await Promise.all([raw.end({ timeout: 5 }), rawA.end({ timeout: 5 }), rawB.end({ timeout: 5 })]);
  await admin.unsafe(`drop database "${dbName}" with (force)`);
  await admin.end({ timeout: 5 });
  console.log(`\nPASS PS-497 supersession contention/rollback (PostgreSQL ${v}) — ${passed}/${passed} checks`);
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });
