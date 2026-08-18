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
// Shared with the PG17 lane: a behaviour proven against one schema says nothing about the
// other, and the divergence would be invisible until a case passed here and failed there.
import {
  PS_502_MIGRATIONS,
  PS_502_PREREQUISITE_DDL,
  PS_502_SEED_SQL,
} from './lib/ps-502-test-schema.js';

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed += 1;
  console.log(`ok   ${name}`);
}

const PREREQUISITE_DDL = PS_502_PREREQUISITE_DDL;
const MIGRATIONS = PS_502_MIGRATIONS;

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
    // Named explicitly rather than counted by prefix: a prefix count silently changes
    // meaning every time a replacement_* table is added, which is exactly what happened
    // when 0100 landed.
    for (const table of [
      'replacements', 'replacement_items', 'replacement_activity_events',
      'replacement_label_purchase_intents', 'replacement_item_remaps',
    ]) {
      const rows = await client.query<{ c: number }>(
        `select count(*)::int as c from information_schema.tables where table_name = '${table}'`,
      );
      assert.equal(rows.rows[0]!.c, 1, `${table} should exist`);
    }
  });
  await check('the migrations are re-runnable (applied twice, no error)', async () => {
    await applyMigrations(client);
  });

  const db = drizzle(client, { schema, casing: 'snake_case' });
  const conn = db as unknown as Parameters<typeof createReplacement>[1];

  // A shipped original: 3 x SKU-A at line 0, 2 x SKU-B at line 1.
  await client.exec(PS_502_SEED_SQL);
  const actor = { email: 'op@example.test', type: 'operator', permissions: ['replacements:create'] };
  const FINANCE_ACTOR = {
    email: 'finance@example.test',
    type: 'admin',
    permissions: ['replacements:create', 'replacements:billing', 'financials:write'],
  };

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

  // Hermes re-audit correction 1: the signature must cover the WHOLE request. Same key,
  // same items, different money or liability INTENT must not silently return the earlier
  // replacement — the caller would believe its new intent had been recorded.
  const sameKeySameItems = {
    orderId: 1321,
    items: [{ orderLineIndex: 0, quantity: 1 }],
    requestIdempotencyKey: 'req-1',
    actor,
  } as const;

  for (const [label, patch] of [
    ['a different reason', { reason: 'lost_in_transit', liabilityOwner: 'operator' }],
    ['a different liability owner', { reason: 'damaged', liabilityOwner: 'client' }],
  ] as const) {
    await check(`the same key with ${label} is a coded conflict`, async () => {
      await assert.rejects(
        () => createReplacement({
          ...sameKeySameItems,
          ...patch,
          actor: FINANCE_ACTOR,
          billabilityReason: 'client accepted liability',
        }, conn),
        (e: unknown) => e instanceof ReplacementCreateError
          && e.code === 'REPLACEMENT_IDEMPOTENCY_MISMATCH',
      );
    });
  }

  // Hermes re-audit correction 2: an authorized client-liability decision of FALSE still
  // required a reason, and that reason was being validated and then discarded — losing
  // exactly the justification an auditor would look for.
  await check('an authorized client-liability FALSE records its reason', async () => {
    const result = await createReplacement({
      orderId: 1321, reason: 'other', liabilityOwner: 'client',
      items: [{ orderLineIndex: 1, quantity: 1 }],
      requestedBillable: false,
      billabilityReason: 'goodwill gesture, not charged',
      requestIdempotencyKey: 'req-nonbillable', actor: FINANCE_ACTOR,
    }, conn);
    assert.equal(result.replacement.billable, false);
    const events = await db.select().from(schema.replacementActivityEvents)
      .where(eq(schema.replacementActivityEvents.replacementId, result.replacement.id));
    const billability = events.find((e) => e.eventType === 'replacement_billability_set');
    assert.ok(billability, 'an authorized FALSE is still a decision and needs its event');
    assert.equal(billability!.detail, 'goodwill gesture, not charged');
  });

  await check('operator-liability forced-false needs NO privileged billability event', async () => {
    const result = await createReplacement({
      orderId: 1321, reason: 'other', liabilityOwner: 'operator',
      items: [{ orderLineIndex: 1, quantity: 1 }],
      requestIdempotencyKey: 'req-forced', actor,
    }, conn);
    const events = await db.select().from(schema.replacementActivityEvents)
      .where(eq(schema.replacementActivityEvents.replacementId, result.replacement.id));
    assert.ok(!events.some((e) => e.eventType === 'replacement_billability_set'),
      'a policy RESULT is not a decision');
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

  await check('the real sync trigger regenerates order_items without touching frozen facts', async () => {
    const [frozenBefore] = await db.select().from(schema.replacementItems)
      .where(eq(schema.replacementItems.replacementId, firstId));

    // The dangerous sequence: 0025 DELETEs every order_items row for this order and
    // reinserts them with line_index recomputed as (ordinality - 1).
    await client.exec(`UPDATE orders SET items = items WHERE id = 1321;`);

    const regenerated = await client.query<{ c: number }>(
      'select count(*)::int as c from order_items where order_id = 1321',
    );
    assert.equal(regenerated.rows[0]!.c, 2, 'the trigger reinserted both lines');

    const [frozenAfter] = await db.select().from(schema.replacementItems)
      .where(eq(schema.replacementItems.replacementId, firstId));
    assert.ok(frozenAfter, 'replacement items survive the delete/reinsert — there is no FK to order_items');
    assert.equal(frozenAfter!.sourceLineFingerprint, frozenBefore!.sourceLineFingerprint,
      'a shipped replacement\'s frozen facts must survive a later refresh untouched');
    assert.equal(frozenAfter!.originalOrderedQuantity, frozenBefore!.originalOrderedQuantity);
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

  // ISOLATED rows, created directly rather than through the command. A replacement made by
  // createReplacement already has a replacement_activity_events row whose FK is RESTRICT, so
  // deleting it fails BEFORE either financial FK is consulted — the test would pass for the
  // wrong constraint.
  const bareReplacement = async (key: string): Promise<number> => {
    const rows = await client.query<{ id: number }>(
      `insert into replacements (order_id, client_id, reference, reason, request_idempotency_key)
       values (1321, 1, '1321-ISO-${key}', 'other', 'iso-${key}') returning id`,
    );
    return rows.rows[0]!.id;
  };

  await check('the catalog confirms both financial FKs are RESTRICT, not SET NULL', async () => {
    const rows = await client.query<{ table_name: string; confdeltype: string }>(`
      select cl.relname as table_name, c.confdeltype
      from pg_constraint c join pg_class cl on cl.oid = c.conrelid
      where c.contype = 'f' and c.confrelid = 'replacements'::regclass
        and cl.relname in ('billing_line_items','billing_credit_notes')
    `);
    assert.equal(rows.rows.length, 2, 'both financial FKs should exist');
    for (const row of rows.rows) assert.equal(row.confdeltype, 'r', `${row.table_name} must be RESTRICT`);
  });

  await check('a billing LINE alone blocks deleting its replacement', async () => {
    const isolated = await bareReplacement('line');
    await client.exec(
      `INSERT INTO billing_line_items (order_id, shipment_id, line_type, description, replacement_id)
       VALUES (1321, 1, 'replace_postage', 'Isolated postage', ${isolated});`,
    );
    await assert.rejects(
      () => client.exec(`DELETE FROM replacements WHERE id = ${isolated};`),
      /foreign key constraint/i,
    );
  });

  await check('a CREDIT NOTE alone blocks deleting its replacement', async () => {
    const isolated = await bareReplacement('credit');
    await client.exec(
      `INSERT INTO billing_credit_notes (id, reason, replacement_id)
       VALUES ('cn-iso', 'cancelled replacement', ${isolated});`,
    );
    await assert.rejects(
      () => client.exec(`DELETE FROM replacements WHERE id = ${isolated};`),
      /foreign key constraint/i,
    );
  });

  await check('a replacement with NO attribution deletes cleanly (the control)', async () => {
    const isolated = await bareReplacement('control');
    await client.exec(`DELETE FROM replacements WHERE id = ${isolated};`);
  });

  await client.exec(
    `INSERT INTO billing_line_items (order_id, shipment_id, line_type, description, replacement_id)
     VALUES (1321, 1, 'replace_postage', 'Replacement postage', ${firstId});`,
  );
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
  console.log(`\nPS-502 integration passed — ${passed} checks against embedded PGlite (PostgreSQL-compatible, single-backend). Genuine multi-backend concurrency is NOT proven here.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
