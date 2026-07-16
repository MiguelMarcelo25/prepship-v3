/**
 * PS-424 behavioral proof. In-memory PGlite only: no production database,
 * provider, label, postage, or marketplace side effect is reachable.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as schema from '../src/db/schema/index.js';
import { fulfillmentLineClaims, orderLifecycleEvents } from '../src/db/schema/order-lifecycle.js';
import { fulfillmentOutbox } from '../src/db/schema/fulfillment-outbox.js';
import { inventory, inventoryLedger } from '../src/db/schema/inventory.js';
import { orders, orderOverrides } from '../src/db/schema/orders.js';
import { shipments } from '../src/db/schema/shipments.js';

async function main(): Promise<void> {
  process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
  process.env.SUPABASE_URL = 'https://example.test';
  process.env.SUPABASE_ANON_KEY = 'test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
  process.env.SUPABASE_JWT_SECRET = 'test';
  process.env.INVENTORY_AUTO_DEDUCT = 'true';
  process.env.NODE_ENV = 'test';

  const {
    applyOrderLifecycleCommandInTransaction,
    voidOrderShipmentLifecycleInTransaction,
  } = await import('../src/services/order-lifecycle-command.js');
  const { applyInventoryClaimsForLifecycleEvent } = await import('../src/services/fulfillment-deductions.js');

  const client = new PGlite();
  await client.exec(`
    CREATE TABLE orders (
      id serial PRIMARY KEY,
      client_id integer,
      order_number text NOT NULL,
      order_status text NOT NULL DEFAULT 'awaiting_shipment',
      canonical_status text,
      order_date timestamptz,
      items jsonb NOT NULL DEFAULT '[]'::jsonb,
      externally_shipped boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE order_overrides (
      order_id integer PRIMARY KEY REFERENCES orders(id),
      residential boolean,
      tracking_number text,
      notes text DEFAULT '',
      tags jsonb NOT NULL DEFAULT '[]'::jsonb,
      ref_usps_rate text,
      ref_ups_rate text,
      rate_weight_oz real,
      rate_dims_l real,
      rate_dims_w real,
      rate_dims_h real,
      selected_pid integer,
      selected_package_id text,
      best_rate_json jsonb,
      best_rate_at timestamptz,
      best_rate_dims text,
      recipient_override jsonb,
      shipping_account text,
      externally_shipped_source text,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE shipments (
      id serial PRIMARY KEY,
      order_id integer REFERENCES orders(id),
      voided boolean NOT NULL DEFAULT false,
      is_return boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE fulfillment_outbox (
      id serial PRIMARY KEY,
      order_id integer NOT NULL REFERENCES orders(id),
      shipment_id integer REFERENCES shipments(id),
      event_type text NOT NULL,
      provider text NOT NULL,
      dedupe_key text NOT NULL,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL DEFAULT 'pending',
      attempts integer NOT NULL DEFAULT 0,
      last_error text,
      next_run_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX fulfillment_outbox_dedupe_idx ON fulfillment_outbox (dedupe_key);
    CREATE TABLE inventory (
      id serial PRIMARY KEY,
      client_id integer,
      sku text NOT NULL,
      name text,
      image_url text,
      stock_qty integer NOT NULL DEFAULT 0,
      reorder_level integer NOT NULL DEFAULT 0,
      weight_oz real DEFAULT 0,
      length real,
      width real,
      height real,
      parent_sku_id integer,
      base_unit_qty integer NOT NULL DEFAULT 1,
      units_per_pack integer NOT NULL DEFAULT 1,
      cu_ft_override real,
      package_id integer,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE inventory_ledger (
      id serial PRIMARY KEY,
      inventory_id integer NOT NULL REFERENCES inventory(id),
      type text NOT NULL,
      qty integer NOT NULL,
      order_id integer REFERENCES orders(id),
      note text,
      created_by text,
      effective_at timestamptz,
      idempotency_key text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX inventory_ledger_idempotency_key_unq ON inventory_ledger (idempotency_key);
  `);
  await client.exec(readFileSync('drizzle/0070_order_lifecycle_commands.sql', 'utf8'));
  const pg = drizzle(client, { schema, casing: 'snake_case' });

  await client.exec(`
    INSERT INTO orders (id, order_number, items) VALUES
      (1, 'PS-424-A', '[]'::jsonb),
      (2, 'PS-424-FAULT', '[]'::jsonb),
      (3, 'PS-424-CANCEL', '[]'::jsonb),
      (4, 'PS-424-EXTERNAL', '[]'::jsonb),
      (5, 'PS-424-STATUS-FIRST', '[{"sku":"STATUS-SKU","quantity":5}]'::jsonb),
      (6, 'PS-424-BAD-QUANTITY', '[{"sku":"BAD-QTY","quantity":"unknown"}]'::jsonb)
  `);
  await client.exec(`INSERT INTO shipments (id, order_id) VALUES (101, 1), (102, 1), (105, 5), (201, 2)`);

  const ship = (args: {
    shipmentId: number;
    commandKey: string;
    quantity: number;
    faultAfter?: 'event' | 'state' | 'claims';
    orderId?: number;
  }) => pg.transaction((tx) => applyOrderLifecycleCommandInTransaction(tx as never, {
    orderId: args.orderId ?? 1,
    shipmentId: args.shipmentId,
    commandKey: args.commandKey,
    transition: 'shipped',
    source: 'ps424_fixture',
    trackingNumber: `TRACK-${args.shipmentId}`,
    fulfilledLines: [{ lineItemId: `line-${args.shipmentId}`, sku: 'PS424-SKU', quantity: args.quantity }],
    faultAfter: args.faultAfter,
  }));

  const first = await ship({ shipmentId: 101, commandKey: 'fixture:ship:101', quantity: 2 });
  assert.equal(first.claimCount, 1);
  assert.equal(first.statusChanged, true);
  let [order] = await pg.select({ orderStatus: orders.orderStatus }).from(orders).where(eq(orders.id, 1));
  assert.equal(order.orderStatus, 'shipped');
  const [override] = await pg
    .select({ trackingNumber: orderOverrides.trackingNumber })
    .from(orderOverrides)
    .where(eq(orderOverrides.orderId, 1));
  assert.equal(override.trackingNumber, 'TRACK-101');
  let claims = await pg.select().from(fulfillmentLineClaims);
  assert.deepEqual(claims.map((claim) => [claim.shipmentId, claim.lineKey, claim.quantity, claim.status]), [
    [101, 'line-101', 2, 'pending'],
  ]);
  let outbox = await pg.select().from(fulfillmentOutbox);
  assert.equal(outbox.length, 1, 'state and durable exact-claim work commit together');
  await assert.rejects(
    client.exec(`UPDATE order_lifecycle_events SET source = 'tampered' WHERE id = ${first.lifecycleEventId}`),
    /append-only/,
    'lifecycle receipts are database-enforced append-only facts',
  );

  const retry = await ship({ shipmentId: 101, commandKey: 'fixture:ship:101', quantity: 999 });
  assert.equal(retry.alreadyApplied, true);
  assert.equal((await pg.select().from(fulfillmentLineClaims)).length, 1,
    'same command never mints changed duplicate work');
  await assert.rejects(
    ship({ shipmentId: 101, commandKey: 'fixture:ship:101', quantity: 1, orderId: 2 }),
    /already belongs to order 1/,
    'a global command-key collision can never replay another order receipt',
  );
  await assert.rejects(
    ship({ shipmentId: 101, commandKey: 'fixture:wrong-shipment-owner', quantity: 1, orderId: 2 }),
    /does not belong to order 2/,
    'new lifecycle commands verify shipment ownership under lock',
  );

  await assert.rejects(
    ship({ shipmentId: 201, commandKey: 'fixture:fault', quantity: 1, faultAfter: 'claims', orderId: 2 }),
    /injected fault/,
  );
  const [faultOrder] = await pg
    .select({ orderStatus: orders.orderStatus })
    .from(orders)
    .where(eq(orders.id, 2));
  assert.equal(faultOrder.orderStatus, 'awaiting_shipment');
  assert.equal(
    (await pg.select().from(orderLifecycleEvents).where(eq(orderLifecycleEvents.commandKey, 'fixture:fault'))).length,
    0,
    'a crash at the claims boundary rolls state, receipt, claims, and outbox back',
  );

  await assert.rejects(
    pg.transaction((tx) => voidOrderShipmentLifecycleInTransaction(tx as never, {
      orderId: 3,
      shipmentId: 101,
      source: 'ps424_wrong_order_fixture',
      reversePackage: false,
    })),
    /does not belong to order/,
  );
  const [stillActive] = await pg
    .select({ voided: shipments.voided })
    .from(shipments)
    .where(eq(shipments.id, 101));
  assert.equal(stillActive.voided, false, 'a mismatched order/shipment void rolls back without mutation');

  await applyInventoryClaimsForLifecycleEvent(first.lifecycleEventId, pg as never);
  let [stock] = await pg
    .select({ stockQty: inventory.stockQty })
    .from(inventory)
    .where(eq(inventory.sku, 'PS424-SKU'));
  assert.equal(stock.stockQty, -2);
  await applyInventoryClaimsForLifecycleEvent(first.lifecycleEventId, pg as never);
  [stock] = await pg.select({ stockQty: inventory.stockQty }).from(inventory).where(eq(inventory.sku, 'PS424-SKU'));
  assert.equal(stock.stockQty, -2, 'worker retry is idempotent at the exact claim ledger key');

  const split = await ship({ shipmentId: 102, commandKey: 'fixture:ship:102', quantity: 1 });
  await applyInventoryClaimsForLifecycleEvent(split.lifecycleEventId, pg as never);
  [stock] = await pg.select({ stockQty: inventory.stockQty }).from(inventory).where(eq(inventory.sku, 'PS424-SKU'));
  assert.equal(stock.stockQty, -3, 'a second shipment claims only its own fulfilled quantity');

  const voidFirst = await pg.transaction((tx) => voidOrderShipmentLifecycleInTransaction(tx as never, {
    orderId: 1,
    shipmentId: 101,
    source: 'ps424_fixture',
    reversePackage: false,
  }));
  assert.equal(voidFirst.decision.kind, 'keep_shipped');
  assert.equal(voidFirst.reversalClaimCount, 1);
  await applyInventoryClaimsForLifecycleEvent(voidFirst.lifecycleEventId, pg as never);
  [stock] = await pg.select({ stockQty: inventory.stockQty }).from(inventory).where(eq(inventory.sku, 'PS424-SKU'));
  assert.equal(stock.stockQty, -1);
  const repeatedVoid = await pg.transaction((tx) => voidOrderShipmentLifecycleInTransaction(tx as never, {
    orderId: 1,
    shipmentId: 101,
    source: 'ps424_fixture',
    reversePackage: false,
  }));
  assert.equal(repeatedVoid.alreadyApplied, true);
  await applyInventoryClaimsForLifecycleEvent(repeatedVoid.lifecycleEventId, pg as never);
  [stock] = await pg.select({ stockQty: inventory.stockQty }).from(inventory).where(eq(inventory.sku, 'PS424-SKU'));
  assert.equal(stock.stockQty, -1, 'repeated void cannot add inventory twice');

  const voidSplit = await pg.transaction((tx) => voidOrderShipmentLifecycleInTransaction(tx as never, {
    orderId: 1,
    shipmentId: 102,
    source: 'ps424_fixture',
    reversePackage: false,
  }));
  assert.equal(voidSplit.decision.kind, 'reopen');
  await applyInventoryClaimsForLifecycleEvent(voidSplit.lifecycleEventId, pg as never);
  [stock] = await pg.select({ stockQty: inventory.stockQty }).from(inventory).where(eq(inventory.sku, 'PS424-SKU'));
  assert.equal(stock.stockQty, 0);

  await client.exec(`INSERT INTO shipments (id, order_id) VALUES (103, 1)`);
  const relabel = await ship({ shipmentId: 103, commandKey: 'fixture:ship:103', quantity: 4 });
  await applyInventoryClaimsForLifecycleEvent(relabel.lifecycleEventId, pg as never);
  const voidRelabel = await pg.transaction((tx) => voidOrderShipmentLifecycleInTransaction(tx as never, {
    orderId: 1,
    shipmentId: 103,
    source: 'ps424_fixture',
    reversePackage: false,
  }));
  await applyInventoryClaimsForLifecycleEvent(voidRelabel.lifecycleEventId, pg as never);
  await client.exec(`INSERT INTO shipments (id, order_id) VALUES (104, 1)`);
  const changedRelabel = await ship({ shipmentId: 104, commandKey: 'fixture:ship:104', quantity: 2 });
  await applyInventoryClaimsForLifecycleEvent(changedRelabel.lifecycleEventId, pg as never);
  [stock] = await pg.select({ stockQty: inventory.stockQty }).from(inventory).where(eq(inventory.sku, 'PS424-SKU'));
  assert.equal(stock.stockQty, -2, 'void + changed-quantity relabel applies the new exact quantity');

  const cancellation = await pg.transaction((tx) => applyOrderLifecycleCommandInTransaction(tx as never, {
    orderId: 3,
    commandKey: 'fixture:cancel:3',
    transition: 'cancelled',
    source: 'marketplace_status',
    fulfilledLines: [],
  }));
  assert.equal(cancellation.claimCount, 0, 'cancellation creates no fulfillment deduction claims');
  const [cancelled] = await pg
    .select({ orderStatus: orders.orderStatus, canonicalStatus: orders.canonicalStatus })
    .from(orders)
    .where(eq(orders.id, 3));
  assert.equal(cancelled.orderStatus, 'cancelled');
  assert.equal(cancelled.canonicalStatus, 'cancelled');
  const cancelledClassification = await pg.transaction((tx) =>
    applyOrderLifecycleCommandInTransaction(tx as never, {
      orderId: 3,
      commandKey: 'fixture:external-classified:3',
      transition: 'external_classified',
      source: 'external_classifier',
      externallyShippedSource: 'marketplace_fulfilled',
      fulfilledLines: [],
    }));
  assert.equal(cancelledClassification.claimCount, 0);
  const [classifiedCancelled] = await pg
    .select({ orderStatus: orders.orderStatus, externallyShipped: orders.externallyShipped })
    .from(orders)
    .where(eq(orders.id, 3));
  assert.deepEqual(classifiedCancelled, { orderStatus: 'cancelled', externallyShipped: true },
    'external classification can annotate a cancelled row without reopening or shipping it');

  await pg.transaction((tx) => applyOrderLifecycleCommandInTransaction(tx as never, {
    orderId: 4,
    commandKey: 'fixture:external:4',
    transition: 'external_shipped',
    source: 'webhook',
    externallyShippedSource: 'webhook:shopify',
    fulfilledLines: [{ id: 'external-line', sku: 'EXT', quantity: 1 }],
  }));
  const [externalOverride] = await pg
    .select({ externallyShippedSource: orderOverrides.externallyShippedSource })
    .from(orderOverrides)
    .where(eq(orderOverrides.orderId, 4));
  assert.equal(externalOverride.externallyShippedSource, 'webhook:shopify',
    'external provenance is written to order_overrides, never a nonexistent orders column');

  const outboxBeforeBadQuantity = (await pg.select().from(fulfillmentOutbox)).length;
  const badQuantity = await pg.transaction((tx) => applyOrderLifecycleCommandInTransaction(tx as never, {
    orderId: 6,
    commandKey: 'fixture:external:bad-quantity',
    transition: 'external_shipped',
    source: 'bad_quantity_fixture',
  }));
  const [badQuantityClaim] = await pg
    .select({ status: fulfillmentLineClaims.status, lastError: fulfillmentLineClaims.lastError })
    .from(fulfillmentLineClaims)
    .where(eq(fulfillmentLineClaims.lifecycleEventId, badQuantity.lifecycleEventId));
  assert.deepEqual(badQuantityClaim, { status: 'review', lastError: 'invalid_quantity' });
  assert.equal((await pg.select().from(fulfillmentOutbox)).length, outboxBeforeBadQuantity,
    'invalid quantities never enqueue real inventory movement');

  const statusOnly = await pg.transaction((tx) => applyOrderLifecycleCommandInTransaction(tx as never, {
    orderId: 5,
    commandKey: 'fixture:status-only:5',
    transition: 'shipped',
    source: 'order_sync_status',
    fulfilledLines: [],
  }));
  assert.equal(statusOnly.claimCount, 0, 'status-only shipped evidence never guesses mutable order quantities');
  await assert.rejects(
    pg.transaction((tx) => applyOrderLifecycleCommandInTransaction(tx as never, {
      orderId: 5,
      commandKey: 'fixture:stale-awaiting-writer:5',
      transition: 'external_shipped',
      source: 'stale_manual_writer',
      requireAwaitingOrderStatus: true,
    })),
    /no longer awaiting shipment/,
    'an awaiting-only caller rechecks terminal state under the order lock',
  );
  const exactAfterStatus = await pg.transaction((tx) => applyOrderLifecycleCommandInTransaction(tx as never, {
    orderId: 5,
    shipmentId: 105,
    commandKey: 'fixture:ship:105',
    transition: 'shipped',
    source: 'shipment_sync',
    fulfilledLines: [{ lineItemId: 'status-exact', sku: 'STATUS-SKU', quantity: 2 }],
  }));
  await applyInventoryClaimsForLifecycleEvent(exactAfterStatus.lifecycleEventId, pg as never);
  const [statusStock] = await pg
    .select({ stockQty: inventory.stockQty })
    .from(inventory)
    .where(eq(inventory.sku, 'STATUS-SKU'));
  assert.equal(statusStock.stockQty, -2, 'later exact shipment facts deduct once, not the whole order plus shipment');

  claims = await pg.select().from(fulfillmentLineClaims);
  assert.ok(claims.every((claim) =>
    claim.direction === 'reverse'
      ? claim.originalClaimId != null && claim.idempotencyKey.endsWith(':void')
      : claim.idempotencyKey.includes(`lifecycle:${claim.lifecycleEventId}:line:`)),
  'deductions are lifecycle-event + line scoped and reversals link that exact claim');
  const ledger = await pg.select().from(inventoryLedger);
  assert.equal(new Set(ledger.map((row) => row.idempotencyKey)).size, ledger.length);
  outbox = await pg.select().from(fulfillmentOutbox);
  assert.equal(new Set(outbox.map((row) => row.dedupeKey)).size, outbox.length);

  await client.close();
  console.log('PASS PS-424 order lifecycle command integration');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
