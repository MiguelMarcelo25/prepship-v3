import { getCachedAuthToken } from './auth-session-cache';

const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 60_000;

function getDefaultTimeoutMs(method: string) {
  return method === 'GET' || method === 'HEAD' ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS;
}

function getTimeoutError(method: string, url: string, timeoutMs: number) {
  const timeoutSeconds = Math.round(timeoutMs / 1000);
  return new Error(
    `Timed out after ${timeoutSeconds}s calling ${method} ${url}. The carrier provider may still be processing; retry from Orders in a moment and check provider history before buying another label.`
  );
}

// Calls a same-origin Vercel serverless function under /api/<path>. Differs
// from the regular `api` client (which targets the Render backend via
// API_BASE) — this one stays on Vercel so we can fix server-side bugs by
// shipping a Vercel deploy without touching Render. Used for carrier-account
// CRUD and verify until the Render API is redeployed with current code.
//
// Auth: forwards the active Supabase session JWT in the Authorization header
// — same scheme the Render API uses, so the verifier handlers can reuse
// their existing JWT-validation code.
export async function callVercelFunction<T>(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {}
): Promise<T> {
  const url = `/api${path.startsWith('/') ? path : `/${path}`}`;
  const method = (init.method ?? 'GET').toUpperCase();
  const timeoutMs = typeof init.timeoutMs === 'number' && Number.isFinite(init.timeoutMs) && init.timeoutMs > 0
    ? init.timeoutMs
    : getDefaultTimeoutMs(method);
  const accessToken = await getCachedAuthToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers ?? {}),
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const err = await res.json();
        if (err?.error) msg = err.error;
      } catch {
        // ignore — keep status text
      }
      throw new Error(msg);
    }
    return (await res.json()) as T;
  } catch (error) {
    if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      throw getTimeoutError(method, url, timeoutMs);
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}
