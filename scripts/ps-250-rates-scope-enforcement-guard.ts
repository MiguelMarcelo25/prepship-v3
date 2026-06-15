/**
 * PS-250 (Card 5) guard — the rate routes enforce client/store scope (no cross-tenant IDOR)
 * and the destructive/global cache endpoints are admin-gated.
 *
 * BEHAVIORAL: imports + runs the shared order-scope owner (scopeFromContext / orderScopePredicate
 * / isOrderRowInScope) to prove restricted callers are fenced and admin/global is unrestricted.
 * STATIC: /browse 404s an out-of-scope orderId before any read/persist; DELETE /cache,
 * /cache-clear-and-refetch, /backfill-best require scope:global; orders.ts delegates to the owner.
 *
 *   npx tsx scripts/ps-250-rates-scope-enforcement-guard.ts
 */
import { readFileSync } from 'node:fs';
import type { Context } from 'hono';
import {
  scopeFromContext,
  orderScopePredicate,
  isOrderRowInScope,
} from '../src/lib/order-scope';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const ctx = (vars: Record<string, unknown>): Context =>
  ({ get: (k: string) => vars[k] } as unknown as Context);

// ── 1. scopeFromContext: restricted vs unrestricted callers ──────────────────────────────────
check('client_user with a clientId is RESTRICTED',
  scopeFromContext(ctx({ role: 'client_user', clientIds: [11] })).isRestricted === true);
check('admin role is UNRESTRICTED (global)',
  scopeFromContext(ctx({ role: 'admin' })).isRestricted === false);

// ── 2. orderScopePredicate: undefined (no filter) only when unrestricted ──────────────────────
check('unrestricted scope -> undefined predicate (no WHERE filter)',
  orderScopePredicate(scopeFromContext(ctx({ role: 'admin' }))) === undefined);
check('restricted scope -> a real predicate (orders are filtered)',
  orderScopePredicate(scopeFromContext(ctx({ role: 'client_user', clientIds: [11] }))) !== undefined);

// ── 3. isOrderRowInScope: a restricted caller is fenced to its own client/store ───────────────
const restricted = scopeFromContext(ctx({ role: 'client_user', clientIds: [11], storeIds: [376661] }));
check('own client (11) in scope', isOrderRowInScope({ clientId: 11, storeId: null }, restricted) === true);
check('other client (22) OUT of scope', isOrderRowInScope({ clientId: 22, storeId: null }, restricted) === false);
check('own store (376661) in scope', isOrderRowInScope({ clientId: null, storeId: 376661 }, restricted) === true);
check('other store (999) OUT of scope', isOrderRowInScope({ clientId: null, storeId: 999 }, restricted) === false);
check('unrestricted caller sees any order',
  isOrderRowInScope({ clientId: 22, storeId: 999 }, scopeFromContext(ctx({ role: 'admin' }))) === true);

// ── 4. STATIC: /browse fences an out-of-scope orderId before read/persist ─────────────────────
const rates = readFileSync('src/routes/rates.ts', 'utf8');
check('rates.ts imports the shared scope owner',
  /from '\.\.\/lib\/order-scope'/.test(rates) &&
    /scopeFromContext/.test(rates) && /orderScopePredicate/.test(rates));
check('/browse scopes the orderId load + 404s out-of-scope',
  /const browseScope = scopeFromContext\(c\);/.test(rates) &&
    /orderScopePredicate\(browseScope\)/.test(rates) &&
    /if \(!inScope\) return c\.json\(\{ error: 'Order not found' \}, 404\);/.test(rates));

// ── 5. STATIC: the global/destructive endpoints are admin-gated (scope:global) ────────────────
check("DELETE /cache requires scope:global",
  /app\.delete\('\/cache', requireInternalPermission\('scope:global'\)/.test(rates));
check("POST /cache-clear-and-refetch requires scope:global",
  /app\.post\('\/cache-clear-and-refetch', requireInternalPermission\('scope:global'\)/.test(rates));
check("POST /backfill-best requires scope:global",
  /'\/backfill-best',\s*\n\s*\/\/[^\n]*\n\s*requireInternalPermission\('scope:global'\)/.test(rates));

// ── 6. STATIC: orders.ts still enforces scope (its local copies are guard-frozen, left intact) ─
const ordersRoute = readFileSync('src/routes/orders.ts', 'utf8');
check('orders.ts still applies orderScopePredicate on its order loads (unchanged enforcement)',
  /orderScopePredicate\(detailScope\)/.test(ordersRoute) && /ordersScopeFromContext\(c\)/.test(ordersRoute));

check('package.json wires test:ps-250-rates-scope-enforcement',
  /test:ps-250-rates-scope-enforcement/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-250 rates scope-enforcement guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-250 rates scope-enforcement guard');
