import { createHash } from 'node:crypto';

type InFlightEntry<T> = {
  promise: Promise<T>;
};

const inFlightBrowseRequests = new Map<string, InFlightEntry<unknown>>();

function stableValue(value: unknown): unknown {
  if (value == null) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      const child = input[key];
      if (child !== undefined) output[key] = stableValue(child);
    }
    return output;
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

export type RateBrowseSingleFlightKeyInput = {
  rateCacheKey: string;
  forceLive?: boolean | null;
  forceRefresh?: boolean | null;
  cachedOnly?: boolean | null;
  requestedCarrierIds?: readonly string[] | null;
  directContext?: unknown;
};

export function buildRateBrowseSingleFlightKey(input: RateBrowseSingleFlightKeyInput): string {
  const requestedCarrierIds = [
    ...new Set((input.requestedCarrierIds ?? []).map((id) => String(id).trim()).filter(Boolean)),
  ].sort();
  const payload = stableValue({
    rateCacheKey: input.rateCacheKey,
    forceLive: input.forceLive === true,
    forceRefresh: input.forceRefresh === true,
    cachedOnly: input.cachedOnly === true,
    requestedCarrierIds,
    directContext: input.directContext ?? null,
  });
  return `rate-browse:${createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32)}`;
}

export async function runRateBrowseSingleFlight<T>(
  key: string,
  producer: () => Promise<T>,
): Promise<T> {
  const normalizedKey = String(key ?? '').trim();
  if (!normalizedKey) return producer();

  const existing = inFlightBrowseRequests.get(normalizedKey) as InFlightEntry<T> | undefined;
  if (existing) return existing.promise;

  let promise!: Promise<T>;
  promise = Promise.resolve()
    .then(producer)
    .finally(() => {
      const current = inFlightBrowseRequests.get(normalizedKey);
      if (current?.promise === promise) inFlightBrowseRequests.delete(normalizedKey);
    });
  inFlightBrowseRequests.set(normalizedKey, { promise });
  return promise;
}
