// PS-487 AC-4 / AC-7 — the return billing-date CORRECTION decision.
//
// Pure. Given who is asking, what they are asking for, and whether the affected periods
// are finalized, it says what may happen and what evidence must be recorded. It performs
// no write, so the rule is testable without a database or a route.
//
// It deliberately does NOT decide how an adjustment is computed or posted — PS-449's
// reconcileFinalizedBillingOrderAdjustments already owns that, and duplicating it here
// would create a second source of truth for finalized-period money.

export type ReturnDateCorrectionActor = {
  /** Backend-resolved role. Client-portal users are never admins. */
  isAdmin: boolean;
  actorId: string;
  actorEmail?: string | null;
};

export type ReturnDateCorrectionRequest = {
  returnId: number;
  /** ISO day the admin wants this return to bill in. */
  newBillingDay: string;
  reason: string;
  /** Evidence reference when the affected period is finalized (AC-6). */
  djApprovalReference?: string | null;
};

export type ReturnDateCorrectionContext = {
  /** returns.created_at — never overwritten; AC-7 keeps it as evidence. */
  systemCreatedDay: string;
  /** The day this return currently bills in (override, else creation). */
  currentBillingDay: string;
  /** Is the period the return bills in TODAY finalized? */
  currentPeriodFinalized: boolean;
  /** Is the period the admin wants to move it INTO finalized? */
  targetPeriodFinalized: boolean;
};

export type ReturnDateCorrectionDecision =
  | { kind: 'rejected'; code: ReturnDateCorrectionRejection; message: string }
  | { kind: 'noop'; message: string }
  | { kind: 'move'; newBillingDay: string; audit: ReturnDateCorrectionAudit }
  | {
      kind: 'adjustment_required';
      newBillingDay: string;
      /** Which side is frozen — both are possible and both need the override. */
      finalized: { current: boolean; target: boolean };
      audit: ReturnDateCorrectionAudit;
    };

export type ReturnDateCorrectionRejection =
  | 'not_admin'
  | 'reason_required'
  | 'invalid_date'
  | 'dj_approval_required';

/** AC-7 evidence. Assembled here so no caller can post a correction without it. */
export type ReturnDateCorrectionAudit = {
  returnId: number;
  oldBillingDay: string;
  newBillingDay: string;
  /** Preserved separately from oldBillingDay — a prior correction may already have moved it. */
  systemCreatedDay: string;
  actorId: string;
  actorEmail: string | null;
  reason: string;
  djApprovalReference: string | null;
  /**
   * AC-7 affected periods — the billing month the return moves OUT of and INTO.
   *
   * Derived here rather than read back later because they are a pure function of the two
   * days, and because "which periods did this touch" is the question an auditor asks
   * first. Recording only the days would make every reader re-derive it, and a reader
   * using a different month boundary would get a different answer.
   */
  fromPeriod: string;
  toPeriod: string;
  /**
   * Whether the correction crosses a finalized period and therefore produces a PS-449
   * adjustment rather than an in-place move.
   *
   * The adjustment's own id is deliberately NOT recorded here: it does not exist yet at
   * decision time — PS-449 mints it when the next open period is reconciled. Claiming an
   * id we have not seen would be worse evidence than admitting the linkage is pending.
   */
  adjustmentRequired: boolean;
};

/**
 * AC-7 evidence that can only be gathered against the database.
 *
 * Kept separate from ReturnDateCorrectionAudit so the decision module stays pure: it
 * decides, this records what the write actually touched. The apply service assembles it
 * inside the same transaction as the override, so the evidence cannot drift from the
 * change it describes.
 */
export type PersistedReturnDateCorrectionAudit = ReturnDateCorrectionAudit & {
  /**
   * billing_line_items.id for every row relationally attributed to this return via
   * PS-488 M2's return_id. This is the "affected billing rows" AC-7 asks for.
   */
  affectedBillingLineItemIds: number[];
  /**
   * Return-typed lines on the same order carrying return_id NULL.
   *
   * Every line generated before PS-488 M2 shipped is unattributed, so a non-zero count
   * means affectedBillingLineItemIds may be INCOMPLETE. Recorded rather than presenting
   * a partial list as whole — an audit trail that looks more certain than it is, is
   * worse than one that admits the gap. Zero means the list is trustworthy.
   *
   * Deliberately a count, not an attribution: guessing which of these belong to this
   * return is exactly the description-parsing/order-id matching that M1 existed to
   * replace.
   */
  unattributedLegacyReturnLines: number;
};

/** The billing period a day falls in. One definition, so no caller invents another. */
export function billingPeriodOf(day: string): string {
  return day.slice(0, 7);
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A billing day must be a REAL calendar day, not merely the right shape. '2026-13-40'
 * satisfies the regex and would otherwise flow into billing-period selection, where
 * Date coercion silently rolls it into some other month.
 */
function isRealIsoDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  // Round-trip: rejects overflow like 2026-02-31 that Date would quietly shift.
  return parsed.toISOString().slice(0, 10) === value;
}

/**
 * Decide what a requested return billing-date correction may do.
 *
 * AC-4: admin only, any past or future day, reason required.
 * AC-6: if either the current or the target period is finalized, normal editing is
 *       blocked and a DJ-approved override reference is mandatory; the result is an
 *       adjustment in the next open period, never a rewrite of the frozen invoice.
 * AC-7: every outcome that changes anything carries full audit evidence.
 */
export function resolveReturnDateCorrection(input: {
  actor: ReturnDateCorrectionActor;
  request: ReturnDateCorrectionRequest;
  context: ReturnDateCorrectionContext;
}): ReturnDateCorrectionDecision {
  const { actor, request, context } = input;

  // Client users can neither call this nor learn anything from it.
  if (!actor.isAdmin) {
    return {
      kind: 'rejected',
      code: 'not_admin',
      message: 'Only an administrator can change a return billing date.',
    };
  }

  const newDay = typeof request.newBillingDay === 'string' ? request.newBillingDay.trim() : '';
  if (!isRealIsoDay(newDay)) {
    return {
      kind: 'rejected',
      code: 'invalid_date',
      message: 'A billing date correction needs a valid calendar day (YYYY-MM-DD).',
    };
  }

  const reason = typeof request.reason === 'string' ? request.reason.trim() : '';
  if (reason.length < 3) {
    return {
      kind: 'rejected',
      code: 'reason_required',
      message: 'A billing date correction requires a reason.',
    };
  }

  // Nothing to do. Reported rather than silently succeeding, so an operator is not told
  // a correction was recorded when no evidence was written.
  if (newDay === context.currentBillingDay) {
    return { kind: 'noop', message: 'The return already bills on that day.' };
  }

  const touchesFinalized = context.currentPeriodFinalized || context.targetPeriodFinalized;

  const audit: ReturnDateCorrectionAudit = {
    returnId: request.returnId,
    oldBillingDay: context.currentBillingDay,
    newBillingDay: newDay,
    systemCreatedDay: context.systemCreatedDay,
    actorId: actor.actorId,
    actorEmail: actor.actorEmail ?? null,
    reason,
    djApprovalReference: request.djApprovalReference?.trim() || null,
    // AC-7 affected periods, from the canonical helper so no caller re-derives them.
    fromPeriod: billingPeriodOf(context.currentBillingDay),
    toPeriod: billingPeriodOf(newDay),
    // Recorded on EVERY outcome, including a plain move where it is false. An absent
    // field would be ambiguous between "no adjustment" and "nobody checked".
    adjustmentRequired: touchesFinalized,
  };
  if (!touchesFinalized) {
    return { kind: 'move', newBillingDay: newDay, audit };
  }

  // Moving money out of, or into, a frozen period needs explicit approval evidence.
  if (!audit.djApprovalReference) {
    return {
      kind: 'rejected',
      code: 'dj_approval_required',
      message:
        'That change affects a finalized billing period and requires DJ-approved override evidence.',
    };
  }

  return {
    kind: 'adjustment_required',
    newBillingDay: newDay,
    finalized: {
      current: context.currentPeriodFinalized,
      target: context.targetPeriodFinalized,
    },
    audit,
  };
}

/** The append-only audit event type written to return_activity_events. */
export const RETURN_BILLING_DATE_CORRECTED_EVENT = 'billing_date_corrected';
