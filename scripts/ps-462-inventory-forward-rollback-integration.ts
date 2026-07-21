import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

async function scalar(client: PGlite, statement: string): Promise<number> {
  const result = await client.query<{ value: number }>(statement);
  return Number(result.rows[0]?.value ?? 0);
}

async function main(): Promise<void> {
  const client = new PGlite();
  const preparation = readFileSync('drizzle/0073_inventory_quantity_sot.sql', 'utf8');
  const cutover = readFileSync('drizzle/0074_inventory_quantity_cutover.sql', 'utf8');
  const rollback = readFileSync('ops/rollback/ps-462_inventory_quantity_forward_rollback.sql', 'utf8');

  await client.exec(`
    create table clients (id serial primary key);
    create table inventory (
      id serial primary key, client_id integer references clients(id), sku text not null,
      stock_qty integer not null default 0, reorder_level integer not null default 0,
      updated_at timestamptz not null default now()
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
      inventory_id integer primary key, stock_qty integer not null default 0,
      effective_stock integer not null default 0
    );
    insert into inventory (id, sku, stock_qty) values (1, 'PS462-A', 3), (2, 'PS462-B', 0);
    insert into inventory_risk_metrics (inventory_id, stock_qty, effective_stock)
      values (1, 3, 3), (2, 0, 0);
  `);

  await client.exec(preparation);
  await client.exec(`
    insert into inventory_ledger (
      inventory_id, type, qty, note, created_by, effective_at, idempotency_key,
      source_entity, source_id
    ) values
      (1, 'receive', 3, 'fixture', 'ps462-test', now(), 'fixture:1', 'fixture', '1');
  `);

  await assert.rejects(
    () => client.exec(rollback),
    /PS462_FORWARD_ROLLBACK_REQUIRES_0074/,
    'the emergency rollback cannot replace the normal pre-cutover trigger',
  );
  await client.exec('rollback');

  await client.exec(cutover);
  assert.equal(
    await scalar(client, `select count(*)::int as value from information_schema.columns
      where table_name = 'inventory' and column_name = 'stock_qty'`),
    0,
  );

  await client.exec(rollback);
  await client.exec(rollback);
  assert.equal(
    await scalar(client, `select count(*)::int as value from information_schema.columns
      where table_name = 'inventory' and column_name = 'stock_qty'`),
    1,
    'repeat execution keeps exactly one compatibility column',
  );
  assert.equal(
    await scalar(client, `select stock_qty::int as value from inventory where id = 1`),
    3,
    'forward rollback derives the cache from immutable movements',
  );

  await client.exec(`
    begin;
    insert into inventory_ledger (
      inventory_id, type, qty, order_id, note, created_by, effective_at, idempotency_key
    ) values (1, 'ship', -2, 99, 'legacy ship', 'legacy-worker', now(), 'legacy:ship:99');
    update inventory set stock_qty = stock_qty - 2 where id = 1;
    commit;
  `);
  const legacy = await client.query<{
    source_entity: string;
    source_id: string;
  }>(`select source_entity, source_id from inventory_ledger where idempotency_key = 'legacy:ship:99'`);
  assert.deepEqual(legacy.rows[0], {
    source_entity: 'legacy_inventory_runtime',
    source_id: 'legacy:ship:99',
  });

  await client.exec(`
    begin;
    insert into inventory_ledger (
      inventory_id, type, qty, note, created_by, effective_at
    ) values (2, 'adjust', 4, 'Opening stock', 'manual', now());
    update inventory set stock_qty = stock_qty + 4 where id = 2;
    commit;
  `);
  const opening = await client.query<{ idempotency_key: string }>(
    `select idempotency_key from inventory_ledger where inventory_id = 2`,
  );
  assert.equal(opening.rows[0]?.idempotency_key, 'inventory:opening:inventory:2');

  await assert.rejects(
    () => client.exec(`insert into inventory_ledger (
      inventory_id, type, qty, note, created_by, effective_at
    ) values (2, 'adjust', 1, 'unidentified legacy adjustment', 'manual', now())`),
    /PS462_INVENTORY_MOVEMENT_IDENTITY_REQUIRED/,
    'unidentified legacy movements still fail closed',
  );
  await assert.rejects(
    () => client.exec(`update inventory_ledger set qty = 999 where id = 1`),
    /PS439_INVENTORY_LEDGER_IMMUTABLE/,
  );
  await assert.rejects(
    () => client.exec(`delete from inventory_ledger where id = 1`),
    /PS439_INVENTORY_LEDGER_IMMUTABLE/,
  );
  await assert.rejects(
    () => client.exec(`truncate inventory_ledger`),
    /PS439_INVENTORY_LEDGER_IMMUTABLE/,
  );

  assert.equal(
    await scalar(client, `select count(*)::int as value
      from inventory item
      left join (
        select inventory_id, coalesce(sum(qty), 0)::int as quantity
        from inventory_ledger group by inventory_id
      ) ledger on ledger.inventory_id = item.id
      where item.stock_qty is distinct from coalesce(ledger.quantity, 0)`),
    0,
    'the prior runtime write shape and compatibility cache remain ledger-equal',
  );

  await client.close();
  console.log('PASS PS-462 inventory forward-rollback migrated-database integration');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
