// PS-256 (Card 11): a DB-backed token bucket so the ShipStation rate limit holds across
// MULTIPLE processes (API + worker + extra instances). The in-memory TokenBucket is per-process,
// so N instances each get the full budget -> N x the carrier rate -> 429s. This shares one bucket
// row in Postgres and refills/decrements it ATOMICALLY, so the combined rate stays within budget
// and survives restarts.
//
// ENV-GATED: selected only when RATE_LIMITER_BACKEND=durable (see v1-client and client). Default stays the
// fast in-memory bucket, so merging this changes nothing until DJ flips it on + watches a canary.
//
// Migration 0062 owns the additive table; boot verifies it before work starts.
import { sql as pg } from '../../db/client.js';
import { assertRuntimeSchemaReady } from '../../services/runtime-schema-readiness.js';

export async function ensureRateLimiterSchema(): Promise<void> {
  await assertRuntimeSchemaReady();
}

export type DurableTokenBucketStore = {
  seed(input: { key: string; capacity: number; tokensPerSec: number }): Promise<void>;
  tryAcquire(input: { key: string }): Promise<boolean>;
  deferUntil(input: { key: string; delayMs: number }): Promise<void>;
};

const postgresDurableTokenBucketStore: DurableTokenBucketStore = {
  async seed({ key, capacity, tokensPerSec }) {
    await ensureRateLimiterSchema();
    await pg`
      INSERT INTO rate_limiter_state (key, tokens, capacity, tokens_per_sec, updated_at)
      VALUES (${key}, ${capacity}, ${capacity}, ${tokensPerSec}, now())
      ON CONFLICT (key) DO UPDATE SET capacity = ${capacity}, tokens_per_sec = ${tokensPerSec}
    `;
  },
  async tryAcquire({ key }) {
    // Atomic: time-refill the bucket and grant one token IFF the refilled balance is >= 1.
    // Concurrent acquirers across processes serialize on the row update, so the combined
    // grant rate can never exceed tokens_per_sec.
    const rows = await pg`
      UPDATE rate_limiter_state
      SET tokens = LEAST(capacity, tokens + EXTRACT(EPOCH FROM (now() - updated_at)) * tokens_per_sec) - 1,
          updated_at = now()
      WHERE key = ${key}
        AND tokens + EXTRACT(EPOCH FROM (now() - updated_at)) * tokens_per_sec >= 1
      RETURNING tokens
    `;
    return rows.length > 0;
  },
  async deferUntil({ key, delayMs }) {
    // PS-447: encode provider Retry-After in the shared row. A future updated_at
    // keeps every API/worker instance from refilling this key until the pause ends.
    await pg`
      UPDATE rate_limiter_state
      SET tokens = 0,
          updated_at = GREATEST(updated_at, now() + (${delayMs} * interval '1 millisecond'))
      WHERE key = ${key}
    `;
  },
};

/** Same interface as the in-memory TokenBucket (acquire one token, waiting if necessary). */
export class DurableTokenBucket {
  private seeded: Promise<void> | null = null;
  private readonly tokensPerSec: number;

  constructor(
    private readonly key: string,
    private readonly capacity: number,
    tokensPerMs: number,
    private readonly store: DurableTokenBucketStore = postgresDurableTokenBucketStore,
  ) {
    this.tokensPerSec = tokensPerMs * 1000;
  }

  private async seed(): Promise<void> {
    this.seeded ??= (async () => {
      // Seed the shared row once; never reset an existing row's live token balance, just keep
      // its capacity/rate current.
      await this.store.seed({
        key: this.key,
        capacity: this.capacity,
        tokensPerSec: this.tokensPerSec,
      });
    })().catch((err) => {
      this.seeded = null;
      throw err;
    });
    return this.seeded;
  }

  async acquire(options: { signal?: AbortSignal } = {}): Promise<void> {
    await this.seed();
    while (true) {
      options.signal?.throwIfAborted();
      if (await this.store.tryAcquire({ key: this.key })) return;
      // No token available yet — wait roughly the time to accrue one, then retry.
      const waitMs = Math.max(5, Math.ceil(1000 / this.tokensPerSec));
      await abortableDelay(waitMs, options.signal);
    }
  }

  async deferFor(delayMs: number): Promise<void> {
    if (!Number.isFinite(delayMs) || delayMs <= 0) return;
    await this.seed();
    await this.store.deferUntil({ key: this.key, delayMs: Math.ceil(delayMs) });
  }
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
