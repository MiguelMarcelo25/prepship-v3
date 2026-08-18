import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { billingLineItems } from '../db/schema/billing.js';
import { roundMoney } from '../lib/money.js';

/**
 * PS-502 AC-6 at the FINALIZATION layer — the same defect item 9 fixed one layer down.
 *
 * A replacement line carries `order_id = originalOrder.id`, and the finalized reconciler's
 * frozen total sums EVERY invoiced line on the order with no line-type filter, so it counts
 * them. The candidate total is built from the freshly generated outbound plan, which never
 * emits replacement lines — the shipped command persists them once and nothing regenerates
 * them.
 *
 * So frozen exceeded current by exactly the replacement charge, and every regeneration of a
 * finalized order appended a credit that erased money the client genuinely owes for a re-ship
 * that consumed real stock and real postage. Nothing errored; the client simply stopped being
 * billed. Item 9 stopped the rebuild sweep DELETING these lines. This stops the reconciler
 * CREDITING them away.
 *
 * Scoped to `invoiced = true` so it adds back PRECISELY what the frozen query counted:
 * replacement money then contributes zero to the delta and only genuine outbound changes
 * drive an adjustment. A replacement line written after the close is not frozen money and
 * belongs to the open period, which ordinary billing already owns.
 *
 * A separate module rather than an inline block because a fold that cannot be called cannot
 * be proven, and this one silently destroys money when it is absent.
 */
export async function foldFinalizedReplacementTotalsIntoCandidates(
  finalizedOrderIds: Iterable<number>,
  candidatesByClient: Map<number, Map<number, number>>,
  conn: Pick<typeof db, 'select'> = db,
): Promise<{ ordersFolded: number; amountFolded: number }> {
  const orderIds = [...finalizedOrderIds];
  if (orderIds.length === 0) return { ordersFolded: 0, amountFolded: 0 };

  const rows = await conn
    .select({
      clientId: billingLineItems.clientId,
      orderId: billingLineItems.orderId,
      totalCost: billingLineItems.totalCost,
    })
    .from(billingLineItems)
    .where(and(
      inArray(billingLineItems.orderId, orderIds),
      isNotNull(billingLineItems.replacementId),
      eq(billingLineItems.invoiced, true),
    ));

  const touched = new Set<number>();
  let amountFolded = 0;
  for (const row of rows) {
    if (row.orderId == null) continue;
    let clientTotals = candidatesByClient.get(row.clientId);
    if (!clientTotals) {
      clientTotals = new Map<number, number>();
      candidatesByClient.set(row.clientId, clientTotals);
    }
    const amount = Number(row.totalCost);
    clientTotals.set(row.orderId, roundMoney((clientTotals.get(row.orderId) ?? 0) + amount));
    touched.add(row.orderId);
    amountFolded = roundMoney(amountFolded + amount);
  }

  return { ordersFolded: touched.size, amountFolded };
}
