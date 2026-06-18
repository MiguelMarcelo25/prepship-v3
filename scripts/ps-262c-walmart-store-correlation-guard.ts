/**
 * PS-262c — Walmart Shipping store/account correlation guard (BEHAVIORAL + STATIC).
 *
 * The boss audit (2026-06-17) flagged that PS-262 evidence did NOT prove the rule
 * "Walmart Shipping direct may only rate/buy for the matching Walmart store/account."
 * This guard supplies that missing proof. The correlation is enforced (not by a new
 * gate, but) by the existing store-scope owner: a `walmart_shipping` row lives in
 * store_accounts keyed by client_id, and BOTH the rate path
 * (rates.ts loadVisibleDirectCarrierAccounts -> directCarrierVisibleForScope) AND the
 * label path (labels-direct.ts loadDirectAccountForLabel -> directCarrierVisibleForScope
 * -> throws DIRECT_CARRIER_NOT_ASSIGNED) gate the account to the order's client/store.
 * A Walmart Shipping account therefore can never rate or buy for a DIFFERENT store.
 *
 * Scope note: correlation is at the store-account (client_id) level — the granularity
 * Walmart credentials are stored at. The broader "direct non-ShipStation never resolves
 * to ParcelGuard" invariant (direct FedEx) is intentionally owned by PS-261 (it needs
 * reliable direct-vs-brokered ACCOUNT context the carrierCode alone cannot give); see
 * carrier-account-registry.ts:193-202.
 *
 *   npx tsx scripts/ps-262c-walmart-store-correlation-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  isStoreScopedShippingProvider,
  directCarrierVisibleForScope,
  directCarrierAssignedToClient,
  evaluateDirectCarrierScope,
} from '../src/lib/direct-carrier-scope';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// A walmart_shipping store_account bound to client/store 42.
const walmartAcctStore42 = { provider: 'walmart_shipping', clientId: 42, assignedClientIds: [42] };

// ── 1) walmart_shipping is a store-scoped marketplace provider ──
check('walmart_shipping is store-scoped (never globally shared)',
  isStoreScopedShippingProvider('walmart_shipping'));
check('ebay_shipping is store-scoped too', isStoreScopedShippingProvider('ebay_shipping'));
check('direct ups is NOT store-scoped (sanity)', !isStoreScopedShippingProvider('ups'));

// ── 2) RATE path: the account is visible ONLY for its own store, hidden for another ──
check('rate: walmart_shipping VISIBLE for its matching store (client 42)',
  directCarrierVisibleForScope(walmartAcctStore42, { clientId: 42, storeId: 42 }) === true);
check('rate: walmart_shipping HIDDEN for a DIFFERENT store (client 99) — no cross-store rate',
  directCarrierVisibleForScope(walmartAcctStore42, { clientId: 99, storeId: 99 }) === false);
check('rate: walmart_shipping HIDDEN in the scopeless Browse-Rates view (store-scoped, never global)',
  directCarrierVisibleForScope(walmartAcctStore42, { includeAllDirectCarriers: true }) === false);

// ── 3) the assignment primitive: matching client only ──
check('assignment: walmart account [42] matches client 42',
  directCarrierAssignedToClient(walmartAcctStore42, 42) === true);
check('assignment: walmart account [42] does NOT match client 99',
  directCarrierAssignedToClient(walmartAcctStore42, 99) === false);

// ── 4) the backend scope gate: a wrong-store request is rejected ──
const wrongStore = evaluateDirectCarrierScope(walmartAcctStore42, { clientId: 99, storeId: 99, orderId: 5 });
check('scope gate: wrong-store walmart request is REJECTED',
  wrongStore.allowed === false);
const rightStore = evaluateDirectCarrierScope(walmartAcctStore42, { clientId: 42, storeId: 42, orderId: 5 });
check('scope gate: matching-store walmart request is ALLOWED',
  rightStore.allowed === true);

// ── 5) STATIC: both money-path boundaries re-apply the SAME visibility gate ──
const ratesSrc = readFileSync('src/services/rates.ts', 'utf8');
check('rate path (rates.ts) filters direct/store accounts through directCarrierVisibleForScope',
  ratesSrc.includes('directCarrierVisibleForScope'));

const labelSrc = readFileSync('src/services/labels-direct.ts', 'utf8');
check('label path (labels-direct.ts) re-applies directCarrierVisibleForScope before purchase',
  labelSrc.includes('directCarrierVisibleForScope('));
check('label path throws DIRECT_CARRIER_NOT_ASSIGNED on a cross-store account (blocks purchase)',
  /DIRECT_CARRIER_NOT_ASSIGNED/.test(labelSrc));

// ── 6) STATIC: walmart_shipping is registered store-scoped at the owner ──
const scopeSrc = readFileSync('src/lib/direct-carrier-scope.ts', 'utf8');
check('direct-carrier-scope registers walmart_shipping in STORE_SCOPED_SHIPPING_PROVIDERS',
  /STORE_SCOPED_SHIPPING_PROVIDERS[\s\S]{0,120}'walmart_shipping'/.test(scopeSrc));

if (failures > 0) {
  console.error(`\nFAIL PS-262c Walmart store-correlation guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-262c Walmart store-correlation guard');
