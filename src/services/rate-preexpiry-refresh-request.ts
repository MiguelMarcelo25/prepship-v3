import type { RateFetchPriority } from './rates';
import type { RatePreExpiryRefreshReason } from './rate-preexpiry-refresh-policy';

export type PreExpiryBackfillMode = 'cache_first' | 'full_live_audit' | 'preexpiry_refresh' | undefined;

export type BackfillRateFetchDecision = {
  forceRefresh: boolean;
  priority: RateFetchPriority;
  reason: 'manual_force_live' | 'preexpiry_selected' | 'cache_allowed';
};

export function shouldForcePreExpiryLiveRefresh(
  mode: PreExpiryBackfillMode,
  reason: RatePreExpiryRefreshReason,
): boolean {
  return mode === 'preexpiry_refresh' && reason !== 'fresh';
}

export function backfillUsesLiveRateBudget(input: {
  liveRecalculate: boolean;
  mode: PreExpiryBackfillMode;
}): boolean {
  return input.liveRecalculate || input.mode === 'preexpiry_refresh';
}

export function buildBackfillRateFetchDecision(input: {
  liveRecalculate: boolean;
  mode: PreExpiryBackfillMode;
  preExpiryRefreshReason: RatePreExpiryRefreshReason;
}): BackfillRateFetchDecision {
  if (input.liveRecalculate) {
    return { forceRefresh: true, priority: 'background', reason: 'manual_force_live' };
  }
  if (shouldForcePreExpiryLiveRefresh(input.mode, input.preExpiryRefreshReason)) {
    return { forceRefresh: true, priority: 'background', reason: 'preexpiry_selected' };
  }
  return { forceRefresh: false, priority: 'background', reason: 'cache_allowed' };
}

export function toGetRatesOptions(decision: BackfillRateFetchDecision): {
  forceRefresh?: true;
  priority: RateFetchPriority;
} {
  return decision.forceRefresh
    ? { forceRefresh: true, priority: decision.priority }
    : { priority: decision.priority };
}
