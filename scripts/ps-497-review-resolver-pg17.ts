// PS-497 Slice 2 Release B (S2.6, Hermes #3 corrective) — the operator review-resolver proven against REAL
// PostgreSQL 17. The resolver reads the AUTHORITATIVE line-evidence the owner persisted on the immutable
// lifecycle event (exact_shipment vs whole_order_fallback) — it NEVER infers evidence from the occurrence
// discriminator — and recomputes sole-outbound over the CANONICAL active outbound SHIPMENTS set (the same
// predicate the owner uses), under the order lock, so a second live shipment that has not yet produced an
// occurrence still makes a whole-order fallback not-sole. Matrix incl. Hermes's required counterexamples:
// a provider_shipment occurrence carrying whole-order fallback evidence; a second active shipment with no
// occurrence row; a voided shipment; concurrent second-shipment creation vs promotion; and true exact evidence
// on a split remaining eligible.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

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
  const dir = path.join(REPO_ROOT, 'drizzle');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const body = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const raw of body.split('--> statement-breakpoint')) {
      let stmt = raw.trim();
      if (!stmt) continue;
      stmt = stmt.replace(/CREATE\s+INDEX\s+CONCURRENTLY/gi, 'CREATE INDEX').replace(/DROP\s+INDEX\s+CONCURRENTLY/gi, 'DROP INDEX');
      try { await sql.unsafe(stmt); } catch { /* supabase artefacts non-fatal */ }
    }
  }
}

async function main(): Promise<void> {
  const hard = setTimeout(() => { console.error('HANG: exceeded 180s'); process.exit(3); }, 180_000);
  hard.unref();
  const admin = postgres(ADMIN, { max: 1, prepare: false, onnotice: () => {} });
  const [ver] = await admin<{ v: number }[]>`select current_setting('server_version_num')::int as v`;
  const v = Number(ver?.v ?? 0);
  if (v < 170000 || v >= 180000) { console.error(`FAIL: not PG17 (${v})`); await admin.end({ timeout: 5 }); process.exit(1); }
  const dbName = `ps497_review_${v}_${process.pid}`;
  await admin.unsafe(`drop database if exists "${dbName}" with (force)`);
  await admin.unsafe(`create database "${dbName}"`);
  const base = ADMIN.replace(/\/[^/]*$/, `/${dbName}`);
  const raw = postgres(base, { max: 1, prepare: false, onnotice: () => {} });
  await migrateAll(raw);

  process.env.DATABASE_URL = base;
  const { db } = await import('../src/db/client.js');
  const schema = await import('../src/db/schema/index.js');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { resolveOccurrenceReviewClaim } = await import('../src/services/fulfillment/resolve-occurrence-review.js');
  const OCC_EVENT = 'fulfillment_occurrence_deduction_requested';

  let passed = 0;
  const ok = (m: string) => { passed += 1; console.log('ok   ' + m); };
  const resolve = (claimId: number, decision: 'pending' | 'not_applicable') =>
    db.transaction((tx) => resolveOccurrenceReviewClaim(tx as never, { claimId, decision, operator: { email: 'op@x' } }));
  const claimStatus = async (id: number) => (await raw<{ status: string }[]>`select status from fulfillment_line_claims where id = ${id}`)[0]?.status;
  const intents = async (occId: number) => (await raw<{ n: number }[]>`select count(*)::int as n from fulfillment_outbox where event_type = ${OCC_EVENT} and (payload->>'occurrenceId')::int = ${occId}`)[0]?.n ?? 0;

  await raw`insert into clients (id, name, is_test) values (7, 'Real', false)`;
  await raw`insert into inventory (client_id, sku, name, active) values (7, 'A', 'A', true)`;

  const seedShipment = (id: number, orderId: number, opts: { voided?: boolean; isReturn?: boolean } = {}) =>
    raw`insert into shipments (id, order_id, voided, is_return, label_shipment_id, source) values (${id}, ${orderId}, ${opts.voided ?? false}, ${opts.isReturn ?? false}, ${id}, 'shipstation')`;

  // Seed one review claim (+ its order, shipment, occurrence, and the immutable lifecycle event carrying the
  // AUTHORITATIVE evidence). Returns the claim id.
  const seedReview = async (a: {
    orderId: number; occId: number; shipmentId: number | null;
    evidence: 'exact_shipment' | 'whole_order_fallback' | 'unavailable' | null;
    supply?: string; sku?: string | null; discriminator?: string; occOrderId?: number; occShipmentId?: number | null;
  }): Promise<number> => {
    await raw`insert into orders (id, client_id, store_id, order_status, order_number) values (${a.orderId}, 7, 3, 'shipped', ${'ORD-' + a.orderId})`;
    if (a.shipmentId != null) await seedShipment(a.shipmentId, a.orderId);
    const occShip = a.occShipmentId === undefined ? a.shipmentId : a.occShipmentId;
    await raw`insert into fulfillment_occurrences (id, order_id, shipment_id, occurrence_key, discriminator_kind, first_seen_source, effective_at)
      values (${a.occId}, ${a.occOrderId ?? a.orderId}, ${occShip}, ${'occ-' + a.occId}, ${a.discriminator ?? 'provider_shipment'}, 's', now())`;
    const provenance = a.evidence == null ? '{}' : JSON.stringify({ ps497LineEvidence: a.evidence });
    await raw`insert into order_lifecycle_events (id, order_id, shipment_id, command_key, transition, source, provenance, effective_at, occurrence_id)
      values (${a.occId}, ${a.orderId}, ${a.shipmentId}, ${'ck:' + a.occId}, 'shipped', 't', ${provenance}::jsonb, now(), ${a.occId})`;
    const [row] = await raw<{ id: number }[]>`insert into fulfillment_line_claims (lifecycle_event_id, order_id, shipment_id, line_key, sku, name, quantity, direction, status, supply, occurrence_id, canonical_line_identity, idempotency_key)
      values (${a.occId}, ${a.orderId}, ${a.shipmentId}, 'sku:A', ${a.sku === undefined ? 'A' : a.sku}, 'A', 2, 'deduct', 'review', ${a.supply ?? 'prepship'}, ${a.occId}, 'sku:A', ${'inventory:deduct:occ:' + a.occId + ':line:sku:A'}) returning id`;
    return row!.id;
  };

  // 1) exact_shipment evidence, sole shipment -> pending + one intent.
  const c1 = await seedReview({ orderId: 1, occId: 10, shipmentId: 100, evidence: 'exact_shipment' });
  const r1 = await resolve(c1, 'pending');
  assert.equal(r1.status, 'pending');
  assert.equal(await claimStatus(c1), 'pending');
  assert.equal(await intents(10), 1, 'a deduped occurrence intent is minted in the same transaction');
  ok('exact_shipment evidence -> pending + one occurrence intent minted');

  // 2) whole_order_fallback that IS the sole active outbound shipment -> pending.
  const c2 = await seedReview({ orderId: 2, occId: 20, shipmentId: 200, evidence: 'whole_order_fallback' });
  const r2 = await resolve(c2, 'pending');
  assert.equal(r2.status, 'pending');
  ok('whole_order_fallback that is sole-outbound -> pending');

  // 3) whole_order_fallback + a 2nd active shipment (with its own occurrence) -> REFUSE.
  const c3 = await seedReview({ orderId: 3, occId: 30, shipmentId: 300, evidence: 'whole_order_fallback' });
  await seedShipment(301, 3);
  await raw`insert into fulfillment_occurrences (id, order_id, shipment_id, occurrence_key, discriminator_kind, first_seen_source, effective_at) values (31, 3, 301, 'occ-31', 'provider_shipment', 's', now())`;
  await assert.rejects(resolve(c3, 'pending'), /deductible predicate/);
  assert.equal(await claimStatus(c3), 'review');
  assert.equal(await intents(30), 0);
  ok('whole_order_fallback + a second active shipment -> REFUSE, stays review, no intent');

  // 4) external supply -> REFUSE. 5) unknown supply -> REFUSE.
  const c4 = await seedReview({ orderId: 4, occId: 40, shipmentId: 400, evidence: 'exact_shipment', supply: 'external' });
  await assert.rejects(resolve(c4, 'pending'), /only a prepship claim/);
  ok('external supply -> REFUSE');
  const c5 = await seedReview({ orderId: 5, occId: 50, shipmentId: 500, evidence: 'exact_shipment', supply: 'unknown' });
  await assert.rejects(resolve(c5, 'pending'), /only a prepship claim/);
  ok('unknown supply -> REFUSE');

  // 6) cross-order malformed occurrence -> REFUSE.
  await raw`insert into orders (id, client_id, store_id, order_status, order_number) values (998, 7, 3, 'shipped', 'ORD-998')`;
  const c6 = await seedReview({ orderId: 6, occId: 60, shipmentId: 600, evidence: 'exact_shipment', occOrderId: 998, occShipmentId: null });
  await assert.rejects(resolve(c6, 'pending'), /disagrees with occurrence/);
  ok('cross-order malformed -> REFUSE');

  // 7) superseded occurrence -> REFUSE.
  const c7 = await seedReview({ orderId: 7, occId: 70, shipmentId: 700, evidence: 'exact_shipment' });
  await raw`insert into fulfillment_occurrences (id, order_id, occurrence_key, discriminator_kind, first_seen_source, effective_at) values (71, 7, 'occ-71', 'provider_shipment', 's', now())`;
  await raw`update fulfillment_occurrences set superseded_by_occurrence_id = 71 where id = 70`;
  await assert.rejects(resolve(c7, 'pending'), /superseded/);
  ok('superseded occurrence -> REFUSE');

  // 8) historical claim (occurrence_id NULL) -> REFUSE.
  await raw`insert into orders (id, client_id, store_id, order_status, order_number) values (8, 7, 3, 'shipped', 'ORD-8')`;
  await raw`insert into order_lifecycle_events (id, order_id, command_key, transition, source, effective_at, occurrence_id) values (8000, 8, 'ck:8000', 'shipped', 't', now(), NULL)`;
  const [c8row] = await raw<{ id: number }[]>`insert into fulfillment_line_claims (lifecycle_event_id, order_id, line_key, sku, name, quantity, direction, status, supply, occurrence_id, canonical_line_identity, idempotency_key)
    values (8000, 8, 'sku:A', 'A', 'A', 2, 'deduct', 'review', 'prepship', NULL, NULL, 'inventory:deduct:lifecycle:8:line:sku:A') returning id`;
  await assert.rejects(resolve(c8row!.id, 'pending'), /no occurrence identity/);
  ok('historical claim (occurrence_id NULL) -> REFUSE');

  // 9) duplicate resolve -> REFUSE (not review), intent stays deduped.
  await assert.rejects(resolve(c1, 'pending'), /is pending, not review/);
  assert.equal(await intents(10), 1, 'duplicate resolve does not mint a second intent');
  ok('duplicate resolve -> REFUSE, intent stays deduped at one');

  // 10) atomicity: status transition + occurrence-intent insert roll back together.
  const c10 = await seedReview({ orderId: 11, occId: 110, shipmentId: 1100, evidence: 'exact_shipment' });
  await assert.rejects(
    db.transaction(async (tx) => {
      await resolveOccurrenceReviewClaim(tx as never, { claimId: c10, decision: 'pending', operator: { email: 'op@x' } });
      throw new Error('boom after resolve');
    }),
    /boom after resolve/,
  );
  assert.equal(await claimStatus(c10), 'review');
  assert.equal(await intents(110), 0);
  ok('atomicity: status transition + occurrence-intent insert roll back together');

  // 11) not_applicable -> terminal, no intent.
  const c11 = await seedReview({ orderId: 12, occId: 120, shipmentId: 1200, evidence: 'exact_shipment' });
  const r11 = await resolve(c11, 'not_applicable');
  assert.equal(r11.status, 'not_applicable');
  assert.equal(await claimStatus(c11), 'not_applicable');
  assert.equal(await intents(120), 0);
  ok('not_applicable -> terminal, no intent');

  // ── Hermes #3 counterexamples ─────────────────────────────────────────────────────────────────────────────
  // 12) provider_shipment occurrence carrying WHOLE-ORDER FALLBACK evidence + a 2nd active shipment -> the
  //     resolver uses the PERSISTED evidence (fallback), NOT the discriminator (provider_shipment) -> not sole
  //     -> REFUSE. (Inferring from the discriminator would have wrongly promoted this as exact.)
  const c12 = await seedReview({ orderId: 13, occId: 130, shipmentId: 1300, evidence: 'whole_order_fallback', discriminator: 'provider_shipment' });
  await seedShipment(1301, 13);
  await assert.rejects(resolve(c12, 'pending'), /deductible predicate/);
  assert.equal(await claimStatus(c12), 'review');
  ok('provider_shipment occurrence + whole_order_fallback evidence + 2nd shipment -> REFUSE (evidence not inferred from discriminator)');

  // 13) 2nd active shipment with NO occurrence row -> the SHIPMENTS-based check sees 2 live shipments -> REFUSE.
  //     An occurrence COUNT would have wrongly said sole (only one occurrence exists).
  const c13 = await seedReview({ orderId: 14, occId: 140, shipmentId: 1400, evidence: 'whole_order_fallback' });
  await seedShipment(1401, 14); // live, but NO occurrence row
  const occCount14 = (await raw<{ n: number }[]>`select count(*)::int as n from fulfillment_occurrences where order_id = 14`)[0]?.n ?? 0;
  assert.equal(occCount14, 1, 'only one occurrence exists (the counterexample an occurrence-count would miss)');
  await assert.rejects(resolve(c13, 'pending'), /deductible predicate/);
  ok('second active shipment with NO occurrence row -> REFUSE (canonical shipments set, not occurrence count)');

  // 14) the claim's own shipment is VOIDED -> not in the active outbound set -> not sole -> REFUSE.
  const c14 = await seedReview({ orderId: 15, occId: 150, shipmentId: 1500, evidence: 'whole_order_fallback' });
  await raw`update shipments set voided = true where id = 1500`;
  await assert.rejects(resolve(c14, 'pending'), /deductible predicate/);
  ok('voided own shipment -> not sole-outbound -> REFUSE');

  // 15) TRUE exact_shipment evidence on a SPLIT (2 active shipments) -> exact deducts even for a split -> PROMOTES.
  const c15 = await seedReview({ orderId: 16, occId: 160, shipmentId: 1600, evidence: 'exact_shipment' });
  await seedShipment(1601, 16); // a second active shipment (a split)
  const r15 = await resolve(c15, 'pending');
  assert.equal(r15.status, 'pending', 'exact shipment evidence stays eligible even on a split');
  assert.equal(await intents(160), 1);
  ok('true exact_shipment evidence on a split -> still eligible, promotes + intent');

  // 16) evidence NOT recorded on the lifecycle event -> fail closed.
  const c16 = await seedReview({ orderId: 17, occId: 170, shipmentId: 1700, evidence: null });
  await assert.rejects(resolve(c16, 'pending'), /no recorded line evidence/);
  ok('no recorded line evidence -> fail closed (REFUSE)');

  // 17) concurrency: a second shipment inserted under the ORDER lock cannot race promotion. B holds the order
  //     lock and inserts a 2nd shipment; A's promotion BLOCKS on the order lock, then after B commits A re-reads
  //     the shipments set (now 2) and REFUSES. Proves the lock/recheck closes the race (Hermes #3).
  const c17 = await seedReview({ orderId: 18, occId: 180, shipmentId: 1800, evidence: 'whole_order_fallback' });
  const rawB = postgres(base, { max: 1, prepare: false, onnotice: () => {} });
  const dbA = drizzle(postgres(base, { max: 1, prepare: false, onnotice: () => {} }) as never, { schema, casing: 'snake_case' });
  let releaseB!: () => void;
  const bGate = new Promise<void>((r) => { releaseB = r; });
  const bHeld = rawB.begin(async (sql) => {
    await sql`select id from orders where id = 18 for update`;
    await sql`insert into shipments (id, order_id, voided, is_return, label_shipment_id, source) values (1801, 18, false, false, 1801, 'shipstation')`;
    await bGate; // hold the order lock open until signaled
  });
  await new Promise((r) => setTimeout(r, 250)); // let B acquire the lock
  const aPromise = dbA.transaction((tx) => resolveOccurrenceReviewClaim(tx as never, { claimId: c17, decision: 'pending', operator: { email: 'op@x' } }));
  const aSettled = assert.rejects(aPromise, /deductible predicate/); // A blocks, then refuses after B commits
  await new Promise((r) => setTimeout(r, 250)); // A is now blocked on the order lock
  releaseB();
  await bHeld;
  await aSettled;
  assert.equal(await claimStatus(c17), 'review', 'the raced promotion refused, claim stays review');
  await rawB.end({ timeout: 5 });
  ok('concurrent second-shipment creation vs promotion -> order lock serializes; promotion REFUSES (no race)');

  clearTimeout(hard);
  await raw.end({ timeout: 5 });
  await admin.unsafe(`drop database "${dbName}" with (force)`);
  await admin.end({ timeout: 5 });
  console.log(`\nPASS PS-497 review resolver (PostgreSQL ${v}) — ${passed}/${passed} checks`);
  void db;
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });
