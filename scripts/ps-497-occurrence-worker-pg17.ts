// PS-497 Slice 2 Release B (S2.5, Hermes #2) — the FULL money path proven against REAL PostgreSQL 17:
//   canonical owner  ->  dedicated occurrence outbox intent  ->  processFulfillmentOccurrenceOutboxOnce (the
//   dedicated worker: claim query + worker-boundary scope fence + dispatch + settlement)  ->  occurrence
//   executor  ->  inventory ledger movement.
// The worker is DRIVEN (not bypassed): the earlier version called applyOccurrenceClaims directly, which Hermes
// rejected. Here the owner mints the intent, the worker claims + settles it, and only then does stock move.
// The executor's DB handle is injected (NODE_ENV=test seam) purely to skip the production
// runtime-schema-readiness catalog (which migrate-all cannot satisfy and the readiness suite covers already);
// every other step is the real worker. Asserts: owner mints exactly one occurrence intent; the worker claims
// the dedicated row, moves -2, sets the claim applied and the outbox succeeded; a rerun moves nothing more; and
// below-floor, out-of-scope, superseded, test-client, and malformed events can NEVER settle as a movement —
// scope/floor fences PARK (retryable), terminal non-movements settle without moving stock.
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
// Canary mode + a frozen floor so ONE process can exercise both the floor fence (below-floor occurrence) and
// the allowlist fence (client 8), while clients 7 and 9 are in scope.
process.env.FULFILLMENT_OCCURRENCE_SCOPE_MODE = 'canary';
process.env.FULFILLMENT_OCCURRENCE_SCOPE_CLIENT_IDS = '7,9';
process.env.FULFILLMENT_OCCURRENCE_PREPROJECTION_MAX_ID = '100';

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

  process.env.DATABASE_URL = base;
  const { db } = await import('../src/db/client.js');
  const schema = await import('../src/db/schema/index.js');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  // A SECOND drizzle instance over the same PG17 db: injected as the executor so applyOccurrenceClaims takes the
  // conn !== db + NODE_ENV=test branch (skips ensureInventoryLedgerSchema). Everything else is the real worker.
  const testDb = drizzle(raw as never, { schema, casing: 'snake_case' }) as unknown as Pick<typeof db, 'transaction'>;
  const { applyOrderLifecycleCommand } = await import('../src/services/order-lifecycle-command.js');
  const { processFulfillmentOccurrenceOutboxOnce, FULFILLMENT_OCCURRENCE_DEDUCTION_OUTBOX_EVENT } =
    await import('../src/services/fulfillment/occurrence-deduction-outbox.js');

  let passed = 0;
  const ok = (m: string) => { passed += 1; console.log('ok   ' + m); };
  const ledgerRows = async () => (await raw<{ n: number }[]>`select count(*)::int as n from inventory_ledger`)[0]?.n ?? 0;
  const ledgerQty = async (sku: string) => (await raw<{ s: number }[]>`select coalesce(sum(l.qty),0)::int as s from inventory_ledger l join inventory i on i.id = l.inventory_id where lower(i.sku) = lower(${sku})`)[0]?.s ?? 0;
  const claimStatus = async (occId: number) => (await raw<{ status: string }[]>`select status from fulfillment_line_claims where occurrence_id = ${occId} and direction = 'deduct' order by id limit 1`)[0]?.status;
  const outboxStatus = async (occId: number) => (await raw<{ status: string }[]>`select status from fulfillment_outbox where event_type = ${FULFILLMENT_OCCURRENCE_DEDUCTION_OUTBOX_EVENT} and (payload->>'occurrenceId')::int = ${occId} order by id limit 1`)[0]?.status;
  const occIntents = async (orderId: number) => (await raw<{ n: number }[]>`select count(*)::int as n from fulfillment_outbox where event_type = ${FULFILLMENT_OCCURRENCE_DEDUCTION_OUTBOX_EVENT} and order_id = ${orderId}`)[0]?.n ?? 0;

  // Clients + inventory. 7 real (in scope), 8 real (out of scope), 9 test-client (in scope).
  await raw`insert into clients (id, name, is_test) values (7, 'Real', false), (8, 'Other', false), (9, 'Test', true)`;
  await raw`insert into inventory (client_id, sku, name, active) values (7, 'A', 'A', true), (7, 'F', 'F', true), (7, 'G', 'G', true), (9, 'T', 'T', true)`;
  // Owner-created occurrences must land ABOVE the canary floor (100).
  await raw`alter sequence fulfillment_occurrences_id_seq restart with 1000`;

  // Direct-intent helper for the seeded fence cases (bypasses the owner so occurrence ids/states are exact).
  const seedOccurrenceIntent = async (args: { occId: number; orderId: number; clientId: number; sku: string }) => {
    const lineKey = 'sku:' + args.sku;
    await raw`insert into orders (id, client_id, store_id, order_status, order_number) values (${args.orderId}, ${args.clientId}, 3, 'shipped', ${'ORD-' + args.orderId})`;
    await raw`insert into fulfillment_occurrences (id, order_id, occurrence_key, discriminator_kind, first_seen_source, effective_at) values (${args.occId}, ${args.orderId}, ${'ord:' + args.orderId + '|pship:s:' + args.occId}, 'provider_shipment', 's', now())`;
    await raw`insert into order_lifecycle_events (id, order_id, command_key, transition, source, effective_at, occurrence_id) values (${args.occId}, ${args.orderId}, ${'ck:' + args.occId}, 'shipped', 't', now(), ${args.occId})`;
    await raw`insert into fulfillment_line_claims (lifecycle_event_id, order_id, line_key, sku, name, quantity, direction, status, supply, occurrence_id, canonical_line_identity, idempotency_key)
      values (${args.occId}, ${args.orderId}, ${lineKey}, ${args.sku}, ${args.sku}, 2, 'deduct', 'pending', 'prepship', ${args.occId}, ${lineKey}, ${'inventory:deduct:occ:' + args.occId + ':line:' + lineKey})`;
    await raw`insert into fulfillment_outbox (order_id, event_type, provider, dedupe_key, payload, status, next_run_at)
      values (${args.orderId}, ${FULFILLMENT_OCCURRENCE_DEDUCTION_OUTBOX_EVENT}, 'inventory_occurrence', ${FULFILLMENT_OCCURRENCE_DEDUCTION_OUTBOX_EVENT + ':occ:' + args.occId}, ${JSON.stringify({ occurrenceId: args.occId, orderId: args.orderId, source: 'seed' })}::jsonb, 'pending', now())`;
  };

  // ── 1) HAPPY PATH: owner mints the intent, the worker drains it, stock moves ──────────────────────────────
  await raw`insert into orders (id, client_id, store_id, order_status, order_number) values (1, 7, 3, 'awaiting_shipment', 'ORD-1')`;
  await raw`insert into shipments (id, order_id, voided, is_return, label_shipment_id, source) values (10, 1, false, false, 555, 'shipstation')`;
  const owned = await applyOrderLifecycleCommand({
    orderId: 1, shipmentId: 10, commandKey: 'ck:1', transition: 'shipped', source: 'shipstation',
    fulfillmentFacts: { kind: 'exact', evidence: 'exact_shipment', lines: [{ lineKey: 'sku:A', sku: 'A', name: 'A', quantity: 2 }] },
  });
  assert.equal(owned.claimCount, 1, 'owner inserted exactly one claim');
  assert.equal(await occIntents(1), 1, 'owner minted EXACTLY ONE occurrence outbox intent');
  const [occ1row] = await raw<{ occurrence_id: number }[]>`select occurrence_id from fulfillment_line_claims where order_id = 1 and direction = 'deduct' limit 1`;
  const occ1 = occ1row!.occurrence_id;
  assert.ok(occ1 >= 1000, 'owner occurrence is above the canary floor');
  ok('owner ships -> occurrence stamped + EXACTLY ONE dedicated occurrence intent minted');

  const w1 = await processFulfillmentOccurrenceOutboxOnce({ executor: testDb });
  assert.equal(w1.claimed, 1, `the dedicated worker claimed exactly one occurrence row (${JSON.stringify(w1)})`);
  assert.equal(w1.applied, 1, 'the worker reports one applied movement');
  assert.equal(await ledgerQty('A'), -2, 'the ledger shows a real -2 ship movement');
  assert.equal(await claimStatus(occ1), 'applied', 'the claim is applied');
  assert.equal(await outboxStatus(occ1), 'succeeded', 'the occurrence outbox row is succeeded');
  ok('worker drains the intent -> executor -> real -2 ledger movement, claim applied, outbox succeeded');

  // ── 2) IDEMPOTENT rerun: no second movement, row stays succeeded ──────────────────────────────────────────
  const w2 = await processFulfillmentOccurrenceOutboxOnce({ executor: testDb });
  assert.equal(w2.claimed, 0, 'nothing due on rerun (the succeeded row is not re-claimed)');
  assert.equal(await ledgerQty('A'), -2, 'no double-deduct on rerun');
  assert.equal(await outboxStatus(occ1), 'succeeded', 'the settled row stays succeeded');
  ok('rerun moves no additional stock; the settled intent is not re-claimed');

  const ledgerAfterHappy = await ledgerRows();

  // ── 3) BELOW-FLOOR occurrence: worker PARKS (retryable), never settles, never moves ───────────────────────
  await seedOccurrenceIntent({ occId: 50, orderId: 20, clientId: 7, sku: 'F' });
  const w3 = await processFulfillmentOccurrenceOutboxOnce({ executor: testDb });
  assert.equal(await ledgerRows(), ledgerAfterHappy, 'below-floor occurrence moved no stock');
  assert.equal(await claimStatus(50), 'pending', 'below-floor claim stays pending (not consumed)');
  assert.equal(await outboxStatus(50), 'pending', 'below-floor intent is PARKED (retryable), not succeeded');
  assert.equal(w3.fenced, 1, 'the worker reports one fenced (parked) row');
  ok('below-floor occurrence -> worker PARKS the intent (pending), claim stays pending, zero movement');

  // ── 4) OUT-OF-SCOPE client (8, not in {7,9}): worker PARKS, never moves ───────────────────────────────────
  await seedOccurrenceIntent({ occId: 1500, orderId: 30, clientId: 8, sku: 'G' });
  await processFulfillmentOccurrenceOutboxOnce({ executor: testDb });
  assert.equal(await ledgerRows(), ledgerAfterHappy, 'out-of-scope client moved no stock');
  assert.equal(await claimStatus(1500), 'pending', 'out-of-scope claim stays pending');
  assert.equal(await outboxStatus(1500), 'pending', 'out-of-scope intent is PARKED (retryable), not succeeded');
  ok('out-of-scope client -> worker PARKS the intent (pending), claim stays pending, zero movement');

  // ── 5) TEST client (in scope): executor reaches it, but NO movement; terminal (row settles) ───────────────
  await seedOccurrenceIntent({ occId: 1600, orderId: 40, clientId: 9, sku: 'T' });
  await processFulfillmentOccurrenceOutboxOnce({ executor: testDb });
  assert.equal(await ledgerRows(), ledgerAfterHappy, 'test client moved no stock');
  assert.equal(await claimStatus(1600), 'review', 'test-client claim is demoted to review (terminal no-movement)');
  assert.equal(await outboxStatus(1600), 'succeeded', 'test-client intent is settled (never moves)');
  ok('test client -> zero movement; claim review; intent terminally settled (no perpetual retry)');

  // ── 6) SUPERSEDED occurrence: terminal settle, no movement ────────────────────────────────────────────────
  await raw`insert into orders (id, client_id, store_id, order_status, order_number) values (50, 7, 3, 'shipped', 'ORD-50')`;
  await raw`insert into fulfillment_occurrences (id, order_id, occurrence_key, discriminator_kind, first_seen_source, effective_at) values (1699, 50, 'ord:50|super-old', 'provider_shipment', 's', now())`;
  await raw`insert into fulfillment_occurrences (id, order_id, occurrence_key, discriminator_kind, first_seen_source, effective_at) values (1700, 50, 'ord:50|super', 'provider_shipment', 's', now())`;
  await raw`update fulfillment_occurrences set superseded_by_occurrence_id = 1699 where id = 1700`;
  await raw`insert into order_lifecycle_events (id, order_id, command_key, transition, source, effective_at, occurrence_id) values (1700, 50, 'ck:1700', 'shipped', 't', now(), 1700)`;
  await raw`insert into fulfillment_line_claims (lifecycle_event_id, order_id, line_key, sku, name, quantity, direction, status, supply, occurrence_id, canonical_line_identity, idempotency_key)
    values (1700, 50, 'sku:A', 'A', 'A', 2, 'deduct', 'pending', 'prepship', 1700, 'sku:A', 'inventory:deduct:occ:1700:line:sku:A')`;
  await raw`insert into fulfillment_outbox (order_id, event_type, provider, dedupe_key, payload, status, next_run_at)
    values (50, ${FULFILLMENT_OCCURRENCE_DEDUCTION_OUTBOX_EVENT}, 'inventory_occurrence', ${FULFILLMENT_OCCURRENCE_DEDUCTION_OUTBOX_EVENT + ':occ:1700'}, ${JSON.stringify({ occurrenceId: 1700, orderId: 50, source: 'seed' })}::jsonb, 'pending', now())`;
  await processFulfillmentOccurrenceOutboxOnce({ executor: testDb });
  assert.equal(await ledgerQty('A'), -2, 'superseded occurrence moved no additional stock');
  assert.equal(await outboxStatus(1700), 'succeeded', 'superseded intent is terminally settled');
  ok('superseded occurrence -> terminal settle, zero movement (occurrence lock re-verified not-superseded)');

  // ── 7) MALFORMED payload (no occurrenceId): fails, never moves ────────────────────────────────────────────
  await raw`insert into fulfillment_outbox (order_id, event_type, provider, dedupe_key, payload, status, next_run_at)
    values (1, ${FULFILLMENT_OCCURRENCE_DEDUCTION_OUTBOX_EVENT}, 'inventory_occurrence', ${FULFILLMENT_OCCURRENCE_DEDUCTION_OUTBOX_EVENT + ':malformed'}, ${JSON.stringify({ orderId: 1, source: 'seed' })}::jsonb, 'pending', now())`;
  const wBefore = await ledgerRows();
  await processFulfillmentOccurrenceOutboxOnce({ executor: testDb });
  assert.equal(await ledgerRows(), wBefore, 'malformed payload moved no stock');
  const [mal] = await raw<{ status: string }[]>`select status from fulfillment_outbox where dedupe_key = ${FULFILLMENT_OCCURRENCE_DEDUCTION_OUTBOX_EVENT + ':malformed'}`;
  assert.equal(mal?.status, 'failed', 'malformed payload is failed, not succeeded');
  ok('malformed payload (no occurrenceId) -> failed, zero movement');

  clearTimeout(hard);
  await raw.end({ timeout: 5 });
  await admin.unsafe(`drop database "${dbName}" with (force)`);
  await admin.end({ timeout: 5 });
  console.log(`\nPASS PS-497 occurrence worker FULL money path (PostgreSQL ${v}) — ${passed}/${passed} checks`);
  void db;
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });
