// PS-166/PS-306/PS-258: pure filter/sort derivation memos extracted VERBATIM
// from OrdersView.tsx (was ~lines 1358–1419). This hook owns NO state, refs, or
// effects and never reads `isReadOnly` — it is a pure derivation over its inputs
// and the already-extracted pure helpers below. Behavior-identical move: the
// four useMemo bodies and their dependency arrays are unchanged.
import { useMemo } from 'react'
import { groupOrdersBySku } from '../orders-grouping'
import { computeOrderedFilteredOrders } from '../orders-filtered-sort'
import { getSortValue } from '../orders-table-columns'
import {
  buildSearchText,
  getActiveItems,
  getOrderSortTimeMs,
  getPrimarySkuLabel,
  getTotalQuantity,
  isEbayOrder,
  isTestOrder,
} from '../orders-items'

// `params` is typed `any` because the source memos lived in the type-unchecked
// OrdersView shell where these closures were untyped; this is a verbatim move,
// not a re-typing. Output identifiers are unchanged.
export function useOrdersFilterSort(params: any) {
  const {
    orders,
    orderDetailsById,
    hideTestOrdersInAllAwaiting,
    searchQuery,
    skuFilter,
    skuSortActive,
    preSkuSortSnapshot,
    sortState,
    shippingAccounts,
  } = params

  const searchedOrders = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    const skuNeedle = skuFilter.trim().toLowerCase()
    return orders.filter((order: any) => {
      const detail = orderDetailsById.get(order.orderId) ?? null
      if (hideTestOrdersInAllAwaiting && isTestOrder(order, detail)) return false
      if (query && !buildSearchText(order, detail).includes(query)) return false
      // SKU filter — primary work happens SERVER-SIDE via useOrders.
      // The client-side check was previously REJECTING server-confirmed
      // matches because of subtle string differences between what the
      // dropdown captured (from /distinct-skus) and what's in
      // order.items[].sku in the list payload (different jsonb
      // serialization paths). User saw '1,653 total' in pagination
      // but 'No orders match' in the table.
      //
      // Two-rail safer behavior:
      //   1. Trust the backend by default — if the order is in the
      //      response, assume it matches. (Previously this filter was
      //      a strict gate; now it's a soft cross-check.)
      //   2. ONLY reject if we have non-empty local items AND we're
      //      certain none match (normalized compare). Empty / missing
      //      items array → keep the order (the backend already
      //      verified the SKU server-side via SQL).
      if (skuNeedle) {
        const items = getActiveItems(order, detail)
        if (items.length > 0) {
          const hit = items.some((item) =>
            (item.sku ?? '').trim().toLowerCase() === skuNeedle
          )
          if (!hit) return false
        }
        // items missing/empty → trust backend, don't reject
      }
      return true
    })
  }, [orders, orderDetailsById, hideTestOrdersInAllAwaiting, searchQuery, skuFilter])

  const orderedFilteredOrders = useMemo(
    () => computeOrderedFilteredOrders(
      { searchedOrders, skuSortActive, preSkuSortSnapshot, sortState, orderDetailsById, shippingAccounts },
      { getActiveItems, getOrderSortTimeMs, isEbayOrder, getSortValue },
    ),
    [searchedOrders, skuSortActive, preSkuSortSnapshot, sortState, orderDetailsById, shippingAccounts],
  )
  const skuOrderGroups = useMemo(
    () => (
      skuSortActive
        ? groupOrdersBySku(
          orderedFilteredOrders,
          (order) => getPrimarySkuLabel(order, orderDetailsById.get(order.orderId) ?? null),
          (order) => getTotalQuantity(order, orderDetailsById.get(order.orderId) ?? null),
          (order) => getActiveItems(order, orderDetailsById.get(order.orderId) ?? null),
          (order) => isEbayOrder(order),
        )
        : []
    ),
    [orderedFilteredOrders, orderDetailsById, skuSortActive],
  )
  const visibleOrderIds = useMemo(
    () => orderedFilteredOrders.map((order) => order.orderId),
    [orderedFilteredOrders],
  )

  return { searchedOrders, orderedFilteredOrders, skuOrderGroups, visibleOrderIds }
}
