#!/usr/bin/env tsx
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const CONFIRMATION = 'apply-ps-497-claim-nullable-quantity-0090';
const migrationPath = 'drizzle/0090_fulfillment_claim_nullable_quantity.sql';

// PS-497 — widen fulfillment_line_claims.quantity and replace `CHECK (quantity > 0)` with a
// state check that permits NULL only on review claims.
//
// This repo does NOT apply migrations with `drizzle-kit migrate`: the drizzle journal stops at
// entry 15 while migration files run past 0090, so everything after 0015 gets a runner like
// this one. Dry run by default; `--apply --confirm=...` is required to touch the database.
//
// The migration is pure DDL. No row is read, written or deleted, and every existing row
// already satisfies the new constraint because every existing row has a positive quantity.
// Re-nulling the 2,950 historical fabricated `1`s is a SEPARATE backfill needing DJ approval,
// and is deliberately not performed here.

type SchemaState = {
  quantity_nullable: boolean;
  old_positive_check_gone: boolean;
  new_state_check_present: boolean;
};

type ClaimsSnapshot = {
  claim_count: string;
  by_status: string;
  quantity_checksum: string;
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
    connection: { application_name: 'ps-497-migration-0090' },
  });

  const inspect = async (): Promise<SchemaState> => {
    const [state] = await client<SchemaState[]>`
      select
        exists (
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'fulfillment_line_claims'
            and column_name = 'quantity' and is_nullable = 'YES'
        ) as quantity_nullable,
        not exists (
          select 1 from pg_constraint con
          join pg_class rel on rel.oid = con.conrelid
          where rel.relname = 'fulfillment_line_claims'
            and con.conname = 'fulfillment_line_claims_quantity_check'
        ) as old_positive_check_gone,
        exists (
          select 1 from pg_constraint con
          join pg_class rel on rel.oid = con.conrelid
          where rel.relname = 'fulfillment_line_claims'
            and con.conname = 'fulfillment_line_claims_quantity_state_check'
        ) as new_state_check_present
    `;
    if (!state) throw new Error('PS-497 schema inspection returned no row');
    return state;
  };

  // Every claim row must be byte-identical afterwards. This is a DDL-only change; if any
  // quantity or status moved, something in the migration was not what it claimed to be.
  const snapshot = async (): Promise<ClaimsSnapshot> => {
    const [state] = await client<ClaimsSnapshot[]>`
      select
        (select count(*)::text from fulfillment_line_claims) as claim_count,
        (select coalesce(string_agg(s.status || '=' || s.n, ',' order by s.status), 'none')
           from (select status, count(*)::text as n from fulfillment_line_claims group by status) s
        ) as by_status,
        (select coalesce(md5(string_agg(
            id || ':' || coalesce(quantity::text, 'null') || ':' || status, ',' order by id)), 'empty')::text
           from fulfillment_line_claims) as quantity_checksum
    `;
    if (!state) throw new Error('PS-497 claims snapshot returned no row');
    return state;
  };

  try {
    const beforeState = await inspect();
    console.log(`[ps-497-migration] current=${JSON.stringify(beforeState)}`);
    if (ready(beforeState)) {
      console.log('[ps-497-migration] already_applied=true');
      return;
    }
    if (!approved()) {
      const before = await snapshot();
      console.log(`[ps-497-migration] claims=${before.claim_count} by_status=${before.by_status}`);
      console.log(
        `[ps-497-migration] DRY RUN: pass --apply --confirm=${CONFIRMATION} to apply ${migrationPath}`,
      );
      return;
    }

    const migration = readFileSync(migrationPath, 'utf8');
    // The same refusals the other runners carry: this migration must be pure DDL on
    // fulfillment_line_claims and must never touch protected historical data.
    if (/\b(update|delete\s+from|insert\s+into|truncate)\b/i.test(migration.replace(/--[^\n]*/g, ''))) {
      throw new Error('Migration refused: DML detected in a DDL-only migration');
    }
    if (/\balter\s+table\s+(?:public\.)?(?:orders|shipments)\b/i.test(migration)) {
      throw new Error('Migration refused: shipped/cancelled protected tables must not be altered');
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
      throw new Error(`PS-497 migration verification failed: ${JSON.stringify(afterState)}`);
    }
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error('Migration verification failed: claim rows, quantities, or statuses changed');
    }

    console.log(`[ps-497-migration] applied=${JSON.stringify(afterState)}`);
    console.log(`[ps-497-migration] claims_unchanged=true rows=${after.claim_count}`);
    console.log('[ps-497-migration] no_backfill_performed=true');
    console.log('[ps-497-migration] orders_shipments_untouched=true');
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error('[ps-497-migration] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
