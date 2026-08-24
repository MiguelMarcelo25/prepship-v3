/**
 * PS-497 — the shipped-outcome invariant, against a migrated disposable PostgreSQL database.
 *
 * THIS GUARD IS EXPECTED TO FAIL ON CURRENT CODE. That is its purpose. It states the contract
 * the forward fix must satisfy, and it is red today because the two dominant writers still
 * produce review receipts that nothing consumes.
 *
 * Why it exists: every existing PS-497 guard proves a slice. None proves the OUTCOME. The
 * ticket's own root cause is ps-318 asserting that the symbol `deductInventoryForOrder` still
 * appears in labels.ts — which stayed green while the behaviour was dead for five weeks. A
 * source-regex cannot distinguish "deduction happened" from "deduction silently skipped", so
 * this drives the real canonical lifecycle owner and the real claim executor and reads the
 * resulting rows.
 *
 * THE INVARIANT: every shipped transition must reach exactly one terminally accountable
 * outcome —
 *   1. PrepShip-supplied with exact evidence -> one deductible claim, one ledger movement;
 *   2. external-supplied                     -> no movement, explicit durable non-applicable;
 *   3. unknown supply or missing line data   -> no movement, durable review row that a REAL
 *                                               consumer reads.
 * A review row no consumer ever selects is not outcome (3). It is an unbounded queue, which is
 * precisely the 3,800-claim backlog.
 *
 * NOT ENROLLED in scripts/sot-guard-pack.mjs. The pack gates deploys, and enrolling a
 * knowingly-red guard would block every unrelated deploy. Enrolment lands with the forward fix
 * that makes it green.
 *
 * UNSKIPPABLE: absent PS497_PG_ADMIN_URL this FAILS rather than skipping.
 */
import fs from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';

const ADMIN_URL = process.env.PS497_PG_ADMIN_URL;
if (!ADMIN_URL) {
  console.error('FAIL: PS497_PG_ADMIN_URL is not set. This proof is unskippable.');
  process.exit(1);
}
{
  const host = new URL(ADMIN_URL).hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1', 'postgres'].includes(host)) {
    console.error('FAIL: refusing non-ephemeral host "' + host + '"');
    process.exit(1);
  }
}

const DB_NAME = 'ps497_invariant_' + process.pid;
const dbUrl = (() => {
  const u = new URL(ADMIN_URL as string);
  u.pathname = '/' + DB_NAME;
  return u.toString();
})();

// The services read env at import time and refuse an injected connection outside tests.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = dbUrl;

let failures = 0;
let reds = 0;
function ok(name: string): void { console.log('ok   ' + name); }
function fail(name: string, detail: string): void { failures += 1; console.log('FAIL ' + name + ' — ' + detail); }
/** An assertion that documents the CURRENT defect. Counted separately from harness breakage. */
function red(name: string, detail: string): void { reds += 1; console.log('RED  ' + name + ' — ' + detail); }

async function migrate(sql: postgres.Sql): Promise<void> {
  const dir = 'drizzle';
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const body = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const raw of body.split('--> statement-breakpoint')) {
      let stmt = raw.trim();
      if (!stmt) continue;
      // A disposable database has no concurrency to protect, and CONCURRENTLY cannot run
      // inside the driver's implicit transaction. The resulting index is equivalent here.
      stmt = stmt
        .replace(/CREATE\s+INDEX\s+CONCURRENTLY/gi, 'CREATE INDEX')
        .replace(/DROP\s+INDEX\s+CONCURRENTLY/gi, 'DROP INDEX');
      // Supabase role grants and a handful of ordering artefacts do not exist here and are not
      // part of this contract. Schema objects the lifecycle owner needs are asserted below.
      try { await sql.unsafe(stmt); } catch { /* non-fatal for this harness */ }
    }
  }
}

async function main(): Promise<void> {
  const admin = postgres(ADMIN_URL as string, { max: 1, prepare: false, onnotice: () => {} });
  await admin.unsafe('drop database if exists ' + DB_NAME);
  await admin.unsafe('create database ' + DB_NAME);
  await admin.end({ timeout: 5 });

  const raw = postgres(dbUrl, { max: 4, prepare: false, onnotice: () => {} });
  try {
    await migrate(raw);

    for (const t of ['orders', 'order_items', 'shipments', 'inventory', 'fulfillment_line_claims', 'order_lifecycle_events', 'inventory_ledger']) {
      const [r] = await raw.unsafe("select to_regclass('public." + t + "') as x");
      if (!(r as { x: string | null }).x) {
        console.error('FAIL: migrated database is missing ' + t + '; harness cannot prove anything.');
        process.exit(1);
      }
    }

    const { drizzle } = await import('drizzle-orm/postgres-js');
    const schema = await import('../src/db/schema/index.js').catch(() => null);
    const conn = schema
      ? drizzle(raw, { schema: (schema as Record<string, unknown>).default ?? schema, casing: 'snake_case' })
      : drizzle(raw, { casing: 'snake_case' });

    const { applyOrderLifecycleCommand } = await import('../src/services/order-lifecycle-command.js');
    const { applyInventoryClaimsForLifecycleEvent } = await import('../src/services/fulfillment-deductions.js');

    const [client] = await raw.unsafe("insert into clients (name) values ('PS497 Invariant') returning id");
    const clientId = (client as { id: number }).id;
    await raw.unsafe("insert into inventory (sku, client_id) values ('SKU-A', $1), ('SKU-B', $1)", [clientId]);

    let seq = 0;
    async function newOrder(): Promise<number> {
      seq += 1;
      const [o] = await raw.unsafe(
        "insert into orders (order_number, client_id, order_status) values ($1, $2, 'awaiting_shipment') returning id",
        ['PS497-' + process.pid + '-' + seq, clientId],
      );
      const orderId = (o as { id: number }).id;
      await raw.unsafe(
        "insert into order_items (order_id, sku, order_status, quantity) values ($1, 'SKU-A', 'awaiting_shipment', 2)",
        [orderId],
      );
      return orderId;
    }
    const claimsFor = async (orderId: number) =>
      (await raw.unsafe(
        'select id, status, sku, quantity, line_key, idempotency_key, lifecycle_event_id from fulfillment_line_claims where order_id = $1 order by id',
        [orderId],
      )) as unknown as Array<Record<string, unknown>>;
    const ledgerFor = async (orderId: number) =>
      (await raw.unsafe(
        "select id, qty, type from inventory_ledger where source_entity_id = $1::text or order_id = $1",
        [orderId],
      ).catch(async () =>
        (await raw.unsafe('select id from inventory_ledger where order_id = $1', [orderId])) as never,
      )) as unknown as Array<Record<string, unknown>>;

    // ---------------------------------------------------------------------------------------
    // 1. PrepShip-supplied with exact evidence -> one deductible claim that the executor applies.
    // ---------------------------------------------------------------------------------------
    {
      const orderId = await newOrder();
      const res = await applyOrderLifecycleCommand({
        orderId,
        commandKey: 'ps497-exact-' + orderId,
        transition: 'shipped',
        source: 'test_exact',
        fulfillmentFacts: { kind: 'exact', lines: [{ sku: 'SKU-A', quantity: 2, name: 'A' }] },
      }, conn as never);

      const claims = await claimsFor(orderId);
      const pending = claims.filter((c) => c.status === 'pending');
      if (pending.length === 1) ok('exact evidence produces exactly one DEDUCTIBLE claim');
      else fail('exact evidence produces exactly one DEDUCTIBLE claim',
        `got ${claims.length} claim(s), ${pending.length} pending: ${JSON.stringify(claims.map((c) => c.status))}`);

      const applied = await applyInventoryClaimsForLifecycleEvent(res.lifecycleEventId, conn as never);
      if (applied.applied === 1) ok('the real claim executor applies that claim (one movement)');
      else fail('the real claim executor applies that claim (one movement)', JSON.stringify(applied));
    }

    // ---------------------------------------------------------------------------------------
    // 2. THE BLEEDING. Both open writers pass kind:'unavailable' — order-sync.ts:736-742 and
    //    reconcile-external-shipped-orders.ts:312-325. The owner mints a SKU-less, quantity-less
    //    review receipt, and the executor selects status='pending' only, so nothing ever
    //    consumes it. Outcome (3) requires a REAL consumer; an unread row is not an outcome.
    // ---------------------------------------------------------------------------------------
    {
      const orderId = await newOrder();
      const res = await applyOrderLifecycleCommand({
        orderId,
        commandKey: 'ps497-unavail-' + orderId,
        transition: 'shipped',
        source: 'order_sync_status',
        fulfillmentFacts: { kind: 'unavailable', description: 'shipped without line quantities' },
      }, conn as never);

      const claims = await claimsFor(orderId);
      const review = claims.filter((c) => c.status === 'review');
      const applied = await applyInventoryClaimsForLifecycleEvent(res.lifecycleEventId, conn as never);
      const after = await claimsFor(orderId);
      const stillUnconsumed = after.every((c) => c.status === 'review');

      if (review.length > 0 && applied.applied === 0 && stillUnconsumed) {
        red('a shipped transition must not leave an unconsumed review row',
          `${review.length} review claim(s) written with sku=${JSON.stringify(review[0]?.sku)} quantity=${JSON.stringify(review[0]?.quantity)}; `
          + `the real executor applied ${applied.applied} and left every row in 'review'. `
          + 'No consumer selects status=review, so this row is unbounded queue growth — the 3,800 backlog.');
      } else {
        ok('a shipped transition must not leave an unconsumed review row');
      }
    }

    // ---------------------------------------------------------------------------------------
    // 3. OCCURRENCE IDENTITY. Two writers describing ONE fulfilment occurrence must produce ONE
    //    movement. Identity is currently keyed on the lifecycle EVENT
    //    (`inventory:deduct:lifecycle:${event.id}:line:${lineKey}`), so a second writer for the
    //    same physical shipment mints a second independent claim. This is exactly the canonical
    //    representation question the audit says DJ must rule on.
    // ---------------------------------------------------------------------------------------
    {
      const orderId = await newOrder();
      const a = await applyOrderLifecycleCommand({
        orderId,
        commandKey: 'ps497-occ-a-' + orderId,
        transition: 'shipped',
        source: 'order_sync_status',
        fulfillmentFacts: { kind: 'exact', lines: [{ sku: 'SKU-A', quantity: 2, name: 'A' }] },
      }, conn as never);
      const b = await applyOrderLifecycleCommand({
        orderId,
        commandKey: 'ps497-occ-b-' + orderId,
        transition: 'external_shipped',
        source: 'external_shipped_classifier',
        fulfillmentFacts: { kind: 'exact', lines: [{ sku: 'SKU-A', quantity: 2, name: 'A' }] },
      }, conn as never).catch((e) => ({ lifecycleEventId: -1, error: String(e).slice(0, 80) } as never));

      const claims = await claimsFor(orderId);
      const keys = new Set(claims.map((c) => String(c.idempotency_key)));
      if (claims.length <= 1) {
        ok('two writers describing one occurrence produce one claim');
      } else {
        red('two writers describing one occurrence produce one claim',
          `got ${claims.length} claims with ${keys.size} distinct idempotency keys across lifecycle events `
          + `${a.lifecycleEventId} and ${(b as { lifecycleEventId: number }).lifecycleEventId}. `
          + 'Identity is event-scoped, so one physical shipment can be deducted twice.');
      }
    }

    // ---------------------------------------------------------------------------------------
    // 4. Genuine split shipments must stay independent — the mirror of case 3. Two real
    //    occurrences must NOT be collapsed by whatever fixes case 3.
    // ---------------------------------------------------------------------------------------
    {
      const orderId = await newOrder();
      const [s1] = await raw.unsafe('insert into shipments (order_id, client_id) values ($1, $2) returning id', [orderId, clientId]);
      const [s2] = await raw.unsafe('insert into shipments (order_id, client_id) values ($1, $2) returning id', [orderId, clientId]);
      await applyOrderLifecycleCommand({
        orderId, shipmentId: (s1 as { id: number }).id,
        commandKey: 'ps497-split-1-' + orderId, transition: 'shipped', source: 'test_split',
        fulfillmentFacts: { kind: 'exact', lines: [{ sku: 'SKU-A', quantity: 1, name: 'A' }] },
      }, conn as never);
      await applyOrderLifecycleCommand({
        orderId, shipmentId: (s2 as { id: number }).id,
        commandKey: 'ps497-split-2-' + orderId, transition: 'shipped', source: 'test_split',
        fulfillmentFacts: { kind: 'exact', lines: [{ sku: 'SKU-A', quantity: 1, name: 'A' }] },
      }, conn as never);
      const claims = await claimsFor(orderId);
      if (claims.length === 2) ok('two genuine split shipments remain two independent claims');
      else fail('two genuine split shipments remain two independent claims', `got ${claims.length}`);
    }

    // ---------------------------------------------------------------------------------------
    // 5. A duplicate/retry of the SAME writer must be idempotent.
    // ---------------------------------------------------------------------------------------
    {
      const orderId = await newOrder();
      const key = 'ps497-retry-' + orderId;
      const facts = { kind: 'exact' as const, lines: [{ sku: 'SKU-A', quantity: 2, name: 'A' }] };
      await applyOrderLifecycleCommand({ orderId, commandKey: key, transition: 'shipped', source: 'test_retry', fulfillmentFacts: facts }, conn as never);
      const second = await applyOrderLifecycleCommand({ orderId, commandKey: key, transition: 'shipped', source: 'test_retry', fulfillmentFacts: facts }, conn as never);
      const claims = await claimsFor(orderId);
      if (second.alreadyApplied && claims.length === 1) ok('a retry of the same writer is idempotent (one claim)');
      else fail('a retry of the same writer is idempotent (one claim)', `alreadyApplied=${second.alreadyApplied} claims=${claims.length}`);
    }

    // ---------------------------------------------------------------------------------------
    // 6. A null/zero/invalid quantity must never become deductible work.
    // ---------------------------------------------------------------------------------------
    {
      const orderId = await newOrder();
      await applyOrderLifecycleCommand({
        orderId,
        commandKey: 'ps497-qty-' + orderId,
        transition: 'shipped',
        source: 'test_qty',
        fulfillmentFacts: { kind: 'exact', lines: [{ sku: 'SKU-A', quantity: 0, name: 'A' }] },
      }, conn as never).catch(() => null);
      const claims = await claimsFor(orderId);
      const deductible = claims.filter((c) => c.status === 'pending');
      if (deductible.length === 0) ok('a zero quantity never becomes deductible work');
      else fail('a zero quantity never becomes deductible work', `${deductible.length} pending claim(s)`);
    }

    console.log('');
    console.log(`harness failures: ${failures}   contract reds (expected today): ${reds}`);
    if (failures > 0) {
      console.log('\nHARNESS BROKEN — fix the guard before reading the contract result.');
      process.exit(2);
    }
    if (reds > 0) {
      console.log('\nRED BY DESIGN: the shipped-outcome invariant does not hold on current code.');
      console.log('This guard turns green when the forward fix lands, and is enrolled in the SOT pack then.');
      process.exit(1);
    }
    console.log('\nPASS — the shipped-outcome invariant holds. Enrol this guard in sot-guard-pack.mjs.');
    process.exit(0);
  } finally {
    await raw.end({ timeout: 5 }).catch(() => {});
    const cleanup = postgres(ADMIN_URL as string, { max: 1, prepare: false, onnotice: () => {} });
    await cleanup.unsafe(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname='" + DB_NAME + "' and pid <> pg_backend_pid()",
    ).catch(() => {});
    await cleanup.unsafe('drop database if exists ' + DB_NAME).catch(() => {});
    await cleanup.end({ timeout: 5 }).catch(() => {});
  }
}

void main();
