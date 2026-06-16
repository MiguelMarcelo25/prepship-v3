/**
 * PS-246 (Card 1) guard — a distinct financials:write permission exists, separating
 * billing READ from billing WRITE, with the right role assignment.
 *
 *   npx tsx scripts/ps-246-financials-write-permission-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const auth = readFileSync('src/middleware/auth.ts', 'utf8');

// The APP_PERMISSIONS tuple defines the type, so a write perm must live there.
const appPerms = auth.match(/export const APP_PERMISSIONS = \[([\s\S]*?)\] as const/)?.[1] ?? '';
check('APP_PERMISSIONS declares both financials:read and financials:write',
  /'financials:read'/.test(appPerms) && /'financials:write'/.test(appPerms));

// Per-role assignment: operator + admin get write; warehouse/client/support do NOT.
const operatorArr = auth.match(/operator:\s*\[([^\]]*)\]/)?.[1] ?? '';
check('operator role has financials:write', /'financials:write'/.test(operatorArr));
check('admin inherits all permissions (admin: APP_PERMISSIONS)', /admin:\s*APP_PERMISSIONS/.test(auth));

const warehouseArr = auth.match(/warehouse:\s*\[([^\]]*)\]/)?.[1] ?? '';
const clientArr = auth.match(/client_user:\s*\[([^\]]*)\]/)?.[1] ?? '';
const supportArr = auth.match(/read_only_support:\s*\[([^\]]*)\]/)?.[1] ?? '';
check('warehouse has NO financials:write', !/'financials:write'/.test(warehouseArr));
check('client_user has NO financials:read/write',
  !/'financials:(read|write)'/.test(clientArr));
check('read_only_support has NO financials:write', !/'financials:write'/.test(supportArr));

// The permission type must still be derived from the tuple (so financials:write is a valid AppPermission).
check('AppPermission is derived from APP_PERMISSIONS',
  /export type AppPermission = \(typeof APP_PERMISSIONS\)\[number\]/.test(auth));

check('package.json wires test:ps-246-financials-write-permission',
  /test:ps-246-financials-write-permission/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-246 financials:write permission guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-246 financials:write permission guard');
