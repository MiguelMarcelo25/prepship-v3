/**
 * Guard: saving a single-SKU weight/dims default only affects orders with the
 * SAME sku + qty.
 *
 * Previously POST /products/save-defaults push-applied the saved box dimensions
 * to EVERY awaiting single-SKU order with that SKU regardless of qty, so saving
 * a 1-pack default overwrote a 2-pack order's (larger) box. The save now carries
 * the source order's qty (appliesToQty) and the push skips orders whose qty
 * differs, so a different qty is never changed.
 *
 * BEHAVIORAL (PS-259 / Card 14): the save-defaults push fans out across the
 * caller's visible orders, so the catalog-scope owner that decides which clients
 * a caller may touch is part of this gate. This guard imports + RUNS that owner
 * (src/lib/client-store-scope) and asserts the cross-tenant verdict directly: a
 * restricted client_user is denied an out-of-scope client, while a global/admin
 * scope passes. These assertions FAIL if the scope enforcement is deleted or
 * broken — they are not substring scans.
 * STATIC: the qty-scope route/source checks below are kept unchanged.
 *
 *   npx tsx scripts/single-sku-default-qty-scope-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  getClientStoreScope,
  isClientVisibleToScope,
} from '../src/lib/client-store-scope';

const route = readFileSync('src/routes/products.ts', 'utf8');
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');

let failures = 0;
function check(name: string, condition: boolean) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// ── BEHAVIORAL: run the real catalog/order-scope owner ─────────────────────────
// A portal client_user fenced to client 11 must NOT be treated as global, and a
// save-defaults push must never reach an out-of-scope client's orders.
const restricted = getClientStoreScope({ role: 'client_user', clientIds: [11], storeIds: [376661] });
check('client_user with a clientId is RESTRICTED (not global)',
  restricted.isRestricted === true && restricted.isGlobal === false);
check('restricted caller CAN touch its own client (11)',
  isClientVisibleToScope({ id: 11 }, restricted) === true);
check('restricted caller CANNOT touch an out-of-scope client (22)',
  isClientVisibleToScope({ id: 22 }, restricted) === false);
check('restricted caller reaches a client via an in-scope store (376661)',
  isClientVisibleToScope({ id: 99, storeIds: [376661] }, restricted) === true);
check('restricted caller blocked from a client whose stores are all out-of-scope',
  isClientVisibleToScope({ id: 99, storeIds: [999] }, restricted) === false);

// read_only_support is restricted-by-role even with no explicit ids (deny by default).
const roSupport = getClientStoreScope({ role: 'read_only_support' });
check('read_only_support is RESTRICTED by role even with no ids',
  roSupport.isRestricted === true && roSupport.isGlobal === false);
check('read_only_support (no ids) sees no client',
  isClientVisibleToScope({ id: 11 }, roSupport) === false);

// admin / scope:global is unrestricted — a fan-out across all clients is allowed.
const adminScope = getClientStoreScope({ role: 'admin' });
const globalPerm = getClientStoreScope({ role: 'client_user', permissions: ['scope:global'] });
check('admin role is GLOBAL (unrestricted)',
  adminScope.isGlobal === true && adminScope.isRestricted === false);
check('admin sees any client (no fence)',
  isClientVisibleToScope({ id: 22 }, adminScope) === true);
check('scope:global permission overrides client_user role into global',
  globalPerm.isGlobal === true && isClientVisibleToScope({ id: 22 }, globalPerm) === true);

// Backend accepts the source qty.
check(
  'save-defaults body accepts appliesToQty',
  /appliesToQty: z\.number\(\)\.int\(\)\.positive\(\)\.optional\(\)/.test(route),
);
check(
  'push function takes an appliesToQty scope',
  /appliesToQty\?: number \| null;/.test(route),
);
// The push skips orders whose qty differs from the saving order's qty.
check(
  'push skips orders whose qty != appliesToQty',
  /if \(input\.appliesToQty != null && qty !== input\.appliesToQty\) continue;/.test(route),
);
check(
  'qty scope is wired into the push call',
  /applySingleSkuDefaultsToMatchingMutableOrders\(\{[\s\S]*?appliesToQty: v\.appliesToQty \?\? null,[\s\S]*?\}\)/.test(route),
);
// appliesToQty must not be inserted as a products column.
check(
  'appliesToQty is excluded from the products upsert values',
  /const \{ clientId: inventoryClientId, appliesToQty: _appliesToQty, \.\.\.productValues \} = v;/.test(route),
);

// Frontend sends the source order's qty.
check(
  'savePanelSkuDefaults sends appliesToQty: target.qty',
  /appliesToQty: target\.qty,/.test(ordersView),
);

if (failures > 0) {
  console.error(`\nFAIL single-SKU default qty-scope guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS single-SKU default qty-scope guard');
