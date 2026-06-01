import { env } from '../env.js';
import { timedFetch } from '../http/timing.js';
import { CircuitBreaker } from './circuit-breaker.js';

const BASE_URL = 'https://api.shipstation.com';

const breaker = new CircuitBreaker(5, 30_000);
const inflight = new Map<string, Promise<unknown>>();

export const SHIPSTATION_RATE_LIMIT_PER_MINUTE = Math.max(
  1,
  Number.parseInt(process.env.SHIPSTATION_RATE_LIMIT_PER_MINUTE ?? '160', 10) || 160
);
export const SHIPSTATION_RATE_LIMIT_BURST = Math.max(
  1,
  Math.min(
    SHIPSTATION_RATE_LIMIT_PER_MINUTE,
    Number.parseInt(process.env.SHIPSTATION_RATE_LIMIT_BURST ?? '20', 10) || 20
  )
);
const SHIPSTATION_RATE_LIMIT_WINDOW_MS = 60_000;
const shipStationV2RateLimitTimestamps: number[] = [];

function trimShipStationV2RateLimitTimestamps(now = Date.now()) {
  while (
    shipStationV2RateLimitTimestamps.length > 0 &&
    now - shipStationV2RateLimitTimestamps[0]! >= SHIPSTATION_RATE_LIMIT_WINDOW_MS
  ) {
    shipStationV2RateLimitTimestamps.shift();
  }
}

function nextShipStationV2BudgetDelayMs(now = Date.now()) {
  trimShipStationV2RateLimitTimestamps(now);
  const burstWindowMs = Math.ceil(
    (SHIPSTATION_RATE_LIMIT_WINDOW_MS * SHIPSTATION_RATE_LIMIT_BURST) /
      SHIPSTATION_RATE_LIMIT_PER_MINUTE
  );
  const recentBurst = shipStationV2RateLimitTimestamps.filter((timestamp) => now - timestamp < burstWindowMs);
  const burstDelay =
    recentBurst.length >= SHIPSTATION_RATE_LIMIT_BURST
      ? Math.max(0, burstWindowMs - (now - recentBurst[0]!))
      : 0;
  const minuteDelay =
    shipStationV2RateLimitTimestamps.length >= SHIPSTATION_RATE_LIMIT_PER_MINUTE
      ? Math.max(0, SHIPSTATION_RATE_LIMIT_WINDOW_MS - (now - shipStationV2RateLimitTimestamps[0]!))
      : 0;
  return Math.max(burstDelay, minuteDelay);
}

async function acquireShipStationV2Budget(): Promise<void> {
  for (;;) {
    const delayMs = nextShipStationV2BudgetDelayMs();
    if (delayMs <= 0) {
      shipStationV2RateLimitTimestamps.push(Date.now());
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
}

export class ShipStationError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown
  ) {
    super(message);
    this.name = 'ShipStationError';
  }
}

type RequestOpts = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  apiKey?: string;
  dedupeKey?: string;
  maxRetries?: number;
  // v2-parity: caller can pass its own AbortSignal (e.g. request lifecycle
  // cancellation). We compose it with a 90s timeout signal so the fetch
  // never hangs indefinitely even when the caller didn't set one.
  signal?: AbortSignal;
  timeoutMs?: number;
};

// v2-parity: default request timeout matches apps/api/src/common/shipstation/client.ts:304-308.
const DEFAULT_TIMEOUT_MS = 90_000;

export async function ssRequest<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const key = opts.apiKey ?? env.SHIPSTATION_API_KEY_V2;
  if (!key) {
    throw new Error('SHIPSTATION_API_KEY_V2 is not configured');
  }

  const execute = () =>
    breaker.execute(async () => {
      const maxRetries = opts.maxRetries ?? 5;
      let attempt = 0;
      while (true) {
        attempt += 1;
        await acquireShipStationV2Budget();
        const timeoutSignal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        const signal = opts.signal
          ? AbortSignal.any([opts.signal, timeoutSignal])
          : timeoutSignal;
        const res = await timedFetch('shipstation.v2.request', `${BASE_URL}${path}`, {
          method: opts.method ?? 'GET',
          headers: {
            'API-Key': key,
            'Content-Type': 'application/json',
          },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal,
        }, { path, attempt });

        if (res.status === 429) {
          if (attempt >= maxRetries) {
            throw new ShipStationError(429, 'ShipStation rate-limited after retries');
          }
          const retryAfter = Number(res.headers.get('Retry-After') ?? 0);
          const backoffMs = retryAfter
            ? retryAfter * 1000
            : Math.min(10_000, 2 ** attempt * 250);
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }

        // v2-parity: retry 5xx with exponential backoff (1s, 2s, 4s) before
        // giving up. Matches apps/api/src/common/shipstation/client.ts:300-346.
        if (res.status >= 500 && res.status <= 599) {
          if (attempt >= maxRetries) {
            let body: unknown = null;
            try { body = await res.json(); } catch { body = await res.text(); }
            throw new ShipStationError(
              res.status,
              `ShipStation ${res.status} after ${attempt} retries`,
              body
            );
          }
          const backoffMs = Math.min(4_000, 2 ** attempt * 1000);
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }

        if (!res.ok) {
          let body: unknown = null;
          try {
            body = await res.json();
          } catch {
            body = await res.text();
          }
          const detail = extractShipStationMessage(body);
          throw new ShipStationError(
            res.status,
            `ShipStation ${res.status}: ${detail ?? res.statusText}`,
            body
          );
        }

        if (res.status === 204) return undefined as T;
        return (await res.json()) as T;
      }
    });

  if (!opts.dedupeKey) return execute();

  const existing = inflight.get(opts.dedupeKey);
  if (existing) return existing as Promise<T>;
  const p = execute().finally(() => inflight.delete(opts.dedupeKey!));
  inflight.set(opts.dedupeKey, p);
  return p;
}

function extractShipStationMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { errors?: Array<{ message?: string }>; message?: string };
  if (Array.isArray(b.errors) && b.errors.length) {
    return b.errors
      .map((e) => e?.message)
      .filter(Boolean)
      .join('; ');
  }
  if (typeof b.message === 'string') return b.message;
  return null;
}

export const shipstationStatus = () => ({
  circuit: breaker.status,
  inflight: inflight.size,
});
