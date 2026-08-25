/**
 * PS-497 / PS-489 Slice 1 — the fulfillment_occurrences identity proven against REAL PostgreSQL 17.
 *
 * PGlite is a single connection and cannot prove that two writers racing one identity collapse to
 * one row. This runs two INDEPENDENT connections against a real PG17 and proves, on the migration
 * composed on top of the REAL 0070 + 0090 migrations:
 *
 *   1. two concurrent occurrence writers racing one occurrence_key -> exactly one row survives
 *      (ON CONFLICT (occurrence_key) DO NOTHING; the loser resolves the winner);
 *   2. two concurrent deduct claims racing one (occurrence_id, canonical_line_identity, 'deduct')
 *      -> exactly one commits, the other is rejected 23505 (THE double-deduct fix);
 *   3. two concurrent reverse claims for one original_claim_id -> exactly one commits, one 23505;
 *   4. expand-only: an INSERT omitting the new columns still succeeds and a SELECT of the new
 *      columns succeeds (the running old app cannot 500 on this migration);
 *   5. the occ-identity CHECK rejects an occurrence-scoped claim with NULL canonical_line_identity;
 *   6. 0090's quantity_state_check is intact: a non-review NULL-quantity claim is still rejected.
 *
 * Unskippable: absent an admin URL this FAILS rather than skips, and it refuses any server that is
 * not PostgreSQL 17. No production database is reachable.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const ADMIN_URL =
  process.env.PS497_PG17_ADMIN_URL ||
  process.env.PS487_PG17_ADMIN_URL ||
  process.env.PS508_PG17_ADMIN_URL;
if (!ADMIN_URL) {
  console.error(
    'FAIL: PS497_PG17_ADMIN_URL (or PS487_/PS508_PG17_ADMIN_URL) is not set. This proof is unskippable.',
  );
  process.exit(1);
}
const ADMIN: string = ADMIN_URL;
const NON_TX_SENTINEL = '-- >>> NON-TRANSACTIONAL <<<';

function migration(path: string): string {
  return readFileSync(path, 'utf8');
}

function splitMigration(sql: string): { transactional: string; concurrent: string[] } {
  // Anchor on the sentinel as its own line so a mention of the marker text inside a comment
  // cannot be mistaken for the real split point.
  const marker = `\n${NON_TX_SENTINEL}`;
  const at = sql.indexOf(marker);
  if (at < 0) throw new Error(`migration missing ${NON_TX_SENTINEL} sentinel line`);
  const concurrent = sql
    .slice(at + marker.length)
    .split('--> statement-breakpoint')
    .map((chunk) =>
      chunk
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((stmt) => stmt.length > 0);
  return { transactional: sql.slice(0, at), concurrent };
}

async function setupSchema(db: postgres.Sql): Promise<void> {
  // Minimal FK parents that the real 0070 requires, then the real claim/event tables and 0090's
  // state check, then the migration under test.
  await db.unsafe(`
    create table orders (id integer primary key);
    create table shipments (id integer primary key);
    create table inventory (id integer primary key);
    insert into orders (id) values (1);
    insert into shipments (id) values (10);
  `);
  await db.unsafe(migration('drizzle/0070_order_lifecycle_commands.sql'));
  await db.unsafe(migration('drizzle/0090_fulfillment_claim_nullable_quantity.sql'));

  const { transactional, concurrent } = splitMigration(
    migration('drizzle/0104_ps497_fulfillment_occurrences.sql'),
  );
  await db.begin(async (tx) => {
    await tx.unsafe(transactional);
  });
  for (const statement of concurrent) {
    await db.unsafe(statement);
  }
}

async function seed(db: postgres.Sql): Promise<{ eventId: number; occId: number; originalClaimId: number }> {
  const [event] = await db<{ id: number }[]>`
    insert into order_lifecycle_events (order_id, command_key, transition, source, effective_at)
    values (1, 'seed:cmd', 'shipped', 'test', now())
    returning id
  `;
  const eventId = Number(event?.id);
  const [occ] = await db<{ id: number }[]>`
    insert into fulfillment_occurrences
      (order_id, shipment_id, occurrence_key, discriminator_kind, first_seen_source, effective_at)
    values (1, 10, 'ord:1|pship:test:SEED', 'provider_shipment', 'seed', now())
    returning id
  `;
  const occId = Number(occ?.id);
  // A real applied claim the reverse-uniqueness probe can point original_claim_id at.
  const [orig] = await db<{ id: number }[]>`
    insert into fulfillment_line_claims
      (lifecycle_event_id, order_id, line_key, quantity, direction, status, idempotency_key)
    values (${eventId}, 1, 'sku:0', 2, 'deduct', 'applied', 'seed:orig')
    returning id
  `;
  return { eventId, occId, originalClaimId: Number(orig?.id) };
}

function insertOccurrence(conn: postgres.Sql, key: string): Promise<postgres.RowList<{ id: number }[]>> {
  return conn<{ id: number }[]>`
    insert into fulfillment_occurrences
      (order_id, shipment_id, occurrence_key, discriminator_kind, first_seen_source, effective_at)
    values (1, null, ${key}, 'whole_order', 'race', now())
    on conflict (occurrence_key) do nothing
    returning id
  `;
}

function sqlState(reason: unknown): string | undefined {
  return (reason as { code?: string } | undefined)?.code;
}

async function main(): Promise<void> {
  const hardTimeout = setTimeout(() => {
    console.error('HANG: ps-497-fulfillment-occurrences-concurrency-pg17 exceeded 90s');
    process.exit(3);
  }, 90_000);
  hardTimeout.unref();

  const admin = postgres(ADMIN, { max: 1, prepare: false, onnotice: () => {} });
  const [ver] = await admin<{ v: number }[]>`select current_setting('server_version_num')::int as v`;
  const v = Number(ver?.v ?? 0);
  if (v < 170000 || v >= 180000) {
    console.error(`FAIL: expected PostgreSQL 17 (server_version_num 170000-179999), got ${v}.`);
    await admin.end({ timeout: 5 });
    process.exit(1);
  }
  const dbName = `ps497_occ_conc_${v}_${process.pid}`;
  await admin.unsafe(`drop database if exists "${dbName}" with (force)`);
  await admin.unsafe(`create database "${dbName}"`);
  const base = ADMIN.replace(/\/[^/]*$/, `/${dbName}`);

  const setup = postgres(base, { max: 1, prepare: false, onnotice: () => {} });
  await setupSchema(setup);
  const { eventId, occId, originalClaimId } = await seed(setup);

  const connA = postgres(base, { max: 1, prepare: false, onnotice: () => {} });
  const connB = postgres(base, { max: 1, prepare: false, onnotice: () => {} });

  let passed = 0;
  const ok = (m: string) => {
    passed += 1;
    console.log('ok   ' + m);
  };

  // 1) Concurrent occurrence writers racing one key collapse to a single row.
  const raceKey = 'ord:1|ext';
  const [ra, rb] = await Promise.all([
    insertOccurrence(connA, raceKey),
    insertOccurrence(connB, raceKey),
  ]);
  const inserted = [ra, rb].filter((r) => r.length > 0);
  assert.equal(inserted.length, 1, 'exactly one concurrent writer inserts the occurrence');
  const winners = await setup<{ id: number }[]>`
    select id from fulfillment_occurrences where occurrence_key = ${raceKey}
  `;
  assert.equal(winners.length, 1, 'the occurrence_key resolves to exactly one row');
  ok('concurrency: two writers racing one occurrence_key -> one canonical occurrence (ON CONFLICT single winner)');

  // 2) Two concurrent deduct claims for one (occurrence, line, direction): the double-deduct fix.
  const insertDeduct = (conn: postgres.Sql, idem: string) =>
    conn`
      insert into fulfillment_line_claims
        (lifecycle_event_id, order_id, line_key, occurrence_id, canonical_line_identity, quantity, direction, status, idempotency_key)
      values (${eventId}, 1, 'sku:0', ${occId}, 'sku:0#1', 3, 'deduct', 'pending', ${idem})
    `;
  const deducts = await Promise.allSettled([
    insertDeduct(connA, 'race:deduct:a'),
    insertDeduct(connB, 'race:deduct:b'),
  ]);
  const deductOk = deducts.filter((r) => r.status === 'fulfilled').length;
  const deductRejects = deducts.filter(
    (r) => r.status === 'rejected' && sqlState((r as PromiseRejectedResult).reason) === '23505',
  ).length;
  assert.equal(deductOk, 1, 'exactly one deduct claim for the (occurrence,line,deduct) tuple commits');
  assert.equal(deductRejects, 1, 'the second identical deduct claim is rejected 23505');
  ok('double-deduct fix: one (occurrence_id, canonical_line_identity, deduct) survives; the racing duplicate is rejected 23505');

  // 3) Two concurrent reverse claims for one original_claim_id.
  const insertReverse = (conn: postgres.Sql, idem: string) =>
    conn`
      insert into fulfillment_line_claims
        (lifecycle_event_id, order_id, line_key, quantity, direction, original_claim_id, status, idempotency_key)
      values (${eventId}, 1, 'sku:0', 2, 'reverse', ${originalClaimId}, 'pending', ${idem})
    `;
  const reverses = await Promise.allSettled([
    insertReverse(connA, 'race:reverse:a'),
    insertReverse(connB, 'race:reverse:b'),
  ]);
  const reverseOk = reverses.filter((r) => r.status === 'fulfilled').length;
  const reverseRejects = reverses.filter(
    (r) => r.status === 'rejected' && sqlState((r as PromiseRejectedResult).reason) === '23505',
  ).length;
  assert.equal(reverseOk, 1, 'exactly one reverse claim for the original commits');
  assert.equal(reverseRejects, 1, 'the second reverse claim for the same original is rejected 23505');
  ok('reverse uniqueness: one reverse per original_claim_id; the racing duplicate is rejected 23505');

  // 4) Expand-only: an insert omitting every new column succeeds; the new columns select cleanly.
  await setup`
    insert into fulfillment_line_claims
      (lifecycle_event_id, order_id, line_key, quantity, direction, status, idempotency_key)
    values (${eventId}, 1, 'sku:legacy', 1, 'deduct', 'pending', 'legacy:no-new-cols')
  `;
  const legacyRead = await setup`
    select occurrence_id, canonical_line_identity, supply from fulfillment_line_claims
    where idempotency_key = 'legacy:no-new-cols'
  `;
  assert.equal(legacyRead.length, 1, 'a claim inserted without the new columns is readable');
  ok('expand-only: an INSERT omitting occurrence_id/canonical_line_identity/supply succeeds and selects back');

  // 5) The occ-identity CHECK: occurrence-scoped claim with NULL canonical_line_identity is rejected.
  let identityRejected = false;
  try {
    await setup`
      insert into fulfillment_line_claims
        (lifecycle_event_id, order_id, line_key, occurrence_id, quantity, direction, status, idempotency_key)
      values (${eventId}, 1, 'sku:1', ${occId}, 1, 'deduct', 'pending', 'bad:no-identity')
    `;
  } catch (error) {
    identityRejected = sqlState(error) === '23514';
    if (!identityRejected) throw error;
  }
  assert.ok(identityRejected, 'an occurrence-scoped claim with no canonical_line_identity is rejected 23514');
  ok('occ-identity CHECK: an occurrence-scoped claim without a canonical_line_identity is rejected 23514');

  // 6) 0090 intact: a non-review claim with NULL quantity is still rejected.
  let quantityStateHeld = false;
  try {
    await setup`
      insert into fulfillment_line_claims
        (lifecycle_event_id, order_id, line_key, quantity, direction, status, idempotency_key)
      values (${eventId}, 1, 'sku:0', null, 'deduct', 'pending', 'bad:null-qty-pending')
    `;
  } catch (error) {
    quantityStateHeld = sqlState(error) === '23514';
    if (!quantityStateHeld) throw error;
  }
  assert.ok(quantityStateHeld, "0090's quantity_state_check still rejects a non-review NULL quantity");
  ok("0090 intact: a non-review claim carrying a NULL quantity is still rejected 23514");

  clearTimeout(hardTimeout);
  await connA.end({ timeout: 5 });
  await connB.end({ timeout: 5 });
  await setup.end({ timeout: 5 });
  await admin.unsafe(`drop database "${dbName}" with (force)`);
  await admin.end({ timeout: 5 });
  console.log(`\nPASS PS-497 fulfillment_occurrences concurrency (PostgreSQL ${v}) — ${passed}/${passed} checks`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
