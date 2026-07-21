// PS-251 (Card 6): wrap fetch with an AbortController timeout so a hung carrier/provider upstream
// can't stall a request (or a worker job) indefinitely — there was no per-fetch timeout on the
// connector calls. Drop-in replacement for fetch: same (input, init) signature plus an optional
// timeoutMs; it merges an abort signal into init and clears the timer in finally. On timeout it throws
// a clear, typed FetchTimeoutError instead of hanging or surfacing an opaque AbortError.
const DEFAULT_TIMEOUT_MS = 30_000;

export class FetchTimeoutError extends Error {
  readonly code = 'FETCH_TIMEOUT' as const;
  constructor(
    readonly url: string,
    readonly timeoutMs: number,
  ) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
    this.name = 'FetchTimeoutError';
  }
}

export async function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal;
  try {
    return await fetch(input, { ...init, signal });
  } catch (err) {
    if (controller.signal.aborted) {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      throw new FetchTimeoutError(url, timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
