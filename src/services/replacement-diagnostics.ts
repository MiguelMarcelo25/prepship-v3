import { sql } from 'drizzle-orm';
import { db } from '../db/client';

/**
 * PS-502 item 14 — what an operator needs to see when something is wrong.
 *
 * ── WHY THIS IS NOT A DASHBOARD ─────────────────────────────────────────────────────────
 *
 * Every anomaly here is a state the system CANNOT resolve on its own. That is the whole
 * selection criterion. A replacement sitting in `requested` is not listed, because it is
 * waiting for a person in the ordinary way and a queue already shows it. A replacement that
 * shipped real goods and wrote no billing line IS listed, because nothing downstream will ever
 * notice: the invoice is simply smaller than it should be, and it stays that way.
 *
 * The prior items built commands that fail closed. Failing closed is only half an answer — it
 * converts a silent wrong into a visible stop, and someone still has to see the stop. This is
 * the seeing.
 *
 * ── EVERY ROW CARRIES WHAT IT MEANS AND WHAT TO DO ──────────────────────────────────────
 *
 * A count named `void_reconcile_required` tells an operator nothing unless they already know
 * the codebase. The explanation travels with the number because the person reading it at 2am
 * is not the person who wrote it.
 *
 * ── READ ONLY ───────────────────────────────────────────────────────────────────────────
 *
 * Nothing here writes, and nothing here resolves. An operator acts through the ordinary
 * commands, which keep their guards, their locks and their audit events. A diagnostics tool
 * that could also fix things would be a second way to change state with none of that.
 */

export type ReplacementAnomalySeverity = 'money' | 'blocked' | 'attention';

export type ReplacementAnomaly = {
  kind: string;
  severity: ReplacementAnomalySeverity;
  count: number;
  /** Enough to go and look, never the whole set — this is a signal, not an export. */
  sampleReplacementIds: number[];
  meaning: string;
  action: string;
};

export type ReplacementDiagnostics = {
  anomalies: ReplacementAnomaly[];
  /** True when nothing needs a human. Explicit so a caller cannot mistake [] for "not run". */
  healthy: boolean;
};

type Conn = Pick<typeof db, 'execute'>;

type AnomalyRow = { count: number; ids: number[] | null };

async function countAndSample(
  conn: Conn,
  clause: ReturnType<typeof sql>,
): Promise<AnomalyRow> {
  const result = await conn.execute(sql`
    select count(*)::int as count,
           (array_agg(id order by id desc))[1:10] as ids
    from (${clause}) as anomaly
  `);
  const rows = Array.isArray(result)
    ? result
    : ((result as { rows?: AnomalyRow[] }).rows ?? []);
  const row = rows[0] as AnomalyRow | undefined;
  return { count: row?.count ?? 0, ids: row?.ids ?? [] };
}

/**
 * The anomaly catalogue. Order is deliberate: money first, then things that cannot proceed,
 * then things that merely need a look.
 */
const CATALOGUE: {
  kind: string;
  severity: ReplacementAnomalySeverity;
  meaning: string;
  action: string;
  query: ReturnType<typeof sql>;
}[] = [
  {
    kind: 'shipped_without_billing',
    severity: 'money',
    meaning:
      'A billable replacement reached shipped or completed and carries no replacement billing '
      + 'line. Real stock, a real package and real postage left the building and the client was '
      + 'never charged for any of it.',
    action:
      'Do NOT hand-write a billing line. Find why the shipped command committed without one — '
      + 'it is supposed to write billing inside the same transaction — and fix that path.',
    query: sql`
      select r.id from replacements r
      where r.billable = true
        and r.status in ('shipped', 'completed')
        and not exists (
          select 1 from billing_line_items b where b.replacement_id = r.id
        )
    `,
  },
  {
    kind: 'unresolved_label_purchase_intent',
    severity: 'money',
    meaning:
      'A label purchase reached the provider and never resolved locally. Postage may already '
      + 'have been bought with nothing here pointing at it, which is exactly the case a missing '
      + 'local receipt cannot rule out.',
    action:
      'Reconcile against the provider before doing anything else. Never cancel the replacement '
      + 'to clear this — cancelling strands the purchase instead of resolving it.',
    query: sql`
      select r.id from replacements r
      join replacement_label_purchase_intents i on i.replacement_id = r.id
      where i.state in ('provider_pending', 'reconcile_required')
        and (i.void_state is null or i.void_state <> 'voided')
    `,
  },
  {
    kind: 'void_reconcile_required',
    severity: 'money',
    meaning:
      'A label void was attempted and the provider did not confirm it. The label is neither '
      + 'reliably live nor reliably dead, and the system will not retry on its own.',
    action:
      'Confirm the label\'s real state with the carrier, then resolve the intent. A voided '
      + 'replacement can never buy another label, so do not void again speculatively.',
    query: sql`
      select r.id from replacements r
      join replacement_label_purchase_intents i on i.replacement_id = r.id
      where i.void_state = 'void_reconcile_required'
    `,
  },
  {
    kind: 'open_original_order_hold',
    severity: 'blocked',
    meaning:
      'The original order was cancelled or refunded and a decision about this replacement is '
      + 'still owed — including, for a delivered one, whether the client still pays.',
    action:
      'Read the hold\'s open question and resolve it through the ordinary commands. The hold '
      + 'records what it acted on, so it can be audited afterwards.',
    query: sql`
      select h.replacement_id as id from replacement_original_order_holds h
      where h.resolved_at is null
    `,
  },
  {
    kind: 'blocked_in_review',
    severity: 'blocked',
    meaning:
      'A replacement is parked in review and cannot proceed until a person resolves it. The '
      + 'review reason says which of the several possible problems it is.',
    action:
      'Resolve through the review endpoint, which asserts the transition and records one event. '
      + 'Never edit the status column directly.',
    query: sql`
      select r.id from replacements r where r.status = 'review'
    `,
  },
  {
    kind: 'label_created_never_shipped',
    severity: 'attention',
    meaning:
      'Postage was bought and nothing was dispatched. Not wrong on its own — a label can sit '
      + 'legitimately — but a growing count here is postage being spent and not used.',
    action:
      'Ship it, or void the label deliberately and cancel. Leaving it is the one option that '
      + 'costs money quietly.',
    query: sql`
      select r.id from replacements r
      where r.status = 'label_created'
        and r.label_created_at < now() - interval '7 days'
    `,
  },
];

export async function collectReplacementDiagnostics(
  conn: Conn = db,
): Promise<ReplacementDiagnostics> {
  const anomalies: ReplacementAnomaly[] = [];

  for (const entry of CATALOGUE) {
    const { count, ids } = await countAndSample(conn, entry.query);
    // Zero-count classes are omitted rather than reported as zero. A list of twelve zeroes and
    // one three is a list someone stops reading; `healthy` below carries "nothing is wrong".
    if (count === 0) continue;
    anomalies.push({
      kind: entry.kind,
      severity: entry.severity,
      count,
      sampleReplacementIds: (ids ?? []).map(Number),
      meaning: entry.meaning,
      action: entry.action,
    });
  }

  return { anomalies, healthy: anomalies.length === 0 };
}
