export type DirectCarrierCacheDecision = 'cache_hit' | 'provider_fetch' | 'uncached';

export function decideDirectCarrierCacheUse(input: {
  cachedOnly: boolean;
  cacheFirst: boolean;
  cachedRateCount: number;
}): DirectCarrierCacheDecision {
  if ((input.cachedOnly || input.cacheFirst) && input.cachedRateCount > 0) return 'cache_hit';
  if (input.cachedOnly) return 'uncached';
  return 'provider_fetch';
}

export function rateSourcesArePurchaseProofEligible(input: {
  shipStationCached: boolean;
  directCarrierCacheUsed: boolean;
}): boolean {
  return !input.shipStationCached && !input.directCarrierCacheUsed;
}

export type RateSignatureCacheMetrics = {
  lookups: number;
  fullHits: number;
  partialHits: number;
  misses: number;
  providerFetches: number;
  hitRatePct: number;
};

export function createRateSignatureCacheMetrics(): RateSignatureCacheMetrics {
  return {
    lookups: 0,
    fullHits: 0,
    partialHits: 0,
    misses: 0,
    providerFetches: 0,
    hitRatePct: 0,
  };
}

/**
 * PS-459 cache telemetry is recorded by the background rate owner, not inferred by the UI.
 * A full hit means no provider fetch was initiated for the exact request signature.
 */
export function recordRateSignatureCacheLookup(
  current: RateSignatureCacheMetrics,
  input: {
    shipStationCached: boolean;
    directCarrierCacheUsed: boolean;
    providerFetches: number;
  },
): RateSignatureCacheMetrics {
  const lookups = current.lookups + 1;
  const providerFetches = current.providerFetches + Math.max(0, Math.trunc(input.providerFetches));
  const usedAnyCache = input.shipStationCached || input.directCarrierCacheUsed;
  const fullHit = input.providerFetches === 0;
  const fullHits = current.fullHits + (fullHit ? 1 : 0);
  const partialHits = current.partialHits + (!fullHit && usedAnyCache ? 1 : 0);
  const misses = current.misses + (!fullHit && !usedAnyCache ? 1 : 0);
  return {
    lookups,
    fullHits,
    partialHits,
    misses,
    providerFetches,
    hitRatePct: Number(((fullHits / lookups) * 100).toFixed(2)),
  };
}
