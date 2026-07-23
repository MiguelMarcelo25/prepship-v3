// PS-256 (Card 11): the shared shape so callers can hold either the in-memory TokenBucket
// or the DB-backed DurableTokenBucket (selected by RATE_LIMITER_BACKEND) without changing.
export interface RateBucket {
  acquire(options?: { signal?: AbortSignal }): Promise<void>;
}

export class TokenBucket implements RateBucket {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly tokensPerMs: number
  ) {
    this.tokens = capacity;
  }

  async acquire(options: { signal?: AbortSignal } = {}): Promise<void> {
    while (true) {
      options.signal?.throwIfAborted();
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.max(1, Math.ceil((1 - this.tokens) / this.tokensPerMs));
      // Per user override unlock shipped data on 2026-07-18: order/shipment
      // worker cancellation must interrupt provider-admission waits so a
      // queued order refresh can reclaim the serialized ShipStation lane.
      await abortableDelay(waitMs, options.signal);
    }
  }

  private refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.tokensPerMs);
    this.lastRefill = now;
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
