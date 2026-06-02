/**
 * Read-only RLS advisor check.
 *
 * Reports current row-level-security status for the tables flagged
 * "RLS Disabled in Public" (CRITICAL) by the Supabase advisor, plus the
 * "RLS Enabled No Policy" set for context. Makes NO changes.
 *
 *   npx tsx scripts/rls-advisor-check.ts
 */
import { sql } from '../src/db/client';

const RLS_DISABLED_CRITICAL = [
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
];

async function main() {
  const rows = await sql<Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>>`
    SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname = ANY(${RLS_DISABLED_CRITICAL})
    ORDER BY c.relname;
  `;

  const found = new Map(rows.map((r) => [r.relname, r]));
  console.log('Table'.padEnd(34), 'RLS', '  FORCE', ' status');
  console.log('-'.repeat(60));
  for (const name of RLS_DISABLED_CRITICAL) {
    const row = found.get(name);
    if (!row) {
      console.log(name.padEnd(34), '   -', '     -', ' MISSING (table not found)');
      continue;
    }
    console.log(
      name.padEnd(34),
      row.relrowsecurity ? ' ON' : 'OFF',
      row.relforcerowsecurity ? '  ON ' : '  off',
      row.relrowsecurity ? ' already enabled' : ' NEEDS ENABLE',
    );
  }

  // Identify the DB role we are connected as (owner role bypasses RLS).
  const [{ current_user, current_role }] = await sql<Array<{ current_user: string; current_role: string }>>`
    SELECT current_user, current_role;
  `;
  console.log('-'.repeat(60));
  console.log(`Connected as: current_user=${current_user} current_role=${current_role}`);

  await sql.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('rls-advisor-check failed:', err);
  process.exit(1);
});
