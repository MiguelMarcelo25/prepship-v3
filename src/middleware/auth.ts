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
  permissions?: string[];
};

export const APP_ROLES = [
  'admin',
  'operator',
  'warehouse',
  'client_user',
  'read_only_support',
] as const;

export type AppRole = (typeof APP_ROLES)[number];

export const APP_PERMISSIONS = [
  'users:manage',
  'settings:read',
  'settings:write',
  'credentials:read',
  'credentials:write',
] as const;

export type AppPermission = (typeof APP_PERMISSIONS)[number];

const APP_ROLE_SET = new Set<string>(APP_ROLES);

const ROLE_PERMISSIONS: Record<AppRole, readonly AppPermission[]> = {
  admin: APP_PERMISSIONS,
  operator: [
    'settings:read',
    'settings:write',
    'credentials:read',
    'credentials:write',
  ],
  warehouse: ['settings:read', 'credentials:read'],
  client_user: ['settings:read'],
  read_only_support: ['settings:read', 'credentials:read'],
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
  const rawPermissions = Array.isArray(appMetadata?.permissions)
    ? appMetadata.permissions
    : Array.isArray(payload.permissions)
      ? payload.permissions
      : [];
  const permissions = rawPermissions.filter(
    (permission): permission is string => typeof permission === 'string'
  );

  return {
    userId: payload.sub,
    email,
    role,
    permissions,
  };
}

export function isAppRole(role: string | undefined): role is AppRole {
  return Boolean(role && APP_ROLE_SET.has(role));
}

export function hasAppPermission(
  auth: Pick<AuthVars, 'email' | 'role' | 'permissions'>,
  permission: AppPermission
): boolean {
  if (isAdminEmail(auth.email)) return true;
  if (auth.permissions?.includes(permission)) return true;
  if (!isAppRole(auth.role)) return false;
  return ROLE_PERMISSIONS[auth.role].includes(permission);
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
    c.set('permissions', authVars.permissions);
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

export function requirePermission(permission: AppPermission) {
  return createMiddleware<{ Variables: AuthVars }>(async (c, next) => {
    if (
      hasAppPermission(
        {
          email: c.get('email'),
          role: c.get('role'),
          permissions: c.get('permissions'),
        },
        permission
      )
    ) {
      await next();
      return;
    }

    return c.json({ error: 'Permission required' }, 403);
  });
}

export const requireCredentialAccountPermission = createMiddleware<{
  Variables: AuthVars;
}>(async (c, next) => {
  const method = c.req.method.toUpperCase();
  const permission: AppPermission =
    method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
      ? 'credentials:read'
      : 'credentials:write';

  if (
    hasAppPermission(
      {
        email: c.get('email'),
        role: c.get('role'),
        permissions: c.get('permissions'),
      },
      permission
    )
  ) {
    await next();
    return;
  }

  return c.json({ error: 'Permission required' }, 403);
});
