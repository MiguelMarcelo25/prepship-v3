#!/usr/bin/env tsx
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const APPLY_CONFIRMATION = 'apply-ps-462-inventory-preparation-0073';
const ROLLBACK_CONFIRMATION = 'rollback-ps-462-inventory-preparation-0073';
const MAINTENANCE_CONFIRMATION = 'api-workers-stopped-inventory-auto-deduct-disabled';
const migrationPath = 'drizzle/0073_inventory_quantity_sot.sql';
const rollbackPath = 'ops/rollback/ps-462_inventory_preparation_compatibility_rollback.sql';

type SqlLike = Pick<postgres.Sql, 'unsafe'>;

type SchemaState = {
  identity_columns: boolean;
  nonzero_constraint: boolean;
  insert_guard: boolean;
  update_delete_guard: boolean;
  truncate_guard: boolean;
  source_identity_index: boolean;
  legacy_stock_column: boolean;
};

type DataSnapshot = {
  inventory_rows: string;
  ledger_rows: string;
  ledger_quantity: string;
  zero_quantity_rows: string;
  incomplete_identity_rows: string;
};

const schemaQuery = `
  select
    (
      select count(*) = 4 from information_schema.columns
      where table_schema = 'public'
        and table_name = 'inventory_ledger'
        and column_name in ('client_id', 'sku', 'source_entity', 'source_id')
    ) as identity_columns,
    exists (
      select 1 from pg_constraint
      where conname = 'inventory_ledger_nonzero_qty_chk'
        and conrelid = to_regclass('public.inventory_ledger')
    ) as nonzero_constraint,
    exists (
      select 1 from pg_trigger
      where tgrelid = to_regclass('public.inventory_ledger')
        and tgname = 'inventory_ledger_prepare_insert_guard'
        and not tgisinternal and tgenabled <> 'D'
    ) as insert_guard,
    exists (
      select 1 from pg_trigger
      where tgrelid = to_regclass('public.inventory_ledger')
        and tgname = 'inventory_ledger_no_update_delete'
        and not tgisinternal and tgenabled <> 'D'
    ) as update_delete_guard,
    exists (
      select 1 from pg_trigger
      where tgrelid = to_regclass('public.inventory_ledger')
        and tgname = 'inventory_ledger_no_truncate'
        and not tgisinternal and tgenabled <> 'D'
    ) as truncate_guard,
    to_regclass('public.inventory_ledger_source_identity_unq') is not null
      as source_identity_index,
    exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'inventory' and column_name = 'stock_qty'
    ) as legacy_stock_column
`;

const snapshotQueryWithIdentity = `
  select
    (select count(*)::text from public.inventory) as inventory_rows,
    count(*)::text as ledger_rows,
    coalesce(sum(qty), 0)::text as ledger_quantity,
    count(*) filter (where qty = 0)::text as zero_quantity_rows,
    count(*) filter (
      where nullif(btrim(created_by), '') is null
         or effective_at is null
         or nullif(btrim(idempotency_key), '') is null
         or (
           exists (
             select 1 from information_schema.columns
             where table_schema = 'public'
               and table_name = 'inventory_ledger'
               and column_name = 'source_entity'
           )
           and (nullif(btrim(source_entity), '') is null or nullif(btrim(source_id), '') is null)
         )
    )::text as incomplete_identity_rows
  from public.inventory_ledger
`;

const snapshotQueryWithoutIdentity = `
  select
    (select count(*)::text from public.inventory) as inventory_rows,
    count(*)::text as ledger_rows,
    coalesce(sum(qty), 0)::text as ledger_quantity,
    count(*) filter (where qty = 0)::text as zero_quantity_rows,
    count(*)::text as incomplete_identity_rows
  from public.inventory_ledger
`;

function mode(): 'check' | 'apply' | 'rollback' {
  const apply = process.argv.includes('--apply');
  const rollback = process.argv.includes('--rollback-compatibility');
  if (apply && rollback) throw new Error('Choose either --apply or --rollback-compatibility, not both');
  return apply ? 'apply' : rollback ? 'rollback' : 'check';
}

function hasMaintenanceConfirmation(): boolean {
  return process.argv.includes(`--maintenance-confirm=${MAINTENANCE_CONFIRMATION}`);
}

function approvedForApply(): boolean {
  return process.argv.includes(`--confirm=${APPLY_CONFIRMATION}`) && hasMaintenanceConfirmation();
}

function approvedForRollback(): boolean {
  return process.argv.includes(`--confirm=${ROLLBACK_CONFIRMATION}`) && hasMaintenanceConfirmation();
}

function validateSql(sql: string, expectedTicket: string): void {
  if (!sql.includes(expectedTicket)) throw new Error(`SQL refused: missing ${expectedTicket} identity`);
  if (/^\s*(?:insert|update|delete|truncate)\b/im.test(sql)) {
    throw new Error('SQL refused: data mutation statement detected');
  }
  if (/\bdrop\s+(?:table|column)\b/i.test(sql)) {
    throw new Error('SQL refused: destructive table/column DROP detected');
  }
  if (/\b(?:public\.)?(?:orders|shipments)\b/i.test(sql)) {
    throw new Error('SQL refused: orders/shipments surface detected');
  }
}

function schemaReady(state: SchemaState): boolean {
  return state.identity_columns
    && state.nonzero_constraint
    && state.insert_guard
    && state.update_delete_guard
    && state.truncate_guard
    && state.source_identity_index
    && state.legacy_stock_column;
}

function compatibilityRollbackReady(state: SchemaState): boolean {
  return state.identity_columns
    && state.nonzero_constraint
    && !state.insert_guard
    && state.update_delete_guard
    && state.truncate_guard
    && state.source_identity_index
    && state.legacy_stock_column;
}

async function inspect(sql: SqlLike): Promise<SchemaState> {
  const rows = await sql.unsafe<SchemaState[]>(schemaQuery);
  const state = rows[0];
  if (!state) throw new Error('PS-462 schema inspection returned no row');
  return state;
}

async function snapshot(sql: SqlLike, state: SchemaState): Promise<DataSnapshot> {
  const query = state.identity_columns ? snapshotQueryWithIdentity : snapshotQueryWithoutIdentity;
  const rows = await sql.unsafe<DataSnapshot[]>(query);
  const result = rows[0];
  if (!result) throw new Error('PS-462 data snapshot returned no row');
  return result;
}

function assertDataUnchanged(before: DataSnapshot, after: DataSnapshot): void {
  const invariantBefore = {
    inventory_rows: before.inventory_rows,
    ledger_rows: before.ledger_rows,
    ledger_quantity: before.ledger_quantity,
    zero_quantity_rows: before.zero_quantity_rows,
  };
  const invariantAfter = {
    inventory_rows: after.inventory_rows,
    ledger_rows: after.ledger_rows,
    ledger_quantity: after.ledger_quantity,
    zero_quantity_rows: after.zero_quantity_rows,
  };
  if (JSON.stringify(invariantBefore) !== JSON.stringify(invariantAfter)) {
    throw new Error(`PS462_PREPARATION_DATA_CHANGED: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  }
}

async function main(): Promise<void> {
  const selectedMode = mode();
  if (selectedMode === 'apply' && !approvedForApply()) {
    throw new Error(
      `Apply refused: require --confirm=${APPLY_CONFIRMATION} `
      + `--maintenance-confirm=${MAINTENANCE_CONFIRMATION}`,
    );
  }
  if (selectedMode === 'rollback' && !approvedForRollback()) {
    throw new Error(
      `Rollback refused: require --confirm=${ROLLBACK_CONFIRMATION} `
      + `--maintenance-confirm=${MAINTENANCE_CONFIRMATION}`,
    );
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const client = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: 'ps-462-inventory-preparation-operator' },
  });

  try {
    const before = await client.begin(async (tx) => {
      await tx.unsafe('set transaction read only');
      const schema = await inspect(tx);
      return { schema, data: await snapshot(tx, schema) };
    });
    console.log(`[ps-462-preparation] mode=${selectedMode} current=${JSON.stringify(before)}`);

    if (selectedMode === 'check') {
      console.log(
        `[ps-462-preparation] READ ONLY: use --apply --confirm=${APPLY_CONFIRMATION} `
        + `--maintenance-confirm=${MAINTENANCE_CONFIRMATION} only during the approved maintenance window`,
      );
      return;
    }
    if (selectedMode === 'apply' && schemaReady(before.schema)) {
      console.log('[ps-462-preparation] already_applied=true; no SQL executed');
      return;
    }
    if (selectedMode === 'rollback' && compatibilityRollbackReady(before.schema)) {
      console.log('[ps-462-preparation] compatibility_rollback_already_applied=true; no SQL executed');
      return;
    }

    const sqlPath = selectedMode === 'apply' ? migrationPath : rollbackPath;
    const sql = readFileSync(sqlPath, 'utf8');
    validateSql(sql, 'PS-462');

    const after = await client.begin(async (tx) => {
      await tx.unsafe("set local lock_timeout = '5s'");
      await tx.unsafe("set local statement_timeout = '60s'");
      const schemaBefore = await inspect(tx);
      const dataBefore = await snapshot(tx, schemaBefore);
      await tx.unsafe(sql);
      const schemaAfter = await inspect(tx);
      const dataAfter = await snapshot(tx, schemaAfter);
      assertDataUnchanged(dataBefore, dataAfter);
      return { schema: schemaAfter, data: dataAfter };
    });

    if (selectedMode === 'apply' && !schemaReady(after.schema)) {
      throw new Error(`PS462_PREPARATION_VERIFY_FAILED: ${JSON.stringify(after.schema)}`);
    }
    if (selectedMode === 'rollback' && !compatibilityRollbackReady(after.schema)) {
      throw new Error(`PS462_PREPARATION_ROLLBACK_VERIFY_FAILED: ${JSON.stringify(after.schema)}`);
    }
    assertDataUnchanged(before.data, after.data);
    console.log(`[ps-462-preparation] completed=${JSON.stringify(after)}`);
    console.log('[ps-462-preparation] inventory_and_ledger_data_unchanged=true');
  } finally {
    await client.end({ timeout: 5 });
  }
}

void main().catch((error) => {
  console.error('[ps-462-preparation] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
