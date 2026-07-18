import { setTimeout as sleep } from 'node:timers/promises';
import { env } from '../env.js';
import { timedFetch } from '../http/timing.js';
import { TokenBucket, type RateBucket } from './rate-limiter.js';
import { DurableTokenBucket } from './durable-rate-limiter.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { ShipStationError } from './client.js';
import {
  SHIPSTATION_RATE_LIMIT_WINDOW_MS,
  SHIPSTATION_V1_RATE_LIMIT_PER_MINUTE,
} from './rate-limit-config.js';

const V1_BASE = 'https://ssapi.shipstation.com';

// v1 limit is 40 req/min (much stricter than v2). Leave some headroom.
// PS-256 (Card 11): default = the fast per-process bucket. Set RATE_LIMITER_BACKEND=durable to
// share one DB-backed bucket across all instances (then the 38/min holds fleet-wide). Inert until flipped.
const bucket: RateBucket =
  process.env.RATE_LIMITER_BACKEND === 'durable'
    ? new DurableTokenBucket(
        'shipstation-v1',
        SHIPSTATION_V1_RATE_LIMIT_PER_MINUTE,
        SHIPSTATION_V1_RATE_LIMIT_PER_MINUTE / SHIPSTATION_RATE_LIMIT_WINDOW_MS,
      )
    : new TokenBucket(
        SHIPSTATION_V1_RATE_LIMIT_PER_MINUTE,
        SHIPSTATION_V1_RATE_LIMIT_PER_MINUTE / SHIPSTATION_RATE_LIMIT_WINDOW_MS,
      );
const breaker = new CircuitBreaker(5, 30_000);
const inflight = new Map<string, Promise<unknown>>();

type Opts = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  apiKey?: string;
  apiSecret?: string;
  dedupeKey?: string;
  maxRetries?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
};

// v2-parity: default request timeout (90s) matches the V2 client.
const DEFAULT_TIMEOUT_MS = 90_000;

function basicAuth(key: string, secret: string) {
  return 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64');
}

function throwIfRequestAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('ShipStation v1 request aborted');
}

async function readErrorBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function ssV1Request<T>(path: string, opts: Opts = {}): Promise<T> {
  const key = opts.apiKey ?? env.SHIPSTATION_API_KEY;
  const secret = opts.apiSecret ?? env.SHIPSTATION_API_SECRET;
  if (!key || !secret) {
    throw new Error(
      'ShipStation v1 credentials missing (SHIPSTATION_API_KEY + SHIPSTATION_API_SECRET)'
    );
  }

  const execute = () =>
    breaker.execute(async () => {
      const maxRetries = opts.maxRetries ?? 5;
      let attempt = 0;
      while (true) {
        // Per user override unlock shipped data on 2026-07-14: the shipment
        // worker's deadline owns retries and rate-limit waits at this boundary.
        throwIfRequestAborted(opts.signal);
        attempt += 1;
        // Per user override unlock shipped data on 2026-07-18: propagate the
        // worker signal through v1 admission so order-priority preemption can
        // release the shared lane even while the fleet token bucket is empty.
        await bucket.acquire({ signal: opts.signal });
        throwIfRequestAborted(opts.signal);
        const timeoutSignal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        const signal = opts.signal
          ? AbortSignal.any([opts.signal, timeoutSignal])
          : timeoutSignal;
        const res = await timedFetch('shipstation.v1.request', `${V1_BASE}${path}`, {
          method: opts.method ?? 'GET',
          headers: {
            Authorization: basicAuth(key, secret),
            'Content-Type': 'application/json',
          },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal,
        }, { path, attempt });

        if (res.status === 429) {
          if (attempt >= maxRetries) {
            throw new ShipStationError(429, 'ShipStation v1 rate-limited after retries');
          }
          const retryAfter = Number(res.headers.get('X-Rate-Limit-Reset') ?? 0);
          const backoffMs = retryAfter
            ? retryAfter * 1000
            : Math.min(30_000, 2 ** attempt * 1000);
          await sleep(backoffMs, undefined, { signal: opts.signal });
          continue;
        }

        // v2-parity: retry 5xx with exponential backoff before giving up.
        if (res.status >= 500 && res.status <= 599) {
          if (attempt >= maxRetries) {
            const body = await readErrorBody(res);
            throw new ShipStationError(
              res.status,
              `ShipStation v1 ${res.status} after ${attempt} retries`,
              body
            );
          }
          const backoffMs = Math.min(4_000, 2 ** attempt * 1000);
          await sleep(backoffMs, undefined, { signal: opts.signal });
          continue;
        }

        if (!res.ok) {
          const body = await readErrorBody(res);
          throw new ShipStationError(
            res.status,
            `ShipStation v1 ${res.status}: ${res.statusText}`,
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
