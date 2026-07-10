import { createHash } from 'node:crypto';
import type { Carrier, CarriersResponse } from '../lib/shipstation/types.js';

export const SHIPSTATION_CARRIER_ACCOUNT_CACHE_TTL_MS = 5 * 60 * 1000;

export type ShipStationCarrierAccountLoadResult = {
  carriers: Carrier[];
  error: string | null;
  status: number | null;
  cacheStatus: 'hit' | 'miss';
  cacheAgeMs: number | null;
  durationMs: number;
  providerDurationMs: number;
};

type LoaderDependencies = {
  load: (apiKeyV2: string, dedupeKey: string) => Promise<CarriersResponse>;
  now: () => number;
  ttlMs: number;
};

type CacheEntry = {
  cachedAt: number;
  carriers: Carrier[];
};

function credentialKey(apiKeyV2: string): string {
  return createHash('sha256').update(apiKeyV2).digest('hex');
}

function errorStatus(error: unknown): number | null {
  const status = Number((error as { status?: unknown } | null)?.status);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

export function createShipStationCarrierAccountLoader(
  overrides: Partial<LoaderDependencies> = {},
) {
  const load = overrides.load ?? (async (apiKeyV2: string, dedupeKey: string) => {
    const { listCarrierAccounts } = await import('./carrier-connector-orchestrator.js');
    return await listCarrierAccounts('shipstation', {
      apiKeyV2,
      dedupeKey,
    }) as CarriersResponse;
  });
  const now = overrides.now ?? Date.now;
  const ttlMs = overrides.ttlMs ?? SHIPSTATION_CARRIER_ACCOUNT_CACHE_TTL_MS;
  const cache = new Map<string, CacheEntry>();

  return async function loadShipStationCarrierAccounts(
    apiKeyV2: string,
  ): Promise<ShipStationCarrierAccountLoadResult> {
    const startedAt = now();
    if (!apiKeyV2) {
      return {
        carriers: [],
        error: 'no key configured',
        status: null,
        cacheStatus: 'miss',
        cacheAgeMs: null,
        durationMs: 0,
        providerDurationMs: 0,
      };
    }

    const key = credentialKey(apiKeyV2);
    const cached = cache.get(key);
    const cacheAgeMs = cached ? Math.max(0, startedAt - cached.cachedAt) : null;
    if (cached && cacheAgeMs != null && cacheAgeMs < ttlMs) {
      return {
        carriers: cached.carriers,
        error: null,
        status: 200,
        cacheStatus: 'hit',
        cacheAgeMs,
        durationMs: Math.max(0, now() - startedAt),
        providerDurationMs: 0,
      };
    }
    if (cached) cache.delete(key);

    const providerStartedAt = now();
    try {
      const data = await load(apiKeyV2, `rates-multi:carriers:${key.slice(0, 16)}`);
      const carriers = Array.isArray(data?.carriers) ? data.carriers : [];
      const cachedAt = now();
      cache.set(key, { cachedAt, carriers });
      return {
        carriers,
        error: null,
        status: 200,
        cacheStatus: 'miss',
        cacheAgeMs: null,
        durationMs: Math.max(0, cachedAt - startedAt),
        providerDurationMs: Math.max(0, cachedAt - providerStartedAt),
      };
    } catch (error) {
      const finishedAt = now();
      return {
        carriers: [],
        error: error instanceof Error ? error.message : String(error),
        status: errorStatus(error),
        cacheStatus: 'miss',
        cacheAgeMs: null,
        durationMs: Math.max(0, finishedAt - startedAt),
        providerDurationMs: Math.max(0, finishedAt - providerStartedAt),
      };
    }
  };
}

export const loadShipStationCarrierAccounts = createShipStationCarrierAccountLoader();
