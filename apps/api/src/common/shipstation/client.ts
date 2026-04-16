/**
 * ShipStationClient — Shared HTTP client for all ShipStation API calls
 *
 * Features:
 * - Centralized rate limiting: token bucket that respects X-Rate-Limit-Reset
 * - Circuit breaker: opens on repeated failures, half-opens to probe recovery
 * - Concurrency guard: prevents duplicate simultaneous requests to same endpoint
 * - V1 (Basic Auth) + V2 (API-Key header) support
 * - All raw fetch() calls for ShipStation should go through this client
 */

// ─── Rate Limiter ─────────────────────────────────────────────────────────────

interface RateLimiterState {
  tokens: number;
  lastRefill: number;
  resetAt: number | null; // epoch ms when SS says we can retry
}

class RateLimiter {
  private readonly maxTokens: number;
  private readonly refillRateMs: number; // ms between token refills
  private state: RateLimiterState;

  constructor(maxTokens = 40, refillRateMs = 1500) {
    this.maxTokens = maxTokens;
    this.refillRateMs = refillRateMs;
    this.state = { tokens: maxTokens, lastRefill: Date.now(), resetAt: null };
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.state.lastRefill;
    const newTokens = Math.floor(elapsed / this.refillRateMs);
    if (newTokens > 0) {
      this.state.tokens = Math.min(this.maxTokens, this.state.tokens + newTokens);
      this.state.lastRefill = now;
    }
  }

  /** Called when we get a 429. Mark the reset time from SS header. */
  markRateLimited(resetSeconds: number): void {
    this.state.tokens = 0;
    this.state.resetAt = Date.now() + resetSeconds * 1000;
  }

  /** Wait until a token is available, then consume one. */
  async acquire(): Promise<void> {
    const maxWaitMs = 60_000;
    const start = Date.now();

    while (true) {
      if (Date.now() - start > maxWaitMs) {
        throw new Error("ShipStation rate limiter: max wait exceeded");
      }

      // If SS told us to wait, honor that first
      if (this.state.resetAt && Date.now() < this.state.resetAt) {
        const waitMs = this.state.resetAt - Date.now() + 100;
        await sleep(Math.min(waitMs, 5_000));
        continue;
      }

      this.refill();

      if (this.state.tokens > 0) {
        this.state.tokens--;
        this.state.resetAt = null;
        return;
      }

      await sleep(this.refillRateMs);
    }
  }
}

// ─── Circuit Breaker ──────────────────────────────────────────────────────────

type CircuitState = "closed" | "open" | "half-open";

class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private lastFailure = 0;
  private readonly failureThreshold: number;
  private readonly recoveryMs: number;

  constructor(failureThreshold = 5, recoveryMs = 30_000) {
    this.failureThreshold = failureThreshold;
    this.recoveryMs = recoveryMs;
  }

  get isOpen(): boolean {
    if (this.state === "open") {
      // Auto-transition to half-open after recovery window
      if (Date.now() - this.lastFailure > this.recoveryMs) {
        this.state = "half-open";
        return false;
      }
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.state = "closed";
  }

  recordFailure(): void {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.failureThreshold) {
      this.state = "open";
    }
  }

  getState(): CircuitState {
    // Trigger lazy transition check
    void this.isOpen;
    return this.state;
  }
}

// ─── In-flight deduplication ─────────────────────────────────────────────────

class InFlightTracker {
  private readonly inFlight = new Map<string, Promise<any>>();

  /** If an identical request is already in-flight, return the same promise. */
  track<T>(key: string, factory: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;

    const promise = factory().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  size(): number {
    return this.inFlight.size;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function basicAuthHeader(apiKey: string, apiSecret: string): string {
  return "Basic " + Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");
}

// ─── Credentials ─────────────────────────────────────────────────────────────

export interface V1Credentials {
  apiKey: string;
  apiSecret: string;
}

export interface V2Credentials {
  apiKeyV2: string;
}

export type ShipStationCredentials = V1Credentials | V2Credentials | (V1Credentials & V2Credentials);

function isV1(creds: ShipStationCredentials): creds is V1Credentials {
  return "apiKey" in creds && "apiSecret" in creds;
}

function isV2(creds: ShipStationCredentials): creds is V2Credentials {
  return "apiKeyV2" in creds;
}

// ─── Client ───────────────────────────────────────────────────────────────────

export interface ShipStationRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /** If true, deduplicate identical concurrent GET requests */
  deduplicate?: boolean;
  timeoutMs?: number;
}

export interface ShipStationClientOptions {
  rateLimiter?: RateLimiter;
  circuitBreaker?: CircuitBreaker;
  /** Max retries on 429 (default: 3) */
  maxRetries?: number;
}

export class ShipStationClient {
  private readonly rateLimiter: RateLimiter;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly inFlight: InFlightTracker;
  private readonly maxRetries: number;

  readonly baseV1 = "https://ssapi.shipstation.com";
  readonly baseV2 = "https://api.shipstation.com/v2";

  constructor(options: ShipStationClientOptions = {}) {
    this.rateLimiter = options.rateLimiter ?? new RateLimiter();
    this.circuitBreaker = options.circuitBreaker ?? new CircuitBreaker();
    this.inFlight = new InFlightTracker();
    this.maxRetries = options.maxRetries ?? 3;
  }

  /** Make a V1 (Basic Auth) request. */
  async v1<T>(
    credentials: V1Credentials,
    path: string,
    options: ShipStationRequestOptions = {},
  ): Promise<T> {
    const url = `${this.baseV1}${path}`;
    const headers: Record<string, string> = {
      Authorization: basicAuthHeader(credentials.apiKey, credentials.apiSecret),
    };
    if (options.method && options.method !== "GET" && options.body) {
      headers["Content-Type"] = "application/json";
    }
    return this._request<T>(url, headers, options);
  }

  /** Make a V2 (API-Key) request. */
  async v2<T>(
    credentials: V2Credentials,
    path: string,
    options: ShipStationRequestOptions = {},
  ): Promise<T> {
    const url = `${this.baseV2}${path}`;
    const headers: Record<string, string> = {
      "API-Key": credentials.apiKeyV2,
    };
    if (options.method && options.method !== "GET" && options.body) {
      headers["Content-Type"] = "application/json";
    }
    return this._request<T>(url, headers, options);
  }

  /** Fetch all pages from a V1 paginated endpoint. */
  async v1Pages<T>(
    credentials: V1Credentials,
    path: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<T[]> {
    const results: T[] = [];
    let page = 1;
    let pages = 1;

    do {
      const qs = new URLSearchParams({ ...params, pageSize: "500", page: String(page) });
      const fullPath = `${path}?${qs}`;

      const data = await this.v1<Record<string, unknown>>(credentials, fullPath, { signal });

      // SS wraps results in a key matching the endpoint segment (orders, shipments)
      const baseKey = path.split("/")[1]?.split("?")[0] ?? "";
      const items = (data[baseKey] ?? data[Object.keys(data).find(k => Array.isArray(data[k])) ?? ""] ?? []) as T[];
      results.push(...items);
      pages = (data.pages as number) ?? 1;
      page++;

      if (page <= pages) await sleep(500);
    } while (page <= pages);

    return results;
  }

  getCircuitState(): CircuitState {
    return this.circuitBreaker.getState();
  }

  getInFlightCount(): number {
    return this.inFlight.size();
  }

  private async _request<T>(
    url: string,
    headers: Record<string, string>,
    options: ShipStationRequestOptions,
  ): Promise<T> {
    // Circuit breaker check
    if (this.circuitBreaker.isOpen) {
      throw new Error(`ShipStation circuit breaker open — too many recent failures`);
    }

    const method = options.method ?? "GET";
    const deduplicateKey = method === "GET" && options.deduplicate !== false
      ? `${method}:${url}`
      : null;

    const doFetch = async (): Promise<T> => {
      let lastError: Error | null = null;

      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        // Acquire rate-limiter token before each attempt
        await this.rateLimiter.acquire();

        const timeoutMs = options.timeoutMs ?? 90_000;
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const signal = options.signal
          ? AbortSignal.any([options.signal, timeoutSignal])
          : timeoutSignal;

        let response: Response;
        try {
          response = await fetch(url, {
            method,
            headers,
            body: options.body ? JSON.stringify(options.body) : undefined,
            signal,
          });
        } catch (err) {
          this.circuitBreaker.recordFailure();
          throw err;
        }

        if (response.status === 429) {
          const resetSeconds = Number(response.headers.get("X-Rate-Limit-Reset") ?? "10");
          console.warn(`[ShipStationClient] Rate limited (429), resetIn=${resetSeconds}s, attempt=${attempt + 1}/${this.maxRetries + 1}`);
          this.rateLimiter.markRateLimited(resetSeconds);
          lastError = new Error(`ShipStation rate limited (429)`);
          if (attempt < this.maxRetries) continue;
          this.circuitBreaker.recordFailure();
          throw lastError;
        }

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          const err = new Error(`ShipStation API error: ${response.status} ${body.slice(0, 200)}`);
          (err as Error & { statusCode?: number; details?: string }).statusCode = response.status;
          (err as Error & { statusCode?: number; details?: string }).details = body.slice(0, 500);

          // 5xx = transient, record failure
          if (response.status >= 500) {
            this.circuitBreaker.recordFailure();
            lastError = err;
            if (attempt < this.maxRetries) {
              await sleep(Math.pow(2, attempt) * 1000);
              continue;
            }
          }
          throw err;
        }

        this.circuitBreaker.recordSuccess();
        return response.json() as Promise<T>;
      }

      throw lastError ?? new Error("ShipStation request failed after retries");
    };

    if (deduplicateKey) {
      // For GET requests, deduplicate concurrent identical calls
      return this.inFlight.track(deduplicateKey, doFetch) as Promise<T>;
    }

    return doFetch();
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _globalClient: ShipStationClient | null = null;

/** Get or create the process-wide ShipStation client. */
export function getShipStationClient(): ShipStationClient {
  if (!_globalClient) {
    _globalClient = new ShipStationClient();
  }
  return _globalClient;
}

/** Replace the global client (for testing). */
export function setShipStationClient(client: ShipStationClient | null): void {
  _globalClient = client;
}
