/**
 * PS-121 guard — Auto-Recalculate Same SKU+qty Group Rates After Explicit Default Save.
 *
 * Read-only static guard (+ pure combo-key behavior): no DB, no network, no order mutation,
 * no postage/label/marketplace calls.
 *
 * Proves the architecture-first contract:
 *   1. A backend-owned TARGETED recalc primitive exists (enqueueBackfillBestRatesForOrderIds) and
 *      keeps the awaiting_shipment lockdown filter + restricts to the given order ids (inArray).
 *   2. Both default-save owners (combo + single-SKU) INVALIDATE stale best rates (bestRateJson/
 *      bestRateAt/bestRateDims -> null) ONLY when recalcGroup is set, stamp PS-120 `pending`, and
 *      return affectedOrderIds.
 *   3. Both routes accept the explicit `recalcGroup` flag and trigger the targeted recalc only
 *      when it is true.
 *   4. The FE fires the group recalc ONLY from the explicit "Save weights & dims as SKU defaults"
 *      (saveSkuDefaults) — never from the silent autosave path.
 *   5. Exact SKU+qty scoping (pure computeComboKey): same combo -> same key; different qty ->
 *      different key. Client scope is enforced by the clientId filter in each owner.
 *
 *   npx tsx scripts/ps-121-group-rate-recalc-guard.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeComboKey } from '../src/lib/package-combo';

const backfill = readFileSync('src/services/rates-backfill.ts', 'utf8');
const combo = readFileSync('src/services/combo-package-defaults.ts', 'utf8');
const products = readFileSync('src/routes/products.ts', 'utf8');
const ordersRoute = readFileSync('src/routes/orders.ts', 'utf8');
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
const apiClient = readFileSync('web/src/lib/v2-apiClient.ts', 'utf8');

// ── 1. Targeted recalc primitive (backend-owned, lockdown-safe) ───────────────
assert.match(
  backfill,
  /export async function enqueueBackfillBestRatesForOrderIds\(/,
  'a backend-owned targeted recalc primitive must exist',
);
assert.match(
  backfill,
  /inArray\(orders\.id,\s*targetedIds\)/,
  'targeted recalc must restrict to the given order ids via inArray(orders.id, …)',
);
assert.match(
  backfill,
  /eq\(orders\.orderStatus,\s*'awaiting_shipment'\)/,
  'targeted recalc must KEEP the awaiting_shipment lockdown filter (never re-rate shipped/cancelled)',
);

// ── 2. Both owners: gated invalidation + pending stamp + affectedOrderIds ──────
for (const [name, src] of [['combo', combo], ['single-SKU', products]] as const) {
  assert.match(
    src,
    /bestRateJson:\s*null[\s\S]*bestRateAt:\s*null[\s\S]*bestRateDims:\s*null/,
    `${name} owner must invalidate stale best rate (bestRateJson/bestRateAt/bestRateDims -> null)`,
  );
  // The invalidation is GATED on recalcGroup + an actual change + an existing saved rate.
  assert.match(
    src,
    /recalcGroup[\s\S]*curBestRateAt\s*!=\s*null[\s\S]*dimsOrPackageChanged|dimsOrPackageChanged[\s\S]*curBestRateAt\s*!=\s*null/,
    `${name} owner must only invalidate when recalcGroup + the rate exists + dims/weight/package changed`,
  );
  assert.match(
    src,
    /setOrderRatePending\(/,
    `${name} owner must stamp PS-120 pending on the invalidated siblings`,
  );
  assert.match(
    src,
    /affectedOrderIds/,
    `${name} owner must return the affected order ids for the targeted recalc`,
  );
}

// ── 3. Routes accept recalcGroup + trigger targeted recalc only when true ──────
assert.match(
  ordersRoute,
  /recalcGroup:\s*z\.boolean\(\)\.optional\(\)/,
  'combo route must accept an explicit recalcGroup flag',
);
assert.match(
  products,
  /recalcGroup:\s*z\.boolean\(\)\.optional\(\)/,
  'single-SKU route must accept an explicit recalcGroup flag',
);
for (const [name, src] of [['combo', ordersRoute], ['single-SKU', products]] as const) {
  assert.match(
    src,
    /recalcGroup === true[\s\S]*enqueueBackfillBestRatesForOrderIds\(/,
    `${name} route must kick the targeted recalc ONLY when recalcGroup is true`,
  );
}

// ── 4. FE: explicit-save-only trigger (never the silent autosave) ─────────────
// saveSkuDefaults (explicit button) sets recalcGroup: true on both branches.
const saveSkuStart = ordersView.indexOf('async function saveSkuDefaults(');
const saveSkuEnd = ordersView.indexOf('\n  function getRateCarrierIdsForAccounts', saveSkuStart);
const saveSkuBody = saveSkuStart >= 0 ? ordersView.slice(saveSkuStart, saveSkuEnd > saveSkuStart ? saveSkuEnd : undefined) : '';
assert.ok(saveSkuBody.length > 0, 'saveSkuDefaults handler must exist');
assert.match(saveSkuBody, /recalcGroup:\s*true/, 'explicit saveSkuDefaults must set recalcGroup: true');

// The silent autosave path must NOT set recalcGroup.
const autoSaveStart = ordersView.indexOf('async function autoSavePanelSkuDefaults(');
const autoSaveEnd = ordersView.indexOf('\n  async function ensurePanelPackageForDims', autoSaveStart);
const autoSaveBody = autoSaveStart >= 0 ? ordersView.slice(autoSaveStart, autoSaveEnd > autoSaveStart ? autoSaveEnd : undefined) : '';
assert.ok(autoSaveBody.length > 0, 'autoSavePanelSkuDefaults handler must exist');
assert.doesNotMatch(autoSaveBody, /recalcGroup/, 'silent autosave must NEVER trigger the group recalc');

// apiClient threads recalcGroup through to the combo body.
assert.match(apiClient, /recalcGroup\?\s*:\s*boolean/, 'apiClient saveComboPackageDefault must accept recalcGroup');
assert.match(apiClient, /input\.recalcGroup\s*\?\s*\{\s*recalcGroup:\s*true\s*\}/, 'apiClient must forward recalcGroup to the combo save body');

// ── 5. Exact SKU+qty scoping (pure computeComboKey) ──────────────────────────
const A = computeComboKey([{ sku: 'Booster-gel-001', quantity: 2 }, { sku: 'HU-10', quantity: 1 }]);
const A2 = computeComboKey([{ sku: 'HU-10', quantity: 1 }, { sku: 'booster-gel-001', quantity: 2 }]); // order/case-insensitive
const B = computeComboKey([{ sku: 'Booster-gel-001', quantity: 1 }, { sku: 'HU-10', quantity: 1 }]); // different qty
assert.equal(A, A2, 'same SKU+qty combo must normalize to the same key (order/case-insensitive)');
assert.notEqual(A, B, 'a different quantity must produce a different combo key (no cross-qty match)');

console.log('PASS PS-121 group-rate-recalc guard');
