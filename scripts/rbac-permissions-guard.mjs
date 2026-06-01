import fs from 'node:fs';
import path from 'node:path';

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
