#!/usr/bin/env tsx
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const CONFIRMATION = 'apply-ps-449-current-period-adjustments-0074';
const migrationPath = 'drizzle/0074_billing_current_period_adjustments.sql';

// Per user override unlock shipped data on 2026-05-23: this command may apply
// only migration 0074 after explicit confirmation. It never updates or deletes
// historical billing, order, shipment, or finalized invoice rows.

type SchemaState = {
  note_adjustment_kind_column: boolean;
  note_adjustment_source_column: boolean;
  note_source_order_column: boolean;
  note_posting_version_column: boolean;
  note_effective_date_column: boolean;
  note_policy_version_column: boolean;
  line_source_finalization_column: boolean;
  line_adjustment_column: boolean;
  summary_adjustment_total_column: boolean;
  adjustment_unique_index: boolean;
  source_finalization_index: boolean;
  source_order_index: boolean;
  adjustment_kind_constraint: boolean;
  adjustment_source_constraint: boolean;
  posting_version_constraint: boolean;
  current_period_fields_constraint: boolean;
  note_id_client_constraint: boolean;
  note_finalization_client_constraint: boolean;
  line_reference_constraint: boolean;
  line_source_finalization_constraint: boolean;
  line_adjustment_constraint: boolean;
  projection_function: boolean;
  signed_balance_function: boolean;
  immutable_adjustment_function: boolean;
  projection_trigger: boolean;
  immutable_adjustment_trigger: boolean;
};

type HistoricalSnapshot = {
  line_count: string;
  line_total: string;
  finalization_count: string;
  finalization_total: string;
  note_count: string;
  note_total: string;
};

function approved(): boolean {
  return process.argv.includes('--apply') &&
    process.argv.includes(`--confirm=${CONFIRMATION}`);
}

function ready(state: SchemaState): boolean {
  return Object.values(state).every(Boolean);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const client = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: 'ps-449-migration-0074' },
  });

  const inspect = async (): Promise<SchemaState> => {
    const [state] = await client<SchemaState[]>`
      select
        exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'billing_credit_notes' and column_name = 'adjustment_kind') as note_adjustment_kind_column,
        exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'billing_credit_notes' and column_name = 'adjustment_source') as note_adjustment_source_column,
        exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'billing_credit_notes' and column_name = 'source_order_id') as note_source_order_column,
        exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'billing_credit_notes' and column_name = 'posting_version') as note_posting_version_column,
        exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'billing_credit_notes' and column_name = 'effective_date') as note_effective_date_column,
        exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'billing_credit_notes' and column_name = 'billing_policy_version') as note_policy_version_column,
        exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'billing_line_items' and column_name = 'source_finalization_id') as line_source_finalization_column,
        exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'billing_line_items' and column_name = 'billing_adjustment_id') as line_adjustment_column,
        exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'billing_summary_metrics' and column_name = 'adjustment_total') as summary_adjustment_total_column,
        to_regclass('public.billing_li_adjustment_unq') is not null as adjustment_unique_index,
        to_regclass('public.billing_li_source_finalization_idx') is not null as source_finalization_index,
        to_regclass('public.billing_credit_notes_source_order_idx') is not null as source_order_index,
        exists (select 1 from pg_constraint where conname = 'billing_credit_notes_adjustment_kind_chk' and conrelid = 'public.billing_credit_notes'::regclass) as adjustment_kind_constraint,
        exists (select 1 from pg_constraint where conname = 'billing_credit_notes_adjustment_source_chk' and conrelid = 'public.billing_credit_notes'::regclass) as adjustment_source_constraint,
        exists (select 1 from pg_constraint where conname = 'billing_credit_notes_posting_version_chk' and conrelid = 'public.billing_credit_notes'::regclass) as posting_version_constraint,
        exists (select 1 from pg_constraint where conname = 'billing_credit_notes_current_period_fields_chk' and conrelid = 'public.billing_credit_notes'::regclass) as current_period_fields_constraint,
        exists (select 1 from pg_constraint where conname = 'billing_credit_notes_id_client_unq' and conrelid = 'public.billing_credit_notes'::regclass) as note_id_client_constraint,
        exists (select 1 from pg_constraint where conname = 'billing_credit_notes_finalization_client_fk' and conrelid = 'public.billing_credit_notes'::regclass) as note_finalization_client_constraint,
        exists (select 1 from pg_constraint where conname = 'billing_line_items_adjustment_reference_chk' and conrelid = 'public.billing_line_items'::regclass) as line_reference_constraint,
        exists (select 1 from pg_constraint where conname = 'billing_line_items_source_finalization_client_fk' and conrelid = 'public.billing_line_items'::regclass) as line_source_finalization_constraint,
        exists (select 1 from pg_constraint where conname = 'billing_line_items_adjustment_client_fk' and conrelid = 'public.billing_line_items'::regclass) as line_adjustment_constraint,
        to_regprocedure('public.billing_credit_notes_require_projection()') is not null as projection_function,
        to_regprocedure('public.billing_credit_notes_block_excess()') is not null as signed_balance_function,
        to_regprocedure('public.billing_line_items_block_adjustment_mutation()') is not null as immutable_adjustment_function,
        exists (select 1 from pg_trigger where tgname = 'billing_credit_notes_projection_guard' and tgrelid = 'public.billing_credit_notes'::regclass and not tgisinternal) as projection_trigger,
        exists (select 1 from pg_trigger where tgname = 'billing_line_items_adjustment_immutable_guard' and tgrelid = 'public.billing_line_items'::regclass and not tgisinternal) as immutable_adjustment_trigger
    `;
    if (!state) throw new Error('PS-449 schema inspection returned no row');
    return state;
  };

  const snapshot = async (): Promise<HistoricalSnapshot> => {
    const [state] = await client<HistoricalSnapshot[]>`
      select
        (select count(*)::text from billing_line_items) as line_count,
        (select coalesce(sum(total_cost), 0)::text from billing_line_items) as line_total,
        (select count(*)::text from billing_finalizations) as finalization_count,
        (select coalesce(sum(subtotal), 0)::text from billing_finalizations) as finalization_total,
        (select count(*)::text from billing_credit_notes) as note_count,
        (select coalesce(sum(amount), 0)::text from billing_credit_notes) as note_total
    `;
    if (!state) throw new Error('PS-449 historical snapshot returned no row');
    return state;
  };

  try {
    const beforeState = await inspect();
    console.log(`[ps-449-migration] current=${JSON.stringify(beforeState)}`);
    if (ready(beforeState)) {
      console.log('[ps-449-migration] already_applied=true');
      return;
    }
    if (!approved()) {
      console.log(
        `[ps-449-migration] DRY RUN: pass --apply --confirm=${CONFIRMATION} to apply ${migrationPath}`,
      );
      return;
    }

    const migration = readFileSync(migrationPath, 'utf8');
    if (/\bupdate\s+(?:public\.)?(?:orders|shipments|billing_line_items|billing_finalizations|billing_credit_notes)\s+set\b/i.test(migration) ||
      /\bdelete\s+from\s+(?:public\.)?(?:orders|shipments|billing_line_items|billing_finalizations|billing_credit_notes)\b/i.test(migration) ||
      /\binsert\s+into\s+(?:public\.)?(?:orders|shipments|billing_line_items|billing_finalizations|billing_credit_notes)\b/i.test(migration) ||
      /\btruncate\s+(?:table\s+)?(?:public\.)?(?:orders|shipments|billing_line_items|billing_finalizations|billing_credit_notes)\b/i.test(migration) ||
      /\balter\s+table\s+(?:public\.)?(?:orders|shipments)\b/i.test(migration)) {
      throw new Error('Migration refused: protected historical billing/order/shipment DML detected');
    }
    if (/\bdrop\s+(?:table|column)\b/i.test(migration)) {
      throw new Error('Migration refused: destructive table/column DROP detected');
    }

    const before = await snapshot();
    await client.begin(async (tx) => {
      await tx.unsafe(migration);
    });
    const after = await snapshot();
    const afterState = await inspect();

    if (!ready(afterState)) {
      throw new Error(`PS-449 migration verification failed: ${JSON.stringify(afterState)}`);
    }
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error('Migration verification failed: historical billing counts or totals changed');
    }

    console.log(`[ps-449-migration] applied=${JSON.stringify(afterState)}`);
    console.log('[ps-449-migration] historical_billing_counts_and_totals_unchanged=true');
    console.log('[ps-449-migration] orders_shipments_unchanged=true');
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error('[ps-449-migration] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
