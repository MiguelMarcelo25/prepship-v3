import { createHash } from 'node:crypto';
import { env } from '../env.js';
import { timedFetch } from '../http/timing.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { DurableTokenBucket } from './durable-rate-limiter.js';
import {
  SHIPSTATION_RATE_LIMIT_BURST,
  SHIPSTATION_RATE_LIMIT_BATCH_BURST_RESERVE,
  SHIPSTATION_RATE_LIMIT_BATCH_PER_MINUTE_RESERVE,
  SHIPSTATION_RATE_LIMIT_INTERACTIVE_BURST_RESERVE,
  SHIPSTATION_RATE_LIMIT_INTERACTIVE_PER_MINUTE_RESERVE,
  SHIPSTATION_RATE_LIMIT_PER_MINUTE,
  SHIPSTATION_RATE_LIMIT_WINDOW_MS,
} from './rate-limit-config.js';

export {
  SHIPSTATION_RATE_LIMIT_BURST,
  SHIPSTATION_RATE_LIMIT_PER_MINUTE,
} from './rate-limit-config.js';

const BASE_URL = 'https://api.shipstation.com';

const breaker = new CircuitBreaker(5, 30_000);
const inflight = new Map<string, Promise<unknown>>();

export type ShipStationRequestPriority = 'interactive' | 'batch' | 'background';
// Audit R-3 (2026-07-13): ShipStation grants the per-minute budget PER API KEY,
// but this bucket was process-global across ALL keys (DR PREPPER, KFG, per-client)
// — one tenant's bulk rating starved another key's interactive quotes while the
// unused keys' capacity sat idle. Buckets are now keyed by a key fingerprint;
// the env budget applies per key, matching what ShipStation actually enforces.
// The in-memory backend remains conservative per process; RATE_LIMITER_BACKEND=durable
// routes the same fingerprints through shared Postgres token buckets across workers.
const shipStationV2RateLimitTimestampsByKey = new Map<string, number[]>();
const shipStationV2ObservedAdmissionTimestampsByKey = new Map<string, number[]>();
const shipStationV2DurableBucketsByKey = new Map<string, DurableTokenBucket>();
const shipStationV2DurableBatchBucketsByKey = new Map<string, DurableTokenBucket>();
const shipStationV2DurableBackgroundBucketsByKey = new Map<string, DurableTokenBucket>();
const shipStationV2PauseUntilByKey = new Map<string, number>();

function shipStationV2BucketId(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

function shipStationV2RateLimitBucket(apiKey: string): number[] {
  const bucketId = shipStationV2BucketId(apiKey);
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

function nextShipStationV2BudgetDelayMs(
  bucket: number[],
  priority: ShipStationRequestPriority,
  now = Date.now(),
) {
  trimShipStationV2RateLimitTimestamps(bucket, now);
  const burstLimit = priority === 'interactive'
    ? SHIPSTATION_RATE_LIMIT_BURST
    : priority === 'batch'
      ? Math.max(1, SHIPSTATION_RATE_LIMIT_BURST - SHIPSTATION_RATE_LIMIT_INTERACTIVE_BURST_RESERVE)
      : Math.max(
          1,
          SHIPSTATION_RATE_LIMIT_BURST
            - SHIPSTATION_RATE_LIMIT_INTERACTIVE_BURST_RESERVE
            - SHIPSTATION_RATE_LIMIT_BATCH_BURST_RESERVE,
        );
  const perMinuteLimit = priority === 'interactive'
    ? SHIPSTATION_RATE_LIMIT_PER_MINUTE
    : priority === 'batch'
      ? Math.max(1, SHIPSTATION_RATE_LIMIT_PER_MINUTE - SHIPSTATION_RATE_LIMIT_INTERACTIVE_PER_MINUTE_RESERVE)
      : Math.max(
          1,
          SHIPSTATION_RATE_LIMIT_PER_MINUTE
            - SHIPSTATION_RATE_LIMIT_INTERACTIVE_PER_MINUTE_RESERVE
            - SHIPSTATION_RATE_LIMIT_BATCH_PER_MINUTE_RESERVE,
        );
  const burstWindowMs = Math.ceil(
    (SHIPSTATION_RATE_LIMIT_WINDOW_MS * SHIPSTATION_RATE_LIMIT_BURST) /
      SHIPSTATION_RATE_LIMIT_PER_MINUTE
  );
  const recentBurst = bucket.filter((timestamp) => now - timestamp < burstWindowMs);
  const burstDelay =
    recentBurst.length >= burstLimit
      ? Math.max(0, burstWindowMs - (now - recentBurst[0]!))
      : 0;
  const minuteDelay =
    bucket.length >= perMinuteLimit
      ? Math.max(0, SHIPSTATION_RATE_LIMIT_WINDOW_MS - (now - bucket[0]!))
      : 0;
  return Math.max(burstDelay, minuteDelay);
}

function shipStationV2DurableBatchBucket(apiKey: string): DurableTokenBucket {
  const bucketId = shipStationV2BucketId(apiKey);
  let bucket = shipStationV2DurableBatchBucketsByKey.get(bucketId);
  if (!bucket) {
    bucket = new DurableTokenBucket(
      `shipstation-v2:${bucketId}:batch`,
      Math.max(1, SHIPSTATION_RATE_LIMIT_BURST - SHIPSTATION_RATE_LIMIT_INTERACTIVE_BURST_RESERVE),
      Math.max(1, SHIPSTATION_RATE_LIMIT_PER_MINUTE - SHIPSTATION_RATE_LIMIT_INTERACTIVE_PER_MINUTE_RESERVE)
        / SHIPSTATION_RATE_LIMIT_WINDOW_MS,
    );
    shipStationV2DurableBatchBucketsByKey.set(bucketId, bucket);
  }
  return bucket;
}

function shipStationV2DurableBucket(apiKey: string): DurableTokenBucket {
  const bucketId = shipStationV2BucketId(apiKey);
  let bucket = shipStationV2DurableBucketsByKey.get(bucketId);
  if (!bucket) {
    bucket = new DurableTokenBucket(
      `shipstation-v2:${bucketId}`,
      SHIPSTATION_RATE_LIMIT_BURST,
      SHIPSTATION_RATE_LIMIT_PER_MINUTE / SHIPSTATION_RATE_LIMIT_WINDOW_MS,
    );
    shipStationV2DurableBucketsByKey.set(bucketId, bucket);
  }
  return bucket;
}

function shipStationV2DurableBackgroundBucket(apiKey: string): DurableTokenBucket {
  const bucketId = shipStationV2BucketId(apiKey);
  let bucket = shipStationV2DurableBackgroundBucketsByKey.get(bucketId);
  if (!bucket) {
    bucket = new DurableTokenBucket(
      `shipstation-v2:${bucketId}:background`,
      Math.max(
        1,
        SHIPSTATION_RATE_LIMIT_BURST
          - SHIPSTATION_RATE_LIMIT_INTERACTIVE_BURST_RESERVE
          - SHIPSTATION_RATE_LIMIT_BATCH_BURST_RESERVE,
      ),
      Math.max(
        1,
        SHIPSTATION_RATE_LIMIT_PER_MINUTE
          - SHIPSTATION_RATE_LIMIT_INTERACTIVE_PER_MINUTE_RESERVE
          - SHIPSTATION_RATE_LIMIT_BATCH_PER_MINUTE_RESERVE,
      )
        / SHIPSTATION_RATE_LIMIT_WINDOW_MS,
    );
    shipStationV2DurableBackgroundBucketsByKey.set(bucketId, bucket);
  }
  return bucket;
}

function recordShipStationV2Admission(apiKey: string): void {
  const bucketId = shipStationV2BucketId(apiKey);
  let bucket = shipStationV2ObservedAdmissionTimestampsByKey.get(bucketId);
  if (!bucket) {
    bucket = [];
    shipStationV2ObservedAdmissionTimestampsByKey.set(bucketId, bucket);
  }
  trimShipStationV2RateLimitTimestamps(bucket);
  bucket.push(Date.now());
}

async function acquireShipStationV2Budget(
  apiKey: string,
  priority: ShipStationRequestPriority,
  signal?: AbortSignal,
): Promise<void> {
  if (process.env.RATE_LIMITER_BACKEND === 'durable') {
    // The lower-throughput background bucket preserves fleet-wide burst and
    // per-minute headroom. Every call also consumes the shared per-key total
    // bucket, so labels, sync, discovery, and rates meet at this one gate.
    if (priority === 'background') {
      await shipStationV2DurableBackgroundBucket(apiKey).acquire({ signal });
    }
    if (priority !== 'interactive') {
      await shipStationV2DurableBatchBucket(apiKey).acquire({ signal });
    }
    await shipStationV2DurableBucket(apiKey).acquire({ signal });
    recordShipStationV2Admission(apiKey);
    return;
  }
  const bucket = shipStationV2RateLimitBucket(apiKey);
  const bucketId = shipStationV2BucketId(apiKey);
  for (;;) {
    signal?.throwIfAborted();
    const pauseDelayMs = Math.max(0, (shipStationV2PauseUntilByKey.get(bucketId) ?? 0) - Date.now());
    const delayMs = Math.max(pauseDelayMs, nextShipStationV2BudgetDelayMs(bucket, priority));
    if (delayMs <= 0) {
      bucket.push(Date.now());
      return;
    }
    await abortableDelay(delayMs, signal);
  }
}

async function deferShipStationV2Budget(apiKey: string, delayMs: number): Promise<void> {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  if (process.env.RATE_LIMITER_BACKEND === 'durable') {
    await shipStationV2DurableBucket(apiKey).deferFor(delayMs);
    return;
  }
  const bucketId = shipStationV2BucketId(apiKey);
  shipStationV2PauseUntilByKey.set(
    bucketId,
    Math.max(shipStationV2PauseUntilByKey.get(bucketId) ?? 0, Date.now() + delayMs),
  );
}

function retryAfterDelayMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : null;
}

export class ShipStationError extends Error {
  code?: string;
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown
  ) {
    super(message);
    this.name = 'ShipStationError';
  }
}

function shipStationError(status: number, message: string, body?: unknown): ShipStationError {
  const error = new ShipStationError(status, message, body);
  const detail = extractShipStationMessage(body) ?? '';
  if (/insufficient[^.]{0,40}balance|balance[^.]{0,40}insufficient/i.test(detail)) {
    error.code = 'SHIPSTATION_INSUFFICIENT_BALANCE';
  }
  return error;
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
  priority?: ShipStationRequestPriority;
};

// v2-parity: default request timeout matches apps/api/src/common/shipstation/client.ts:304-308.
const DEFAULT_TIMEOUT_MS = 90_000;

export async function ssRequest<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const key = opts.apiKey ?? env.SHIPSTATION_API_KEY_V2;
  if (!key) {
    throw new Error('SHIPSTATION_API_KEY_V2 is not configured');
  }

  // PS-447: one deadline governs admission, fetch, Retry-After, and retry backoff.
  // A cancelled browser/job request therefore cannot keep consuming permits as a zombie.
  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const requestSignal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal;

  const execute = () =>
    breaker.execute(async () => {
      const maxRetries = opts.maxRetries ?? 5;
      let attempt = 0;
      while (true) {
        requestSignal.throwIfAborted();
        attempt += 1;
        await acquireShipStationV2Budget(key, opts.priority ?? 'interactive', requestSignal);
        const res = await timedFetch('shipstation.v2.request', `${BASE_URL}${path}`, {
          method: opts.method ?? 'GET',
          headers: {
            'API-Key': key,
            'Content-Type': 'application/json',
          },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: requestSignal,
        }, { path, attempt });

        if (res.status === 429) {
          if (attempt >= maxRetries) {
            throw new ShipStationError(429, 'ShipStation rate-limited after retries');
          }
          const backoffMs = retryAfterDelayMs(res.headers.get('Retry-After'))
            ?? Math.min(10_000, 2 ** attempt * 250);
          await deferShipStationV2Budget(key, backoffMs);
          await abortableDelay(backoffMs, requestSignal);
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
          await abortableDelay(backoffMs, requestSignal);
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
          throw shipStationError(
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

export function getShipStationV2LimiterSnapshot(): {
  backend: 'memory' | 'durable';
  windowMs: number;
  budgetUsed: number;
  burstLimit: number;
  perMinuteLimit: number;
} {
  const buckets = process.env.RATE_LIMITER_BACKEND === 'durable'
    ? shipStationV2ObservedAdmissionTimestampsByKey
    : shipStationV2RateLimitTimestampsByKey;
  let budgetUsed = 0;
  for (const bucket of buckets.values()) {
    trimShipStationV2RateLimitTimestamps(bucket);
    budgetUsed += bucket.length;
  }
  return {
    backend: process.env.RATE_LIMITER_BACKEND === 'durable' ? 'durable' : 'memory',
    windowMs: SHIPSTATION_RATE_LIMIT_WINDOW_MS,
    budgetUsed,
    burstLimit: SHIPSTATION_RATE_LIMIT_BURST,
    perMinuteLimit: SHIPSTATION_RATE_LIMIT_PER_MINUTE,
  };
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
