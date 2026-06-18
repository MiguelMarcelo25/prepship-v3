// PS-166 (#685): the backend best-rate completeness reader, in its own small file
// (DJ preference: new functions live in their own short module). Extracted VERBATIM
// from OrdersView.tsx — pure, no behavior change. It READS the backend best-rate DTO
// only (its `bestRate.isComplete` stamp, else the backend `carrierStatuses`); it never
// recomputes a money/insurance verdict and the FE never asserts completeness on its own.
//
// PS-143 stays intact: this reader is independent of buildRateRequestDraftKey — the FE
// draft key is NOT derived from the backend response fingerprint, so moving this reader
// here cannot couple the two.
import { toRecord, toStringValue } from './orders-row-display'

// PS-111: completeness is BACKEND-OWNED. Prefer the backend-stamped
// `bestRate.isComplete`; otherwise derive it from the backend carrier statuses
// (complete only when no carrier is still loading or errored). The frontend must
// NOT assert `isComplete: true` just because a rate exists — a rate found while a
// carrier failed/loaded is partial, and the workflow status must reflect that.
export function deriveBackendBestRateComplete(
  response: Record<string, unknown> | null | undefined,
  rate?: Record<string, unknown> | null,
): boolean {
  const stamped = toRecord(rate)?.isComplete
  if (typeof stamped === 'boolean') return stamped
  const statuses = Array.isArray(response?.carrierStatuses)
    ? response!.carrierStatuses as Array<Record<string, unknown>>
    : []
  if (!statuses.length) return false
  return statuses.every((status) => {
    const value = toStringValue(toRecord(status)?.status)
    return value !== 'loading' && value !== 'error'
  })
}
