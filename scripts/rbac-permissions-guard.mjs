import fs from 'node:fs';
import path from 'node:path';

// PS-259 (Card 14): BEHAVIORAL conversion. This guard previously only string-scanned
// auth.ts/route files (substring-only — it would pass even if the RBAC enforcement were
// deleted). It now ALSO imports the real enforcement owner (hasAppPermission from
// src/middleware/auth) and runs it on representative role/permission pairs, asserting the
// actual security verdict. These assertions FAIL if ROLE_PERMISSIONS or hasAppPermission
// were removed/weakened — they are not tautologies. auth.ts imports lib/env which validates
// required vars at load, so set serverless mode + dummy URLs BEFORE the dynamic import.
//
// Because auth.ts is TypeScript, this .mjs must be run via tsx, not node:
//   npx tsx scripts/rbac-permissions-guard.mjs
process.env.VERCEL = '1';
process.env.DATABASE_URL ??= 'postgres://u:p@localhost:5432/db';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

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

// ── BEHAVIORAL: run the real RBAC owner, not a string scan ────────────────────────────────────
// hasAppPermission(auth, permission) is the authoritative role→permission matrix evaluator.
// A restricted portal role (client_user) and read-only support must be DENIED write permissions;
// internal staff (operator/admin) must be ALLOWED them. If the enforcement logic were deleted
// or the ROLE_PERMISSIONS matrix opened up, these denials would flip to true and this block fails.
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
// An unknown/spoofed role gets nothing (default-deny), and an admin email overrides the role matrix.
assert(
  hasAppPermission({ role: 'totally-made-up-role' }, 'settings:read') === false,
  'BEHAVIORAL: unknown role is default-DENIED (no implicit grant)',
);

// ── STATIC: route/source checks (unchanged — still enforced) ──────────────────────────────────
const authSource = read('src/middleware/auth.ts');
const usersSource = read('src/routes/users.ts');
const settingsSource = read('src/routes/settings.ts');
const carrierAccountsSource = read('src/routes/carrier-accounts.ts');
const carriersSource = read('src/routes/carriers.ts');

assert(authSource.includes('APP_ROLES'), 'auth middleware defines canonical app roles');
for (const role of ['admin', 'operator', 'warehouse', 'client_user', 'read_only_support']) {
  assert(authSource.includes(`'${role}'`), `auth middleware includes ${role} role`);
}

assert(authSource.includes('APP_PERMISSIONS'), 'auth middleware defines app permissions');
for (const permission of [
  'users:manage',
  'settings:read',
  'settings:write',
  'credentials:read',
  'credentials:write',
  'print_queue:write',
]) {
  assert(authSource.includes(`'${permission}'`), `auth middleware includes ${permission} permission`);
}

assert(authSource.includes('requirePermission'), 'auth middleware exports requirePermission');
assert(authSource.includes('requireInternalPermission'), 'auth middleware exports internal permission guard');
assert(
  authSource.includes('app_metadata') && authSource.includes('permissions'),
  'auth middleware reads app_metadata permissions from Supabase JWT',
);

assert(
  usersSource.includes("requirePermission('users:manage')") &&
    usersSource.includes("app.get('/', requirePermission('users:manage')"),
  '/users root requires user-management permission',
);
assert(
  usersSource.includes("app.get('/me'") &&
    !usersSource.includes("app.get('/me', requirePermission('users:manage')"),
  '/users/me remains authenticated-self without user-management permission',
);

assert(
  settingsSource.includes("requirePermission('settings:read'") &&
    settingsSource.includes("app.get('/', requirePermission('settings:read'") &&
    settingsSource.includes("app.get('/:key', requirePermission('settings:read'"),
  'settings reads require settings:read permission',
);
assert(
  settingsSource.includes("requirePermission('settings:write'") &&
    settingsSource.includes("app.put('/:key', requirePermission('settings:write'") &&
    settingsSource.includes("app.delete('/:key', requirePermission('settings:write'"),
  'settings writes require settings:write permission',
);

assert(
  carrierAccountsSource.includes('requireCredentialAccountPermission') &&
    carrierAccountsSource.includes("app.all('/', requireCredentialAccountPermission"),
  'carrier account route uses method-aware credential permission middleware',
);
assert(
  carriersSource.includes("requirePermission('credentials:write'") &&
    carriersSource.includes("app.all('/verify', requirePermission('credentials:write'"),
  'carrier verification requires credential write permission',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
