export type RatePreExpiryRefreshReason =
  | 'missing_rate'
  | 'missing_expiry'
  | 'missing_proof'
  | 'incomplete_proof'
  | 'incomplete_tuple'
  | 'expired'
  | 'near_expiry'
  | 'fresh';

type PolicyOptions = {
  nowMs?: number;
  refreshLeadMs?: number;
};

const DEFAULT_PREEXPIRY_REFRESH_LEAD_MS = 60 * 60 * 1000;

function readEnvLeadMs(): number {
  const explicitMs = Number.parseInt(process.env.RATE_PREEXPIRY_REFRESH_LEAD_MS ?? '', 10);
  if (Number.isFinite(explicitMs) && explicitMs > 0) return explicitMs;
  const hours = Number.parseFloat(process.env.RATE_PREEXPIRY_REFRESH_LEAD_HOURS ?? '');
  if (Number.isFinite(hours) && hours > 0) return Math.round(hours * 3_600_000);
  return DEFAULT_PREEXPIRY_REFRESH_LEAD_MS;
}

// Backend-owned PS-348 freshness lead. The hard purchase/proof TTL still lives in rates.ts;
// this window only decides how early the scheduler should refresh a visible tuple before it expires.
export const RATE_PREEXPIRY_REFRESH_LEAD_MS = Math.max(5 * 60 * 1000, readEnvLeadMs());

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function finitePositiveNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function nestedMetadata(rate: Record<string, unknown>): Record<string, unknown> {
  return isRecord(rate.metadata) ? rate.metadata : {};
}

function rateString(rate: Record<string, unknown>, key: string): string | null {
  const metadata = nestedMetadata(rate);
  return stringOrNull(rate[key]) ?? stringOrNull(metadata[key]);
}

function rateNumber(rate: Record<string, unknown>, ...keys: string[]): number | null {
  const metadata = nestedMetadata(rate);
  for (const key of keys) {
    const direct = finitePositiveNumber(rate[key]);
    if (direct != null) return direct;
    const nested = finitePositiveNumber(metadata[key]);
    if (nested != null) return nested;
  }
  return null;
}

export function rateCacheExpiresAtMs(rate: unknown): number | null {
  if (!isRecord(rate)) return null;
  const raw = rateString(rate, 'cacheExpiresAt');
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function classifyRatePreExpiryRefresh(
  rate: unknown,
  options: PolicyOptions = {},
): RatePreExpiryRefreshReason {
  if (!isRecord(rate)) return 'missing_rate';
  if (rateNumber(rate, 'cShippingRateAmount') == null) return 'incomplete_tuple';
  if (rateNumber(rate, 'selectedRateCost') == null) return 'incomplete_tuple';
  if (rate.isComplete !== true && nestedMetadata(rate).isComplete !== true) return 'incomplete_proof';

  const proofSource = rateString(rate, 'proofSource');
  const requestFingerprint = rateString(rate, 'requestFingerprint');
  const cacheKey = rateString(rate, 'cacheKey');
  const rateQuoteId = rateString(rate, 'rateQuoteId');
  const selectedRateKey = rateString(rate, 'selectedRateKey');
  if (
    proofSource !== 'backend_rate_response' ||
    !requestFingerprint ||
    !cacheKey ||
    !rateQuoteId ||
    !selectedRateKey
  ) {
    return 'missing_proof';
  }

  const expiresAtMs = rateCacheExpiresAtMs(rate);
  if (expiresAtMs == null) return 'missing_expiry';
  const nowMs = options.nowMs ?? Date.now();
  if (expiresAtMs <= nowMs) return 'expired';
  const refreshLeadMs = options.refreshLeadMs ?? RATE_PREEXPIRY_REFRESH_LEAD_MS;
  if (expiresAtMs <= nowMs + refreshLeadMs) return 'near_expiry';
  return 'fresh';
}

export function shouldPreExpiryRefreshRate(rate: unknown, options: PolicyOptions = {}): boolean {
  return classifyRatePreExpiryRefresh(rate, options) !== 'fresh';
}
