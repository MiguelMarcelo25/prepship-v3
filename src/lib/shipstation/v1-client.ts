import { env } from '../env';
import { TokenBucket } from './rate-limiter';
import { CircuitBreaker } from './circuit-breaker';
import { ShipStationError } from './client';

const V1_BASE = 'https://ssapi.shipstation.com';

// v1 limit is 40 req/min (much stricter than v2). Leave some headroom.
const bucket = new TokenBucket(38, 38 / 60_000);
const breaker = new CircuitBreaker(5, 30_000);
const inflight = new Map<string, Promise<unknown>>();

type Opts = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  apiKey?: string;
  apiSecret?: string;
  dedupeKey?: string;
  maxRetries?: number;
};

function basicAuth(key: string, secret: string) {
  return 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64');
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
        attempt += 1;
        await bucket.acquire();
        const res = await fetch(`${V1_BASE}${path}`, {
          method: opts.method ?? 'GET',
          headers: {
            Authorization: basicAuth(key, secret),
            'Content-Type': 'application/json',
          },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        });

        if (res.status === 429) {
          if (attempt >= maxRetries) {
            throw new ShipStationError(429, 'ShipStation v1 rate-limited after retries');
          }
          const retryAfter = Number(res.headers.get('X-Rate-Limit-Reset') ?? 0);
          const backoffMs = retryAfter
            ? retryAfter * 1000
            : Math.min(30_000, 2 ** attempt * 1000);
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
