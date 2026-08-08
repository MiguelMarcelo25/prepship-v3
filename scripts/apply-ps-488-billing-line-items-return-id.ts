#!/usr/bin/env tsx
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const CONFIRMATION = 'apply-ps-488-billing-line-items-return-id-0089';
const migrationPath = 'drizzle/0089_billing_line_items_return_id.sql';

// PS-488 M1 — one additive NULLABLE column, an FK and a partial index on
// `billing_line_items`.
//
// Same runner pattern as 0088: this repo does NOT apply migrations with
// `drizzle-kit migrate` (the drizzle journal stops at entry 15 while migration files run
// past 0088), so each migration past 0015 gets its own script.
//
// billing_line_items is FROZEN INVOICE TRUTH, so the verification here is stricter than
// 0088's: the row count, the summed total_cost and a checksum over every row's identity
// must be byte-identical afterwards. A schema change to this table must be provably
// incapable of moving a single cent.
//
// M1 only creates the place to put the identity. Every row stays NULL until PS-488 M2
// makes the writers populate it, and NULL means "not yet attributed" — never "not a
// return line". Do not build AC-7 linkage on this column between M1 and M2.

type SchemaState = {
  return_id_column: boolean;
  return_id_nullable: boolean;
  return_id_fk: boolean;
  return_id_index: boolean;
};

type BillingSnapshot = {
  line_count: string;
  invoiced_count: string;
  total_cost_sum: string;
  identity_checksum: string;
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
    connection: { application_name: 'ps-488-migration-0089' },
  });

  const inspect = async (): Promise<SchemaState> => {
    const [state] = await client<SchemaState[]>`
      select
        exists (
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'billing_line_items'
            and column_name = 'return_id'
        ) as return_id_column,
        not exists (
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'billing_line_items'
            and column_name = 'return_id' and is_nullable = 'NO'
        ) as return_id_nullable,
        exists (
          select 1 from pg_constraint
          where conname = 'billing_line_items_return_id_returns_id_fk'
        ) as return_id_fk,
        exists (
          select 1 from pg_indexes
          where schemaname = 'public' and indexname = 'billing_li_return_id_idx'
        ) as return_id_index
    `;
    if (!state) throw new Error('PS-488 schema inspection returned no row');
    return state;
  };

  // billing_line_items is the frozen invoice record. Row count, invoiced count, the
  // summed charge and a checksum over each row's identity must be identical afterwards.
  const snapshot = async (): Promise<BillingSnapshot> => {
    const [state] = await client<BillingSnapshot[]>`
      select
        (select count(*)::text from billing_line_items) as line_count,
        (select count(*)::text from billing_line_items where invoiced) as invoiced_count,
        (select coalesce(sum(total_cost), 0)::text from billing_line_items) as total_cost_sum,
        (select coalesce(
           md5(string_agg(id || ':' || line_type || ':' || total_cost, ',' order by id)),
           'empty'
         )::text from billing_line_items) as identity_checksum
    `;
    if (!state) throw new Error('PS-488 billing snapshot returned no row');
    return state;
  };

  try {
    const beforeState = await inspect();
    console.log(`[ps-488-migration] current=${JSON.stringify(beforeState)}`);
    if (ready(beforeState)) {
      console.log('[ps-488-migration] already_applied=true');
      return;
    }
    if (!approved()) {
      console.log(
        `[ps-488-migration] DRY RUN: pass --apply --confirm=${CONFIRMATION} to apply ${migrationPath}`,
      );
      return;
    }

    const migration = readFileSync(migrationPath, 'utf8');
    if (/\bupdate\s+(?:public\.)?(?:returns|orders|shipments|billing_line_items|billing_finalizations)\s+set\b/i.test(migration) ||
      /\bdelete\s+from\s+(?:public\.)?(?:returns|orders|shipments|billing_line_items|billing_finalizations)\b/i.test(migration) ||
      /\binsert\s+into\s+(?:public\.)?(?:returns|orders|shipments|billing_line_items|billing_finalizations)\b/i.test(migration) ||
      /\btruncate\s+(?:table\s+)?(?:public\.)?(?:returns|orders|shipments|billing_line_items|billing_finalizations)\b/i.test(migration) ||
      /\balter\s+table\s+(?:public\.)?(?:orders|shipments|returns)\b/i.test(migration)) {
      throw new Error('Migration refused: protected historical returns/billing/order/shipment DML detected');
    }
    if (/\bdrop\s+(?:table|column)\b/i.test(migration)) {
      throw new Error('Migration refused: destructive table/column DROP detected');
    }
    // A NOT NULL add would need a backfilled return_id for every existing billing line,
    // and any invented attribution is a false audit trail on frozen invoice rows.
    if (/\badd\s+column\b[^;]*\bnot\s+null\b/i.test(migration)) {
      throw new Error('Migration refused: a NOT NULL column add would require backfilling frozen billing lines');
    }
    // ON DELETE CASCADE here would let deleting a return delete the charge it produced.
    if (/on\s+delete\s+cascade/i.test(migration)) {
      throw new Error('Migration refused: ON DELETE CASCADE would let a return deletion destroy billing history');
    }

    const before = await snapshot();
    await client.begin(async (tx) => {
      await tx.unsafe(migration);
    });
    const after = await snapshot();
    const afterState = await inspect();

    if (!ready(afterState)) {
      throw new Error(`PS-488 migration verification failed: ${JSON.stringify(afterState)}`);
    }
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error('Migration verification failed: billing line count, invoiced count, or charge total changed');
    }

    const [populated] = await client<{ n: string }[]>`
      select count(return_id)::text as n from billing_line_items
    `;
    if (populated && populated.n !== '0') {
      throw new Error(`Migration verification failed: M1 must leave return_id empty, found ${populated.n} populated`);
    }

    console.log(`[ps-488-migration] applied=${JSON.stringify(afterState)}`);
    console.log(`[ps-488-migration] billing_unchanged=true rows=${after.line_count} total=${after.total_cost_sum}`);
    console.log('[ps-488-migration] frozen_invoice_rows_intact=true');
    console.log('[ps-488-migration] return_id_populated=0 (M2 writers have not run — expected)');
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error('[ps-488-migration] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
