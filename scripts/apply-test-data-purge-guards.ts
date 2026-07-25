#!/usr/bin/env tsx
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const CONFIRMATION = 'apply-test-data-purge-guards-0082';
const MIGRATION_PATH = 'drizzle/0082_test_data_purge_guards.sql';

type GuardState = {
  enabled_guard: boolean;
  client_guard: boolean;
  order_guard: boolean;
  inventory_owner_guard: boolean;
  shipment_guard: boolean;
  inventory_guard: boolean;
  lifecycle_guard: boolean;
  hazmat_guard: boolean;
  billing_adjustment_guard: boolean;
  billing_period_guard: boolean;
  billing_close_guard: boolean;
};

type ProtectedSnapshot = {
  order_count: string;
  order_id_sum: string;
  shipment_count: string;
  shipment_id_sum: string;
  inventory_ledger_count: string;
  billing_line_count: string;
};

function approved(): boolean {
  return process.argv.includes('--apply') && process.argv.includes(`--confirm=${CONFIRMATION}`);
}

function ready(state: GuardState): boolean {
  return Object.values(state).every(Boolean);
}

function assertMigrationSafety(source: string): void {
  const forbidden = [
    /\binsert\s+into\s+(?:public\.)?(?:orders|shipments|inventory_ledger|billing_line_items)\b/i,
    /\bupdate\s+(?:public\.)?(?:orders|shipments|inventory_ledger|billing_line_items)\s+set\b/i,
    /\bdelete\s+from\s+(?:public\.)?(?:orders|shipments|inventory_ledger|billing_line_items)\b/i,
    /\btruncate\b/i,
    /\balter\s+table\b/i,
    /\bdrop\s+(?:table|column|trigger)\b/i,
    /\bdisable\s+trigger\b/i,
  ];
  if (forbidden.some((pattern) => pattern.test(source))) {
    throw new Error('Migration refused: 0082 contains destructive or protected-table DML');
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const client = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: 'test-data-purge-guards-0082' },
  });

  const inspect = async (): Promise<GuardState> => {
    const [state] = await client<GuardState[]>`
      select
        to_regprocedure('public.test_data_purge_enabled()') is not null as enabled_guard,
        to_regprocedure('public.test_data_purge_client_allowed(integer)') is not null as client_guard,
        to_regprocedure('public.test_data_purge_order_allowed(integer)') is not null as order_guard,
        to_regprocedure('public.test_data_purge_inventory_allowed(integer)') is not null as inventory_owner_guard,
        to_regprocedure('public.test_data_purge_shipment_allowed(integer)') is not null as shipment_guard,
        coalesce(position('test_data_purge' in pg_get_functiondef(to_regprocedure('public.inventory_ledger_block_mutations()'))) > 0, false) as inventory_guard,
        coalesce(position('test_data_purge' in pg_get_functiondef(to_regprocedure('public.order_lifecycle_events_block_mutations()'))) > 0, false) as lifecycle_guard,
        coalesce(position('test_data_purge' in pg_get_functiondef(to_regprocedure('public.shipment_hazmat_snapshots_block_mutations()'))) > 0, false) as hazmat_guard,
        coalesce(position('test_data_purge' in pg_get_functiondef(to_regprocedure('public.billing_line_items_block_adjustment_mutation()'))) > 0, false) as billing_adjustment_guard,
        coalesce(position('test_data_purge' in pg_get_functiondef(to_regprocedure('public.billing_line_items_block_closed_period_mutation()'))) > 0, false) as billing_period_guard,
        coalesce(position('test_data_purge' in pg_get_functiondef(to_regprocedure('public.billing_close_records_block_mutations()'))) > 0, false) as billing_close_guard
    `;
    if (!state) throw new Error('Test-data purge guard inspection returned no row');
    return state;
  };

  const snapshot = async (): Promise<ProtectedSnapshot> => {
    const [state] = await client<ProtectedSnapshot[]>`
      select
        (select count(*)::text from public.orders) as order_count,
        (select coalesce(sum(id), 0)::text from public.orders) as order_id_sum,
        (select count(*)::text from public.shipments) as shipment_count,
        (select coalesce(sum(id), 0)::text from public.shipments) as shipment_id_sum,
        (select count(*)::text from public.inventory_ledger) as inventory_ledger_count,
        (select count(*)::text from public.billing_line_items) as billing_line_count
    `;
    if (!state) throw new Error('Protected data snapshot returned no row');
    return state;
  };

  try {
    const beforeState = await inspect();
    console.log(`[test-data-purge-migration] current=${JSON.stringify(beforeState)}`);
    if (ready(beforeState)) {
      console.log('[test-data-purge-migration] already_applied=true');
      return;
    }
    if (!approved()) {
      console.log(
        `[test-data-purge-migration] DRY RUN: pass --apply --confirm=${CONFIRMATION} to apply 0082`,
      );
      return;
    }

    const migration = readFileSync(MIGRATION_PATH, 'utf8');
    assertMigrationSafety(migration);
    const beforeProtected = await snapshot();

    await client.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('test-data-purge-guards-0082'))`;
      await tx.unsafe(migration);
    });

    const afterState = await inspect();
    if (!ready(afterState)) {
      throw new Error(`0082 verification failed: ${JSON.stringify(afterState)}`);
    }
    const afterProtected = await snapshot();
    if (JSON.stringify(beforeProtected) !== JSON.stringify(afterProtected)) {
      throw new Error('0082 verification failed: protected row counts changed');
    }

    console.log(`[test-data-purge-migration] applied=${JSON.stringify(afterState)}`);
    console.log('[test-data-purge-migration] protected_rows_unchanged=true');
    console.log('[test-data-purge-migration] labels_postage_provider_calls=0');
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error('[test-data-purge-migration] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
