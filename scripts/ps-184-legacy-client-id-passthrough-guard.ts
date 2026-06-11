/**
 * PS-184 guard — legacy client-id parity is backend-owned; FE remap tables deleted.
 *
 * THE BUG: OrdersView kept THREE remap tables (legacy id by display name / by
 * store id / by current id) that shadowed the backend's `legacyClientId` —
 * the backend stamps that field on every order row AND detail payload via
 * resolveLegacyClientId (the canonical store/client parity map). Two copies of
 * id-mapping data drift; the FE tables also consulted display strings (client
 * name) the backend never trusts.
 *
 * THE FIX: the three FE tables are deleted; getLegacyClientIdForDisplay is a
 * pure pass-through of order.legacyClientId (clientId fallback for pre-stamp
 * rows only).
 *
 * Pins:
 *   1. No LEGACY_CLIENT_ID_BY_* table anywhere in web/src (recursive sweep).
 *   2. getLegacyClientIdForDisplay passes the backend value through.
 *   3. Backend owner unchanged: resolveLegacyClientId exists and both the list
 *      rows and the detail payload stamp legacyClientId from it.
 *
 *   npx tsx scripts/ps-184-legacy-client-id-passthrough-guard.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}
const offenders = walk('web/src').filter((f) => /LEGACY_CLIENT_ID_BY_\w+\s*=\s*new Map/.test(readFileSync(f, 'utf8')));
check('no FE legacy client-id remap table anywhere in web/src', offenders.length === 0, offenders.join(', '));

const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
check('getLegacyClientIdForDisplay passes the backend value through',
  /function getLegacyClientIdForDisplay[\s\S]{0,500}return toNumericValue\(order\.legacyClientId\) \?\? toNumericValue\(order\.clientId\)/.test(ordersView));
check('no display-name-based legacy mapping remains',
  !/LEGACY_CLIENT_ID_BY_DISPLAY_NAME/.test(ordersView));

const ordersRoute = readFileSync('src/routes/orders.ts', 'utf8');
check('backend resolveLegacyClientId owner unchanged',
  /function resolveLegacyClientId\(/.test(ordersRoute) &&
  /LEGACY_CLIENT_ID_BY_STORE_ID/.test(ordersRoute) &&
  /LEGACY_CLIENT_ID_BY_CURRENT_ID/.test(ordersRoute));
check('list rows + detail payload both stamp legacyClientId from the owner',
  (ordersRoute.match(/resolveLegacyClientId\(/g)?.length ?? 0) >= 3);

if (failures > 0) {
  console.error(`\nFAIL PS-184 legacy client-id passthrough guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-184 legacy client-id passthrough guard');
