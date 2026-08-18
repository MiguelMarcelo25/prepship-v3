import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { roundMoney } from '../lib/money.js';
import { replacementSchemaPresent } from './replacement-schema-readiness.js';

/**
 * PS-502 AC-6 at the FINALIZATION layer — the same defect item 9 fixed one layer down.
 *
 * A replacement line carries `order_id = originalOrder.id`, and the finalized reconciler's
 * frozen total sums EVERY invoiced line on the order with no line-type filter, so it counts
 * them. The candidate total is built from the freshly generated outbound plan, which never
 * emits replacement lines — the shipped command persists them once and nothing regenerates
 * them. Without this fold, frozen exceeded current by exactly the replacement charge and every
 * regeneration of a finalized order appended a credit erasing money the client genuinely owed.
 *
 * ── WHY IT TAKES A PERIOD ───────────────────────────────────────────────────────────────
 *
 * The first version took only order ids and summed EVERY invoiced replacement line on them.
 * That is not what the frozen side counts. The reconciler joins `billing_finalizations` and
 * counts a line only when its effective date falls inside a CLOSED period overlapping the
 * window being regenerated.
 *
 * So a replacement invoiced in period A, on an order whose ordinary billing was finalized in
 * period B, was added to candidate B while frozen B knew nothing about it — and the reconciler
 * emitted a DEBIT for the difference, charging the client a second time for a re-ship they had
 * already paid for on an earlier invoice. The original code could not tell "invoiced" from
 * "frozen in THIS finalization", and those are different facts.
 *
 * The join and the overlap predicate below deliberately mirror the reconciler's, because the
 * entire purpose is for the two sides to count the same money. When they do, replacement
 * charges contribute zero to the delta and only genuine outbound changes drive an adjustment.
 *
 * ── WHY THE DISTINCT SUB-SELECT ─────────────────────────────────────────────────────────
 *
 * If two closed periods ever overlap, one line joins both and is counted twice. Migration 0065
 * prevents new overlapping finalizations, so this is a legacy/import concern rather than a
 * reachable path on a clean database — but a fold that silently doubles a charge under a
 * condition the schema merely discourages is not worth defending, and counting each line id
 * once costs nothing.
 */
export async function foldFinalizedReplacementTotalsIntoCandidates(
  finalizedOrderIds: Iterable<number>,
  candidatesByClient: Map<number, Map<number, number>>,
  /** The window being regenerated — the SAME bounds the reconciler is given. */
  period: { dateFrom: string; dateTo: string },
  conn: Pick<typeof db, 'execute'> = db,
): Promise<{ ordersFolded: number; amountFolded: number }> {
  const orderIds = [...finalizedOrderIds];
  if (orderIds.length === 0) return { ordersFolded: 0, amountFolded: 0 };

  // Billing regeneration is a pre-existing path that runs on every database, migrated or not.
  // `billing_line_items.replacement_id` arrives with 0097.
  if (!(await replacementSchemaPresent(conn))) return { ordersFolded: 0, amountFolded: 0 };

  const result = await conn.execute(sql`
    select "clientId", "orderId", coalesce(sum("totalCost"), 0)::text as "total"
    from (
      select distinct
        line.id as "lineId",
        line.client_id as "clientId",
        line.order_id as "orderId",
        line.total_cost as "totalCost"
      from billing_line_items line
      join billing_finalizations closed
        on closed.client_id = line.client_id
        and coalesce(line.billing_effective_date, line.ship_date) >= closed.period_start
        and coalesce(line.billing_effective_date, line.ship_date) < closed.period_end
      where line.order_id in (${sql.join(orderIds.map((id) => sql`${id}`), sql`, `)})
        and line.replacement_id is not null
        and line.invoiced = true
        and closed.period_start < ${period.dateTo}::timestamptz
        and closed.period_end > ${period.dateFrom}::timestamptz
    ) frozen_replacement_lines
    group by "clientId", "orderId"
  `);

  const rows = (Array.isArray(result)
    ? result
    : ((result as { rows?: unknown[] }).rows ?? [])) as {
      clientId: number; orderId: number; total: string;
    }[];

  let amountFolded = 0;
  for (const row of rows) {
    if (row.orderId == null) continue;
    const clientId = Number(row.clientId);
    const orderId = Number(row.orderId);
    let clientTotals = candidatesByClient.get(clientId);
    if (!clientTotals) {
      clientTotals = new Map<number, number>();
      candidatesByClient.set(clientId, clientTotals);
    }
    const amount = Number(row.total);
    clientTotals.set(orderId, roundMoney((clientTotals.get(orderId) ?? 0) + amount));
    amountFolded = roundMoney(amountFolded + amount);
  }

  return { ordersFolded: rows.length, amountFolded };
}
