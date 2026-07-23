// PS-251 (Card 6): wrap fetch with an AbortController timeout so a hung carrier/provider upstream
// can't stall a request (or a worker job) indefinitely — there was no per-fetch timeout on the
// connector calls. Drop-in replacement for fetch: same (input, init) signature plus an optional
// timeoutMs; it merges an abort signal into init. The timeout stays armed after
// response headers arrive because fetch bodies are streamed asynchronously.
// Header-phase timeouts throw FetchTimeoutError; a body read observes the same
// abort signal and rejects instead of hanging indefinitely.
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
    const response = await fetch(input, { ...init, signal });
    // Once headers arrive, the response body/socket keeps real streaming work
    // alive. Do not make a completed short body hold a CLI process open solely
    // for this safety timer.
    timer.unref?.();
    return response;
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      throw new FetchTimeoutError(url, timeoutMs);
    }
    throw err;
  }
}
