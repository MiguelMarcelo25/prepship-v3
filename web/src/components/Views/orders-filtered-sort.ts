/**
 * PS-258 / PS-166 — pure owner of the Awaiting orders ORDER/sort computation that the
 * OrdersView `orderedFilteredOrders` useMemo derives.
 *
 * Lifted VERBATIM out of the 9.7k-line OrdersView component (behavior-preserving) so the
 * sort logic has a single, testable home and the monolith shrinks. No React, no state,
 * no IO.
 *
 * The per-order accessors (getActiveItems / getOrderSortTimeMs / isEbayOrder / getSortValue)
 * live in sibling modules that transitively import the Vite-only api-base (import.meta.env),
 * so they are INJECTED via `deps` rather than imported here — that keeps this module a leaf
 * the offline guard can unit-test without a Vite build context. buildSkuCompositionKey is a
 * true leaf (no imports) and stays a direct import.
 *
 * Three branches, identical to the original:
 *   1. SKU-sort active   → group-key sort, then newest-first, then orderId.
 *   2. pre-SKU snapshot  → restore the pre-sort order via a rank map.
 *   3. default           → sort by the active column (getSortValue) + direction.
 */
import { buildSkuCompositionKey } from './orders-grouping';

export interface OrderedFilteredSortInput {
  /** Orders after search/filter (the list the original spread `[...searchedOrders]`). */
  searchedOrders: any[];
  skuSortActive: boolean;
  preSkuSortSnapshot: number[] | null;
  sortState: { key: string; dir: string };
  orderDetailsById: Map<number, any>;
  shippingAccounts: any;
}

export interface OrderedFilteredSortDeps {
  getActiveItems: (order: any, detail: any) => any;
  getOrderSortTimeMs: (order: any) => number;
  isEbayOrder: (order: any) => boolean;
  // key is `any` so the real getSortValue (whose key is the narrower SortKey union) is
  // assignable here (function-param contravariance); the caller passes sortState.key.
  getSortValue: (order: any, detail: any, key: any, shippingAccounts: any) => any;
}

export function computeOrderedFilteredOrders(input: OrderedFilteredSortInput, deps: OrderedFilteredSortDeps): any[] {
  const { searchedOrders, skuSortActive, preSkuSortSnapshot, sortState, orderDetailsById, shippingAccounts } = input;
  const { getActiveItems, getOrderSortTimeMs, isEbayOrder, getSortValue } = deps;
  const next = [...searchedOrders];

  if (skuSortActive) {
    next.sort((left, right) => {
      const leftDetail = orderDetailsById.get(left.orderId) ?? null;
      const rightDetail = orderDetailsById.get(right.orderId) ?? null;
      const leftKey = buildSkuCompositionKey(getActiveItems(left, leftDetail), { titleFallback: isEbayOrder(left) }).key;
      const rightKey = buildSkuCompositionKey(getActiveItems(right, rightDetail), { titleFallback: isEbayOrder(right) }).key;
      if (leftKey < rightKey) return -1;
      if (leftKey > rightKey) return 1;
      const dateDelta = getOrderSortTimeMs(right) - getOrderSortTimeMs(left);
      if (dateDelta !== 0) return dateDelta;
      return (right.orderId ?? 0) - (left.orderId ?? 0);
    });
    return next;
  }

  if (preSkuSortSnapshot) {
    const rank = new Map(preSkuSortSnapshot.map((orderId, index) => [orderId, index]));
    next.sort((left, right) => {
      return (rank.get(left.orderId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.orderId) ?? Number.MAX_SAFE_INTEGER);
    });
    return next;
  }

  next.sort((left, right) => {
    const leftDetail = orderDetailsById.get(left.orderId) ?? null;
    const rightDetail = orderDetailsById.get(right.orderId) ?? null;
    const leftValue = getSortValue(left, leftDetail, sortState.key, shippingAccounts);
    const rightValue = getSortValue(right, rightDetail, sortState.key, shippingAccounts);
    const direction = sortState.dir === 'asc' ? 1 : -1;
    if (leftValue < rightValue) return -direction;
    if (leftValue > rightValue) return direction;
    return 0;
  });

  return next;
}
