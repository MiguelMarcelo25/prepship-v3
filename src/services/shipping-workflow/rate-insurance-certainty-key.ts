// PS-274 — read the canonical insurance-CERTAINTY STATE off a rate/proof row.
//
// `resolveInsuranceCertainty` (insurance-certainty.ts) stamps a full
// InsuranceCertaintyResult object onto each rate; the connector rides it as
// `rate.insuranceCertainty`. The ONE fact the rate fingerprint + selected-rate
// proof must bind is the certainty *state* string (e.g.
// 'requested_application_uncertain' vs 'explicitly_included'). This pure reader
// normalizes that state out of either shape (the full object, or a bare state
// string) so a rate quoted as UNCERTAIN cannot later round-trip as
// proven-insured: its authority key carries the uncertain state, which a
// claimed 'explicitly_included' eligible rate will not match.
//
// Returns '' when the rate carries no certainty at all — keeping the fingerprint
// and authority key BYTE-IDENTICAL for every legacy/non-Shipp caller (additive).

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalized insurance-certainty STATE for one rate/proof row, or '' when absent.
 * Reads `rate.insuranceCertainty.certainty` (the stamped result object) first,
 * then a bare `rate.insuranceCertainty` string. Never throws.
 */
export function readRateInsuranceCertaintyState(rate: unknown): string {
  const row = isRecord(rate) ? rate : null;
  if (!row) return '';
  const meta = isRecord(row.insuranceCertainty) ? row.insuranceCertainty : null;
  const raw = meta?.certainty ?? row.insuranceCertainty;
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}
