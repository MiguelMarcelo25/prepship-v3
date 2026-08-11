#!/usr/bin/env tsx
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';

const CONFIRMATION = 'apply-ps-466-run-recovery-0091';
const MIGRATION_PATH = 'drizzle/0091_ps466_automation_run_recovery.sql';

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
    connection: { application_name: 'ps-466-run-recovery-0091' },
  });
  try {
    const inspect = async () => {
      const [row] = await client<{
        run_lease_columns: boolean;
        recovery_index: boolean;
        running_runs: number;
        expired_planned_effects: number;
      }[]>`
        select
          (select count(*) = 6 from information_schema.columns
            where table_schema = 'public' and table_name = 'automation_runs'
              and column_name in ('attempt_count', 'lease_token', 'lease_expires_at', 'recovery_count', 'last_recovery_code', 'last_recovered_at')) as run_lease_columns,
          to_regclass('public.automation_runs_recovery_idx') is not null as recovery_index,
          (select count(*)::int from automation_runs where status = 'running') as running_runs,
          (select count(*)::int from automation_action_results
            where status = 'planned' and (lease_expires_at is null or lease_expires_at <= now())) as expired_planned_effects
      `;
      if (!row) throw new Error('PS-466 recovery inspection returned no row');
      return row;
    };

    const before = await inspect();
    console.log(`[ps-466-run-recovery] before=${JSON.stringify(before)}`);
    if (before.run_lease_columns && before.recovery_index) {
      console.log('[ps-466-run-recovery] already_applied=true');
      return;
    }
    if (!approved()) {
      console.log(`[ps-466-run-recovery] DRY RUN: pass --apply --confirm=${CONFIRMATION} to apply schema only`);
      console.log('[ps-466-run-recovery] application_rows_mutated=0 provider_calls=0');
      return;
    }

    const migration = await readFile(MIGRATION_PATH, 'utf8');
    if (/\b(?:insert|update|delete|truncate)\b/i.test(migration)) {
      throw new Error('Migration refused: application-row DML is not allowed');
    }
    await client`select pg_advisory_lock(hashtext('ps-466-run-recovery-0091'))`;
    try {
      await client.unsafe(migration);
      await client.unsafe(`
        CREATE INDEX CONCURRENTLY IF NOT EXISTS automation_runs_recovery_idx
          ON automation_runs (status, lease_expires_at, started_at, id)
          WHERE status = 'running'
      `);
    } finally {
      await client`select pg_advisory_unlock(hashtext('ps-466-run-recovery-0091'))`;
    }
    const after = await inspect();
    if (!after.run_lease_columns || !after.recovery_index) {
      throw new Error(`PS-466 recovery migration verification failed: ${JSON.stringify(after)}`);
    }
    if (before.running_runs !== after.running_runs || before.expired_planned_effects !== after.expired_planned_effects) {
      throw new Error('Schema migration unexpectedly changed automation application rows');
    }
    console.log(`[ps-466-run-recovery] after=${JSON.stringify(after)}`);
    console.log('[ps-466-run-recovery] application_rows_mutated=0 provider_calls=0');
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error('[ps-466-run-recovery] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
