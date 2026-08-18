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
import { eq, inArray, sql } from 'drizzle-orm';
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
  const { env } = await import('../src/lib/env.js');
  const {
    purchaseReplacementLabel, ReplacementLabelError, replacementProviderIdempotencyKey,
    classifyProviderFailure,
  } = await import('../src/services/replacement-label-purchase-command.js');
  const {
    voidReplacementLabel, reconcileReplacementPurchaseIntent, ReplacementVoidError,
  } = await import('../src/services/replacement-label-void-command.js');
  const { shipReplacement, ReplacementShippedError } =
    await import('../src/services/replacement-shipped-command.js');
  const { writeReplacementBillingInTransaction } =
    await import('../src/services/replacement-billing-writer.js');
  const { planReplacementBillingLines, ReplacementBillingPlanError } =
    await import('../src/services/replacement-billing-planner.js');
  const {
    approveReplacement, rejectReplacement, cancelReplacement, resolveReplacementReview,
    remapReplacementItem, setReplacementBillability, completeReplacement,
    ReplacementLifecycleError,
  } = await import('../src/services/replacement-lifecycle-command.js');
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
    assert.equal(regenerated.rows[0]!.c, 3, 'the trigger reinserted every line');

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
      `INSERT INTO billing_line_items (client_id, order_id, shipment_id, line_type, description, unit_cost, total_cost, replacement_id)
       VALUES (1, 1321, 1, 'replace_postage', 'Isolated postage', 1, 1, ${isolated});`,
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
    `INSERT INTO billing_line_items (client_id, order_id, shipment_id, line_type, description, unit_cost, total_cost, replacement_id)
     VALUES (1, 1321, 1, 'replace_postage', 'Replacement postage', 1, 1, ${firstId});`,
  );
  await check('a description reword cannot mint a second replacement charge', async () => {
    await assert.rejects(
      () => client.exec(
        `INSERT INTO billing_line_items (client_id, order_id, shipment_id, line_type, description, unit_cost, total_cost, replacement_id)
         VALUES (1, 1321, 1, 'replace_postage', 'Replacement postage (revised wording)', 1, 1, ${firstId});`,
      ),
      /duplicate key value|unique constraint/i,
    );
  });

  await check('a replacement billing line without its shipment is rejected', async () => {
    await assert.rejects(
      () => client.exec(
        `INSERT INTO billing_line_items (client_id, order_id, shipment_id, line_type, description, unit_cost, total_cost, replacement_id)
         VALUES (1, 1321, NULL, 'replace_pick_pack', 'Pick/pack', 1, 1, ${firstId});`,
      ),
      /check constraint/i,
    );
  });

  console.log('\nlifecycle command');

  const OVERRIDE_ACTOR = {
    email: 'lead@example.test', type: 'admin',
    permissions: ['replacements:create', 'replacements:override'],
  };

  const makeReplacement = async (key: string, lineIndex = 1, quantity = 1) => {
    const r = await createReplacement({
      orderId: 1321, reason: 'damaged', liabilityOwner: 'operator',
      items: [{ orderLineIndex: lineIndex, quantity }],
      requestIdempotencyKey: key, actor,
    }, conn);
    return r.replacement;
  };

  await check('approval moves requested -> approved and appends ONE event', async () => {
    const r = await makeReplacement('lc-approve');
    const approved = await approveReplacement({ replacementId: r.id, actor, reason: 'ok' }, conn);
    assert.equal(approved.status, 'approved');
    assert.equal(approved.stateVersion, r.stateVersion + 1, 'the version must advance');
    const events = await db.select().from(schema.replacementActivityEvents)
      .where(eq(schema.replacementActivityEvents.replacementId, r.id));
    assert.equal(events.filter((e) => e.eventType === 'replacement_approved').length, 1,
      'exactly one event per successful transition');
  });

  await check('a transition the diagram forbids is refused before any write', async () => {
    const r = await makeReplacement('lc-illegal');
    const versionBefore = r.stateVersion;
    await assert.rejects(
      () => completeReplacement({
        replacementId: r.id, actor, basis: 'audited_override', reason: 'jump the queue',
      }, conn),
      (e: unknown) => e instanceof Error,
    );
    const [after] = await db.select().from(schema.replacements)
      .where(eq(schema.replacements.id, r.id));
    assert.equal(after!.status, 'requested', 'the status must not move');
    assert.equal(after!.stateVersion, versionBefore, 'nor the version');
    const events = await db.select().from(schema.replacementActivityEvents)
      .where(eq(schema.replacementActivityEvents.replacementId, r.id));
    assert.ok(!events.some((e) => e.eventType.startsWith('replacement_completed')),
      'a refused transition appends no event');
  });

  await check('rejection and cancellation require a written reason', async () => {
    const a = await makeReplacement('lc-reject');
    await assert.rejects(
      () => rejectReplacement({ replacementId: a.id, actor, reason: '   ' }, conn),
      (e: unknown) => e instanceof ReplacementLifecycleError
        && e.code === 'REPLACEMENT_REASON_REQUIRED',
    );
    const b = await makeReplacement('lc-cancel');
    await assert.rejects(
      () => cancelReplacement({ replacementId: b.id, actor, reason: '' }, conn),
      (e: unknown) => e instanceof ReplacementLifecycleError
        && e.code === 'REPLACEMENT_REASON_REQUIRED',
    );
  });

  await check('approval re-resolves drift: review COMMITS and the command returns 409', async () => {
    const r = await makeReplacement('lc-drift');
    await client.exec(`UPDATE order_items SET quantity = 7 WHERE order_id = 1321 AND line_index = 1;`);
    await assert.rejects(
      () => approveReplacement({ replacementId: r.id, actor, reason: 'ok' }, conn),
      (e: unknown) => e instanceof ReplacementLifecycleError
        && e.code === 'REPLACEMENT_SOURCE_LINE_CHANGED',
    );
    const [after] = await db.select().from(schema.replacements)
      .where(eq(schema.replacements.id, r.id));
    assert.equal(after!.status, 'review', 'the review must survive the failed approval');
    assert.equal(after!.reviewReason, 'original_order_line_drift');
    await client.exec(`UPDATE order_items SET quantity = 2 WHERE order_id = 1321 AND line_index = 1;`);
  });

  await check('review is left to an explicit pre-ship state and clears its reason', async () => {
    const r = await makeReplacement('lc-review');
    await db.update(schema.replacements)
      .set({ status: 'review', reviewReason: 'original_order_line_drift' })
      .where(eq(schema.replacements.id, r.id));
    const resolved = await resolveReplacementReview({
      replacementId: r.id, to: 'approved', actor, reason: 'line confirmed',
    }, conn);
    assert.equal(resolved.status, 'approved');
    assert.equal(resolved.reviewReason, null);
  });

  await check('a remap requires the override capability', async () => {
    const r = await makeReplacement('lc-remap-perm');
    const [item] = await db.select().from(schema.replacementItems)
      .where(eq(schema.replacementItems.replacementId, r.id));
    await assert.rejects(
      () => remapReplacementItem({
        replacementId: r.id, replacementItemId: item!.id, toOrderLineIndex: 0,
        actor, reason: 'retarget',
      }, conn),
      (e: unknown) => e instanceof ReplacementLifecycleError
        && e.code === 'REPLACEMENT_REMAP_FORBIDDEN',
    );
  });

  await check('a remap appends evidence and NEVER rewrites the requested snapshot', async () => {
    const r = await makeReplacement('lc-remap');
    const [item] = await db.select().from(schema.replacementItems)
      .where(eq(schema.replacementItems.replacementId, r.id));
    const frozenBefore = item!.sourceLineFingerprint;

    const result = await remapReplacementItem({
      replacementId: r.id, replacementItemId: item!.id, toOrderLineIndex: 0,
      actor: OVERRIDE_ACTOR, reason: 'operator confirmed the wrong line was requested',
    }, conn);
    assert.equal(result.remapVersion, 1);

    const [after] = await db.select().from(schema.replacementItems)
      .where(eq(schema.replacementItems.id, item!.id));
    assert.equal(after!.sourceLineFingerprint, frozenBefore,
      'the REQUESTED snapshot must survive the remap');
    assert.equal(after!.orderLineIndex, item!.orderLineIndex);

    const remaps = await db.select().from(schema.replacementItemRemaps)
      .where(eq(schema.replacementItemRemaps.replacementItemId, item!.id));
    assert.equal(remaps.length, 1, 'the resolution is separately attributable');
    assert.equal(remaps[0]!.previousSourceLineFingerprint, frozenBefore);
    assert.equal(remaps[0]!.resolution, 'remapped');
    assert.match(String(remaps[0]!.reason), /wrong line/);
  });

  await check('a remap onto an exhausted line is refused', async () => {
    // Line 0 already has 1 shipped unit from an earlier case, so 2 exhausts it.
    const shipped = await makeReplacement('lc-remap-cap-src', 0, 2);
    await db.update(schema.replacements)
      .set({ status: 'shipped', shippedAt: new Date() })
      .where(eq(schema.replacements.id, shipped.id));

    const r = await makeReplacement('lc-remap-cap');
    const [item] = await db.select().from(schema.replacementItems)
      .where(eq(schema.replacementItems.replacementId, r.id));
    await assert.rejects(
      () => remapReplacementItem({
        replacementId: r.id, replacementItemId: item!.id, toOrderLineIndex: 0,
        actor: OVERRIDE_ACTOR, reason: 'retarget onto a full line',
      }, conn),
      (e: unknown) => e instanceof ReplacementLifecycleError
        && e.code === 'REPLACEMENT_ALLOWANCE_EXCEEDED',
    );
  });

  await check('billability is frozen from label_created onward', async () => {
    const r = await makeReplacement('lc-bill');
    await db.update(schema.replacements)
      .set({ liabilityOwner: 'client', status: 'label_created' })
      .where(eq(schema.replacements.id, r.id));
    await assert.rejects(
      () => setReplacementBillability({
        replacementId: r.id, requestedBillable: true, actor: FINANCE_ACTOR,
        reason: 'late change',
      }, conn),
      (e: unknown) => e instanceof ReplacementLifecycleError
        && e.code === 'REPLACEMENT_BILLABLE_FROZEN',
    );
  });

  await check('completion records its basis and stamps completed_at', async () => {
    const r = await makeReplacement('lc-complete');
    await db.update(schema.replacements)
      .set({ status: 'shipped', shippedAt: new Date() })
      .where(eq(schema.replacements.id, r.id));
    const done = await completeReplacement({
      replacementId: r.id, actor, basis: 'tracking_evidence', reason: 'delivered',
    }, conn);
    assert.equal(done.status, 'completed');
    assert.ok(done.completedAt);
    const events = await db.select().from(schema.replacementActivityEvents)
      .where(eq(schema.replacementActivityEvents.replacementId, r.id));
    assert.ok(events.some((e) => e.eventType === 'replacement_completed_tracking_evidence'),
      'the basis for completion is part of the record');
  });

  console.log('\nlabel purchase');

  // A fake provider. No real postage is reachable from this suite, and every assertion
  // below counts its calls — "the command threw" would not reveal a second purchase.
  let providerCalls = 0;
  let lastIdempotencyKey = '';
  const fakeProvider = {
    purchase: async ({ idempotencyKey }: { idempotencyKey: string }) => {
      providerCalls += 1;
      lastIdempotencyKey = idempotencyKey;
      return {
        providerTransactionId: `txn-${providerCalls}`,
        providerLabelId: `lbl-${providerCalls}`,
        trackingNumber: '1Z-TEST',
        labelUrl: 'https://example.test/label.pdf',
        shipmentCost: 8.25,
        otherCost: 1.5,
      };
    },
  };

  const PURCHASE_INPUTS = {
    address: {
      value: {
        name: 'Jane Roe', line1: '1 Test Way', city: 'Springfield',
        state: 'IL', postalCode: '62704', country: 'US',
      },
      source: 'operator_override' as const,
      chosenBy: 'lead@example.test', reason: 'customer confirmed address',
    },
    carrier: {
      value: { carrierCode: 'ups', serviceCode: 'ups_ground', providerAccountId: 7 },
      source: 'operator_override' as const,
      chosenBy: 'lead@example.test', reason: 'same service as the original',
    },
    package: {
      value: { packageId: 'box-a', weightOz: 32, dimsL: 10, dimsW: 8, dimsH: 6 },
      source: 'operator_override' as const,
      chosenBy: 'lead@example.test', reason: 'recalculated from the replacement items',
    },
  };

  /** A replacement with an attached shipment, ready to buy. */
  const readyToBuy = async (key: string, lineIndex = 1) => {
    const r = await makeReplacement(key, lineIndex);
    await db.update(schema.replacements)
      .set({ status: 'approved' }).where(eq(schema.replacements.id, r.id));
    await insertReplacementShipment({
      replacementId: r.id, actor: { email: actor.email, type: 'operator' },
    }, conn);
    const [fresh] = await db.select().from(schema.replacements)
      .where(eq(schema.replacements.id, r.id));
    return fresh!;
  };

  await check('the feature gate stops BEFORE any provider call or DB mutation', async () => {
    const r = await readyToBuy('lbl-disabled');
    const callsBefore = providerCalls;
    (env as { REPLACEMENTS_LABEL_ENABLED: boolean }).REPLACEMENTS_LABEL_ENABLED = false;
    await assert.rejects(
      () => purchaseReplacementLabel({
        replacementId: r.id, actor: { email: actor.email, type: 'operator' },
        purchaseInputs: PURCHASE_INPUTS,
      }, fakeProvider, conn),
      (e: unknown) => e instanceof ReplacementLabelError
        && e.code === 'REPLACEMENT_LABEL_FEATURE_DISABLED',
    );
    assert.equal(providerCalls, callsBefore, 'no provider call while dark');
    const intents = await db.select().from(schema.replacementLabelPurchaseIntents)
      .where(eq(schema.replacementLabelPurchaseIntents.replacementId, r.id));
    assert.equal(intents.length, 0, 'and no durable intent written');
    (env as { REPLACEMENTS_LABEL_ENABLED: boolean }).REPLACEMENTS_LABEL_ENABLED = true;
  });

  await check('a successful purchase records the receipt and moves to label_created', async () => {
    const r = await readyToBuy('lbl-ok');
    const before = providerCalls;
    const result = await purchaseReplacementLabel({
      replacementId: r.id, actor: { email: actor.email, type: 'operator' },
      purchaseInputs: PURCHASE_INPUTS,
    }, fakeProvider, conn);

    assert.equal(providerCalls, before + 1, 'exactly one provider call');
    assert.equal(result.purchased, true);

    const [after] = await db.select().from(schema.replacements)
      .where(eq(schema.replacements.id, r.id));
    assert.equal(after!.status, 'label_created');

    const [intent] = await db.select().from(schema.replacementLabelPurchaseIntents)
      .where(eq(schema.replacementLabelPurchaseIntents.replacementId, r.id));
    assert.equal(intent!.state, 'purchased');
    assert.ok(intent!.providerTransactionId, 'stable provider identity is persisted');

    const [ship] = await db.select().from(schema.shipments)
      .where(eq(schema.shipments.id, result.shipmentId));
    assert.equal(String(ship!.cost), '8.25', 'the customer money tuple is frozen');
    assert.equal(String(ship!.otherCost), '1.50');
    assert.equal(String(ship!.selectedRateCost), '9.75', 'and the normalized total agrees');
  });

  await check('the provider identity is replacement-scoped, never the order key', async () => {
    assert.match(lastIdempotencyKey, /^replacement:\d+:shipment:\d+:attempt:1:request:/);
    assert.ok(!lastIdempotencyKey.includes('order'),
      'two replacements on one order must never share a purchase identity');
  });

  await check('AC-11: provider succeeds, the DB tail fails, a retry buys NOTHING more', async () => {
    const r = await readyToBuy('lbl-crash');
    const before = providerCalls;

    // Fail the SECOND transaction — the persistence phase — after the provider succeeded.
    let transactions = 0;
    const crashingConn = {
      transaction: async (fn: never) => {
        transactions += 1;
        if (transactions === 2) throw new Error('simulated process death after purchase');
        return (conn as { transaction: (f: never) => unknown }).transaction(fn);
      },
    } as never;

    await assert.rejects(() => purchaseReplacementLabel({
      replacementId: r.id, actor: { email: actor.email, type: 'operator' },
      purchaseInputs: PURCHASE_INPUTS,
    }, fakeProvider, crashingConn));

    assert.equal(providerCalls, before + 1, 'the provider was called once');

    // The durable intent survives, still unresolved — proof a purchase MAY exist.
    const [intent] = await db.select().from(schema.replacementLabelPurchaseIntents)
      .where(eq(schema.replacementLabelPurchaseIntents.replacementId, r.id));
    assert.equal(intent!.state, 'provider_pending',
      'the intent committed before dispatch is what proves a purchase may have happened');

    // THE POINT: a retry refuses and does NOT dispatch again.
    await assert.rejects(
      () => purchaseReplacementLabel({
        replacementId: r.id, actor: { email: actor.email, type: 'operator' },
        purchaseInputs: PURCHASE_INPUTS,
      }, fakeProvider, conn),
      (e: unknown) => e instanceof ReplacementLabelError
        && e.code === 'REPLACEMENT_LABEL_RECONCILE_REQUIRED',
    );
    assert.equal(providerCalls, before + 1, 'NO second postage purchase');

    const intents = await db.select().from(schema.replacementLabelPurchaseIntents)
      .where(eq(schema.replacementLabelPurchaseIntents.replacementId, r.id));
    assert.equal(intents.length, 1, 'one durable receipt, not two');

    const ships = await db.select().from(schema.shipments)
      .where(eq(schema.shipments.orderId, 1321));
    const forThis = ships.filter((x) => x.id === intent!.replacementShipmentId);
    assert.equal(forThis.length, 1, 'one replacement shipment');
  });

  await check('an unknown provider outcome becomes reconcile_required, never a retry', async () => {
    const r = await readyToBuy('lbl-unknown');
    const before = providerCalls;
    const timingOutProvider = {
      purchase: async () => {
        providerCalls += 1;
        throw new Error('socket hang up');
      },
    };
    await assert.rejects(
      () => purchaseReplacementLabel({
        replacementId: r.id, actor: { email: actor.email, type: 'operator' },
        purchaseInputs: PURCHASE_INPUTS,
      }, timingOutProvider as never, conn),
      (e: unknown) => e instanceof ReplacementLabelError
        && e.code === 'REPLACEMENT_LABEL_RECONCILE_REQUIRED',
    );
    assert.equal(providerCalls, before + 1);
    const [intent] = await db.select().from(schema.replacementLabelPurchaseIntents)
      .where(eq(schema.replacementLabelPurchaseIntents.replacementId, r.id));
    assert.equal(intent!.state, 'reconcile_required');
    assert.equal(intent!.reconciliationState, 'unresolved');
  });

  await check('a provider REJECTION is recoverable, not held for reconciliation', () => {
    assert.equal(classifyProviderFailure(new Error('address rejected')), 'failed_pre_purchase');
    assert.equal(classifyProviderFailure(new Error('socket hang up')), 'reconcile_required');
    assert.equal(classifyProviderFailure(new Error('ETIMEDOUT')), 'reconcile_required',
      'anything we cannot prove did not happen must be reconciled, not retried');
  });

  await check('the idempotency key changes with the frozen request', () => {
    const base = {
      replacementId: 1, replacementShipmentId: 2,
      requestFingerprint: 'fp-a', purchaseAttempt: 1,
    };
    assert.notEqual(
      replacementProviderIdempotencyKey(base),
      replacementProviderIdempotencyKey({ ...base, requestFingerprint: 'fp-b' }),
    );
    assert.notEqual(
      replacementProviderIdempotencyKey(base),
      replacementProviderIdempotencyKey({ ...base, replacementId: 2 }),
    );
  });

  console.log('\nlabel void and reconciliation');

  const LABEL_ACTOR = {
    email: 'lead@example.test', type: 'admin',
    permissions: ['replacements:create', 'replacements:label'],
  };
  let voidCalls = 0;
  const voidingProvider = {
    voidLabel: async () => {
      voidCalls += 1;
      return { providerVoidId: `void-${voidCalls}`, voided: true };
    },
  };

  /** A replacement with a purchased label. */
  const withPurchasedLabel = async (key: string, lineIndex = 1) => {
    const r = await readyToBuy(key, lineIndex);
    await purchaseReplacementLabel({
      replacementId: r.id, actor: { email: actor.email, type: 'operator' },
      purchaseInputs: PURCHASE_INPUTS,
    }, fakeProvider, conn);
    return r;
  };

  await check('a void requires the label capability and a written reason', async () => {
    const r = await withPurchasedLabel('void-perm');
    await assert.rejects(
      () => voidReplacementLabel({
        replacementId: r.id, actor: { ...LABEL_ACTOR, permissions: ['replacements:create'] },
        reason: 'no longer needed',
      }, voidingProvider, conn),
      (e: unknown) => e instanceof ReplacementVoidError && e.code === 'REPLACEMENT_VOID_FORBIDDEN',
    );
    await assert.rejects(
      () => voidReplacementLabel({
        replacementId: r.id, actor: LABEL_ACTOR, reason: '   ',
      }, voidingProvider, conn),
      (e: unknown) => e instanceof ReplacementVoidError
        && e.code === 'REPLACEMENT_VOID_REASON_REQUIRED',
    );
  });

  await check('a confirmed void records the provider identity and an event', async () => {
    const r = await withPurchasedLabel('void-ok');
    const before = voidCalls;
    const result = await voidReplacementLabel({
      replacementId: r.id, actor: LABEL_ACTOR, reason: 'customer cancelled',
    }, voidingProvider, conn);
    assert.equal(result.voided, true);
    assert.equal(voidCalls, before + 1);
    const [intent] = await db.select().from(schema.replacementLabelPurchaseIntents)
      .where(eq(schema.replacementLabelPurchaseIntents.replacementId, r.id));
    assert.equal(intent!.voidState, 'voided');
    assert.ok(intent!.providerVoidId);
    assert.ok(intent!.voidedAt);
    const events = await db.select().from(schema.replacementActivityEvents)
      .where(eq(schema.replacementActivityEvents.replacementId, r.id));
    const voided = events.find((e) => e.eventType === 'replacement_label_voided');
    assert.ok(voided);
    assert.equal(voided!.detail, 'customer cancelled');
  });

  await check('a repeated void sends NO second destructive call', async () => {
    const r = await withPurchasedLabel('void-twice');
    await voidReplacementLabel({
      replacementId: r.id, actor: LABEL_ACTOR, reason: 'first',
    }, voidingProvider, conn);
    const after = voidCalls;
    const again = await voidReplacementLabel({
      replacementId: r.id, actor: LABEL_ACTOR, reason: 'second',
    }, voidingProvider, conn);
    assert.equal(again.voided, false, 'an already-voided label is returned, not re-voided');
    assert.equal(voidCalls, after, 'a repeated destructive call can cancel a later label');
  });

  await check('an UNCONFIRMED void is never recorded as voided', async () => {
    const r = await withPurchasedLabel('void-unconfirmed');
    const unsureProvider = {
      voidLabel: async () => ({ providerVoidId: 'v-?', voided: false }),
    };
    await assert.rejects(
      () => voidReplacementLabel({
        replacementId: r.id, actor: LABEL_ACTOR, reason: 'try',
      }, unsureProvider, conn),
      (e: unknown) => e instanceof ReplacementVoidError
        && e.code === 'REPLACEMENT_VOID_RECONCILE_REQUIRED',
    );
    const [intent] = await db.select().from(schema.replacementLabelPurchaseIntents)
      .where(eq(schema.replacementLabelPurchaseIntents.replacementId, r.id));
    assert.equal(intent!.voidState, 'void_reconcile_required',
      'a local voided row with a live label is worse than no row at all');
  });

  await check('a void TIMEOUT is held for reconciliation, not retried', async () => {
    const r = await withPurchasedLabel('void-timeout');
    const timingOut = { voidLabel: async () => { throw new Error('socket hang up'); } };
    await assert.rejects(
      () => voidReplacementLabel({
        replacementId: r.id, actor: LABEL_ACTOR, reason: 'try',
      }, timingOut, conn),
      (e: unknown) => e instanceof ReplacementVoidError
        && e.code === 'REPLACEMENT_VOID_RECONCILE_REQUIRED',
    );
    const [intent] = await db.select().from(schema.replacementLabelPurchaseIntents)
      .where(eq(schema.replacementLabelPurchaseIntents.replacementId, r.id));
    assert.equal(intent!.voidState, 'void_reconcile_required');
  });

  await check('a stale state_version cannot void', async () => {
    const r = await withPurchasedLabel('void-stale');
    await assert.rejects(
      () => voidReplacementLabel({
        replacementId: r.id, actor: LABEL_ACTOR, reason: 'try',
        expectedStateVersion: 9999,
      }, voidingProvider, conn),
      (e: unknown) => e instanceof ReplacementVoidError
        && e.code === 'REPLACEMENT_STATE_CONFLICT',
    );
  });

  await check('a replacement with no purchased label cannot be voided', async () => {
    const r = await makeReplacement('void-nolabel');
    await assert.rejects(
      () => voidReplacementLabel({
        replacementId: r.id, actor: LABEL_ACTOR, reason: 'try',
      }, voidingProvider, conn),
      (e: unknown) => e instanceof ReplacementVoidError
        && e.code === 'REPLACEMENT_VOID_NO_ACTIVE_LABEL',
    );
  });

  await check('reconciliation resolves an orphaned intent the provider CONFIRMS', async () => {
    const r = await readyToBuy('recon-found');
    let transactions = 0;
    const crashingConn = {
      transaction: async (fn: never) => {
        transactions += 1;
        if (transactions === 2) throw new Error('crash after purchase');
        return (conn as { transaction: (f: never) => unknown }).transaction(fn);
      },
    } as never;
    await assert.rejects(() => purchaseReplacementLabel({
      replacementId: r.id, actor: { email: actor.email, type: 'operator' },
      purchaseInputs: PURCHASE_INPUTS,
    }, fakeProvider, crashingConn));

    const [orphan] = await db.select().from(schema.replacementLabelPurchaseIntents)
      .where(eq(schema.replacementLabelPurchaseIntents.replacementId, r.id));
    assert.equal(orphan!.state, 'provider_pending');

    const knowingProvider = {
      voidLabel: async () => ({ providerVoidId: 'x', voided: true }),
      lookupPurchase: async () => ({
        providerTransactionId: 'txn-recovered', providerLabelId: 'lbl-recovered',
        shipmentCost: 8.25, otherCost: 1.5,
      }),
    };
    const outcome = await reconcileReplacementPurchaseIntent({
      intentId: orphan!.id, actor: LABEL_ACTOR, reason: 'operator reconciliation',
    }, knowingProvider as never, conn);
    assert.equal(outcome.outcome, 'purchased');

    const [resolved] = await db.select().from(schema.replacementLabelPurchaseIntents)
      .where(eq(schema.replacementLabelPurchaseIntents.id, orphan!.id));
    assert.equal(resolved!.state, 'purchased');
    assert.equal(resolved!.providerTransactionId, 'txn-recovered');
    assert.equal(resolved!.reconciliationState, 'resolved_purchased');
  });

  await check('reconciliation closes an intent the provider is CERTAIN never bought', async () => {
    const r = await readyToBuy('recon-absent');
    let transactions = 0;
    const crashingConn = {
      transaction: async (fn: never) => {
        transactions += 1;
        if (transactions === 2) throw new Error('crash after purchase');
        return (conn as { transaction: (f: never) => unknown }).transaction(fn);
      },
    } as never;
    await assert.rejects(() => purchaseReplacementLabel({
      replacementId: r.id, actor: { email: actor.email, type: 'operator' },
      purchaseInputs: PURCHASE_INPUTS,
    }, fakeProvider, crashingConn));
    const [orphan] = await db.select().from(schema.replacementLabelPurchaseIntents)
      .where(eq(schema.replacementLabelPurchaseIntents.replacementId, r.id));

    const certainProvider = {
      voidLabel: async () => ({ providerVoidId: 'x', voided: true }),
      lookupPurchase: async () => null,
    };
    const outcome = await reconcileReplacementPurchaseIntent({
      intentId: orphan!.id, actor: LABEL_ACTOR, reason: 'provider has no record',
    }, certainProvider as never, conn);
    assert.equal(outcome.outcome, 'failed_pre_purchase');
  });

  await check('a provider that CANNOT tell leaves the intent unresolved', async () => {
    const r = await readyToBuy('recon-unknown');
    let transactions = 0;
    const crashingConn = {
      transaction: async (fn: never) => {
        transactions += 1;
        if (transactions === 2) throw new Error('crash after purchase');
        return (conn as { transaction: (f: never) => unknown }).transaction(fn);
      },
    } as never;
    await assert.rejects(() => purchaseReplacementLabel({
      replacementId: r.id, actor: { email: actor.email, type: 'operator' },
      purchaseInputs: PURCHASE_INPUTS,
    }, fakeProvider, crashingConn));
    const [orphan] = await db.select().from(schema.replacementLabelPurchaseIntents)
      .where(eq(schema.replacementLabelPurchaseIntents.replacementId, r.id));

    const unsureProvider = {
      voidLabel: async () => ({ providerVoidId: 'x', voided: true }),
      lookupPurchase: async () => { throw new Error('provider unavailable'); },
    };
    const outcome = await reconcileReplacementPurchaseIntent({
      intentId: orphan!.id, actor: LABEL_ACTOR, reason: 'attempt',
    }, unsureProvider as never, conn);
    assert.equal(outcome.outcome, 'still_unknown',
      'an operator chasing a stuck row beats a silent second purchase');
    const [after] = await db.select().from(schema.replacementLabelPurchaseIntents)
      .where(eq(schema.replacementLabelPurchaseIntents.id, orphan!.id));
    assert.equal(after!.state, 'reconcile_required');
  });

  console.log('\nreplacement billing');

  const PLAN_FACTS = {
    replacementId: 1, orderId: 1321, clientId: 1,
    reference: '1321-REPLACE', replacementShipmentId: 5, billable: true,
    money: { shipmentCost: 8.25, otherCost: 1.5 },
    pickPackCharge: 2.5,
    shipDate: new Date('2026-08-18T00:00:00Z'),
    billingEffectiveDate: new Date('2026-08-18T00:00:00Z'),
    billingPolicyVersion: 'v1',
  };

  await check('a NON-billable replacement plans NO line, not a zero line', () => {
    const lines = planReplacementBillingLines({ ...PLAN_FACTS, billable: false });
    assert.equal(lines.length, 0, 'absence and $0.00 are different claims');
  });

  await check('a billable replacement plans the COMPLETE set', () => {
    const lines = planReplacementBillingLines(PLAN_FACTS);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((l) => l.lineType).sort(), ['replace_pick_pack', 'replace_postage']);
    const postage = lines.find((l) => l.lineType === 'replace_postage');
    assert.equal(postage!.totalCost, '9.75', 'postage is shipmentCost + otherCost, frozen');
    assert.equal(postage!.orderNumber, '1321-REPLACE', 'the ALLOCATED reference, not the order number');
    assert.equal(postage!.orderId, 1321, 'the ORIGINAL order relationally');
  });

  await check('a missing frozen money tuple FAILS CLOSED', () => {
    let err: unknown = null;
    try {
      planReplacementBillingLines({ ...PLAN_FACTS, money: { shipmentCost: null, otherCost: 1.5 } });
    } catch (e) { err = e; }
    assert.ok(err instanceof ReplacementBillingPlanError
      && err.code === 'REPLACEMENT_BILLING_MONEY_UNAVAILABLE',
      'a live quote is not a substitute for what was actually paid');
  });

  await check('a missing pick/pack authority FAILS CLOSED', () => {
    let err: unknown = null;
    try {
      planReplacementBillingLines({ ...PLAN_FACTS, pickPackCharge: null });
    } catch (e) { err = e; }
    assert.ok(err instanceof ReplacementBillingPlanError
      && err.code === 'REPLACEMENT_BILLING_PICK_PACK_UNAVAILABLE');
  });

  // ── The atomic shipped command, executed end to end ──────────────────────
  await client.exec(`
    INSERT INTO inventory (id, sku, name, client_id) VALUES
      (900, 'SKU-C', 'Widget C', 1);
  `);

  const packageConsumer = async () => ({ consumed: true });
  const billingWriter = async (tx: unknown, input: { replacement: { id: number; orderId: number; clientId: number | null; reference: string; replacementShipmentId: number | null; billable: boolean } ; shipmentId: number }) =>
    writeReplacementBillingInTransaction(tx, {
      replacementId: input.replacement.id,
      orderId: input.replacement.orderId,
      clientId: input.replacement.clientId ?? 1,
      reference: input.replacement.reference,
      replacementShipmentId: input.shipmentId,
      billable: input.replacement.billable,
      money: { shipmentCost: 8.25, otherCost: 1.5 },
      pickPackCharge: 2.5,
      shipDate: new Date(),
      billingEffectiveDate: new Date(),
      billingPolicyVersion: 'v1',
    });

  /** A billable replacement with a purchased label, ready to ship. */
  const readyToShip = async (key: string) => {
    // Line 2 has headroom; lines 0 and 1 are where the allowance cases deliberately
    // exhaust the cap, and reusing them here would make these fixtures fight those.
    const r = await withPurchasedLabel(key, 2);
    await db.update(schema.replacements)
      .set({ billable: true, liabilityOwner: 'client' })
      .where(eq(schema.replacements.id, r.id));
    const [items] = await db.select().from(schema.replacementItems)
      .where(eq(schema.replacementItems.replacementId, r.id));
    return { replacementId: r.id, itemId: items!.id };
  };

  await check('AC-4: two replacements on one order persist FOUR lines with exact attribution', async () => {
    const a = await readyToShip('bill-a');
    const b = await readyToShip('bill-b');

    for (const target of [a, b]) {
      const result = await shipReplacement({
        replacementId: target.replacementId, actor: { email: actor.email, type: 'operator' },
        inventoryLines: [{ replacementItemId: target.itemId, inventoryId: 900, qty: 1 }],
        consumePackage: packageConsumer,
        writeBilling: billingWriter as never,
      }, conn);
      assert.equal(result.shipped, true, 'the replacement shipped');
      assert.equal(result.billingLinesWritten, 2, 'both lines, or none');
    }

    const lines = await db.select().from(schema.billingLineItems)
      .where(inArray(schema.billingLineItems.replacementId, [a.replacementId, b.replacementId]));
    assert.equal(lines.length, 4, 'exactly four persisted rows, not four calls that returned');

    for (const target of [a, b]) {
      const mine = lines.filter((l) => l.replacementId === target.replacementId);
      assert.equal(mine.length, 2, 'each replacement owns exactly two');
      const total = mine.reduce((sum, l) => sum + Number(l.totalCost), 0);
      assert.equal(total.toFixed(2), '12.25', '9.75 postage + 2.50 pick/pack');
      for (const line of mine) {
        assert.equal(line.orderId, 1321, 'the ORIGINAL order relationally');
        assert.ok(String(line.orderNumber).startsWith('1321-REPLACE'),
          'the allocated reference visibly');
      }
    }
  });

  await check('the cross-table invariant holds: line.shipment_id = replacement shipment', async () => {
    const lines = await db.select().from(schema.billingLineItems)
      .where(eq(schema.billingLineItems.lineType, 'replace_postage'));
    for (const line of lines) {
      const [r] = await db.select().from(schema.replacements)
        .where(eq(schema.replacements.id, line.replacementId!));
      // The ruling-C cases insert bare fixture rows by hand against replacements that have
      // no shipment. Those are testing the FK, not the writer, so they are not in scope here.
      if (r!.replacementShipmentId == null) continue;
      assert.equal(line.shipmentId, r!.replacementShipmentId);
      assert.equal(line.orderId, r!.orderId);
    }
  });

  await check('a description reword cannot mint a SECOND replacement charge', async () => {
    const [existing] = await db.select().from(schema.billingLineItems)
      .where(eq(schema.billingLineItems.lineType, 'replace_postage'));
    await assert.rejects(
      () => client.exec(
        `INSERT INTO billing_line_items (client_id, order_id, order_number, shipment_id,
           line_type, description, unit_cost, total_cost, replacement_id)
         VALUES (1, 1321, '1321-REPLACE', ${existing!.shipmentId},
           'replace_postage', 'Replacement postage (reworded)', 9.75, 9.75, ${existing!.replacementId});`,
      ),
      /duplicate key value|unique constraint/i,
      'identity lives in replacement_id + line_type, not in the description');
  });

  await check('a NON-billable replacement ships with NO billing row', async () => {
    const t = await readyToShip('bill-none');
    await db.update(schema.replacements).set({ billable: false })
      .where(eq(schema.replacements.id, t.replacementId));
    const result = await shipReplacement({
      replacementId: t.replacementId, actor: { email: actor.email, type: 'operator' },
      inventoryLines: [{ replacementItemId: t.itemId, inventoryId: 900, qty: 1 }],
      consumePackage: packageConsumer,
      writeBilling: billingWriter as never,
    }, conn);
    assert.equal(result.shipped, true);
    assert.equal(result.billingLinesWritten, 0);
    const lines = await db.select().from(schema.billingLineItems)
      .where(eq(schema.billingLineItems.replacementId, t.replacementId));
    assert.equal(lines.length, 0, 'assert ABSENCE, not a zero row');
  });

  await check('stock is deducted once per replacement item, and a retry adds nothing', async () => {
    const t = await readyToShip('bill-stock');
    const before = await client.query<{ q: number }>(
      'select coalesce(sum(qty),0)::int as q from inventory_ledger where inventory_id = 900');
    const first = await shipReplacement({
      replacementId: t.replacementId, actor: { email: actor.email, type: 'operator' },
      inventoryLines: [{ replacementItemId: t.itemId, inventoryId: 900, qty: 1 }],
      consumePackage: packageConsumer, writeBilling: billingWriter as never,
    }, conn);
    assert.equal(first.inventoryApplied, 1);
    const afterFirst = await client.query<{ q: number }>(
      'select coalesce(sum(qty),0)::int as q from inventory_ledger where inventory_id = 900');
    assert.equal(afterFirst.rows[0]!.q, before.rows[0]!.q - 1);

    const again = await shipReplacement({
      replacementId: t.replacementId, actor: { email: actor.email, type: 'operator' },
      inventoryLines: [{ replacementItemId: t.itemId, inventoryId: 900, qty: 1 }],
      consumePackage: packageConsumer, writeBilling: billingWriter as never,
    }, conn);
    assert.equal(again.shipped, false, 'a retry is a no-op');
    const afterRetry = await client.query<{ q: number }>(
      'select coalesce(sum(qty),0)::int as q from inventory_ledger where inventory_id = 900');
    assert.equal(afterRetry.rows[0]!.q, afterFirst.rows[0]!.q,
      'no double deduction');
  });

  await check('INVENTORY_AUTO_DEDUCT off blocks shipping and writes NOTHING', async () => {
    const t = await readyToShip('bill-killswitch');
    (env as { INVENTORY_AUTO_DEDUCT: boolean }).INVENTORY_AUTO_DEDUCT = false;
    await assert.rejects(
      () => shipReplacement({
        replacementId: t.replacementId, actor: { email: actor.email, type: 'operator' },
        inventoryLines: [{ replacementItemId: t.itemId, inventoryId: 900, qty: 1 }],
        consumePackage: packageConsumer, writeBilling: billingWriter as never,
      }, conn),
      (e: unknown) => e instanceof ReplacementShippedError
        && e.code === 'REPLACEMENT_INVENTORY_DISABLED',
    );
    (env as { INVENTORY_AUTO_DEDUCT: boolean }).INVENTORY_AUTO_DEDUCT = true;
    const [after] = await db.select().from(schema.replacements)
      .where(eq(schema.replacements.id, t.replacementId));
    assert.equal(after!.status, 'label_created', 'it stays put');
    assert.equal(after!.shippedAt, null);
    const lines = await db.select().from(schema.billingLineItems)
      .where(eq(schema.billingLineItems.replacementId, t.replacementId));
    assert.equal(lines.length, 0, 'no billing row');
  });

  await client.close();
  console.log(`\nPS-502 integration passed — ${passed} checks against embedded PGlite (PostgreSQL-compatible, single-backend). Genuine multi-backend concurrency is NOT proven here.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
