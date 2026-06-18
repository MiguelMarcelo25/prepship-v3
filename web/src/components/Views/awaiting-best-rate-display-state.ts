// PS-286 (slice): map the BACKEND rate source-of-truth verdict for an
// awaiting_shipment row into an EXPLICIT Best-Rate-column display state, so a
// stale / incomplete / expired / eligibility-mismatched saved rate renders an
// actionable label instead of a confident (but no-longer-valid) dollar figure.
//
// SOURCE OF TRUTH: this is a PURE classifier over verdicts the backend already
// owns and stamps on the DTO (order-rate-dto.ts -> normalizeOrderBestRateDto:
// isComplete / cacheExpiresAt / eligibilityVersion) plus the canonical FE
// display contract (orders-parity.ts -> savedBestRateCanDisplayForCurrentRequest).
// It does NOT recompute any money, insurance, or eligibility VERDICT — it only
// turns the existing booleans/strings into a UI state name. The column is a thin
// consumer: it asks this function "may I show the saved dollar figure, and if
// not, why" and renders accordingly.

export type AwaitingBestRateDisplayState =
  // The saved best rate passes the backend + FE display contract — show the $ amount.
  | 'show_amount'
  // A saved rate exists but its eligibility version no longer matches the
  // current required version (carrier/service catalog moved) — must re-rate.
  | 'eligibility_mismatch'
  // The backend marked the saved rate as not fully priced/complete — must re-rate.
  | 'coverage_incomplete'
  // The saved rate's cache window has elapsed — must re-rate.
  | 'expired'
  // Dimensions/weight are missing, so no rate can be computed yet.
  | 'add_dims'
  // A saved rate exists but does not satisfy the display contract for any of the
  // generic reasons above (e.g. unproven / request-key mismatch) — must re-rate.
  | 'recalculate_required'
  // No saved rate at all for this row.
  | 'no_rate'

export type AwaitingBestRateDisplayInput = {
  // Whether the row carries ANY saved best-rate record with a positive base amount.
  hasSavedBestRate: boolean
  // The single canonical FE display verdict
  // (savedBestRateCanDisplayForCurrentRequest result). When true => show_amount.
  canDisplaySavedRate: boolean
  // Backend-stamped completeness verdict (OrderBestRateDto.isComplete).
  isComplete: boolean | null
  // Backend-stamped cache expiry (OrderBestRateDto.cacheExpiresAt, ISO string).
  cacheExpiresAt: string | null
  // Backend-stamped eligibility version on the saved rate vs the version the
  // current request requires (SHIPPING_SERVICE_ELIGIBILITY_VERSION).
  eligibilityVersion: string | null
  requiredEligibilityVersion: string | null
  // Whether the row currently has complete dims + weight (so a rate is even possible).
  hasDimsAndWeight: boolean
  nowMs?: number
}

// PS-286: explicit-state precedence. Eligibility mismatch and incompleteness are
// classified BEFORE expiry so the operator sees the most specific actionable
// reason; add_dims is the terminal fallback for a row that cannot be rated yet.
export function classifyAwaitingBestRateDisplay(
  input: AwaitingBestRateDisplayInput,
): AwaitingBestRateDisplayState {
  if (input.canDisplaySavedRate) return 'show_amount'
  if (!input.hasSavedBestRate) {
    return input.hasDimsAndWeight ? 'no_rate' : 'add_dims'
  }
  // A saved rate exists but is not displayable — surface the most specific reason.
  if (
    input.requiredEligibilityVersion != null &&
    input.eligibilityVersion !== input.requiredEligibilityVersion
  ) {
    return 'eligibility_mismatch'
  }
  if (input.isComplete === false) return 'coverage_incomplete'
  const expiresAt = input.cacheExpiresAt
  if (expiresAt) {
    const expiresMs = Date.parse(expiresAt)
    if (Number.isFinite(expiresMs) && expiresMs <= (input.nowMs ?? Date.now())) {
      return 'expired'
    }
  }
  return 'recalculate_required'
}

// Operator-facing label for each explicit state. Pure presentation; no policy.
export const AWAITING_BEST_RATE_STATE_LABELS: Record<AwaitingBestRateDisplayState, string> = {
  show_amount: '',
  eligibility_mismatch: 'Carrier coverage incomplete',
  coverage_incomplete: 'Carrier coverage incomplete',
  expired: 'Rate expired',
  add_dims: 'Add Dims',
  recalculate_required: 'Recalculate required',
  no_rate: '',
}
