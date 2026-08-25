/**
 * PS-497 Slice 2 Release B (S2.6, Hermes #1) — behavioral authorization proof for the operator
 * review-resolution route. The route MUTATES inventory-bound claim state, so it must require the internal
 * inventory:write permission, not merely authentication. This suite runs the REAL Hono middleware chain and
 * asserts: an unauthenticated request is 401 (requireAuth); a portal client_user is 403; a portal
 * read_only_support is 403; an authenticated internal user WITHOUT inventory:write is 403; and an authorized
 * internal inventory operator passes the permission gate (reaches the handler, which 400s on a bad claimId —
 * proving no DB mutation is attempted). Portal/client sessions are tenant-scoped and refused outright, so they
 * can never resolve another client's claim; internal inventory operators are cross-tenant by design.
 */
import { Hono } from 'hono';

process.env.VERCEL = '1';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://ps497:ps497@127.0.0.1:1/ps497_authz';
process.env.SUPABASE_URL = 'https://ps497-authz.supabase.invalid';
process.env.SUPABASE_ANON_KEY = 'ps497-authz-anon-not-real';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'ps497-authz-service-not-real';
process.env.SUPABASE_JWT_SECRET = 'ps497-authz-jwt-not-real';

const [{ default: fulfillmentReviewRoute }, { requireAuth }] = await Promise.all([
  import('../src/routes/fulfillment-review.js'),
  import('../src/middleware/auth.js'),
]);

let failures = 0;
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) { console.log(`ok   ${name}`); return; }
  failures += 1;
  console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
};

type AuthContext = { userId: string; email: string; role: string; permissions: string[]; clientIds?: number[]; storeIds?: number[] };

function appWithAuth(auth: AuthContext): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('userId' as never, auth.userId as never);
    c.set('email' as never, auth.email as never);
    c.set('role' as never, auth.role as never);
    c.set('permissions' as never, auth.permissions as never);
    c.set('clientIds' as never, (auth.clientIds ?? []) as never);
    c.set('storeIds' as never, (auth.storeIds ?? []) as never);
    await next();
  });
  app.route('/', fulfillmentReviewRoute);
  return app;
}

const body = JSON.stringify({ decision: 'pending' });
const headers = { 'content-type': 'application/json' };
// claimId 0 fails the handler's positive-integer check BEFORE any DB call, so a 400 here means the request
// PASSED the permission gate (an authorized caller), while a 403 means it was blocked at authorization.
const PATH = '/claims/0/resolve';
const req = (app: Hono) => app.request(PATH, { method: 'POST', headers, body });

async function main(): Promise<void> {
  // 1) Unauthenticated -> 401 (the route sits behind requireAuth; no bearer token).
  const authApp = new Hono();
  authApp.use('*', requireAuth);
  authApp.route('/', fulfillmentReviewRoute);
  const unauth = await authApp.request(PATH, { method: 'POST', headers, body });
  check('unauthenticated request is 401 (requireAuth)', unauth.status === 401, `got ${unauth.status}`);

  // 2) Portal client_user -> 403 (internal access required).
  const clientUser = await req(appWithAuth({ userId: 'u1', email: 'client@x', role: 'client_user', permissions: ['settings:read', 'billing:generate', 'rates:quote'], clientIds: [10] }));
  check('portal client_user is 403 (cannot mutate inventory-bound claim state)', clientUser.status === 403, `got ${clientUser.status}`);

  // 3) Portal read_only_support -> 403.
  const readOnly = await req(appWithAuth({ userId: 'u2', email: 'support@x', role: 'read_only_support', permissions: ['settings:read', 'automations:read', 'credentials:read'] }));
  check('portal read_only_support is 403', readOnly.status === 403, `got ${readOnly.status}`);

  // 4) Authenticated internal user WITHOUT inventory:write -> 403.
  const internalNoPerm = await req(appWithAuth({ userId: 'u3', email: 'internal@x', role: 'custom_internal', permissions: [] }));
  check('authenticated internal user lacking inventory:write is 403', internalNoPerm.status === 403, `got ${internalNoPerm.status}`);

  // 5) Authorized internal inventory operator -> PASSES the permission gate (handler 400s on claimId 0).
  const authorized = await req(appWithAuth({ userId: 'u4', email: 'ops@x', role: 'custom_internal', permissions: ['inventory:write'] }));
  check('authorized internal inventory operator passes auth (400 bad claimId, not 403)', authorized.status === 400, `got ${authorized.status}`);

  // 6) The admin role (all permissions, internal) also passes.
  const admin = await req(appWithAuth({ userId: 'u5', email: 'admin@x', role: 'admin', permissions: [] }));
  check('admin (internal, all permissions) passes auth (400 bad claimId, not 403)', admin.status === 400, `got ${admin.status}`);

  if (failures > 0) {
    console.error(`\nFAIL PS-497 review route authz guard (${failures} failing)`);
    process.exit(1);
  }
  console.log('\nPASS PS-497 review route authz guard — 6/6 checks');
}

main().catch((error) => { console.error(error); process.exit(1); });
