/**
 * PS-200 S1/S2 guard - account CRUD and carrier ops are v4-routed.
 *
 * Offline/static only: no DB, no network, no provider calls, no labels, no
 * marketplace notifications, and no production data mutation.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walkTs(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTs(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full.replaceAll('\\', '/'));
    }
  }
  return out;
}

function includesAll(source: string, tokens: string[]): string[] {
  return tokens.filter((token) => !source.includes(token));
}

const packageJson = read('package.json');
const ps200Doc = read('docs/ps-200-legacy-api-decommission.md');
const main = read('src/main.ts');
const carrierAccountsRoute = read('src/routes/carrier-accounts.ts');
const storeAccountsRoute = read('src/routes/store-accounts.ts');
const carriersRoute = read('src/routes/carriers.ts');
const settings = read('web/src/components/Settings/CarrierIntegrationsCard.tsx');
const pending = read('web/src/components/Settings/PendingClientIntegrationsCard.tsx');
const useShippingAccounts = read('web/src/hooks/useShippingAccounts.ts');
const sharedApiClient = read('web/src/lib/v2-apiClient/shared.ts');
const v2ApiClient = read('web/src/lib/v2-apiClient.ts');

const webFiles = walkTs('web/src');
const webCode = webFiles
  .map((file) => ({ file, code: stripComments(read(file)) }));

const callVercelOffenders = webCode
  .filter(({ code }) => /callVercelFunction/.test(code))
  .map(({ file }) => file);
const apiFetchOffenders = webCode
  .filter(({ code }) => /fetch\s*\(\s*['"`]\/api\//.test(code))
  .map(({ file }) => file);

check('legacy web/src/lib/vercelFunction.ts transport is deleted',
  !existsSync('web/src/lib/vercelFunction.ts'));

check('web/src has no live callVercelFunction transport calls',
  callVercelOffenders.length === 0,
  callVercelOffenders);

check('web/src has no live same-origin fetch("/api/...") calls',
  apiFetchOffenders.length === 0,
  apiFetchOffenders);

check('v4 main mounts and protects account/carrier ops routes',
  includesAll(main, [
    "'/carrier-accounts'",
    "'/store-accounts'",
    "'/carriers'",
    "app.route('/carrier-accounts', carrierAccountsRoute)",
    "app.route('/store-accounts', storeAccountsRoute)",
    "app.route('/carriers', carriersRoute)",
  ]).length === 0,
  includesAll(main, [
    "'/carrier-accounts'",
    "'/store-accounts'",
    "'/carriers'",
    "app.route('/carrier-accounts', carrierAccountsRoute)",
    "app.route('/store-accounts', storeAccountsRoute)",
    "app.route('/carriers', carriersRoute)",
  ]));

check('carrier/store account v4 routes delegate to imported handlers behind credential permission',
  /requireCredentialAccountPermission/.test(carrierAccountsRoute) &&
  /runNodeHandler\(carrierAccountsHandler\)/.test(carrierAccountsRoute) &&
  /requireCredentialAccountPermission/.test(storeAccountsRoute) &&
  /runNodeHandler\(storeAccountsHandler\)/.test(storeAccountsRoute));

check('carrier ops v4 route owns verify, settings rates probe, order pulls, and Walmart fees entrypoints',
  includesAll(carriersRoute, [
    "app.all('/verify'",
    "app.post('/rates'",
    "probeCarrierAccountRates",
    "app.all('/walmart/orders'",
    "app.all('/ebay/orders'",
    "app.post('/walmart/fees'",
    "syncWalmartFeesForAccount",
  ]).length === 0,
  includesAll(carriersRoute, [
    "app.all('/verify'",
    "app.post('/rates'",
    "probeCarrierAccountRates",
    "app.all('/walmart/orders'",
    "app.all('/ebay/orders'",
    "app.post('/walmart/fees'",
    "syncWalmartFeesForAccount",
  ]));

check('Settings integration UI calls v4 account and carrier ops routes through api client',
  includesAll(settings, [
    "api.post<{ data: SavedRow | null }>(endpoint, body)",
    "api.post<VerifyResult>(",
    "'/carriers/verify'",
    "api.delete<unknown>(`${endpoint}?id=${rowId}`)",
    "api.patch<{ data: Record<string, unknown> | null }>(",
    "api.post<WalmartOrdersResult>('/carriers/walmart/orders'",
    "api.post<WalmartOrdersResult>('/carriers/ebay/orders'",
    "api.post<FeesPullResult>('/carriers/walmart/fees'",
    "api.post<CarrierRatesResult>('/carriers/rates'",
    "api.get<{ data: RawIntegrationRow[] }>('/carrier-accounts')",
    "api.get<{ data: RawIntegrationRow[] }>('/store-accounts?source=admin')",
  ]).length === 0,
  includesAll(settings, [
    "api.post<{ data: SavedRow | null }>(endpoint, body)",
    "api.post<VerifyResult>(",
    "'/carriers/verify'",
    "api.delete<unknown>(`${endpoint}?id=${rowId}`)",
    "api.patch<{ data: Record<string, unknown> | null }>(",
    "api.post<WalmartOrdersResult>('/carriers/walmart/orders'",
    "api.post<WalmartOrdersResult>('/carriers/ebay/orders'",
    "api.post<FeesPullResult>('/carriers/walmart/fees'",
    "api.post<CarrierRatesResult>('/carriers/rates'",
    "api.get<{ data: RawIntegrationRow[] }>('/carrier-accounts')",
    "api.get<{ data: RawIntegrationRow[] }>('/store-accounts?source=admin')",
  ]));

check('pending integrations UI uses v4 carrier-accounts route through api client',
  /api\.get<\{ data: PendingIntegration\[\] \}>\('\/carrier-accounts\?source=portal&pending=1'\)/.test(pending) &&
  /api\.delete\(`\/carrier-accounts\?id=\$\{id\}`\)/.test(pending) &&
  /api\.patch\(`\/carrier-accounts\?id=\$\{id\}`/.test(pending));

check('Rate Browser direct-carrier account list uses v4 carrier-accounts route',
  /api\.get<V4DirectCarriersResponse>\('\/carrier-accounts\?source=admin'\)/.test(useShippingAccounts));

check('v2-apiClient delegates scoped carrier identity to the v4 rates read model',
  /`\/rates\/carriers-for-store/.test(v2ApiClient) &&
  !/\/carrier-accounts\?source=admin|\/store-accounts\?source=admin/.test(v2ApiClient + sharedApiClient));

check('S2 zero-caller diagnostic endpoints stay deleted',
  !existsSync('api/carriers/validate-address.ts') &&
  !existsSync('api/carriers/ups/probe.ts') &&
  !existsSync('api/carriers/walmart/probe-carriers.ts'));

check('PS-200 doc records S1/S2 v4 cutover as guarded locally',
  /S1\/S2 v4 cutover guarded locally/.test(ps200Doc) &&
  /test:ps-200-v4-account-carrier-ops-cutover/.test(ps200Doc));

check('PS-200 doc no longer says frontend reaches legacy stack via callVercelFunction/raw carrier fetch',
  !/The FE reaches the legacy stack two ways/.test(ps200Doc) &&
  !/raw `fetch\('\/api\/carrier-accounts\?source=admin'\)`/.test(ps200Doc));

check('stale S1 comments do not describe account endpoints as /api or Vercel-backed',
  !/Stores live in \/api\/store-accounts, carriers in \/api\/carrier-accounts/.test(settings) &&
  !/caches \/api\/carrier-accounts/.test(settings) &&
  !/via Vercel\s*[\r\n]+\s*\/\/ \/api\/carrier-accounts/.test(useShippingAccounts));

check('package wires PS-200 v4 account/carrier ops cutover guard',
  packageJson.includes('"test:ps-200-v4-account-carrier-ops-cutover"'));

if (failures > 0) {
  console.error(`\nFAIL PS-200 v4 account/carrier ops cutover guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-200 v4 account/carrier ops cutover guard');
