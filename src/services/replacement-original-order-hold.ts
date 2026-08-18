import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  replacements,
  replacementOriginalOrderHolds,
  replacementLabelPurchaseIntents,
  type ReplacementRow,
} from '../db/schema/replacements';
import { billingLineItems } from '../db/schema/billing';
import {
  annotateReplacementOriginalOrderInTransaction,
  cancelReplacementForOriginalOrderInTransaction,
  enterReplacementReview,
  type LifecycleActor,
} from './replacement-lifecycle-command';
import { cancelReplacementBillingInTransaction } from './replacement-billing-writer';
import { reconcileFinalizedBillingReplacementAdjustment } from './billing-finalization-policy';
import { roundMoney } from '../lib/money';

/**
 * PS-502 AC-16 — the original order was cancelled or refunded. What happens to its replacements.
 *
 * ── WHAT THIS IS ────────────────────────────────────────────────────────────────────────
 *
 * A fan-out of HOLDS, not a status change on the order and not a billing action. Every
 * replacement hanging off the order is classified by the phase it has reached, and moved to
 * the strongest state that phase legally permits. Where the phase makes the answer a money
 * question, this refuses to answer it and records the question for a human.
 *
 * ── WHY IT IS NOT THE DRIFT PATH ────────────────────────────────────────────────────────
 *
 * The card is explicit that a cancelled original keeps its OWN review path. The two lead an
 * operator to different actions: drift means "the line you asked for is not where it was, look
 * at the order"; this means "there is no order any more, decide about the money". Sharing
 * `original_order_line_drift` would make the review queue unable to tell them apart.
 *
 * ── WHY THE EVIDENCE IS A POINTER ───────────────────────────────────────────────────────
 *
 * A hold is raised because a RECEIPT exists — a row in `order_lifecycle_events` or
 * `webhook_events`, or a named operator. Nothing here reads `orders.order_status` as prose and
 * nothing parses `reason`. That is the discipline PS-488 established and the drift path
 * already keeps.
 *
 * ── THE LOCK ────────────────────────────────────────────────────────────────────────────
 *
 * Class 36423 on the ORIGINAL ORDER id — the same lock every replacement command takes. That
 * is what makes this safe against an in-flight `shipReplacement`: either the ship completes and
 * this sees `shipped` (and annotates rather than cancels), or this completes and the ship finds
 * a status that is no longer `label_created` and refuses. There is no interleaving in which a
 * replacement is cancelled and dispatched.
 */

export type ReplacementHoldTriggerKind = 'order_cancelled' | 'order_refunded';

export type ReplacementHoldEvidence =
  | { kind: 'order_lifecycle_event'; orderLifecycleEventId: number }
  | { kind: 'webhook_event'; webhookEventId: number }
  | { kind: 'operator_declaration'; declaredBy: string };

export type ReplacementHoldOutcome = {
  replacementId: number;
  phase: 'pre_dispatch' | 'pre_dispatch_label_at_risk' | 'post_dispatch' | 'terminal_no_action';
  disposition: 'cancelled' | 'review' | 'flagged_post_dispatch' | 'no_action';
  openQuestion: string | null;
  /** Cancellation retained invoiced lines; a credit is owed once this transaction commits. */
  finalizedCreditOwed: boolean;
};

export type ReplacementHoldSweepResult = {
  considered: number;
  outcomes: ReplacementHoldOutcome[];
  /**
   * Replacements whose cancellation left INVOICED money behind.
   *
   * Deleting an invoiced line is not an option — a finalized charge is history — so the
   * difference has to become an append-only credit. That credit cannot be raised here:
   * `reconcileFinalizedBillingReplacementAdjustment` takes the CLIENT lock (36421) and this
   * sweep already holds the ORDER lock (36423). Taking them in that order, when the billing
   * generator takes the client lock first, is a deadlock waiting for two clients to cancel
   * at once.
   *
   * So the sweep reports, and the caller settles AFTER this transaction commits. The debt is
   * durable in the meantime: the invoiced rows are still there and still attributable.
   */
  finalizedCreditPending: { replacementId: number; clientId: number }[];
  /**
   * Replacements left untouched because they already carry an OPEN hold — this signal
   * replayed, or an earlier one still awaiting a human.
   */
  alreadyHeld: number;
};

/** Real money may be committed at the provider even with no confirmed local receipt. */
const INTENT_AT_RISK_STATES = ['provider_pending', 'reconcile_required', 'purchased'] as const;

function evidenceColumns(evidence: ReplacementHoldEvidence) {
  return {
    evidenceKind: evidence.kind,
    orderLifecycleEventId:
      evidence.kind === 'order_lifecycle_event' ? evidence.orderLifecycleEventId : null,
    webhookEventId: evidence.kind === 'webhook_event' ? evidence.webhookEventId : null,
    declaredBy: evidence.kind === 'operator_declaration' ? evidence.declaredBy : null,
  };
}

/** Stable per (replacement, evidence): the SAME signal replayed collides instead of stacking. */
function evidenceKey(evidence: ReplacementHoldEvidence): string {
  if (evidence.kind === 'order_lifecycle_event') return `lifecycle:${evidence.orderLifecycleEventId}`;
  if (evidence.kind === 'webhook_event') return `webhook:${evidence.webhookEventId}`;
  return `operator:${evidence.declaredBy}`;
}

export async function raiseReplacementOriginalOrderHoldsInTransaction(
  tx: any,
  input: {
    orderId: number;
    triggerKind: ReplacementHoldTriggerKind;
    evidence: ReplacementHoldEvidence;
    reason: string;
    actor: LifecycleActor;
  },
): Promise<ReplacementHoldSweepResult> {
  await tx.execute(sql`select pg_advisory_xact_lock(36423, ${input.orderId})`);

  const rows: ReplacementRow[] = await tx
    .select()
    .from(replacements)
    .where(eq(replacements.orderId, input.orderId))
    .orderBy(replacements.id);

  const outcomes: ReplacementHoldOutcome[] = [];
  const finalizedCreditPending: { replacementId: number; clientId: number }[] = [];
  let alreadyHeld = 0;

  for (const before of rows) {
    const idempotencyKey =
      `replacement:${before.id}:original-order-hold:${input.triggerKind}:${evidenceKey(input.evidence)}`;

    // Skip if this replacement is ALREADY HELD — either by this exact signal replayed, or by
    // an earlier one still awaiting a human.
    //
    // Matching only the idempotency key is not enough, and the database says so: the partial
    // unique index permits one OPEN hold per replacement, so a second cancellation signal
    // with different evidence would abort the whole sweep on a constraint violation — taking
    // every other replacement on the order down with it.
    //
    // Skipping is also the right answer on its own terms. A replacement already parked for a
    // decision does not need a second question stacked on it, and re-classifying it would
    // overwrite the phase a human is currently looking at. The first signal's hold stands
    // until someone resolves it.
    const [existing] = await tx
      .select({ id: replacementOriginalOrderHolds.id })
      .from(replacementOriginalOrderHolds)
      .where(and(
        eq(replacementOriginalOrderHolds.replacementId, before.id),
        sql`(${replacementOriginalOrderHolds.resolvedAt} is null
             or ${replacementOriginalOrderHolds.idempotencyKey} = ${idempotencyKey})`,
      ))
      .limit(1);
    if (existing) {
      alreadyHeld += 1;
      continue;
    }

    const outcome = await classifyAndAct(tx, before, input);
    outcomes.push(outcome);
    if (outcome.finalizedCreditOwed) {
      finalizedCreditPending.push({
        replacementId: before.id,
        clientId: (before as { clientId: number }).clientId,
      });
    }

    await tx.insert(replacementOriginalOrderHolds).values({
      replacementId: before.id,
      orderId: input.orderId,
      triggerKind: input.triggerKind,
      ...evidenceColumns(input.evidence),
      reason: input.reason,
      phase: outcome.phase,
      disposition: outcome.disposition,
      openQuestion: outcome.openQuestion,
      statusAtHold: before.status,
      stateVersionAtHold: before.stateVersion,
      idempotencyKey,
      // A hold with nothing for a human to decide is closed on the spot, so the operator
      // queue holds only real questions. The row still exists, because "the sweep saw this
      // replacement and had nothing to do" is itself worth being able to prove.
      ...(outcome.disposition === 'no_action'
        ? {
          resolvedAt: new Date(),
          resolvedBy: input.actor.email ?? 'system',
          resolution: 'no_action_required',
        }
        : {}),
    });
  }

  return { considered: rows.length, outcomes, alreadyHeld, finalizedCreditPending };
}

async function classifyAndAct(
  tx: any,
  before: ReplacementRow,
  input: {
    triggerKind: ReplacementHoldTriggerKind;
    reason: string;
    actor: LifecycleActor;
  },
): Promise<ReplacementHoldOutcome> {
  const base = { replacementId: before.id };

  // ── Already finished with. Nothing to move, nothing to decide. ────────────────────────
  if (before.status === 'cancelled' || before.status === 'rejected') {
    return {
      ...base, phase: 'terminal_no_action', disposition: 'no_action',
      openQuestion: null, finalizedCreditOwed: false,
    };
  }

  // ── Dispatched. Real stock left, real postage was spent. Status is never touched. ──────
  if (before.status === 'shipped' || before.status === 'completed') {
    await annotateReplacementOriginalOrderInTransaction(tx, before, {
      actor: input.actor,
      reason: input.reason,
      eventType: `replacement_original_order_${input.triggerKind === 'order_refunded' ? 'refunded' : 'cancelled'}`,
    });
    return {
      ...base,
      phase: 'post_dispatch',
      disposition: 'flagged_post_dispatch',
      // Deliberately unanswered. The goods went out; whether the client still pays for them
      // when the original was reversed is a billing-authority decision, and guessing it here
      // would either bill for something nobody owes or silently forgive real money.
      openQuestion: 'does_the_client_still_pay_for_a_delivered_replacement',
      // The goods went out. Nothing is credited without a human deciding it should be.
      finalizedCreditOwed: false,
    };
  }

  // ── A live label. Postage is already spent and could still be used. ───────────────────
  //
  // Never auto-void. A void is a one-way door — claimPurchase replays on `purchased` with no
  // void_state filter, so a voided replacement can never buy another label — and voiding is a
  // provider action that a local cancellation must not perform on its own authority.
  //
  // `review` IS the shipping block: shipReplacement demands `label_created`, so this
  // structurally prevents dispatch without a second gate, and the shared 36423 lock closes
  // the race against a ship already in flight.
  if (before.status === 'label_created') {
    await enterReplacementReview(tx, before, {
      reviewReason: 'original_order_cancelled_label_live',
      eventType: 'replacement_original_order_cancelled',
      actor: input.actor,
      reason: input.reason,
      idempotencySuffix: 'original-order-hold',
    });
    return {
      ...base,
      phase: 'pre_dispatch_label_at_risk',
      disposition: 'review',
      openQuestion: 'void_or_retain_purchased_label',
      finalizedCreditOwed: false,
    };
  }

  // ── Pre-dispatch, but a purchase may be in flight at the provider. ────────────────────
  //
  // A missing local receipt is not proof that nothing was bought — that is the whole reason
  // the intent table exists. Cancelling here could strand real postage with nothing pointing
  // at it.
  const [openIntent] = await tx
    .select({ id: replacementLabelPurchaseIntents.id })
    .from(replacementLabelPurchaseIntents)
    .where(and(
      eq(replacementLabelPurchaseIntents.replacementId, before.id),
      sql`${replacementLabelPurchaseIntents.state} in ${INTENT_AT_RISK_STATES}`,
      sql`(${replacementLabelPurchaseIntents.voidState} is null or ${replacementLabelPurchaseIntents.voidState} <> 'voided')`,
    ))
    .limit(1);

  if (openIntent) {
    await enterReplacementReview(tx, before, {
      reviewReason: 'original_order_cancelled_label_unresolved',
      eventType: 'replacement_original_order_cancelled',
      actor: input.actor,
      reason: input.reason,
      idempotencySuffix: 'original-order-hold',
    });
    return {
      ...base,
      phase: 'pre_dispatch_label_at_risk',
      disposition: 'review',
      openQuestion: 'resolve_label_purchase_intent_before_cancelling',
      finalizedCreditOwed: false,
    };
  }

  // ── Pre-dispatch with money already invoiced. That should be impossible. ──────────────
  //
  // Billing lines are written by the shipped command and nowhere else, so a pre-dispatch
  // replacement carrying an invoiced line means an assumption elsewhere is wrong. Fail into
  // review rather than cancelling: an anomaly is not a licence to delete.
  const invoiced = await tx
    .select({ id: billingLineItems.id })
    .from(billingLineItems)
    .where(and(
      eq(billingLineItems.replacementId, before.id),
      eq(billingLineItems.invoiced, true),
    ))
    .limit(1);

  if (invoiced.length > 0) {
    await enterReplacementReview(tx, before, {
      reviewReason: 'original_order_cancelled_unexpected_billing',
      eventType: 'replacement_original_order_cancelled',
      actor: input.actor,
      reason: input.reason,
      idempotencySuffix: 'original-order-hold',
    });
    return {
      ...base,
      phase: 'pre_dispatch_label_at_risk',
      disposition: 'review',
      openQuestion: 'invoiced_money_on_an_undispatched_replacement',
      finalizedCreditOwed: false,
    };
  }

  // ── Nothing spent. Cancel it. ─────────────────────────────────────────────────────────
  await cancelReplacementForOriginalOrderInTransaction(tx, before, {
    actor: input.actor,
    reason: input.reason,
  });
  const billing = await cancelReplacementBillingInTransaction(tx, { replacementId: before.id });

  return {
    ...base, phase: 'pre_dispatch', disposition: 'cancelled', openQuestion: null,
    // Editable lines are gone; anything invoiced survives and is owed a credit the caller
    // raises once this transaction has committed.
    finalizedCreditOwed: billing.invoicedRetained > 0,
  };
}

/** Open holds for an order — what a human still owes an answer to. */
export async function findOpenReplacementOriginalOrderHolds(
  tx: any,
  orderId: number,
): Promise<{ id: number; replacementId: number; openQuestion: string | null }[]> {
  return tx
    .select({
      id: replacementOriginalOrderHolds.id,
      replacementId: replacementOriginalOrderHolds.replacementId,
      openQuestion: replacementOriginalOrderHolds.openQuestion,
    })
    .from(replacementOriginalOrderHolds)
    .where(and(
      eq(replacementOriginalOrderHolds.orderId, orderId),
      isNull(replacementOriginalOrderHolds.resolvedAt),
    ));
}

/**
 * PS-502 AC-13 — raise the credits a cancellation left owed.
 *
 * MUST run after the sweep's transaction has committed. The reconciler takes the CLIENT
 * advisory lock and the sweep holds the ORDER one; nesting them in that order deadlocks
 * against the billing generator, which takes the client lock first.
 *
 * This is the caller the reconciler never had. It existed, was guarded, was proven correct in
 * isolation, and was invoked by nothing — so a cancellation of a finalized replacement
 * removed the editable lines, dutifully preserved the invoiced ones, and left the client
 * charged. Every part worked; the wire between them did not exist.
 *
 * The idempotency key is derived from the HOLD, which is itself keyed on (replacement,
 * evidence). A replayed signal therefore produces the same key and the reconciler refuses a
 * second credit for the same finalization.
 */
export async function settleReplacementCancellationCredits(
  pending: readonly { replacementId: number; clientId: number }[],
  input: { reason: string; actor: LifecycleActor; idempotencySeed: string },
  /** Injected so the settlement can be proven against the embedded harness. */
  conn?: Parameters<typeof reconcileFinalizedBillingReplacementAdjustment>[1],
): Promise<{ settled: number; creditedAmount: string }> {
  let settled = 0;
  let credited = 0;

  for (const item of pending) {
    const result = await reconcileFinalizedBillingReplacementAdjustment({
      clientId: item.clientId,
      replacementId: item.replacementId,
      actorId: input.actor.email ?? 'system',
      actorEmail: input.actor.email ?? null,
      reason: input.reason,
      idempotencyKey: `replacement:${item.replacementId}:cancel:${input.idempotencySeed}`,
    }, conn);
    if (result.adjustedCount > 0) settled += 1;
    credited = roundMoney(credited + Number(result.creditedAmount));
  }

  return { settled, creditedAmount: credited.toFixed(2) };
}
