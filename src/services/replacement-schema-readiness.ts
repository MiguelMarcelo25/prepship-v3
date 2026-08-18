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

let present: Promise<boolean> | null = null;

type SchemaProbeConn = Pick<typeof db, 'execute'>;

async function probe(conn: SchemaProbeConn): Promise<boolean> {
  const result = await conn.execute(sql`
    select 1 from information_schema.tables where table_name = 'replacements' limit 1
  `);
  const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
  return rows.length > 0;
}

/**
 * The memo covers the DEFAULT connection only.
 *
 * An explicit connection is queried every time and never cached, because the harness runs
 * against an embedded database while the singleton points at production: one shared memo
 * would let a test answer for the real thing, or the reverse. Caching per connection would
 * be a map keyed on an object nobody can be sure is stable, so it is not worth it — the
 * probe is one indexed lookup and the explicit-connection callers are already inside a
 * transaction doing more work than this.
 */
export function replacementSchemaPresent(conn?: SchemaProbeConn): Promise<boolean> {
  if (conn) return probe(conn);
  present ??= probe(db)
    // A probe that throws must not be cached as "absent" — one transient error would
    // disable every replacement path until the process restarted.
    .catch((error) => { present = null; throw error; });
  return present;
}

/** Test seam: the memo must not leak between harness databases. */
export function resetReplacementSchemaPresence(): void {
  present = null;
}
