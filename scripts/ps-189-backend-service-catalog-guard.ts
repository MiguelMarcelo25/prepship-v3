/**
 * PS-189 guard — account→service catalog is backend-owned; media-mail auto-default deleted.
 *
 * THE BUG: OrdersView kept its own CARRIER_SERVICES table AND, on account switch,
 * auto-defaulted serviceCode to the FIRST entry — for stamps_com that silently
 * stamped usps_media_mail (a legally restricted, books-only USPS service) into the
 * purchase payload with no backend re-check and no operator intent.
 *
 * THE FIX:
 *   - canonical catalog src/lib/carrier-service-catalog.ts served at
 *     GET /carriers/service-catalog (static, read-only);
 *   - OrdersView fetches it (session-cached) and its CARRIER_SERVICES copy is gone;
 *   - account switch KEEPS the current service when the new account offers it,
 *     otherwise clears to '' forcing an explicit operator pick — no first-entry
 *     auto-default anywhere.
 *
 *   npx tsx scripts/ps-189-backend-service-catalog-guard.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { servicesForCarrierCode, fullServiceCatalog } from '../src/lib/carrier-service-catalog';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

// ── canonical catalog behavior ────────────────────────────────────────────────
const stamps = servicesForCarrierCode('stamps_com');
check('catalog still lists media mail on stamps_com (it exists on the account)',
  stamps.some((s) => s.code === 'usps_media_mail'));
check('unknown carrier code → empty list (never invents services)',
  servicesForCarrierCode('not_a_carrier').length === 0 && servicesForCarrierCode(null).length === 0);
check('catalog covers the five account families',
  ['stamps_com', 'ups', 'ups_walleted', 'fedex', 'fedex_walleted']
    .every((code) => (fullServiceCatalog()[code] ?? []).length > 0));

// ── backend route ─────────────────────────────────────────────────────────────
const carriersRoute = readFileSync('src/routes/carriers.ts', 'utf8');
check('GET /carriers/service-catalog serves the canonical catalog',
  /app\.get\('\/service-catalog'[\s\S]{0,80}fullServiceCatalog\(\)/.test(carriersRoute));

// ── FE: table gone, catalog fetched, no auto-default ─────────────────────────
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}
const offenders = walk('web/src').filter((f) => /CARRIER_SERVICES\s*[:=]/.test(readFileSync(f, 'utf8')));
check('no local CARRIER_SERVICES table anywhere in web/src', offenders.length === 0, offenders.join(', '));

const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
check('OrdersView fetches the backend catalog',
  /'\/carriers\/service-catalog'/.test(ordersView));
check('getServiceOptionsForAccount reads the fetched catalog',
  /return carrierServiceCatalog\[account\.code\] \?\? \[\]/.test(ordersView));
check('no first-entry service auto-default remains',
  !/getServiceOptionsForAccount\([^)]*\)\[0\]\?\.code/.test(ordersView));
check('account switch keeps a still-offered service, else forces an explicit pick',
  /keepService \? current\.serviceCode : ''/.test(ordersView));

if (failures > 0) {
  console.error(`\nFAIL PS-189 backend service catalog guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-189 backend service catalog guard');
