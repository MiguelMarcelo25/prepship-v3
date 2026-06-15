/**
 * PS-242 guard — Marketplace Fee rules use POPULATED Client/Store selectors, not raw ID inputs.
 *
 * BEHAVIORAL (not text-grep): imports + executes the pure option logic to prove catch-all,
 * unknown-ID preservation, client-filtered stores, and incompatible-pair clearing actually work.
 * Plus a few STATIC checks that the raw numeric ID inputs are gone and the selector component is wired.
 *
 *   npx tsx scripts/ps-242-marketplace-fee-scope-selectors-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  buildClientOptions,
  buildStoreOptions,
  parseScopeValue,
  savedClientExtraOption,
  savedStoreExtraOption,
  storeStillValidForClient,
  toClientLites,
  toStoreLites,
} from '../web/src/components/Views/marketplace-fee-scope-options';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const CLIENTS = [{ clientId: 11, name: 'KF Goods' }, { clientId: 10, name: 'DJC' }];
const STORES = [
  { storeId: 376661, clientId: 10, storeName: 'Walmart - DJC' },
  { storeId: 277422, clientId: 11, storeName: 'Amazon - KF' },
];

// ── 1. Catch-all: a blank selection persists as null (compatible with parseMarketplaceFeeRules) ──
check('parseScopeValue("") === null (Any = catch-all)', parseScopeValue('') === null);
check('parseScopeValue("11") === 11 (numeric scope preserved)', parseScopeValue('11') === 11);

// ── 2. Options show human names + IDs ────────────────────────────────────────────────────────
const clientOpts = buildClientOptions(CLIENTS);
check('client option shows "KF Goods — Client ID 11"',
  clientOpts.some((o) => o.id === 11 && o.label === 'KF Goods — Client ID 11'));
const storeOptsAll = buildStoreOptions(STORES, null);
check('store option shows "Walmart - DJC — Store ID 376661"',
  storeOptsAll.some((o) => o.id === 376661 && o.label === 'Walmart - DJC — Store ID 376661'));

// ── 3. Selecting a client filters stores to that client (no cross-client pick) ────────────────
const storeOptsForClient10 = buildStoreOptions(STORES, 10);
check('client 10 sees only its own store (376661)',
  storeOptsForClient10.length === 1 && storeOptsForClient10[0].id === 376661);
check('client 10 does NOT see client 11 store (277422)',
  !storeOptsForClient10.some((o) => o.id === 277422));

// ── 4. Unknown / stale saved IDs are preserved, never dropped ─────────────────────────────────
check('unknown saved clientId -> "Unknown client — ID 999"',
  savedClientExtraOption(999, CLIENTS)?.label === 'Unknown client — ID 999');
check('known clientId -> no extra option', savedClientExtraOption(11, CLIENTS) === null);
check('unknown saved storeId -> "Unknown store — ID 888"',
  savedStoreExtraOption(888, STORES, null)?.label === 'Unknown store — ID 888');
check('saved store from another client is shown + flagged "(other client)"',
  (savedStoreExtraOption(376661, STORES, 11)?.label ?? '').includes('(other client)'));

// ── 5. Incompatible client/store pair is detected (caller clears it) ──────────────────────────
check('store 376661 (client 10) invalid after switching to client 11',
  storeStillValidForClient(376661, 11, STORES) === false);
check('store 376661 valid when its own client (10) selected',
  storeStillValidForClient(376661, 10, STORES) === true);
check('Any-client keeps any store valid', storeStillValidForClient(376661, null, STORES) === true);
check('Any-store always valid', storeStillValidForClient(null, 11, STORES) === true);

// ── 6. Loose API rows map safely + drop bad ids ──────────────────────────────────────────────
check('toClientLites maps clientId|id and drops rows with no id',
  toClientLites([{ clientId: 11, name: 'KF' }, { id: 10, name: 'DJC' }, { name: 'bad' }]).length === 2);
check('toStoreLites maps storeId + keeps clientId',
  toStoreLites([{ storeId: 5, clientId: 11, storeName: 'X' }, { clientId: 9 }]).length === 1);

// ── 7. STATIC: the raw numeric Client ID / Store ID inputs are GONE; selector is wired ─────────
const section = readFileSync('web/src/components/Views/MarketplaceFeesSection.tsx', 'utf8');
check('section no longer binds a raw input to clientId/storeId',
  !/update\(index, \{ clientId: numOrNull/.test(section) && !/update\(index, \{ storeId: numOrNull/.test(section));
check('section renders <MarketplaceFeeScopeSelectors>', /<MarketplaceFeeScopeSelectors/.test(section));
check('section loads the canonical client + store lists',
  /apiClient\.fetchClients\(\)/.test(section) && /apiClient\.fetchStores\(\)/.test(section));
check('section shows a non-destructive warning on option lookup failure',
  /options\.kind === 'error'/.test(section));

const selectors = readFileSync('web/src/components/Views/MarketplaceFeesScopeSelectors.tsx', 'utf8');
check('selector renders Any client + Any store catch-all options',
  /Any client/.test(selectors) && /Any store/.test(selectors));
check('selector uses <select> (no type="number" ID box)',
  /<select/.test(selectors) && !/type="number"/.test(selectors));

check('package.json wires test:ps-242-marketplace-fee-scope-selectors',
  /test:ps-242-marketplace-fee-scope-selectors/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-242 marketplace-fee scope-selectors guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-242 marketplace-fee scope-selectors guard');
