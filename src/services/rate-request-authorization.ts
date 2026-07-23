import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import { orders } from '../db/schema/orders';
import type { ClientStoreScope } from '../lib/client-store-scope';
import { isResourceInScope } from '../lib/scope-predicates';

export type RateRequestScopeInput = {
  orderId?: number | null;
  clientId?: number | null;
  storeId?: number | null;
};

export type RateRequestScopeDecision =
  | { allowed: true; source: 'global' | 'order' | 'raw-context' }
  | { allowed: false; source: 'order-not-found' | 'out-of-scope' | 'missing-context' };

export type RateOrderScopeRow = {
  clientId: number | null;
  storeId: number | null;
};

export type RateOrderScopeLoader = (
  orderId: number,
) => Promise<RateOrderScopeRow | null>;
export type RateOrderScopeBatchLoader = (
  orderIds: number[],
) => Promise<Map<number, RateOrderScopeRow>>;

async function loadRateOrderScope(orderId: number): Promise<RateOrderScopeRow | null> {
  const [row] = await db
    .select({ clientId: orders.clientId, storeId: orders.storeId })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  return row ?? null;
}

async function loadRateOrderScopes(orderIds: number[]): Promise<Map<number, RateOrderScopeRow>> {
  if (!orderIds.length) return new Map();
  const rows = await db
    .select({ id: orders.id, clientId: orders.clientId, storeId: orders.storeId })
    .from(orders)
    .where(inArray(orders.id, orderIds));
  return new Map(rows.map((row) => [row.id, row]));
}

// PS-421 canonical rate-context policy. Raw client/store claims and order ids
// are untrusted until this owner binds them to the authenticated scope. Routes
// call it before rate-cache access, provider work, workflow enqueue, or quote
// authorization. An order-backed request can later mint purchase proof; a raw
// context can only quote/cache within the caller's explicit tenant scope.
export async function authorizeRateRequestScope(
  scope: ClientStoreScope,
  input: RateRequestScopeInput,
  loadOrder: RateOrderScopeLoader = loadRateOrderScope,
): Promise<RateRequestScopeDecision> {
  if (input.orderId != null) {
    const order = await loadOrder(input.orderId);
    if (!order) return { allowed: false, source: 'order-not-found' };
    if (scope.isRestricted && !isResourceInScope(scope, order)) {
      return { allowed: false, source: 'out-of-scope' };
    }
    if (
      (input.clientId != null && input.clientId !== order.clientId) ||
      (input.storeId != null && input.storeId !== order.storeId)
    ) {
      return { allowed: false, source: 'out-of-scope' };
    }
    return {
      allowed: true,
      source: scope.isRestricted ? 'order' : 'global',
    };
  }

  if (!scope.isRestricted) return { allowed: true, source: 'global' };

  if (input.clientId == null && input.storeId == null) {
    return { allowed: false, source: 'missing-context' };
  }

  const clientAllowed =
    input.clientId == null ||
    isResourceInScope(scope, { clientId: input.clientId, storeId: null });
  const storeAllowed =
    input.storeId == null ||
    isResourceInScope(scope, { clientId: null, storeId: input.storeId });
  return clientAllowed && storeAllowed
    ? { allowed: true, source: 'raw-context' }
    : { allowed: false, source: 'out-of-scope' };
}

export async function authorizeRateRequestScopes(
  scope: ClientStoreScope,
  inputs: RateRequestScopeInput[],
  loadOrders: RateOrderScopeBatchLoader = loadRateOrderScopes,
): Promise<RateRequestScopeDecision> {
  const orderIds = [
    ...new Set(
      inputs
        .map((input) => input.orderId)
        .filter((id): id is number => id != null),
    ),
  ];
  const ordersById = await loadOrders(orderIds);
  for (const input of inputs) {
    const decision = await authorizeRateRequestScope(
      scope,
      input,
      async (orderId) => ordersById.get(orderId) ?? null,
    );
    if (!decision.allowed) return decision;
  }
  return {
    allowed: true,
    source: scope.isRestricted
      ? orderIds.length ? 'order' : 'raw-context'
      : 'global',
  };
}
