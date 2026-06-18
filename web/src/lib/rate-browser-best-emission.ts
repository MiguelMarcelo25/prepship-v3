// PS-279: the Rate Browser may ONLY emit/persist the backend's canonical best rate.
//
// The backend (src/services/rates.ts) owns best-rate selection — it picks the cheapest
// ELIGIBLE rate POST-markup. The Rate Browser CONSUMES that canonical winner; it must never
// substitute a frontend-ranked local "cheapest" when the backend best is absent. A FE re-rank
// can silently diverge from the backend (markup-map drift, eligibility differences) and persist
// a different "best" than the table/row shows — exactly what this slice forbids.
//
// This pure boundary encodes the rule: given the resolved canonical best (already matched to an
// eligible modal row via findCanonicalBestRate), return what — if anything — may be emitted.
// When canonicalBest is null the caller emits NOTHING and shows an unresolved/retry state.

export type BestEmissionDecision<T> =
  | { kind: 'emit'; rate: T }
  | { kind: 'unresolved' };

/**
 * Decide the Rate Browser's best-rate emission.
 *
 * - canonicalBest present  → emit it verbatim (backend authority).
 * - canonicalBest is null  → 'unresolved' (no FE-ranked local fallback; the modal shows a
 *   retry/diagnostic state and persists nothing).
 */
export function decideBestRateEmission<T>(canonicalBest: T | null | undefined): BestEmissionDecision<T> {
  if (canonicalBest == null) return { kind: 'unresolved' };
  return { kind: 'emit', rate: canonicalBest };
}
