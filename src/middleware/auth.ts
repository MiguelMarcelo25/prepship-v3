import { createMiddleware } from 'hono/factory';
import type { JWTPayload } from 'jose';
import { isAdminEmail } from '../lib/admin-emails';
import {
  extractBearerToken,
  verifySupabaseJwt,
} from '../lib/auth/verify-supabase-jwt';
import { env } from '../lib/env';
import { elapsedMs, nowMs } from '../lib/http/timing';
import {
  BUSINESS_ROUTE_POLICIES,
  type BusinessRoutePolicyId,
} from '../lib/business-route-policy';

export type AuthVars = {
  userId: string;
  email?: string;
  role?: string;
  permissions?: string[];
  clientIds?: number[];
  storeIds?: number[];
  authDurationMs?: number;
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
  'financials:read',
  // Narrow capability for regenerating canonical billing rows. The billing
  // router still requires financials:read, and its service applies tenant scope.
  'billing:generate',
  // PS-246 (Card 1): a distinct WRITE permission for billing/financial mutations.
  // Read != write — Card 4 gates every billing mutation on this.
  'financials:write',
  // PS-421: named warehouse mutation and scoped rate-quote capabilities.
  'inventory:write',
  'rates:quote',
  'print_queue:write',
  // PS-465: trained internal operators may mutate the compliance declaration.
  // Warehouse users require an explicit JWT claim; portal roles never receive it.
  'hazmat:write',
  'scope:global',
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
    'financials:read',
    'billing:generate',
    // PS-246 (Card 1): operators run billing, so they get write; warehouse/client/support stay read-only.
    'financials:write',
    'inventory:write',
    'rates:quote',
    'print_queue:write',
    'hazmat:write',
  ],
  warehouse: [
    'settings:read',
    'credentials:read',
    'inventory:write',
    'rates:quote',
    'print_queue:write',
  ],
  client_user: ['settings:read', 'billing:generate', 'rates:quote'],
  read_only_support: ['settings:read', 'credentials:read'],
};

// Paths that are served unauthenticated even when they sit under an auth-gated
// prefix. Mock test labels live at /labels/mock/:id — the browser loads them
// via window.open which can't attach a bearer token, and they're fake data
// anyway. The shipmentId is effectively unguessable (random 8-digit int).
const AUTH_BYPASS_PREFIXES = [
  '/labels/mock/',
  // Signed Print Queue PDF view links carry a short-lived HMAC token because
  // Chrome's native PDF viewer cannot attach the Supabase Bearer token.
  '/print-queue/print/view/',
];

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
  const clientIds = normalizeIdList(
    appMetadata?.clientIds ??
      appMetadata?.client_ids ??
      appMetadata?.assignedClientIds ??
      appMetadata?.assigned_client_ids ??
      payload.clientIds ??
      payload.client_ids
  );
  const storeIds = normalizeIdList(
    appMetadata?.storeIds ??
      appMetadata?.store_ids ??
      appMetadata?.assignedStoreIds ??
      appMetadata?.assigned_store_ids ??
      payload.storeIds ??
      payload.store_ids
  );

  return {
    userId: payload.sub,
    email,
    role,
    permissions,
    clientIds,
    storeIds,
  };
}

function normalizeIdList(value: unknown): number[] {
  const rawValues =
    typeof value === 'string'
      ? value.split(',')
      : Array.isArray(value)
        ? value
        : [];

  return Array.from(
    new Set(
      rawValues
        .map((raw) => Number(raw))
        .filter((id) => Number.isInteger(id) && id > 0)
    )
  );
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

export type AuthDomain = 'internal' | 'portal';

export function getAuthDomain(
  auth: Pick<AuthVars, 'role'>
): AuthDomain {
  return auth.role === 'client_user' || auth.role === 'read_only_support'
    ? 'portal'
    : 'internal';
}

export function isPortalSession(auth: Pick<AuthVars, 'role'>): boolean {
  return getAuthDomain(auth) === 'portal';
}

export function isReadOnlySupportMethodAllowed(
  role: string | undefined,
  method: string,
): boolean {
  if (role !== 'read_only_support') return true;
  return ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

export function hasInternalAppPermission(
  auth: Pick<AuthVars, 'email' | 'role' | 'permissions'>,
  permission: AppPermission,
): boolean {
  return getAuthDomain(auth) === 'internal' && hasAppPermission(auth, permission);
}

export type BusinessRoutePolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: 'read_only_method' | 'internal_only' | 'permission' };

export function evaluateBusinessRoutePolicy(
  policyId: BusinessRoutePolicyId,
  auth: Pick<AuthVars, 'email' | 'role' | 'permissions'>,
  method: string = BUSINESS_ROUTE_POLICIES[policyId].method,
): BusinessRoutePolicyDecision {
  const policy = BUSINESS_ROUTE_POLICIES[policyId];
  if (!isReadOnlySupportMethodAllowed(auth.role, method)) {
    return { allowed: false, reason: 'read_only_method' };
  }
  if (policy.audience === 'internal' && getAuthDomain(auth) === 'portal') {
    return { allowed: false, reason: 'internal_only' };
  }
  if (!hasAppPermission(auth, policy.permission)) {
    return { allowed: false, reason: 'permission' };
  }
  return { allowed: true };
}

export const requireAuth = createMiddleware<{ Variables: AuthVars }>(
  async (c, next) => {
    const authStartedAt = nowMs();
    const finishAuthTiming = () => c.set('authDurationMs', elapsedMs(authStartedAt));
    if (AUTH_BYPASS_PREFIXES.some((p) => c.req.path.startsWith(p))) {
      finishAuthTiming();
      await next();
      return;
    }
    const token = extractBearerToken(c.req.header('authorization'));
    if (!token) {
      finishAuthTiming();
      return c.json({ error: 'Missing bearer token' }, 401);
    }
    const verified = await verifySupabaseJwt(token, {
      supabaseUrl: env.SUPABASE_URL,
      jwtSecret: env.SUPABASE_JWT_SECRET,
      strictClaims: env.STRICT_JWT_CLAIMS,
    });
    if (!verified.ok) {
      console.warn('[auth] Invalid Supabase JWT:', verified.reason);
      finishAuthTiming();
      return c.json({ error: 'Invalid token' }, 401);
    }
    const authVars = payloadToAuthVars(verified.payload);
    if (!authVars) {
      console.warn('[auth] Verified Supabase JWT missing subject');
      finishAuthTiming();
      return c.json({ error: 'Invalid token' }, 401);
    }
    c.set('userId', authVars.userId);
    c.set('email', authVars.email);
    c.set('role', authVars.role);
    c.set('permissions', authVars.permissions);
    c.set('clientIds', authVars.clientIds);
    c.set('storeIds', authVars.storeIds);
    finishAuthTiming();
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

// PS-421: read_only_support stays GET/HEAD-only even if a token carries an
// accidentally broad custom permission. Mounted immediately after requireAuth,
// so denial happens before route validation, DB reads, providers, or caches.
export const enforceReadOnlySupportMethods = createMiddleware<{
  Variables: AuthVars;
}>(async (c, next) => {
  if (!isReadOnlySupportMethodAllowed(c.get('role'), c.req.method)) {
    return c.json({ error: 'Read-only support sessions cannot modify data' }, 403);
  }
  await next();
});

export function requireBusinessRoutePolicy(policyId: BusinessRoutePolicyId) {
  return createMiddleware<{ Variables: AuthVars }>(async (c, next) => {
    const decision = evaluateBusinessRoutePolicy(
      policyId,
      {
        email: c.get('email'),
        role: c.get('role'),
        permissions: c.get('permissions'),
      },
      c.req.method,
    );
    if (decision.allowed) {
      await next();
      return;
    }
    if (decision.reason === 'read_only_method') {
      return c.json({ error: 'Read-only support sessions cannot modify data' }, 403);
    }
    if (decision.reason === 'internal_only') {
      return c.json({ error: 'Internal access required' }, 403);
    }
    return c.json({ error: 'Permission required' }, 403);
  });
}

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

export function requireInternalPermission(permission: AppPermission) {
  return createMiddleware<{ Variables: AuthVars }>(async (c, next) => {
    const auth = {
      email: c.get('email'),
      role: c.get('role'),
      permissions: c.get('permissions'),
    };
    const authDomain = getAuthDomain(auth);

    if (authDomain === 'portal' || isPortalSession(auth)) {
      return c.json({ error: 'Internal access required' }, 403);
    }

    if (hasAppPermission(auth, permission)) {
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
