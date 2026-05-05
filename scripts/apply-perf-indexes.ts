#!/usr/bin/env tsx
import 'dotenv/config';
import { sql as pgClient, db } from '../src/db/client';
import { sql } from 'drizzle-orm';

async function main() {
  console.log('Applying 0017_perf_indexes…');
  console.log('  CREATE INDEX orders_status_date_idx');
  await db.execute(sql`
    create index if not exists "orders_status_date_idx"
      on "orders" ("order_status", "order_date" desc)
  `);
  console.log('  CREATE INDEX orders_client_status_date_idx');
  await db.execute(sql`
    create index if not exists "orders_client_status_date_idx"
      on "orders" ("client_id", "order_status", "order_date" desc)
  `);
  console.log('  CREATE INDEX orders_items_gin_idx (GIN on JSONB items)');
  await db.execute(sql`
    create index if not exists "orders_items_gin_idx"
      on "orders" using gin ("items")
  `);
  console.log('  CREATE INDEX shipments_order_voided_idx');
  await db.execute(sql`
    create index if not exists "shipments_order_voided_idx"
      on "shipments" ("order_id", "voided")
  `);
  console.log('  ANALYZE orders, shipments');
  await db.execute(sql`analyze "orders"`);
  await db.execute(sql`analyze "shipments"`);

  console.log('\nIndexes now on orders:');
  const r1 = await db.execute<{ indexname: string }>(sql`
    select indexname from pg_indexes where tablename = 'orders' and schemaname = 'public' order by indexname
  `);
  for (const r of r1) console.log(`  ${r.indexname}`);

  console.log('\nIndexes now on shipments:');
  const r2 = await db.execute<{ indexname: string }>(sql`
    select indexname from pg_indexes where tablename = 'shipments' and schemaname = 'public' order by indexname
  `);
  for (const r of r2) console.log(`  ${r.indexname}`);
}

main()
  .catch((err) => { console.error('FAIL:', err); process.exitCode = 1; })
  .finally(async () => { await pgClient.end({ timeout: 5 }); });
