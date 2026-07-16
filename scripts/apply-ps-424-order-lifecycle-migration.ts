#!/usr/bin/env tsx
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { opsMayMutate } from '../src/lib/ops-confirm.js';
import { sql as pg } from '../src/db/client.js';

const migrationPath = 'drizzle/0070_order_lifecycle_commands.sql';

async function inspect() {
  const [state] = await pg<Array<{
    events_present: boolean;
    claims_present: boolean;
    append_only_trigger_present: boolean;
  }>>`
    select
      to_regclass('public.order_lifecycle_events') is not null as events_present,
      to_regclass('public.fulfillment_line_claims') is not null as claims_present,
      exists (
        select 1
        from pg_trigger
        where not tgisinternal
          and tgname = 'order_lifecycle_events_no_update_delete'
      ) as append_only_trigger_present
  `;
  return state;
}

async function main() {
  const before = await inspect();
  console.log(`[ps-424-migration] current=${JSON.stringify(before)}`);

  if (!opsMayMutate()) {
    console.log(`[ps-424-migration] DRY RUN: pass --apply to execute ${migrationPath}`);
    return;
  }

  const statements = readFileSync(migrationPath, 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);

  await pg.begin(async (tx) => {
    for (const statement of statements) {
      await tx.unsafe(statement);
    }
  });

  const after = await inspect();
  if (!after?.events_present || !after.claims_present || !after.append_only_trigger_present) {
    throw new Error(`PS-424 migration verification failed: ${JSON.stringify(after)}`);
  }
  console.log(`[ps-424-migration] applied=${JSON.stringify(after)}`);
}

main()
  .catch((error) => {
    console.error('[ps-424-migration] failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pg.end({ timeout: 5 });
  });
