import { createMiddleware } from 'hono/factory';
import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JWTVerifyOptions,
  type JWTPayload,
} from 'jose';
import { env } from '../lib/env';
import { isAdminEmail } from '../lib/admin-emails';

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

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getSupabaseJwks() {
  if (!cachedJwks) {
    const base = env.SUPABASE_URL.replace(/\/+$/, '');
    cachedJwks = createRemoteJWKSet(
      new URL(`${base}/auth/v1/.well-known/jwks.json`)
    );
  }
  return cachedJwks;
}

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

async function verifySupabaseJwt(token: string): Promise<AuthVars | null> {
  const errors: string[] = [];
  let protectedHeader: ReturnType<typeof decodeProtectedHeader>;
  try {
    protectedHeader = decodeProtectedHeader(token);
  } catch (err) {
    console.warn(
      '[auth] Malformed Supabase JWT:',
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
  const isHmacToken = protectedHeader.alg?.startsWith('HS') ?? false;
  const verifyOptions: JWTVerifyOptions | undefined = env.STRICT_JWT_CLAIMS
    ? {
        issuer: `${env.SUPABASE_URL.replace(/\/+$/, '')}/auth/v1`,
        audience: 'authenticated',
      }
    : undefined;

  const verifyWithSecret = async () => {
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(env.SUPABASE_JWT_SECRET),
      verifyOptions
    );
    return payloadToAuthVars(payload);
  };

  const verifyWithJwks = async () => {
    const { payload } = await jwtVerify(token, getSupabaseJwks(), verifyOptions);
    return payloadToAuthVars(payload);
  };

  const attempts = isHmacToken
    ? [verifyWithSecret]
    : [verifyWithJwks, verifyWithSecret];

  for (const attempt of attempts) {
    try {
      const authVars = await attempt();
      if (authVars) return authVars;
      errors.push('verified token missing subject');
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  console.warn('[auth] Invalid Supabase JWT:', errors.join(' | '));
  return null;
}

export const requireAuth = createMiddleware<{ Variables: AuthVars }>(
  async (c, next) => {
    if (AUTH_BYPASS_PREFIXES.some((p) => c.req.path.startsWith(p))) {
      await next();
      return;
    }
    const auth = c.req.header('authorization');
    if (!auth?.toLowerCase().startsWith('bearer ')) {
      return c.json({ error: 'Missing bearer token' }, 401);
    }
    const token = auth.slice(7).trim();
    const authVars = await verifySupabaseJwt(token);
    if (!authVars) {
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
