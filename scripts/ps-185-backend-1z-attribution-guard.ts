/**
 * PS-185 guard — UPS 1Z tracking-prefix attribution is backend-owned.
 *
 * THE BUG: OrdersView duplicated the backend's 1Z tracking→account derivation
 * (slice the 6-char account number out of a 1Z tracking number, match it against
 * the carrier-account registry). The backend performs the IDENTICAL derivation in
 * resolveV2CarrierAccountRef (src/routes/orders.ts) and stamps the result into
 * the canonical providerAccountId + account nickname on every order's shipping
 * model — which the FE lookup reads FIRST. The FE copy could only ever fire when
 * the backend (same data, same registry) had already failed, while silently
 * drifting from it.
 *
 * THE FIX: the FE /^1Z/ block is deleted; resolveV2CarrierAccount keeps only
 * display lookup of the backend-stamped id (exact id, then carrier-code match).
 *
 * Pins:
 *   1. No 1Z tracking-prefix attribution anywhere in web/src (recursive sweep
 *      for the startsWith('1Z') + slice account-number pattern).
 *   2. Backend owner unchanged: resolveV2CarrierAccountRef still derives from
 *      the tracking account number and feeds the canonical provider pick.
 *   3. FE lookup reads the canonical shipping model id first.
 *
 *   npx tsx scripts/ps-185-backend-1z-attribution-guard.ts
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
const offenders = walk('web/src').filter((f) => {
  const src = readFileSync(f, 'utf8');
  return /startsWith\(['"]1Z['"]\)/.test(src) || /\/\^1Z\//.test(src);
});
check('no 1Z tracking-prefix attribution anywhere in web/src', offenders.length === 0, offenders.join(', '));

const ordersRoute = readFileSync('src/routes/orders.ts', 'utf8');
check('backend resolveV2CarrierAccountRef still owns the 1Z derivation',
  /function resolveV2CarrierAccountRef[\s\S]{0,800}startsWith\('1Z'\)[\s\S]{0,200}slice\(2, 8\)/.test(ordersRoute));
check('the derived attribution feeds the canonical provider pick',
  /resolvedCarrierAccount\?\.shippingProviderId[\s\S]{0,200}Derived from provider id, carrier code, tracking account number/.test(ordersRoute));

const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
check('FE lookup reads the canonical shipping model id first',
  /getV2CarrierAccountForOrder[\s\S]{0,300}getShippingProviderAccountId\(order\) \?\?/.test(ordersView));
check('FE resolver no longer takes a tracking number',
  /function resolveV2CarrierAccount\(\s*providerAccountId: number \| null,\s*carrierCode: string \| null,\s*clientId: number \| null,\s*\)/.test(ordersView));

if (failures > 0) {
  console.error(`\nFAIL PS-185 backend 1Z attribution guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-185 backend 1Z attribution guard');
