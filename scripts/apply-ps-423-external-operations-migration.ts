#!/usr/bin/env tsx
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const CONFIRMATION = 'apply-ps-423-external-operations-0072';
const migrationPath = 'drizzle/0072_external_operations.sql';

type SchemaState = {
  relation_present: boolean;
  operation_key_column: boolean;
  provider_receipt_column: boolean;
  key_index: boolean;
  idempotency_index: boolean;
  state_lease_index: boolean;
  subject_index: boolean;
};

function approved(): boolean {
  return process.argv.includes('--apply') && process.argv.includes(`--confirm=${CONFIRMATION}`);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const client = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: 'ps-423-migration-0072' },
  });

  const inspect = async (): Promise<SchemaState> => {
    const [state] = await client<SchemaState[]>`
      select
        to_regclass('public.external_operations') is not null as relation_present,
        exists (
          select 1 from information_schema.columns
          where table_schema = 'public'
            and table_name = 'external_operations'
            and column_name = 'operation_key'
        ) as operation_key_column,
        exists (
          select 1 from information_schema.columns
          where table_schema = 'public'
            and table_name = 'external_operations'
            and column_name = 'provider_receipt'
        ) as provider_receipt_column,
        to_regclass('public.external_operations_key_unq') is not null as key_index,
        to_regclass('public.external_operations_idempotency_unq') is not null as idempotency_index,
        to_regclass('public.external_operations_state_lease_idx') is not null as state_lease_index,
        to_regclass('public.external_operations_subject_idx') is not null as subject_index
    `;
    if (!state) throw new Error('PS-423 schema inspection returned no row');
    return state;
  };

  try {
    const before = await inspect();
    console.log(`[ps-423-migration] current=${JSON.stringify(before)}`);
    if (!approved()) {
      console.log(
        `[ps-423-migration] DRY RUN: pass --apply --confirm=${CONFIRMATION} to apply ${migrationPath}`,
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
    if (Object.values(after).some((present) => !present)) {
      throw new Error(`PS-423 migration verification failed: ${JSON.stringify(after)}`);
    }
    console.log(`[ps-423-migration] applied=${JSON.stringify(after)}`);
    console.log('[ps-423-migration] orders_shipments_unchanged=true');
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error('[ps-423-migration] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
