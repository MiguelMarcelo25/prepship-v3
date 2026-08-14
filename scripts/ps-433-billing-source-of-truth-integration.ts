/**
 * PS-433 billing source-of-truth integration proof.
 *
 * Uses an in-memory PGlite database with the current billing/order columns and
 * the real billingInvoiceHeaderTotals owner. It never connects to production
 * and performs no provider, label, postage, or shipped/cancelled mutation.
 */
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';

async function main(): Promise<void> {
  process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
  process.env.SUPABASE_URL = 'https://example.test';
  process.env.SUPABASE_ANON_KEY = 'test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
  process.env.SUPABASE_JWT_SECRET = 'test';
  process.env.NODE_ENV = 'test';

  const { billingInvoiceHeaderTotals } = await import('../src/services/billing-invoice-totals.js');
  const client = new PGlite();
  const pg = drizzle(client, { casing: 'snake_case' });

  await pg.execute(sql`create table orders (
    id integer primary key,
    order_status text,
    canonical_status text
  )`);
  await pg.execute(sql`create table billing_line_items (
    id serial primary key,
    client_id integer not null,
    order_id integer,
    ship_date timestamptz not null,
    billing_effective_date timestamptz,
    billing_policy_version text,
    line_type text not null,
    total_cost numeric(10,2) not null
  )`);

  await pg.execute(sql`insert into orders (id, order_status, canonical_status) values
    (101, 'shipped', 'shipped'),
    (102, 'cancelled', 'cancelled'),
    (103, 'shipped', 'shipped'),
    (201, 'shipped', 'shipped')`);
  await pg.execute(sql`insert into billing_line_items
    (client_id, order_id, ship_date, line_type, total_cost) values
    (10, 101, '2026-07-10T12:00:00Z', 'pick_pack', 2.00),
    (10, 101, '2026-07-10T12:00:00Z', 'additional_unit', 1.00),
    (10, 101, '2026-07-10T12:00:00Z', 'package_cost', 3.00),
    (10, 101, '2026-07-10T12:00:00Z', 'shipping', 8.00),
    (10, 101, '2026-07-10T12:00:00Z', 'storage', 4.00),
    (10, 102, '2026-07-11T12:00:00Z', 'shipping', 99.00),
    (10, 102, '2026-07-11T12:00:00Z', 'return_label', 5.00),
    (10, 103, '2026-08-02T12:00:00Z', 'shipping', 77.00),
    (20, 201, '2026-07-12T12:00:00Z', 'shipping', 88.00)`);

  const conn = pg as unknown as Parameters<typeof billingInvoiceHeaderTotals>[3];
  const query = () => billingInvoiceHeaderTotals(
    10,
    '2026-07-01T00:00:00.000Z',
    '2026-08-01T00:00:00.000Z',
    conn,
    // PS-491: this fixture has no duplicated order numbers, so nothing is suppressed.
    // Stated explicitly rather than defaulted — the totals owner requires callers to
    // decide, which is what stops a real caller from silently double-billing.
    new Map(),
  );

  const first = await query();
  assert.deepEqual(first, {
    orderCount: 2,
    pickPackTotal: 2,
    additionalTotal: 1,
    pickPackFeeTotal: 3,
    packageTotal: 3,
    shippingTotal: 8,
    storageTotal: 4,
    adjustmentTotal: 0,
    grandTotal: 23,
    // PS-505 corrective: fulfillment SERVICE fees only — pickPackFee 3 + package 3 = 6.
    // Previously 18 (all five buckets), which made this field a second row total.
    fulfillmentFeeTotal: 6,
  });
  assert.equal(first.orderCount, 2, 'cardinality counts distinct in-scope orders, not line rows');
  assert.equal(first.shippingTotal, 8, 'cancelled non-return shipping is zeroed by the backend owner');
  // PS-505 corrective: with Fulfillment Fee narrowed to services, the residual after
  // EVERY outbound term is what the return contributed. Expressed against all four
  // outbound components rather than the old fee-vs-grand shorthand, which only isolated
  // the return money while fulfillmentFeeTotal happened to equal the outbound row.
  assert.equal(
    first.grandTotal
      - (first.fulfillmentFeeTotal + first.shippingTotal + first.storageTotal + first.adjustmentTotal),
    5,
    'return lines remain independently billable',
  );

  const before = await client.query<{ count: number }>('select count(*)::int as count from billing_line_items');
  const second = await query();
  const after = await client.query<{ count: number }>('select count(*)::int as count from billing_line_items');
  assert.deepEqual(second, first, 'repeat runs return the same frozen totals');
  assert.equal(before.rows[0]?.count, 9);
  assert.equal(after.rows[0]?.count, 9, 'idempotent read leaves migrated fixture cardinality unchanged');

  await client.close();
  console.log('PASS PS-433 billing source-of-truth PGlite integration');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
