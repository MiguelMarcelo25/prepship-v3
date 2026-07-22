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
  await client.exec(`
    create table clients (id serial primary key);
    create table inventory (
      id serial primary key, client_id integer references clients(id), sku text not null,
      name text, image_url text, stock_qty integer not null default 0,
      reorder_level integer not null default 0, weight_oz real default 0,
      length real, width real, height real, parent_sku_id integer,
      base_unit_qty integer not null default 1, units_per_pack integer not null default 1,
      cu_ft_override real, package_id integer, active boolean not null default true,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now()
    );
    create table inventory_ledger (
      id serial primary key, inventory_id integer not null references inventory(id),
      type text not null, qty integer not null, order_id integer, note text,
      created_by text, effective_at timestamptz, idempotency_key text,
      created_at timestamptz not null default now()
    );
    create unique index inventory_ledger_idempotency_key_unq
      on inventory_ledger (idempotency_key);
    create table inventory_risk_metrics (stock_qty integer, effective_stock integer);
  `);
  await client.exec(`insert into inventory (id, sku, stock_qty) values (1, 'PS439', 0)`);
  const preparationMigration = readFileSync('drizzle/0075_inventory_quantity_sot.sql', 'utf8');
  const cutoverMigration = readFileSync('drizzle/0076_inventory_quantity_cutover.sql', 'utf8');
  await assert.rejects(
    () => client.exec(cutoverMigration),
    /PS462_INVENTORY_CUTOVER_SCHEMA_NOT_READY/,
    'cutover requires the additive identity and immutability stage first',
  );
  await client.exec(preparationMigration);
  await client.exec(preparationMigration);

  await client.exec(`alter table inventory_ledger disable trigger inventory_ledger_no_update_delete`);
  await assert.rejects(
    () => client.exec(cutoverMigration),
    /PS462_INVENTORY_CUTOVER_SCHEMA_NOT_READY/,
    'cutover rejects a present but disabled ledger safety trigger',
  );
  await client.exec(`alter table inventory_ledger enable trigger inventory_ledger_no_update_delete`);

  let columnResult = await pg.execute<{ count: number }>(sql`
    select count(*)::int as count from information_schema.columns
    where table_name = 'inventory' and column_name = 'stock_qty'
  `);
  let [column] = (columnResult as unknown as { rows: Array<{ count: number }> }).rows;
  assert.equal(Number(column?.count), 1, 'the additive preparation keeps legacy stock_qty');

  const move = (qty: number, key: string, type: 'receive' | 'ship' | 'adjust') =>
    pg.transaction((tx) => applyInventoryMovementInTransaction(tx as never, {
      inventoryId: 1,
      type,
      qty,
      orderId: type === 'ship' ? 99 : null,
      note: key,
      createdBy: 'ps439-test',
      effectiveAt: new Date('2026-07-21T00:00:00Z'),
      idempotencyKey: key,
      sourceEntity: 'ps439_test',
      sourceId: key,
    }));

  await Promise.all([
    move(5, 'receive:1', 'receive'),
    move(-8, 'ship:1', 'ship'),
  ]);
  let [quantity] = await pg.select({ total: sql<number>`coalesce(sum(${inventoryLedger.qty}), 0)::int` }).from(inventoryLedger);
  assert.equal(quantity.total, -3, 'concurrent receive and ship preserve both signed movements');

  await assert.rejects(
    () => move(1, 'bad:positive-ship', 'ship'),
    /INVENTORY_MOVEMENT_DIRECTION_INVALID/,
    'positive ship deltas fail at the canonical movement owner',
  );
  await assert.rejects(
    () => move(-1, 'bad:negative-receive', 'receive'),
    /INVENTORY_MOVEMENT_DIRECTION_INVALID/,
    'negative receive deltas fail at the canonical movement owner',
  );
  await assert.rejects(
    () => client.exec(`
      insert into inventory_ledger (
        inventory_id, type, qty, created_by, effective_at, idempotency_key, source_entity, source_id
      ) values (1, 'ship', 1, 'ps439-test', now(), 'bad-db-direction', 'ps439_test', 'bad-db-direction')
    `),
    /PS462_INVENTORY_MOVEMENT_DIRECTION_INVALID/,
    'the DB boundary rejects a direction-invalid movement even outside the service',
  );
  await assert.rejects(
    () => pg.update(inventory).set({ sku: 'RENAMED' }).where(eq(inventory.id, 1)),
    (error: unknown) => {
      const wrapped = error as { message?: string; cause?: { message?: string } };
      return `${wrapped.message ?? ''} ${wrapped.cause?.message ?? ''}`.includes(
        'PS462_INVENTORY_IDENTITY_IMMUTABLE',
      );
    },
    'catalog identity cannot drift after signed history exists',
  );

  await move(4, 'receive:2', 'receive');
  [quantity] = await pg.select({ total: sql<number>`coalesce(sum(${inventoryLedger.qty}), 0)::int` }).from(inventoryLedger);
  assert.equal(quantity.total, 1, 'later receive recovers the negative balance');

  const replay = await Promise.all([move(-2, 'ship:replay', 'ship'), move(-2, 'ship:replay', 'ship')]);
  assert.deepEqual(replay.map((result) => result.status).sort(), ['already_applied', 'applied']);
  await assert.rejects(() => move(-3, 'ship:replay', 'ship'), /INVENTORY_IDEMPOTENCY_CONFLICT/);
  [quantity] = await pg.select({ total: sql<number>`coalesce(sum(${inventoryLedger.qty}), 0)::int` }).from(inventoryLedger);
  assert.equal(quantity.total, -1, 'replayed ship deducts exactly once');

  await assert.rejects(
    async () => {
      await pg.update(inventory).set({ active: false }).where(eq(inventory.id, 1));
      await client.exec(cutoverMigration);
    },
    /PS462_INVENTORY_CUTOVER_BLOCKED/,
    'inactive catalog rows remain inside discrepancy/cutover coverage',
  );
  await assert.rejects(
    () => client.exec(cutoverMigration),
    /PS462_INVENTORY_CUTOVER_BLOCKED/,
    'cutover fails closed while the legacy quantity differs from the ledger',
  );
  await move(1, 'ps439:reviewed-correction:1', 'adjust');
  [quantity] = await pg.select({ total: sql<number>`coalesce(sum(${inventoryLedger.qty}), 0)::int` }).from(inventoryLedger);
  assert.equal(quantity.total, 0, 'reviewed correction is an append-only movement');
  await client.exec(cutoverMigration);
  await client.exec(cutoverMigration);

  await assert.rejects(() => pg.update(inventoryLedger).set({ qty: 999 }).where(eq(inventoryLedger.id, 1)));
  await assert.rejects(() => pg.delete(inventoryLedger).where(eq(inventoryLedger.id, 1)));
  await assert.rejects(() => client.exec(`
    insert into inventory_ledger (
      inventory_id, type, qty, created_by, effective_at, idempotency_key, source_entity, source_id
    ) values (1, 'adjust', 0, 'ps439-test', now(), 'zero', 'ps439_test', 'zero')
  `));
  columnResult = await pg.execute<{ count: number }>(sql`
    select count(*)::int as count from information_schema.columns
    where table_name = 'inventory' and column_name = 'stock_qty'
  `);
  [column] = (columnResult as unknown as { rows: Array<{ count: number }> }).rows;
  assert.equal(Number(column?.count), 0);

  await client.close();
  console.log('PASS PS-439 inventory concurrency integration');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
