import { db } from '../db/client';
import { cancelReplacementBillingInTransaction } from './replacement-billing-writer';
import { settleReplacementCancellationCredits } from './replacement-original-order-hold';

/**
 * PS-502 AC-13 — "do not charge for this replacement", as one operation.
 *
 * ── WHY IT IS NOT IN THE BILLING WRITER ─────────────────────────────────────────────────
 *
 * replacement-billing-writer.ts is transaction-PARASITIC on purpose: every function there
 * takes a `tx` and none opens one, which is what lets the shipped command call it and have a
 * billing failure roll back the stock movement. Two guards pin that property. This owner has
 * to span TWO transactions, so putting it there would have quietly broken the thing that
 * makes the writer safe.
 *
 * ── WHY TWO TRANSACTIONS ────────────────────────────────────────────────────────────────
 *
 * Editable lines are removed in the first. The credit for anything already invoiced is raised
 * after it commits, because the reconciler takes the CLIENT advisory lock while replacement
 * commands hold the ORDER one — nesting them in that order deadlocks against the billing
 * generator, which takes the client lock first.
 *
 * ── WHICH OPERATIONS FUNNEL HERE ────────────────────────────────────────────────────────
 *
 * The audit read a contradiction into the card: the state machine makes `cancelled` reachable
 * pre-ship ONLY, while AC-13 credits money that may already be finalized. Both are true and
 * they do not conflict — a replacement's LIFECYCLE and its MONEY are different things.
 *
 *   - lifecycle `cancelled` is pre-ship, and billing is written at ship, so a cancelled
 *     replacement has no finalized money BY CONSTRUCTION. It can still hold editable lines if
 *     something wrote them early, and those must go.
 *   - billability turned OFF is the money decision. It carries `replacements:billing`, applies
 *     at any status including `shipped`, and is the only operator action that reaches a
 *     replacement whose charge is already invoiced.
 *
 * Both funnel here so the sentence means one thing.
 */
export async function cancelReplacementCharges(
  input: {
    replacementId: number;
    clientId: number;
    actor: { email: string | null; type: string; permissions: readonly string[] };
    reason: string;
    /** Stable per decision: a retried request must settle to the same key. */
    idempotencySeed: string;
  },
  conn: Pick<typeof db, 'transaction'> = db,
): Promise<{ editableRemoved: number; creditsSettled: number; creditedAmount: string }> {
  const removal = await conn.transaction(async (tx) =>
    cancelReplacementBillingInTransaction(tx, { replacementId: input.replacementId }));

  // Nothing invoiced means nothing to credit — the ordinary pre-ship case, and the reason a
  // lifecycle cancellation almost never reaches the reconciler.
  if (removal.invoicedRetained === 0) {
    return { editableRemoved: removal.editableRemoved, creditsSettled: 0, creditedAmount: '0.00' };
  }

  const settled = await settleReplacementCancellationCredits(
    [{ replacementId: input.replacementId, clientId: input.clientId }],
    { reason: input.reason, actor: input.actor, idempotencySeed: input.idempotencySeed },
  );

  return {
    editableRemoved: removal.editableRemoved,
    creditsSettled: settled.settled,
    creditedAmount: settled.creditedAmount,
  };
}
