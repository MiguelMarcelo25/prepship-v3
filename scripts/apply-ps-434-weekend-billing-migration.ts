#!/usr/bin/env tsx
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const CONFIRMATION = 'apply-ps-434-weekend-billing-0071';
const migrationPath = 'drizzle/0071_billing_weekend_rollforward.sql';

function approved(): boolean {
  return process.argv.includes('--apply') &&
    process.argv.includes(`--confirm=${CONFIRMATION}`);
}

type BillingSnapshot = {
  line_count: string;
  total_cost: string;
};

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const client = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: 'ps-434-migration-0071' },
  });

  const inspect = async () => {
    const [state] = await client<{
      effective_date_column: boolean;
      policy_version_column: boolean;
      effective_date_index: boolean;
      closed_period_function: boolean;
    }[]>`
      select
        exists (
          select 1 from information_schema.columns
          where table_schema = 'public'
            and table_name = 'billing_line_items'
            and column_name = 'billing_effective_date'
        ) as effective_date_column,
        exists (
          select 1 from information_schema.columns
          where table_schema = 'public'
            and table_name = 'billing_line_items'
            and column_name = 'billing_policy_version'
        ) as policy_version_column,
        to_regclass('public.billing_li_effective_date_idx') is not null as effective_date_index,
        to_regprocedure('public.billing_line_items_block_closed_period_mutation()') is not null
          as closed_period_function
    `;
    return state!;
  };

  const snapshot = async () => {
    const [row] = await client<BillingSnapshot[]>`
      select
        count(*)::text as line_count,
        coalesce(sum(total_cost), 0)::text as total_cost
      from billing_line_items
    `;
    return row!;
  };

  try {
    const beforeState = await inspect();
    console.log(`[ps-434-migration] current=${JSON.stringify(beforeState)}`);
    if (!approved()) {
      console.log(
        `[ps-434-migration] DRY RUN: pass --apply --confirm=${CONFIRMATION} to apply ${migrationPath}`,
      );
      return;
    }

    const migration = readFileSync(migrationPath, 'utf8');
    if (/\b(?:update|delete)\s+(?:from\s+)?(?:public\.)?billing_line_items\b/i.test(migration)) {
      throw new Error('Migration refused: historical billing-line mutation detected');
    }
    if (/\b(?:alter|update|delete|truncate)\s+(?:table\s+|from\s+)?(?:public\.)?(?:orders|shipments)\b/i.test(migration)) {
      throw new Error('Migration refused: orders/shipments mutation detected');
    }

    const before = await snapshot();
    await client.begin(async (tx) => {
      await tx.unsafe(migration);
    });
    const after = await snapshot();
    const afterState = await inspect();

    if (
      !afterState.effective_date_column ||
      !afterState.policy_version_column ||
      !afterState.effective_date_index ||
      !afterState.closed_period_function
    ) {
      throw new Error(`Migration verification failed: ${JSON.stringify(afterState)}`);
    }
    if (before.line_count !== after.line_count || Number(before.total_cost) !== Number(after.total_cost)) {
      throw new Error('Migration verification failed: historical billing rows/totals changed');
    }

    console.log(`[ps-434-migration] applied=${JSON.stringify(afterState)}`);
    console.log('[ps-434-migration] historical_rows_and_totals_unchanged=true');
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error('[ps-434-migration] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
