/**
 * PS-427 behavioral integration proof. Uses only an in-memory PGlite database.
 * It never connects to production, calls providers, or mutates real inventory/orders.
 */
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';

process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
process.env.SUPABASE_URL = 'https://example.test';
process.env.SUPABASE_ANON_KEY = 'test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
process.env.SUPABASE_JWT_SECRET = 'test';
process.env.NODE_ENV = 'test';

type TestDatabase = ReturnType<typeof drizzle>;

async function scalar(database: TestDatabase, query: ReturnType<typeof sql>): Promise<number> {
  const result = await database.execute<{ value: number | string }>(query);
  const rows = Array.isArray(result) ? result : result.rows;
  return Number(rows[0]?.value ?? 0);
}

async function main(): Promise<void> {
  const client = new PGlite();
  const database = drizzle(client, { casing: 'snake_case' });

  await database.execute(sql`create table clients (
    id serial primary key,
    name text not null
  )`);
  await database.execute(sql`create table orders (
    id serial primary key,
    client_id integer,
    order_number text not null,
    order_status text not null
  )`);
  await database.execute(sql`create table order_items (
    id serial primary key,
    order_id integer not null,
    sku text not null,
    quantity numeric(12,3) not null default 0
  )`);
  await database.execute(sql`create table inventory (
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
    updated_at timestamptz not null default now(),
    unique (client_id, sku)
  )`);
  await database.execute(sql`create table inventory_ledger (
    id serial primary key,
    inventory_id integer not null,
    type text not null,
    qty integer not null,
    order_id integer,
    note text,
    created_by text,
    effective_at timestamptz,
    idempotency_key text unique,
    created_at timestamptz not null default now()
  )`);
  await database.execute(sql`create table audit_log (
    id serial primary key,
    ts timestamptz not null default now(),
    event_type text not null,
    actor_id text,
    actor_email text,
    resource_type text not null,
    resource_id text,
    action text not null,
    details jsonb,
    ip text
  )`);

  await database.execute(sql`insert into clients (id, name) values (1, 'One'), (2, 'Two')`);
  await database.execute(sql`insert into inventory (id, client_id, sku, stock_qty) values
    (1, 1, 'DOWN', 10),
    (2, 1, 'UP', 7),
    (3, 1, 'ZERO', 5),
    (4, 1, 'NEGATIVE', 4),
    (5, 2, 'DUP', 2),
    (6, 2, 'dup', 2),
    (7, 1, 'CONCURRENT', 10),
    (8, 1, 'AUDIT-FAIL', 9)
  `);
  await database.execute(sql`insert into inventory_ledger
    (inventory_id, type, qty, order_id, effective_at, idempotency_key) values
    (1, 'receive', 10, null, now(), 'fixture:1:receive'),
    (1, 'ship', -3, 101, now(), 'fixture:1:ship'),
    (2, 'receive', 10, null, now(), 'fixture:2:receive'),
    (3, 'adjust', 0, null, now(), 'fixture:3:zero'),
    (4, 'receive', 5, null, now(), 'fixture:4:receive'),
    (4, 'ship', -8, 104, now(), 'fixture:4:ship'),
    (5, 'receive', 2, null, now(), 'fixture:5:receive'),
    (6, 'receive', 2, null, now(), 'fixture:6:receive'),
    (7, 'receive', 7, null, now(), 'fixture:7:receive'),
    (8, 'receive', 3, null, now(), 'fixture:8:receive')
  `);

  const {
    applyInventoryReconciliationPlan,
    buildInventoryReconciliationPlan,
    INVENTORY_RECONCILIATION_CONFIRMATION,
    InventoryReconciliationError,
  } = await import('../src/services/inventory-reconciliation.js');
  const { applyInventoryMovementInTransaction } = await import('../src/services/inventory-movement.js');

  const dependencies = {
    database: database as never,
    ensureAuditReady: async () => undefined,
  };
  const actor = { actorId: 'operator-427', actorEmail: 'operator@example.test' };
  const apply = async (clientId: number, sku: string, reviewedPlanHash: string) =>
    applyInventoryReconciliationPlan({
      scope: { clientId, sku },
      reviewedPlanHash,
      confirmation: INVENTORY_RECONCILIATION_CONFIRMATION,
      reason: `PS-427 reviewed repair for ${sku}`,
      approvalReference: `DJ-APPROVAL-${sku}`,
      actor,
      applyEnabled: true,
    }, dependencies);

  const disabledPlan = await buildInventoryReconciliationPlan(
    { clientId: 1, sku: 'DOWN' },
    dependencies,
  );
  await assert.rejects(
    applyInventoryReconciliationPlan({
      scope: { clientId: 1, sku: 'DOWN' },
      reviewedPlanHash: disabledPlan.planHash,
      confirmation: INVENTORY_RECONCILIATION_CONFIRMATION,
      reason: 'PS-427 reviewed repair for DOWN',
      approvalReference: 'DJ-APPROVAL-DOWN',
      actor,
      applyEnabled: false,
    }, dependencies),
    (error: unknown) => error instanceof InventoryReconciliationError && error.code === 'APPLY_DISABLED',
  );
  assert.equal(await scalar(database, sql`select stock_qty as value from inventory where id = 1`), 10);

  const ledgerCountBefore = await scalar(database, sql`select count(*) as value from inventory_ledger`);
  const downResult = await apply(1, 'DOWN', disabledPlan.planHash);
  assert.equal(downResult.rowsAdjusted, 1);
  assert.equal(await scalar(database, sql`select stock_qty as value from inventory where id = 1`), 7);
  assert.equal(
    await scalar(database, sql`select count(*) as value from inventory_ledger`),
    ledgerCountBefore,
    'reconciliation must not manufacture a ledger movement',
  );

  const auditResult = await database.execute<{
    event_type: string;
    details: Record<string, unknown>;
  }>(sql`select event_type, details from audit_log where resource_id = '1'`);
  const auditRows = Array.isArray(auditResult) ? auditResult : auditResult.rows;
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0]?.event_type, 'inventory.cache_rebuilt');
  assert.equal(auditRows[0]?.details.beforeStockQty, 10);
  assert.equal(auditRows[0]?.details.authoritativeLedgerQty, 7);
  assert.equal(auditRows[0]?.details.afterStockQty, 7);
  assert.equal(auditRows[0]?.details.rollbackStockQty, 10);

  const matchedPlan = await buildInventoryReconciliationPlan({ clientId: 1, sku: 'DOWN' }, dependencies);
  assert.equal(matchedPlan.rowsToAdjust, 0);
  await assert.rejects(
    apply(1, 'DOWN', disabledPlan.planHash),
    (error: unknown) => error instanceof InventoryReconciliationError && error.code === 'PLAN_MISMATCH',
  );
  const noop = await apply(1, 'DOWN', matchedPlan.planHash);
  assert.equal(noop.rowsAdjusted, 0, 'reviewed matching retry is idempotent');

  for (const [inventoryId, sku, expected] of [
    [2, 'UP', 10],
    [3, 'ZERO', 0],
    [4, 'NEGATIVE', -3],
  ] as const) {
    const plan = await buildInventoryReconciliationPlan({ clientId: 1, sku }, dependencies);
    assert.equal(plan.rows[0]?.authoritativeLedgerQty, expected);
    await apply(1, sku, plan.planHash);
    assert.equal(
      await scalar(database, sql`select stock_qty as value from inventory where id = ${inventoryId}`),
      expected,
    );
  }

  const duplicatePlan = await buildInventoryReconciliationPlan({ clientId: 2, sku: 'dup' }, dependencies);
  assert.equal(duplicatePlan.blocked, true);
  assert.equal(duplicatePlan.ambiguousRows.length, 2);
  await assert.rejects(
    apply(2, 'dup', duplicatePlan.planHash),
    (error: unknown) => error instanceof InventoryReconciliationError && error.code === 'AMBIGUOUS_SKU',
  );
  assert.equal(await scalar(database, sql`select sum(stock_qty) as value from inventory where client_id = 2`), 4);

  const concurrentPlan = await buildInventoryReconciliationPlan(
    { clientId: 1, sku: 'CONCURRENT' },
    dependencies,
  );
  const concurrentResults = await Promise.allSettled([
    apply(1, 'CONCURRENT', concurrentPlan.planHash),
    database.transaction((tx) => applyInventoryMovementInTransaction(tx as never, {
      inventoryId: 7,
      type: 'adjust',
      qty: -1,
      effectiveAt: new Date('2026-07-15T00:00:00Z'),
      idempotencyKey: 'ps-427:concurrent-movement',
    })),
  ]);
  assert.equal(concurrentResults[1]?.status, 'fulfilled', 'normal movement remains composable');
  const postConcurrentPlan = await buildInventoryReconciliationPlan(
    { clientId: 1, sku: 'CONCURRENT' },
    dependencies,
  );
  if (postConcurrentPlan.rowsToAdjust > 0) {
    await apply(1, 'CONCURRENT', postConcurrentPlan.planHash);
  }
  const finalConcurrentPlan = await buildInventoryReconciliationPlan(
    { clientId: 1, sku: 'CONCURRENT' },
    dependencies,
  );
  assert.equal(finalConcurrentPlan.rowsToAdjust, 0, 'retry from fresh truth converges after concurrency');
  assert.equal(
    await scalar(database, sql`select count(*) as value from inventory_ledger where inventory_id = 7`),
    2,
    'only the real concurrent movement is appended',
  );

  const auditFailurePlan = await buildInventoryReconciliationPlan(
    { clientId: 1, sku: 'AUDIT-FAIL' },
    dependencies,
  );
  const auditCountBeforeFailure = await scalar(database, sql`select count(*) as value from audit_log`);
  await database.execute(sql`alter table audit_log add constraint reject_cache_rebuild
    check (event_type <> 'inventory.cache_rebuilt' or resource_id <> '8')`);
  await assert.rejects(apply(1, 'AUDIT-FAIL', auditFailurePlan.planHash));
  assert.equal(
    await scalar(database, sql`select stock_qty as value from inventory where id = 8`),
    9,
    'failed required audit insert rolls back the cache update',
  );
  assert.equal(await scalar(database, sql`select count(*) as value from audit_log`), auditCountBeforeFailure);
  assert.equal(
    await scalar(database, sql`select count(*) as value from inventory_ledger where inventory_id = 8`),
    1,
  );

  await client.close();
  console.log('PASS PS-427 inventory reconciliation integration');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
