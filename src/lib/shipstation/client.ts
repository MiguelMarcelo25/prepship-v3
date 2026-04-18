import { env } from '../env';
import { TokenBucket } from './rate-limiter';
import { CircuitBreaker } from './circuit-breaker';

const BASE_URL = 'https://api.shipstation.com';

const bucket = new TokenBucket(40, 40 / 1500);
const breaker = new CircuitBreaker(5, 30_000);
const inflight = new Map<string, Promise<unknown>>();

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
};

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
        await bucket.acquire();
        const res = await fetch(`${BASE_URL}${path}`, {
          method: opts.method ?? 'GET',
          headers: {
            'API-Key': key,
            'Content-Type': 'application/json',
          },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        });

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
