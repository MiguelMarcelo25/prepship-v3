/**
 * PS-502 — the ONE transactional owner of replacement lifecycle transitions.
 *
 * REQUIRES `unlock shipped data`: approval and remap read a shipped original as operational
 * authority, and every command here can move a replacement toward shipping.
 *
 * WHAT IT DOES NOT DO. No shipment row, no label, no provider call, no inventory, no
 * packaging, no billing line, no marketplace notification. It moves state and appends
 * evidence. `shipped` is deliberately NOT reachable from here — it belongs to the atomic
 * shipped command, which must own inventory, packaging and billing in one transaction.
 *
 * WHY ONE OWNER
 *
 * Every transition is `WHERE id AND status = :expected AND state_version = :expected
 * RETURNING`, with zero rows meaning a coded 409 rather than a lost update, and exactly one
 * idempotent activity event per successful move. Scattered across routes those three rules
 * drift apart immediately: one caller forgets the version predicate, another appends an event
 * before checking the result, a third invents a transition the diagram never allowed. A guard
 * asserts no route writes `status` directly.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { orderItems } from '../db/schema/order-items';
import { shipments, type Shipment } from '../db/schema/shipments';
import {
  replacementActivityEvents,
  replacementItemRemaps,
  replacementItems,
  replacementLabelPurchaseIntents,
  replacementOriginalOrderHolds,
  replacements,
  type ReplacementRow,
} from '../db/schema/replacements';
import {
  assertReplacementTransition,
  isReplacementStatus,
  REPLACEMENT_ERROR_CODES,
  type ReplacementStatus,
} from './replacement-state-machine';
import { findFrozenLineDrift } from './replacement-drift-resolution';
import { buildReplacementSourceLineFingerprint } from './replacement-source-line-fingerprint';
import { evaluateBillabilityChange, type ReplacementLiabilityOwner } from './replacement-billability';
import { evaluateReplacementAllowance, type AllowanceRow } from './replacement-allowance';
import { completePreShipCancellationCleanupInTransaction } from './replacement-financial-action';
import { readFrozenReplacementCustomerShippingMoney } from './customer-shipping-money';

/** Same class as the create and shipment commands: everything serialises on the order. */
const REPLACEMENT_ORDER_LOCK_CLASS = 36423;

/** The capability an audited remap requires. Distinct from ordinary approval. */
export const REPLACEMENT_OVERRIDE_PERMISSION = 'replacements:override';

export type ReplacementLifecycleErrorCode =
  | 'REPLACEMENT_NOT_FOUND'
  | 'REPLACEMENT_STATE_CONFLICT'
  | 'REPLACEMENT_SOURCE_LINE_CHANGED'
  | 'REPLACEMENT_REMAP_FORBIDDEN'
  | 'REPLACEMENT_REMAP_REASON_REQUIRED'
  | 'REPLACEMENT_REMAP_TARGET_INVALID'
  | 'REPLACEMENT_ALLOWANCE_EXCEEDED'
  | 'REPLACEMENT_REASON_REQUIRED'
  | 'REPLACEMENT_TERMINAL_LABEL_REVIEW_REQUIRED'
  | 'REPLACEMENT_REVIEW_PREREQUISITE_REQUIRED'
  | 'REPLACEMENT_BILLABLE_FORBIDDEN_FOR_OPERATOR_LIABILITY'
  | 'REPLACEMENT_BILLABLE_FROZEN'
  | 'REPLACEMENT_BILLABLE_FINALIZED'
  | 'REPLACEMENT_BILLABLE_FORBIDDEN'
  | 'REPLACEMENT_BILLABLE_REASON_REQUIRED';

export class ReplacementLifecycleError extends Error {
  constructor(
    readonly code: ReplacementLifecycleErrorCode,
    message: string,
    readonly httpStatus: 400 | 403 | 404 | 409 = 409,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ReplacementLifecycleError';
  }
}

export type LifecycleActor = {
  email: string | null;
  type: string;
  permissions: readonly string[];
};

type Conn = Pick<typeof db, 'transaction'>;

async function loadForUpdate(tx: any, replacementId: number): Promise<ReplacementRow> {
  await tx.execute(sql`select pg_advisory_xact_lock(${REPLACEMENT_ORDER_LOCK_CLASS}, (
    select order_id from replacements where id = ${replacementId}
  ))`);
  const [row] = await tx.select().from(replacements).where(eq(replacements.id, replacementId)).limit(1);
  if (!row) {
    throw new ReplacementLifecycleError(
      'REPLACEMENT_NOT_FOUND', `replacement ${replacementId} does not exist`, 404,
    );
  }
  return row as ReplacementRow;
}

/** Column stamped when a status is reached, so timestamps cannot disagree with status. */
const TIMESTAMP_FOR: Partial<Record<ReplacementStatus, 'labelCreatedAt' | 'completedAt' | 'rejectedAt' | 'cancelledAt' | 'closedAt'>> = {
  label_created: 'labelCreatedAt',
  completed: 'completedAt',
  rejected: 'rejectedAt',
  cancelled: 'cancelledAt',
};

/**
 * The single transition primitive.
 *
 * Guarded on expected status AND state_version, verified by row count, and paired with
 * exactly one activity event. Nothing here is optional: appending the event before checking
 * the result would record a transition that never happened, and an append-only audit log is
 * trusted precisely because it cannot contain one.
 */
async function applyTransition(
  tx: any,
  before: ReplacementRow,
  input: {
    to: ReplacementStatus;
    eventType: string;
    actor: LifecycleActor;
    reason?: string | null;
    idempotencySuffix: string;
    extra?: Record<string, unknown>;
  },
): Promise<ReplacementRow> {
  const from = isReplacementStatus(before.status) ? before.status : null;
  if (!from) {
    throw new ReplacementLifecycleError(
      'REPLACEMENT_STATE_CONFLICT', `replacement ${before.reference} has unknown status ${before.status}`,
    );
  }
  // Fail closed against the diagram before touching the row: a transition the lifecycle never
  // allowed must not depend on a predicate happening to miss.
  assertReplacementTransition(from, input.to);

  const stamp = TIMESTAMP_FOR[input.to];
  const moved = await tx
    .update(replacements)
    .set({
      status: input.to,
      stateVersion: before.stateVersion + 1,
      updatedAt: new Date(),
      ...(stamp ? { [stamp]: new Date() } : {}),
      ...(input.extra ?? {}),
    })
    .where(and(
      eq(replacements.id, before.id),
      eq(replacements.status, before.status),
      eq(replacements.stateVersion, before.stateVersion),
    ))
    .returning();

  if (moved.length === 0) {
    throw new ReplacementLifecycleError(
      'REPLACEMENT_STATE_CONFLICT',
      `replacement ${before.reference} moved under this request; nothing was changed`,
      409,
      { expectedStatus: before.status, expectedStateVersion: before.stateVersion },
    );
  }

  await tx.insert(replacementActivityEvents).values({
    replacementId: before.id,
    eventType: input.eventType,
    fromStatus: from,
    toStatus: input.to,
    actorType: input.actor.type,
    actorEmail: input.actor.email,
    detail: input.reason ?? null,
    idempotencyKey: `replacement:${before.id}:${input.idempotencySuffix}:v${before.stateVersion}`,
  });

  return moved[0] as ReplacementRow;
}

function requireReason(reason: string | null | undefined, code: ReplacementLifecycleErrorCode): string {
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  if (trimmed === '') {
    throw new ReplacementLifecycleError(code, 'a written reason is required and is recorded', 400);
  }
  return trimmed;
}

/**
 * Park a replacement in `review`, for a NAMED reason. The ONLY writer of that move.
 *
 * Extracted because there were three hand-rolled copies of this update and every one of them
 * hard-coded reviewReason = 'original_order_line_drift'. AC-16 needed a fourth review reason,
 * and a fourth copy would have been the point at which the shape stopped being a shape. One of
 * the three (label-purchase) also updated on id alone, without the optimistic predicate — so
 * the copies had already drifted apart in the way that matters.
 *
 * All three now delegate here: approval drift (below), shipment drift, post-dispatch label
 * drift, and AC-16's original-order hold. The predicate is therefore written once, and the
 * one copy that had lost it cannot silently be the odd one out again.
 *
 * NOT applyTransition. `review -> review` is not in the diagram and a self-transition throws,
 * but re-parking an already-reviewing replacement under a NEW reason is legitimate: a second,
 * different thing is now wrong with it. So this writes the row directly, keeping the same
 * guard the primitive uses — expected status AND expected state_version, row count checked —
 * and appends exactly one event.
 *
 * WHAT CALLERS MAY VARY, and what they may not. They may add columns they own on the same row
 * (`extra`), link the event to the shipment the decision was made against (`shipmentId`), and
 * choose the error their own public surface raises on a lost race (`onConflict`) so a command
 * does not leak a lifecycle error past a caller catching its own type. They may NOT vary the
 * detection: the predicate and the row-count check are not parameters, and `onConflict`
 * supplies an error to throw rather than deciding whether to throw one.
 */
export async function enterReplacementReview(
  tx: any,
  before: ReplacementRow,
  input: {
    reviewReason: string;
    eventType: string;
    /**
     * Entering review is not a capability-gated act — the CALLER decides who may trigger it —
     * so this asks only for what the event records. Narrower than LifecycleActor on purpose:
     * the shipment and label commands carry no permission list, and inventing an empty one at
     * those call sites would read as "checked here, and it passed".
     */
    actor: Pick<LifecycleActor, 'email' | 'type'>;
    reason?: string | null;
    idempotencySuffix: string;
    /** Columns the CALLER owns on the same row — a label timestamp it just earned, say. */
    extra?: Record<string, unknown>;
    /** The shipment the review was decided against, for audit linkage. */
    shipmentId?: number | null;
    /** The error THIS caller's surface throws on a lost race. Detection is not negotiable. */
    onConflict?: (before: ReplacementRow) => Error;
  },
): Promise<ReplacementRow> {
  const reviewed = await tx
    .update(replacements)
    .set({
      status: 'review',
      reviewReason: input.reviewReason,
      reviewRequestedAt: new Date(),
      stateVersion: before.stateVersion + 1,
      updatedAt: new Date(),
      ...(input.extra ?? {}),
    })
    .where(and(
      eq(replacements.id, before.id),
      eq(replacements.status, before.status),
      eq(replacements.stateVersion, before.stateVersion),
    ))
    .returning();

  if (reviewed.length === 0) {
    throw input.onConflict?.(before) ?? new ReplacementLifecycleError(
      'REPLACEMENT_STATE_CONFLICT',
      `replacement ${before.reference} moved while review was being recorded; nothing was written`,
      409,
      { expectedStatus: before.status, expectedStateVersion: before.stateVersion },
    );
  }

  await tx.insert(replacementActivityEvents).values({
    replacementId: before.id,
    ...(input.shipmentId != null ? { shipmentId: input.shipmentId } : {}),
    eventType: input.eventType,
    fromStatus: before.status,
    toStatus: 'review',
    actorType: input.actor.type,
    actorEmail: input.actor.email,
    detail: input.reason ?? null,
    idempotencyKey: `replacement:${before.id}:${input.idempotencySuffix}:v${before.stateVersion}`,
  });

  return reviewed[0] as ReplacementRow;
}

type ReplacementTerminalFenceBlock =
  | 'label_live'
  | 'label_unresolved'
  | 'shipment_ownership_mismatch'
  | 'shipment_not_empty';

export type ReplacementTerminalFenceResult =
  | { ready: true; replacement: ReplacementRow }
  | {
    ready: false;
    replacement: ReplacementRow;
    block: ReplacementTerminalFenceBlock;
  };

function isEmptyReplacementShipment(shipment: Shipment): boolean {
  return shipment.labelShipmentId == null
    && shipment.labelUrl == null
    && shipment.labelCreatedAt == null
    && shipment.labelTracking == null
    && shipment.trackingNumber == null
    && shipment.labelCost == null
    && shipment.cost == null
    && shipment.selectedRateCost == null
    && shipment.shipDate == null;
}

/**
 * Final pre-terminal label fence and vessel retirement owner.
 *
 * A provider call runs outside the order transaction, so an operator can attempt cancel or
 * reject after Phase 1 committed `provider_pending` and before Phase 3 records the receipt.
 * Terminalizing in that window would leave purchased postage attached to a terminal row.
 * Every pre-ship terminal command therefore calls this under the same 36423 order lock.
 *
 * A clean, never-purchased shipment is only an empty replacement vessel. It is retired
 * locally (`voided=true`) with an audit event; no provider void is implied or attempted. A
 * provider-confirmed void may carry label snapshot fields and is also safe to retire locally.
 */
export async function prepareReplacementTerminalTransitionInTransaction(
  tx: any,
  before: ReplacementRow,
  input: {
    actor: Pick<LifecycleActor, 'email' | 'type'>;
    reason: string;
    context: 'original_order' | 'operator_terminal';
  },
): Promise<ReplacementTerminalFenceResult> {
  const intents = await tx
    .select({
      id: replacementLabelPurchaseIntents.id,
      state: replacementLabelPurchaseIntents.state,
      voidState: replacementLabelPurchaseIntents.voidState,
      replacementShipmentId: replacementLabelPurchaseIntents.replacementShipmentId,
    })
    .from(replacementLabelPurchaseIntents)
    .where(eq(replacementLabelPurchaseIntents.replacementId, before.id))
    .orderBy(desc(replacementLabelPurchaseIntents.id));

  const atRisk = intents.find((intent: {
    state: string;
    voidState: string | null;
  }) => (
    intent.state === 'provider_pending'
    || intent.state === 'reconcile_required'
    || intent.state === 'purchased'
  ) && intent.voidState !== 'voided');

  let block: ReplacementTerminalFenceBlock | null = atRisk
    ? (atRisk.state === 'purchased' ? 'label_live' : 'label_unresolved')
    : null;
  let shipment: Shipment | undefined;
  let providerVoidProven = false;

  if (!block && before.replacementShipmentId != null) {
    [shipment] = await tx
      .select()
      .from(shipments)
      .where(eq(shipments.id, before.replacementShipmentId))
      .limit(1);

    if (
      !shipment
      || before.clientId == null
      || shipment.orderId !== null
      || shipment.clientId !== before.clientId
      || shipment.orderNumber !== before.reference
      || shipment.source !== 'replacement'
    ) {
      block = 'shipment_ownership_mismatch';
    } else if (!shipment.voided) {
      providerVoidProven = intents.some((intent: {
        state: string;
        voidState: string | null;
        replacementShipmentId: number | null;
      }) => intent.replacementShipmentId === shipment!.id && (
        intent.state === 'voided'
        || (intent.state === 'purchased' && intent.voidState === 'voided')
      ));
      if (!providerVoidProven && !isEmptyReplacementShipment(shipment)) {
        block = 'shipment_not_empty';
      }
    }
  }

  if (block) {
    const reviewReason = input.context === 'original_order'
      ? (block === 'label_live'
        ? 'original_order_cancelled_label_live'
        : 'original_order_cancelled_label_unresolved')
      : (block === 'label_live'
        ? 'terminal_transition_label_live'
        : 'terminal_transition_label_unresolved');
    if (before.status === 'cancelled' || before.status === 'rejected') {
      return { ready: false, replacement: before, block };
    }
    if (before.status === 'review' && before.reviewReason === reviewReason) {
      return { ready: false, replacement: before, block };
    }
    const reviewed = await enterReplacementReview(tx, before, {
      reviewReason,
      eventType: input.context === 'original_order'
        ? 'replacement_original_order_cancelled'
        : 'replacement_terminal_transition_blocked',
      actor: input.actor,
      reason: input.reason,
      idempotencySuffix: `${input.context}-terminal-${block}`,
      shipmentId: before.replacementShipmentId,
    });
    return { ready: false, replacement: reviewed, block };
  }

  if (shipment && !shipment.voided) {
    const conditions = [
      eq(shipments.id, shipment.id),
      isNull(shipments.orderId),
      eq(shipments.clientId, before.clientId!),
      eq(shipments.orderNumber, before.reference),
      eq(shipments.source, 'replacement'),
      eq(shipments.voided, false),
    ];
    if (!providerVoidProven) {
      conditions.push(
        isNull(shipments.labelShipmentId),
        isNull(shipments.labelUrl),
        isNull(shipments.labelCreatedAt),
        isNull(shipments.labelTracking),
        isNull(shipments.trackingNumber),
        isNull(shipments.labelCost),
        isNull(shipments.cost),
        isNull(shipments.selectedRateCost),
        isNull(shipments.shipDate),
      );
    }

    // Per user override unlock shipped data on 2026-08-19: retire only the exact detached,
    // replacement-owned vessel proved empty or backed by a confirmed provider void. This is
    // a local lifecycle fence; it performs no provider void and rewrites no shipment history.
    const retired = await tx
      .update(shipments)
      .set({ voided: true, updatedAt: new Date() })
      .where(and(...conditions))
      .returning({ id: shipments.id });
    if (retired.length === 0) {
      const reviewReason = input.context === 'original_order'
        ? 'original_order_cancelled_label_unresolved'
        : 'terminal_transition_label_unresolved';
      const reviewed = await enterReplacementReview(tx, before, {
        reviewReason,
        eventType: input.context === 'original_order'
          ? 'replacement_original_order_cancelled'
          : 'replacement_terminal_transition_blocked',
        actor: input.actor,
        reason: input.reason,
        idempotencySuffix: `${input.context}-terminal-shipment-race`,
        shipmentId: shipment.id,
      });
      return { ready: false, replacement: reviewed, block: 'shipment_not_empty' };
    }

    await tx.insert(replacementActivityEvents).values({
      replacementId: before.id,
      shipmentId: shipment.id,
      eventType: providerVoidProven
        ? 'replacement_voided_shipment_retired'
        : 'replacement_empty_shipment_retired',
      fromStatus: before.status,
      toStatus: before.status,
      actorType: input.actor.type,
      actorEmail: input.actor.email,
      detail: input.reason,
      idempotencyKey: `replacement:${before.id}:terminal-shipment-retire:v${before.stateVersion}`,
    });
  }

  return { ready: true, replacement: before };
}

function terminalFenceReviewError(
  result: Extract<ReplacementTerminalFenceResult, { ready: false }>,
  attemptedAction: 'cancel' | 'reject',
): ReplacementLifecycleError {
  return new ReplacementLifecycleError(
    'REPLACEMENT_TERMINAL_LABEL_REVIEW_REQUIRED',
    `replacement ${result.replacement.reference} has label or shipment evidence that must be ` +
      `resolved before ${attemptedAction}; it is parked in review`,
    409,
    {
      replacementId: result.replacement.id,
      reviewReason: result.replacement.reviewReason,
      block: result.block,
    },
  );
}

/**
 * AC-16 — cancel a PRE-DISPATCH replacement because its original order went away.
 *
 * Runs inside the caller's transaction, because the hold that records WHY must commit with
 * the cancellation that records WHAT. The diagram is asserted by applyTransition, so a
 * shipped or completed replacement cannot reach here even by mistake: `shipped -> cancelled`
 * is not an edge, and the guard pins that it never becomes one.
 *
 * This does NOT void a label. cancelReplacement has said so since it was written, for a
 * reason that outlives AC-16: a local cancellation must never pretend a provider action
 * happened. The caller decides that separately, and where a live label exists AC-16 does not
 * come here at all — it parks the replacement in review instead.
 */
export async function cancelReplacementForOriginalOrderInTransaction(
  tx: any,
  before: ReplacementRow,
  input: { actor: LifecycleActor; reason: string },
): Promise<ReplacementRow> {
  const reason = requireReason(input.reason, 'REPLACEMENT_REASON_REQUIRED');
  return applyTransition(tx, before, {
    to: 'cancelled',
    eventType: 'replacement_cancelled_original_order',
    actor: input.actor,
    reason,
    idempotencySuffix: 'original-order-cancel',
  });
}

/**
 * AC-16 — annotate a POST-DISPATCH replacement. Status is deliberately untouched.
 *
 * A shipped replacement moved real stock, consumed a real package and spent real postage.
 * `shipped -> ['completed']` is the whole of its future, so there is no status that could
 * express "the original was cancelled" without first making a delivered re-ship cancellable.
 *
 * So this records the fact and moves nothing: state_version bumps so a concurrent reader
 * cannot miss it, and exactly one event is appended. It copies setReplacementBillability,
 * which is the only existing shape for a status-preserving annotation — applyTransition
 * cannot express one, because a self-transition throws at the diagram.
 *
 * Whether the client still pays is NOT decided here. That is a money question and it is
 * carried on the hold as an open question for a human.
 */
export async function annotateReplacementOriginalOrderInTransaction(
  tx: any,
  before: ReplacementRow,
  input: { actor: LifecycleActor; reason: string; eventType: string },
): Promise<ReplacementRow> {
  const reason = requireReason(input.reason, 'REPLACEMENT_REASON_REQUIRED');
  const annotated = await tx
    .update(replacements)
    .set({
      stateVersion: before.stateVersion + 1,
      updatedAt: new Date(),
    })
    .where(and(
      eq(replacements.id, before.id),
      eq(replacements.status, before.status),
      eq(replacements.stateVersion, before.stateVersion),
    ))
    .returning();

  if (annotated.length === 0) {
    throw new ReplacementLifecycleError(
      'REPLACEMENT_STATE_CONFLICT',
      `replacement ${before.reference} moved while the original-order note was being recorded`,
    );
  }

  await tx.insert(replacementActivityEvents).values({
    replacementId: before.id,
    eventType: input.eventType,
    fromStatus: before.status,
    toStatus: before.status,
    actorType: input.actor.type,
    actorEmail: input.actor.email,
    detail: reason,
    idempotencyKey: `replacement:${before.id}:original-order-note:v${before.stateVersion}`,
  });

  return annotated[0] as ReplacementRow;
}

/**
 * Approve — re-resolving every frozen source line IMMEDIATELY before commit.
 *
 * Drift commits `review` and then reports 409, in that order and in separate transactions.
 * Throwing inside one transaction would roll the review back, leaving the replacement
 * approvable again and drifting forever with nothing recorded.
 */
export async function approveReplacement(
  input: { replacementId: number; actor: LifecycleActor; reason?: string | null },
  conn: Conn = db,
): Promise<ReplacementRow> {
  const drift = await conn.transaction(async (tx) => {
    const before = await loadForUpdate(tx, input.replacementId);
    const finding = await findFrozenLineDrift(tx, before);
    if (!finding) return null;

    await enterReplacementReview(tx, before, {
      reviewReason: 'original_order_line_drift',
      eventType: 'replacement_source_line_drift',
      actor: input.actor,
      idempotencySuffix: 'approve-drift',
    });
    return { reference: before.reference, finding };
  });

  if (drift) {
    throw new ReplacementLifecycleError(
      REPLACEMENT_ERROR_CODES.SOURCE_LINE_CHANGED,
      `the source line at index ${drift.finding.effectiveOrderLineIndex} on ${drift.reference} no ` +
        'longer matches what was frozen. The replacement is in review; resolve or remap it under ' +
        'audited override rather than approving against a line that moved.',
      409,
      { replacementItemId: drift.finding.replacementItemId, viaRemap: drift.finding.viaRemap },
    );
  }

  return conn.transaction(async (tx) => {
    const before = await loadForUpdate(tx, input.replacementId);
    return applyTransition(tx, before, {
      to: 'approved',
      eventType: 'replacement_approved',
      actor: input.actor,
      reason: input.reason ?? null,
      idempotencySuffix: 'approve',
      extra: { approvedBy: input.actor.email, reviewReason: null },
    });
  });
}

export async function rejectReplacement(
  input: { replacementId: number; actor: LifecycleActor; reason: string },
  conn: Conn = db,
): Promise<ReplacementRow> {
  const reason = requireReason(input.reason, 'REPLACEMENT_REASON_REQUIRED');
  const result = await conn.transaction(async (tx) => {
    const before = await loadForUpdate(tx, input.replacementId);
    const fence = await prepareReplacementTerminalTransitionInTransaction(tx, before, {
      actor: input.actor,
      reason,
      context: 'operator_terminal',
    });
    if (!fence.ready) return fence;
    const replacement = await applyTransition(tx, before, {
      to: 'rejected', eventType: 'replacement_rejected', actor: input.actor,
      reason, idempotencySuffix: 'reject',
    });
    return { ready: true as const, replacement };
  });
  if (!result.ready) {
    throw terminalFenceReviewError(result, 'reject');
  }
  return result.replacement;
}

/**
 * Cancel — pre-ship only, which the state machine already enforces.
 *
 * This does NOT void a label. A cancelled replacement holding a purchased label requires an
 * explicit void or an audited retain decision; coupling the two here would let a local
 * cancellation pretend a provider void succeeded.
 *
 * Per user override `unlock shipped data` on 2026-08-19: editable replacement billing is
 * removed and recorded in the SAME transaction as the lifecycle move. A process death can
 * no longer commit `cancelled` first and strand charge cleanup behind a terminal retry.
 */
export async function cancelReplacement(
  input: { replacementId: number; actor: LifecycleActor; reason: string },
  conn: Conn = db,
): Promise<ReplacementRow> {
  const reason = requireReason(input.reason, 'REPLACEMENT_REASON_REQUIRED');
  const result = await conn.transaction(async (tx) => {
    const before = await loadForUpdate(tx, input.replacementId);
    const fence = await prepareReplacementTerminalTransitionInTransaction(tx, before, {
      actor: input.actor,
      reason,
      context: 'operator_terminal',
    });
    if (!fence.ready) return fence;
    await completePreShipCancellationCleanupInTransaction(tx, {
      replacement: before,
      actor: input.actor,
      reason,
      idempotencyKey: `replacement:${before.id}:pre-ship-cancel:v${before.stateVersion}`,
    });
    const replacement = await applyTransition(tx, before, {
      to: 'cancelled', eventType: 'replacement_cancelled', actor: input.actor,
      reason, idempotencySuffix: 'cancel',
    });
    return { ready: true as const, replacement };
  });
  if (!result.ready) {
    throw terminalFenceReviewError(result, 'cancel');
  }
  return result.replacement;
}

const AC16_REVIEW_QUESTIONS_BY_REASON: Readonly<Record<string, readonly string[]>> = {
  original_order_cancelled_label_live: [
    'void_or_retain_purchased_label',
  ],
  original_order_cancelled_label_unresolved: [
    'resolve_label_purchase_intent_before_cancelling',
    'resolve_label_or_shipment_evidence_before_cancelling',
  ],
  original_order_cancelled_dispatch_inconsistent: [
    'resolve_lifecycle_dispatch_inconsistency',
  ],
  original_order_cancelled_unexpected_billing: [
    'invoiced_money_on_an_undispatched_replacement',
    'editable_money_on_an_undispatched_replacement',
  ],
};

async function assertReviewResolutionPrerequisites(
  tx: any,
  before: ReplacementRow,
  to: Extract<ReplacementStatus, 'requested' | 'approved' | 'label_created' | 'rejected' | 'cancelled'>,
): Promise<void> {
  const ac16Questions = before.reviewReason
    ? AC16_REVIEW_QUESTIONS_BY_REASON[before.reviewReason]
    : undefined;
  if (ac16Questions) {
    const [decision] = await tx
      .select({
        id: replacementOriginalOrderHolds.id,
        resolvedAt: replacementOriginalOrderHolds.resolvedAt,
      })
      .from(replacementOriginalOrderHolds)
      .where(and(
        eq(replacementOriginalOrderHolds.replacementId, before.id),
        inArray(replacementOriginalOrderHolds.openQuestion, [...ac16Questions]),
      ))
      .orderBy(desc(replacementOriginalOrderHolds.id))
      .limit(1);
    if (!decision?.resolvedAt) {
      throw new ReplacementLifecycleError(
        'REPLACEMENT_REVIEW_PREREQUISITE_REQUIRED',
        `replacement ${before.reference} still has an unanswered original-order hold; `
          + 'resolve that exact hold before clearing its review reason',
        409,
        { replacementId: before.id, reviewReason: before.reviewReason, holdId: decision?.id ?? null },
      );
    }
  }

  if (before.reviewReason !== 'replacement_customer_money_unavailable') return;
  if (to !== 'label_created' || before.replacementShipmentId == null) {
    throw new ReplacementLifecycleError(
      'REPLACEMENT_REVIEW_PREREQUISITE_REQUIRED',
      'paid-label customer-money review may only return to label_created after pricing reconciliation',
      409,
      { replacementId: before.id, reviewReason: before.reviewReason, requestedStatus: to },
    );
  }

  const [intent] = await tx
    .select({
      id: replacementLabelPurchaseIntents.id,
      replacementShipmentId: replacementLabelPurchaseIntents.replacementShipmentId,
      providerTransactionId: replacementLabelPurchaseIntents.providerTransactionId,
      providerShipmentId: replacementLabelPurchaseIntents.providerShipmentId,
    })
    .from(replacementLabelPurchaseIntents)
    .where(and(
      eq(replacementLabelPurchaseIntents.replacementId, before.id),
      eq(replacementLabelPurchaseIntents.state, 'purchased'),
      isNull(replacementLabelPurchaseIntents.voidState),
    ))
    .orderBy(desc(replacementLabelPurchaseIntents.id))
    .limit(1);
  const [shipment] = intent?.replacementShipmentId == null
    ? []
    : await tx
      .select()
      .from(shipments)
      .where(eq(shipments.id, intent.replacementShipmentId))
      .limit(1);
  const exactReceipt = intent != null
    && shipment != null
    && intent.replacementShipmentId === before.replacementShipmentId
    && shipment.orderId === null
    && shipment.clientId === before.clientId
    && shipment.orderNumber === before.reference
    && shipment.source === 'replacement'
    && shipment.voided === false
    && Boolean(intent.providerTransactionId?.trim())
    && intent.providerShipmentId != null
    && String(shipment.labelShipmentId) === intent.providerShipmentId;
  const frozen = exactReceipt
    ? readFrozenReplacementCustomerShippingMoney(shipment.selectedRateJson)
    : null;
  const [pricingAudit] = intent == null
    ? []
    : await tx
      .select({ id: replacementActivityEvents.id })
      .from(replacementActivityEvents)
      .where(and(
        eq(replacementActivityEvents.replacementId, before.id),
        eq(replacementActivityEvents.shipmentId, before.replacementShipmentId),
        eq(replacementActivityEvents.eventType, 'replacement_customer_money_reconciled'),
        eq(
          replacementActivityEvents.idempotencyKey,
          `replacement:${before.id}:pricing-reconcile:${intent.id}`,
        ),
      ))
      .limit(1);
  if (!exactReceipt || !frozen || !pricingAudit) {
    throw new ReplacementLifecycleError(
      'REPLACEMENT_REVIEW_PREREQUISITE_REQUIRED',
      'the exact active paid-label receipt still lacks its frozen customer-money tuple or pricing audit',
      409,
      { replacementId: before.id, reviewReason: before.reviewReason },
    );
  }
}

/**
 * Leave review for an explicitly chosen pre-ship state.
 *
 * `shipped` is unreachable from `review` in the state machine, and this cannot widen that: it
 * asserts the transition like every other move. Review at `label_created` is left by retaining
 * the label pending, voiding it, or remapping and re-rating — never by jumping forward.
 */
export async function resolveReplacementReview(
  input: {
    replacementId: number;
    to: Extract<ReplacementStatus, 'requested' | 'approved' | 'label_created' | 'rejected' | 'cancelled'>;
    actor: LifecycleActor;
    reason: string;
  },
  conn: Conn = db,
): Promise<ReplacementRow> {
  const reason = requireReason(input.reason, 'REPLACEMENT_REASON_REQUIRED');
  const result = await conn.transaction(async (tx) => {
    const before = await loadForUpdate(tx, input.replacementId);
    await assertReviewResolutionPrerequisites(tx, before, input.to);
    if (input.to === 'cancelled' || input.to === 'rejected') {
      const fence = await prepareReplacementTerminalTransitionInTransaction(tx, before, {
        actor: input.actor,
        reason,
        context: 'operator_terminal',
      });
      if (!fence.ready) return fence;
    }
    if (input.to === 'cancelled') {
      // Per user override `unlock shipped data` on 2026-08-19: resolving review through the
      // cancellation door has the same atomic money boundary as the direct cancel command.
      await completePreShipCancellationCleanupInTransaction(tx, {
        replacement: before,
        actor: input.actor,
        reason,
        idempotencyKey: `replacement:${before.id}:review-pre-ship-cancel:v${before.stateVersion}`,
      });
    }
    const replacement = await applyTransition(tx, before, {
      to: input.to,
      eventType: 'replacement_review_resolved',
      actor: input.actor,
      reason,
      idempotencySuffix: `review-${input.to}`,
      extra: { reviewReason: null },
    });
    return { ready: true as const, replacement };
  });
  if (!result.ready) {
    throw terminalFenceReviewError(result, input.to === 'rejected' ? 'reject' : 'cancel');
  }
  return result.replacement;
}

/**
 * An audited remap of one item onto a different source line.
 *
 * Appends to `replacement_item_remaps` and NEVER rewrites `replacement_items`: that row is
 * what was REQUESTED, and an audit after the fact needs it. The effective target becomes the
 * latest remap.
 *
 * The allowance is re-run against the NEW coordinate, because a cap aggregated on the frozen
 * fingerprint says nothing about the line being remapped onto — remapping is exactly how a
 * line could otherwise be over-replaced without any single request exceeding its own cap.
 */
export async function remapReplacementItem(
  input: {
    replacementId: number;
    replacementItemId: number;
    toOrderLineIndex: number;
    actor: LifecycleActor;
    reason: string;
  },
  conn: Conn = db,
): Promise<{ remapVersion: number; resolvedFingerprint: string }> {
  if (!input.actor.permissions.includes(REPLACEMENT_OVERRIDE_PERMISSION)) {
    throw new ReplacementLifecycleError(
      'REPLACEMENT_REMAP_FORBIDDEN',
      `remapping requires ${REPLACEMENT_OVERRIDE_PERMISSION}; retargeting a replacement is not ` +
        'an ordinary approval',
      403,
    );
  }
  const reason = requireReason(input.reason, 'REPLACEMENT_REMAP_REASON_REQUIRED');

  return conn.transaction(async (tx) => {
    const before = await loadForUpdate(tx, input.replacementId);

    const [item] = await tx.select().from(replacementItems)
      .where(and(
        eq(replacementItems.id, input.replacementItemId),
        eq(replacementItems.replacementId, before.id),
      ))
      .limit(1);
    if (!item) {
      throw new ReplacementLifecycleError(
        'REPLACEMENT_REMAP_TARGET_INVALID',
        `item ${input.replacementItemId} does not belong to ${before.reference}`, 404,
      );
    }

    const [line] = await tx.select({
      orderId: orderItems.orderId, lineIndex: orderItems.lineIndex,
      sku: orderItems.sku, name: orderItems.name, quantity: orderItems.quantity,
    }).from(orderItems).where(and(
      eq(orderItems.orderId, before.orderId),
      eq(orderItems.lineIndex, input.toOrderLineIndex),
    )).limit(1);
    if (!line) {
      throw new ReplacementLifecycleError(
        'REPLACEMENT_REMAP_TARGET_INVALID',
        `order ${before.orderId} has no line at index ${input.toOrderLineIndex}`, 400,
      );
    }

    const originalOrderedQuantity = Math.max(0, Math.trunc(Number(line.quantity)));
    const resolvedFingerprint = buildReplacementSourceLineFingerprint({
      orderId: before.orderId,
      orderLineIndex: line.lineIndex,
      sku: line.sku,
      name: line.name,
      originalOrderedQuantity,
    });

    const priorRows = await tx
      .select({
        sourceLineFingerprint: replacementItems.sourceLineFingerprint,
        quantity: replacementItems.quantity,
        status: replacements.status,
        shippedAt: replacements.shippedAt,
      })
      .from(replacementItems)
      .innerJoin(replacements, eq(replacementItems.replacementId, replacements.id))
      .where(eq(replacementItems.orderId, before.orderId));

    const verdict = evaluateReplacementAllowance({
      originalOrderedQuantity,
      sourceLineFingerprint: resolvedFingerprint,
      rows: priorRows as AllowanceRow[],
      requestedQuantity: item.quantity,
    });
    if (!verdict.allowed) {
      throw new ReplacementLifecycleError(
        'REPLACEMENT_ALLOWANCE_EXCEEDED', verdict.detail, 409,
        { toOrderLineIndex: input.toOrderLineIndex, remaining: verdict.allowance.remaining },
      );
    }

    const [latest] = await tx.select({ remapVersion: replacementItemRemaps.remapVersion })
      .from(replacementItemRemaps)
      .where(eq(replacementItemRemaps.replacementItemId, item.id))
      .orderBy(desc(replacementItemRemaps.remapVersion))
      .limit(1);
    const remapVersion = (latest?.remapVersion ?? 0) + 1;

    await tx.insert(replacementItemRemaps).values({
      replacementId: before.id,
      replacementItemId: item.id,
      previousOrderLineIndex: item.orderLineIndex,
      previousSourceLineFingerprint: item.sourceLineFingerprint,
      resolvedOrderLineIndex: line.lineIndex,
      resolvedSourceLineFingerprint: resolvedFingerprint,
      resolution: line.lineIndex === item.orderLineIndex ? 'retained' : 'remapped',
      remapVersion,
      actorType: input.actor.type,
      actorEmail: input.actor.email,
      reason,
      idempotencyKey: `replacement:${before.id}:remap:${item.id}:v${remapVersion}`,
    });

    await tx.insert(replacementActivityEvents).values({
      replacementId: before.id,
      eventType: 'replacement_item_remapped',
      fromStatus: before.status,
      toStatus: before.status,
      actorType: input.actor.type,
      actorEmail: input.actor.email,
      detail: reason,
      idempotencyKey: `replacement:${before.id}:remap-event:${item.id}:v${remapVersion}`,
    });

    return { remapVersion, resolvedFingerprint };
  });
}

/**
 * Change billability. Editable through `approved` only; the policy owner decides, this
 * records. Not a status transition, so it bumps the version without moving state.
 */
export async function setReplacementBillability(
  input: {
    replacementId: number;
    requestedBillable: boolean;
    actor: LifecycleActor;
    reason: string;
    finalized?: boolean;
  },
  conn: Conn = db,
): Promise<ReplacementRow> {
  return conn.transaction(async (tx) => {
    const before = await loadForUpdate(tx, input.replacementId);
    const status = isReplacementStatus(before.status) ? before.status : 'requested';

    const verdict = evaluateBillabilityChange({
      liabilityOwner: before.liabilityOwner as ReplacementLiabilityOwner,
      status,
      requestedBillable: input.requestedBillable,
      actor: { permissions: input.actor.permissions },
      reason: input.reason,
      finalized: input.finalized,
    });
    if (!verdict.allowed) {
      throw new ReplacementLifecycleError(verdict.code, verdict.detail, 403);
    }

    const moved = await tx.update(replacements)
      .set({
        billable: verdict.billable,
        stateVersion: before.stateVersion + 1,
        updatedAt: new Date(),
      })
      .where(and(
        eq(replacements.id, before.id),
        eq(replacements.status, before.status),
        eq(replacements.stateVersion, before.stateVersion),
      ))
      .returning();
    if (moved.length === 0) {
      throw new ReplacementLifecycleError(
        'REPLACEMENT_STATE_CONFLICT',
        `replacement ${before.reference} moved under this request; billability was not changed`,
      );
    }

    await tx.insert(replacementActivityEvents).values({
      replacementId: before.id,
      eventType: 'replacement_billability_set',
      fromStatus: before.status,
      toStatus: before.status,
      actorType: input.actor.type,
      actorEmail: input.actor.email,
      detail: input.reason,
      idempotencyKey: `replacement:${before.id}:billability:v${before.stateVersion}`,
    });

    return moved[0] as ReplacementRow;
  });
}

/**
 * `shipped -> completed`.
 *
 * Per Hermes's addendum this is NOT an unrestricted route: completion should be driven by the
 * canonical tracking-completion evidence owner, or by a separately privileged audited
 * override where no authoritative tracking evidence exists. The caller supplies which, and
 * the reason is recorded either way.
 */
export async function completeReplacement(
  input: {
    replacementId: number;
    actor: LifecycleActor;
    /** 'tracking_evidence' | 'audited_override' */
    basis: 'tracking_evidence' | 'audited_override';
    reason: string;
  },
  conn: Conn = db,
): Promise<ReplacementRow> {
  const reason = requireReason(input.reason, 'REPLACEMENT_REASON_REQUIRED');
  return conn.transaction(async (tx) => {
    const before = await loadForUpdate(tx, input.replacementId);
    return applyTransition(tx, before, {
      to: 'completed',
      eventType: `replacement_completed_${input.basis}`,
      actor: input.actor,
      reason,
      idempotencySuffix: 'complete',
      extra: { closedAt: new Date() },
    });
  });
}
