import {
  rateCacheExpiresAtMs,
  type RatePreExpiryRefreshReason,
} from './rate-preexpiry-refresh-policy';

export const PREEXPIRY_REFRESH_REASONS: RatePreExpiryRefreshReason[] = [
  'missing_rate',
  'missing_expiry',
  'missing_proof',
  'incomplete_proof',
  'incomplete_tuple',
  'expired',
  'near_expiry',
  'fresh',
];

export type PreExpiryRefreshProof = {
  selected: number;
  refreshed: number;
  skipped: number;
  pushedForward: number;
  tupleRefreshed: number;
  reasons: Record<RatePreExpiryRefreshReason, number>;
};

export type PreExpiryRefreshResultInput = {
  before: unknown;
  after: unknown;
  updated: boolean;
};

function createReasonCounters(): Record<RatePreExpiryRefreshReason, number> {
  return Object.fromEntries(PREEXPIRY_REFRESH_REASONS.map((reason) => [reason, 0])) as Record<
    RatePreExpiryRefreshReason,
    number
  >;
}

function positiveNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function readTupleNumber(rate: unknown, ...keys: string[]): number | null {
  if (rate === null || typeof rate !== 'object' || Array.isArray(rate)) return null;
  const record = rate as Record<string, unknown>;
  const metadata =
    record.metadata !== null && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? record.metadata as Record<string, unknown>
      : {};
  for (const key of keys) {
    const direct = positiveNumber(record[key]);
    if (direct != null) return direct;
    const nested = positiveNumber(metadata[key]);
    if (nested != null) return nested;
  }
  return null;
}

function hasCustomerAndCostTuple(rate: unknown): boolean {
  return (
    readTupleNumber(rate, 'customerRateAmount', 'customer_rate_amount') != null &&
    readTupleNumber(rate, 'rateCostAmount', 'rate_cost_amount') != null
  );
}

export function createPreExpiryRefreshProof(): PreExpiryRefreshProof {
  return {
    selected: 0,
    refreshed: 0,
    skipped: 0,
    pushedForward: 0,
    tupleRefreshed: 0,
    reasons: createReasonCounters(),
  };
}

export function recordPreExpirySelection(
  proof: PreExpiryRefreshProof,
  reason: RatePreExpiryRefreshReason,
): void {
  proof.selected += 1;
  proof.reasons[reason] = (proof.reasons[reason] ?? 0) + 1;
}

export function recordPreExpiryRefreshResult(
  proof: PreExpiryRefreshProof,
  input: PreExpiryRefreshResultInput,
): void {
  if (!input.updated) {
    proof.skipped += 1;
    return;
  }
  proof.refreshed += 1;

  const beforeExpiresAt = rateCacheExpiresAtMs(input.before);
  const afterExpiresAt = rateCacheExpiresAtMs(input.after);
  if (afterExpiresAt != null && (beforeExpiresAt == null || afterExpiresAt > beforeExpiresAt)) {
    proof.pushedForward += 1;
  }
  if (hasCustomerAndCostTuple(input.after)) {
    proof.tupleRefreshed += 1;
  }
}
