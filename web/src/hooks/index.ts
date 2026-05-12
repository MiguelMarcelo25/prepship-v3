// Hooks barrel — re-exports everything the bulk-ported v2 components expect.
// Primary shim (transforms v4 responses to v2 shape) lives in v2Hooks.ts.
// Individual v2 hook files are re-exported as-is (they use apiClient adapter).

export {
  useOrders,
  useOrderDetail,
  useLocations,
  useShippingAccounts,
  useClients,
  useAllClients,
  useInventory,
  usePackages,
  type UseOrdersOptions,
  type UseOrdersResult,
  type UseOrderDetailResult,
  type UseLocationsResult,
  type LocationDto,
  type UseShippingAccountsResult,
  type CarrierAccountDto,
  type OrderSummaryDto,
  type OrderFullDto,
  type UseClientsResult,
  type ClientDto,
  type UseInventoryOptions,
  type UseInventoryResult,
  type InventoryItemDto,
  type UsePackagesResult,
  type PackageDto,
} from './v2Hooks';

// v2 hook files (bulk-copied) — these use v2's apiClient adapter shape.
// If a name conflicts with v2Hooks above, v2Hooks wins (ours is the transform).
export { useAutoPolling } from './useAutoPolling';
export { useInitStores } from './useInitStores';
export { useKeyboardShortcuts } from './useKeyboardShortcuts';
export { useOrdersWithDetails } from './useOrdersWithDetails';
export { useShippedOrdersCache } from './useShippedOrdersCache';
export { useStoreOrders } from './useStoreOrders';
export { useStores } from './useStores';
export { useSyncPoller } from './useSyncPoller';
// useRates was deleted in commit 04f8216 — it was orphan code that hit
// /api/rates without auth and used v2's outdated payload shape. v4 callers
// should use apiClient.fetchRates() instead (same endpoint, authed, with
// the v2↔v4 shape translation baked in).
