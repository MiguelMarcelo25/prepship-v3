// PS-286 (slice): make the Print Queue preflight consume the SAME backend rate
// source-of-truth verdict the Awaiting "Best Rate" column does, so the two AGREE.
//
// The Awaiting column derives an explicit AwaitingBestRateDisplayState from the
// backend verdict (isComplete / cacheExpiresAt / eligibilityVersion, surfaced via
// savedBestRateCanDisplayForCurrentRequest -> classifyAwaitingBestRateDisplay).
// When an order has NO already-bought queueable label, the Send-to-Queue preflight
// would otherwise build a label payload from order.bestRate and hand it to the
// purchase boundary — even when that saved rate is STALE / incomplete / expired /
// eligibility-mismatched. That silently queues a confident-looking rate the
// Awaiting column is simultaneously refusing to show as a dollar figure.
//
// This PURE mapping closes that gap. It does NOT recompute any money / insurance /
// eligibility verdict — it takes the explicit state the Awaiting column already
// computed and answers one question: "is this saved rate queueable AS-CURRENT, or
// must the row be re-rated first?". Only an explicit show_amount state (the same
// state that renders a dollar figure) is queueable-as-current; every actionable
// state (eligibility_mismatch / coverage_incomplete / expired / recalculate_required
// / add_dims / no_rate) is treated as NOT queueable-as-current with the same reason
// the column surfaces. Because both consumers read the identical classifier output,
// Print-Queue and Awaiting can never disagree about a given row.

import type { AwaitingBestRateDisplayState } from './awaiting-best-rate-display-state'

export type PrintQueuePreflightVerdict = {
  // True only when the saved best rate is the backend-confirmed current rate (the
  // same state the Awaiting column shows as a dollar figure).
  queueableAsCurrent: boolean
  // The explicit Awaiting state this verdict mirrors — so the preflight surfaces
  // the EXACT same actionable reason the column shows, never a generic message.
  state: AwaitingBestRateDisplayState
  // null when queueable; otherwise the not-queueable-as-current reason (the state
  // name), so the caller can skip the order with an explicit, column-aligned cause.
  blockedReason: AwaitingBestRateDisplayState | null
}

// The Awaiting "Best Rate" column renders a dollar figure ONLY for show_amount.
// Every other explicit state is an actionable "must re-rate / add dims" label, so
// the saved rate is not the current rate and must not be silently queued.
export function classifyPrintQueuePreflightFromAwaitingState(
  state: AwaitingBestRateDisplayState,
): PrintQueuePreflightVerdict {
  const queueableAsCurrent = state === 'show_amount'
  return {
    queueableAsCurrent,
    state,
    blockedReason: queueableAsCurrent ? null : state,
  }
}
