// v2-compat shim: v2 raw-fetch code paths expect API_BASE_URL + authHeaders.
// In v4 auth goes through Supabase bearer tokens (via lib/api.ts); the
// typical consumer is OrdersView's apiClient adapter, which routes through
// that path. This shim exists so v2 imports still resolve.

export const API_BASE_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3000'

export function authHeaders(
  extra: Record<string, string> = {}
): Record<string, string> {
  return { ...extra }
}
