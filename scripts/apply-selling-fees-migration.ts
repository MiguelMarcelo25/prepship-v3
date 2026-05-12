#!/usr/bin/env tsx
// ──────────────────────────────────────────────────────────────────
// scripts/apply-selling-fees-migration.ts
//
// Idempotent apply for drizzle/0019_selling_fees.sql. Adds the four
// columns + one partial index that power per-order seller-fee
// tracking (Walmart first; eBay etc. layered later).
//
// Safe to re-run: every statement uses ADD COLUMN IF NOT EXISTS /
// CREATE INDEX IF NOT EXISTS, so no behavior on second invocation.
//
// Usage:
//   npx tsx scripts/apply-selling-fees-migration.ts
// ──────────────────────────────────────────────────────────────────

import 'dotenv/config';
import { db } from '../src/db/client';
import { sql } from 'drizzle-orm';

async function main() {
  console.log('Applying 0019_selling_fees…');

  const statements: Array<{ label: string; sql: ReturnType<typeof sql> }> = [
    {
      label: 'ALTER TABLE orders ADD selling_fee',
      sql: sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS selling_fee NUMERIC(10, 2) NOT NULL DEFAULT 0`,
    },
    {
      label: 'ALTER TABLE orders ADD selling_fee_breakdown',
      sql: sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS selling_fee_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb`,
    },
    {
      label: 'ALTER TABLE orders ADD selling_fee_synced_at',
      sql: sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS selling_fee_synced_at TIMESTAMPTZ`,
    },
    {
      label: 'ALTER TABLE orders ADD selling_fee_source',
      sql: sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS selling_fee_source TEXT`,
    },
    {
      label: 'CREATE INDEX orders_selling_fee_source_idx',
      sql: sql`CREATE INDEX IF NOT EXISTS orders_selling_fee_source_idx ON orders (selling_fee_source) WHERE selling_fee_source IS NOT NULL`,
    },
  ];

  for (const { label, sql: stmt } of statements) {
    console.log(`  ${label}`);
    await db.execute(stmt);
  }

  console.log('\nVerifying:');
  const cols = await db.execute<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(sql`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'orders'
      AND column_name LIKE 'selling_fee%'
    ORDER BY column_name
  `);
  for (const r of cols) {
    console.log(`  ${r.column_name.padEnd(28)} ${r.data_type.padEnd(28)} nullable=${r.is_nullable.padEnd(3)} default=${r.column_default ?? '—'}`);
  }

  const indexes = await db.execute<{ indexname: string }>(sql`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'orders' AND indexname = 'orders_selling_fee_source_idx'
  `);
  console.log(`\nIndex: ${indexes.length > 0 ? indexes[0].indexname : '(not created)'}`);

  console.log('\nDone.');
}

main()
  .catch((err) => {
    console.error('apply-selling-fees-migration.ts failed:', err);
    process.exit(1);
  })
  .finally(() => {
    process.exit(0);
  });
