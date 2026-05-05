#!/usr/bin/env tsx
import 'dotenv/config';
import { sql as pgClient, db } from '../src/db/client';
import { sql } from 'drizzle-orm';

async function main() {
  console.log('Applying 0016_order_assignment migration...');
  await db.execute(sql`
    ALTER TABLE "orders"
      ADD COLUMN IF NOT EXISTS "assigned_to_user_id" text,
      ADD COLUMN IF NOT EXISTS "assigned_to_email"   text,
      ADD COLUMN IF NOT EXISTS "assigned_at"         timestamp with time zone
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "orders_assigned_user_idx"
      ON "orders" ("assigned_to_user_id")
  `);

  const check = await db.execute<{ column_name: string }>(sql`
    select column_name from information_schema.columns
    where table_name = 'orders'
      and column_name in ('assigned_to_user_id', 'assigned_to_email', 'assigned_at')
    order by column_name
  `);
  console.log('Columns now present:', check.map((r) => r.column_name));
}

main()
  .catch((err) => {
    console.error('FAIL:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pgClient.end({ timeout: 5 });
  });
