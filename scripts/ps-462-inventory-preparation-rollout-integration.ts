import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

async function scalar(client: PGlite, statement: string): Promise<number> {
  const result = await client.query<{ value: number }>(statement);
  return Number(result.rows[0]?.value ?? 0);
}

async function main(): Promise<void> {
  const client = new PGlite();
  const preparation = readFileSync('drizzle/0075_inventory_quantity_sot.sql', 'utf8');
  const rollback = readFileSync(
    'ops/rollback/ps-462_inventory_preparation_compatibility_rollback.sql',
    'utf8',
  );

  await client.exec(`
    create table clients (id serial primary key);
    create table inventory (
      id serial primary key, client_id integer references clients(id), sku text not null,
      stock_qty integer not null default 0
    );
    create table inventory_ledger (
      id serial primary key, inventory_id integer not null references inventory(id),
      type text not null, qty integer not null, order_id integer, note text,
      created_by text, effective_at timestamptz, idempotency_key text,
      created_at timestamptz not null default now()
    );
    create unique index inventory_ledger_idempotency_key_unq
      on inventory_ledger (idempotency_key);
    insert into clients (id) values (1);
    insert into inventory (id, client_id, sku, stock_qty) values (1, 1, 'PS462-PREP', 4);
    insert into inventory_ledger (
      inventory_id, type, qty, note, created_by, effective_at, idempotency_key
    ) values (1, 'receive', 4, 'legacy fixture', 'fixture', now(), 'legacy:1');
  `);
  const beforeRows = await scalar(client, 'select count(*)::int as value from inventory_ledger');
  const beforeQuantity = await scalar(
    client,
    'select coalesce(sum(qty), 0)::int as value from inventory_ledger',
  );

  await client.exec(preparation);
  assert.equal(await scalar(client, 'select count(*)::int as value from inventory_ledger'), beforeRows);
  assert.equal(
    await scalar(client, 'select coalesce(sum(qty), 0)::int as value from inventory_ledger'),
    beforeQuantity,
  );
  await assert.rejects(
    () => client.exec(`insert into inventory_ledger (
      inventory_id, type, qty, note, created_by, effective_at, idempotency_key
    ) values (1, 'adjust', 1, 'old runtime', 'legacy-worker', now(), 'legacy:2')`),
    /PS462_INVENTORY_MOVEMENT_IDENTITY_REQUIRED/,
  );

  await client.exec(rollback);
  await client.exec(rollback);
  await client.exec(`insert into inventory_ledger (
    inventory_id, type, qty, note, created_by, effective_at, idempotency_key
  ) values (1, 'adjust', 1, 'old runtime', 'legacy-worker', now(), 'legacy:2')`);
  assert.equal(await scalar(client, 'select count(*)::int as value from inventory_ledger'), 2);
  await assert.rejects(
    () => client.exec('update inventory_ledger set qty = 99 where id = 1'),
    /PS462_INVENTORY_LEDGER_IMMUTABLE/,
  );
  await assert.rejects(
    () => client.exec('delete from inventory_ledger where id = 1'),
    /PS462_INVENTORY_LEDGER_IMMUTABLE/,
  );
  await assert.rejects(
    () => client.exec('truncate inventory_ledger'),
    /PS462_INVENTORY_LEDGER_IMMUTABLE/,
  );

  await client.exec(preparation);
  await client.exec(`insert into inventory_ledger (
    inventory_id, type, qty, note, created_by, effective_at, idempotency_key,
    source_entity, source_id
  ) values (1, 'adjust', -1, 'new runtime', 'ps462-worker', now(), 'ps462:1',
    'ps462_test', '1')`);
  assert.equal(
    await scalar(client, 'select coalesce(sum(qty), 0)::int as value from inventory_ledger'),
    4,
  );

  await client.exec(`
    alter table inventory drop column stock_qty;
  `);
  await assert.rejects(
    () => client.exec(rollback),
    /PS462_PREPARATION_ROLLBACK_REQUIRES_PRE_CUTOVER/,
  );
  await client.exec('rollback');

  await client.close();
  console.log('PASS PS-462 inventory preparation rollout and compatibility rollback integration');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
