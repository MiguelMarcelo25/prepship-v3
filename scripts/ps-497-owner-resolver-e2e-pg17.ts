// PS-497 Slice 2 Release B (Hermes proof-gap #3) — END-TO-END binding of owner persistence to resolver
// consumption against REAL PostgreSQL 17. It drives the PRODUCTION lifecycle owner (applyOrderLifecycleCommand)
// to create a review claim, reads back the ps497LineEvidence the REAL owner persisted on the immutable
// lifecycle event, then drives the PRODUCTION resolver (resolveOccurrenceReviewClaim) and proves fallback-vs-
// exact behavior FROM that owner-created event — not a hand-seeded provenance value.
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
process.env.FULFILLMENT_OCCURRENCE_PROJECTION = 'true';
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
  const dbName = `ps497_e2e_${v}_${process.pid}`;
  await admin.unsafe(`drop database if exists "${dbName}" with (force)`);
  await admin.unsafe(`create database "${dbName}"`);
  const base = ADMIN.replace(/\/[^/]*$/, `/${dbName}`);
  const raw = postgres(base, { max: 1, prepare: false, onnotice: () => {} });
  await migrateAll(raw);

  process.env.DATABASE_URL = base;
  const { db } = await import('../src/db/client.js');
  const { applyOrderLifecycleCommand } = await import('../src/services/order-lifecycle-command.js');
  const { resolveOccurrenceReviewClaim } = await import('../src/services/fulfillment/resolve-occurrence-review.js');
  const OCC_EVENT = 'fulfillment_occurrence_deduction_requested';

  let passed = 0;
  const ok = (m: string) => { passed += 1; console.log('ok   ' + m); };
  const resolve = (claimId: number, decision: 'pending' | 'not_applicable') =>
    db.transaction((tx) => resolveOccurrenceReviewClaim(tx as never, { claimId, decision, operator: { email: 'op@x' } }));
  const reviewClaimId = async (orderId: number) => (await raw<{ id: number }[]>`select id from fulfillment_line_claims where order_id = ${orderId} and direction = 'deduct' order by id limit 1`)[0]?.id;
  const claimStatus = async (id: number) => (await raw<{ status: string }[]>`select status from fulfillment_line_claims where id = ${id}`)[0]?.status;
  const eventEvidence = async (orderId: number) => (await raw<{ e: string | null }[]>`select provenance->>'ps497LineEvidence' as e from order_lifecycle_events where order_id = ${orderId} order by id limit 1`)[0]?.e ?? null;
  const intents = async (orderId: number) => (await raw<{ n: number }[]>`select count(*)::int as n from fulfillment_outbox where event_type = ${OCC_EVENT} and order_id = ${orderId}`)[0]?.n ?? 0;

  await raw`insert into clients (id, name, is_test) values (7, 'Real', false)`;
  await raw`insert into inventory (client_id, sku, name, active) values (7, 'A', 'A', true)`;

  // ── Case 1: FALLBACK end-to-end. Two active shipments (a split), owner ships one with whole-order-fallback
  //    evidence -> the owner persists ps497LineEvidence='whole_order_fallback' and (not-sole) lands the claim in
  //    review. The resolver reads THAT owner-persisted evidence: refuse while not-sole, promote once sole. ──
  await raw`insert into orders (id, client_id, store_id, order_status, order_number) values (1, 7, 3, 'awaiting_shipment', 'ORD-1')`;
  await raw`insert into shipments (id, order_id, voided, is_return, label_shipment_id, source) values (10, 1, false, false, 10, 'shipstation'), (11, 1, false, false, 11, 'shipstation')`;
  await applyOrderLifecycleCommand({
    orderId: 1, shipmentId: 10, commandKey: 'ck:1', transition: 'shipped', source: 'shipstation',
    fulfillmentFacts: { kind: 'exact', evidence: 'whole_order_fallback', soleOutbound: false, lines: [{ lineKey: 'sku:A', sku: 'A', name: 'A', quantity: 2 }] },
  });
  assert.equal(await eventEvidence(1), 'whole_order_fallback', 'the REAL owner persisted whole_order_fallback on the lifecycle event');
  const c1 = await reviewClaimId(1);
  assert.equal(await claimStatus(c1!), 'review', 'the owner placed the not-sole fallback claim in review');
  await assert.rejects(resolve(c1!, 'pending'), /deductible predicate/, 'resolver refuses the owner-created fallback claim while a 2nd shipment is active');
  assert.equal(await intents(1), 0);
  ok('owner-created FALLBACK event -> resolver reads owner-persisted whole_order_fallback -> refuse while not-sole');
  // Void the competing shipment -> now sole -> the resolver promotes from the SAME owner-created event.
  await raw`update shipments set voided = true where id = 11`;
  const r1 = await resolve(c1!, 'pending');
  assert.equal(r1.status, 'pending');
  assert.equal(await claimStatus(c1!), 'pending');
  assert.equal(await intents(1), 1, 'promotion mints one occurrence intent');
  ok('same owner-created FALLBACK event, now sole-outbound -> resolver promotes + mints intent');

  // ── Case 2: EXACT end-to-end. Owner ships with exact_shipment evidence -> persists ps497LineEvidence=
  //    'exact_shipment' (claim pending). Put the claim in review, add a competing shipment (a split), and prove
  //    the resolver reads the owner-persisted EXACT evidence and stays eligible even on a split. ──
  await raw`insert into orders (id, client_id, store_id, order_status, order_number) values (2, 7, 3, 'awaiting_shipment', 'ORD-2')`;
  await raw`insert into shipments (id, order_id, voided, is_return, label_shipment_id, source) values (20, 2, false, false, 20, 'shipstation')`;
  await applyOrderLifecycleCommand({
    orderId: 2, shipmentId: 20, commandKey: 'ck:2', transition: 'shipped', source: 'shipstation',
    fulfillmentFacts: { kind: 'exact', evidence: 'exact_shipment', lines: [{ lineKey: 'sku:A', sku: 'A', name: 'A', quantity: 2 }] },
  });
  assert.equal(await eventEvidence(2), 'exact_shipment', 'the REAL owner persisted exact_shipment on the lifecycle event');
  const c2 = await reviewClaimId(2);
  assert.equal(await claimStatus(c2!), 'pending', 'an exact_shipment claim is pending at the owner (never review)');
  // Put it in review to feed the resolver, and add a competing active shipment (a split).
  await raw`update fulfillment_line_claims set status = 'review' where id = ${c2!}`;
  await raw`insert into shipments (id, order_id, voided, is_return, label_shipment_id, source) values (21, 2, false, false, 21, 'shipstation')`;
  const r2 = await resolve(c2!, 'pending');
  assert.equal(r2.status, 'pending', 'the resolver reads owner-persisted exact_shipment and stays eligible even on a split');
  // The owner already minted an intent for the (pending) exact claim; the resolver mints its own review-scoped
  // intent on promotion. Assert the RESOLVER's specific intent exists (deduped by review:{claimId}).
  const reviewIntent = (await raw<{ n: number }[]>`select count(*)::int as n from fulfillment_outbox where event_type = ${OCC_EVENT} and dedupe_key like ${'%:review:' + c2}`)[0]?.n ?? 0;
  assert.equal(reviewIntent, 1, 'the resolver minted its review-scoped occurrence intent');
  ok('owner-created EXACT event -> resolver reads owner-persisted exact_shipment -> promotes even on a split');

  clearTimeout(hard);
  await raw.end({ timeout: 5 });
  await admin.unsafe(`drop database "${dbName}" with (force)`);
  await admin.end({ timeout: 5 });
  console.log(`\nPASS PS-497 owner->resolver evidence binding (PostgreSQL ${v}) — ${passed}/${passed} checks`);
  void db;
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });
