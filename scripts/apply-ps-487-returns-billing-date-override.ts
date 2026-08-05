#!/usr/bin/env tsx
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const CONFIRMATION = 'apply-ps-487-returns-billing-date-override-0088';
const migrationPath = 'drizzle/0088_returns_billing_date_override.sql';

// PS-487 AC-4/AC-7 — three additive NULLABLE columns on `returns`.
//
// This repo does NOT apply migrations with `drizzle-kit migrate`: the drizzle journal
// stops at entry 15 while migration files run to 0088, so everything past 0015 is applied
// by a per-migration script like this one. Running `db:migrate` here would reconcile
// against a 73-migration gap, which is why 0088 gets its own runner.
//
// Nothing in 0088 touches existing data. NULL means "no correction" and the billing
// contract falls back to returns.created_at, so every existing row keeps its behaviour
// and no backfill is required.

type SchemaState = {
  billing_date_override_column: boolean;
  billing_date_override_by_column: boolean;
  billing_date_override_reason_column: boolean;
  all_nullable: boolean;
};

type ReturnsSnapshot = {
  return_count: string;
  returns_with_shipping: string;
  shipping_total: string;
  created_at_checksum: string;
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
    connection: { application_name: 'ps-487-migration-0088' },
  });

  const inspect = async (): Promise<SchemaState> => {
    const [state] = await client<SchemaState[]>`
      select
        exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'returns' and column_name = 'billing_date_override') as billing_date_override_column,
        exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'returns' and column_name = 'billing_date_override_by') as billing_date_override_by_column,
        exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'returns' and column_name = 'billing_date_override_reason') as billing_date_override_reason_column,
        not exists (
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'returns'
            and column_name in ('billing_date_override', 'billing_date_override_by', 'billing_date_override_reason')
            and is_nullable = 'NO'
        ) as all_nullable
    `;
    if (!state) throw new Error('PS-487 schema inspection returned no row');
    return state;
  };

  // `returns` is the only table 0088 touches. Its row count, the captured customer
  // return shipping, and a checksum over created_at must all be identical afterwards —
  // created_at is the audit evidence AC-7 requires a correction to leave intact.
  const snapshot = async (): Promise<ReturnsSnapshot> => {
    const [state] = await client<ReturnsSnapshot[]>`
      select
        (select count(*)::text from returns) as return_count,
        (select count(*)::text from returns where return_customer_shipping_rate is not null) as returns_with_shipping,
        (select coalesce(sum(return_customer_shipping_rate), 0)::text from returns) as shipping_total,
        (select coalesce(md5(string_agg(id || ':' || created_at, ',' order by id)), 'empty')::text from returns) as created_at_checksum
    `;
    if (!state) throw new Error('PS-487 returns snapshot returned no row');
    return state;
  };

  try {
    const beforeState = await inspect();
    console.log(`[ps-487-migration] current=${JSON.stringify(beforeState)}`);
    if (ready(beforeState)) {
      console.log('[ps-487-migration] already_applied=true');
      return;
    }
    if (!approved()) {
      console.log(
        `[ps-487-migration] DRY RUN: pass --apply --confirm=${CONFIRMATION} to apply ${migrationPath}`,
      );
      return;
    }

    const migration = readFileSync(migrationPath, 'utf8');
    if (/\bupdate\s+(?:public\.)?(?:returns|orders|shipments|billing_line_items|billing_finalizations)\s+set\b/i.test(migration) ||
      /\bdelete\s+from\s+(?:public\.)?(?:returns|orders|shipments|billing_line_items|billing_finalizations)\b/i.test(migration) ||
      /\binsert\s+into\s+(?:public\.)?(?:returns|orders|shipments|billing_line_items|billing_finalizations)\b/i.test(migration) ||
      /\btruncate\s+(?:table\s+)?(?:public\.)?(?:returns|orders|shipments|billing_line_items|billing_finalizations)\b/i.test(migration) ||
      /\balter\s+table\s+(?:public\.)?(?:orders|shipments)\b/i.test(migration)) {
      throw new Error('Migration refused: protected historical returns/billing/order/shipment DML detected');
    }
    if (/\bdrop\s+(?:table|column)\b/i.test(migration)) {
      throw new Error('Migration refused: destructive table/column DROP detected');
    }
    // A NOT NULL add on `returns` would need a backfill value for the 8 existing rows,
    // and any invented value is indistinguishable from a real correction.
    if (/\badd\s+column\b[^;]*\bnot\s+null\b/i.test(migration)) {
      throw new Error('Migration refused: a NOT NULL column add would require backfilling existing returns');
    }

    const before = await snapshot();
    await client.begin(async (tx) => {
      await tx.unsafe(migration);
    });
    const after = await snapshot();
    const afterState = await inspect();

    if (!ready(afterState)) {
      throw new Error(`PS-487 migration verification failed: ${JSON.stringify(afterState)}`);
    }
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error('Migration verification failed: returns rows, shipping totals, or created_at changed');
    }

    console.log(`[ps-487-migration] applied=${JSON.stringify(afterState)}`);
    console.log(`[ps-487-migration] returns_unchanged=true rows=${after.return_count}`);
    console.log('[ps-487-migration] created_at_audit_evidence_intact=true');
    console.log('[ps-487-migration] orders_shipments_untouched=true');
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error('[ps-487-migration] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
