/**
 * Apply RLS to the tables flagged "RLS Disabled in Public" (CRITICAL) by the
 * Supabase advisor. Enables row-level security (ENABLE, never FORCE) so the
 * anon/authenticated PostgREST roles are denied while the `postgres` owner role
 * (used by the backend) continues to bypass RLS.
 *
 * Idempotent and transactional. Verifies before/after and smoke-tests that the
 * owner role can still read each table.
 *
 *   npx tsx scripts/rls-advisor-apply.ts          # apply
 *   npx tsx scripts/rls-advisor-apply.ts --check  # report only, no changes
 */
import { sql } from '../src/db/client';

// Hardcoded allowlist — these names are interpolated into DDL, so they MUST NOT
// come from user input. They mirror drizzle/0037_rls_reporting_metrics_inbound.sql.
const TABLES = [
  'reporting_refresh_runs',
  'analytics_cache',
  'order_items',
  'fulfillment_outbox',
  'daily_sales_metrics',
  'sku_velocity_metrics',
  'inventory_risk_metrics',
  'billing_summary_metrics',
  'client_combo_package_defaults',
  'inbound_shipments',
  'inbound_items',
] as const;

const CHECK_ONLY = process.argv.includes('--check');

async function statusMap() {
  const rows = await sql<Array<{ relname: string; relrowsecurity: boolean }>>`
    SELECT c.relname, c.relrowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY(${TABLES as unknown as string[]});
  `;
  return new Map(rows.map((r) => [r.relname, r.relrowsecurity]));
}

async function main() {
  const before = await statusMap();
  const missing = TABLES.filter((t) => !before.has(t));
  if (missing.length) {
    throw new Error(`Refusing to proceed — tables not found: ${missing.join(', ')}`);
  }

  const needEnable = TABLES.filter((t) => before.get(t) !== true);
  console.log(`RLS already enabled: ${TABLES.length - needEnable.length}/${TABLES.length}`);
  console.log(`Needs enable      : ${needEnable.length ? needEnable.join(', ') : '(none)'}`);

  if (CHECK_ONLY) {
    console.log('\n--check: no changes made.');
    await sql.end({ timeout: 5 });
    return;
  }

  if (needEnable.length > 0) {
    await sql.begin(async (tx) => {
      for (const table of needEnable) {
        // table is from the hardcoded allowlist above (not user input).
        await tx.unsafe(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
        console.log(`  enabled RLS on public.${table}`);
      }
    });
  }

  // Verify final state.
  const after = await statusMap();
  const stillOff = TABLES.filter((t) => after.get(t) !== true);
  console.log('\n=== Verification ===');
  for (const t of TABLES) console.log(`  ${after.get(t) ? 'ON ' : 'OFF'}  public.${t}`);
  if (stillOff.length) {
    throw new Error(`RLS still OFF after apply: ${stillOff.join(', ')}`);
  }

  // Smoke test: the owner role (backend) must still be able to read every table.
  console.log('\n=== Owner-role read smoke test (backend access must survive RLS) ===');
  for (const t of TABLES) {
    const [{ count }] = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM ${sql(t)};
    `;
    console.log(`  OK  SELECT count(*) FROM public.${t} -> ${count}`);
  }

  console.log('\nAll 11 tables: RLS enabled, owner reads intact.');
  await sql.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('rls-advisor-apply failed:', err);
  process.exit(1);
});
