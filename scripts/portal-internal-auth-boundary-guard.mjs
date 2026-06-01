import { readFileSync } from 'node:fs';

function read(path) {
  return readFileSync(path, 'utf8');
}

function assert(condition, message) {
  if (!condition) {
    console.error(`[PS-062 guard] ${message}`);
    process.exit(1);
  }
}

const authSource = read('src/middleware/auth.ts');
const scopeSource = read('src/lib/client-store-scope.ts');
const printQueueRouteSource = read('src/routes/print-queue.ts');
const packageJson = JSON.parse(read('package.json'));

function roleBlock(role) {
  const match = authSource.match(new RegExp(`${role}:\\s*\\[([\\s\\S]*?)\\]`, 'm'));
  return match?.[1] ?? '';
}

assert(
  authSource.includes("'print_queue:write'"),
  'auth permissions include print_queue:write for internal print queue operations',
);
assert(
  roleBlock('operator').includes("'print_queue:write'") &&
    roleBlock('warehouse').includes("'print_queue:write'"),
  'operator and warehouse roles can perform print queue work',
);
assert(
  !roleBlock('client_user').includes("'print_queue:write'") &&
    !roleBlock('read_only_support').includes("'print_queue:write'"),
  'portal/read-only roles do not receive print_queue:write by default',
);
assert(
  authSource.includes('export type AuthDomain') &&
    authSource.includes('getAuthDomain') &&
    authSource.includes('isPortalSession') &&
    authSource.includes('requireInternalPermission'),
  'auth middleware exposes an explicit portal/internal session boundary',
);
assert(
  authSource.includes("authDomain === 'portal'") ||
    authSource.includes("isPortalSession({"),
  'internal permission guard rejects portal sessions before internal ops run',
);

assert(
  scopeSource.includes('getInternalOpsClientStoreScope'),
  'client/store scope helper exposes an internal ops variant',
);
assert(
  scopeSource.includes("auth.role === 'operator'") &&
    scopeSource.includes("auth.role === 'warehouse'") &&
    scopeSource.includes("'print_queue:write'"),
  'internal ops scope treats operator/warehouse/print_queue permission as internal authority',
);

assert(
  printQueueRouteSource.includes("requireInternalPermission('print_queue:write')"),
  'print queue route requires internal print_queue:write permission',
);
assert(
  printQueueRouteSource.includes('getInternalOpsClientStoreScope') &&
    !printQueueRouteSource.includes('getClientStoreScope({'),
  'print queue uses internal ops scope, not portal tenant scope, for internal routes',
);
assert(
  printQueueRouteSource.includes('[print-queue:auth-denied]') &&
    printQueueRouteSource.includes('authDomain') &&
    printQueueRouteSource.includes('requestedOrderIds') &&
    printQueueRouteSource.includes('requestedClientIds') &&
    printQueueRouteSource.includes('allowedClientIds') &&
    printQueueRouteSource.includes('allowedStoreIds') &&
    printQueueRouteSource.includes('redactEmailForLog'),
  'print queue auth denials emit sanitized PS-062 diagnostics',
);

assert(
  packageJson.scripts?.['test:portal-internal-auth-boundary'] ===
    'node scripts/portal-internal-auth-boundary-guard.mjs',
  'package exposes PS-062 portal/internal auth boundary guard',
);

console.log('PS-062 portal/internal auth boundary guard passed');
