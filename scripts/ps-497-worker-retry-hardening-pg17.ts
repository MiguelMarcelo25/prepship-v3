// PS-497 Slice 2 Release B (Hermes worker-hardening) — proves a malformed/stale occurrence-intent batch cannot
// STARVE valid movement. Before the fix, a malformed row was left status='failed' + next_run_at unchanged, so
// the claimer (status IN ('pending','failed') AND next_run_at <= NOW()) re-claimed it every poll, potentially
// occupying the whole batch limit ahead of valid work forever. Now a malformed payload is parked TERMINALLY
// (next_run_at='infinity') and a missing occurrence / executor error backs off with a bounded retry budget and
// then terminal — so malformed rows leave the due set and a later valid movement is reached in bounded drains.
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
  const dbName = `ps497_retry_${v}_${process.pid}`;
  await admin.unsafe(`drop database if exists "${dbName}" with (force)`);
  await admin.unsafe(`create database "${dbName}"`);
  const base = ADMIN.replace(/\/[^/]*$/, `/${dbName}`);
  const raw = postgres(base, { max: 1, prepare: false, onnotice: () => {} });
  await migrateAll(raw);

  process.env.DATABASE_URL = base;
  const { db } = await import('../src/db/client.js');
  const schema = await import('../src/db/schema/index.js');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const testDb = drizzle(raw as never, { schema, casing: 'snake_case' }) as unknown as Pick<typeof db, 'transaction'>;
  const { processFulfillmentOccurrenceOutboxOnce, FULFILLMENT_OCCURRENCE_DEDUCTION_OUTBOX_EVENT: EVT } =
    await import('../src/services/fulfillment/occurrence-deduction-outbox.js');

  let passed = 0;
  const ok = (m: string) => { passed += 1; console.log('ok   ' + m); };
  const ledgerQty = async (sku: string) => (await raw<{ s: number }[]>`select coalesce(sum(l.qty),0)::int as s from inventory_ledger l join inventory i on i.id = l.inventory_id where lower(i.sku) = lower(${sku})`)[0]?.s ?? 0;
  const dueCount = async () => (await raw<{ n: number }[]>`select count(*)::int as n from fulfillment_outbox where event_type = ${EVT} and status in ('pending','failed') and next_run_at <= NOW()`)[0]?.n ?? 0;
  const infinityCount = async () => (await raw<{ n: number }[]>`select count(*)::int as n from fulfillment_outbox where event_type = ${EVT} and next_run_at = 'infinity'::timestamptz`)[0]?.n ?? 0;

  await raw`insert into clients (id, name, is_test) values (7, 'Real', false)`;
  await raw`insert into inventory (client_id, sku, name, active) values (7, 'A', 'A', true)`;

  // 120 malformed intents (no occurrenceId), LOW ids, all due now — more than the 100 batch limit.
  await raw`insert into fulfillment_outbox (order_id, event_type, provider, dedupe_key, payload, status, next_run_at)
    select 1, ${EVT}, 'inventory_occurrence', ${EVT} || ':malformed:' || g, '{}'::jsonb, 'pending', now()
    from generate_series(1, 120) g`;
  // ONE valid occurrence + its intent, inserted LAST so it has the highest id (worst case for starvation).
  await raw`insert into orders (id, client_id, store_id, order_status, order_number) values (900, 7, 3, 'shipped', 'ORD-900')`;
  await raw`insert into fulfillment_occurrences (id, order_id, occurrence_key, discriminator_kind, first_seen_source, effective_at) values (9000, 900, 'ord:900|pship:s:9000', 'provider_shipment', 's', now())`;
  await raw`insert into order_lifecycle_events (id, order_id, command_key, transition, source, effective_at, occurrence_id) values (9000, 900, 'ck:9000', 'shipped', 't', now(), 9000)`;
  await raw`insert into fulfillment_line_claims (lifecycle_event_id, order_id, line_key, sku, name, quantity, direction, status, supply, occurrence_id, canonical_line_identity, idempotency_key)
    values (9000, 900, 'sku:A', 'A', 'A', 2, 'deduct', 'pending', 'prepship', 9000, 'sku:A', 'inventory:deduct:occ:9000:line:sku:A')`;
  await raw`insert into fulfillment_outbox (order_id, event_type, provider, dedupe_key, payload, status, next_run_at)
    values (900, ${EVT}, 'inventory_occurrence', ${EVT} || ':occ:9000', ${JSON.stringify({ occurrenceId: 9000, orderId: 900, source: 'seed' })}::jsonb, 'pending', now())`;

  assert.equal(await dueCount(), 121, 'all 120 malformed + 1 valid are due at the start');

  // Drain in bounded rounds. Each round parks its malformed batch TERMINALLY (infinity), so the due set shrinks
  // and the valid row is reached — instead of the malformed batch being re-claimed every round forever.
  let moved = 0;
  let rounds = 0;
  for (let i = 0; i < 5 && moved === 0; i += 1) {
    const r = await processFulfillmentOccurrenceOutboxOnce({ executor: testDb, limit: 100 });
    rounds += 1;
    moved = await ledgerQty('A');
    void r;
  }
  assert.equal(moved, -2, `the valid movement was reached within bounded drains (rounds=${rounds})`);
  assert.ok(rounds <= 3, `bounded: the valid movement was reached in <= 3 drains (was ${rounds})`);
  ok(`valid movement reached in ${rounds} bounded drains despite 120 malformed rows ahead of it`);

  // Every malformed row is now parked TERMINALLY and can never be re-claimed to starve future work.
  assert.equal(await infinityCount(), 120, 'all 120 malformed rows are parked terminally (next_run_at=infinity)');
  const [mal] = await raw<{ status: string }[]>`select status from fulfillment_outbox where dedupe_key = ${EVT + ':malformed:1'}`;
  assert.equal(mal?.status, 'failed', 'a malformed row is failed + terminal, not re-due');
  ok('all malformed rows are parked terminally (infinity) — they leave the due set and cannot re-crowd valid work');

  // A further drain claims nothing (malformed terminal, valid succeeded): no perpetual re-claiming.
  const after = await processFulfillmentOccurrenceOutboxOnce({ executor: testDb, limit: 100 });
  assert.equal(after.claimed, 0, 'a subsequent drain re-claims nothing (no malformed re-claim loop)');
  assert.equal(await ledgerQty('A'), -2, 'no additional movement');
  ok('a subsequent drain re-claims nothing — malformed rows do not return every poll');

  clearTimeout(hard);
  await raw.end({ timeout: 5 });
  await admin.unsafe(`drop database "${dbName}" with (force)`);
  await admin.end({ timeout: 5 });
  console.log(`\nPASS PS-497 worker retry hardening (PostgreSQL ${v}) — ${passed}/${passed} checks`);
  void db;
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });
