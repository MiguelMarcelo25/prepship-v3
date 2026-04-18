type State = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private state: State = 'closed';
  private failures = 0;
  private openedAt = 0;

  constructor(
    private readonly failureThreshold = 5,
    private readonly recoveryMs = 30_000
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.openedAt < this.recoveryMs) {
        throw new Error('ShipStation circuit breaker open');
      }
      this.state = 'half-open';
    }
    try {
      const result = await fn();
      this.failures = 0;
      this.state = 'closed';
      return result;
    } catch (err) {
      this.failures += 1;
      if (this.failures >= this.failureThreshold || this.state === 'half-open') {
        this.state = 'open';
        this.openedAt = Date.now();
      }
      throw err;
    }
  }

  get status() {
    return {
      state: this.state,
      failures: this.failures,
      openedAt: this.openedAt ? new Date(this.openedAt) : null,
    };
  }
}
