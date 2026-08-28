// PS-497 Slice 2 Release B (S2.5, Hermes #2 item 8) — proves that with the narrow execution flag OFF, the
// dedicated worker leaves a due occurrence intent RETRYABLE (never settled) and moves NO stock. Separate
// process because the flags are frozen at env-import time. Real PostgreSQL 17.
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
// The whole point: execution OFF (master still on) -> isOccurrenceExecutionEnabled() is false -> locked_down.
process.env.FULFILLMENT_OCCURRENCE_EXECUTION = 'false';
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
  const hard = setTimeout(() => { console.error('HANG: exceeded 150s'); process.exit(3); }, 150_000);
  hard.unref();
  const admin = postgres(ADMIN, { max: 1, prepare: false, onnotice: () => {} });
  const [ver] = await admin<{ v: number }[]>`select current_setting('server_version_num')::int as v`;
  const v = Number(ver?.v ?? 0);
  if (v < 170000 || v >= 180000) { console.error(`FAIL: not PG17 (${v})`); await admin.end({ timeout: 5 }); process.exit(1); }
  const dbName = `ps497_execoff_${v}_${process.pid}`;
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
  const { processFulfillmentOccurrenceOutboxOnce, FULFILLMENT_OCCURRENCE_DEDUCTION_OUTBOX_EVENT } =
    await import('../src/services/fulfillment/occurrence-deduction-outbox.js');

  await raw`insert into clients (id, name, is_test) values (7, 'Real', false)`;
  await raw`insert into inventory (client_id, sku, name, active) values (7, 'A', 'A', true)`;
  await raw`insert into orders (id, client_id, store_id, order_status, order_number) values (1, 7, 3, 'shipped', 'ORD-1')`;
  await raw`insert into fulfillment_occurrences (id, order_id, occurrence_key, discriminator_kind, first_seen_source, effective_at) values (5000, 1, 'ord:1|pship:s:5000', 'provider_shipment', 's', now())`;
  await raw`insert into order_lifecycle_events (id, order_id, command_key, transition, source, effective_at, occurrence_id) values (5000, 1, 'ck:5000', 'shipped', 't', now(), 5000)`;
  await raw`insert into fulfillment_line_claims (lifecycle_event_id, order_id, line_key, sku, name, quantity, direction, status, supply, occurrence_id, canonical_line_identity, idempotency_key)
    values (5000, 1, 'sku:A', 'A', 'A', 2, 'deduct', 'pending', 'prepship', 5000, 'sku:A', 'inventory:deduct:occ:5000:line:sku:A')`;
  await raw`insert into fulfillment_outbox (order_id, event_type, provider, dedupe_key, payload, status, next_run_at)
    values (1, ${FULFILLMENT_OCCURRENCE_DEDUCTION_OUTBOX_EVENT}, 'inventory_occurrence', ${FULFILLMENT_OCCURRENCE_DEDUCTION_OUTBOX_EVENT + ':occ:5000'}, ${JSON.stringify({ occurrenceId: 5000, orderId: 1, source: 'seed' })}::jsonb, 'pending', now())`;

  const result = await processFulfillmentOccurrenceOutboxOnce({ executor: testDb });
  const ledger = (await raw<{ n: number }[]>`select count(*)::int as n from inventory_ledger`)[0]?.n ?? 0;
  const [outbox] = await raw<{ status: string }[]>`select status from fulfillment_outbox where (payload->>'occurrenceId')::int = 5000`;
  const [claim] = await raw<{ status: string }[]>`select status from fulfillment_line_claims where occurrence_id = 5000`;

  assert.equal(result.claimed, 1, 'the worker claimed the due row');
  assert.equal(result.lockedDown, 1, 'the worker reports one locked-down (flag-off) row');
  assert.equal(result.applied, 0, 'no movement applied with execution off');
  assert.equal(ledger, 0, 'execution OFF -> zero ledger movement');
  assert.equal(outbox?.status, 'pending', 'the intent is left RETRYABLE (pending), not settled');
  assert.equal(claim?.status, 'pending', 'the claim is left pending (not consumed)');
  console.log('ok   execution OFF -> worker keeps the intent retryable (pending), claim pending, zero movement');

  clearTimeout(hard);
  await raw.end({ timeout: 5 });
  await admin.unsafe(`drop database "${dbName}" with (force)`);
  await admin.end({ timeout: 5 });
  console.log(`\nPASS PS-497 occurrence worker execution-OFF (PostgreSQL ${v}) — 1/1 checks`);
  void db;
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });
