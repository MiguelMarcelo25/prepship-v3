import { api } from './api';

// Compatibility helper for settings code brought over from the temp repo.
// In this app, API calls should go through the configured Hono/Render backend
// rather than same-origin Vercel functions so local dev works too.
export function callVercelFunction<T>(path: string): Promise<T> {
  return api.get<T>(path);
}
