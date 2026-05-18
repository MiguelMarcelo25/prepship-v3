import { createMiddleware } from 'hono/factory';
import type { JWTPayload } from 'jose';
import { isAdminEmail } from '../lib/admin-emails';
import {
  extractBearerToken,
  verifySupabaseJwt,
} from '../lib/auth/verify-supabase-jwt';
import { env } from '../lib/env';

export type AuthVars = {
  userId: string;
  email?: string;
  role?: string;
};

// Paths that are served unauthenticated even when they sit under an auth-gated
// prefix. Mock test labels live at /labels/mock/:id — the browser loads them
// via window.open which can't attach a bearer token, and they're fake data
// anyway. The shipmentId is effectively unguessable (random 8-digit int).
const AUTH_BYPASS_PREFIXES = ['/labels/mock/'];

function payloadToAuthVars(payload: JWTPayload): AuthVars | null {
  if (typeof payload.sub !== 'string' || !payload.sub) return null;
  const appMetadata =
    payload.app_metadata &&
    typeof payload.app_metadata === 'object' &&
    !Array.isArray(payload.app_metadata)
      ? (payload.app_metadata as Record<string, unknown>)
      : null;
  const email = typeof payload.email === 'string' ? payload.email : undefined;
  const role =
    typeof appMetadata?.role === 'string'
      ? appMetadata.role
      : typeof payload.role === 'string'
        ? payload.role
        : undefined;

  return {
    userId: payload.sub,
    email,
    role,
  };
}

export const requireAuth = createMiddleware<{ Variables: AuthVars }>(
  async (c, next) => {
    if (AUTH_BYPASS_PREFIXES.some((p) => c.req.path.startsWith(p))) {
      await next();
      return;
    }
    const token = extractBearerToken(c.req.header('authorization'));
    if (!token) {
      return c.json({ error: 'Missing bearer token' }, 401);
    }
    const verified = await verifySupabaseJwt(token, {
      supabaseUrl: env.SUPABASE_URL,
      jwtSecret: env.SUPABASE_JWT_SECRET,
      strictClaims: env.STRICT_JWT_CLAIMS,
    });
    if (!verified.ok) {
      console.warn('[auth] Invalid Supabase JWT:', verified.reason);
      return c.json({ error: 'Invalid token' }, 401);
    }
    const authVars = payloadToAuthVars(verified.payload);
    if (!authVars) {
      console.warn('[auth] Verified Supabase JWT missing subject');
      return c.json({ error: 'Invalid token' }, 401);
    }
    c.set('userId', authVars.userId);
    c.set('email', authVars.email);
    c.set('role', authVars.role);
    await next();
  }
);

export const requireAdmin = createMiddleware<{ Variables: AuthVars }>(
  async (c, next) => {
    const email = c.get('email');
    const role = c.get('role');

    if (role !== 'admin' && !isAdminEmail(email)) {
      return c.json({ error: 'Admin access required' }, 403);
    }

    await next();
  }
);
