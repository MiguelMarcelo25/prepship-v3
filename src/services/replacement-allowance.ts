/**
 * PS-502 decision 5 — the cumulative replacement cap.
 *
 * PURE AND UNLOCKED. Arithmetic over replacement rows the caller already holds. It reads no
 * shipment, moves no stock and writes nothing; the card unlocks "scoped read models over the
 * NEW replacement tables", and this is the policy those reads feed.
 *
 * FROZEN CONTRACT (DJ, pinned comment — supersedes the card description):
 *
 *   remaining_allowance(order_line) =
 *     original_ordered_quantity
 *     - SUM(replacement_items.quantity) for that frozen line
 *       WHERE replacement.status IN ('shipped','completed')
 *          OR (status = 'review' AND shipped_at IS NOT NULL)
 *
 * WHY ONLY SHIPPED UNITS COUNT
 *
 * The cap exists to stop repeated replacements silently over-shipping. What consumes stock
 * is goods physically leaving the warehouse, so a `requested` or `approved` replacement — or
 * one that reached `label_created` and was then cancelled — has taken nothing and must not
 * hold allowance hostage. Counting those would make a cancelled replacement permanently
 * reduce what a customer can be re-sent, with no goods movement behind it.
 *
 * WHY post-ship `review` STILL COUNTS
 *
 * `review` is reachable from `label_created` after a label exists, and section A also drives
 * a shipped replacement into `review` on later drift. Status alone cannot tell those apart —
 * `shipped_at` can. A replacement that shipped and then landed in review HAS consumed stock,
 * and ignoring it would let the same units go out twice.
 */

import type { ReplacementStatus } from './replacement-state-machine';

/** Statuses that consume allowance outright. */
const ALLOWANCE_CONSUMING_STATUSES: readonly ReplacementStatus[] = ['shipped', 'completed'];

/** The distinct override reason the decision names, so genuine re-replacements stay separable. */
export const REPLACEMENT_OF_FAILED_REPLACEMENT = 'replacement_of_failed_replacement';

export type AllowanceRow = {
  /** The frozen coordinate this item was created against. */
  sourceLineFingerprint: string;
  quantity: number;
  status: ReplacementStatus;
  /** Non-null once the replacement shipped, whatever its status is now. */
  shippedAt: Date | string | null | undefined;
};

export type ReplacementAllowance = {
  originalOrderedQuantity: number;
  consumed: number;
  remaining: number;
  /** True when the requested quantity fits without an override. */
  withinAllowance: boolean;
  /** By how much a request exceeds the remaining allowance; 0 when it fits. */
  exceededBy: number;
};

/**
 * Does this row consume allowance?
 *
 * Exported because the same predicate must answer both "what is left" and "why", and two
 * copies of a rule this load-bearing is how the cap and its explanation come to disagree.
 */
export function consumesReplacementAllowance(row: {
  status: ReplacementStatus;
  shippedAt: Date | string | null | undefined;
}): boolean {
  if (ALLOWANCE_CONSUMING_STATUSES.includes(row.status)) return true;
  // Post-ship review only. A pre-ship review has shipped nothing.
  return row.status === 'review' && row.shippedAt != null;
}

/**
 * Remaining allowance for ONE frozen source line.
 *
 * Aggregates on the frozen fingerprint, never on whichever SKU currently occupies the index
 * (correction A). If the cap were computed from the live line, a reorder would silently reset
 * it and the over-ship this exists to prevent would become possible precisely when the order
 * was edited.
 *
 * Rows whose fingerprint does not match are ignored rather than rejected: callers pass a
 * per-order query, and being strict about unrelated lines here would turn a harmless
 * over-fetch into a failure.
 */
export function calculateReplacementAllowance(input: {
  originalOrderedQuantity: number;
  sourceLineFingerprint: string;
  rows: readonly AllowanceRow[];
  /** Quantity being requested now. Omit to ask only what remains. */
  requestedQuantity?: number;
}): ReplacementAllowance {
  const original = Number.isFinite(input.originalOrderedQuantity)
    ? Math.max(0, Math.trunc(input.originalOrderedQuantity))
    : 0;

  let consumed = 0;
  for (const row of input.rows) {
    if (row.sourceLineFingerprint !== input.sourceLineFingerprint) continue;
    if (!consumesReplacementAllowance(row)) continue;
    if (!Number.isFinite(row.quantity)) continue;
    consumed += Math.max(0, Math.trunc(row.quantity));
  }

  // Clamped at zero: an over-ship that already happened (via override) leaves nothing
  // further available, and a negative "remaining" would read as credit.
  const remaining = Math.max(0, original - consumed);
  const requested = Number.isFinite(input.requestedQuantity ?? NaN)
    ? Math.max(0, Math.trunc(input.requestedQuantity as number))
    : 0;

  return {
    originalOrderedQuantity: original,
    consumed,
    remaining,
    withinAllowance: requested <= remaining,
    exceededBy: Math.max(0, requested - remaining),
  };
}

export type AllowanceOverride = {
  /** `replacements:override` must be held; the caller resolves the permission. */
  hasOverridePermission: boolean;
  reason: string | null | undefined;
};

export type AllowanceVerdict =
  | { allowed: true; viaOverride: boolean; allowance: ReplacementAllowance }
  | { allowed: false; code: 'REPLACEMENT_ALLOWANCE_EXCEEDED'; allowance: ReplacementAllowance; detail: string };

/**
 * The gate: may this quantity be requested against this line?
 *
 * Returns a verdict rather than performing one, for the same reason the drift check does —
 * a caller cannot half-apply a decision it was handed as data.
 *
 * An override without a reason is refused. "admin_override = true" with nothing behind it is
 * an unattributable claim, which is the same rule `replacements_admin_override_attribution_check`
 * enforces in the database; enforcing it here too means the request fails before it reaches a
 * constraint violation.
 */
export function evaluateReplacementAllowance(input: {
  originalOrderedQuantity: number;
  sourceLineFingerprint: string;
  rows: readonly AllowanceRow[];
  requestedQuantity: number;
  override?: AllowanceOverride;
}): AllowanceVerdict {
  const allowance = calculateReplacementAllowance(input);
  if (allowance.withinAllowance) {
    return { allowed: true, viaOverride: false, allowance };
  }

  const override = input.override;
  const reason = typeof override?.reason === 'string' ? override.reason.trim() : '';
  if (override?.hasOverridePermission && reason !== '') {
    return { allowed: true, viaOverride: true, allowance };
  }

  return {
    allowed: false,
    code: 'REPLACEMENT_ALLOWANCE_EXCEEDED',
    allowance,
    detail:
      `requested ${Math.max(0, Math.trunc(input.requestedQuantity))} but only ${allowance.remaining} of ` +
      `${allowance.originalOrderedQuantity} remain (${allowance.consumed} already shipped). ` +
      `An override requires replacements:override and a reason` +
      `; use "${REPLACEMENT_OF_FAILED_REPLACEMENT}" when replacing a replacement that shipped and was lost.`,
  };
}
