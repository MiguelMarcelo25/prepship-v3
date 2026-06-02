/**
 * Add covering indexes for the two app FKs flagged "Unindexed foreign keys".
 * Uses CREATE INDEX CONCURRENTLY IF NOT EXISTS (non-blocking, idempotent), so it
 * runs OUTSIDE a transaction. Verifies the indexes exist afterward.
 *
 *   npx tsx scripts/rls-advisor-fk-apply.ts
 */
import { sql } from '../src/db/client';

const INDEXES = [
  { name: 'billing_line_items_package_id_idx', table: 'billing_line_items', column: 'package_id' },
  { name: 'client_combo_package_defaults_package_id_idx', table: 'client_combo_package_defaults', column: 'package_id' },
] as const;

async function main() {
  for (const ix of INDEXES) {
    // Names/columns are from the hardcoded list above (not user input).
    await sql.unsafe(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${ix.name} ON public.${ix.table} (${ix.column});`,
    );
    console.log(`  ensured index ${ix.name} on public.${ix.table}(${ix.column})`);
  }

  const present = await sql<Array<{ indexname: string }>>`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = ANY(${INDEXES.map((i) => i.name)});
  `;
  const have = new Set(present.map((r) => r.indexname));
  console.log('\n=== Verification ===');
  let ok = true;
  for (const ix of INDEXES) {
    const exists = have.has(ix.name);
    if (!exists) ok = false;
    console.log(`  ${exists ? 'OK ' : 'MISSING'}  ${ix.name}`);
  }
  if (!ok) process.exit(1);
  console.log('\nBoth FK covering indexes present.');
  await sql.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('fk-apply failed:', err);
  process.exit(1);
});
