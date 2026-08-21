import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client';
import {
  replacements,
  replacementOriginalOrderHolds,
  replacementLabelPurchaseIntents,
  replacementFinancialActions,
  type ReplacementRow,
} from '../db/schema/replacements';
import { billingLineItems } from '../db/schema/billing';
import { shipments } from '../db/schema/shipments';
import {
  annotateReplacementOriginalOrderInTransaction,
  cancelReplacementForOriginalOrderInTransaction,
  enterReplacementReview,
  prepareReplacementTerminalTransitionInTransaction,
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
      ...(outcome.disposition === 'no_action' || outcome.disposition === 'cancelled'
        ? {
          resolvedAt: new Date(),
          resolvedBy: input.actor.email ?? 'system',
          resolution: outcome.disposition === 'cancelled'
            ? 'clean_pre_dispatch_replacement_cancelled'
            : 'no_action_required',
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

  // Per user override `unlock shipped data` on 2026-08-19: shipped_at, not a status label,
  // is authoritative dispatch evidence. Shipped history is preserved even if an older bug
  // left lifecycle text inconsistent with the physical dispatch fact.
  if (before.shippedAt != null) {
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
      openQuestion: before.status === 'shipped' || before.status === 'completed'
        ? 'does_the_client_still_pay_for_a_delivered_replacement'
        : 'dispatch_evidence_disagrees_with_lifecycle_and_financials_need_review',
      // The goods went out. Nothing is credited without a human deciding it should be.
      finalizedCreditOwed: false,
    };
  }

  // A shipped/completed lifecycle without authoritative dispatch evidence is not a licence
  // to treat the replacement as delivered or clean. Park it under its OWN original-order
  // reason so an operator sees the inconsistency rather than the unrelated drift reason.
  if (before.status === 'shipped' || before.status === 'completed') {
    await enterReplacementReview(tx, before, {
      reviewReason: 'original_order_cancelled_dispatch_inconsistent',
      eventType: 'replacement_original_order_dispatch_inconsistent',
      actor: input.actor,
      reason: input.reason,
      idempotencySuffix: 'original-order-dispatch-inconsistent',
    });
    return {
      ...base,
      phase: 'pre_dispatch_label_at_risk',
      disposition: 'review',
      openQuestion: 'resolve_lifecycle_dispatch_inconsistency',
      finalizedCreditOwed: false,
    };
  }

  // The intent ledger, not lifecycle display text, is the postage authority. The canonical
  // void command deliberately leaves status at label_created but marks the purchased intent
  // voided; that is no longer a live label and must remain eligible for the amended AC-16
  // clean pre-dispatch cancellation path.
  const [atRiskIntent] = await tx
    .select({
      id: replacementLabelPurchaseIntents.id,
      state: replacementLabelPurchaseIntents.state,
    })
    .from(replacementLabelPurchaseIntents)
    .where(and(
      eq(replacementLabelPurchaseIntents.replacementId, before.id),
      sql`${replacementLabelPurchaseIntents.state} in ${INTENT_AT_RISK_STATES}`,
      sql`(${replacementLabelPurchaseIntents.voidState} is null or ${replacementLabelPurchaseIntents.voidState} <> 'voided')`,
    ))
    .limit(1);

  // ── A live label. Postage is already spent and could still be used. ───────────────────
  //
  // Never auto-void. A void is a one-way door — claimPurchase replays on `purchased` with no
  // void_state filter, so a voided replacement can never buy another label — and voiding is a
  // provider action that a local cancellation must not perform on its own authority.
  //
  // `review` IS the shipping block: shipReplacement demands `label_created`, so this
  // structurally prevents dispatch without a second gate, and the shared 36423 lock closes
  // the race against a ship already in flight.
  if (atRiskIntent?.state === 'purchased') {
    if (before.status === 'cancelled' || before.status === 'rejected') {
      // Historical lifecycle/label mismatch. Terminal -> review is not a legal transition,
      // but terminal text cannot erase live postage. Preserve the terminal status, append the
      // anomaly receipt, and leave the HOLD open for a human.
      await annotateReplacementOriginalOrderInTransaction(tx, before, {
        actor: input.actor,
        reason: input.reason,
        eventType: 'replacement_terminal_original_order_live_label',
      });
      return {
        ...base,
        phase: 'pre_dispatch_label_at_risk',
        disposition: 'review',
        openQuestion: 'terminal_replacement_has_live_label',
        finalizedCreditOwed: false,
      };
    }
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
  if (atRiskIntent) {
    if (before.status === 'cancelled' || before.status === 'rejected') {
      await annotateReplacementOriginalOrderInTransaction(tx, before, {
        actor: input.actor,
        reason: input.reason,
        eventType: 'replacement_terminal_original_order_unresolved_label',
      });
      return {
        ...base,
        phase: 'pre_dispatch_label_at_risk',
        disposition: 'review',
        openQuestion: 'terminal_replacement_has_unresolved_label_intent',
        finalizedCreditOwed: false,
      };
    }
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

  // ── Pre-dispatch with ANY replacement money. That should be impossible. ───────────────
  //
  // Billing lines are written by the shipped command and nowhere else. Editable is no less
  // anomalous than finalized here: Hermes's amended AC-16 says ANY billing row blocks the
  // automatic path, so none is silently deleted as though it were clean.
  const [billing] = await tx
    .select({ id: billingLineItems.id, invoiced: billingLineItems.invoiced })
    .from(billingLineItems)
    .where(eq(billingLineItems.replacementId, before.id))
    .limit(1);

  if (billing) {
    if (before.status === 'cancelled' || before.status === 'rejected') {
      await annotateReplacementOriginalOrderInTransaction(tx, before, {
        actor: input.actor,
        reason: input.reason,
        eventType: 'replacement_terminal_original_order_unexpected_billing',
      });
      return {
        ...base,
        phase: 'pre_dispatch_label_at_risk',
        disposition: 'review',
        openQuestion: billing.invoiced
          ? 'terminal_undispatched_replacement_has_invoiced_money'
          : 'terminal_undispatched_replacement_has_editable_money',
        finalizedCreditOwed: false,
      };
    }
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
      openQuestion: billing.invoiced
        ? 'invoiced_money_on_an_undispatched_replacement'
        : 'editable_money_on_an_undispatched_replacement',
      finalizedCreditOwed: false,
    };
  }

  // ── Already finished with, and clean. Nothing to move or decide. ──────────────────────
  if (before.status === 'cancelled' || before.status === 'rejected') {
    return {
      ...base, phase: 'terminal_no_action', disposition: 'no_action',
      openQuestion: null, finalizedCreditOwed: false,
    };
  }

  // ── Nothing spent. Cancel it. ─────────────────────────────────────────────────────────
  const terminalFence = await prepareReplacementTerminalTransitionInTransaction(tx, before, {
    actor: input.actor,
    reason: input.reason,
    context: 'original_order',
  });
  if (!terminalFence.ready) {
    return {
      ...base,
      phase: 'pre_dispatch_label_at_risk',
      disposition: 'review',
      openQuestion: terminalFence.block === 'label_live'
        ? 'void_or_retain_purchased_label'
        : 'resolve_label_or_shipment_evidence_before_cancelling',
      finalizedCreditOwed: false,
    };
  }

  await cancelReplacementForOriginalOrderInTransaction(tx, before, {
    actor: input.actor,
    reason: input.reason,
  });
  // The query above proved there is no billing row. Keep the zero-effect call as a database
  // assertion inside the same transaction: if a concurrent writer appears, the shared order
  // lock and writer ownership make that a bug worth failing rather than a silent deletion.
  await cancelReplacementBillingInTransaction(tx, { replacementId: before.id });

  return {
    ...base, phase: 'pre_dispatch', disposition: 'cancelled', openQuestion: null,
    // ALWAYS false, and that is a fact about the classifier rather than a shortcut: the
    // branch above sends any replacement carrying invoiced money to `review`, so nothing
    // reaching here can owe a credit. An earlier version derived this from
    // `invoicedRetained > 0`, which read as careful and could never be true — the audit
    // called it a wired path that no producer could feed. The operator cancellation routes
    // own that case now, through cancelReplacementCharges.
    finalizedCreditOwed: false,
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

export const REPLACEMENT_HOLD_PERMISSION = 'replacements:hold';

export const REPLACEMENT_HOLD_RESOLUTIONS = [
  'label_voided',
  'label_retained',
  'label_not_purchased',
  'replacement_cancelled',
  'replacement_rejected',
  'financials_cleared',
  'financial_reversal_completed',
  'post_dispatch_client_charge_retained',
  'dispatch_evidence_reconciled',
] as const;

export type ReplacementHoldResolution = (typeof REPLACEMENT_HOLD_RESOLUTIONS)[number];

export type ReplacementHoldResolutionErrorCode =
  | 'REPLACEMENT_HOLD_NOT_FOUND'
  | 'REPLACEMENT_HOLD_ALREADY_RESOLVED'
  | 'REPLACEMENT_HOLD_STATE_CONFLICT'
  | 'REPLACEMENT_HOLD_ACTOR_REQUIRED'
  | 'REPLACEMENT_HOLD_REASON_REQUIRED'
  | 'REPLACEMENT_HOLD_RESOLUTION_FORBIDDEN'
  | 'REPLACEMENT_HOLD_RESOLUTION_INCOMPATIBLE'
  | 'REPLACEMENT_HOLD_PREREQUISITE_MISSING';

export class ReplacementHoldResolutionError extends Error {
  constructor(
    readonly code: ReplacementHoldResolutionErrorCode,
    message: string,
    readonly httpStatus: 400 | 401 | 403 | 404 | 409 = 409,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ReplacementHoldResolutionError';
  }
}

const HOLD_RESOLUTIONS_BY_OPEN_QUESTION: Readonly<Record<string, readonly ReplacementHoldResolution[]>> = {
  void_or_retain_purchased_label: ['label_voided', 'label_retained'],
  terminal_replacement_has_live_label: ['label_voided', 'label_retained'],
  resolve_label_purchase_intent_before_cancelling: [
    'label_not_purchased', 'label_voided', 'label_retained',
    'replacement_cancelled', 'replacement_rejected',
  ],
  terminal_replacement_has_unresolved_label_intent: [
    'label_not_purchased', 'label_voided', 'label_retained',
  ],
  resolve_label_or_shipment_evidence_before_cancelling: [
    'label_not_purchased', 'label_voided',
    'replacement_cancelled', 'replacement_rejected',
  ],
  invoiced_money_on_an_undispatched_replacement: ['financial_reversal_completed'],
  editable_money_on_an_undispatched_replacement: ['financials_cleared'],
  terminal_undispatched_replacement_has_invoiced_money: ['financial_reversal_completed'],
  terminal_undispatched_replacement_has_editable_money: ['financials_cleared'],
  does_the_client_still_pay_for_a_delivered_replacement: [
    'financial_reversal_completed', 'post_dispatch_client_charge_retained',
  ],
  dispatch_evidence_disagrees_with_lifecycle_and_financials_need_review: [
    'financial_reversal_completed', 'post_dispatch_client_charge_retained',
  ],
  resolve_lifecycle_dispatch_inconsistency: ['dispatch_evidence_reconciled'],
};

function assertResolutionMatchesOpenQuestion(
  openQuestion: string | null,
  resolution: ReplacementHoldResolution,
): void {
  const allowed = openQuestion ? HOLD_RESOLUTIONS_BY_OPEN_QUESTION[openQuestion] : undefined;
  if (!allowed?.includes(resolution)) {
    throw new ReplacementHoldResolutionError(
      'REPLACEMENT_HOLD_RESOLUTION_INCOMPATIBLE',
      'The requested resolution does not answer this hold question',
      409,
      { openQuestion, resolution, allowedResolutions: allowed ?? [] },
    );
  }
}

async function assertHoldResolutionPrerequisite(
  tx: any,
  before: ReplacementRow,
  resolution: ReplacementHoldResolution,
  openQuestion: string | null,
): Promise<void> {
  const fail = (detail: string): never => {
    throw new ReplacementHoldResolutionError(
      'REPLACEMENT_HOLD_PREREQUISITE_MISSING',
      detail,
      409,
      { replacementId: before.id, resolution },
    );
  };

  if (openQuestion === 'dispatch_evidence_disagrees_with_lifecycle_and_financials_need_review') {
    if (
      before.shippedAt == null
      || (before.status !== 'shipped' && before.status !== 'completed')
    ) {
      fail('Authoritative shipped_at and lifecycle must agree before the financial question can close');
    }
  }

  if (resolution === 'label_voided' || resolution === 'label_retained') {
    const [intent] = await tx
      .select({
        state: replacementLabelPurchaseIntents.state,
        voidState: replacementLabelPurchaseIntents.voidState,
        replacementShipmentId: replacementLabelPurchaseIntents.replacementShipmentId,
        providerTransactionId: replacementLabelPurchaseIntents.providerTransactionId,
        providerLabelId: replacementLabelPurchaseIntents.providerLabelId,
      })
      .from(replacementLabelPurchaseIntents)
      .where(and(
        eq(replacementLabelPurchaseIntents.replacementId, before.id),
        eq(replacementLabelPurchaseIntents.state, 'purchased'),
      ))
      .limit(1);
    if (!intent || intent.replacementShipmentId !== before.replacementShipmentId) {
      fail('A replacement-owned purchased label receipt is required before resolving this hold');
    }
    if (!intent.providerTransactionId && !intent.providerLabelId) {
      fail('Purchased state has no stable provider receipt identity');
    }
    if (resolution === 'label_retained') {
      if (intent.voidState !== null) {
        fail('A retained label requires a stable active void state, not pending/reconcile/voided');
      }
      const [activeShipment] = await tx
        .select({
          id: shipments.id,
          orderId: shipments.orderId,
          clientId: shipments.clientId,
          orderNumber: shipments.orderNumber,
          source: shipments.source,
          voided: shipments.voided,
        })
        .from(shipments)
        .where(eq(shipments.id, intent.replacementShipmentId!))
        .limit(1);
      if (
        !activeShipment
        || activeShipment.voided
        || activeShipment.orderId !== null
        || activeShipment.clientId !== before.clientId
        || activeShipment.orderNumber !== before.reference
        || activeShipment.source !== 'replacement'
      ) {
        fail('Retaining a label requires its exact active replacement-owned shipment');
      }
      return;
    }

    const [shipment] = await tx
      .select({
        id: shipments.id,
        orderId: shipments.orderId,
        clientId: shipments.clientId,
        orderNumber: shipments.orderNumber,
        source: shipments.source,
        voided: shipments.voided,
      })
      .from(shipments)
      .where(eq(shipments.id, intent.replacementShipmentId!))
      .limit(1);
    if (
      intent.voidState !== 'voided'
      || !shipment?.voided
      || shipment.orderId !== null
      || shipment.clientId !== before.clientId
      || shipment.orderNumber !== before.reference
      || shipment.source !== 'replacement'
    ) {
      fail('Both the provider void receipt and exact replacement shipment void are required');
    }
    return;
  }

  if (resolution === 'label_not_purchased') {
    const [atRisk] = await tx
      .select({ id: replacementLabelPurchaseIntents.id })
      .from(replacementLabelPurchaseIntents)
      .where(and(
        eq(replacementLabelPurchaseIntents.replacementId, before.id),
        sql`${replacementLabelPurchaseIntents.state} in ('provider_pending', 'reconcile_required', 'purchased')`,
        sql`(${replacementLabelPurchaseIntents.voidState} is null
          or ${replacementLabelPurchaseIntents.voidState} <> 'voided')`,
      ))
      .limit(1);
    if (atRisk) {
      fail('The label intent is still unresolved, purchased, or otherwise at risk');
    }
    const [purchaseReceipt] = await tx
      .select({ id: replacementLabelPurchaseIntents.id })
      .from(replacementLabelPurchaseIntents)
      .where(and(
        eq(replacementLabelPurchaseIntents.replacementId, before.id),
        sql`(${replacementLabelPurchaseIntents.state} in ('purchased', 'voided')
          or ${replacementLabelPurchaseIntents.providerTransactionId} is not null
          or ${replacementLabelPurchaseIntents.providerLabelId} is not null)`,
      ))
      .limit(1);
    if (purchaseReceipt) {
      fail('A durable provider purchase receipt exists; answer whether that label was voided or retained');
    }
    const [failedBeforePurchase] = await tx
      .select({ id: replacementLabelPurchaseIntents.id })
      .from(replacementLabelPurchaseIntents)
      .where(and(
        eq(replacementLabelPurchaseIntents.replacementId, before.id),
        eq(replacementLabelPurchaseIntents.state, 'failed_pre_purchase'),
      ))
      .limit(1);
    if (!failedBeforePurchase) {
      fail('A durable failed-before-purchase receipt is required');
    }
    return;
  }

  if (resolution === 'replacement_cancelled' || resolution === 'replacement_rejected') {
    const expected = resolution === 'replacement_cancelled' ? 'cancelled' : 'rejected';
    if (before.status !== expected) {
      fail(`Replacement must already be ${expected}; resolving a hold does not move lifecycle`);
    }
    const [atRisk] = await tx
      .select({ id: replacementLabelPurchaseIntents.id })
      .from(replacementLabelPurchaseIntents)
      .where(and(
        eq(replacementLabelPurchaseIntents.replacementId, before.id),
        sql`${replacementLabelPurchaseIntents.state} in ('provider_pending', 'reconcile_required', 'purchased')`,
        sql`(${replacementLabelPurchaseIntents.voidState} is null
          or ${replacementLabelPurchaseIntents.voidState} <> 'voided')`,
      ))
      .limit(1);
    if (atRisk) fail('Unresolved or live label evidence still exists on the terminal replacement');
    return;
  }

  if (resolution === 'financial_reversal_completed') {
    const [completed] = await tx
      .select({ id: replacementFinancialActions.id })
      .from(replacementFinancialActions)
      .where(and(
        eq(replacementFinancialActions.replacementId, before.id),
        eq(replacementFinancialActions.actionType, 'post_ship_financial_reversal'),
        eq(replacementFinancialActions.status, 'completed'),
      ))
      .limit(1);
    if (!completed) fail('A completed durable post-ship financial reversal is required');
    return;
  }

  if (resolution === 'financials_cleared') {
    const [remainingLine] = await tx
      .select({ id: billingLineItems.id })
      .from(billingLineItems)
      .where(eq(billingLineItems.replacementId, before.id))
      .limit(1);
    if (remainingLine) {
      fail('Replacement-attributed billing rows still exist');
    }
    return;
  }

  if (resolution === 'post_dispatch_client_charge_retained') {
    if (before.shippedAt == null || before.billable !== true) {
      fail('A dispatched, billable replacement is required to retain the client charge');
    }
    return;
  }

  const dispatchConsistent = before.shippedAt != null
    ? before.status === 'shipped' || before.status === 'completed'
    : before.status !== 'shipped' && before.status !== 'completed';
  if (!dispatchConsistent) {
    fail('Lifecycle and authoritative shipped_at evidence are still inconsistent');
  }
}

/**
 * Close one open AC-16 question after its external/lifecycle/financial prerequisite exists.
 *
 * This command never performs that prerequisite. It validates the receipt already committed,
 * bumps the replacement version, appends the named decision event, and closes the hold in
 * one order-locked transaction. A stale UI cannot close a question against a moved row.
 */
export async function resolveReplacementOriginalOrderHold(
  input: {
    holdId: number;
    replacementId: number;
    expectedStateVersion: number;
    resolution: ReplacementHoldResolution;
    reason: string;
    actor: LifecycleActor;
  },
  conn: Pick<typeof db, 'transaction'> = db,
): Promise<{ holdId: number; replacement: ReplacementRow; resolution: ReplacementHoldResolution }> {
  const actorEmail = input.actor.email?.trim() ?? '';
  const reason = input.reason?.trim() ?? '';
  if (!actorEmail) {
    throw new ReplacementHoldResolutionError(
      'REPLACEMENT_HOLD_ACTOR_REQUIRED', 'A named actor is required to resolve a hold', 401,
    );
  }
  if (!input.actor.permissions.includes(REPLACEMENT_HOLD_PERMISSION)) {
    throw new ReplacementHoldResolutionError(
      'REPLACEMENT_HOLD_RESOLUTION_FORBIDDEN',
      `Resolving a hold requires ${REPLACEMENT_HOLD_PERMISSION}`,
      403,
    );
  }
  if (!reason) {
    throw new ReplacementHoldResolutionError(
      'REPLACEMENT_HOLD_REASON_REQUIRED', 'A written resolution reason is required', 400,
    );
  }

  return conn.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(36423, (
      select order_id from replacement_original_order_holds where id = ${input.holdId}
    ))`);
    const [hold] = await tx
      .select()
      .from(replacementOriginalOrderHolds)
      .where(eq(replacementOriginalOrderHolds.id, input.holdId))
      .limit(1)
      .for('update');
    if (!hold || hold.replacementId !== input.replacementId) {
      throw new ReplacementHoldResolutionError(
        'REPLACEMENT_HOLD_NOT_FOUND', 'Open replacement hold not found', 404,
      );
    }
    if (hold.resolvedAt != null) {
      throw new ReplacementHoldResolutionError(
        'REPLACEMENT_HOLD_ALREADY_RESOLVED', 'Replacement hold is already resolved', 409,
      );
    }

    const [before] = await tx
      .select()
      .from(replacements)
      .where(eq(replacements.id, hold.replacementId))
      .limit(1);
    if (!before) {
      throw new ReplacementHoldResolutionError(
        'REPLACEMENT_HOLD_NOT_FOUND', 'Replacement for hold not found', 404,
      );
    }
    if (before.stateVersion !== input.expectedStateVersion) {
      throw new ReplacementHoldResolutionError(
        'REPLACEMENT_HOLD_STATE_CONFLICT',
        'Replacement moved after the hold was read; reload before resolving it',
        409,
        {
          expectedStateVersion: input.expectedStateVersion,
          actualStateVersion: before.stateVersion,
        },
      );
    }

    assertResolutionMatchesOpenQuestion(hold.openQuestion, input.resolution);
    await assertHoldResolutionPrerequisite(
      tx,
      before as ReplacementRow,
      input.resolution,
      hold.openQuestion,
    );
    const resolvedReplacement = await annotateReplacementOriginalOrderInTransaction(
      tx,
      before as ReplacementRow,
      {
        actor: input.actor,
        eventType: 'replacement_original_order_hold_resolved',
        reason: `${input.resolution}: ${reason}`,
      },
    );
    const closed = await tx
      .update(replacementOriginalOrderHolds)
      .set({
        resolvedAt: new Date(),
        resolvedBy: actorEmail,
        resolution: `${input.resolution}: ${reason}`,
      })
      .where(and(
        eq(replacementOriginalOrderHolds.id, hold.id),
        eq(replacementOriginalOrderHolds.replacementId, before.id),
        isNull(replacementOriginalOrderHolds.resolvedAt),
      ))
      .returning({ id: replacementOriginalOrderHolds.id });
    if (!closed[0]) {
      throw new ReplacementHoldResolutionError(
        'REPLACEMENT_HOLD_STATE_CONFLICT', 'Hold moved while its resolution was recorded', 409,
      );
    }
    return { holdId: hold.id, replacement: resolvedReplacement, resolution: input.resolution };
  });
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
