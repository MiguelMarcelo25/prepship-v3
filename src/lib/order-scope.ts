// PS-250 (Card 5): shared owner of "which orders may this caller touch" for routes that
// load/persist by orderId. routes/rates.ts had NO scope check, so /rates/browse could
// read/persist against ANY tenant's order (cross-tenant IDOR) — it now delegates here.
// NOTE: routes/orders.ts keeps its own LOCAL copies of the same logic on purpose — they
// are pinned, assertion-by-assertion, by scripts/orders-manifests-client-store-scope-guard.mjs
// (a frozen security surface), so they are deliberately not collapsed into this owner.
import type { Context } from 'hono';
import { inArray, or, sql, type SQL } from 'drizzle-orm';
import { getClientStoreScope, type ClientStoreScope } from './client-store-scope';
import { orders } from '../db/schema/orders';

/** Build the caller's client/store scope from the request context (set by the auth middleware). */
export function scopeFromContext(c: Context): ClientStoreScope {
  return getClientStoreScope({
    email: c.get('email' as never) as string | undefined,
    role: c.get('role' as never) as string | undefined,
    permissions: c.get('permissions' as never) as string[] | undefined,
    clientIds: c.get('clientIds' as never) as number[] | undefined,
    storeIds: c.get('storeIds' as never) as number[] | undefined,
  });
}

/**
 * WHERE predicate restricting the `orders` table to the caller's scope.
 * undefined = unrestricted (admin/global, no filter); sql`false` = restricted but
 * empty scope (matches nothing). AND this into an order load so an out-of-scope
 * orderId resolves to zero rows (→ the caller 404s rather than reading another tenant).
 */
export function orderScopePredicate(scope: ClientStoreScope): SQL | undefined {
  if (!scope.isRestricted) return undefined;
  const predicates: SQL[] = [];
  if (scope.clientIds.length > 0) predicates.push(inArray(orders.clientId, scope.clientIds));
  if (scope.storeIds.length > 0) predicates.push(inArray(orders.storeId, scope.storeIds));
  if (!predicates.length) return sql`false`;
  return predicates.length === 1 ? predicates[0] : (or(...predicates) ?? sql`false`);
}

/** In-memory equivalent: is an already-loaded order row within the caller's scope? */
export function isOrderRowInScope(
  row: { clientId: number | null; storeId: number | null },
  scope: ClientStoreScope,
): boolean {
  if (!scope.isRestricted) return true;
  if (row.clientId != null && scope.clientIds.includes(row.clientId)) return true;
  if (row.storeId != null && scope.storeIds.includes(row.storeId)) return true;
  return false;
}
