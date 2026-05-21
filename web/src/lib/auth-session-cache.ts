import { supabase } from './supabase';

const AUTH_TOKEN_CACHE_MS = 30_000;

let cachedAccessToken: string | null = null;
let cachedTokenExpiresAt = 0;
let inFlightToken: Promise<string | null> | null = null;
let authListenerAttached = false;

function attachAuthListener(): void {
  if (authListenerAttached) return;
  authListenerAttached = true;

  supabase.auth.onAuthStateChange((_event, session) => {
    cachedAccessToken = session?.access_token ?? null;
    cachedTokenExpiresAt = cachedAccessToken ? Date.now() + AUTH_TOKEN_CACHE_MS : 0;
    inFlightToken = null;
  });
}

export function clearCachedAuthToken(): void {
  cachedAccessToken = null;
  cachedTokenExpiresAt = 0;
  inFlightToken = null;
}

export async function getCachedAuthToken(): Promise<string | null> {
  attachAuthListener();

  const now = Date.now();
  if (cachedAccessToken && cachedTokenExpiresAt > now) {
    return cachedAccessToken;
  }

  if (inFlightToken) return inFlightToken;

  inFlightToken = supabase.auth.getSession()
    .then(({ data: { session } }) => {
      cachedAccessToken = session?.access_token ?? null;
      cachedTokenExpiresAt = cachedAccessToken ? Date.now() + AUTH_TOKEN_CACHE_MS : 0;
      return cachedAccessToken;
    })
    .finally(() => {
      inFlightToken = null;
    });

  return inFlightToken;
}
