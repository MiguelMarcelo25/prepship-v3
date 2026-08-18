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
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { orderItems } from '../db/schema/order-items';
import {
  replacementActivityEvents,
  replacementItemRemaps,
  replacementItems,
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
  return conn.transaction(async (tx) => {
    const before = await loadForUpdate(tx, input.replacementId);
    return applyTransition(tx, before, {
      to: 'rejected', eventType: 'replacement_rejected', actor: input.actor,
      reason, idempotencySuffix: 'reject',
    });
  });
}

/**
 * Cancel — pre-ship only, which the state machine already enforces.
 *
 * This does NOT void a label. A cancelled replacement holding a purchased label requires an
 * explicit void or an audited retain decision; coupling the two here would let a local
 * cancellation pretend a provider void succeeded.
 */
export async function cancelReplacement(
  input: { replacementId: number; actor: LifecycleActor; reason: string },
  conn: Conn = db,
): Promise<ReplacementRow> {
  const reason = requireReason(input.reason, 'REPLACEMENT_REASON_REQUIRED');
  return conn.transaction(async (tx) => {
    const before = await loadForUpdate(tx, input.replacementId);
    return applyTransition(tx, before, {
      to: 'cancelled', eventType: 'replacement_cancelled', actor: input.actor,
      reason, idempotencySuffix: 'cancel',
    });
  });
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
  return conn.transaction(async (tx) => {
    const before = await loadForUpdate(tx, input.replacementId);
    return applyTransition(tx, before, {
      to: input.to,
      eventType: 'replacement_review_resolved',
      actor: input.actor,
      reason,
      idempotencySuffix: `review-${input.to}`,
      extra: { reviewReason: null },
    });
  });
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
