// PS-312/PS-317 (S4 slice 1) — scope-safe owner for the bundle read-model exposure. Given the order
// ids the caller asked about + the caller's client/store scope, drop any order outside that scope
// BEFORE the read-model sees it, then resolve the rest to their bundle DTOs. A bundle's members all
// share one client/store by construction (createBundle), so an in-scope member implies the whole
// bundle is visible — no cross-client leak. Read-only. The route stays thin (resolve scope → call
// this → return the DTOs); the scope enforcement lives here under a pglite guard.
import { and, inArray, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { orders } from '../../db/schema/orders.js';
import type { ClientStoreScope } from '../../lib/client-store-scope.js';
import { getBundlesForOrders, type BundleRowDto } from './bundle-read-model.js';
import { createBundle, type CreateBundleResult } from './create-bundle.js';

/** Thrown when a caller tries to bundle an order outside their client/store scope. */
export class BundleScopeError extends Error {
  constructor(public readonly outOfScopeOrderIds: number[]) {
    super(`orders not in your scope: ${outOfScopeOrderIds.join(', ')}`);
    this.name = 'BundleScopeError';
  }
}

/** The same client/store scope predicate the orders list endpoint uses, over the orders table. */
function orderScopePredicate(scope: ClientStoreScope): SQL | undefined {
  if (!scope.isRestricted) return undefined;
  const predicates: SQL[] = [];
  if (scope.clientIds.length > 0) predicates.push(inArray(orders.clientId, scope.clientIds));
  if (scope.storeIds.length > 0) predicates.push(inArray(orders.storeId, scope.storeIds));
  if (predicates.length === 0) return sql`false`;
  return predicates.length === 1 ? predicates[0] : (or(...predicates) ?? sql`false`);
}

export async function resolveScopedBundles(
  orderIds: number[],
  scope: ClientStoreScope,
  conn: typeof db = db,
): Promise<Map<number, BundleRowDto>> {
  if (orderIds.length === 0) return new Map();
  const predicate = orderScopePredicate(scope);
  const scopedRows = await conn
    .select({ id: orders.id })
    .from(orders)
    .where(predicate ? and(inArray(orders.id, orderIds), predicate) : inArray(orders.id, orderIds));
  const inScopeIds = scopedRows.map((row) => row.id);
  return getBundlesForOrders(inScopeIds, conn);
}

/**
 * Create a bundle on behalf of a scoped caller. CREATE requires FULL access to every order — unlike
 * read (which silently drops out-of-scope ids), creating a bundle that touched an order the caller
 * can't see would be a privilege violation, so we REJECT (BundleScopeError) instead of dropping.
 * Eligibility (>=2 awaiting same-recipient orders, none already bundled) + the membership invariants
 * are enforced by the underlying createBundle.
 */
export async function createScopedBundle(
  orderIds: number[],
  primaryOrderId: number | null,
  scope: ClientStoreScope,
  resolvedBy: string | null,
  conn: typeof db = db,
): Promise<CreateBundleResult> {
  const predicate = orderScopePredicate(scope);
  const accessibleRows = await conn
    .select({ id: orders.id })
    .from(orders)
    .where(predicate ? and(inArray(orders.id, orderIds), predicate) : inArray(orders.id, orderIds));
  const accessible = new Set(accessibleRows.map((row) => row.id));
  const outOfScope = orderIds.filter((id) => !accessible.has(id));
  if (outOfScope.length > 0) throw new BundleScopeError(outOfScope);
  return createBundle(orderIds, resolvedBy, primaryOrderId, conn);
}
