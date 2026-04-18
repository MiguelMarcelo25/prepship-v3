export class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly tokensPerMs: number
  ) {
    this.tokens = capacity;
  }

  async acquire(): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.max(1, Math.ceil((1 - this.tokens) / this.tokensPerMs));
      await new Promise((r) => setTimeout(r, waitMs));
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
