// PS-256 (Card 11): a DB-backed token bucket so the ShipStation rate limit holds across
// MULTIPLE processes (API + worker + extra instances). The in-memory TokenBucket is per-process,
// so N instances each get the full budget -> N x the carrier rate -> 429s. This shares one bucket
// row in Postgres and refills/decrements it ATOMICALLY, so the combined rate stays within budget
// and survives restarts.
//
// ENV-GATED: selected only when RATE_LIMITER_BACKEND=durable (see v1-client and client). Default stays the
// fast in-memory bucket, so merging this changes nothing until DJ flips it on + watches a canary.
//
// Additive-table 500-safe pattern (like ensureAddressClassificationsSchema): runtime CREATE TABLE
// IF NOT EXISTS, NOT in the drizzle schema index.
import { sql as pg } from '../../db/client.js';

let schemaEnsured: Promise<void> | null = null;

export async function ensureRateLimiterSchema(): Promise<void> {
  schemaEnsured ??= (async () => {
    await pg`
      CREATE TABLE IF NOT EXISTS rate_limiter_state (
        key text PRIMARY KEY,
        tokens double precision NOT NULL,
        capacity double precision NOT NULL,
        tokens_per_sec double precision NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    await pg`ALTER TABLE rate_limiter_state ENABLE ROW LEVEL SECURITY`;
  })().catch((err) => {
    schemaEnsured = null;
    throw err;
  });
  return schemaEnsured;
}

/** Same interface as the in-memory TokenBucket (acquire one token, waiting if necessary). */
export class DurableTokenBucket {
  private seeded: Promise<void> | null = null;
  private readonly tokensPerSec: number;

  constructor(
    private readonly key: string,
    private readonly capacity: number,
    tokensPerMs: number,
  ) {
    this.tokensPerSec = tokensPerMs * 1000;
  }

  private async seed(): Promise<void> {
    this.seeded ??= (async () => {
      await ensureRateLimiterSchema();
      // Seed the shared row once; never reset an existing row's live token balance, just keep
      // its capacity/rate current.
      await pg`
        INSERT INTO rate_limiter_state (key, tokens, capacity, tokens_per_sec, updated_at)
        VALUES (${this.key}, ${this.capacity}, ${this.capacity}, ${this.tokensPerSec}, now())
        ON CONFLICT (key) DO UPDATE SET capacity = ${this.capacity}, tokens_per_sec = ${this.tokensPerSec}
      `;
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
      // Atomic: time-refill the bucket and grant one token IFF the refilled balance is >= 1.
      // Concurrent acquirers across processes serialize on the row update, so the combined
      // grant rate can never exceed tokens_per_sec.
      const rows = await pg`
        UPDATE rate_limiter_state
        SET tokens = LEAST(capacity, tokens + EXTRACT(EPOCH FROM (now() - updated_at)) * tokens_per_sec) - 1,
            updated_at = now()
        WHERE key = ${this.key}
          AND tokens + EXTRACT(EPOCH FROM (now() - updated_at)) * tokens_per_sec >= 1
        RETURNING tokens
      `;
      if (rows.length > 0) return;
      // No token available yet — wait roughly the time to accrue one, then retry.
      const waitMs = Math.max(5, Math.ceil(1000 / this.tokensPerSec));
      await abortableDelay(waitMs, options.signal);
    }
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
