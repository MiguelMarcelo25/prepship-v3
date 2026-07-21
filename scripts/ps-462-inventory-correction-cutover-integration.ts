import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../src/db/schema/index.js';
import { buildInventoryCorrectionPlan } from '../src/services/inventory-correction-plan.js';

async function scalar(client: PGlite, statement: string): Promise<number> {
  const result = await client.query<{ value: number }>(statement);
  return Number(result.rows[0]?.value ?? 0);
}

async function main(): Promise<void> {
  process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
  process.env.SUPABASE_URL = 'https://example.test';
  process.env.SUPABASE_ANON_KEY = 'test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
  process.env.SUPABASE_JWT_SECRET = 'test';
  process.env.NODE_ENV = 'test';
  const { applyInventoryMovementInTransaction } = await import('../src/services/inventory-movement.js');
  const { buildInventoryReconciliationPlanInTransaction } = await import(
    '../src/services/inventory-reconciliation.js'
  );

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
    create table inventory_risk_metrics (
      inventory_id integer, stock_qty integer not null default 0,
      effective_stock integer not null default 0
    );
    insert into clients (id) values (1);
    insert into inventory (id, client_id, sku, stock_qty) values (1, 1, 'PS462-CORRECT', 10);
    insert into inventory_ledger (
      inventory_id, type, qty, note, created_by, effective_at, idempotency_key
    ) values (1, 'receive', 4, 'legacy fixture', 'fixture', now(), 'legacy:ps462:1');
  `);
  const preparation = readFileSync('drizzle/0073_inventory_quantity_sot.sql', 'utf8');
  const cutover = readFileSync('drizzle/0074_inventory_quantity_cutover.sql', 'utf8');
  await client.exec(preparation);

  await assert.rejects(() => client.exec(cutover), /PS439_INVENTORY_CUTOVER_BLOCKED/);
  await client.exec('rollback');

  const correction = await pg.transaction(async (tx) => {
    const source = await buildInventoryReconciliationPlanInTransaction(tx as never, {});
    const reviewed = buildInventoryCorrectionPlan(source);
    assert.equal(reviewed.rows.length, 1);
    assert.equal(reviewed.rows[0]?.correctionQuantity, 6);
    const row = reviewed.rows[0]!;
    const result = await applyInventoryMovementInTransaction(tx as never, {
      inventoryId: row.inventoryId,
      qty: row.correctionQuantity,
      type: row.type,
      orderId: row.orderId,
      note: row.note,
      createdBy: 'ps462-integration',
      effectiveAt: new Date('2026-07-21T00:00:00Z'),
      idempotencyKey: row.idempotencyKey,
      sourceEntity: row.sourceEntity,
      sourceId: row.sourceId,
    });
    assert.equal(result.status, 'applied');
    const verified = await buildInventoryReconciliationPlanInTransaction(tx as never, {});
    assert.equal(verified.rowsToAdjust, 0);
    return reviewed;
  });
  assert.equal(correction.correctionQuantity, 6);
  assert.equal(await scalar(client, 'select count(*)::int as value from inventory_ledger'), 2);
  assert.equal(
    await scalar(client, 'select coalesce(sum(qty), 0)::int as value from inventory_ledger'),
    10,
  );

  const beforeRows = await scalar(client, 'select count(*)::int as value from inventory_ledger');
  const beforeQuantity = await scalar(
    client,
    'select coalesce(sum(qty), 0)::int as value from inventory_ledger',
  );
  await client.exec(cutover);
  assert.equal(await scalar(client, 'select count(*)::int as value from inventory_ledger'), beforeRows);
  assert.equal(
    await scalar(client, 'select coalesce(sum(qty), 0)::int as value from inventory_ledger'),
    beforeQuantity,
  );
  assert.equal(await scalar(client, `select count(*)::int as value from information_schema.columns
    where table_name = 'inventory' and column_name = 'stock_qty'`), 0);
  await assert.rejects(
    () => client.exec('update inventory_ledger set qty = 99 where id = 1'),
    /PS439_INVENTORY_LEDGER_IMMUTABLE/,
  );

  await client.close();
  console.log('PASS PS-462 append-only correction and 0074 cutover integration');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
