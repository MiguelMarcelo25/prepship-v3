/**
 * PS-451 deterministic TOCTOU proof.
 *
 * In-memory PGlite only: no production database, label, postage, provider,
 * marketplace notification, inventory mutation, or real shipped order is reachable.
 */
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../src/db/schema/index.js';
import { orderOverrides, orders } from '../src/db/schema/orders.js';

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function main(): Promise<void> {
  process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
  process.env.SUPABASE_URL = 'https://example.test';
  process.env.SUPABASE_ANON_KEY = 'test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
  process.env.SUPABASE_JWT_SECRET = 'test';
  process.env.NODE_ENV = 'test';

  const { withOrderEditableWriteInTransaction } =
    await import('../src/services/order-editable-write.js');

  const client = new PGlite();
  await client.exec(`
    CREATE TABLE orders (
      id integer PRIMARY KEY,
      order_status text NOT NULL DEFAULT 'awaiting_shipment',
      canonical_status text,
      externally_shipped boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE order_overrides (
      order_id integer PRIMARY KEY REFERENCES orders(id),
      residential boolean,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  const pg = drizzle(client, { schema, casing: 'snake_case' });

  const raceIterations = 25;
  for (let index = 1; index <= raceIterations; index += 1) {
    await client.query(
      `INSERT INTO orders (id, order_status) VALUES ($1, 'awaiting_shipment')`,
      [index],
    );

    const preflightPassed = deferred();
    const shippedCommitted = deferred();
    let protectedWriteCalls = 0;

    const stalePatchRequest = (async () => {
      const [preflight] = await pg
        .select({ orderStatus: orders.orderStatus })
        .from(orders)
        .where(eq(orders.id, index))
        .limit(1);
      assert.equal(preflight?.orderStatus, 'awaiting_shipment',
        `iteration ${index}: route preflight must observe awaiting state`);
      preflightPassed.resolve();

      await shippedCommitted.promise;
      return pg.transaction((tx) => withOrderEditableWriteInTransaction(
        tx as never,
        index,
        { allowTerminal: false },
        async (writeTx) => {
          protectedWriteCalls += 1;
          await writeTx.execute(sql`
            INSERT INTO order_overrides (order_id, residential)
            VALUES (${index}, true)
          `);
          return index;
        },
      ));
    })();

    const concurrentShipment = (async () => {
      await preflightPassed.promise;
      try {
        await pg
          .update(orders)
          .set({ orderStatus: 'shipped', updatedAt: new Date() })
          .where(eq(orders.id, index));
      } finally {
        shippedCommitted.resolve();
      }
    })();

    const [patchResult] = await Promise.all([stalePatchRequest, concurrentShipment]);
    assert.equal(patchResult.ok, false, `iteration ${index}: stale PATCH must fail closed`);
    if (patchResult.ok) assert.fail(`iteration ${index}: stale PATCH unexpectedly wrote`);
    assert.equal(patchResult.reason, 'locked',
      `iteration ${index}: stale PATCH must return the locked boundary result`);
    assert.equal(patchResult.lifecycle.orderLifecycleStatus, 'shipped',
      `iteration ${index}: final guard must report shipped lifecycle truth`);
    assert.equal(protectedWriteCalls, 0,
      `iteration ${index}: protected callback must not run for the shipped row`);
    assert.equal(
      (await pg
        .select({ orderId: orderOverrides.orderId })
        .from(orderOverrides)
        .where(eq(orderOverrides.orderId, index))).length,
      0,
      `iteration ${index}: shipped row must receive zero override writes`,
    );
  }

  const editableOrderId = raceIterations + 1;
  await client.query(
    `INSERT INTO orders (id, order_status) VALUES ($1, 'awaiting_shipment')`,
    [editableOrderId],
  );
  const editableResult = await pg.transaction((tx) => withOrderEditableWriteInTransaction(
    tx as never,
    editableOrderId,
    { allowTerminal: false },
    async (writeTx) => {
      await writeTx.execute(sql`
        INSERT INTO order_overrides (order_id, residential)
        VALUES (${editableOrderId}, false)
      `);
      return editableOrderId;
    },
  ));
  assert.equal(editableResult.ok, true, 'ordinary awaiting write behavior must remain unchanged');
  assert.equal(
    (await pg
      .select({ orderId: orderOverrides.orderId })
      .from(orderOverrides)
      .where(eq(orderOverrides.orderId, editableOrderId))).length,
    1,
    'ordinary awaiting write must persist once',
  );

  await client.close();
  console.log(`PASS PS-451 order edit TOCTOU integration (${raceIterations} deterministic races)`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
