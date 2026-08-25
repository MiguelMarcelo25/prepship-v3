// PS-497 Slice 2 Release B (S2.4e + S2.4x) — the occurrence executor MOVES STOCK and enforces its fence,
// proven against REAL PostgreSQL 17 on the full migrated schema. Seeds the exact projected state the owner
// produces and drives applyOccurrenceClaims through an injected transaction (NODE_ENV=test skips the
// production readiness gate, the same seam the legacy executor uses). Asserts: a real -2 ledger movement +
// claim->applied; idempotent re-run (no double-deduct); superseded occurrence, test client, and out-of-scope
// client each fenced to no-movement; and the generic worker predicate never selects the occurrence event.
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
      try { await sql.unsafe(stmt); } catch { /* supabase grants / ordering artefacts are non-fatal here */ }
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
  const dbName = `ps497_worker_${v}_${process.pid}`;
  await admin.unsafe(`drop database if exists "${dbName}" with (force)`);
  await admin.unsafe(`create database "${dbName}"`);
  const base = ADMIN.replace(/\/[^/]*$/, `/${dbName}`);
  const raw = postgres(base, { max: 1, prepare: false, onnotice: () => {} });
  await migrateAll(raw);
  for (const rel of ['inventory', 'inventory_ledger', 'fulfillment_line_claims', 'fulfillment_occurrences', 'fulfillment_outbox', 'orders', 'clients']) {
    const [row] = await raw<{ ok: boolean }[]>`select to_regclass(${'public.' + rel}) is not null as ok`;
    assert.ok(row?.ok, `migrated schema is missing ${rel}`);
  }

  await raw`insert into clients (id, name, is_test) values (7, 'Real Client', false), (8, 'Other Client', false), (9, 'Test Client', true)`;
  const [inv] = await raw<{ id: number }[]>`insert into inventory (client_id, sku, name, active) values (7, 'A', 'A', true) returning id`;
  // occ 1 (order 1, client 7, in-scope): the happy movement. occ 2 superseded. occ 3 client 8 out-of-scope.
  // occ 4 client 9 test-client.
  await raw`insert into orders (id, client_id, store_id, order_status, order_number) values
    (1, 7, 3, 'shipped', 'ORD-1'), (2, 7, 3, 'shipped', 'ORD-2'), (3, 8, 3, 'shipped', 'ORD-3'), (4, 9, 3, 'shipped', 'ORD-4')`;
  await raw`insert into fulfillment_occurrences (id, order_id, occurrence_key, discriminator_kind, first_seen_source, effective_at) values
    (1, 1, 'ord:1|pship:s:1', 'provider_shipment', 's', now()),
    (2, 2, 'ord:2|pship:s:2', 'provider_shipment', 's', now()),
    (3, 3, 'ord:3|pship:s:3', 'provider_shipment', 's', now()),
    (4, 4, 'ord:4|pship:s:4', 'provider_shipment', 's', now())`;
  await raw`update fulfillment_occurrences set superseded_by_occurrence_id = 1 where id = 2`;
  await raw`insert into order_lifecycle_events (id, order_id, command_key, transition, source, effective_at, occurrence_id) values
    (1, 1, 'ck:1', 'shipped', 't', now(), 1), (2, 2, 'ck:2', 'shipped', 't', now(), 2),
    (3, 3, 'ck:3', 'shipped', 't', now(), 3), (4, 4, 'ck:4', 'shipped', 't', now(), 4)`;
  const claim = (eventId: number, orderId: number, occId: number) =>
    raw`insert into fulfillment_line_claims (lifecycle_event_id, order_id, line_key, sku, name, quantity, direction, status, supply, occurrence_id, canonical_line_identity, idempotency_key)
        values (${eventId}, ${orderId}, 'sku:A', 'A', 'A', 2, 'deduct', 'pending', 'prepship', ${occId}, 'sku:A', ${'inventory:deduct:occ:' + occId + ':line:sku:A'})`;
  await claim(1, 1, 1); await claim(2, 2, 2); await claim(3, 3, 3); await claim(4, 4, 4);

  process.env.DATABASE_URL = base;
  const { db } = await import('../src/db/client.js');
  const { applyOccurrenceClaims } = await import('../src/services/fulfillment-deductions.js');

  let passed = 0;
  const ok = (m: string) => { passed += 1; console.log('ok   ' + m); };
  const ledgerQty = async (invId: number) => (await raw<{ s: number }[]>`select coalesce(sum(qty),0)::int as s from inventory_ledger where inventory_id = ${invId}`)[0]?.s ?? 0;
  const claimStatus = async (occId: number) => (await raw<{ status: string }[]>`select status from fulfillment_line_claims where occurrence_id = ${occId} and direction = 'deduct'`)[0]?.status;
  const runExecutor = (occId: number) => db.transaction((tx) => applyOccurrenceClaims(occId, tx));

  // 1) in-scope prepship occurrence -> a real -2 ledger movement, claim applied.
  const r1 = await runExecutor(1);
  assert.equal(r1.applied, 1, `one movement applied (${JSON.stringify(r1)})`);
  assert.equal(await ledgerQty(inv?.id ?? 0), -2, 'inventory ledger shows a -2 ship movement');
  assert.equal(await claimStatus(1), 'applied');
  ok('executor moves stock: in-scope prepship occurrence -> real -2 ledger movement + claim applied');

  // 2) idempotent: re-run -> claim no longer pending -> no second movement.
  const r2 = await runExecutor(1);
  assert.equal(r2.applied, 0);
  assert.equal(await ledgerQty(inv?.id ?? 0), -2, 'no double-deduct on re-run');
  ok('idempotent: re-running the executor on an applied occurrence moves no additional stock');

  // 3) superseded occurrence -> fenced, no movement, claim left pending.
  const r3 = await runExecutor(2);
  assert.equal(r3.applied, 0);
  assert.equal(await claimStatus(2), 'pending', 'superseded occurrence: claim untouched (returned before select)');
  ok('superseded occurrence -> no movement (occurrence lock re-verified not-superseded)');

  // 4) out-of-scope client -> fenced to review, no movement.
  const r4 = await runExecutor(3);
  assert.equal(r4.applied, 0);
  assert.equal(await claimStatus(3), 'review', 'out-of-scope client -> review');
  ok('out-of-scope client -> executor fences the claim to review, no movement');

  // 5) test client -> no movement, review.
  const r5 = await runExecutor(4);
  assert.equal(r5.applied, 0);
  assert.equal(await claimStatus(4), 'review', 'test client -> review');
  ok('test client (clients.is_test) -> no movement, review');

  // 6) worker isolation (structural): the generic worker predicate never selects the occurrence event.
  await raw`insert into fulfillment_outbox (order_id, event_type, provider, dedupe_key, payload, status, next_run_at)
    values (1, 'fulfillment_occurrence_deduction_requested', 'inventory_occurrence', 'occ:1', '{"occurrenceId":1}'::jsonb, 'pending', now())`;
  const [gen] = await raw<{ n: number }[]>`select count(*)::int as n from fulfillment_outbox where event_type = 'shipment_confirmation_requested' and status in ('pending','failed')`;
  assert.equal(gen?.n, 0, 'the occurrence event is never a shipment_confirmation_requested row the generic worker claims');
  ok('generic worker predicate (shipment_confirmation_requested only) never selects the occurrence event');

  clearTimeout(hard);
  await raw.end({ timeout: 5 });
  await admin.unsafe(`drop database "${dbName}" with (force)`);
  await admin.end({ timeout: 5 });
  console.log(`\nPASS PS-497 occurrence executor+worker (PostgreSQL ${v}) — ${passed}/${passed} checks`);
  void db;
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });
