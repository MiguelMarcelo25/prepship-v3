import { sql } from 'drizzle-orm';
import { db } from '../db/client';

/**
 * PS-502 — "does this column exist on THIS database?", for money paths that must run before
 * their migration does.
 *
 * ── WHY IT IS ITS OWN MODULE ────────────────────────────────────────────────────────────
 *
 * These probes started life inside billing-row-status.ts, which is a PURE classifier that
 * contract guards import for isBillingReturnLineType. Adding `db` to it meant importing that
 * classifier validated DATABASE_URL and the Supabase keys at module load — so every guard in
 * the PS-488 PG17 lane died with "Invalid environment variables" before running a single
 * assertion. A local .env hid it completely; CI has no such file, which is exactly why CI is
 * the authority and a green local run is not.
 *
 * ── WHY THE PROBES EXIST AT ALL ─────────────────────────────────────────────────────────
 *
 * Migrations are not applied by deploy here, so code reaches production before its schema BY
 * DESIGN. Three separate canonical money owners — the live billing summary, the invoice
 * totals, and the credit-note projection — referenced `replacement_id` before 0097 was
 * applied, and each one failed for every client with replacement flags off.
 *
 * ── MEMO RULE ───────────────────────────────────────────────────────────────────────────
 *
 * Only TRUE is remembered. Migrations are forward-only and nothing drops these columns, so a
 * positive answer cannot become wrong; a negative one stops being true the moment the
 * migration lands, and caching it left a migrated database looking unmigrated until restart.
 * An explicit connection is never cached at all — the singleton points at production while a
 * harness runs embedded.
 */

type ColumnProbeConn = Pick<typeof db, 'execute'>;

async function probeColumn(
  conn: ColumnProbeConn,
  table: string,
  column: string,
): Promise<boolean> {
  const result = await conn.execute(sql`
    select 1 from information_schema.columns
     where table_schema = current_schema()
       and table_name = ${table}
       and column_name = ${column}
     limit 1
  `);
  const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
  return rows.length > 0;
}

function memoisedTruePresence(table: string, column: string) {
  let present: Promise<boolean> | null = null;
  return (conn?: ColumnProbeConn): Promise<boolean> => {
    if (conn) return probeColumn(conn, table, column);
    present ??= probeColumn(db, table, column)
      .then((found) => {
        if (!found) present = null;
        return found;
      })
      .catch((error) => { present = null; throw error; });
    return present;
  };
}

/** `billing_line_items.replacement_id` — arrives with 0097. */
export const billingLineItemsHasReplacementIdColumn =
  memoisedTruePresence('billing_line_items', 'replacement_id');

/** `billing_credit_notes.replacement_id` — also 0097, and reached by the ORDER reconciler. */
export const billingCreditNotesHasReplacementIdColumn =
  memoisedTruePresence('billing_credit_notes', 'replacement_id');
