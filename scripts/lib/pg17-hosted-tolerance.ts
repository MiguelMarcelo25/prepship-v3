/**
 * PS-510 — the ONE explicit tolerance policy shared by the real-PostgreSQL lanes.
 *
 * This replaces `catch { /* supabase artefacts non-fatal *\/ }`.
 *
 * That bare catch tolerated every error, from every migration, for no stated reason. It is how
 * two of migration 0104's occurrence-identity objects went missing without a single red lane —
 * confirmed by hosted readback (run 33121719782): ABSENT/COMPROMISED.
 *
 * Every rule here names an exact migration file, an exact SQLSTATE, and why. Anything else is
 * fatal and names itself. Adding a rule is a deliberate, reviewable act; the planner rejects
 * wildcards outright.
 *
 * IF A LANE FAILS BECAUSE A MIGRATION ERROR IS NOT LISTED HERE, THAT IS THE FEATURE.
 * Diagnose the error. Do not add a broad rule to make it quiet.
 */
import type { ToleranceRule } from './migration-execution-plan.js';

/**
 * Disposable PostgreSQL 17 in hosted CI is not Supabase: it has no `supabase_admin`,
 * `anon`, `authenticated` or `service_role` roles, and no Supabase-owned schemas. Migrations
 * that GRANT to those roles, or that assume Supabase-managed objects, therefore fail on a
 * bare cluster in ways that say nothing about application schema fidelity.
 *
 * Deliberately NOT tolerated here:
 *   42P07 duplicate_table / 42710 duplicate_object on application objects — those would hide
 *   a genuine ordering defect.
 *   25001 active_sql_transaction — that is precisely the CONCURRENTLY failure PS-510 fixes by
 *   phase routing. If it ever appears again, the plan is wrong and the lane must go red.
 */
export const PG17_HOSTED_TOLERANCE: ToleranceRule[] = [
  {
    file: '0037_rls_reporting_metrics_inbound.sql',
    sqlstate: '42P01', // undefined_table
    reason: 'RLS over inbound_shipments, a table this repo does not own and does not create',
  },
  {
    file: '0045_revoke_public_api_grants.sql',
    sqlstate: '42704', // undefined_object
    reason: 'revokes from the Supabase anon role, which does not exist on a vanilla server',
  },
  {
    file: '0069_public_billing_rls_hardening.sql',
    sqlstate: '42704', // undefined_object
    reason: 'same Supabase-only anon role',
  },
  {
    file: '0094_pin_function_search_path.sql',
    sqlstate: '3F000', // invalid_schema_name
    reason: 'pgboss schema is created by the pg-boss library at runtime; these harnesses never start the worker',
  },
  {
    file: '0058_search_trgm_indexes.sql',
    sqlstate: '58P01', // undefined_file — extension control file absent
    reason: 'pg_trgm contrib may be absent depending on image; trgm indexes are search performance, not correctness',
  },
];

/**
 * Build a tolerance policy for a specific migration file and SQLSTATE. Kept as a helper so a
 * caller that genuinely needs one records it at the call site with its reason visible in review,
 * rather than reaching for a wildcard.
 */
export function tolerate(file: string, sqlstate: string, reason: string): ToleranceRule {
  return { file, sqlstate, reason };
}
