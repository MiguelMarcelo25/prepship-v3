/**
 * PS-502 — the replacement lifecycle, as a pure state machine.
 *
 * PURE AND UNLOCKED. This module decides whether a transition is legal and nothing else:
 * no database, no shipment, no label, no inventory, no billing. That is what keeps it
 * inside the card's "no unlock" list — the commands that ACT on these verdicts (the create
 * command, shipment insertion, label purchase, the `shipped` write, inventory deduction)
 * require `unlock shipped data` and are not in this slice.
 *
 * WHY A TABLE RATHER THAN CONDITIONALS
 *
 * The card specifies the lifecycle as a diagram plus a set of prose rules. Encoding it as
 * scattered `if (status === ...)` checks in route handlers is how two callers come to
 * disagree about whether `label_failed → shipped` is legal. One table, one predicate, and
 * the routes ask rather than decide.
 *
 * FAIL CLOSED. Anything not listed is ILLEGAL. The card's diagram is the authority, and
 * where it is silent this module refuses rather than guessing — a wrong "allow" here
 * eventually purchases a label or moves stock, while a wrong "deny" surfaces as a 409 that
 * a human reads.
 */

export const REPLACEMENT_STATUSES = [
  'requested',
  'review',
  'approved',
  'label_created',
  'label_failed',
  'shipped',
  'completed',
  'rejected',
  'cancelled',
] as const;

export type ReplacementStatus = (typeof REPLACEMENT_STATUSES)[number];

/**
 * Post-ship states. The card is explicit: "After `shipped`/`completed`: never rewrite or
 * invalidate. A later refresh does not change what shipped." Cancellation and rejection
 * are pre-ship only, so neither is reachable from here.
 */
export const REPLACEMENT_POST_SHIP_STATUSES: readonly ReplacementStatus[] = ['shipped', 'completed'];

/** No transition leaves these. */
export const REPLACEMENT_TERMINAL_STATUSES: readonly ReplacementStatus[] = [
  'completed',
  'rejected',
  'cancelled',
];

/**
 * The legal moves, transcribed from the card's diagram and its prose:
 *
 *   requested → approved → label_created → shipped → completed
 *      ↕ review              ↘ label_failed ↗    cancelled/rejected terminal pre-ship
 *
 * Plus the review rules stated in section A:
 *   - pre-label drift (requested/review/approved/label_failed) → review
 *   - at label_created, a NEW mismatch → review, "shipping blocked"; the purchased label is
 *     preserved and requires explicit void, retain-pending, or approved remap/re-rate.
 *
 * `shipped` is deliberately NOT reachable from `review`: review at label_created blocks
 * shipping, and leaving review is an explicit operator action back to a pre-ship state.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<ReplacementStatus, readonly ReplacementStatus[]>> = {
  requested: ['review', 'approved', 'rejected', 'cancelled'],
  // Review is exited by resolving it — back to the pre-label state the operator chooses, or
  // out of the workflow. It never jumps forward to a shipped state.
  review: ['requested', 'approved', 'label_created', 'rejected', 'cancelled'],
  approved: ['review', 'label_created', 'label_failed', 'cancelled'],
  // A purchase attempt either produced a label or did not.
  label_created: ['review', 'shipped', 'cancelled'],
  label_failed: ['review', 'approved', 'label_created', 'cancelled'],
  // The one-way door. Everything after this is history.
  shipped: ['completed'],
  completed: [],
  rejected: [],
  cancelled: [],
};

/** Coded 409s. Routes return these verbatim; the card names each one. */
export const REPLACEMENT_ERROR_CODES = {
  /** Optimistic-concurrency miss: status or state_version moved under the caller. */
  STATE_CONFLICT: 'REPLACEMENT_STATE_CONFLICT',
  /** The frozen source coordinate no longer matches the order. Never silently retarget. */
  SOURCE_LINE_CHANGED: 'REPLACEMENT_SOURCE_LINE_CHANGED',
  /** INVENTORY_AUTO_DEDUCT is off, so shipping cannot deduct and must not proceed. */
  INVENTORY_DISABLED: 'REPLACEMENT_INVENTORY_DISABLED',
} as const;

export type ReplacementErrorCode =
  (typeof REPLACEMENT_ERROR_CODES)[keyof typeof REPLACEMENT_ERROR_CODES];

export class ReplacementStateError extends Error {
  readonly code: ReplacementErrorCode;
  readonly httpStatus = 409;
  readonly from: ReplacementStatus | null;
  readonly to: ReplacementStatus | null;

  constructor(
    code: ReplacementErrorCode,
    message: string,
    from: ReplacementStatus | null = null,
    to: ReplacementStatus | null = null,
  ) {
    super(message);
    this.name = 'ReplacementStateError';
    this.code = code;
    this.from = from;
    this.to = to;
  }
}

export function isReplacementStatus(value: unknown): value is ReplacementStatus {
  return typeof value === 'string' && (REPLACEMENT_STATUSES as readonly string[]).includes(value);
}

export function isReplacementTerminal(status: ReplacementStatus): boolean {
  return REPLACEMENT_TERMINAL_STATUSES.includes(status);
}

export function isReplacementPostShip(status: ReplacementStatus): boolean {
  return REPLACEMENT_POST_SHIP_STATUSES.includes(status);
}

/** Every status reachable in one legal step. */
export function replacementTransitionsFrom(status: ReplacementStatus): readonly ReplacementStatus[] {
  return ALLOWED_TRANSITIONS[status] ?? [];
}

export function canTransitionReplacement(
  from: ReplacementStatus,
  to: ReplacementStatus,
): boolean {
  return replacementTransitionsFrom(from).includes(to);
}

/**
 * Assert a transition, or throw the coded 409 a route returns verbatim.
 *
 * A self-transition is rejected rather than treated as a no-op: `approved → approved`
 * reaching this function means a caller believes it is advancing the workflow when it is
 * not, and swallowing that hides a bug behind a success response.
 */
export function assertReplacementTransition(
  from: ReplacementStatus,
  to: ReplacementStatus,
): void {
  if (!canTransitionReplacement(from, to)) {
    const allowed = replacementTransitionsFrom(from);
    throw new ReplacementStateError(
      REPLACEMENT_ERROR_CODES.STATE_CONFLICT,
      `replacement cannot move ${from} -> ${to}. ` +
        (allowed.length ? `Legal from ${from}: ${allowed.join(', ')}.` : `${from} is terminal.`),
      from,
      to,
    );
  }
}

/**
 * The drift verdict, as data.
 *
 * Deliberately returns a decision rather than performing one: the card requires a mismatch
 * to produce `status=review`, `review_reason=original_order_line_drift` and a
 * 409 REPLACEMENT_SOURCE_LINE_CHANGED with NO label, inventory, package or billing effect.
 * Keeping that verdict pure means the caller cannot half-apply it.
 */
export type ReplacementDriftVerdict =
  | { matches: true }
  | { matches: false; code: ReplacementErrorCode; reviewReason: 'original_order_line_drift' };

export function evaluateReplacementSourceLineDrift(input: {
  frozenFingerprint: string;
  currentFingerprint: string | null | undefined;
}): ReplacementDriftVerdict {
  // A missing current fingerprint is drift, not a pass. The referenced line being GONE is
  // one of the four drift cases the card enumerates, and treating absence as "unchanged"
  // would let the worst case through.
  if (!input.currentFingerprint || input.currentFingerprint !== input.frozenFingerprint) {
    return {
      matches: false,
      code: REPLACEMENT_ERROR_CODES.SOURCE_LINE_CHANGED,
      reviewReason: 'original_order_line_drift',
    };
  }
  return { matches: true };
}
