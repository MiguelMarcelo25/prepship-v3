/**
 * PS-221 slice 3 — auto-provision readiness / dry-run (READ-ONLY).
 *
 * Auto-provision (PACKAGE_AUTO_PROVISION) is DARK by default: a label whose dims
 * match no catalog box auto-creates the box + saves it as the order's combo
 * default. Before enabling it in prod, run this to capture a BASELINE — then flip
 * the flag in a controlled window and re-run to see exactly what it created.
 *
 * Read-only (counts only). Run against prod read-only per the team convention:
 *   npx tsx scripts/ps-221-auto-provision-dry-run.ts
 */
import { sql } from 'drizzle-orm';
import { db } from '../src/db/client';

async function count(label: string, query: ReturnType<typeof sql>): Promise<number> {
  const rows = await db.execute<{ n: number }>(query);
  const n = Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
  console.log(`  ${label.padEnd(52)} ${n}`);
  return n;
}

async function main() {
  console.log('PS-221 auto-provision readiness (read-only baseline)\n');
  console.log(`  PACKAGE_AUTO_PROVISION = ${process.env.PACKAGE_AUTO_PROVISION ?? '(unset → OFF)'}\n`);

  console.log('Catalog:');
  await count('packages (total)', sql`select count(*)::int as n from packages`);
  const customBefore = await count('packages source=custom (auto-provision creates these)',
    sql`select count(*)::int as n from packages where source = 'custom'`);

  console.log('\nDefaults:');
  await count('client_combo_package_defaults (total)',
    sql`select count(*)::int as n from client_combo_package_defaults`);

  console.log('\nCandidates (orders that rely on dims/auto-provision at label time):');
  await count('awaiting orders with NO canonical selected_package_id',
    sql`select count(*)::int as n
        from orders o
        left join order_overrides ov on ov.order_id = o.id
        where o.order_status = 'awaiting_shipment'
          and (ov.selected_package_id is null or ov.selected_package_id = '')`);

  console.log('\nNotes:');
  console.log('  • Auto-provision fires at LABEL time for a no-catalog-match dims set —');
  console.log('    the exact set can\'t be predicted from awaiting state (depends on the');
  console.log('    label\'s dims), so this is a BEFORE snapshot, not a per-order forecast.');
  console.log('  • To roll out: set PACKAGE_AUTO_PROVISION=true on Render, ship a few');
  console.log('    labels, then re-run — the source=custom + combo-defaults counts above');
  console.log('    show what it created. Kill-switch: unset the flag (instant, no rollback).');
  console.log(`\n  Baseline custom packages: ${customBefore}. Re-run after enabling to diff.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('dry-run failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
