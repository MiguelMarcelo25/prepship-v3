/**
 * PS-502 behavioural proof against a real PostgreSQL engine.
 *
 * In-memory PGlite only: no production database, provider, label, postage, inventory or
 * marketplace side effect is reachable. Nothing here writes a real shipment.
 *
 * WHY THIS EXISTS. Every PS-502 guard so far asserts SHAPE and ORDERING against source text.
 * None of them execute a command. Hermes put runtime proof at 0% for exactly that reason, and
 * the commands now carry guards — advisory locks, optimistic concurrency, payload-bound
 * idempotency — whose whole purpose is to behave correctly under conditions source text
 * cannot express.
 *
 * The migrations are applied VERBATIM from drizzle/, so the schema under test is the schema
 * that ships, including the CHECK constraints and partial unique indexes the Drizzle mapping
 * deliberately does not declare.
 *
 * WHAT THIS DOES NOT PROVE. PGlite is a single-backend PostgreSQL: two transactions cannot
 * execute simultaneously, so this file does NOT prove the advisory lock prevents interleaving.
 * What it proves is the property that actually protects the data — the optimistic-concurrency
 * predicate rejects a lost update. That race is simulated by INTERLEAVING deterministically:
 * read state, let another writer move it, then attempt the guarded write with the stale
 * expectation. True parallel proof needs a multi-backend server and is called out as
 * outstanding rather than implied.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../src/db/schema/index.js';

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed += 1;
  console.log(`ok   ${name}`);
}

/** The prerequisite tables 0096 references. Minimal — only what the commands touch. */
const PREREQUISITE_DDL = `
  CREATE TABLE clients (id serial PRIMARY KEY, name text);
  CREATE TABLE orders (
    id serial PRIMARY KEY,
    client_id integer REFERENCES clients(id),
    order_number text NOT NULL,
    order_status text NOT NULL DEFAULT 'awaiting_shipment',
    items jsonb NOT NULL DEFAULT '[]'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE order_items (
    id serial PRIMARY KEY,
    order_id integer NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    line_index integer NOT NULL DEFAULT 0,
    sku text NOT NULL,
    name text,
    quantity numeric(12,3) NOT NULL DEFAULT '0',
    order_status text NOT NULL DEFAULT 'shipped',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX order_items_order_line_idx ON order_items (order_id, line_index);
  -- Mirrors src/db/schema/shipments.ts in full. Drizzle emits EVERY declared column on
  -- an insert, so a test table missing one fails the same way a real database would — which
  -- is the failure mode returns.ts documents, seen from the other side.
  CREATE TABLE shipments (
    id serial PRIMARY KEY,
    order_id integer REFERENCES orders(id),
    client_id integer REFERENCES clients(id),
    order_number text, carrier_code text, service_code text, tracking_number text,
    ship_date timestamptz, create_date timestamptz,
    weight_oz real, dims_l real, dims_w real, dims_h real,
    cost numeric(10,2), other_cost numeric(10,2) NOT NULL DEFAULT '0',
    selected_rate_cost numeric(10,2),
    label_url text, label_created_at timestamptz, label_format text, label_carrier text,
    label_service text, label_tracking text, label_cost numeric(10,2),
    label_ship_date timestamptz, label_provider integer, label_shipment_id integer,
    selected_rate_json jsonb, selected_pid integer, selected_package_id text,
    provider_account_id integer, provider_account_nickname text, carrier_provider text,
    carrier_account_id text, label_provider_key text,
    confirmation_provider text, confirmation_status text,
    confirmation_attempts integer NOT NULL DEFAULT 0, confirmation_last_error text,
    marketplace_confirmed_at timestamptz,
    voided boolean NOT NULL DEFAULT false, source text,
    is_return boolean NOT NULL DEFAULT false,
    return_for_shipment_id integer, return_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE billing_line_items (
    id serial PRIMARY KEY,
    order_id integer,
    shipment_id integer,
    line_type text NOT NULL,
    description text,
    replacement_id integer
  );
  CREATE TABLE billing_credit_notes (
    id text PRIMARY KEY,
    finalization_id text,
    reason text NOT NULL,
    replacement_id integer,
    created_at timestamptz NOT NULL DEFAULT now()
  );
`;

const MIGRATIONS = [
  'drizzle/0096_ps502_replacements.sql',
  'drizzle/0097_ps502_replacement_billing.sql',
  'drizzle/0098_ps502_replacement_financial_restrict.sql',
];

async function applyMigrations(client: PGlite): Promise<void> {
  for (const file of MIGRATIONS) {
    await client.exec(readFileSync(file, 'utf8'));
  }
}

async function main(): Promise<void> {
  process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
  process.env.SUPABASE_URL = 'https://example.test';
  process.env.SUPABASE_ANON_KEY = 'test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
  process.env.SUPABASE_JWT_SECRET = 'test';
  process.env.NODE_ENV = 'test';

  const { createReplacement, ReplacementCreateError } =
    await import('../src/services/replacement-create-command.js');
  const { insertReplacementShipment, ReplacementShipmentError } =
    await import('../src/services/replacement-shipment-command.js');

  const client = new PGlite();
  await client.exec(PREREQUISITE_DDL);

  console.log('\nmigrations');
  await applyMigrations(client);
  await check('0096/0097/0098 apply against a real PostgreSQL engine', async () => {
    const rows = await client.query<{ c: number }>(
      "select count(*)::int as c from information_schema.tables where table_name like 'replacement%'",
    );
    assert.equal(rows.rows[0]!.c, 3, 'three replacement tables should exist');
  });
  await check('the migrations are re-runnable (applied twice, no error)', async () => {
    await applyMigrations(client);
  });

  const db = drizzle(client, { schema, casing: 'snake_case' });
  const conn = db as unknown as Parameters<typeof createReplacement>[1];

  // A shipped original: 3 x SKU-A at line 0, 2 x SKU-B at line 1.
  await client.exec(`
    INSERT INTO clients (id, name) VALUES (1, 'Acme');
    INSERT INTO orders (id, client_id, order_number, order_status)
      VALUES (1321, 1, '1321', 'shipped');
    INSERT INTO order_items (order_id, line_index, sku, name, quantity) VALUES
      (1321, 0, 'SKU-A', 'Widget A', 3),
      (1321, 1, 'SKU-B', 'Widget B', 2);
  `);
  const actor = { email: 'op@example.test', type: 'operator', permissions: ['replacements:create'] };

  console.log('\ncreate command');

  let firstId = 0;
  await check('the first replacement allocates the BARE reference', async () => {
    const result = await createReplacement({
      orderId: 1321, reason: 'damaged', liabilityOwner: 'operator',
      items: [{ orderLineIndex: 0, quantity: 1 }],
      requestIdempotencyKey: 'req-1', actor,
    }, conn);
    assert.equal(result.created, true);
    assert.equal(result.replacement.reference, '1321-REPLACE');
    assert.equal(result.replacement.status, 'requested');
    assert.equal(result.replacement.billable, false, 'operator liability forces non-billable');
    firstId = result.replacement.id;
  });

  await check('the frozen fingerprint and snapshots are persisted', async () => {
    const items = await db.select().from(schema.replacementItems)
      .where(eq(schema.replacementItems.replacementId, firstId));
    assert.equal(items.length, 1);
    assert.equal(items[0]!.sku, 'SKU-A');
    assert.equal(items[0]!.originalOrderedQuantity, 3);
    assert.match(String(items[0]!.sourceLineFingerprint), /^\["rlf1",1321,0,"sku-a"/);
  });

  await check('a SECOND replacement on the same order allocates -2', async () => {
    const result = await createReplacement({
      orderId: 1321, reason: 'wrong_item', liabilityOwner: 'operator',
      items: [{ orderLineIndex: 1, quantity: 1 }],
      requestIdempotencyKey: 'req-2', actor,
    }, conn);
    assert.equal(result.replacement.reference, '1321-REPLACE-2');
  });

  await check('a retried key returns the SAME replacement and appends no second event', async () => {
    const again = await createReplacement({
      orderId: 1321, reason: 'damaged', liabilityOwner: 'operator',
      items: [{ orderLineIndex: 0, quantity: 1 }],
      requestIdempotencyKey: 'req-1', actor,
    }, conn);
    assert.equal(again.created, false);
    assert.equal(again.replacement.id, firstId);
    const events = await db.select().from(schema.replacementActivityEvents)
      .where(eq(schema.replacementActivityEvents.replacementId, firstId));
    assert.equal(events.length, 1, 'exactly one creation event');
  });

  await check('the same key with DIFFERENT items is a coded conflict, never silent reuse', async () => {
    await assert.rejects(
      () => createReplacement({
        orderId: 1321, reason: 'damaged', liabilityOwner: 'operator',
        items: [{ orderLineIndex: 0, quantity: 2 }],
        requestIdempotencyKey: 'req-1', actor,
      }, conn),
      (e: unknown) => e instanceof ReplacementCreateError
        && e.code === 'REPLACEMENT_IDEMPOTENCY_MISMATCH',
    );
  });

  console.log('\ncumulative cap against the database');

  await check('a pending replacement consumes NO allowance', async () => {
    const result = await createReplacement({
      orderId: 1321, reason: 'other', liabilityOwner: 'operator',
      items: [{ orderLineIndex: 0, quantity: 3 }],
      requestIdempotencyKey: 'req-3', actor,
    }, conn);
    assert.equal(result.created, true, 'req-1 is still `requested`, so all 3 remain available');
  });

  await check('a SHIPPED replacement consumes it, and the next request is refused', async () => {
    await db.update(schema.replacements)
      .set({ status: 'shipped', shippedAt: new Date() })
      .where(eq(schema.replacements.id, firstId));
    await assert.rejects(
      () => createReplacement({
        orderId: 1321, reason: 'other', liabilityOwner: 'operator',
        items: [{ orderLineIndex: 0, quantity: 3 }],
        requestIdempotencyKey: 'req-4', actor,
      }, conn),
      (e: unknown) => e instanceof ReplacementCreateError
        && e.code === 'REPLACEMENT_ALLOWANCE_EXCEEDED',
    );
  });

  console.log('\nvalidation reaches the caller as a coded 400, not a Postgres error');

  const badInputs = [
    ['a fractional quantity', [{ orderLineIndex: 1, quantity: 1.5 }]],
    ['a zero quantity', [{ orderLineIndex: 1, quantity: 0 }]],
    ['a duplicate line coordinate', [{ orderLineIndex: 1, quantity: 1 }, { orderLineIndex: 1, quantity: 1 }]],
  ] as const;

  for (const [label, items] of badInputs) {
    await check(`${label} is rejected before the transaction`, async () => {
      await assert.rejects(
        () => createReplacement({
          orderId: 1321, reason: 'damaged', liabilityOwner: 'operator',
          items: [...items],
          requestIdempotencyKey: `bad-${label}`, actor,
        }, conn),
        (e: unknown) => e instanceof ReplacementCreateError
          && e.code === 'REPLACEMENT_ITEM_INVALID' && e.httpStatus === 400,
      );
    });
  }

  await check('an unknown reason is rejected server-side', async () => {
    await assert.rejects(
      () => createReplacement({
        orderId: 1321, reason: 'because-i-said-so', liabilityOwner: 'operator',
        items: [{ orderLineIndex: 1, quantity: 1 }],
        requestIdempotencyKey: 'bad-reason', actor,
      }, conn),
      (e: unknown) => e instanceof ReplacementCreateError
        && e.code === 'REPLACEMENT_REASON_INVALID',
    );
  });

  console.log('\nthe original order survives its replacements');

  await check('updating the original order still succeeds after replacement items exist', async () => {
    await client.exec(`UPDATE orders SET updated_at = now() WHERE id = 1321;`);
    const items = await db.select().from(schema.replacementItems)
      .where(eq(schema.replacementItems.replacementId, firstId));
    assert.equal(items.length, 1, 'no FK to order_items means the refresh cannot cascade');
  });

  console.log('\nshipment insertion');

  let approvedId = 0;
  await check('a shipment attaches at `approved` and carries the replacement reference', async () => {
    const created = await createReplacement({
      orderId: 1321, reason: 'damaged', liabilityOwner: 'operator',
      items: [{ orderLineIndex: 1, quantity: 1 }],
      requestIdempotencyKey: 'req-ship', actor,
    }, conn);
    approvedId = created.replacement.id;
    await db.update(schema.replacements).set({ status: 'approved' })
      .where(eq(schema.replacements.id, approvedId));

    const result = await insertReplacementShipment({
      replacementId: approvedId, actor: { email: actor.email, type: actor.type },
    }, conn);
    assert.equal(result.created, true);
    const [row] = await db.select().from(schema.shipments)
      .where(eq(schema.shipments.id, result.shipmentId));
    assert.equal(row!.orderNumber, created.replacement.reference);
    assert.equal(row!.orderId, 1321, 'relational ownership stays with the original');
    assert.equal(row!.isReturn, false, 'a replacement is OUTBOUND');
    assert.equal(row!.source, 'replacement');
  });

  await check('re-attaching returns the SAME shipment, never a second', async () => {
    const before = await client.query<{ c: number }>('select count(*)::int as c from shipments');
    const again = await insertReplacementShipment({
      replacementId: approvedId, actor: { email: actor.email, type: actor.type },
    }, conn);
    assert.equal(again.created, false);
    const after = await client.query<{ c: number }>('select count(*)::int as c from shipments');
    assert.equal(after.rows[0]!.c, before.rows[0]!.c, 'no second shipment row');
  });

  console.log('\ndrift: the review COMMITS while the command FAILS');

  await check('a moved source line reviews the replacement and returns a coded 409', async () => {
    const created = await createReplacement({
      orderId: 1321, reason: 'damaged', liabilityOwner: 'operator',
      items: [{ orderLineIndex: 1, quantity: 1 }],
      requestIdempotencyKey: 'req-drift', actor,
    }, conn);
    const driftId = created.replacement.id;
    await db.update(schema.replacements).set({ status: 'approved' })
      .where(eq(schema.replacements.id, driftId));

    // The line moves underneath it: SKU-B's ordered quantity changes.
    await client.exec(`UPDATE order_items SET quantity = 9 WHERE order_id = 1321 AND line_index = 1;`);

    await assert.rejects(
      () => insertReplacementShipment({
        replacementId: driftId, actor: { email: actor.email, type: actor.type },
      }, conn),
      (e: unknown) => e instanceof ReplacementShipmentError
        && e.code === 'REPLACEMENT_SOURCE_LINE_CHANGED',
    );

    // THE POINT: the review survived the failure.
    const [after] = await db.select().from(schema.replacements)
      .where(eq(schema.replacements.id, driftId));
    assert.equal(after!.status, 'review', 'the review must COMMIT even though the command threw');
    assert.equal(after!.reviewReason, 'original_order_line_drift');
    assert.equal(after!.replacementShipmentId, null, 'no shipment on the drift path');

    const events = await db.select().from(schema.replacementActivityEvents)
      .where(eq(schema.replacementActivityEvents.replacementId, driftId));
    assert.ok(events.some((e) => e.eventType === 'replacement_source_line_drift'));

    await client.exec(`UPDATE order_items SET quantity = 2 WHERE order_id = 1321 AND line_index = 1;`);
  });

  console.log('\noptimistic concurrency (interleaved, not parallel — see header)');

  await check('a stale state_version cannot link a shipment', async () => {
    const created = await createReplacement({
      orderId: 1321, reason: 'damaged', liabilityOwner: 'operator',
      items: [{ orderLineIndex: 0, quantity: 1 }],
      requestIdempotencyKey: 'req-race', actor,
    }, conn);
    const raceId = created.replacement.id;
    await db.update(schema.replacements).set({ status: 'approved' })
      .where(eq(schema.replacements.id, raceId));
    const [read] = await db.select().from(schema.replacements)
      .where(eq(schema.replacements.id, raceId));

    // Another writer moves it while the first holds a stale expectation.
    await db.update(schema.replacements)
      .set({ stateVersion: read!.stateVersion + 1 })
      .where(eq(schema.replacements.id, raceId));

    // The guarded update the command performs, replayed with the STALE version.
    const linked = await db.update(schema.replacements)
      .set({ replacementShipmentId: 999999, stateVersion: read!.stateVersion + 1 })
      .where(sql`${schema.replacements.id} = ${raceId}
        and ${schema.replacements.status} = ${read!.status}
        and ${schema.replacements.stateVersion} = ${read!.stateVersion}`)
      .returning();
    assert.equal(linked.length, 0, 'a lost update must match zero rows, not overwrite');
  });

  console.log('\nfinancial attribution is protected (ruling C)');

  await check('a replacement with billing attribution CANNOT be deleted', async () => {
    await client.exec(
      `INSERT INTO billing_line_items (order_id, shipment_id, line_type, description, replacement_id)
       VALUES (1321, 1, 'replace_postage', 'Replacement postage', ${firstId});`,
    );
    await assert.rejects(
      () => client.exec(`DELETE FROM replacements WHERE id = ${firstId};`),
      /foreign key constraint/i,
    );
  });

  await check('a credit note attribution is protected the same way', async () => {
    await client.exec(
      `INSERT INTO billing_credit_notes (id, reason, replacement_id)
       VALUES ('cn-1', 'cancelled replacement', ${firstId});`,
    );
    await assert.rejects(
      () => client.exec(`DELETE FROM replacements WHERE id = ${firstId};`),
      /foreign key constraint/i,
    );
  });

  await check('a description reword cannot mint a second replacement charge', async () => {
    await assert.rejects(
      () => client.exec(
        `INSERT INTO billing_line_items (order_id, shipment_id, line_type, description, replacement_id)
         VALUES (1321, 1, 'replace_postage', 'Replacement postage (revised wording)', ${firstId});`,
      ),
      /duplicate key value|unique constraint/i,
    );
  });

  await check('a replacement billing line without its shipment is rejected', async () => {
    await assert.rejects(
      () => client.exec(
        `INSERT INTO billing_line_items (order_id, shipment_id, line_type, description, replacement_id)
         VALUES (1321, NULL, 'replace_pick_pack', 'Pick/pack', ${firstId});`,
      ),
      /check constraint/i,
    );
  });

  await client.close();
  console.log(`\nPS-502 integration passed — ${passed} checks against a real PostgreSQL engine.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
