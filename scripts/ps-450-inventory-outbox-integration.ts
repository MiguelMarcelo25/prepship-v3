/** PS-450 read-model integration proof. Offline PGlite only; SELECT-only. */
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { getInventoryDeductionReport } from '../src/services/fulfillment/inventory-deduction-report.js';

type SqlTag = <T extends unknown[] = Record<string, unknown>[]>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T>;

function pgliteSql(client: PGlite): SqlTag {
  return (async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown[]> => {
    let query = strings[0] ?? '';
    for (let index = 0; index < values.length; index += 1) {
      query += `$${index + 1}${strings[index + 1] ?? ''}`;
    }
    return (await client.query(query, values)).rows;
  }) as SqlTag;
}

async function main(): Promise<void> {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgres://ps450:offline@127.0.0.1:1/ps450';
  process.env.SUPABASE_URL = 'https://ps450.invalid';
  process.env.SUPABASE_ANON_KEY = 'offline';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'offline';
  process.env.SUPABASE_JWT_SECRET = 'offline';
  process.env.INVENTORY_AUTO_DEDUCT = 'false';

  const { applyInventoryClaimsForLifecycleEvent } = await import(
    '../src/services/fulfillment-deductions.js'
  );
  let transactionCalls = 0;
  const lockedDown = await applyInventoryClaimsForLifecycleEvent(450, {
    transaction: async () => {
      transactionCalls += 1;
      throw new Error('kill switch allowed a transaction');
    },
  } as never);
  assert.deepEqual(lockedDown, { applied: 0, alreadyApplied: 0, lockedDown: true });
  assert.equal(transactionCalls, 0, 'disabled auto-deduct must perform zero database transactions');

  const client = new PGlite();
  try {
    await client.exec(`
      CREATE TABLE fulfillment_outbox (
        id serial PRIMARY KEY,
        order_id integer NOT NULL,
        shipment_id integer,
        event_type text NOT NULL,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        status text NOT NULL,
        attempts integer NOT NULL DEFAULT 0,
        last_error text,
        next_run_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO fulfillment_outbox
        (order_id, shipment_id, event_type, payload, status, attempts, last_error, next_run_at)
      VALUES
        (45001, 45010, 'inventory_deduction_requested', '{"lifecycleEventId":450}'::jsonb,
          'pending', 0, NULL, now()),
        (45002, NULL, 'inventory_deduction_requested', '{}'::jsonb,
          'processing', 1, NULL, now()),
        (45003, NULL, 'inventory_deduction_requested', '{}'::jsonb,
          'failed', 2, 'temporary fixture failure', now() + interval '5 minutes'),
        (45004, NULL, 'inventory_deduction_requested', '{}'::jsonb,
          'failed', 10, 'retry budget exhausted', 'infinity'::timestamptz),
        (45005, NULL, 'inventory_deduction_requested', '{}'::jsonb,
          'succeeded', 1, NULL, now()),
        (45006, NULL, 'shipment_confirmation_requested', '{}'::jsonb,
          'failed', 1, 'unrelated event', now());
    `);

    const executor = pgliteSql(client);
    const snapshotSql = `
      SELECT id, order_id, shipment_id, event_type, payload::text, status,
        attempts, last_error, next_run_at::text, created_at::text, updated_at::text
      FROM fulfillment_outbox
      ORDER BY id
    `;
    const before = await client.query(snapshotSql);
    const parked = await getInventoryDeductionReport(executor, {
      inventoryAutoDeductEnabled: false,
      now: new Date('2026-07-21T00:00:00.000Z'),
    });
    assert.equal(parked.readOnly, true);
    assert.equal(parked.rows.length, 4, 'succeeded and unrelated events stay out of the report');
    assert.equal(parked.counts.parked_kill_switch, 4);
    assert.ok(parked.rows.every((row) => row.state === 'parked_kill_switch'));
    assert.equal(parked.rows.find((row) => row.id === 1)?.lifecycleEventId, 450);

    const active = await getInventoryDeductionReport(executor, {
      inventoryAutoDeductEnabled: true,
      limit: 500,
    });
    assert.deepEqual(active.counts, {
      parked_kill_switch: 0,
      pending: 1,
      processing: 1,
      retrying: 1,
      exhausted: 1,
    });
    const after = await client.query(snapshotSql);
    assert.deepEqual(after.rows, before.rows, 'the report must not mutate outbox state');
  } finally {
    await client.close();
  }

  console.log('PASS PS-450 inventory deduction report integration');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
