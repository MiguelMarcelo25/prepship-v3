/** PS-413 behavioral integration test. Offline PGlite only; no production DB. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import * as schema from '../src/db/schema/index.js';
import { packageConsumptionReviews } from '../src/db/schema/package-consumption-reviews.js';
import { packageLedger } from '../src/db/schema/package-ledger.js';
import { packages } from '../src/db/schema/packages.js';
async function main(): Promise<void> {
  process.env.INVENTORY_AUTO_DEDUCT = 'true';
  process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
  process.env.SUPABASE_URL = 'https://example.test';
  process.env.SUPABASE_ANON_KEY = 'test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
  process.env.SUPABASE_JWT_SECRET = 'test';
  process.env.NODE_ENV = 'test';
  const {
    consumeOutboundPackage,
    reverseOutboundPackageConsumptionInTransaction,
    resolveOutboundPackageSelection,
  } = await import('../src/services/package-consumption.js');
  const client = new PGlite();
  const pg = drizzle(client, { schema, casing: 'snake_case' });
  const conn = pg as unknown as Parameters<typeof consumeOutboundPackage>[1];

  await pg.execute(sql`CREATE TABLE packages (
    id serial primary key,
    name text not null,
    type text not null default 'box',
    length real not null default 0,
    width real not null default 0,
    height real not null default 0,
    tare_weight_oz real not null default 0,
    source text not null default 'custom',
    carrier_code text,
    package_code text,
    domestic boolean,
    international boolean,
    stock_qty integer not null default 0,
    reorder_level integer not null default 10,
    unit_cost numeric(10,2),
    is_default boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`);
  await pg.execute(sql`CREATE TABLE order_overrides (
    order_id integer primary key,
    selected_package_id text
  )`);
  await pg.execute(sql`CREATE TABLE package_ledger (
    id serial primary key,
    package_id integer not null references packages(id),
    change_type text not null,
    qty_delta integer not null,
    balance_after integer not null,
    note text,
    unit_cost numeric(10,3),
    user_id uuid,
    created_at timestamptz not null default now()
  )`);
  await client.exec(readFileSync('drizzle/0060_package_consumption_ledger.sql', 'utf8'));

  await pg.insert(packages).values([
    { id: 1, name: 'Exact', length: 12, width: 10, height: 3, stockQty: 10 },
    { id: 2, name: 'Ambiguous A', length: 8, width: 6, height: 4, stockQty: 10, packageCode: 'DUP' },
    { id: 3, name: 'Ambiguous B', length: 8, width: 6, height: 4, stockQty: 10, packageCode: 'DUP' },
    { id: 4, name: 'Near A', length: 6.05, width: 5, height: 4, stockQty: 10 },
    { id: 5, name: 'Near B', length: 6.06, width: 5, height: 4, stockQty: 10 },
  ]);

  const exact = await resolveOutboundPackageSelection({
    orderId: 100,
    dimensions: { length: 12, width: 10, height: 3 },
  }, pg as never);
  assert.deepEqual(exact, { status: 'matched', packageId: 1, matchedBy: 'exact_dimensions' });

  const ambiguous = await resolveOutboundPackageSelection({
    orderId: 100,
    dimensions: { length: 8, width: 6, height: 4 },
  }, pg as never);
  assert.deepEqual(ambiguous, { status: 'review', reason: 'ambiguous_dimensions' });
  const ambiguousCode = await resolveOutboundPackageSelection({
    orderId: 100,
    selectedPackageId: 'DUP',
    dimensions: { length: 12, width: 10, height: 3 },
  }, pg as never);
  assert.deepEqual(ambiguousCode, { status: 'review', reason: 'ambiguous_selected_package' });
  const fuzzyNear = await resolveOutboundPackageSelection({
    orderId: 100,
    dimensions: { length: 6, width: 5, height: 4 },
  }, pg as never);
  assert.deepEqual(fuzzyNear, { status: 'skip', reason: 'no_package_match' }, 'near/fuzzy boxes must never be guessed');

  const input = {
    shipmentId: 501,
    orderId: 100,
    orderNumber: 'ORDER-100',
    source: 'shipstation',
    sourceAccountId: 'account-1',
    providerShipmentId: 'ss-501',
    effectiveAt: new Date('2026-07-10T12:00:00Z'),
    selectedPackageId: 1,
    dimensions: { length: 99, width: 99, height: 99 },
  };
  const first = await consumeOutboundPackage(input, conn);
  assert.equal(first.status, 'consumed');
  const retry = await consumeOutboundPackage(input, conn);
  assert.equal(retry.status, 'already_consumed');

  const [stockAfterRetry] = await pg.select({ stockQty: packages.stockQty }).from(packages).where(sql`${packages.id} = 1`);
  assert.equal(stockAfterRetry.stockQty, 9, 'retry must not double-decrement');
  const rows = await pg.select().from(packageLedger);
  assert.equal(rows.length, 1, 'retry must not duplicate ledger row');
  assert.equal(rows[0].shipmentId, 501);
  assert.equal(rows[0].orderId, 100);
  assert.equal(rows[0].source, 'shipstation');
  assert.equal(rows[0].providerShipmentId, 'ss-501');
  assert.equal(rows[0].effectiveAt?.toISOString(), '2026-07-10T12:00:00.000Z');
  assert.ok(rows[0].idempotencyKey);

  const [concurrentA, concurrentB] = await Promise.all([
    consumeOutboundPackage({ ...input, shipmentId: 502, providerShipmentId: 'ss-502' }, conn),
    consumeOutboundPackage({ ...input, shipmentId: 502, providerShipmentId: 'ss-502' }, conn),
  ]);
  assert.deepEqual(
    [concurrentA.status, concurrentB.status].sort(),
    ['already_consumed', 'consumed'],
  );
  const [stockAfterConcurrent] = await pg.select({ stockQty: packages.stockQty }).from(packages).where(sql`${packages.id} = 1`);
  assert.equal(stockAfterConcurrent.stockQty, 8, 'concurrent same-key calls decrement once');

  const review = await consumeOutboundPackage({
    ...input,
    shipmentId: 503,
    providerShipmentId: 'ss-503',
    selectedPackageId: null,
    dimensions: { length: 8, width: 6, height: 4 },
  }, conn);
  assert.deepEqual(review, { status: 'review', reason: 'ambiguous_dimensions' });

  const invalidSelected = await consumeOutboundPackage({
    ...input,
    shipmentId: 504,
    providerShipmentId: 'ss-504',
    selectedPackageId: 99999,
    dimensions: { length: 12, width: 10, height: 3 },
  }, conn);
  assert.deepEqual(invalidSelected, { status: 'review', reason: 'invalid_selected_package' });
  const reviews = await pg.select().from(packageConsumptionReviews);
  assert.equal(reviews.length, 2, 'consumption calls with ambiguous and invalid selections create durable review rows');

  const orphan = await consumeOutboundPackage({
    ...input,
    shipmentId: 506,
    orderId: null,
    providerShipmentId: 'ss-506',
  }, conn);
  assert.equal(orphan.status, 'consumed', 'unmatched real shipment consumes by selected package/dims');
  process.env.INVENTORY_AUTO_DEDUCT = 'false';
  const lockedReverse = await pg.transaction((tx) =>
    reverseOutboundPackageConsumptionInTransaction(506, new Date('2026-07-11T00:00:00Z'), tx as never));
  assert.equal(lockedReverse.status, 'lockdown', 'kill switch blocks automatic void reversal');
  process.env.INVENTORY_AUTO_DEDUCT = 'true';
  const reversed = await pg.transaction((tx) =>
    reverseOutboundPackageConsumptionInTransaction(506, new Date('2026-07-11T00:00:00Z'), tx as never));
  assert.equal(reversed.status, 'reversed');
  const reversedAgain = await pg.transaction((tx) =>
    reverseOutboundPackageConsumptionInTransaction(506, new Date('2026-07-11T00:00:00Z'), tx as never));
  assert.equal(reversedAgain.status, 'already_reversed');

  process.env.INVENTORY_AUTO_DEDUCT = 'false';
  const locked = await consumeOutboundPackage({
    ...input,
    shipmentId: 505,
    providerShipmentId: 'ss-505',
  }, conn);
  assert.deepEqual(locked, { status: 'skipped', reason: 'lockdown' });
  process.env.INVENTORY_AUTO_DEDUCT = 'true';

  const excludedCases = [
    { voided: true },
    { isReturn: true },
    { isTest: true },
  ];
  for (const [index, excluded] of excludedCases.entries()) {
    const result = await consumeOutboundPackage({
      ...input,
      shipmentId: 600 + index,
      providerShipmentId: `excluded-${Object.keys(excluded)[0]}`,
      ...excluded,
    }, conn);
    assert.equal(result.status, 'skipped');
  }

  const finalRows = await pg.select().from(packageLedger);
  assert.equal(finalRows.length, 4, 'two active consumptions plus orphan consume+void reversal');
  const [finalPackage] = await pg.select({ stockQty: packages.stockQty }).from(packages).where(sql`${packages.id} = 1`);
  assert.equal(finalPackage.stockQty, 8, 'void reversal restores exactly one consumed package');
  await assert.rejects(
    pg.delete(packages).where(sql`${packages.id} = 1`),
    'package with immutable ledger history must not be deleted',
  );
  await client.close();
  console.log('PASS PS-413 package consumption integration');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
