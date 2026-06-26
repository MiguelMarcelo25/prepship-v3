export const RATE_BROWSER_BACKEND_PROOF_UNAVAILABLE_REASON =
  'Backend rate proof unavailable - browse rates again before selecting.';

const DEFAULT_ELIGIBILITY_BLOCK_REASON = 'Shipping service is not eligible for this order.';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readBackendEligibilityBlockReason(rate: unknown): string | null {
  const record = asRecord(rate);
  const raw = asRecord(record?.raw);
  const blocked = record?.eligibilityBlocked ?? raw?.eligibilityBlocked;
  if (blocked !== true) return null;
  return (
    readString(record?.eligibilityBlockReason) ??
    readString(raw?.eligibilityBlockReason) ??
    DEFAULT_ELIGIBILITY_BLOCK_REASON
  );
}

export function rateBrowserBackendProofIsComplete(rate: unknown): boolean {
  const record = asRecord(rate);
  const raw = asRecord(record?.raw);
  if (record?.testRate === true || raw?.testRate === true || record?.mocked === true || raw?.mocked === true) {
    return true;
  }
  return record?.isComplete === true || raw?.isComplete === true;
}

export function rateBrowserUnavailableReason(rate: unknown): string | null {
  return (
    readBackendEligibilityBlockReason(rate) ??
    (rateBrowserBackendProofIsComplete(rate) ? null : RATE_BROWSER_BACKEND_PROOF_UNAVAILABLE_REASON)
  );
}

export function rateBrowserCanApplyRate(rate: unknown): boolean {
  return rateBrowserUnavailableReason(rate) == null;
}
