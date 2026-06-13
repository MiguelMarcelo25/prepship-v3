// PS-233 / PS-240 (Per user override unlock shipped data on 2026-06-13): one
// shared in-memory caller-scope check for resources already loaded from the DB.
// Routes/services load the order or shipment, then call assertResourceInScope so a
// restricted principal (client_user / read_only_support) can only act on rows in
// its clientIds/storeIds. This is the service-layer companion to the SQL-side
// `orderScopePredicate` (orders.ts) and `manifestClientScopePredicate`
// (manifests.ts) — same rule, applied where the row is already in hand.
import type { ClientStoreScope } from './client-store-scope';

export type ScopedResource = {
  clientId?: number | null;
  storeId?: number | null;
};

/**
 * True when the caller's scope may access the resource. A global (unrestricted)
 * scope always passes; a restricted scope passes only when the resource's
 * clientId is in scope.clientIds OR its storeId is in scope.storeIds.
 */
export function isResourceInScope(
  scope: ClientStoreScope,
  resource: ScopedResource,
): boolean {
  if (!scope.isRestricted) return true;
  const clientId = resource.clientId == null ? null : Number(resource.clientId);
  if (clientId != null && scope.clientIds.includes(clientId)) return true;
  const storeId = resource.storeId == null ? null : Number(resource.storeId);
  if (storeId != null && scope.storeIds.includes(storeId)) return true;
  return false;
}

/**
 * Thrown when a resource is outside the caller's scope. The default message is a
 * not-found-style string on purpose so route handlers map it to 404 and never
 * leak the existence of another tenant's record.
 */
export class ResourceScopeError extends Error {
  readonly code = 'RESOURCE_OUT_OF_SCOPE';
  constructor(message = 'Resource not found') {
    super(message);
    this.name = 'ResourceScopeError';
  }
}

/**
 * No-op for a global scope; throws ResourceScopeError (404-style message) when the
 * resource is outside a restricted caller's scope.
 */
export function assertResourceInScope(
  scope: ClientStoreScope,
  resource: ScopedResource,
  notFoundMessage = 'Resource not found',
): void {
  if (!isResourceInScope(scope, resource)) {
    throw new ResourceScopeError(notFoundMessage);
  }
}
