import { sql as pg } from '../../db/client.js';

/**
 * PS-469: bound automation_runs so the engine's history cannot grow without limit.
 *
 * The loop that filled this table is fixed -- three separate causes, each a value that
 * changed on every write sitting inside a fingerprint meant to describe content. Growth
 * collapsed from ~200 MB/day to about 7 rows/hour. What remains is 926 MB of pre-fix
 * rows: measured 2026-08-01, 380,565 of 380,643 rows (99.98%) predate the final fix.
 *
 * This is the bound, not a cleanup. It deletes nothing today -- the oldest row is
 * 2026-07-25, inside every window below -- and ages the pre-fix block out on its own.
 * The point is that the table can never again grow unbounded, whatever the next trigger
 * bug turns out to be.
 */

/**
 * A run that never matched a rule version is a record that the engine looked and found
 * nothing. After 30 days that answers no question anyone asks.
 */
export const AUTOMATION_RUN_RETENTION_DAYS = 30;

/**
 * Rows per DELETE. 371,714 rows will become eligible at once when the pre-fix block
 * ages out, and one statement that size would hold locks and bloat WAL for minutes on a
 * database already documented as compute-starved. Small batches keep each transaction
 * short; the schedule catches up over several ticks.
 */
export const AUTOMATION_RUN_RETENTION_BATCH = 2_000;

/** Batches per invocation, so one maintenance tick cannot run long. */
export const AUTOMATION_RUN_RETENTION_MAX_BATCHES = 5;

/**
 * Delete expired automation runs that carry NO evidence a rule took effect.
 *
 * The evidence rule is not a nicety. `ruleExecutionHistoryExists`
 * (execution-history.ts) decides whether deleting an automation rule is REFUSED,
 * and it reads `matched_rule_version_ids` on this table. Pruning a row that carries
 * matched versions would erase the proof that a rule affected real orders -- and a rule
 * that really ran would silently become deletable, taking its audit trail with it.
 *
 * So rows with matched_rule_version_ids (or a rule_id, kept defensively because
 * execution-history checks it too) are retained regardless of age. On 2026-08-01 that is
 * 8,929 of 380,643 rows: 2.3%, and the only 2.3% anyone would ever ask about.
 *
 * Deliberately NOT deleting by `id IN (...)` of a prior SELECT: between the read and the
 * write a run could finish and gain matched versions. The subquery re-checks the evidence
 * predicate inside the same statement.
 */
export async function pruneExpiredAutomationRuns(
  retentionDays: number = AUTOMATION_RUN_RETENTION_DAYS,
  conn: typeof pg = pg,
): Promise<{ deleted: number; batches: number; reachedLimit: boolean }> {
  if (!(retentionDays > 0)) return { deleted: 0, batches: 0, reachedLimit: false };

  let deleted = 0;
  let batches = 0;
  for (let i = 0; i < AUTOMATION_RUN_RETENTION_MAX_BATCHES; i += 1) {
    const rows = await conn`
      DELETE FROM automation_runs
      WHERE id IN (
        SELECT id FROM automation_runs
        WHERE started_at < now() - make_interval(days => ${retentionDays})
          AND rule_id IS NULL
          AND (
            matched_rule_version_ids IS NULL
            OR array_length(matched_rule_version_ids, 1) IS NULL
          )
        ORDER BY id
        LIMIT ${AUTOMATION_RUN_RETENTION_BATCH}
      )
    `;
    const count = (rows as unknown as { count?: number }).count ?? 0;
    batches += 1;
    deleted += count;
    if (count < AUTOMATION_RUN_RETENTION_BATCH) {
      return { deleted, batches, reachedLimit: false };
    }
  }
  // More remained than this tick would take. The schedule picks it up next run rather
  // than letting one maintenance tick delete unboundedly.
  return { deleted, batches, reachedLimit: true };
}
