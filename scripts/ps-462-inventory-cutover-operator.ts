#!/usr/bin/env tsx
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const APPLY_CONFIRMATION = 'apply-ps-462-inventory-cutover-0076';
const MAINTENANCE_CONFIRMATION = 'api-workers-stopped-inventory-auto-deduct-disabled';
const ROLLBACK_CONFIRMATION = 'forward-rollback-reviewed';
const migrationPath = 'drizzle/0076_inventory_quantity_cutover.sql';

type SqlLike = Pick<postgres.Sql, 'unsafe'>;

type CutoverState = {
  identity_columns: boolean;
  nonzero_constraint: boolean;
  insert_guard: boolean;
  update_delete_guard: boolean;
  truncate_guard: boolean;
  idempotency_index: boolean;
  source_identity_index: boolean;
  legacy_stock_column: boolean;
  risk_stock_column: boolean;
  risk_effective_stock_column: boolean;
  mismatch_rows: string;
  zero_quantity_rows: string;
};

type Snapshot = {
  inventory_rows: string;
  ledger_rows: string;
  ledger_quantity: string;
};

const stateQuery = `
  select
    (select count(*) = 4 from information_schema.columns
      where table_schema = 'public' and table_name = 'inventory_ledger'
        and column_name in ('client_id', 'sku', 'source_entity', 'source_id')) as identity_columns,
    exists (select 1 from pg_constraint where conrelid = to_regclass('public.inventory_ledger')
      and conname = 'inventory_ledger_nonzero_qty_chk') as nonzero_constraint,
    exists (select 1 from pg_trigger where tgrelid = to_regclass('public.inventory_ledger')
      and tgname = 'inventory_ledger_prepare_insert_guard' and not tgisinternal and tgenabled <> 'D') as insert_guard,
    exists (select 1 from pg_trigger where tgrelid = to_regclass('public.inventory_ledger')
      and tgname = 'inventory_ledger_no_update_delete' and not tgisinternal and tgenabled <> 'D') as update_delete_guard,
    exists (select 1 from pg_trigger where tgrelid = to_regclass('public.inventory_ledger')
      and tgname = 'inventory_ledger_no_truncate' and not tgisinternal and tgenabled <> 'D') as truncate_guard,
    to_regclass('public.inventory_ledger_idempotency_key_unq') is not null as idempotency_index,
    to_regclass('public.inventory_ledger_source_identity_unq') is not null as source_identity_index,
    exists (select 1 from information_schema.columns where table_schema = 'public'
      and table_name = 'inventory' and column_name = 'stock_qty') as legacy_stock_column,
    exists (select 1 from information_schema.columns where table_schema = 'public'
      and table_name = 'inventory_risk_metrics' and column_name = 'stock_qty') as risk_stock_column,
    exists (select 1 from information_schema.columns where table_schema = 'public'
      and table_name = 'inventory_risk_metrics' and column_name = 'effective_stock') as risk_effective_stock_column,
    case when exists (select 1 from information_schema.columns where table_schema = 'public'
      and table_name = 'inventory' and column_name = 'stock_qty') then (
        select count(*)::text from public.inventory item
        left join (
          select inventory_id, coalesce(sum(qty), 0)::int as quantity
          from public.inventory_ledger group by inventory_id
        ) ledger on ledger.inventory_id = item.id
        where (to_jsonb(item)->>'stock_qty')::int is distinct from coalesce(ledger.quantity, 0)
      ) else '0' end as mismatch_rows,
    (select count(*)::text from public.inventory_ledger where qty = 0) as zero_quantity_rows
`;

const snapshotQuery = `
  select
    (select count(*)::text from public.inventory) as inventory_rows,
    count(*)::text as ledger_rows,
    coalesce(sum(qty), 0)::text as ledger_quantity
  from public.inventory_ledger
`;

async function inspect(sql: SqlLike): Promise<CutoverState> {
  const [state] = await sql.unsafe<CutoverState[]>(stateQuery);
  if (!state) throw new Error('PS462_CUTOVER_INSPECTION_EMPTY');
  return state;
}

async function snapshot(sql: SqlLike): Promise<Snapshot> {
  const [state] = await sql.unsafe<Snapshot[]>(snapshotQuery);
  if (!state) throw new Error('PS462_CUTOVER_SNAPSHOT_EMPTY');
  return state;
}

function phaseOneReady(state: CutoverState): boolean {
  return state.identity_columns
    && state.nonzero_constraint
    && state.insert_guard
    && state.update_delete_guard
    && state.truncate_guard
    && state.idempotency_index
    && state.source_identity_index
    && state.legacy_stock_column;
}

function cutoverReady(state: CutoverState): boolean {
  return phaseOneReady(state)
    && Number(state.mismatch_rows) === 0
    && Number(state.zero_quantity_rows) === 0;
}

function validateMigration(migration: string): void {
  if (!migration.includes('PS-462 phase 2')) throw new Error('PS462_CUTOVER_SQL_IDENTITY_MISSING');
  if (!migration.includes('0075_inventory_quantity_sot.sql')) {
    throw new Error('PS462_CUTOVER_SQL_PHASE_ONE_GUARD_MISSING');
  }
  if (!migration.includes('DROP COLUMN IF EXISTS stock_qty')) {
    throw new Error('PS462_CUTOVER_SQL_STOCK_DROP_MISSING');
  }
  if (/\b(?:insert|update|delete|truncate)\b/i.test(migration)) {
    throw new Error('PS462_CUTOVER_SQL_DATA_MUTATION_DETECTED');
  }
  if (/\b(?:orders|shipments)\b/i.test(migration)) {
    throw new Error('PS462_CUTOVER_SQL_PROTECTED_SURFACE_DETECTED');
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const migration = readFileSync(migrationPath, 'utf8');
  validateMigration(migration);
  const client = postgres(databaseUrl, { max: 1 });
  try {
    const apply = process.argv.includes('--apply');
    if (!apply) {
      const result = await client.begin(async (tx) => {
        await tx.unsafe('set transaction read only');
        const state = await inspect(tx);
        return { state, snapshot: await snapshot(tx) };
      });
      console.log(JSON.stringify({
        mode: 'READ_ONLY_PREFLIGHT',
        productionMutation: false,
        ready: cutoverReady(result.state),
        ...result,
      }, null, 2));
      return;
    }

    if (!process.argv.includes(`--confirm=${APPLY_CONFIRMATION}`)) {
      throw new Error('PS462_CUTOVER_EXACT_CONFIRMATION_REQUIRED');
    }
    if (!process.argv.includes(`--maintenance-confirm=${MAINTENANCE_CONFIRMATION}`)) {
      throw new Error('PS462_CUTOVER_MAINTENANCE_CONFIRMATION_REQUIRED');
    }
    if (!process.argv.includes(`--rollback-confirm=${ROLLBACK_CONFIRMATION}`)) {
      throw new Error('PS462_CUTOVER_ROLLBACK_CONFIRMATION_REQUIRED');
    }

    const result = await client.begin(async (tx) => {
      await tx.unsafe("set local lock_timeout = '5s'");
      await tx.unsafe("set local statement_timeout = '60s'");
      await tx.unsafe('lock table public.inventory in share row exclusive mode');
      await tx.unsafe('lock table public.inventory_ledger in share row exclusive mode');
      const beforeState = await inspect(tx);
      if (!cutoverReady(beforeState)) throw new Error('PS462_CUTOVER_PREFLIGHT_BLOCKED');
      const before = await snapshot(tx);

      await tx.unsafe(migration);

      const afterState = await inspect(tx);
      const after = await snapshot(tx);
      if (afterState.legacy_stock_column
        || afterState.risk_stock_column
        || afterState.risk_effective_stock_column) {
        throw new Error('PS462_CUTOVER_LEGACY_COLUMNS_REMAIN');
      }
      if (!afterState.identity_columns
        || !afterState.nonzero_constraint
        || !afterState.insert_guard
        || !afterState.update_delete_guard
        || !afterState.truncate_guard
        || !afterState.idempotency_index
        || !afterState.source_identity_index) {
        throw new Error('PS462_CUTOVER_LEDGER_GUARDS_LOST');
      }
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        throw new Error('PS462_CUTOVER_DATA_SNAPSHOT_CHANGED');
      }
      return { before, after, state: afterState };
    });
    console.log(JSON.stringify({ mode: 'APPLIED', productionMutation: true, ...result }, null, 2));
  } finally {
    await client.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
