/** PS-414 behavioral integration test. Offline PGlite only; no production DB. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../src/db/schema/index.js';
import { inventory, inventoryLedger } from '../src/db/schema/inventory.js';

async function main(): Promise<void> {
  process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
  process.env.SUPABASE_URL = 'https://example.test';
  process.env.SUPABASE_ANON_KEY = 'test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
  process.env.SUPABASE_JWT_SECRET = 'test';
  process.env.NODE_ENV = 'test';
  const { applyInventoryMovementInTransaction } = await import('../src/services/inventory-movement.js');

  const client = new PGlite();
  const pg = drizzle(client, { schema, casing: 'snake_case' });
  await pg.execute(sql`CREATE TABLE inventory (
    id serial primary key,
    client_id integer,
    sku text not null,
    name text,
    image_url text,
    stock_qty integer not null default 0,
    reorder_level integer not null default 0,
    weight_oz real default 0,
    length real,
    width real,
    height real,
    parent_sku_id integer,
    base_unit_qty integer not null default 1,
    units_per_pack integer not null default 1,
    cu_ft_override real,
    package_id integer,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`);
  await pg.execute(sql`CREATE TABLE inventory_ledger (
    id serial primary key,
    inventory_id integer not null,
    type text not null,
    qty integer not null,
    order_id integer,
    note text,
    created_by text,
    created_at timestamptz not null default now()
  )`);
  await pg.insert(inventory).values({ id: 1, sku: 'PS414', stockQty: 10 });
  await pg.execute(sql`INSERT INTO inventory_ledger
    (inventory_id, type, qty, created_at)
    VALUES (1, 'adjust', 0, '2024-01-02T00:00:00Z')`);
  await client.exec(readFileSync('drizzle/0061_inventory_ledger_effective_at.sql', 'utf8'));

  const [legacy] = await pg.select().from(inventoryLedger).where(eq(inventoryLedger.id, 1));
  assert.equal(legacy.effectiveAt, null, 'migration must not rewrite historical movement dates');
  assert.equal(legacy.createdAt.toISOString(), '2024-01-02T00:00:00.000Z');

  const move = (qty: number, idempotencyKey: string, effectiveAt: Date) =>
    pg.transaction((tx) => applyInventoryMovementInTransaction(tx as never, {
      inventoryId: 1,
      type: 'adjust',
      qty,
      effectiveAt,
      idempotencyKey,
    }));
  const [receive, adjust] = await Promise.all([
    move(5, 'receive:one', new Date('2026-06-01T12:00:00Z')),
    move(-2, 'adjust:one', new Date('2026-06-02T12:00:00Z')),
  ]);
  assert.equal(receive.status, 'applied');
  assert.equal(adjust.status, 'applied');
  let [row] = await pg.select({ stockQty: inventory.stockQty }).from(inventory).where(eq(inventory.id, 1));
  assert.equal(row.stockQty, 13, 'concurrent atomic deltas must compose');

  const ship = () => pg.transaction((tx) => applyInventoryMovementInTransaction(tx as never, {
    inventoryId: 1,
    type: 'ship',
    qty: -3,
    orderId: 99,
    effectiveAt: new Date('2026-06-03T12:00:00Z'),
    idempotencyKey: 'inventory:ship:order:99:inventory:1',
  }));
  const sameShip = await Promise.all([ship(), ship()]);
  assert.deepEqual(sameShip.map((result) => result.status).sort(), ['already_applied', 'applied']);
  [row] = await pg.select({ stockQty: inventory.stockQty }).from(inventory).where(eq(inventory.id, 1));
  assert.equal(row.stockQty, 10, 'same ship identity must decrement once');

  const rows = await pg.select().from(inventoryLedger);
  assert.equal(rows.length, 4);
  const shipped = rows.find((entry) => entry.type === 'ship');
  assert.equal(shipped?.effectiveAt?.toISOString(), '2026-06-03T12:00:00.000Z');
  assert.notEqual(shipped?.createdAt.toISOString(), shipped?.effectiveAt?.toISOString());

  await client.close();
  console.log('PASS PS-414 inventory ledger integration');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
