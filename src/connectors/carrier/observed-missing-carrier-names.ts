// PS-271 (Layer 4) — derive the NAMED missing-carrier list for a CarrierRateDiagnostic.
//
// The Shipp connector rides an observed-incomplete marker (shipp-observed-incomplete-marker.ts) on its
// rate array when Layer 1 accepted a known-thin partial; that marker carries `missing: string[]` — the
// observed-expected carriers that did NOT come back in the accepted pass. This pure helper normalizes
// that list into the diagnostic's `expectedCarrierAbsent` field so the out-of-band diagnostic can name
// exactly which carriers were absent (not just a thin boolean).
//
// Source-of-truth: the connector's observedMissing[] is the only authority for which carriers were
// expected-but-absent. Callers must delegate here rather than re-deriving the set. Returns undefined
// (NOT an empty array) when there is nothing to surface, so the field stays absent on every non-thin
// pass and the diagnostic is byte-identical to today.

/** The minimal thin-marker shape carried out of the connector via the rates pipeline. */
export type ObservedIncompleteThin = {
  observedIncomplete: true;
  missing: string[];
};

/**
 * Normalize the observed-incomplete marker's `missing` into a clean, de-duplicated, ordered list of
 * absent carrier names for `CarrierRateDiagnostic.expectedCarrierAbsent`. Returns undefined when the
 * marker is absent or names nothing — never an empty array — so the field is omitted on non-thin passes.
 */
export function expectedCarrierAbsentFromThin(
  thin: ObservedIncompleteThin | null | undefined,
): string[] | undefined {
  if (!thin || thin.observedIncomplete !== true || !Array.isArray(thin.missing)) return undefined;
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of thin.missing) {
    const name = String(raw ?? '').trim().toLowerCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names.length ? names : undefined;
}
