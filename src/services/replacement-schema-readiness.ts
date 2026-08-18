import { sql } from 'drizzle-orm';
import { db } from '../db/client';

/**
 * PS-502 — is the replacement schema actually present on THIS database?
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────
 *
 * Migrations are not applied by deploy in this repo, and the PS-502 migrations (0096-0101)
 * are gated behind the designated-operator lane. Code therefore reaches production BEFORE its
 * schema, routinely, by design.
 *
 * That was survivable while every replacement path was reachable only through replacement
 * routes. It stopped being survivable when the AC-16 fan-out was wired into the ORDINARY order
 * cancellation branch, the upstream webhook reconciler, and the billing regeneration fold —
 * three pre-existing hot paths that now query `replacements` unconditionally. On a database
 * without the table, cancelling any order threw `relation "replacements" does not exist`, with
 * every replacement flag off. Hermes reproduced it; so does `npm run test:ps-424-order-lifecycle`.
 *
 * The argument that put it there was "every writer of order_status='cancelled' must fan out, and
 * a rule that holds only where it is currently reachable breaks the day reachability changes".
 * The rule is still right. What was wrong was making a NEW feature's schema a hard prerequisite
 * of an OLD feature's happy path.
 *
 * ── WHY A PROBE AND NOT THE FEATURE FLAG ────────────────────────────────────────────────
 *
 * REPLACEMENTS_ENABLED answers "should operators see this feature". This answers "can this query
 * run at all". They are different questions and conflating them would mean turning the flag on
 * before the migration lands produces the same crash, or that a fully-migrated database with the
 * flag off silently skips holds it should be raising.
 *
 * ── FAIL SAFE, NOT FAIL CLOSED ──────────────────────────────────────────────────────────
 *
 * Absent schema means SKIP, not throw. A replacement cannot exist on a database that has no
 * replacements table, so there is nothing to hold, fold or classify — skipping loses nothing.
 * That is only true because absence is total: once 0096-0101 are applied this returns true
 * forever and every path resumes. It must NOT be used to skip work on a migrated database.
 */

/**
 * Only a TRUE answer is remembered.
 *
 * The first version cached both. A process that booted before the migration lane ran cached
 * `false` and kept returning it after the migration landed — so upstream cancellation
 * reconciliation and the finalized billing fold stayed silently disabled on a fully migrated
 * database until someone restarted the app. The comment above it worried about caching a
 * THROWN error as absent and missed the ordinary false.
 *
 * Presence is permanent — migrations here are forward-only, and nothing drops these tables —
 * so remembering `true` is safe. Absence is a transient state that a migration ends, so it is
 * re-checked every time. The cost of that is one indexed catalogue lookup on a database where
 * the feature does not exist yet.
 */
let present: Promise<boolean> | null = null;

type SchemaProbeConn = Pick<typeof db, 'execute'>;

/**
 * Every relation the guarded callers actually touch, not just the headline table.
 *
 * `replacements` alone did not prove `billing_line_items.replacement_id` (0097) or
 * `replacement_original_order_holds` (0101), and the fold and the sweep need those. The
 * official runner applies 0096-0101 in ONE transaction, so requiring all three cannot
 * strand a partially-migrated database that the supported lane could produce.
 *
 * to_regclass and current_schema() respect the active search_path — an unqualified
 * information_schema lookup would happily find a same-named table in another schema.
 */
async function probe(conn: SchemaProbeConn): Promise<boolean> {
  const result = await conn.execute(sql`
    select
      to_regclass('replacements') is not null as has_replacements,
      to_regclass('replacement_original_order_holds') is not null as has_holds,
      exists (
        select 1 from information_schema.columns
         where table_schema = current_schema()
           and table_name = 'billing_line_items'
           and column_name = 'replacement_id'
      ) as has_replacement_id
  `);
  const rows = (Array.isArray(result)
    ? result
    : ((result as { rows?: unknown[] }).rows ?? [])) as {
      has_replacements: boolean; has_holds: boolean; has_replacement_id: boolean;
    }[];
  const row = rows[0];
  return Boolean(row?.has_replacements && row?.has_holds && row?.has_replacement_id);
}

/**
 * An explicit connection is queried every time and never cached: the singleton points at
 * production while the harness runs embedded, and one shared memo would let a test answer
 * for the real database.
 */
export function replacementSchemaPresent(conn?: SchemaProbeConn): Promise<boolean> {
  if (conn) return probe(conn);
  present ??= probe(db)
    .then((found) => {
      // Forget a NEGATIVE immediately, so the next call re-checks. Remembering it is what
      // kept a migrated database looking unmigrated for the life of the process.
      if (!found) present = null;
      return found;
    })
    .catch((error) => { present = null; throw error; });
  return present;
}

/** Test seam: the memo must not leak between harness databases. */
export function resetReplacementSchemaPresence(): void {
  present = null;
}
