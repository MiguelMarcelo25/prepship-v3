import { getCachedAuthToken } from './auth-session-cache';

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
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<T> {
  const url = `/api${path.startsWith('/') ? path : `/${path}`}`;
  const accessToken = await getCachedAuthToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers ?? {}),
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
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
}
