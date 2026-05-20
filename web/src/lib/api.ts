import { supabase } from './supabase';
import { API_BASE } from './api-base';

const SESSION_TIMEOUT_MS = 5_000;
const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 60_000;

export type Pagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type Paginated<T> = {
  data: T[];
  pagination: Pagination;
};

type Init = Omit<RequestInit, 'body'> & { body?: unknown; timeoutMs?: number };

export class ApiRequestError extends Error {
  status?: number;
  requestId?: string;
  method: string;
  path: string;

  constructor(
    message: string,
    options: { status?: number; requestId?: string | null; method: string; path: string }
  ) {
    const requestId = options.requestId?.trim() || undefined;
    super(requestId ? `${message} (Request ID: ${requestId})` : message);
    this.name = 'ApiRequestError';
    this.status = options.status;
    this.requestId = requestId;
    this.method = options.method;
    this.path = options.path;
  }
}

function seconds(ms: number): number {
  return Math.round(ms / 1000);
}

function withRequestId(message: string, requestId?: string): string {
  return requestId ? `${message} (Request ID: ${requestId})` : message;
}

function timeoutError(label: string, timeoutMs: number, requestId?: string): Error {
  return new Error(
    withRequestId(
      `${label} timed out after ${seconds(timeoutMs)}s. Please retry; if it repeats, Render or Supabase is not responding.`,
      requestId
    )
  );
}

function isReadMethod(method: string | undefined): boolean {
  const normalized = (method ?? 'GET').toUpperCase();
  return normalized === 'GET' || normalized === 'HEAD' || normalized === 'OPTIONS';
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timeoutError(label, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function request<T>(path: string, init: Init = {}): Promise<T> {
  const { body, headers, signal, timeoutMs: explicitTimeoutMs, ...rest } = init;
  const method = (rest.method ?? 'GET').toUpperCase();
  const timeoutMs = explicitTimeoutMs ?? (isReadMethod(method) ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS);
  const {
    data: { session },
  } = await withTimeout(
    supabase.auth.getSession(),
    SESSION_TIMEOUT_MS,
    'Authentication session'
  );

  const finalHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(headers as Record<string, string> | undefined),
  };
  const requestId =
    finalHeaders['X-Request-Id'] ||
    finalHeaders['x-request-id'] ||
    (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  finalHeaders['X-Request-Id'] = requestId;
  if (session?.access_token) {
    finalHeaders['Authorization'] = `Bearer ${session.access_token}`;
  }

  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abortFromCaller = () => controller.abort();

  if (signal?.aborted) {
    controller.abort();
  } else {
    signal?.addEventListener('abort', abortFromCaller, { once: true });
  }

  let res: Response;
  try {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    res = await fetch(`${API_BASE}${path}`, {
      ...rest,
      headers: finalHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (timedOut) {
      throw timeoutError(`API ${method} ${path}`, timeoutMs, requestId);
    }
    if (isAbortError(err)) {
      throw new Error(withRequestId(`API ${method} ${path} was cancelled.`, requestId));
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromCaller);
  }

  if (res.status === 401) {
    throw new ApiRequestError('Not authenticated', {
      status: res.status,
      requestId: res.headers.get('x-request-id') ?? requestId,
      method,
      path,
    });
  }

  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const err = await res.json();
      if (err?.error) msg = err.error;
    } catch {
      // ignore
    }
    throw new ApiRequestError(msg, {
      status: res.status,
      requestId: res.headers.get('x-request-id') ?? requestId,
      method,
      path,
    });
  }

  return res.json() as Promise<T>;
}

export const api = {
  get: <T,>(path: string, init?: Omit<Init, 'method' | 'body'>) => request<T>(path, init),
  post: <T,>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body }),
  put: <T,>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body }),
  patch: <T,>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body }),
  delete: <T,>(path: string) => request<T>(path, { method: 'DELETE' }),
};

export function qs(params: Record<string, string | number | boolean | undefined>) {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    out.set(k, String(v));
  }
  const s = out.toString();
  return s ? `?${s}` : '';
}
