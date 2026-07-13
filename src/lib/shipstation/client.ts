import { createHash } from 'node:crypto';
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
// Audit R-3 (2026-07-13): ShipStation grants the per-minute budget PER API KEY,
// but this bucket was process-global across ALL keys (DR PREPPER, KFG, per-client)
// — one tenant's bulk rating starved another key's interactive quotes while the
// unused keys' capacity sat idle. Buckets are now keyed by a key fingerprint;
// the env budget applies per key, matching what ShipStation actually enforces.
// (Cross-PROCESS budget sharing — two workers, one key — remains the durable
// token-bucket follow-up; this bucket is deliberately conservative per process.)
const shipStationV2RateLimitTimestampsByKey = new Map<string, number[]>();

function shipStationV2RateLimitBucket(apiKey: string): number[] {
  const bucketId = createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
  let bucket = shipStationV2RateLimitTimestampsByKey.get(bucketId);
  if (!bucket) {
    bucket = [];
    shipStationV2RateLimitTimestampsByKey.set(bucketId, bucket);
  }
  return bucket;
}

function trimShipStationV2RateLimitTimestamps(bucket: number[], now = Date.now()) {
  while (
    bucket.length > 0 &&
    now - bucket[0]! >= SHIPSTATION_RATE_LIMIT_WINDOW_MS
  ) {
    bucket.shift();
  }
}

function nextShipStationV2BudgetDelayMs(bucket: number[], now = Date.now()) {
  trimShipStationV2RateLimitTimestamps(bucket, now);
  const burstWindowMs = Math.ceil(
    (SHIPSTATION_RATE_LIMIT_WINDOW_MS * SHIPSTATION_RATE_LIMIT_BURST) /
      SHIPSTATION_RATE_LIMIT_PER_MINUTE
  );
  const recentBurst = bucket.filter((timestamp) => now - timestamp < burstWindowMs);
  const burstDelay =
    recentBurst.length >= SHIPSTATION_RATE_LIMIT_BURST
      ? Math.max(0, burstWindowMs - (now - recentBurst[0]!))
      : 0;
  const minuteDelay =
    bucket.length >= SHIPSTATION_RATE_LIMIT_PER_MINUTE
      ? Math.max(0, SHIPSTATION_RATE_LIMIT_WINDOW_MS - (now - bucket[0]!))
      : 0;
  return Math.max(burstDelay, minuteDelay);
}

async function acquireShipStationV2Budget(apiKey: string): Promise<void> {
  const bucket = shipStationV2RateLimitBucket(apiKey);
  for (;;) {
    const delayMs = nextShipStationV2BudgetDelayMs(bucket);
    if (delayMs <= 0) {
      bucket.push(Date.now());
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
  // Per user override unlock shipped data on 2026-07-13 (audit C1): non-idempotent
  // money-path POSTs (label purchases) must NOT be re-sent on 5xx — ShipStation may
  // have created the label even though the gateway returned 502/504, so a blind
  // re-send buys postage again. Purchase callers set retryOn5xx: false; a 5xx then
  // throws immediately as an UNKNOWN outcome for the caller to reconcile against
  // /v2/labels. 429 retries stay enabled (rate-limited requests are never processed,
  // so retrying them cannot double-purchase).
  retryOn5xx?: boolean;
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
        await acquireShipStationV2Budget(key);
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
        // Exception (audit C1): retryOn5xx=false callers (label purchases) get
        // exactly one attempt — the provider may have processed the request.
        if (res.status >= 500 && res.status <= 599) {
          if ((opts.retryOn5xx ?? true) === false || attempt >= maxRetries) {
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
