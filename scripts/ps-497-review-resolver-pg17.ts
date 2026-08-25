// PS-497 Slice 2 Release B (S2.6, Hermes #3) — the operator review-resolver proven against REAL PostgreSQL 17.
// The resolver RE-DERIVES canonical evidence + sole-outbound under the lock (never hardcodes), verifies
// claim/occurrence/order identity agreement, and either promotes review->pending (minting a deduped occurrence
// intent in the SAME transaction) or terminally marks not_applicable. Matrix: valid review->pending; a
// whole-order fallback that is no longer sole-outbound REFUSES; external/unknown supply REFUSE; a cross-order
// malformed claim REFUSES; a superseded occurrence REFUSES; a historical (occurrence_id NULL) claim REFUSES; a
// duplicate resolve is safe; and the status transition + occurrence-intent insert roll back together.
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

  // Seed one review claim on a fresh order+occurrence. Returns the claim id.
  const seedReview = async (args: { orderId: number; occId: number; kind: string; supply?: string; sku?: string | null; occOrderId?: number }): Promise<number> => {
    await raw`insert into orders (id, client_id, store_id, order_status, order_number) values (${args.orderId}, 7, 3, 'shipped', ${'ORD-' + args.orderId})`;
    await raw`insert into fulfillment_occurrences (id, order_id, occurrence_key, discriminator_kind, first_seen_source, effective_at) values (${args.occId}, ${args.occOrderId ?? args.orderId}, ${'occ-' + args.occId}, ${args.kind}, 's', now())`;
    await raw`insert into order_lifecycle_events (id, order_id, command_key, transition, source, effective_at, occurrence_id) values (${args.occId}, ${args.orderId}, ${'ck:' + args.occId}, 'shipped', 't', now(), ${args.occId})`;
    const [row] = await raw<{ id: number }[]>`insert into fulfillment_line_claims (lifecycle_event_id, order_id, line_key, sku, name, quantity, direction, status, supply, occurrence_id, canonical_line_identity, idempotency_key)
      values (${args.occId}, ${args.orderId}, 'sku:A', ${args.sku === undefined ? 'A' : args.sku}, 'A', 2, 'deduct', 'review', ${args.supply ?? 'prepship'}, ${args.occId}, 'sku:A', ${'inventory:deduct:occ:' + args.occId + ':line:sku:A'}) returning id`;
    return row!.id;
  };

  // 1) valid review -> pending: shipment-backed occurrence (exact evidence) -> promoted + one intent minted.
  const c1 = await seedReview({ orderId: 1, occId: 10, kind: 'provider_shipment' });
  const r1 = await resolve(c1, 'pending');
  assert.equal(r1.status, 'pending');
  assert.equal(await claimStatus(c1), 'pending');
  assert.equal(await intents(10), 1, 'a deduped occurrence intent is minted in the same transaction');
  ok('valid review (shipment-backed) -> pending + one occurrence intent minted');

  // 2) whole-order fallback that is NO LONGER sole-outbound -> REFUSE (recomputed sole-outbound = false).
  const c2 = await seedReview({ orderId: 2, occId: 20, kind: 'whole_order' });
  await raw`insert into fulfillment_occurrences (id, order_id, occurrence_key, discriminator_kind, first_seen_source, effective_at) values (21, 2, 'occ-21-other-active', 'provider_shipment', 's', now())`;
  await assert.rejects(resolve(c2, 'pending'), /deductible predicate/, 'a non-sole whole-order fallback must refuse');
  assert.equal(await claimStatus(c2), 'review', 'the refused claim stays review');
  assert.equal(await intents(20), 0, 'no intent minted for the refused promotion');
  ok('whole-order fallback that is no longer sole-outbound -> REFUSE, claim stays review, no intent');

  // 3) external supply -> REFUSE.
  const c3 = await seedReview({ orderId: 3, occId: 30, kind: 'provider_shipment', supply: 'external' });
  await assert.rejects(resolve(c3, 'pending'), /only a prepship claim/);
  ok('external supply -> REFUSE promotion to pending');

  // 4) unknown supply -> REFUSE.
  const c4 = await seedReview({ orderId: 4, occId: 40, kind: 'provider_shipment', supply: 'unknown' });
  await assert.rejects(resolve(c4, 'pending'), /only a prepship claim/);
  ok('unknown supply -> REFUSE promotion to pending');

  // 5) cross-order malformed: the claim's occurrence points at a DIFFERENT order -> REFUSE before scope.
  await raw`insert into orders (id, client_id, store_id, order_status, order_number) values (999, 7, 3, 'shipped', 'ORD-999')`;
  const c5 = await seedReview({ orderId: 5, occId: 50, kind: 'provider_shipment', occOrderId: 999 });
  await assert.rejects(resolve(c5, 'pending'), /disagrees with occurrence/);
  ok('cross-order malformed (claim.order != occurrence.order) -> REFUSE');

  // 6) superseded occurrence -> REFUSE.
  const c6 = await seedReview({ orderId: 6, occId: 60, kind: 'provider_shipment' });
  await raw`insert into fulfillment_occurrences (id, order_id, occurrence_key, discriminator_kind, first_seen_source, effective_at) values (61, 6, 'occ-61', 'provider_shipment', 's', now())`;
  await raw`update fulfillment_occurrences set superseded_by_occurrence_id = 61 where id = 60`;
  await assert.rejects(resolve(c6, 'pending'), /superseded/);
  ok('superseded occurrence -> REFUSE');

  // 7) historical claim (occurrence_id NULL) -> REFUSE (the fenced backlog).
  await raw`insert into orders (id, client_id, store_id, order_status, order_number) values (7, 7, 3, 'shipped', 'ORD-7')`;
  await raw`insert into order_lifecycle_events (id, order_id, command_key, transition, source, effective_at, occurrence_id) values (7000, 7, 'ck:7000', 'shipped', 't', now(), NULL)`;
  const [c7row] = await raw<{ id: number }[]>`insert into fulfillment_line_claims (lifecycle_event_id, order_id, line_key, sku, name, quantity, direction, status, supply, occurrence_id, canonical_line_identity, idempotency_key)
    values (7000, 7, 'sku:A', 'A', 'A', 2, 'deduct', 'review', 'prepship', NULL, NULL, 'inventory:deduct:lifecycle:7:line:sku:A') returning id`;
  await assert.rejects(resolve(c7row!.id, 'pending'), /no occurrence identity/);
  ok('historical claim (occurrence_id NULL) -> REFUSE (fenced backlog)');

  // 8) duplicate resolve: the second call sees status!=review and refuses; the intent stays deduped at one.
  await assert.rejects(resolve(c1, 'pending'), /is pending, not review/);
  assert.equal(await intents(10), 1, 'duplicate resolve does not mint a second intent');
  ok('duplicate resolve -> REFUSE (not review), intent stays deduped at one');

  // 9) atomicity: the status transition + the occurrence-intent insert roll back together.
  const c9 = await seedReview({ orderId: 9, occId: 90, kind: 'provider_shipment' });
  await assert.rejects(
    db.transaction(async (tx) => {
      await resolveOccurrenceReviewClaim(tx as never, { claimId: c9, decision: 'pending', operator: { email: 'op@x' } });
      throw new Error('boom after resolve');
    }),
    /boom after resolve/,
  );
  assert.equal(await claimStatus(c9), 'review', 'the claim rolled back to review');
  assert.equal(await intents(90), 0, 'the occurrence intent rolled back with the status transition');
  ok('atomicity: status transition + occurrence-intent insert roll back together');

  // 10) not_applicable decision -> terminal, no intent.
  const c10 = await seedReview({ orderId: 11, occId: 110, kind: 'provider_shipment' });
  const r10 = await resolve(c10, 'not_applicable');
  assert.equal(r10.status, 'not_applicable');
  assert.equal(await claimStatus(c10), 'not_applicable');
  assert.equal(await intents(110), 0, 'not_applicable mints no intent');
  ok('not_applicable decision -> terminal, no intent');

  clearTimeout(hard);
  await raw.end({ timeout: 5 });
  await admin.unsafe(`drop database "${dbName}" with (force)`);
  await admin.end({ timeout: 5 });
  console.log(`\nPASS PS-497 review resolver (PostgreSQL ${v}) — ${passed}/${passed} checks`);
  void db;
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });
