#!/usr/bin/env tsx
/* eslint-disable no-console */
// One-shot migration from Tokyo Supabase → US-West Supabase.
//
// Reads source/target connection strings from env so credentials stay out
// of git. Phases:
//   1. Apply schema to target via drizzle-kit migrations (you run separately
//      with TARGET_DATABASE_URL set; this script assumes schema is already
//      in place).
//   2. Copy public-schema tables from source to target in dependency order,
//      preserving IDs. Truncates target tables first (safe — target is fresh).
//   3. Reset Postgres sequences on target to MAX(id)+1.
//   4. (Run migrate-supabase-auth.ts separately for auth.users.)
//
// Usage:
//   SOURCE_DATABASE_URL='postgresql://...tokyo...' \
//   TARGET_DATABASE_URL='postgresql://...us-west...' \
//   npx tsx scripts/migrate-supabase.ts [--dry-run] [--only=table1,table2]

import postgres from 'postgres';

const SOURCE_URL = process.env.SOURCE_DATABASE_URL;
const TARGET_URL = process.env.TARGET_DATABASE_URL;
if (!SOURCE_URL || !TARGET_URL) {
  console.error('Need SOURCE_DATABASE_URL and TARGET_DATABASE_URL env vars.');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const onlyTables = onlyArg ? onlyArg.slice('--only='.length).split(',') : null;

// Tables in dependency order (parents first). FK violations otherwise.
// Sourced from the Drizzle schema files in src/db/schema/.
const TABLE_ORDER: Array<{ name: string; pk?: string }> = [
  // Independent / reference tables
  { name: 'clients', pk: 'id' },
  { name: 'locations', pk: 'id' },
  { name: 'packages', pk: 'id' },
  { name: 'parent_skus', pk: 'id' },
  { name: 'products', pk: 'id' },
  { name: 'product_defaults', pk: 'id' },
  { name: 'settings' },
  { name: 'rate_cache' },
  { name: 'mock_labels' },
  { name: 'sync_meta' },
  { name: 'carrier_accounts', pk: 'id' },
  { name: 'return_labels', pk: 'id' },
  { name: 'billing_records', pk: 'id' },

  // Order-dependent
  { name: 'orders', pk: 'id' },
  { name: 'order_overrides' },
  { name: 'shipments', pk: 'id' },

  // Inventory-dependent
  { name: 'inventory', pk: 'id' },
  { name: 'inventory_sku_parents', pk: 'id' },
  { name: 'inventory_ledger', pk: 'id' },

  // Other order-dependent
  { name: 'package_ledger', pk: 'id' },
  { name: 'print_queue_orders' },
];

const BATCH_SIZE = 1000;

async function tableExists(sql: ReturnType<typeof postgres>, table: string) {
  const rows = await sql<{ exists: boolean }[]>`
    select exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = ${table}
    ) as exists
  `;
  return rows[0]?.exists === true;
}

async function getColumns(sql: ReturnType<typeof postgres>, table: string): Promise<string[]> {
  const rows = await sql<{ column_name: string }[]>`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = ${table}
    order by ordinal_position
  `;
  return rows.map((r) => r.column_name);
}

async function rowCount(sql: ReturnType<typeof postgres>, table: string): Promise<number> {
  const rows = await sql<{ c: number }[]>`select count(*)::int as c from ${sql(table)}`;
  return rows[0]?.c ?? 0;
}

async function copyTable(
  src: ReturnType<typeof postgres>,
  tgt: ReturnType<typeof postgres>,
  table: string,
) {
  if (!(await tableExists(src, table))) {
    console.log(`  ${table}: skip (not in source)`);
    return { copied: 0, skipped: 0 };
  }
  if (!(await tableExists(tgt, table))) {
    console.log(`  ${table}: skip (not in target — apply schema first)`);
    return { copied: 0, skipped: 0 };
  }

  const srcCols = await getColumns(src, table);
  const tgtCols = await getColumns(tgt, table);
  const cols = srcCols.filter((c) => tgtCols.includes(c));
  if (!cols.length) {
    console.log(`  ${table}: no overlapping columns`);
    return { copied: 0, skipped: 0 };
  }

  const total = await rowCount(src, table);
  if (total === 0) {
    console.log(`  ${table}: 0 rows`);
    return { copied: 0, skipped: 0 };
  }

  if (dryRun) {
    console.log(`  ${table}: ${total} rows would copy (cols: ${cols.length})`);
    return { copied: 0, skipped: 0 };
  }

  console.log(`  ${table}: ${total} rows…`);
  // Truncate target first. Safe because new project is empty; this also
  // protects from re-runs producing duplicate-key errors on PKs.
  await tgt`truncate table ${tgt(table)} restart identity cascade`;

  let copied = 0;
  let offset = 0;
  while (offset < total) {
    const batch = await src.unsafe<Record<string, unknown>[]>(
      `select ${cols.map((c) => `"${c}"`).join(', ')} from "${table}" order by ${cols[0]} limit ${BATCH_SIZE} offset ${offset}`
    );
    if (batch.length === 0) break;
    await tgt`insert into ${tgt(table)} ${tgt(batch as never, ...cols)}`;
    copied += batch.length;
    offset += BATCH_SIZE;
    if (copied % 5000 === 0 || copied === total) {
      console.log(`    ${copied}/${total}`);
    }
  }
  return { copied, skipped: 0 };
}

async function resetSequences(tgt: ReturnType<typeof postgres>) {
  console.log('\nResetting sequences to MAX(id)+1…');
  for (const { name, pk } of TABLE_ORDER) {
    if (!pk) continue;
    if (!(await tableExists(tgt, name))) continue;
    try {
      const seqRows = await tgt<{ seq: string | null }[]>`
        select pg_get_serial_sequence(${name}, ${pk}) as seq
      `;
      const seq = seqRows[0]?.seq;
      if (!seq) continue;
      const maxRows = await tgt.unsafe<{ m: number | null }[]>(
        `select coalesce(max("${pk}"), 0) as m from "${name}"`
      );
      const next = (maxRows[0]?.m ?? 0) + 1;
      if (!dryRun) {
        await tgt.unsafe(`select setval('${seq}', ${next}, false)`);
      }
      console.log(`  ${name}.${pk}: setval(${seq}, ${next})`);
    } catch (err) {
      console.warn(`  ${name}.${pk}: skipped — ${(err as Error).message}`);
    }
  }
}

async function verifyCounts(
  src: ReturnType<typeof postgres>,
  tgt: ReturnType<typeof postgres>,
) {
  console.log('\nVerifying row counts:');
  console.log(`  ${'table'.padEnd(28)} source   target  match?`);
  let allMatch = true;
  for (const { name } of TABLE_ORDER) {
    if (!(await tableExists(src, name)) || !(await tableExists(tgt, name))) continue;
    const sCount = await rowCount(src, name);
    const tCount = await rowCount(tgt, name);
    const match = sCount === tCount;
    if (!match) allMatch = false;
    console.log(`  ${name.padEnd(28)} ${String(sCount).padStart(7)}  ${String(tCount).padStart(7)}  ${match ? '✓' : '✗ MISMATCH'}`);
  }
  return allMatch;
}

async function main() {
  console.log(`\n=== Supabase migration ${dryRun ? '(DRY RUN)' : ''} ===\n`);
  const src = postgres(SOURCE_URL, { prepare: false, max: 5, idle_timeout: 10 });
  const tgt = postgres(TARGET_URL, { prepare: false, max: 5, idle_timeout: 10 });

  try {
    console.log('Source: connected');
    await src`select 1`;
    console.log('Target: connected');
    await tgt`select 1`;

    console.log('\nCopying tables (parents first):');
    let totalCopied = 0;
    for (const { name } of TABLE_ORDER) {
      if (onlyTables && !onlyTables.includes(name)) continue;
      const { copied } = await copyTable(src, tgt, name);
      totalCopied += copied;
    }

    if (!dryRun && !onlyTables) {
      await resetSequences(tgt);
    }

    const ok = await verifyCounts(src, tgt);
    console.log(`\nDone. Copied ${totalCopied} rows total. ${ok ? '✓ All counts match.' : '✗ COUNT MISMATCH — investigate before cutover.'}`);
  } finally {
    await src.end({ timeout: 5 });
    await tgt.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('FAIL:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
