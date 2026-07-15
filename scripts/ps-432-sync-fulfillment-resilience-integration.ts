/**
 * PS-432 executable failure-injection proof.
 *
 * Offline PGlite only. This exercises the real canonical owners with injected
 * database/provider boundaries. It never opens a configured database, buys
 * postage, creates a label, or notifies a marketplace.
 */
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql as drizzleSql } from 'drizzle-orm';
import { fulfillmentOutbox } from '../src/db/schema/fulfillment-outbox.js';

type SqlTag = {
  <T extends unknown[] = Record<string, unknown>[]>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
  begin<T>(callback: (tx: SqlTag) => Promise<T>): Promise<T>;
};

function pgliteSql(client: {
  query: (query: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  transaction: <T>(callback: (tx: any) => Promise<T>) => Promise<T>;
}): SqlTag {
  const executor = (async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown[]> => {
    let query = strings[0] ?? '';
    for (let index = 0; index < values.length; index += 1) {
      query += `$${index + 1}${strings[index + 1] ?? ''}`;
    }
    const result = await client.query(query, values);
    return result.rows;
  }) as SqlTag;
  executor.begin = (callback) =>
    client.transaction((tx) => callback(pgliteSql(tx)));
  return executor;
}

async function createFixtureSchema(client: PGlite): Promise<void> {
  await client.exec(`
    CREATE TABLE orders (
      id integer PRIMARY KEY,
      order_status text NOT NULL DEFAULT 'awaiting_shipment',
      source_provider text,
      source_account_id text,
      source_order_id text,
      source_order_number text,
      source_status text,
      canonical_status text,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX orders_source_provider_idx ON orders (source_provider);
    CREATE INDEX orders_canonical_status_idx ON orders (canonical_status);

    CREATE TABLE shipments (
      id integer PRIMARY KEY,
      order_id integer NOT NULL REFERENCES orders(id),
      voided boolean NOT NULL DEFAULT false,
      carrier_provider text,
      carrier_account_id text,
      label_provider_key text,
      confirmation_status text,
      confirmation_provider text,
      confirmation_attempts integer NOT NULL DEFAULT 0,
      confirmation_last_error text,
      marketplace_confirmed_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX shipments_confirmation_status_idx ON shipments (confirmation_status);

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
    CREATE INDEX fulfillment_outbox_due_idx ON fulfillment_outbox (status, next_run_at);

    CREATE TABLE label_purchase_intents (
      id serial PRIMARY KEY,
      order_id integer NOT NULL,
      provider text NOT NULL,
      request_fingerprint text,
      state text NOT NULL DEFAULT 'provider_pending',
      shipment_id integer,
      error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

async function main(): Promise<void> {
  process.env.NODE_ENV = 'test';
  process.env.VERCEL = '1';
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
  process.env.SUPABASE_JWT_SECRET = 'test';

  const client = new PGlite();
  try {
    await createFixtureSchema(client);
    const injectedSql = pgliteSql(client as never);
    const db = drizzle(client, {
      schema: { fulfillmentOutbox },
      casing: 'snake_case',
    });

    const {
      enqueueInventoryDeduction,
    } = await import('../src/services/fulfillment/inventory-deduction-outbox.js');
    const {
      assertFulfillmentSchemaReady,
      resetFulfillmentSchemaReadinessForTests,
    } = await import('../src/services/fulfillment/schema-readiness.js');
    const {
      reconvergeSucceededShipmentConfirmations,
    } = await import('../src/services/fulfillment/outbox.js');
    const {
      assertNoUnresolvedLabelPurchaseIntent,
      createLabelPurchaseIntent,
      isLabelPurchaseReconcileRequiredError,
      resolveLabelPurchaseIntentByOperator,
    } = await import('../src/lib/label-purchase-intent.js');
    const {
      createShipStationStoreConnector,
    } = await import('../src/connectors/store/shipstation.js');

    // 1. A forced failure inside the shipped transition transaction rolls back
    // both the status change and the real inventory-intent owner insert.
    await client.query(
      `INSERT INTO orders (id, order_status, canonical_status)
       VALUES (43201, 'awaiting_shipment', 'awaiting_shipment')`,
    );
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.execute(drizzleSql`
          UPDATE orders
          SET order_status = 'shipped', canonical_status = 'shipped'
          WHERE id = 43201
        `);
        await enqueueInventoryDeduction(
          { id: 43201 },
          { source: 'ps_432_forced_rollback' },
          tx as never,
        );
        throw new Error('forced process failure before commit');
      }),
      /forced process failure before commit/,
    );
    const rolledBackOrder = await client.query<{ order_status: string }>(
      `SELECT order_status FROM orders WHERE id = 43201`,
    );
    const rolledBackIntent = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM fulfillment_outbox WHERE order_id = 43201`,
    );
    assert.equal(rolledBackOrder.rows[0]?.order_status, 'awaiting_shipment');
    assert.equal(rolledBackIntent.rows[0]?.count, 0);

    await db.transaction(async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE orders
        SET order_status = 'shipped', canonical_status = 'shipped'
        WHERE id = 43201
      `);
      await enqueueInventoryDeduction(
        { id: 43201 },
        { source: 'ps_432_committed' },
        tx as never,
      );
    });
    const committedPair = await client.query<{
      order_status: string;
      intent_count: number;
    }>(`
      SELECT o.order_status,
        count(f.id)::int AS intent_count
      FROM orders o
      LEFT JOIN fulfillment_outbox f ON f.order_id = o.id
      WHERE o.id = 43201
      GROUP BY o.order_status
    `);
    assert.deepEqual(committedPair.rows[0], {
      order_status: 'shipped',
      intent_count: 1,
    });

    // 2. A provider-success row with torn local projections reconverges once.
    // Calling the owner again returns zero and has no connector/provider seam.
    await client.exec(`
      INSERT INTO orders (id, order_status, canonical_status)
      VALUES (43202, 'shipped', 'confirmation_pending');
      INSERT INTO shipments (id, order_id, confirmation_status, confirmation_attempts)
      VALUES (43220, 43202, 'processing', 1);
      INSERT INTO fulfillment_outbox (
        order_id, shipment_id, event_type, provider, dedupe_key, payload,
        status, attempts
      ) VALUES (
        43202, 43220, 'shipment_confirmation_requested', 'shipstation',
        'shipment_confirmation_requested:43220',
        '{"carrierProvider":"shipstation","carrierAccountId":"fixture"}'::jsonb,
        'succeeded', 1
      );
    `);
    resetFulfillmentSchemaReadinessForTests();
    await assertFulfillmentSchemaReady(injectedSql as never);
    const firstReconvergence = await reconvergeSucceededShipmentConfirmations(
      25,
      injectedSql as never,
    );
    const secondReconvergence = await reconvergeSucceededShipmentConfirmations(
      25,
      injectedSql as never,
    );
    assert.equal(firstReconvergence, 1);
    assert.equal(secondReconvergence, 0);
    const reconverged = await client.query<{
      canonical_status: string;
      confirmation_status: string;
      confirmation_attempts: number;
      marketplace_confirmed_at: Date | string | null;
    }>(`
      SELECT o.canonical_status, s.confirmation_status,
        s.confirmation_attempts, s.marketplace_confirmed_at
      FROM orders o
      JOIN shipments s ON s.order_id = o.id
      WHERE o.id = 43202
    `);
    assert.equal(reconverged.rows[0]?.canonical_status, 'shipped');
    assert.equal(reconverged.rows[0]?.confirmation_status, 'succeeded');
    assert.equal(reconverged.rows[0]?.confirmation_attempts, 2);
    assert.ok(reconverged.rows[0]?.marketplace_confirmed_at);

    // 3. Simulate a Shopify provider ACK followed by process death before
    // persistence. The actual intent owner blocks the retry before the provider
    // spy can run a second time, then requires an explicit audited resolution.
    const intentDependencies = {
      executor: injectedSql as never,
      ensureSchema: async () => undefined,
    };
    let shopifyProviderCalls = 0;
    await assertNoUnresolvedLabelPurchaseIntent(43203, intentDependencies);
    const crashedIntentId = await createLabelPurchaseIntent({
      orderId: 43203,
      provider: 'shopify_shipping',
      requestFingerprint: 'fulfillment=fixture-43203',
    }, intentDependencies);
    shopifyProviderCalls += 1;
    await assert.rejects(
      async () => {
        await assertNoUnresolvedLabelPurchaseIntent(43203, intentDependencies);
        shopifyProviderCalls += 1;
      },
      isLabelPurchaseReconcileRequiredError,
    );
    assert.equal(shopifyProviderCalls, 1, 'Shopify retry must not repurchase');
    const crashedIntent = await client.query<{ state: string; error: string | null }>(
      `SELECT state, error FROM label_purchase_intents WHERE id = $1`,
      [crashedIntentId],
    );
    assert.equal(crashedIntent.rows[0]?.state, 'reconcile_required');
    assert.match(crashedIntent.rows[0]?.error ?? '', /process died between provider purchase/);
    await resolveLabelPurchaseIntentByOperator(crashedIntentId, {
      outcome: 'provider_verified_no_label',
      note: 'offline fixture verified no active shipment',
    }, intentDependencies);
    await assert.doesNotReject(() =>
      assertNoUnresolvedLabelPurchaseIntent(43203, intentDependencies));

    // 4. Operator resolution is order/shipment scoped and retains its note.
    await client.exec(`
      INSERT INTO orders (id, order_status, canonical_status)
      VALUES
        (43204, 'shipped', 'shipped'),
        (43205, 'shipped', 'shipped');
      INSERT INTO shipments (id, order_id)
      VALUES
        (43240, 43204),
        (43250, 43205);
    `);
    const scopedIntentId = await createLabelPurchaseIntent({
      orderId: 43204,
      provider: 'shipstation',
      requestFingerprint: 'fixture-43204',
    }, intentDependencies);
    await assert.rejects(
      () => resolveLabelPurchaseIntentByOperator(scopedIntentId, {
        outcome: 'linked_shipment',
        shipmentId: 43250,
        note: 'wrong-order fixture',
      }, intentDependencies),
      /does not belong/,
    );
    await assert.rejects(
      () => resolveLabelPurchaseIntentByOperator(scopedIntentId, {
        outcome: 'provider_verified_no_label',
        note: 'conflicts with active shipment fixture',
      }, intentDependencies),
      /active shipment exists/,
    );
    const scopedResolution = await resolveLabelPurchaseIntentByOperator(scopedIntentId, {
      outcome: 'linked_shipment',
      shipmentId: 43240,
      note: 'provider reference matched active shipment',
    }, intentDependencies);
    assert.deepEqual(scopedResolution, {
      id: scopedIntentId,
      orderId: 43204,
      state: 'resolved_by_operator',
      shipmentId: 43240,
    });
    const resolutionAudit = await client.query<{
      shipment_id: number;
      error: string;
    }>(`SELECT shipment_id, error FROM label_purchase_intents WHERE id = $1`, [scopedIntentId]);
    assert.equal(resolutionAudit.rows[0]?.shipment_id, 43240);
    assert.match(resolutionAudit.rows[0]?.error ?? '', /operator linked_shipment/);

    // 5. Simulate ShipStation accepting markasshipped and the process dying
    // before local settlement. The retry re-reads upstream shipped truth and
    // must not send a second marketplace notification.
    let upstreamOrderStatus = 'awaiting_shipment';
    let marketplaceNotificationCalls = 0;
    const connector = createShipStationStoreConnector({
      loadOrder: async (orderId) => {
        assert.equal(orderId, 4320001);
        return { orderStatus: upstreamOrderStatus };
      },
      markOrderShipped: async () => {
        marketplaceNotificationCalls += 1;
        upstreamOrderStatus = 'shipped';
      },
    });
    const confirmationInput = {
      orderId: 43206,
      shipmentId: 43260,
      externalOrderId: '4320001',
      clientId: 1,
      orderNumber: 'PS-432-FIXTURE',
      trackingNumber: 'OFFLINE-FIXTURE',
      carrierCode: 'ups',
      shipDate: '2026-07-15',
      notifyCustomer: false,
      notifyMarketplace: true,
      credentials: { apiKey: 'fixture', apiSecret: 'fixture' },
    };
    const firstConfirmation = await connector.confirmShipment(confirmationInput);
    assert.equal(firstConfirmation.ok, true);
    assert.equal(marketplaceNotificationCalls, 1);
    const retryConfirmation = await connector.confirmShipment(confirmationInput);
    assert.equal(retryConfirmation.ok, true);
    assert.match(retryConfirmation.message ?? '', /already shipped/i);
    assert.equal(
      marketplaceNotificationCalls,
      1,
      'ShipStation retry must not notify the marketplace twice',
    );

    resetFulfillmentSchemaReadinessForTests();
  } finally {
    await client.close();
  }

  console.log('PASS PS-432 executable transaction/provider retry integration');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
