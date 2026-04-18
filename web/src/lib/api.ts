import { supabase } from './supabase';

const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

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

type Init = Omit<RequestInit, 'body'> & { body?: unknown };

async function request<T>(path: string, init: Init = {}): Promise<T> {
  const { body, headers, ...rest } = init;
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const finalHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(headers as Record<string, string> | undefined),
  };
  if (session?.access_token) {
    finalHeaders['Authorization'] = `Bearer ${session.access_token}`;
  }

  const res = await fetch(`${BASE}${path}`, {
    ...rest,
    headers: finalHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401) {
    throw new Error('Not authenticated');
  }

  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const err = await res.json();
      if (err?.error) msg = err.error;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }

  return res.json() as Promise<T>;
}

export const api = {
  get: <T,>(path: string) => request<T>(path),
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
