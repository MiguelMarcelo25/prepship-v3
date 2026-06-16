import fs from 'node:fs';
import path from 'node:path';

// PS-259 (Card 14): BEHAVIORAL conversion. This guard previously only string-scanned
// src/main.ts (substring-only — it would still pass even if the route-level authz/scope
// enforcement were deleted). It now ALSO imports the real enforcement owner
// (hasAppPermission from src/middleware/auth) and runs it on representative
// role/permission pairs, asserting the actual security verdict. These assertions FAIL if
// ROLE_PERMISSIONS or hasAppPermission were removed/weakened — they are not tautologies.
// auth.ts imports lib/env which validates required vars at load, so set serverless mode +
// dummy URLs BEFORE the dynamic import.
//
// Because auth.ts is TypeScript, this .mjs must be run via tsx, not node:
//   npx tsx scripts/auth-coverage-guard.mjs
process.env.VERCEL = '1';
process.env.DATABASE_URL ??= 'postgres://u:p@localhost:5432/db';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';

const root = process.cwd();
const mainSource = fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8');

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function assert(condition, message) {
  if (condition) pass(message);
  else fail(message);
}

// ── BEHAVIORAL: run the real authz/scope owner, not a string scan ──────────────────────────────
// hasAppPermission(auth, permission) is the authoritative role→permission matrix evaluator that
// every authz-gated route delegates to. A restricted portal role (client_user) and read-only
// support must be DENIED out-of-scope WRITE permissions; internal staff (operator/admin) must be
// ALLOWED them. If the enforcement logic were deleted or the ROLE_PERMISSIONS matrix opened up,
// these denials would flip to true and this block fails. Note: we pass ONLY { role } (no explicit
// permissions array) so the verdict is decided by the role matrix, not a self-granted permission.
const { hasAppPermission } = await import('../src/middleware/auth.ts');

// Restricted scopes are denied out-of-scope WRITE permissions (the security verdict that matters).
assert(
  hasAppPermission({ role: 'client_user' }, 'settings:write') === false,
  'BEHAVIORAL: client_user (portal) is DENIED settings:write',
);
assert(
  hasAppPermission({ role: 'client_user' }, 'credentials:write') === false,
  'BEHAVIORAL: client_user (portal) is DENIED credentials:write',
);
assert(
  hasAppPermission({ role: 'client_user' }, 'users:manage') === false,
  'BEHAVIORAL: client_user (portal) is DENIED users:manage',
);
assert(
  hasAppPermission({ role: 'read_only_support' }, 'settings:write') === false,
  'BEHAVIORAL: read_only_support is DENIED settings:write',
);
assert(
  hasAppPermission({ role: 'read_only_support' }, 'credentials:write') === false,
  'BEHAVIORAL: read_only_support is DENIED credentials:write',
);
// Internal staff are ALLOWED the same writes — proves the matrix actually grants, not blanket-denies.
assert(
  hasAppPermission({ role: 'operator' }, 'settings:write') === true,
  'BEHAVIORAL: operator is ALLOWED settings:write',
);
assert(
  hasAppPermission({ role: 'operator' }, 'credentials:write') === true,
  'BEHAVIORAL: operator is ALLOWED credentials:write',
);
assert(
  hasAppPermission({ role: 'admin' }, 'users:manage') === true,
  'BEHAVIORAL: admin is ALLOWED users:manage',
);
// An unknown/spoofed role gets nothing (default-deny) — no implicit grant from an unrecognized role.
assert(
  hasAppPermission({ role: 'totally-made-up-role' }, 'settings:read') === false,
  'BEHAVIORAL: unknown role is default-DENIED (no implicit grant)',
);

function protectedPrefixBlock() {
  const start = mainSource.indexOf('const protectedPrefixes = [');
  const end = mainSource.indexOf('];', start);
  if (start === -1 || end === -1) return '';
  return mainSource.slice(start, end);
}

const prefixes = [
  '/orders',
  '/shipments',
  '/packages',
  '/clients',
  '/rates',
  '/labels',
  '/sync',
  '/inventory',
  '/locations',
  '/settings',
  '/billing',
  '/manifests',
  '/analysis',
  '/dashboard',
  '/print-queue',
  '/parent-skus',
  '/products',
  '/init',
  '/admin',
  '/carrier-accounts',
  '/carriers',
  '/users',
  '/worker',
];

const block = protectedPrefixBlock();
assert(block.length > 0, 'main.ts declares protectedPrefixes');

for (const prefix of prefixes) {
  assert(block.includes(`'${prefix}'`), `${prefix} is covered by protectedPrefixes`);
}

assert(
  mainSource.includes('app.use(prefix, requireAuth);') &&
    mainSource.includes('app.use(`${prefix}/*`, requireAuth);'),
  'protectedPrefixes apply root and wildcard requireAuth gates',
);

assert(
  mainSource.includes("app.use('/admin', requireAdmin);") &&
    mainSource.includes("app.use('/admin/*', requireAdmin);"),
  'admin root and wildcard routes require requireAdmin',
);

const healthIndex = mainSource.indexOf("app.route('/health', health);");
const cronIndex = mainSource.indexOf("app.route('/cron', cronRoute);");
const authIndex = mainSource.indexOf('const protectedPrefixes = [');

assert(healthIndex !== -1 && healthIndex < authIndex, '/health is routed before app auth gates');
assert(cronIndex !== -1 && cronIndex < authIndex, '/cron is routed before app auth gates');

if (process.exitCode) {
  process.exit(process.exitCode);
}
