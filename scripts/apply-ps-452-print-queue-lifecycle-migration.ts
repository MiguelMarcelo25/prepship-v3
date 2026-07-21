#!/usr/bin/env tsx
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const CONFIRMATION = 'apply-ps-452-print-queue-fences-0073';
const migrationPath = 'drizzle/0073_print_queue_send_execution_fences.sql';
// Per user override unlock shipped data on 2026-07-21: this script may apply
// only the PS-452 Print Queue sidecar migration after explicit confirmation.

type SchemaState = {
  generation_column: boolean;
  chunk_sequence_column: boolean;
  snapshot_updated_column: boolean;
  claimed_column: boolean;
  heartbeat_column: boolean;
  cancel_requested_column: boolean;
  cancel_acknowledged_column: boolean;
  item_attempt_column: boolean;
  item_generation_column: boolean;
  parent_generation_constraint: boolean;
  parent_chunk_constraint: boolean;
  item_attempt_constraint: boolean;
  item_generation_constraint: boolean;
  recovery_index: boolean;
};

function approved(): boolean {
  return process.argv.includes('--apply') && process.argv.includes(`--confirm=${CONFIRMATION}`);
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
    connection: { application_name: 'ps-452-migration-0073' },
  });

  const inspect = async (): Promise<SchemaState> => {
    const [state] = await client<SchemaState[]>`
      select
        exists (
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'print_queue_send_jobs'
            and column_name = 'generation'
        ) as generation_column,
        exists (
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'print_queue_send_jobs'
            and column_name = 'current_chunk_sequence'
        ) as chunk_sequence_column,
        exists (
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'print_queue_send_jobs'
            and column_name = 'snapshot_updated_at'
        ) as snapshot_updated_column,
        exists (
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'print_queue_send_jobs'
            and column_name = 'claimed_at'
        ) as claimed_column,
        exists (
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'print_queue_send_jobs'
            and column_name = 'heartbeat_at'
        ) as heartbeat_column,
        exists (
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'print_queue_send_jobs'
            and column_name = 'cancel_requested_at'
        ) as cancel_requested_column,
        exists (
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'print_queue_send_jobs'
            and column_name = 'cancel_acknowledged_at'
        ) as cancel_acknowledged_column,
        exists (
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'print_queue_batch_job_items'
            and column_name = 'attempt_count'
        ) as item_attempt_column,
        exists (
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'print_queue_batch_job_items'
            and column_name = 'generation'
        ) as item_generation_column,
        exists (
          select 1 from pg_constraint
          where conname = 'print_queue_send_jobs_generation_nonnegative'
            and conrelid = 'public.print_queue_send_jobs'::regclass
        ) as parent_generation_constraint,
        exists (
          select 1 from pg_constraint
          where conname = 'print_queue_send_jobs_chunk_sequence_positive'
            and conrelid = 'public.print_queue_send_jobs'::regclass
        ) as parent_chunk_constraint,
        exists (
          select 1 from pg_constraint
          where conname = 'print_queue_batch_job_items_attempt_count_nonnegative'
            and conrelid = 'public.print_queue_batch_job_items'::regclass
        ) as item_attempt_constraint,
        exists (
          select 1 from pg_constraint
          where conname = 'print_queue_batch_job_items_generation_nonnegative'
            and conrelid = 'public.print_queue_batch_job_items'::regclass
        ) as item_generation_constraint,
        to_regclass('public.print_queue_send_jobs_recovery_idx') is not null as recovery_index
    `;
    if (!state) throw new Error('PS-452 schema inspection returned no row');
    return state;
  };

  try {
    const before = await inspect();
    console.log(`[ps-452-migration] current=${JSON.stringify(before)}`);
    if (ready(before)) {
      console.log('[ps-452-migration] already_applied=true');
      return;
    }
    if (!approved()) {
      console.log(
        `[ps-452-migration] DRY RUN: pass --apply --confirm=${CONFIRMATION} to apply ${migrationPath}`,
      );
      return;
    }

    const migration = readFileSync(migrationPath, 'utf8');
    if (/\b(?:alter|update|delete|truncate|insert)\s+(?:table\s+|from\s+|into\s+)?(?:public\.)?(?:orders|shipments)\b/i.test(migration)) {
      throw new Error('Migration refused: orders/shipments mutation detected');
    }
    if (/\bdrop\s+(?:table|column|index)\b/i.test(migration)) {
      throw new Error('Migration refused: destructive DROP detected');
    }

    await client.begin(async (tx) => {
      await tx.unsafe(migration);
    });

    const after = await inspect();
    if (!ready(after)) {
      throw new Error(`PS-452 migration verification failed: ${JSON.stringify(after)}`);
    }
    console.log(`[ps-452-migration] applied=${JSON.stringify(after)}`);
    console.log('[ps-452-migration] orders_shipments_unchanged=true');
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error('[ps-452-migration] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
