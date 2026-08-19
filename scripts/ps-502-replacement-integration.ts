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

/**
 * A frozen customer-money tuple that reconciles: carrier 8.25, customer 9.75, margin 1.50.
 *
 * The billed postage is the same 9.75 the old carrier-sum produced, which is the point — the
 * NUMBER did not have to change for the SOURCE to become correct, and that is exactly why the
 * old shape survived review.
 */
const FROZEN_CUSTOMER_MONEY = {
  selectedRateCost: 8.25,
  cShippingRateAmount: 9.75,
  shippingMarginAmount: 1.5,
  shippingMarginPct: 18.18,
  customerRateSource: 'realized_customer_shipping_rate',
  rateCostSource: 'label_final_cost',
  customerShippingMoneyPolicyVersion: 'ps-437-v1',
  customerShippingPricingAuthority: {
    policyOwner: 'billing_config',
    policyId: 'billing_config:1',
    policyRowVersion: '2026-08-18T00:00:00.000Z',
    policyActive: true,
    clientId: 1,
    billingMode: 'markup',
    perAccountMarkupEnabled: false,
    markupAuthority: 'client_billing_config',
    markupRuleKey: 'billing_config.shipping_markup_pct+shipping_markup_flat',
    markupPct: 18,
    markupFlat: 0,
    markupAdjustmentKind: 'customer_profit_markup',
    providerAccountId: null,
    selectedOverrideIdentity: null,
    appliedHugrabOverrideIdentity: null,
    billingSource: 'c_shipping_rate',
  },
};
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
  const { selectReplacementProviderCredentialAuthority } =
    await import('../src/services/replacement-provider-credential-authority.js');
  const { shipReplacement, ReplacementShippedError } =
    await import('../src/services/replacement-shipped-command.js');
  const { writeReplacementBillingInTransaction } =
    await import('../src/services/replacement-billing-writer.js');
  const { deleteOutboundBillingLinesForRebuild } =
    await import('../src/services/billing-outbound-sweep.js');
  const { resolveReplacementCustomerPostage } =
    await import('../src/services/replacement-customer-money.js');
  const { cancelReplacementBillingInTransaction } =
    await import('../src/services/replacement-billing-writer.js');
  const { regenerateReplacementBillingInTransaction } =
    await import('../src/services/replacement-billing-writer.js');
  const { planReplacementBillingLines, ReplacementBillingPlanError } =
    await import('../src/services/replacement-billing-planner.js');
  const {
    approveReplacement, rejectReplacement, cancelReplacement, resolveReplacementReview,
    remapReplacementItem, setReplacementBillability, completeReplacement,
    ReplacementLifecycleError,
  } = await import('../src/services/replacement-lifecycle-command.js');
  const {
    requestReplacementFinancialReversal,
    processReplacementFinancialAction,
    readReplacementFinancialAction,
  } = await import('../src/services/replacement-financial-action.js');
  const { insertReplacementShipment, ReplacementShipmentError } =
    await import('../src/services/replacement-shipment-command.js');
  const { writeReplacementBilling } =
    await import('../src/services/replacement-shipping-execution.js');

  const client = new PGlite();
  await client.exec(PREREQUISITE_DDL);

  console.log('\nmigrations');
  await applyMigrations(client);
  await check('0096 through 0103 apply against a real PostgreSQL engine', async () => {
    // Named explicitly rather than counted by prefix: a prefix count silently changes
    // meaning every time a replacement_* table is added, which is exactly what happened
    // when 0100 landed.
    for (const table of [
      'replacements', 'replacement_items', 'replacement_activity_events',
      'replacement_label_purchase_intents', 'replacement_item_remaps',
      'replacement_financial_actions',
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
  await check('0103 installs the durable queue contract with RLS and stable idempotency', async () => {
    const table = await client.query<{
      rls: boolean;
      columns: number;
      checks: number;
      unique_keys: number;
      due_indexes: number;
    }>(`
      select
        c.relrowsecurity as rls,
        (select count(*)::int from information_schema.columns
          where table_schema = 'public' and table_name = 'replacement_financial_actions') as columns,
        (select count(*)::int from pg_constraint
          where conrelid = 'replacement_financial_actions'::regclass and contype = 'c') as checks,
        (select count(*)::int from pg_indexes
          where schemaname = 'public' and tablename = 'replacement_financial_actions'
            and indexdef ilike '%unique%idempotency_key%') as unique_keys,
        (select count(*)::int from pg_indexes
          where schemaname = 'public' and tablename = 'replacement_financial_actions'
            and indexname = 'replacement_financial_actions_due_idx'
            and indexdef ilike '%where%pending%retry%processing%') as due_indexes
      from pg_class c
      where c.oid = 'replacement_financial_actions'::regclass
    `);
    assert.equal(table.rows[0]!.rls, true, 'the public table is not exposed without RLS');
    assert.equal(table.rows[0]!.columns, 19, 'the worker/result/lease columns all exist');
    assert.ok(table.rows[0]!.checks >= 7, 'invalid action states are database-rejected');
    assert.equal(table.rows[0]!.unique_keys, 1, 'one stable key admits one durable decision');
    assert.equal(table.rows[0]!.due_indexes, 1, 'the worker has a partial due-work index');
  });

  const db = drizzle(client, { schema, casing: 'snake_case' });
  const conn = db as unknown as Parameters<typeof createReplacement>[1];

  // A shipped original: 3 x SKU-A at line 0, 2 x SKU-B at line 1.
  await client.exec(PS_502_SEED_SQL);
  const actor = {
    email: 'op@example.test',
    type: 'operator',
    permissions: ['replacements:create', 'replacements:label'],
  };
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

  await check('an account-less cancellation received before import blocks every later ambiguous account', async () => {
    await db.execute(sql`
      insert into webhook_events (
        provider, source_order_id, canonical_status, status, metadata
      ) values ('shopify', 'shared-upstream-42', 'cancelled', 'received', '{}'::jsonb)
    `);
    await db.execute(sql`
      insert into orders (
        id, client_id, source_provider, source_account_id, source_order_id,
        order_number, order_status, items
      ) values
        (1322, 1, 'shopify', 'account-a', 'shared-upstream-42', '1322', 'shipped',
          '[{"sku":"SKU-A","name":"Widget A","quantity":1}]'::jsonb),
        (1323, 1, 'shopify', 'account-b', 'shared-upstream-42', '1323', 'shipped',
          '[{"sku":"SKU-A","name":"Widget A","quantity":1}]'::jsonb)
    `);

    for (const orderId of [1322, 1323]) {
      await assert.rejects(
        () => createReplacement({
          orderId,
          reason: 'damaged',
          liabilityOwner: 'operator',
          items: [{ orderLineIndex: 0, quantity: 1 }],
          requestIdempotencyKey: `ambiguous-preimport-${orderId}`,
          actor,
        }, conn),
        (error: unknown) =>
          (error as { code?: string }).code === 'REPLACEMENT_ORIGINAL_ORDER_EVIDENCE_AMBIGUOUS',
      );
    }
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
    assert.equal(row!.orderId, null,
      'the replacement vessel is detached from original-order shipment consumers');
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
      `INSERT INTO billing_finalizations (
         id, client_id, period_start, period_end, line_count, order_count, subtotal, finalized_by
       ) VALUES (
         'fin-iso', 1, '2000-01-01T00:00:00Z', '2000-01-02T00:00:00Z', 0, 0, 0, 'test'
       );
       INSERT INTO billing_credit_notes (
         id, finalization_id, client_id, amount, reason, replacement_id,
         idempotency_key, created_by
       ) VALUES (
         'cn-iso', 'fin-iso', 1, 1, 'cancelled replacement', ${isolated},
         'cn-iso-idempotency', 'test'
       );`,
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
        providerShipmentId: String(10_000 + providerCalls),
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

  const PURCHASE_SHIPMENT = {
    carrierCode: PURCHASE_INPUTS.carrier.value.carrierCode,
    serviceCode: PURCHASE_INPUTS.carrier.value.serviceCode,
    providerAccountId: PURCHASE_INPUTS.carrier.value.providerAccountId,
    selectedPackageId: PURCHASE_INPUTS.package.value.packageId,
    weightOz: PURCHASE_INPUTS.package.value.weightOz,
    dimsL: PURCHASE_INPUTS.package.value.dimsL,
    dimsW: PURCHASE_INPUTS.package.value.dimsW,
    dimsH: PURCHASE_INPUTS.package.value.dimsH,
  };

  /** A replacement with an attached shipment, ready to buy. */
  const readyToBuy = async (key: string, lineIndex = 1) => {
    const r = await makeReplacement(key, lineIndex);
    await db.update(schema.replacements)
      .set({ status: 'approved' }).where(eq(schema.replacements.id, r.id));
    await insertReplacementShipment({
      replacementId: r.id, actor: { email: actor.email, type: 'operator' },
      shipment: PURCHASE_SHIPMENT,
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
        replacementId: r.id, actor,
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

  await check('a NULL replacement client buys NOTHING, even though the original order has one', async () => {
    const r = await readyToBuy('lbl-null-client');
    // The replacement loses its own client identity; the ORIGINAL order keeps its. The
    // tempting fallback is to bill and buy against the order's client — that would spend one
    // tenant's ShipStation credential on another tenant's postage. The replacement's own
    // client is the only authority, so a NULL one must stop before the provider.
    //
    // The APPLICATION-MAIN V2 key is configured here deliberately, and that is the whole
    // point of this check. The first version of this test passed only because the harness
    // never set it: a NULL client yields empty client credentials, selection fell through to
    // the main key and froze scope 'main', and a real purchase was reachable. Asserting "zero
    // provider calls" with the fallback switched OFF proved nothing about the fallback.
    // Hermes reproduced the live purchase at this exact boundary on 2026-08-19. Switch the
    // fallback on, then require zero calls anyway.
    const mainKeyBefore = env.SHIPSTATION_API_KEY_V2;
    (env as { SHIPSTATION_API_KEY_V2?: string }).SHIPSTATION_API_KEY_V2 = 'ps502-main-v2-fixture';
    try {
      await db.update(schema.replacements).set({ clientId: null })
        .where(eq(schema.replacements.id, r.id));
      await db.update(schema.shipments).set({ clientId: null })
        .where(eq(schema.shipments.id, r.replacementShipmentId!));

      // Raw SQL: the harness mirrors billing_line_items in full, but `orders` is deliberately
      // a subset, and a drizzle select would emit every declared column and fail on it.
      const originalOrderRows = await db.execute(sql`
        select client_id as "clientId" from orders where id = 1321
      `);
      assert.equal(
        (originalOrderRows as unknown as { rows: { clientId: number }[] }).rows[0]!.clientId,
        1,
        'the original order still carries an authoritative client to be tempted by',
      );

      // Prove the fallback really is armed, so this test can never silently revert to the
      // toothless version that asserted zero calls with no main key configured.
      assert.ok(
        typeof env.SHIPSTATION_API_KEY_V2 === 'string'
          && env.SHIPSTATION_API_KEY_V2.length > 0,
        'the application-main key must be configured or this check proves nothing',
      );
      assert.equal(
        selectReplacementProviderCredentialAuthority({
          requestedClientId: null,
          credentials: { apiKeyV2: null, apiKey: null, apiSecret: null, sourceClientId: null },
          mainApiKeyV2: env.SHIPSTATION_API_KEY_V2,
        }),
        null,
        'a NULL client selects NO authority even while a usable main key exists',
      );

      const callsBefore = providerCalls;
      await assert.rejects(
        () => purchaseReplacementLabel({
          replacementId: r.id, actor,
          purchaseInputs: PURCHASE_INPUTS,
        }, fakeProvider, conn),
        (e: unknown) => e instanceof ReplacementLabelError
          && e.code === 'REPLACEMENT_PROVIDER_CREDENTIAL_UNAVAILABLE',
        'a replacement with no client of its own has no credential authority to buy with',
      );
      assert.equal(providerCalls, callsBefore,
        'ZERO provider calls — the refusal happens before anything is sent');

      const intents = await db.select().from(schema.replacementLabelPurchaseIntents)
        .where(eq(schema.replacementLabelPurchaseIntents.replacementId, r.id));
      assert.equal(intents.length, 0, 'and no durable purchase intent was written');
    } finally {
      (env as { SHIPSTATION_API_KEY_V2?: string }).SHIPSTATION_API_KEY_V2 = mainKeyBefore;
    }
  });

  await check('a fresh request cannot replace an already-attached shipment snapshot', async () => {
    const r = await readyToBuy('lbl-shipment-request-mismatch');
    const changedInputs = {
      ...PURCHASE_INPUTS,
      carrier: {
        ...PURCHASE_INPUTS.carrier,
        value: { ...PURCHASE_INPUTS.carrier.value, serviceCode: 'ups_2nd_day_air' },
      },
    };
    const secondAttach = await insertReplacementShipment({
      replacementId: r.id,
      actor: { email: actor.email, type: 'operator' },
      shipment: {
        ...PURCHASE_SHIPMENT,
        serviceCode: changedInputs.carrier.value.serviceCode,
      },
    }, conn);
    assert.equal(secondAttach.created, false, 'the existing shipment remains frozen');

    const before = providerCalls;
    await assert.rejects(
      () => purchaseReplacementLabel({
        replacementId: r.id,
        actor,
        purchaseInputs: changedInputs,
      }, fakeProvider, conn),
      (error: unknown) => error instanceof ReplacementLabelError
        && error.code === 'REPLACEMENT_SHIPMENT_REQUEST_MISMATCH'
        && (error.details.mismatchedFields as string[]).includes('serviceCode'),
    );
    assert.equal(providerCalls, before, 'the mismatch is refused before provider dispatch');
    const intents = await db.select().from(schema.replacementLabelPurchaseIntents)
      .where(eq(schema.replacementLabelPurchaseIntents.replacementId, r.id));
    assert.equal(intents.length, 0, 'a mismatched request does not mint an intent');
  });

  await check('a failed pre-purchase attempt needs an explicit audited generation', async () => {
    const r = await readyToBuy('lbl-failed-attempt-generation');
    const before = providerCalls;
    const rejectingProvider = {
      purchase: async () => {
        providerCalls += 1;
        throw Object.assign(new Error('address rejected'), { code: 'PROVIDER_REJECTED' });
      },
    };
    await assert.rejects(() => purchaseReplacementLabel({
      replacementId: r.id,
      actor,
      purchaseInputs: PURCHASE_INPUTS,
    }, rejectingProvider, conn), /address rejected/);
    assert.equal(providerCalls, before + 1, 'only the original provider refusal was dispatched');

    await assert.rejects(
      () => purchaseReplacementLabel({
        replacementId: r.id,
        actor,
        purchaseInputs: PURCHASE_INPUTS,
      }, fakeProvider, conn),
      (error: unknown) => error instanceof ReplacementLabelError
        && error.code === 'REPLACEMENT_LABEL_ATTEMPT_GENERATION_REQUIRED'
        && error.details.sameFrozenRequest === true,
      'same-request replay must be coded, not a raw unique-key failure',
    );
    const changedRequestInputs = {
      ...PURCHASE_INPUTS,
      carrier: {
        ...PURCHASE_INPUTS.carrier,
        value: { ...PURCHASE_INPUTS.carrier.value, serviceCode: 'ups_2nd_day_air' },
      },
    };
    await assert.rejects(
      () => purchaseReplacementLabel({
        replacementId: r.id,
        actor,
        purchaseInputs: changedRequestInputs,
      }, fakeProvider, conn),
      (error: unknown) => error instanceof ReplacementLabelError
        && error.code === 'REPLACEMENT_LABEL_ATTEMPT_GENERATION_REQUIRED'
        && error.details.sameFrozenRequest === false,
      'changed-request replay must not invent purchase_attempt=2',
    );
    assert.equal(providerCalls, before + 1, 'neither replay reached a provider');
    const intents = await db.select().from(schema.replacementLabelPurchaseIntents)
      .where(eq(schema.replacementLabelPurchaseIntents.replacementId, r.id));
    assert.equal(intents.length, 1, 'no second provider identity was minted');
    assert.equal(intents[0]!.state, 'failed_pre_purchase');
    assert.equal(intents[0]!.purchaseAttempt, 1);
  });

  await check('a successful purchase records the receipt and moves to label_created', async () => {
    const r = await readyToBuy('lbl-ok');
    const before = providerCalls;
    const result = await purchaseReplacementLabel({
      replacementId: r.id, actor,
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

  await check('customer-money review cannot be cleared without its exact pricing audit and tuple', async () => {
    const r = await readyToBuy('lbl-money-review-guard');
    const bought = await purchaseReplacementLabel({
      replacementId: r.id,
      actor,
      purchaseInputs: PURCHASE_INPUTS,
    }, fakeProvider, conn);
    // Isolated historical failure: the provider receipt survived, but the pricing freeze did
    // not. The recovery command is the only owner allowed to add the missing tuple + audit.
    await db.update(schema.shipments)
      .set({ selectedRateJson: null })
      .where(eq(schema.shipments.id, bought.shipmentId));
    await db.update(schema.replacements)
      .set({ status: 'review', reviewReason: 'replacement_customer_money_unavailable' })
      .where(eq(schema.replacements.id, r.id));

    await assert.rejects(
      () => resolveReplacementReview({
        replacementId: r.id,
        to: 'label_created',
        actor,
        reason: 'attempted pricing-review bypass',
      }, conn),
      (error: unknown) =>
        (error as { code?: string }).code === 'REPLACEMENT_REVIEW_PREREQUISITE_REQUIRED',
    );
    const [after] = await db.select().from(schema.replacements)
      .where(eq(schema.replacements.id, r.id));
    assert.equal(after!.status, 'review');
    assert.equal(after!.reviewReason, 'replacement_customer_money_unavailable');
  });

  await check('the production ship adapter writes from frozen policy, never HTTP money', async () => {
    const r = await readyToBuy('lbl-production-billing');
    await db.update(schema.replacements)
      .set({ billable: true, liabilityOwner: 'client' })
      .where(eq(schema.replacements.id, r.id));
    await client.query(`update billing_config set pick_pack_fee = 2.50 where client_id = 1`);
    const bought = await purchaseReplacementLabel({
      replacementId: r.id, actor,
      purchaseInputs: PURCHASE_INPUTS,
    }, fakeProvider, conn);
    const [replacement] = await db.select().from(schema.replacements)
      .where(eq(schema.replacements.id, r.id));
    const written = await conn.transaction((tx) => writeReplacementBilling(tx, {
      replacement: replacement!,
      shipmentId: bought.shipmentId,
    }));
    assert.equal(written.linesWritten, 2,
      'canonical frozen postage and database pick/pack policy produce the complete plan');
    const lines = await db.select().from(schema.billingLineItems)
      .where(eq(schema.billingLineItems.replacementId, r.id));
    assert.deepEqual(lines.map((line) => line.lineType).sort(), ['replace_pick_pack', 'replace_postage']);
    assert.equal(lines.find((line) => line.lineType === 'replace_postage')?.totalCost, '11.51',
      'the line uses customer money: 9.75 carrier total plus the frozen 18% policy');
    assert.equal(lines.find((line) => line.lineType === 'replace_pick_pack')?.totalCost, '2.50');
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
      replacementId: r.id, actor,
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
        replacementId: r.id, actor,
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
      .where(eq(schema.shipments.id, intent!.replacementShipmentId!));
    assert.equal(ships.length, 1, 'one replacement shipment');
    assert.equal(ships[0]!.orderId, null, 'it is not an original-order shipment');
    assert.equal(ships[0]!.source, 'replacement');
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
        replacementId: r.id, actor,
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
    assert.equal(classifyProviderFailure(
      Object.assign(new Error('address rejected'), { code: 'PROVIDER_REJECTED' }),
    ), 'failed_pre_purchase');
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
      replacementId: r.id, actor,
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
    let timedOutVoidCalls = 0;
    const timingOut = {
      voidLabel: async () => {
        timedOutVoidCalls += 1;
        throw new Error('socket hang up');
      },
    };
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
    await assert.rejects(
      () => voidReplacementLabel({
        replacementId: r.id, actor: LABEL_ACTOR, reason: 'retry must not redispatch',
      }, timingOut, conn),
      (e: unknown) => e instanceof ReplacementVoidError
        && e.code === 'REPLACEMENT_VOID_RECONCILE_REQUIRED',
    );
    assert.equal(timedOutVoidCalls, 1,
      'an unresolved destructive outcome is reconciled, never dispatched again');
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
      replacementId: r.id, actor,
      purchaseInputs: PURCHASE_INPUTS,
    }, fakeProvider, crashingConn));

    const [orphan] = await db.select().from(schema.replacementLabelPurchaseIntents)
      .where(eq(schema.replacementLabelPurchaseIntents.replacementId, r.id));
    assert.equal(orphan!.state, 'provider_pending');

    const knowingProvider = {
      voidLabel: async () => ({ providerVoidId: 'x', voided: true }),
      lookupPurchase: async () => ({
        providerTransactionId: 'txn-recovered', providerLabelId: 'lbl-recovered',
        providerShipmentId: '20001',
        shipmentCost: 8.25, otherCost: 1.5,
      }),
    };
    const outcome = await reconcileReplacementPurchaseIntent({
      replacementId: r.id, intentId: orphan!.id,
      actor: LABEL_ACTOR, reason: 'operator reconciliation',
    }, knowingProvider as never, conn);
    assert.equal(outcome.outcome, 'purchased');

    const [resolved] = await db.select().from(schema.replacementLabelPurchaseIntents)
      .where(eq(schema.replacementLabelPurchaseIntents.id, orphan!.id));
    assert.equal(resolved!.state, 'purchased');
    assert.equal(resolved!.providerTransactionId, 'txn-recovered');
    assert.equal(resolved!.reconciliationState, 'resolved_purchased');

    // The intent resolving is not the same fact as the label happening. This assertion is the
    // whole of blocker 4: recovery used to stop above, leaving a real paid-for label attached
    // to a replacement still sitting at `approved` with an empty shipment.
    assert.equal(outcome.recorded, 'label_created');

    const [after] = await db.select().from(schema.replacements)
      .where(eq(schema.replacements.id, r.id));
    assert.equal(after!.status, 'label_created', 'the replacement is shippable again');
    assert.ok(after!.labelCreatedAt, 'and it records when the label was earned');

    const [shipment] = await db.select().from(schema.shipments)
      .where(eq(schema.shipments.id, resolved!.replacementShipmentId!));
    assert.equal(shipment!.selectedRateCost, '9.75',
      'the shipment carries the carrier receipt, not nothing');
    assert.equal(Number(shipment!.cost), 8.25);
    assert.equal(Number(shipment!.otherCost), 1.5);

    const events = await db.select().from(schema.replacementActivityEvents)
      .where(eq(schema.replacementActivityEvents.replacementId, r.id));
    assert.equal(
      events.filter((e) => e.eventType === 'replacement_label_created').length, 1,
      'exactly one label_created event — the shared idempotency key sees to that',
    );
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
      replacementId: r.id, actor,
      purchaseInputs: PURCHASE_INPUTS,
    }, fakeProvider, crashingConn));
    const [orphan] = await db.select().from(schema.replacementLabelPurchaseIntents)
      .where(eq(schema.replacementLabelPurchaseIntents.replacementId, r.id));

    const certainProvider = {
      voidLabel: async () => ({ providerVoidId: 'x', voided: true }),
      lookupPurchase: async () => null,
    };
    const outcome = await reconcileReplacementPurchaseIntent({
      replacementId: r.id, intentId: orphan!.id,
      actor: LABEL_ACTOR, reason: 'provider has no record',
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
      replacementId: r.id, actor,
      purchaseInputs: PURCHASE_INPUTS,
    }, fakeProvider, crashingConn));
    const [orphan] = await db.select().from(schema.replacementLabelPurchaseIntents)
      .where(eq(schema.replacementLabelPurchaseIntents.replacementId, r.id));

    const unsureProvider = {
      voidLabel: async () => ({ providerVoidId: 'x', voided: true }),
      lookupPurchase: async () => { throw new Error('provider unavailable'); },
    };
    const outcome = await reconcileReplacementPurchaseIntent({
      replacementId: r.id, intentId: orphan!.id,
      actor: LABEL_ACTOR, reason: 'attempt',
    }, unsureProvider as never, conn);
    assert.equal(outcome.outcome, 'still_unknown',
      'an operator chasing a stuck row beats a silent second purchase');
    const [after] = await db.select().from(schema.replacementLabelPurchaseIntents)
      .where(eq(schema.replacementLabelPurchaseIntents.id, orphan!.id));
    assert.equal(after!.state, 'reconcile_required');
  });

  await check('a provisional ShipStation lookup 404 leaves the intent unresolved', async () => {
    const r = await readyToBuy('recon-provisional-404');
    let transactions = 0;
    const crashingConn = {
      transaction: async (fn: never) => {
        transactions += 1;
        if (transactions === 2) throw new Error('crash after purchase');
        return (conn as { transaction: (f: never) => unknown }).transaction(fn);
      },
    } as never;
    await assert.rejects(() => purchaseReplacementLabel({
      replacementId: r.id, actor,
      purchaseInputs: PURCHASE_INPUTS,
    }, fakeProvider, crashingConn));
    const [orphan] = await db.select().from(schema.replacementLabelPurchaseIntents)
      .where(eq(schema.replacementLabelPurchaseIntents.replacementId, r.id));

    const provisionalMissProvider = {
      voidLabel: async () => ({ providerVoidId: 'x', voided: true }),
      lookupPurchase: async () => {
        throw Object.assign(new Error('external shipment not found yet'), {
          code: 'PROVIDER_LOOKUP_UNAVAILABLE', status: 404,
        });
      },
    };
    const outcome = await reconcileReplacementPurchaseIntent({
      replacementId: r.id, intentId: orphan!.id,
      actor: LABEL_ACTOR, reason: 'provisional external-id miss',
    }, provisionalMissProvider as never, conn);
    assert.equal(outcome.outcome, 'still_unknown',
      'a bare lookup miss has no durable no-effect acknowledgement or consistency grace');
    const [after] = await db.select().from(schema.replacementLabelPurchaseIntents)
      .where(eq(schema.replacementLabelPurchaseIntents.id, orphan!.id));
    assert.equal(after!.state, 'reconcile_required');
    assert.notEqual(after!.state, 'failed_pre_purchase',
      'a provisional 404 must never authorize another postage purchase');
  });

  console.log('\nreplacement billing');

  const PLAN_FACTS = {
    replacementId: 1, orderId: 1321, clientId: 1,
    reference: '1321-REPLACE', replacementShipmentId: 5, billable: true,
    customerPostage: resolveReplacementCustomerPostage({ frozenCustomerShippingMoney: FROZEN_CUSTOMER_MONEY }),
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
    assert.equal(postage!.totalCost, '9.75',
      'the fenced CUSTOMER amount — cShippingRateAmount, not the carrier cost');
    assert.equal(postage!.orderNumber, '1321-REPLACE', 'the ALLOCATED reference, not the order number');
    assert.equal(postage!.orderId, 1321, 'the ORIGINAL order relationally');
  });

  await check('a missing frozen money tuple FAILS CLOSED', () => {
    let err: unknown = null;
    try {
      planReplacementBillingLines({ ...PLAN_FACTS, customerPostage: null });
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
    UPDATE orders
       SET items = items || '[{"sku":"SKU-D","name":"Widget D","quantity":99},{"sku":"SKU-C","name":"Widget C duplicate","quantity":99}]'::jsonb
     WHERE id = 1321;
    INSERT INTO inventory (id, sku, name, client_id) VALUES
      (900, 'SKU-C', 'Widget C', 1),
      (910, 'SKU-C', 'Other Tenant Widget C', 2),
      (911, 'SKU-B', 'Widget B', 1),
      (912, 'SKU-D', 'Widget D', 1);
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
      customerPostage: resolveReplacementCustomerPostage({ frozenCustomerShippingMoney: FROZEN_CUSTOMER_MONEY }),
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

  /** Attach, buy and mark billable for an existing requested replacement fixture. */
  const readyExistingReplacementToShip = async (replacementId: number) => {
    await db.update(schema.replacements)
      .set({ status: 'approved' })
      .where(eq(schema.replacements.id, replacementId));
    await insertReplacementShipment({
      replacementId, actor: { email: actor.email, type: 'operator' },
      shipment: PURCHASE_SHIPMENT,
    }, conn);
    await purchaseReplacementLabel({
      replacementId, actor, purchaseInputs: PURCHASE_INPUTS,
    }, fakeProvider, conn);
    await db.update(schema.replacements)
      .set({ billable: true, liabilityOwner: 'client' })
      .where(eq(schema.replacements.id, replacementId));
    const items = await db.select().from(schema.replacementItems)
      .where(eq(schema.replacementItems.replacementId, replacementId));
    return { replacementId, items };
  };

  await check('AC-4: two replacements on one order persist FOUR lines with exact attribution', async () => {
    const a = await readyToShip('bill-a');
    const b = await readyToShip('bill-b');

    for (const target of [a, b]) {
      const result = await shipReplacement({
        replacementId: target.replacementId, actor: { email: actor.email, type: 'operator' },
        inventoryLines: [{ replacementItemId: target.itemId, inventoryId: 900 }],
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
      inventoryLines: [{ replacementItemId: t.itemId, inventoryId: 900 }],
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
      inventoryLines: [{ replacementItemId: t.itemId, inventoryId: 900 }],
      consumePackage: packageConsumer, writeBilling: billingWriter as never,
    }, conn);
    assert.equal(first.inventoryApplied, 1);
    const afterFirst = await client.query<{ q: number }>(
      'select coalesce(sum(qty),0)::int as q from inventory_ledger where inventory_id = 900');
    assert.equal(afterFirst.rows[0]!.q, before.rows[0]!.q - 1);

    const again = await shipReplacement({
      replacementId: t.replacementId, actor: { email: actor.email, type: 'operator' },
      inventoryLines: [{ replacementItemId: t.itemId, inventoryId: 900 }],
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
        inventoryLines: [{ replacementItemId: t.itemId, inventoryId: 900 }],
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

  console.log('\nAC-6 — regeneration preserves replacement lines');

  await check('the PRODUCTION outbound sweep does not delete replacement lines', async () => {
    const before = await db.select().from(schema.billingLineItems)
      .where(inArray(schema.billingLineItems.lineType, ['replace_postage', 'replace_pick_pack']));
    assert.ok(before.length >= 4, 'there are replacement lines to endanger');
    const totalBefore = before.reduce((sum, l) => sum + Number(l.totalCost), 0);

    // Seed an ordinary outbound line on the SAME order, so the sweep has something it does
    // own and the test proves selectivity rather than a no-op.
    await client.exec(
      `INSERT INTO billing_line_items (client_id, order_id, order_number, shipment_id,
         line_type, description, unit_cost, total_cost)
       VALUES (1, 1321, '1321', 1, 'postage', 'Original postage', 5, 5);`,
    );

    // The ACTUAL production owner, with an order-scoped window exactly as regeneration uses.
    await deleteOutboundBillingLinesForRebuild(
      db as never,
      sql`${schema.billingLineItems.orderId} = 1321`,
    );

    const after = await db.select().from(schema.billingLineItems)
      .where(inArray(schema.billingLineItems.lineType, ['replace_postage', 'replace_pick_pack']));
    const totalAfter = after.reduce((sum, l) => sum + Number(l.totalCost), 0);

    assert.equal(after.length, before.length, 'every replacement line survives');
    assert.equal(totalAfter.toFixed(2), totalBefore.toFixed(2), 'and their totals are unchanged');

    const ordinary = await db.select().from(schema.billingLineItems)
      .where(eq(schema.billingLineItems.lineType, 'postage'));
    assert.equal(ordinary.length, 0,
      'the sweep still deletes what it DOES own — otherwise this proves nothing');
  });

  await check('the replacement regeneration owner deletes only its own editable rows', async () => {
    const [line] = await db.select().from(schema.billingLineItems)
      .where(eq(schema.billingLineItems.lineType, 'replace_postage'));
    const replacementId = line!.replacementId!;
    const [r] = await db.select().from(schema.replacements)
      .where(eq(schema.replacements.id, replacementId));

    // Mark ONE of its lines invoiced. Finalized money is history and must survive.
    await db.update(schema.billingLineItems).set({ invoiced: true })
      .where(eq(schema.billingLineItems.id, line!.id));

    const facts = {
      replacementId, orderId: r!.orderId, clientId: r!.clientId ?? 1,
      reference: r!.reference, replacementShipmentId: r!.replacementShipmentId!,
      billable: true,
      customerPostage: resolveReplacementCustomerPostage({ frozenCustomerShippingMoney: FROZEN_CUSTOMER_MONEY }),
      pickPackCharge: 2.5,
      shipDate: new Date(), billingEffectiveDate: new Date(),
      billingPolicyVersion: 'v1',
    };

    // The postage row is invoiced, so regeneration must fail rather than duplicate it:
    // the partial unique index refuses a second replace_postage for this replacement.
    await assert.rejects(
      () => (conn as { transaction: (f: never) => unknown }).transaction((async (tx: never) =>
        regenerateReplacementBillingInTransaction(tx, facts)) as never),
      'a finalized row is never deleted, so rebuilding beside it must fail loudly');

    const still = await db.select().from(schema.billingLineItems)
      .where(eq(schema.billingLineItems.id, line!.id));
    assert.equal(still.length, 1, 'the invoiced row survives the rolled-back attempt');
    assert.equal(still[0]!.invoiced, true);
  });

  console.log('\nAC-13 — cancelling ONE replacement');

  await check('cancelling A removes only A, and B is untouched', async () => {
    const a = await readyToShip('cancel-a');
    const b = await readyToShip('cancel-b');
    for (const target of [a, b]) {
      await shipReplacement({
        replacementId: target.replacementId, actor: { email: actor.email, type: 'operator' },
        inventoryLines: [{ replacementItemId: target.itemId, inventoryId: 900 }],
        consumePackage: packageConsumer, writeBilling: billingWriter as never,
      }, conn);
    }

    const beforeB = await db.select().from(schema.billingLineItems)
      .where(eq(schema.billingLineItems.replacementId, b.replacementId));
    assert.equal(beforeB.length, 2, 'B has its two lines');
    const totalBBefore = beforeB.reduce((sum, l) => sum + Number(l.totalCost), 0);

    const result = await (conn as { transaction: (f: never) => unknown }).transaction((async (tx: never) =>
      cancelReplacementBillingInTransaction(tx, { replacementId: a.replacementId })) as never) as
      { editableRemoved: number; invoicedRetained: number };
    assert.equal(result.editableRemoved, 2, 'both of A\'s editable lines are removed');

    const afterA = await db.select().from(schema.billingLineItems)
      .where(eq(schema.billingLineItems.replacementId, a.replacementId));
    assert.equal(afterA.length, 0, 'A is cancelled');

    const afterB = await db.select().from(schema.billingLineItems)
      .where(eq(schema.billingLineItems.replacementId, b.replacementId));
    assert.equal(afterB.length, 2, 'B is UNTOUCHED — identity is relational, not a description match');
    const totalBAfter = afterB.reduce((sum, l) => sum + Number(l.totalCost), 0);
    assert.equal(totalBAfter.toFixed(2), totalBBefore.toFixed(2));
  });

  await check('a retried cancellation removes nothing further', async () => {
    const a = await readyToShip('cancel-retry');
    await shipReplacement({
      replacementId: a.replacementId, actor: { email: actor.email, type: 'operator' },
      inventoryLines: [{ replacementItemId: a.itemId, inventoryId: 900 }],
      consumePackage: packageConsumer, writeBilling: billingWriter as never,
    }, conn);

    const run = async () => (conn as { transaction: (f: never) => unknown }).transaction((async (tx: never) =>
      cancelReplacementBillingInTransaction(tx, { replacementId: a.replacementId })) as never) as
      Promise<{ editableRemoved: number }>;

    const first = await run();
    assert.equal(first.editableRemoved, 2);
    const second = await run();
    assert.equal(second.editableRemoved, 0, 'a retry is a no-op, not a second credit');
  });

  await check('an INVOICED replacement line is retained, never deleted', async () => {
    const a = await readyToShip('cancel-invoiced');
    await shipReplacement({
      replacementId: a.replacementId, actor: { email: actor.email, type: 'operator' },
      inventoryLines: [{ replacementItemId: a.itemId, inventoryId: 900 }],
      consumePackage: packageConsumer, writeBilling: billingWriter as never,
    }, conn);
    const lines = await db.select().from(schema.billingLineItems)
      .where(eq(schema.billingLineItems.replacementId, a.replacementId));
    await db.update(schema.billingLineItems).set({ invoiced: true })
      .where(eq(schema.billingLineItems.id, lines[0]!.id));

    const result = await (conn as { transaction: (f: never) => unknown }).transaction((async (tx: never) =>
      cancelReplacementBillingInTransaction(tx, { replacementId: a.replacementId })) as never) as
      { editableRemoved: number; invoicedRetained: number };
    assert.equal(result.editableRemoved, 1, 'only the editable line goes');
    assert.equal(result.invoicedRetained, 1, 'the finalized one is history');

    const remaining = await db.select().from(schema.billingLineItems)
      .where(eq(schema.billingLineItems.replacementId, a.replacementId));
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]!.invoiced, true);
  });

  console.log('\nreplacement money that was disappearing (D1/D2/D3)');

  const { findFrozenReplacementLineTotals, reconcileFinalizedBillingReplacementAdjustment } =
    await import('../src/services/billing-finalization-policy.js');
  const { foldFinalizedReplacementTotalsIntoCandidates } =
    await import('../src/services/billing-replacement-finalized-fold.js');
  const { isCancelledNoChargeExcludedLineType, cancelledNoChargeBillingLinePredicateSql } =
    await import('../src/services/billing-cancelled-no-charge.js');

  /**
   * Every fixture closes its OWN period, one calendar year apart.
   *
   * A shared now()±30d window made each successive fixture overlap all the earlier ones, and
   * an ordinary replacement line carries no source_finalization_id — so one line joined every
   * overlapping period at once. That is the exact legacy anomaly
   * reconcileFinalizedBillingReplacementAdjustment refuses as
   * BILLING_REPLACEMENT_FINALIZATION_AMBIGUOUS, which meant the fifth caller of this helper
   * could never reach the credit it was written to prove. Disjoint periods keep each line in
   * exactly one closed period, which is what real monthly finalization produces.
   */
  let nextFinalizationPeriodYear = 2051;

  /** Ship a replacement, close a period over its lines, and freeze them as billing does. */
  const finalizeReplacement = async (slug: string, finalizationId: string) => {
    const target = await readyToShip(slug);
    await shipReplacement({
      replacementId: target.replacementId, actor: { email: actor.email, type: 'operator' },
      inventoryLines: [{ replacementItemId: target.itemId, inventoryId: 900 }],
      consumePackage: packageConsumer, writeBilling: billingWriter as never,
    }, conn);

    const lines = await db.select().from(schema.billingLineItems)
      .where(eq(schema.billingLineItems.replacementId, target.replacementId));
    assert.equal(lines.length, 2, 'the replacement wrote its two lines');

    const year = nextFinalizationPeriodYear;
    nextFinalizationPeriodYear += 1;
    // A closed period carries the invoiced subtotal it actually billed. Left at the column
    // default of 0 the period has no balance, and createBillingCreditNote correctly refuses
    // every credit against it as BILLING_CREDIT_EXCEEDS_BALANCE — you cannot credit back more
    // than was invoiced. 100 leaves headroom above this fixture's 12.25 of replacement money,
    // matching the closed period the AC-13 amendment fixture below opens.
    await db.execute(sql`
      insert into billing_finalizations (
        id, client_id, period_start, period_end, line_count, order_count, subtotal, finalized_by
      ) values (
        ${finalizationId}, 1,
        ${`${year}-01-01T00:00:00Z`}::timestamptz,
        ${`${year}-02-01T00:00:00Z`}::timestamptz,
        2, 1, 100, 'ps-502-integration'
      )
    `);
    // finalizeBillingPeriod freezes a line by setting invoiced = true and NOTHING else. The
    // effective date is what decides WHICH period owns the line, exactly as the shipping date
    // does in production; it is dated into this fixture's own period rather than left at now().
    await db.execute(sql`
      update billing_line_items
         set invoiced = true,
             billing_effective_date = ${`${year}-01-15T00:00:00Z`}::timestamptz
       where replacement_id = ${target.replacementId}
    `);
    return target;
  };

  await check('frozen replacement money is discoverable at all', async () => {
    const target = await finalizeReplacement('frozen-a', 'fin-a');

    const found = await findFrozenReplacementLineTotals(db as never, {
      clientId: 1, replacementId: target.replacementId,
    });
    assert.equal(found.length, 1, 'one closed period froze this replacement');
    assert.equal(found[0]!.finalizationId, 'fin-a');
    assert.equal(Number(found[0]!.frozenTotal).toFixed(2), '12.25');

    // The predicate this replaced. A replacement charge can never carry
    // source_finalization_id — constraint billing_line_items_adjustment_reference_chk
    // forbids it on any line whose type is not billing_adjustment — so the original
    // query matched nothing and the reconciler credited nothing, silently.
    const viaOldPredicate = await db.execute(sql`
      select count(*)::int as n from billing_line_items
      where replacement_id = ${target.replacementId}
        and invoiced = true and source_finalization_id is not null
    `);
    const n = (viaOldPredicate as unknown as { rows: { n: number }[] }).rows[0]!.n;
    assert.equal(n, 0, 'the predicate this replaced could never have matched a row');
  });

  await check('frozen money is scoped to ONE replacement', async () => {
    const a = await finalizeReplacement('frozen-scope-a', 'fin-scope');
    const b = await readyToShip('frozen-scope-b');
    await shipReplacement({
      replacementId: b.replacementId, actor: { email: actor.email, type: 'operator' },
      inventoryLines: [{ replacementItemId: b.itemId, inventoryId: 900 }],
      consumePackage: packageConsumer, writeBilling: billingWriter as never,
    }, conn);
    await db.update(schema.billingLineItems).set({ invoiced: true })
      .where(eq(schema.billingLineItems.replacementId, b.replacementId));

    const found = await findFrozenReplacementLineTotals(db as never, {
      clientId: 1, replacementId: a.replacementId,
    });
    assert.equal(Number(found[0]!.frozenTotal).toFixed(2), '12.25',
      'B\'s identical frozen money is not counted as A\'s');
  });

  await check('a line in OVERLAPPING closed periods is parked for review, never credited twice', async () => {
    const target = await finalizeReplacement('ambiguous-periods', 'fin-ambiguous');

    // A second closed period covering the SAME line. Legacy data really does contain
    // overlapping periods, and an ordinary replacement charge can carry no
    // source_finalization_id — constraint billing_line_items_adjustment_reference_chk forbids
    // it on any non-adjustment line — so nothing on the row says which invoice owns it. Joining
    // both and crediting once per period would refund the client twice for one shipment.
    await db.execute(sql`
      insert into billing_finalizations (
        id, client_id, period_start, period_end, line_count, order_count, subtotal, finalized_by
      )
      select 'fin-ambiguous-overlap', 1,
             coalesce(b.billing_effective_date, b.ship_date) - interval '1 day',
             coalesce(b.billing_effective_date, b.ship_date) + interval '1 day',
             1, 1, 100, 'ps-502-integration'
        from billing_line_items b
       where b.replacement_id = ${target.replacementId}
       limit 1
    `);

    await assert.rejects(
      // The harness already owns the schema, so the ensure-schema hook is a no-op here.
      () => reconcileFinalizedBillingReplacementAdjustment({
        clientId: 1,
        replacementId: target.replacementId,
        actorId: 'ps-502-integration',
        reason: 'attempted automatic credit across overlapping legacy periods',
        idempotencyKey: 'ps502-ambiguous-periods',
      }, conn as never, async () => {}),
      (error: unknown) =>
        (error as { code?: string }).code === 'BILLING_REPLACEMENT_FINALIZATION_AMBIGUOUS',
      'an ambiguous line is a financial-review question, never a guess',
    );

    const credits = await db.execute(sql`
      select count(*)::int as n from billing_credit_notes
       where replacement_id = ${target.replacementId}
    `);
    assert.equal((credits as unknown as { rows: { n: number }[] }).rows[0]!.n, 0,
      'the refusal happens before any money moves');
  });

  /** Independent of the fold's own query, so the proof is not the code restating itself. */
  // The regeneration window used by the fold proofs. The harness closes its periods at
  // now()±30d, so this contains them; the cross-period case below deliberately does not.
  const WINDOW_FROM = new Date(Date.parse('2020-01-01T00:00:00Z')).toISOString();
  const WINDOW_TO = new Date(Date.parse('2999-01-01T00:00:00Z')).toISOString();

  /**
   * Independent of the fold's own query, so the proof is not the code restating itself.
   *
   * Written with EXISTS rather than the JOIN the fold uses, deliberately: it must express the
   * SAME rule — invoiced, and effective inside a closed period overlapping the window — while
   * being a different statement of it. The first version omitted the period entirely, which
   * made it agree with the fold only while the fold was wrong.
   */
  const invoicedReplacementMoneyOnOrder = async (orderId: number) => {
    const rows = await db.execute(sql`
      select coalesce(sum(b.total_cost), 0)::text as total
      from billing_line_items b
      where b.order_id = ${orderId}
        and b.replacement_id is not null
        and b.invoiced = true
        and exists (
          select 1 from billing_finalizations f
           where f.client_id = b.client_id
             and coalesce(b.billing_effective_date, b.ship_date) >= f.period_start
             and coalesce(b.billing_effective_date, b.ship_date) < f.period_end
             and f.period_start < ${WINDOW_TO}::timestamptz
             and f.period_end > ${WINDOW_FROM}::timestamptz
        )
    `);
    return Number((rows as unknown as { rows: { total: string }[] }).rows[0]!.total);
  };

  await check('the finalized candidate total gains the frozen replacement money', async () => {
    await finalizeReplacement('fold-a', 'fin-fold');
    const frozenOnOrder = await invoicedReplacementMoneyOnOrder(1321);
    assert.ok(frozenOnOrder >= 12.25, 'this replacement\'s frozen money is part of the order\'s');

    // What the outbound plan produced: the original order only. Without the fold this is what
    // the reconciler compares against a frozen total that DOES include the replacement — a
    // negative delta, and a credit that erases a real charge.
    const candidates = new Map<number, Map<number, number>>([[1, new Map([[1321, 20]])]]);
    const folded = await foldFinalizedReplacementTotalsIntoCandidates(
      [1321], candidates, { dateFrom: WINDOW_FROM, dateTo: WINDOW_TO }, db as never,
    );

    assert.equal(folded.ordersFolded, 1);
    assert.equal(folded.amountFolded.toFixed(2), frozenOnOrder.toFixed(2));
    assert.equal(candidates.get(1)!.get(1321)!.toFixed(2), (20 + frozenOnOrder).toFixed(2),
      'current now counts what frozen counts, so replacement money contributes zero delta');
  });

  await check('an UNINVOICED replacement line is not folded', async () => {
    const before = await foldFinalizedReplacementTotalsIntoCandidates(
      [1321], new Map(), { dateFrom: WINDOW_FROM, dateTo: WINDOW_TO }, db as never,
    );

    const open = await readyToShip('fold-open');
    await shipReplacement({
      replacementId: open.replacementId, actor: { email: actor.email, type: 'operator' },
      inventoryLines: [{ replacementItemId: open.itemId, inventoryId: 900 }],
      consumePackage: packageConsumer, writeBilling: billingWriter as never,
    }, conn);

    const after = await foldFinalizedReplacementTotalsIntoCandidates(
      [1321], new Map(), { dateFrom: WINDOW_FROM, dateTo: WINDOW_TO }, db as never,
    );
    assert.equal(after.amountFolded.toFixed(2), before.amountFolded.toFixed(2),
      'open-period money is not frozen money — it belongs to the period ordinary billing owns');
  });
  await check('a cancelled original does not zero a delivered replacement', () => {
    assert.equal(isCancelledNoChargeExcludedLineType('replace_postage'), true);
    assert.equal(isCancelledNoChargeExcludedLineType('replace_pick_pack'), true);
    assert.equal(isCancelledNoChargeExcludedLineType('return_postage'), true,
      'the return exclusion is unchanged');
    assert.equal(isCancelledNoChargeExcludedLineType('postage'), false,
      'an ordinary outbound line is still zeroed — the predicate still does its job');

    // The SQL twin must agree with the TypeScript one; they are read by different callers.
    const predicate = cancelledNoChargeBillingLinePredicateSql({
      lineType: sql`line_type`, orderStatus: sql`order_status`, canonicalStatus: sql`canonical_status`,
    });
    const text = JSON.stringify(predicate);
    assert.ok(text.includes('replace_postage') && text.includes('replace_pick_pack'),
      'the SQL predicate excludes replacement types too');
  });

  console.log('\nAC-16 — the original order went away');

  // Per user override unlock shipped data on 2026-08-19: every shipped/cancelled mutation in
  // this section is confined to the isolated PGlite database and proves the amended safety fence.

  const {
    raiseReplacementOriginalOrderHoldsInTransaction,
    resolveReplacementOriginalOrderHold,
  } =
    await import('../src/services/replacement-original-order-hold.js');

  const HOLD_ACTOR = {
    email: 'hold-operator@example.test',
    type: 'admin',
    permissions: ['replacements:hold'],
  };

  let evidenceSeq = 0;
  /** A real receipt row, because a hold points at one by foreign key. */
  const newEvidence = async () => {
    evidenceSeq += 1;
    const rows = await db.execute(sql`
      insert into order_lifecycle_events (order_id, command_key, transition, source)
      values (1321, ${'ac16-' + String(evidenceSeq)}, 'cancelled', 'test')
      returning id
    `);
    return (rows as unknown as { rows: { id: number }[] }).rows[0]!.id;
  };

  const sweep = async (evidenceId: number) =>
    (conn as { transaction: (f: never) => unknown }).transaction((async (tx: never) =>
      raiseReplacementOriginalOrderHoldsInTransaction(tx, {
        orderId: 1321,
        triggerKind: 'order_cancelled',
        evidence: { kind: 'order_lifecycle_event', orderLifecycleEventId: evidenceId },
        reason: 'original order cancelled upstream',
        actor: { type: 'system', email: null, permissions: [] },
      })) as never) as Promise<{
        considered: number; alreadyHeld: number;
        outcomes: { replacementId: number; phase: string; disposition: string; openQuestion: string | null }[];
      }>;

  const holdFor = async (replacementId: number) => {
    const rows = await db.select().from(schema.replacementOriginalOrderHolds)
      .where(eq(schema.replacementOriginalOrderHolds.replacementId, replacementId));
    return rows[rows.length - 1]!;
  };
  const statusOf = async (replacementId: number) => {
    const [row] = await db.select().from(schema.replacements)
      .where(eq(schema.replacements.id, replacementId));
    return row!;
  };

  /**
   * Each AC-16 case is a separate historical world. The production evidence is deliberately
   * durable; this PGlite-only reset prevents one world's cancellation receipt from making the
   * next world's fixture impossible to create. It never reaches a configured/live database.
   */
  const resetAc16Evidence = async () => {
    await db.delete(schema.replacementOriginalOrderHolds)
      .where(eq(schema.replacementOriginalOrderHolds.orderId, 1321));
    await db.execute(sql`delete from order_lifecycle_events
      where order_id = 1321 and command_key like 'ac16-%'`);
  };

  await check('a PRE-DISPATCH replacement with nothing spent is cancelled', async () => {
    await resetAc16Evidence();
    const created = await makeReplacement('ac16-clean');
    await db.update(schema.replacements).set({ status: 'approved' })
      .where(eq(schema.replacements.id, created.id));
    await insertReplacementShipment({
      replacementId: created.id,
      actor: { email: actor.email, type: actor.type },
    }, conn);
    const target = { replacementId: created.id };

    const result = await sweep(await newEvidence());
    const mine = result.outcomes.find((o) => o.replacementId === target.replacementId)!;
    assert.equal(mine.phase, 'pre_dispatch');
    assert.equal(mine.disposition, 'cancelled');
    assert.equal(mine.openQuestion, null, 'nothing was spent, so nothing is owed a decision');

    const after = await statusOf(target.replacementId);
    assert.equal(after.status, 'cancelled');
    const [retiredVessel] = await db.select().from(schema.shipments)
      .where(eq(schema.shipments.id, after.replacementShipmentId!));
    assert.equal(retiredVessel!.orderId, null,
      'the dedicated replacement vessel is detached from original-order consumers');
    assert.equal(retiredVessel!.voided, true,
      'clean cancellation retires its exact empty vessel without contacting a provider');

    const hold = await holdFor(target.replacementId);
    assert.equal(hold.statusAtHold, 'approved', 'the hold records what it acted on');
    assert.equal(hold.evidenceKind, 'order_lifecycle_event');
    assert.ok(hold.orderLifecycleEventId, 'a hold points at a receipt, never at prose');
    assert.ok(hold.resolvedAt, 'a clean automatic cancellation closes its decision hold');
    assert.equal(hold.resolution, 'clean_pre_dispatch_replacement_cancelled');

    await assert.rejects(
      () => createReplacement({
        orderId: 1321,
        reason: 'damaged',
        liabilityOwner: 'operator',
        items: [{ orderLineIndex: 1, quantity: 1 }],
        requestIdempotencyKey: 'ac16-create-after-sweep',
        actor,
      }, conn),
      (error: unknown) => (error as { code?: string }).code === 'REPLACEMENT_ORIGINAL_ORDER_HELD',
      'the durable cancellation receipt blocks replacements created after the sweep',
    );
  });

  await check('a LIVE LABEL goes to review, is never auto-voided, and cannot ship', async () => {
    await resetAc16Evidence();
    const target = await readyToShip('ac16-label');
    const before = await statusOf(target.replacementId);
    assert.equal(before.status, 'label_created');

    const result = await sweep(await newEvidence());
    const mine = result.outcomes.find((o) => o.replacementId === target.replacementId)!;
    assert.equal(mine.disposition, 'review');
    assert.equal(mine.openQuestion, 'void_or_retain_purchased_label');

    const after = await statusOf(target.replacementId);
    assert.equal(after.status, 'review', 'review IS the shipping block — shipReplacement demands label_created');
    assert.equal(after.reviewReason, 'original_order_cancelled_label_live');
    assert.notEqual(after.reviewReason, 'original_order_line_drift',
      'AC-16 keeps its OWN review path; the two lead an operator to different actions');

    const intents = await db.select().from(schema.replacementLabelPurchaseIntents)
      .where(eq(schema.replacementLabelPurchaseIntents.replacementId, target.replacementId));
    assert.ok(intents.every((i) => i.voidState !== 'voided'),
      'a local cancellation must never perform a provider action on its own authority');

    const hold = await holdFor(target.replacementId);
    await assert.rejects(
      () => resolveReplacementReview({
        replacementId: target.replacementId,
        to: 'label_created',
        actor,
        reason: 'attempted generic review bypass',
      }, conn),
      (error: unknown) =>
        (error as { code?: string }).code === 'REPLACEMENT_REVIEW_PREREQUISITE_REQUIRED',
      'generic review resolution cannot clear an unanswered AC-16 hold',
    );
    await assert.rejects(
      () => resolveReplacementOriginalOrderHold({
        holdId: hold.id,
        replacementId: target.replacementId,
        expectedStateVersion: after.stateVersion,
        resolution: 'dispatch_evidence_reconciled',
        reason: 'attempted unrelated answer',
        actor: HOLD_ACTOR,
      }, conn),
      (error: unknown) =>
        (error as { code?: string }).code === 'REPLACEMENT_HOLD_RESOLUTION_INCOMPATIBLE',
      'a dispatch answer cannot erase the still-live-label question',
    );

    await db.update(schema.replacementLabelPurchaseIntents)
      .set({ voidState: 'void_pending' })
      .where(eq(schema.replacementLabelPurchaseIntents.replacementId, target.replacementId));
    await assert.rejects(
      () => resolveReplacementOriginalOrderHold({
        holdId: hold.id,
        replacementId: target.replacementId,
        expectedStateVersion: after.stateVersion,
        resolution: 'label_retained',
        reason: 'keep the still-active label',
        actor: HOLD_ACTOR,
      }, conn),
      (error: unknown) =>
        (error as { code?: string }).code === 'REPLACEMENT_HOLD_PREREQUISITE_MISSING',
      'void_pending is not stable active-label evidence and cannot close the hold as retained',
    );
  });

  await check('a confirmed-void purchased intent is not a live label and cleanly auto-cancels', async () => {
    await resetAc16Evidence();
    const target = await withPurchasedLabel('ac16-label-already-voided');
    const confirmedVoid = await voidReplacementLabel({
      replacementId: target.id,
      actor: LABEL_ACTOR,
      reason: 'label was explicitly voided before the original-order cancellation',
    }, voidingProvider, conn);
    assert.equal(confirmedVoid.voided, true);

    const before = await statusOf(target.id);
    assert.equal(before.status, 'label_created',
      'the canonical void keeps lifecycle display state; the intent ledger carries liveness');
    const [voidedIntent] = await db.select().from(schema.replacementLabelPurchaseIntents)
      .where(eq(schema.replacementLabelPurchaseIntents.replacementId, target.id));
    assert.equal(voidedIntent!.state, 'purchased', 'the purchase receipt remains durable history');
    assert.equal(voidedIntent!.voidState, 'voided', 'the same durable intent proves no live label remains');

    const result = await sweep(await newEvidence());
    const mine = result.outcomes.find((outcome) => outcome.replacementId === target.id)!;
    assert.equal(mine.phase, 'pre_dispatch');
    assert.equal(mine.disposition, 'cancelled');
    assert.equal(mine.openQuestion, null, 'confirmed-void postage leaves no label decision open');

    const after = await statusOf(target.id);
    assert.equal(after.status, 'cancelled');
    const hold = await holdFor(target.id);
    assert.ok(hold.resolvedAt, 'the clean cancellation closes its hold immediately');
    assert.equal(hold.resolution, 'clean_pre_dispatch_replacement_cancelled');
  });

  await check('an at-risk purchase intent without label_created goes to its unresolved review', async () => {
    await resetAc16Evidence();
    const target = await readyToShip('ac16-intent-unresolved');
    await db.update(schema.replacements).set({ status: 'approved' })
      .where(eq(schema.replacements.id, target.replacementId));
    await db.update(schema.replacementLabelPurchaseIntents)
      .set({ state: 'reconcile_required', voidState: null })
      .where(eq(schema.replacementLabelPurchaseIntents.replacementId, target.replacementId));

    const result = await sweep(await newEvidence());
    const mine = result.outcomes.find((o) => o.replacementId === target.replacementId)!;
    assert.equal(mine.disposition, 'review');
    assert.equal(mine.openQuestion, 'resolve_label_purchase_intent_before_cancelling');

    const after = await statusOf(target.replacementId);
    assert.equal(after.status, 'review');
    assert.equal(after.reviewReason, 'original_order_cancelled_label_unresolved');
  });

  await check('an EDITABLE billing row on an undispatched replacement requires review', async () => {
    await resetAc16Evidence();
    const target = await readyToBuy('ac16-editable-billing', 2);
    await db.insert(schema.billingLineItems).values({
      clientId: 1,
      orderId: 1321,
      orderNumber: target.reference,
      shipmentId: target.replacementShipmentId!,
      replacementId: target.id,
      lineType: 'replace_pick_pack',
      description: 'Unexpected editable replacement charge',
      unitCost: '2.50',
      totalCost: '2.50',
      invoiced: false,
    });

    const result = await sweep(await newEvidence());
    const mine = result.outcomes.find((o) => o.replacementId === target.id)!;
    assert.equal(mine.disposition, 'review');
    assert.equal(mine.openQuestion, 'editable_money_on_an_undispatched_replacement');
    const after = await statusOf(target.id);
    assert.equal(after.reviewReason, 'original_order_cancelled_unexpected_billing');

    const lines = await db.select().from(schema.billingLineItems)
      .where(eq(schema.billingLineItems.replacementId, target.id));
    assert.equal(lines.length, 1, 'review never disguises the anomaly by deleting money');
  });

  await check('shipped lifecycle text without shipped_at enters dedicated inconsistency review', async () => {
    await resetAc16Evidence();
    const target = await readyToBuy('ac16-status-without-dispatch', 2);
    // Per user override unlock shipped data on 2026-08-19: this test creates the historical
    // lifecycle/dispatch disagreement named by the amended AC-16; no production row is touched.
    await db.update(schema.replacements).set({ status: 'shipped', shippedAt: null })
      .where(eq(schema.replacements.id, target.id));

    const result = await sweep(await newEvidence());
    const mine = result.outcomes.find((o) => o.replacementId === target.id)!;
    assert.equal(mine.disposition, 'review');
    assert.equal(mine.openQuestion, 'resolve_lifecycle_dispatch_inconsistency');
    const after = await statusOf(target.id);
    assert.equal(after.status, 'review');
    assert.equal(after.reviewReason, 'original_order_cancelled_dispatch_inconsistent');
  });

  await check('shipped_at on a pre-ship lifecycle preserves history under a post-dispatch hold', async () => {
    await resetAc16Evidence();
    const target = await readyToBuy('ac16-dispatch-without-status', 2);
    const before = await statusOf(target.id);
    // Per user override unlock shipped data on 2026-08-19: authoritative dispatch evidence
    // wins over stale lifecycle text in this isolated PGlite fixture.
    await db.update(schema.replacements).set({ shippedAt: new Date() })
      .where(eq(schema.replacements.id, target.id));

    const result = await sweep(await newEvidence());
    const mine = result.outcomes.find((o) => o.replacementId === target.id)!;
    assert.equal(mine.phase, 'post_dispatch');
    assert.equal(mine.disposition, 'flagged_post_dispatch');
    assert.equal(
      mine.openQuestion,
      'dispatch_evidence_disagrees_with_lifecycle_and_financials_need_review',
    );
    const after = await statusOf(target.id);
    assert.equal(after.status, 'approved', 'the stale status is preserved as history, not rewritten');
    assert.equal(after.stateVersion, before.stateVersion + 1);
  });

  await check('the combined question needs a consistent lifecycle AND an explicit financial decision', async () => {
    await resetAc16Evidence();
    const target = await readyToBuy('ac16-combined-question', 2);
    // Per user override unlock shipped data on 2026-08-19: this isolated PGlite fixture
    // recreates the historical disagreement the amended AC-16 names — authoritative dispatch
    // evidence under stale pre-dispatch lifecycle text. No production row is touched.
    await db.update(schema.replacements)
      .set({ shippedAt: new Date(), billable: true })
      .where(eq(schema.replacements.id, target.id));

    const result = await sweep(await newEvidence());
    const mine = result.outcomes.find((o) => o.replacementId === target.id)!;
    assert.equal(
      mine.openQuestion,
      'dispatch_evidence_disagrees_with_lifecycle_and_financials_need_review',
    );

    const hold = await holdFor(target.id);
    const held = await statusOf(target.id);

    // 1. Plain dispatch reconciliation is the answer to the lifecycle-ONLY inconsistency.
    // This question also has unresolved money behind it, so that answer cannot close it.
    await assert.rejects(
      () => resolveReplacementOriginalOrderHold({
        holdId: hold.id,
        replacementId: target.id,
        expectedStateVersion: held.stateVersion,
        resolution: 'dispatch_evidence_reconciled',
        reason: 'attempted to close the combined question as a dispatch-only fix',
        actor: HOLD_ACTOR,
      }, conn),
      (error: unknown) =>
        (error as { code?: string }).code === 'REPLACEMENT_HOLD_RESOLUTION_INCOMPATIBLE',
      'reconciling dispatch evidence alone must never close the financial half',
    );

    // 2. A financial answer while shipped_at and the lifecycle still disagree is refused:
    // nobody can decide what is owed on a replacement whose dispatch state is contradictory.
    await assert.rejects(
      () => resolveReplacementOriginalOrderHold({
        holdId: hold.id,
        replacementId: target.id,
        expectedStateVersion: held.stateVersion,
        resolution: 'post_dispatch_client_charge_retained',
        reason: 'retain the charge while the lifecycle is still inconsistent',
        actor: HOLD_ACTOR,
      }, conn),
      (error: unknown) =>
        (error as { code?: string }).code === 'REPLACEMENT_HOLD_PREREQUISITE_MISSING',
      'the lifecycle must agree with shipped_at before the money question can be answered',
    );

    // Make the lifecycle agree with the authoritative dispatch evidence.
    await db.update(schema.replacements).set({ status: 'shipped' })
      .where(eq(schema.replacements.id, target.id));

    // 3. A consistent lifecycle alone is still not enough. Claiming a reversal requires the
    // durable completed action that proves the reversal actually happened.
    await assert.rejects(
      () => resolveReplacementOriginalOrderHold({
        holdId: hold.id,
        replacementId: target.id,
        expectedStateVersion: held.stateVersion,
        resolution: 'financial_reversal_completed',
        reason: 'claim a reversal that was never performed',
        actor: HOLD_ACTOR,
      }, conn),
      (error: unknown) =>
        (error as { code?: string }).code === 'REPLACEMENT_HOLD_PREREQUISITE_MISSING',
      'a reversal answer with no completed durable action is an unbacked claim',
    );

    const stillOpen = await holdFor(target.id);
    assert.ok(!stillOpen.resolvedAt, 'three refused answers left the question open');

    // 4. Consistent lifecycle PLUS an explicit, provable decision closes it — and only then.
    const resolved = await resolveReplacementOriginalOrderHold({
      holdId: hold.id,
      replacementId: target.id,
      expectedStateVersion: held.stateVersion,
      resolution: 'post_dispatch_client_charge_retained',
      reason: 'finance decided the delivered replacement stays billed to the client',
      actor: HOLD_ACTOR,
    }, conn);
    assert.equal(resolved.resolution, 'post_dispatch_client_charge_retained');

    const closed = await holdFor(target.id);
    assert.ok(closed.resolvedAt, 'the explicit financial decision closes the hold');
    // The stored resolution is the decision AND the reason it was taken: an auditor reading
    // the hold sees who kept the client charged and why, not just an enum value.
    assert.match(String(closed.resolution), /^post_dispatch_client_charge_retained\b/);
    assert.match(String(closed.resolution), /finance decided the delivered replacement stays billed/);
  });

  await check('a SHIPPED replacement is annotated, never moved', async () => {
    await resetAc16Evidence();
    const target = await readyToShip('ac16-shipped');
    await shipReplacement({
      replacementId: target.replacementId, actor: { email: actor.email, type: 'operator' },
      inventoryLines: [{ replacementItemId: target.itemId, inventoryId: 900 }],
      consumePackage: packageConsumer, writeBilling: billingWriter as never,
    }, conn);
    const before = await statusOf(target.replacementId);

    const result = await sweep(await newEvidence());
    const mine = result.outcomes.find((o) => o.replacementId === target.replacementId)!;
    assert.equal(mine.phase, 'post_dispatch');
    assert.equal(mine.disposition, 'flagged_post_dispatch');
    assert.equal(mine.openQuestion, 'does_the_client_still_pay_for_a_delivered_replacement',
      'the money question is RECORDED, not answered by a default');

    const after = await statusOf(target.replacementId);
    assert.equal(after.status, 'shipped', 'real stock left; the status is history');
    assert.equal(after.stateVersion, before.stateVersion + 1, 'a concurrent reader cannot miss it');

    const lines = await db.select().from(schema.billingLineItems)
      .where(eq(schema.billingLineItems.replacementId, target.replacementId));
    assert.equal(lines.length, 2, 'a delivered replacement is not silently un-billed');
  });

  await check('the same evidence replayed moves nothing twice', async () => {
    await resetAc16Evidence();
    const target = await readyToShip('ac16-replay');
    await db.update(schema.replacements).set({ status: 'approved' })
      .where(eq(schema.replacements.id, target.replacementId));
    await db.delete(schema.replacementLabelPurchaseIntents)
      .where(eq(schema.replacementLabelPurchaseIntents.replacementId, target.replacementId));

    const evidenceId = await newEvidence();
    const first = await sweep(evidenceId);
    const versionAfterFirst = (await statusOf(target.replacementId)).stateVersion;

    const second = await sweep(evidenceId);
    assert.equal(second.outcomes.length, 0, "a replay classifies nothing");
    assert.equal(second.alreadyHeld, first.considered);
    assert.equal((await statusOf(target.replacementId)).stateVersion, versionAfterFirst);
  });

  await check('terminal lifecycle text cannot erase a live purchased label', async () => {
    await resetAc16Evidence();
    const target = await readyToShip('ac16-terminal-live-label');
    await db.update(schema.replacements).set({ status: 'cancelled' })
      .where(eq(schema.replacements.id, target.replacementId));
    const before = await statusOf(target.replacementId);

    const result = await sweep(await newEvidence());
    const mine = result.outcomes.find((outcome) => outcome.replacementId === target.replacementId)!;
    assert.equal(mine.disposition, 'review');
    assert.equal(mine.openQuestion, 'terminal_replacement_has_live_label');
    const after = await statusOf(target.replacementId);
    assert.equal(after.status, 'cancelled', 'terminal status is preserved; no illegal terminal -> review move');
    assert.equal(after.stateVersion, before.stateVersion + 1, 'the anomaly annotation remains observable');
    const events = await db.select().from(schema.replacementActivityEvents)
      .where(eq(schema.replacementActivityEvents.replacementId, target.replacementId));
    assert.ok(events.some((event) =>
      event.eventType === 'replacement_terminal_original_order_live_label'));
    assert.equal((await holdFor(target.replacementId)).resolvedAt, null,
      'the live-label decision stays open despite terminal lifecycle text');
  });

  await check('terminal lifecycle text cannot erase an unresolved provider intent', async () => {
    await resetAc16Evidence();
    const target = await readyToShip('ac16-terminal-unresolved-label');
    await db.update(schema.replacementLabelPurchaseIntents)
      .set({ state: 'reconcile_required', voidState: null })
      .where(eq(schema.replacementLabelPurchaseIntents.replacementId, target.replacementId));
    await db.update(schema.replacements).set({ status: 'rejected' })
      .where(eq(schema.replacements.id, target.replacementId));

    const result = await sweep(await newEvidence());
    const mine = result.outcomes.find((outcome) => outcome.replacementId === target.replacementId)!;
    assert.equal(mine.disposition, 'review');
    assert.equal(mine.openQuestion, 'terminal_replacement_has_unresolved_label_intent');
    assert.equal((await statusOf(target.replacementId)).status, 'rejected');
    const events = await db.select().from(schema.replacementActivityEvents)
      .where(eq(schema.replacementActivityEvents.replacementId, target.replacementId));
    assert.ok(events.some((event) =>
      event.eventType === 'replacement_terminal_original_order_unresolved_label'));
  });

  await check('terminal lifecycle text cannot erase unexpected billing evidence', async () => {
    await resetAc16Evidence();
    const target = await readyToBuy('ac16-terminal-billing', 2);
    await db.insert(schema.billingLineItems).values({
      clientId: 1,
      orderId: 1321,
      orderNumber: target.reference,
      shipmentId: target.replacementShipmentId!,
      replacementId: target.id,
      lineType: 'replace_pick_pack',
      description: 'Unexpected terminal replacement charge',
      unitCost: '2.50',
      totalCost: '2.50',
      invoiced: false,
    });
    await db.update(schema.replacements).set({ status: 'cancelled' })
      .where(eq(schema.replacements.id, target.id));

    const result = await sweep(await newEvidence());
    const mine = result.outcomes.find((outcome) => outcome.replacementId === target.id)!;
    assert.equal(mine.disposition, 'review');
    assert.equal(mine.openQuestion, 'terminal_undispatched_replacement_has_editable_money');
    assert.equal((await statusOf(target.id)).status, 'cancelled');
    const events = await db.select().from(schema.replacementActivityEvents)
      .where(eq(schema.replacementActivityEvents.replacementId, target.id));
    assert.ok(events.some((event) =>
      event.eventType === 'replacement_terminal_original_order_unexpected_billing'));
    const retained = await db.select().from(schema.billingLineItems)
      .where(eq(schema.billingLineItems.replacementId, target.id));
    assert.equal(retained.length, 1, 'the terminal anomaly path never silently deletes money');
  });

  await check('an already-cancelled replacement is recorded and left alone', async () => {
    await resetAc16Evidence();
    const target = await readyToShip('ac16-terminal');
    await db.update(schema.replacements).set({ status: 'cancelled' })
      .where(eq(schema.replacements.id, target.replacementId));
    await db.delete(schema.replacementLabelPurchaseIntents)
      .where(eq(schema.replacementLabelPurchaseIntents.replacementId, target.replacementId));
    const before = await statusOf(target.replacementId);

    const result = await sweep(await newEvidence());
    const mine = result.outcomes.find((o) => o.replacementId === target.replacementId)!;
    assert.equal(mine.phase, 'terminal_no_action');
    assert.equal(mine.disposition, 'no_action');

    const after = await statusOf(target.replacementId);
    assert.equal(after.stateVersion, before.stateVersion, "nothing was touched");

    const hold = await holdFor(target.replacementId);
    assert.ok(hold.resolvedAt, "a hold with nothing to decide does not sit in the operator queue");
    assert.equal(hold.resolution, 'no_action_required');
  });

  await resetAc16Evidence();

  console.log('\nAC-10 — replace_postage is customer money, structurally');

  await check('the fence returns CUSTOMER money, not the carrier cost', () => {
    const fenced = resolveReplacementCustomerPostage({
      frozenCustomerShippingMoney: FROZEN_CUSTOMER_MONEY,
    });
    assert.ok(fenced, 'a reconciling tuple is accepted');
    assert.equal(fenced!.amount, 9.75, 'cShippingRateAmount — what the client pays');
    assert.notEqual(fenced!.amount, FROZEN_CUSTOMER_MONEY.selectedRateCost,
      'never selectedRateCost, which is what the carrier charged us');
    assert.equal(fenced!.source, 'frozen_customer_shipping_money');
  });

  await check('provider cost handed in alongside is IGNORED — there is nowhere to put it', () => {
    // The sneaky fixture, after the PS-487 return guard. Every one of these is a carrier
    // number a caller might reach for; none of them is a field the fence accepts.
    const sneaky = {
      frozenCustomerShippingMoney: null,
      labelCost: 8.25,
      providerCost: 8.25,
      externalLabelCost: 8.25,
      shipmentCost: 8.25,
      otherCost: 1.5,
      cost: 9.75,
    } as unknown as { frozenCustomerShippingMoney: unknown };
    assert.equal(resolveReplacementCustomerPostage(sneaky), null,
      'a caller holding only carrier cost cannot express it, so nothing is billed');
  });

  await check('a ZERO-MARGIN tuple is accepted — equality is not the discriminator', () => {
    // REVERSED from the first version, which refused this. A client configured with no
    // shipping markup legitimately pays cost, and refusing them did not merely skip a charge:
    // the planner treats missing customer money as fatal, so their replacements could not ship
    // at all. What separates customer money from carrier cost is provenance, not arithmetic.
    const zeroMargin = {
      ...FROZEN_CUSTOMER_MONEY,
      cShippingRateAmount: 8.25,
      shippingMarginAmount: 0,
      shippingMarginPct: 0,
    };
    const fenced = resolveReplacementCustomerPostage({ frozenCustomerShippingMoney: zeroMargin });
    assert.ok(fenced, 'a reconciling zero-margin tuple is customer money too');
    assert.equal(fenced!.amount, 8.25);
  });

  await check('a tuple with the WRONG provenance is still refused', () => {
    // The protection the equality check was standing in for, stated directly.
    for (const broken of [
      { ...FROZEN_CUSTOMER_MONEY, customerRateSource: 'selected_rate_cost' },
      { ...FROZEN_CUSTOMER_MONEY, rateCostSource: 'quote' },
    ]) {
      assert.equal(
        resolveReplacementCustomerPostage({ frozenCustomerShippingMoney: broken }), null,
        'a number copied out of shipments.cost cannot forge a customer-money source');
    }
  });

  await check('an out-of-policy or partial tuple is refused', () => {
    const stale = { ...FROZEN_CUSTOMER_MONEY, customerShippingMoneyPolicyVersion: 'ps-000-v0' };
    assert.equal(resolveReplacementCustomerPostage({ frozenCustomerShippingMoney: stale }), null,
      'a tuple frozen under a policy we no longer run is not evidence of anything');

    const { cShippingRateAmount, ...partial } = FROZEN_CUSTOMER_MONEY;
    void cShippingRateAmount;
    assert.equal(resolveReplacementCustomerPostage({ frozenCustomerShippingMoney: partial }), null,
      'the reader never manufactures customer money from selected cost');
  });

  await check('a replacement with no fenced money REFUSES rather than billing zero', async () => {
    const target = await readyToShip('ac10-refuse');
    // A writer identical to the harness's except that the fence returned nothing — which is
    // what a shipment carrying no reconciling tuple actually produces.
    const unfencedWriter = async (tx: unknown, input: {
      replacement: { id: number; orderId: number; clientId: number | null; reference: string; billable: boolean };
      shipmentId: number;
    }) => writeReplacementBillingInTransaction(tx, {
      replacementId: input.replacement.id,
      orderId: input.replacement.orderId,
      clientId: input.replacement.clientId ?? 1,
      reference: input.replacement.reference,
      replacementShipmentId: input.shipmentId,
      billable: input.replacement.billable,
      customerPostage: null,
      pickPackCharge: 2.5,
      shipDate: new Date(),
      billingEffectiveDate: new Date(),
      billingPolicyVersion: 'v1',
    } as never);

    await assert.rejects(
      () => shipReplacement({
        replacementId: target.replacementId, actor: { email: actor.email, type: 'operator' },
        inventoryLines: [{ replacementItemId: target.itemId, inventoryId: 900 }],
        consumePackage: packageConsumer, writeBilling: unfencedWriter as never,
      }, conn),
      /REPLACEMENT_BILLING_MONEY_UNAVAILABLE|no frozen customer-money tuple/,
      'shipping unbilled is a decision nobody made');

    const [after] = await db.select().from(schema.replacements)
      .where(eq(schema.replacements.id, target.replacementId));
    assert.notEqual(after!.status, 'shipped', 'the refusal rolled the whole dispatch back');
  });
  console.log('\nitem 14 — what an operator can see');

  const { collectReplacementDiagnostics } =
    await import('../src/services/replacement-diagnostics.js');

  const anomaly = async (kind: string) => {
    const report = await collectReplacementDiagnostics(db as never);
    return report.anomalies.find((a) => a.kind === kind) ?? null;
  };

  await check('a shipped billable replacement with NO billing line is reported', async () => {
    const before = await anomaly('shipped_without_billing');

    const target = await readyToShip('diag-unbilled');
    await shipReplacement({
      replacementId: target.replacementId, actor: { email: actor.email, type: 'operator' },
      inventoryLines: [{ replacementItemId: target.itemId, inventoryId: 900 }],
      consumePackage: packageConsumer, writeBilling: billingWriter as never,
    }, conn);
    // The state the anomaly exists for: goods gone, money absent. Reached here by deleting
    // the lines, because the commands correctly refuse to produce it.
    await db.delete(schema.billingLineItems)
      .where(eq(schema.billingLineItems.replacementId, target.replacementId));

    const after = await anomaly('shipped_without_billing');
    assert.ok(after, 'the anomaly is reported at all');
    assert.equal(after!.count, (before?.count ?? 0) + 1);
    assert.ok(after!.sampleReplacementIds.includes(target.replacementId),
      'the sample names the replacement, so an operator can go and look');
    assert.equal(after!.severity, 'money');
    assert.ok(after!.meaning.length > 0 && after!.action.length > 0,
      'a count without an explanation is not diagnostics');
  });

  await check('a correctly billed shipped replacement is NOT reported', async () => {
    const before = await anomaly('shipped_without_billing');
    const target = await readyToShip('diag-billed');
    await shipReplacement({
      replacementId: target.replacementId, actor: { email: actor.email, type: 'operator' },
      inventoryLines: [{ replacementItemId: target.itemId, inventoryId: 900 }],
      consumePackage: packageConsumer, writeBilling: billingWriter as never,
    }, conn);

    const after = await anomaly('shipped_without_billing');
    assert.equal(after?.count ?? 0, before?.count ?? 0,
      'the ordinary path must not appear in a list of things that are wrong');
  });

  await check('an unresolved original-order hold is reported as blocked', async () => {
    const fixture = await statusOf(firstId);
    await db.insert(schema.replacementOriginalOrderHolds).values({
      replacementId: fixture.id,
      orderId: fixture.orderId,
      triggerKind: 'order_cancelled',
      evidenceKind: 'operator_declaration',
      declaredBy: 'diagnostics-fixture@example.test',
      reason: 'isolated diagnostics fixture',
      phase: 'pre_dispatch_label_at_risk',
      disposition: 'review',
      openQuestion: 'void_or_retain_purchased_label',
      statusAtHold: fixture.status,
      stateVersionAtHold: fixture.stateVersion,
      idempotencyKey: 'ac16-diagnostics-open-hold',
    });
    const found = await anomaly('open_original_order_hold');
    assert.ok(found, 'the explicit AC-16 operator question is listed');
    assert.equal(found!.severity, 'blocked');

    const [{ n }] = (await db.execute(sql`
      select count(*)::int as n from replacement_original_order_holds where resolved_at is null
    `) as unknown as { rows: { n: number }[] }).rows;
    assert.equal(found!.count, n, "the count is the truth, not an approximation");
    await db.delete(schema.replacementOriginalOrderHolds)
      .where(eq(schema.replacementOriginalOrderHolds.idempotencyKey, 'ac16-diagnostics-open-hold'));
  });

  await check('classes with nothing wrong are omitted, not reported as zero', async () => {
    const report = await collectReplacementDiagnostics(db as never);
    assert.ok(report.anomalies.every((a) => a.count > 0),
      'a list of zeroes is a list nobody finishes reading');
    assert.equal(report.healthy, report.anomalies.length === 0,
      'healthy states it explicitly, so an empty list cannot be mistaken for a failed run');
  });

  console.log('\nblocker 2 — the caller cannot choose how much stock moves');

  const frozenQtyOf = async (replacementId: number) => {
    const rows = await db.select().from(schema.replacementItems)
      .where(eq(schema.replacementItems.replacementId, replacementId));
    return rows;
  };
  const ledgerFor = async (replacementId: number, shipmentId: number, itemId: number) => {
    const rows = await db.execute(sql`
      select qty from inventory_ledger
       where idempotency_key like ${`replacement:${replacementId}:shipment:${shipmentId}:item:${itemId}:%`}
    `);
    return (rows as unknown as { rows: { qty: number }[] }).rows;
  };

  const assertShipRefusalHasNoEffects = async (
    target: { replacementId: number; itemId: number },
    inventoryId: number,
    expectedCode: string,
  ) => {
    const before = await statusOf(target.replacementId);
    assert.ok(before.replacementShipmentId, 'the refusal fixture has a frozen shipment');
    let packageCalls = 0;
    let billingCalls = 0;
    await assert.rejects(
      () => shipReplacement({
        replacementId: target.replacementId,
        actor: { email: actor.email, type: 'operator' },
        inventoryLines: [{ replacementItemId: target.itemId, inventoryId }],
        consumePackage: async () => {
          packageCalls += 1;
          return { consumed: true };
        },
        writeBilling: async () => {
          billingCalls += 1;
          return { linesWritten: 2 };
        },
      }, conn),
      (error: unknown) => error instanceof ReplacementShippedError
        && error.code === expectedCode,
    );
    assert.equal(packageCalls, 0, 'the refusal precedes package consumption');
    assert.equal(billingCalls, 0, 'the refusal precedes billing');
    assert.equal((await ledgerFor(
      target.replacementId, before.replacementShipmentId, target.itemId,
    )).length, 0, 'the refusal appends no inventory movement');
    assert.equal((await statusOf(target.replacementId)).status, 'label_created',
      'the refusal leaves the replacement shippable only after its evidence is corrected');
  };

  await check('only an explicit active/null purchased label may ship', async () => {
    for (const [suffix, voidState] of [
      ['pending', 'void_pending'],
      ['reconcile', 'void_reconcile_required'],
      ['voided', 'voided'],
      ['future', 'future_unknown_state'],
    ] as const) {
      const target = await readyToShip(`ship-label-${suffix}`);
      await db.update(schema.replacementLabelPurchaseIntents)
        .set({ voidState })
        .where(eq(schema.replacementLabelPurchaseIntents.replacementId, target.replacementId));
      await assertShipRefusalHasNoEffects(target, 900, 'REPLACEMENT_LABEL_NOT_ACTIVE');
    }
  });

  await check('a cross-client inventory candidate is refused before deduction', async () => {
    const target = await readyToShip('ship-inventory-cross-client');
    await assertShipRefusalHasNoEffects(
      target, 910, 'REPLACEMENT_INVENTORY_AUTHORITY_MISMATCH',
    );
  });

  await check('inventory must match the latest audited remap SKU, not the requested snapshot', async () => {
    const replacement = await makeReplacement('ship-inventory-remapped-sku', 2);
    const [item] = await db.select().from(schema.replacementItems)
      .where(eq(schema.replacementItems.replacementId, replacement.id));
    await remapReplacementItem({
      replacementId: replacement.id,
      replacementItemId: item!.id,
      toOrderLineIndex: 3,
      actor: OVERRIDE_ACTOR,
      reason: 'operator confirmed Widget D is the effective replacement line',
    }, conn);
    const prepared = await readyExistingReplacementToShip(replacement.id);
    assert.equal(prepared.items.length, 1);
    assert.equal(prepared.items[0]!.sku, 'SKU-C',
      'the immutable requested snapshot still names the old SKU');
    await assertShipRefusalHasNoEffects(
      { replacementId: prepared.replacementId, itemId: prepared.items[0]!.id },
      900,
      'REPLACEMENT_INVENTORY_AUTHORITY_MISMATCH',
    );
  });

  await check('an inactive inventory candidate is refused before deduction', async () => {
    const target = await readyToShip('ship-inventory-inactive');
    await db.update(schema.inventory).set({ active: false }).where(eq(schema.inventory.id, 900));
    try {
      await assertShipRefusalHasNoEffects(
        target, 900, 'REPLACEMENT_INVENTORY_AUTHORITY_MISMATCH',
      );
    } finally {
      await db.update(schema.inventory).set({ active: true }).where(eq(schema.inventory.id, 900));
    }
  });

  await check('two duplicate-SKU items deduct independently and replay deducts nothing', async () => {
    const created = await createReplacement({
      orderId: 1321,
      reason: 'damaged',
      liabilityOwner: 'operator',
      items: [
        { orderLineIndex: 2, quantity: 1 },
        { orderLineIndex: 4, quantity: 1 },
      ],
      requestIdempotencyKey: 'ship-duplicate-sku-items',
      actor,
    }, conn);
    const target = await readyExistingReplacementToShip(created.replacement.id);
    assert.equal(target.items.length, 2);
    assert.ok(target.items.every((item) => item.sku === 'SKU-C'));
    const mappings = target.items.map((item) => ({
      replacementItemId: item.id,
      inventoryId: 900,
    }));
    let packageCalls = 0;
    let billingCalls = 0;
    const first = await shipReplacement({
      replacementId: target.replacementId,
      actor: { email: actor.email, type: 'operator' },
      inventoryLines: mappings,
      consumePackage: async () => {
        packageCalls += 1;
        return { consumed: true };
      },
      writeBilling: (async (tx, input) => {
        billingCalls += 1;
        return billingWriter(tx, input);
      }) as never,
    }, conn);
    assert.equal(first.shipped, true);
    assert.equal(first.inventoryApplied, 2, 'each frozen item owns one movement');
    assert.equal(first.inventoryAlreadyApplied, 0);
    assert.equal(packageCalls, 1);
    assert.equal(billingCalls, 1);

    const after = await statusOf(target.replacementId);
    const ledgerRows = (await db.execute(sql`
      select source_entity, source_id, qty
        from inventory_ledger
       where idempotency_key like ${`replacement:${target.replacementId}:shipment:${after.replacementShipmentId}:%`}
       order by source_id
    `) as unknown as {
      rows: { source_entity: string; source_id: string; qty: number }[];
    }).rows;
    assert.equal(ledgerRows.length, 2, 'the source-identity unique key did not collapse siblings');
    assert.ok(ledgerRows.every((row) => row.source_entity === 'replacement_shipment_item'));
    assert.deepEqual(
      ledgerRows.map((row) => row.source_id).sort(),
      target.items.map((item) => `${after.replacementShipmentId}:${item.id}`).sort(),
    );
    assert.ok(ledgerRows.every((row) => Number(row.qty) === -1));

    const replay = await shipReplacement({
      replacementId: target.replacementId,
      actor: { email: actor.email, type: 'operator' },
      inventoryLines: mappings,
      consumePackage: async () => {
        packageCalls += 1;
        return { consumed: true };
      },
      writeBilling: (async (tx, input) => {
        billingCalls += 1;
        return billingWriter(tx, input);
      }) as never,
    }, conn);
    assert.equal(replay.shipped, false);
    assert.equal(replay.inventoryApplied, 0);
    assert.equal(replay.inventoryAlreadyApplied, 0);
    assert.equal(packageCalls, 1, 'replay did not consume another package');
    assert.equal(billingCalls, 1, 'replay did not write billing again');
    const replayRows = (await db.execute(sql`
      select count(*)::int as n from inventory_ledger
       where idempotency_key like ${`replacement:${target.replacementId}:shipment:${after.replacementShipmentId}:%`}
    `) as unknown as { rows: { n: number }[] }).rows;
    assert.equal(replayRows[0]!.n, 2, 'replay appended no third movement');
  });

  await check('the deduction is the FROZEN quantity, which the caller never states', async () => {
    const target = await readyToShip('qty-frozen');
    const [item] = await frozenQtyOf(target.replacementId);
    assert.ok(item, 'the replacement has a frozen item');

    await shipReplacement({
      replacementId: target.replacementId, actor: { email: actor.email, type: 'operator' },
      // No quantity anywhere in this call. There is nowhere to put one.
      inventoryLines: [{ replacementItemId: target.itemId, inventoryId: 900 }],
      consumePackage: packageConsumer, writeBilling: billingWriter as never,
    }, conn);

    const [replacementRow] = await db.select().from(schema.replacements)
      .where(eq(schema.replacements.id, target.replacementId));
    const moved = await ledgerFor(
      target.replacementId, replacementRow!.replacementShipmentId!, target.itemId,
    );
    assert.equal(moved.length, 1, 'exactly one ledger row');
    assert.equal(Number(moved[0]!.qty), -Number(item!.quantity),
      'the ledger moved exactly what was frozen at creation');
  });

  await check('a SECOND mapping for the same item is refused, not deducted twice', async () => {
    const target = await readyToShip('qty-duplicate');
    await assert.rejects(
      () => shipReplacement({
        replacementId: target.replacementId, actor: { email: actor.email, type: 'operator' },
        inventoryLines: [
          { replacementItemId: target.itemId, inventoryId: 900 },
          // A different inventory record, so the idempotency key differs and the ledger
          // would have had no reason to refuse the second movement.
          { replacementItemId: target.itemId, inventoryId: 901 },
        ],
        consumePackage: packageConsumer, writeBilling: billingWriter as never,
      }, conn),
      (e: unknown) => (e as { code?: string }).code === 'REPLACEMENT_INVENTORY_DUPLICATE_MAPPING',
    );

    const [after] = await db.select().from(schema.replacements)
      .where(eq(schema.replacements.id, target.replacementId));
    assert.notEqual(after!.status, 'shipped', 'the refusal rolled everything back');
  });

  await check('a mapping for an item of ANOTHER replacement is refused', async () => {
    const mine = await readyToShip('qty-scope-mine');
    const theirs = await readyToShip('qty-scope-theirs');
    await assert.rejects(
      () => shipReplacement({
        replacementId: mine.replacementId, actor: { email: actor.email, type: 'operator' },
        inventoryLines: [
          { replacementItemId: mine.itemId, inventoryId: 900 },
          { replacementItemId: theirs.itemId, inventoryId: 900 },
        ],
        consumePackage: packageConsumer, writeBilling: billingWriter as never,
      }, conn),
      (e: unknown) => (e as { code?: string }).code === 'REPLACEMENT_INVENTORY_UNKNOWN_ITEM',
      'an item belonging to a different replacement is not this one\'s to move');
  });

  console.log('\nblocker 5 — the fold counts only THIS period');

  await check('a replacement frozen in ANOTHER period is not folded into this one', async () => {
    // Period A: long closed, and the replacement money was invoiced inside it.
    const target = await readyToShip('period-a');
    await shipReplacement({
      replacementId: target.replacementId, actor: { email: actor.email, type: 'operator' },
      inventoryLines: [{ replacementItemId: target.itemId, inventoryId: 900 }],
      consumePackage: packageConsumer, writeBilling: billingWriter as never,
    }, conn);

    await db.execute(sql`
      update billing_line_items
         set billing_effective_date = now() - interval '400 days', invoiced = true
       where replacement_id = ${target.replacementId}
    `);
    await db.execute(sql`
      insert into billing_finalizations (id, client_id, period_start, period_end)
      values ('fin-period-a', 1, now() - interval '430 days', now() - interval '370 days')
    `);

    // Regenerating a window that does NOT overlap period A must not see that money. Before
    // the period predicate existed, the fold added it to this window's candidate and the
    // reconciler emitted a debit for the difference — charging the client twice.
    const candidates = new Map<number, Map<number, number>>([[1, new Map([[1321, 20]])]]);
    const folded = await foldFinalizedReplacementTotalsIntoCandidates(
      [1321], candidates,
      { dateFrom: new Date(Date.parse('2000-01-01T00:00:00Z')).toISOString(),
        dateTo: new Date(Date.parse('2000-02-01T00:00:00Z')).toISOString() },
      db as never,
    );

    assert.equal(folded.amountFolded, 0,
      'money frozen in a period this run is not reconciling belongs to that invoice');
    assert.equal(candidates.get(1)!.get(1321), 20,
      'the candidate is untouched, so the delta stays zero and no debit is raised');
  });

  await check('the SAME replacement IS folded when its period is in the window', async () => {
    const candidates = new Map<number, Map<number, number>>([[1, new Map([[1321, 20]])]]);
    const folded = await foldFinalizedReplacementTotalsIntoCandidates(
      [1321], candidates,
      { dateFrom: new Date(Date.parse('2020-01-01T00:00:00Z')).toISOString(),
        dateTo: new Date(Date.parse('2999-01-01T00:00:00Z')).toISOString() },
      db as never,
    );
    assert.ok(folded.amountFolded > 0,
      'a window that DOES overlap the closed period still counts it — the fix must not be a blanket exclusion');
  });

  console.log('\nblocker 7 — the credit a cancellation owes is actually raised');

  const creditNotesFor = async (replacementId: number) => {
    const rows = await db.execute(sql`
      select id, replacement_id, amount from billing_credit_notes
       where replacement_id = ${replacementId}
    `);
    return (rows as unknown as { rows: { id: string; amount: string }[] }).rows;
  };

  await check('the sweep never auto-cancels a replacement that carries invoiced money', async () => {
    await resetAc16Evidence();
    const target = await finalizeReplacement('settle-report', 'fin-settle-report');
    // Wind it back behind the label: pre-dispatch, but its money is already invoiced.
    // Per user override unlock shipped data on 2026-08-19: the isolated fixture recreates a
    // historical billing-without-dispatch anomaly so AC-16 must review it instead of erasing it.
    await db.update(schema.replacements).set({ status: 'approved', shippedAt: null })
      .where(eq(schema.replacements.id, target.replacementId));
    await db.delete(schema.replacementLabelPurchaseIntents)
      .where(eq(schema.replacementLabelPurchaseIntents.replacementId, target.replacementId));

    const result = await sweep(await newEvidence());
    const mine = result.outcomes.find((o) => o.replacementId === target.replacementId);
    assert.ok(mine, 'the sweep classified it');
    assert.equal(mine!.disposition, 'review',
      'invoiced money on an undispatched replacement is an anomaly, not a cancellation');
    assert.equal(mine!.openQuestion, 'invoiced_money_on_an_undispatched_replacement');
    assert.equal(mine!.finalizedCreditOwed, false,
      'nothing was cancelled, so nothing is owed a credit yet');
    const after = await statusOf(target.replacementId);
    assert.equal(after.status, 'review');
    assert.equal(after.reviewReason, 'original_order_cancelled_unexpected_billing');
    const retained = await db.select().from(schema.billingLineItems)
      .where(eq(schema.billingLineItems.replacementId, target.replacementId));
    assert.equal(retained.length, 2);
    assert.ok(retained.every((line) => line.invoiced),
      'finalized anomaly rows remain immutable while finance decides');

    // The amendment keeps this anomaly out of lifecycle cancellation. If a finance operator
    // decides to reverse it, the separate durable AC-13 command below owns that decision.
    assert.equal(result.finalizedCreditPending.length, 0,
      'the original-order sweep records the question; it does not silently decide money');
    await resetAc16Evidence();
  });

  console.log('\nAC-10 end to end — the client is charged CUSTOMER money');

  await check('purchasing a label freezes a customer tuple the fence accepts', async () => {
    const target = await readyToShip('ac10-e2e');

    const [replacementRow] = await db.select().from(schema.replacements)
      .where(eq(schema.replacements.id, target.replacementId));
    const [shipment] = await db.select().from(schema.shipments)
      .where(eq(schema.shipments.id, replacementRow!.replacementShipmentId!));

    const frozen = shipment!.selectedRateJson as Record<string, unknown> | null;
    assert.ok(frozen, 'the purchase froze something onto the shipment');
    assert.equal(frozen!.customerShippingMoneyPolicyVersion, 'ps-437-v1',
      'and it is policy-versioned, which raw carrier cost never is');

    const fenced = resolveReplacementCustomerPostage({ frozenCustomerShippingMoney: frozen });
    assert.ok(fenced, 'the AC-10 fence accepts what the purchase froze — the wire is joined');

    // The whole point: what the client pays is NOT what the carrier charged. The harness
    // client carries an 18% markup, so a fence that returned selectedRateCost would be
    // visibly wrong here rather than passing by coincidence.
    assert.ok(fenced!.amount > Number(frozen!.selectedRateCost),
      'the customer amount exceeds the carrier cost by the configured markup');
    assert.equal(
      Number(frozen!.cShippingRateAmount).toFixed(2), fenced!.amount.toFixed(2),
      'and it is exactly cShippingRateAmount, never selectedRateCost');
  });

  await check('the freeze is one-shot — a second call cannot move frozen money', async () => {
    const { freezeReplacementCustomerShippingMoney } =
      await import('../src/services/customer-shipping-money.js');
    const target = await readyToShip('ac10-oneshot');
    const [row] = await db.select().from(schema.replacements)
      .where(eq(schema.replacements.id, target.replacementId));
    const shipmentId = row!.replacementShipmentId!;

    const first = await freezeReplacementCustomerShippingMoney(shipmentId, db as never);

    // Move the markup AFTER the freeze. A charge that changes because policy changed later is
    // not a record of what happened.
    await db.execute(sql`update billing_config set shipping_markup_pct = 99 where client_id = 1`);
    const second = await freezeReplacementCustomerShippingMoney(shipmentId, db as never);
    await db.execute(sql`update billing_config set shipping_markup_pct = 18 where client_id = 1`);

    assert.equal(second.cShippingRateAmount, first.cShippingRateAmount,
      'the snapshot is returned, not re-decided');
  });

  console.log('\nAC-13 amendment — lifecycle cancellation and financial reversal are separate');

  // Per user override unlock shipped data on 2026-08-19: these tests exercise only PGlite
  // fixtures; they preserve shipped lifecycle history and never reach a provider or live data.

  await check('pre-ship cancellation rolls cleanup, action, event, and status back together', async () => {
    const target = await readyToBuy('ac13-pre-ship-atomic', 2);
    await db.insert(schema.billingLineItems).values({
      clientId: 1,
      orderId: 1321,
      orderNumber: target.reference,
      shipmentId: target.replacementShipmentId!,
      replacementId: target.id,
      lineType: 'replace_pick_pack',
      description: 'Editable pre-ship replacement charge',
      unitCost: '2.50',
      totalCost: '2.50',
      invoiced: false,
    });
    const before = await statusOf(target.id);
    const eventsBefore = await db.select().from(schema.replacementActivityEvents)
      .where(eq(schema.replacementActivityEvents.replacementId, target.id));

    const crashAfterCommand = {
      transaction: async (fn: (tx: never) => Promise<unknown>) =>
        (conn as unknown as { transaction: (callback: (tx: never) => Promise<unknown>) => Promise<unknown> })
          .transaction(async (tx) => {
            await fn(tx);
            throw new Error('simulated process death before cancellation commit');
          }),
    } as never;

    await assert.rejects(
      () => cancelReplacement({
        replacementId: target.id,
        actor,
        reason: 'customer withdrew the pre-ship replacement',
      }, crashAfterCommand),
      /simulated process death/,
    );

    const afterCrash = await statusOf(target.id);
    assert.equal(afterCrash.status, before.status, 'the lifecycle move did not escape the rollback');
    assert.equal(afterCrash.stateVersion, before.stateVersion);
    const linesAfterCrash = await db.select().from(schema.billingLineItems)
      .where(eq(schema.billingLineItems.replacementId, target.id));
    assert.equal(linesAfterCrash.length, 1, 'editable money did not commit without cancellation');
    const actionsAfterCrash = await db.select().from(schema.replacementFinancialActions)
      .where(eq(schema.replacementFinancialActions.replacementId, target.id));
    assert.equal(actionsAfterCrash.length, 0, 'the completed cleanup fact rolled back too');
    const eventsAfterCrash = await db.select().from(schema.replacementActivityEvents)
      .where(eq(schema.replacementActivityEvents.replacementId, target.id));
    assert.equal(eventsAfterCrash.length, eventsBefore.length, 'no cancellation event escaped');

    const cancelled = await cancelReplacement({
      replacementId: target.id,
      actor,
      reason: 'customer withdrew the pre-ship replacement',
    }, conn);
    assert.equal(cancelled.status, 'cancelled');
    const linesAfterCommit = await db.select().from(schema.billingLineItems)
      .where(eq(schema.billingLineItems.replacementId, target.id));
    assert.equal(linesAfterCommit.length, 0, 'the retry removes only its editable charge');
    const [action] = await db.select().from(schema.replacementFinancialActions)
      .where(eq(schema.replacementFinancialActions.replacementId, target.id));
    assert.equal(action!.actionType, 'pre_ship_cancellation_cleanup');
    assert.equal(action!.status, 'completed');
    assert.equal(action!.editableRemoved, 1);
  });

  await check('financially reversing shipped A credits only A; retry and replay duplicate nothing', async () => {
    const a = await readyToShip('ac13-amended-a');
    const b = await readyToShip('ac13-amended-b');
    for (const target of [a, b]) {
      await shipReplacement({
        replacementId: target.replacementId,
        actor: { email: actor.email, type: actor.type },
        inventoryLines: [{ replacementItemId: target.itemId, inventoryId: 900 }],
        consumePackage: packageConsumer,
        writeBilling: billingWriter as never,
      }, conn);
    }

    // Freeze only postage in an isolated historical period; pick/pack remains editable so the
    // one action must exercise both halves of the amendment without overlapping older fixtures.
    await db.execute(sql`
      update billing_line_items
         set invoiced = true,
             billing_effective_date = '2050-01-15T00:00:00Z'::timestamptz
       where replacement_id in (${a.replacementId}, ${b.replacementId})
         and line_type = 'replace_postage'
    `);
    await db.execute(sql`
      insert into billing_finalizations (
        id, client_id, period_start, period_end, line_count, order_count, subtotal, finalized_by
      ) values (
        'fin-ac13-amended', 1,
        '2050-01-01T00:00:00Z', '2050-02-01T00:00:00Z',
        2, 1, 100, 'ps-502-integration'
      )
    `);

    const bBefore = await db.select().from(schema.billingLineItems)
      .where(eq(schema.billingLineItems.replacementId, b.replacementId));
    assert.equal(bBefore.length, 2);

    await assert.rejects(
      () => requestReplacementFinancialReversal({
        replacementId: a.replacementId,
        actor: { ...FINANCE_ACTOR, permissions: ['replacements:billing'] },
        reason: 'approved finance reversal for shipped replacement A',
        idempotencyKey: 'ps502-ac13-amended-a',
      }, conn),
      (error: unknown) => (error as { code?: string }).code === 'REPLACEMENT_FINANCIAL_FORBIDDEN',
      'both replacements:billing and financials:write are required before a durable row exists',
    );

    const firstRequest = await requestReplacementFinancialReversal({
      replacementId: a.replacementId,
      actor: FINANCE_ACTOR,
      reason: 'approved finance reversal for shipped replacement A',
      idempotencyKey: 'ps502-ac13-amended-a',
    }, conn);
    assert.equal(firstRequest.alreadyRequested, false);
    assert.equal(firstRequest.action.status, 'pending', 'the obligation commits before cleanup');

    const replayBeforeWork = await requestReplacementFinancialReversal({
      replacementId: a.replacementId,
      actor: FINANCE_ACTOR,
      reason: 'approved finance reversal for shipped replacement A',
      idempotencyKey: 'ps502-ac13-amended-a',
    }, conn);
    assert.equal(replayBeforeWork.alreadyRequested, true);
    assert.equal(replayBeforeWork.action.id, firstRequest.action.id);

    let transactionNumber = 0;
    const transientWorkerConn = {
      execute: (query: unknown) =>
        (conn as unknown as { execute: (query: unknown) => Promise<unknown> }).execute(query),
      transaction: async (fn: (tx: never) => Promise<unknown>) => {
        transactionNumber += 1;
        // read action, claim action, then the action's first mutation transaction.
        if (transactionNumber === 3) throw new Error('temporary worker database fault');
        return (conn as unknown as {
          transaction: (callback: (tx: never) => Promise<unknown>) => Promise<unknown>;
        }).transaction(fn);
      },
    } as never;

    await assert.rejects(
      () => processReplacementFinancialAction(firstRequest.action.id, transientWorkerConn),
      /temporary worker database fault/,
    );
    const retry = await readReplacementFinancialAction(firstRequest.action.id, conn);
    assert.equal(retry!.status, 'retry', 'the durable obligation survives a worker failure');
    assert.equal(retry!.attempts, 1);
    assert.match(String(retry!.lastError), /temporary worker database fault/);
    const aBeforeRetry = await db.select().from(schema.billingLineItems)
      .where(eq(schema.billingLineItems.replacementId, a.replacementId));
    assert.equal(aBeforeRetry.length, 2, 'the fault happened before any financial mutation');

    await db.update(schema.replacementFinancialActions)
      .set({ nextRunAt: new Date(0) })
      .where(eq(schema.replacementFinancialActions.id, firstRequest.action.id));
    const completed = await processReplacementFinancialAction(firstRequest.action.id, conn);
    assert.equal(completed!.status, 'completed');
    assert.equal(completed!.attempts, 2, 'the same durable row was retried');
    assert.equal(completed!.editableRemoved, 1);
    assert.equal(completed!.creditsSettled, 1);
    assert.equal(Number(completed!.creditedAmount).toFixed(2), '9.75');

    const aAfter = await db.select().from(schema.billingLineItems)
      .where(eq(schema.billingLineItems.replacementId, a.replacementId));
    assert.equal(aAfter.length, 1, 'only A\'s finalized postage remains as immutable history');
    assert.equal(aAfter[0]!.lineType, 'replace_postage');
    assert.equal(aAfter[0]!.invoiced, true);

    const bAfter = await db.select().from(schema.billingLineItems)
      .where(eq(schema.billingLineItems.replacementId, b.replacementId));
    assert.deepEqual(
      bAfter.map((line) => [line.id, line.lineType, line.invoiced, Number(line.totalCost)]),
      bBefore.map((line) => [line.id, line.lineType, line.invoiced, Number(line.totalCost)]),
      'sibling B is byte-for-byte unchanged at the billing-row grain',
    );

    const aCredits = await creditNotesFor(a.replacementId);
    const bCredits = await creditNotesFor(b.replacementId);
    assert.equal(aCredits.length, 1);
    assert.equal(Number(aCredits[0]!.amount).toFixed(2), '9.75');
    assert.equal(bCredits.length, 0, 'the order-grained sibling never receives A\'s credit');

    const aLifecycle = await statusOf(a.replacementId);
    assert.equal(aLifecycle.status, 'shipped', 'financial reversal never lifecycle-cancels history');
    assert.ok(aLifecycle.shippedAt, 'authoritative dispatch evidence is preserved');

    const replayAfterWork = await requestReplacementFinancialReversal({
      replacementId: a.replacementId,
      actor: FINANCE_ACTOR,
      reason: 'approved finance reversal for shipped replacement A',
      idempotencyKey: 'ps502-ac13-amended-a',
    }, conn);
    assert.equal(replayAfterWork.alreadyRequested, true);
    const completedReplay = await processReplacementFinancialAction(firstRequest.action.id, conn);
    assert.equal(completedReplay!.status, 'completed');
    assert.equal((await creditNotesFor(a.replacementId)).length, 1, 'no duplicate credit on replay');

    const events = await db.select().from(schema.replacementActivityEvents)
      .where(eq(schema.replacementActivityEvents.replacementId, a.replacementId));
    assert.equal(
      events.filter((event) => event.eventType === 'replacement_financial_reversal_requested').length,
      1,
    );
    assert.equal(
      events.filter((event) => event.eventType === 'replacement_financial_reversal_completed').length,
      1,
    );
  });

  await check('a crash after credit commit recovers non-zero action results on retry', async () => {
    const target = await finalizeReplacement(
      'ac13-crash-after-credit',
      'fin-ac13-crash-after-credit',
    );
    const requested = await requestReplacementFinancialReversal({
      replacementId: target.replacementId,
      actor: FINANCE_ACTOR,
      reason: 'approved reversal with a simulated post-credit process death',
      idempotencyKey: 'ps502-ac13-crash-after-credit',
    }, conn);

    let crashInjected = false;
    const crashAfterCreditCommitConn = {
      execute: (query: unknown) =>
        (conn as unknown as { execute: (query: unknown) => Promise<unknown> }).execute(query),
      transaction: async (fn: (tx: never) => Promise<unknown>) => {
        const result = await (conn as unknown as {
          transaction: (callback: (tx: never) => Promise<unknown>) => Promise<unknown>;
        }).transaction(fn);
        // This check runs only after the delegated transaction has committed. The first
        // transaction that can make it true is the replacement-credit settlement; action
        // completion is the next transaction and therefore has not happened yet.
        if (!crashInjected && (await creditNotesFor(target.replacementId)).length > 0) {
          crashInjected = true;
          throw new Error('simulated process death after replacement credit commit');
        }
        return result;
      },
    } as never;

    await assert.rejects(
      () => processReplacementFinancialAction(requested.action.id, crashAfterCreditCommitConn),
      /simulated process death after replacement credit commit/,
    );
    assert.equal(crashInjected, true, 'the injected failure happened only after durable credit');
    const committedCredits = await creditNotesFor(target.replacementId);
    assert.equal(committedCredits.length, 1, 'the credit committed before the action result');
    assert.equal(Number(committedCredits[0]!.amount).toFixed(2), '12.25');

    const retry = await readReplacementFinancialAction(requested.action.id, conn);
    assert.equal(retry!.status, 'retry');
    assert.equal(retry!.creditsSettled, 0, 'completion did not falsely escape the crash boundary');
    assert.equal(Number(retry!.creditedAmount).toFixed(2), '0.00');

    await db.update(schema.replacementFinancialActions)
      .set({ nextRunAt: new Date(0) })
      .where(eq(schema.replacementFinancialActions.id, requested.action.id));
    const recovered = await processReplacementFinancialAction(requested.action.id, conn);
    assert.equal(recovered!.status, 'completed');
    assert.equal(recovered!.attempts, 2, 'the same durable action owns both attempts');
    assert.equal(recovered!.creditsSettled, 1,
      'the retry recovers the action-owned credit instead of reporting zero');
    assert.equal(Number(recovered!.creditedAmount).toFixed(2), '12.25');
    assert.equal((await creditNotesFor(target.replacementId)).length, 1,
      'recovery reads the committed credit and never duplicates it');
  });

  await client.close();
  console.log(`\nPS-502 integration passed — ${passed} checks against embedded PGlite (PostgreSQL-compatible, single-backend). Genuine multi-backend concurrency is NOT proven here.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
