/**
 * v2 hook shims — React Query-backed.
 *
 * Mirror the runtime shape of v2's hooks at
 * `apps/react/src/hooks/{useOrders,useOrderDetail,useLocations,useShippingAccounts}.ts`
 * so the wholesale OrdersView.tsx port compiles and runs against v4's API
 * without edits at the call sites. DTOs are kept loose (`any`) because
 * v2's types aren't available in this project; structural access from
 * the ported view is preserved.
 *
 * PS-157: the eight hooks that used to live in this file were split into
 * per-domain modules (useOrders/useOrderDetail/useLocations/
 * useShippingAccounts/useClients/useAllClients/useInventory/usePackages),
 * with cross-cutting helpers/types in ./v2Hooks-shared. This file is now a
 * thin BARREL that re-exports all of them so existing
 * `from '../hooks/v2Hooks'` imports keep working byte-unchanged. Behavior
 * identical; this is a pure re-export.
 */

export { useOrders } from './useOrders';
export type { UseOrdersOptions, UseOrdersResult } from './useOrders';

export { useOrderDetail } from './useOrderDetail';
export type { UseOrderDetailResult } from './useOrderDetail';

export { useLocations } from './useLocations';
export type { LocationDto, UseLocationsResult } from './useLocations';

export { useShippingAccounts } from './useShippingAccounts';
export type { CarrierAccountDto, UseShippingAccountsResult } from './useShippingAccounts';

export { useClients } from './useClients';
export { useAllClients } from './useAllClients';
export type { ClientDto, UseClientsResult } from './v2Hooks-shared';

export { useInventory } from './useInventory';
export type { InventoryItemDto, UseInventoryOptions, UseInventoryResult } from './useInventory';

export { usePackages } from './usePackages';
export type { PackageDto, UsePackagesResult } from './usePackages';

// Loose DTOs — property access flows as `any`. Live in ./v2Hooks-shared so
// useOrders/useOrderDetail can consume them without importing each other;
// re-exported here to preserve the original v2Hooks export surface.
export type { OrderSummaryDto, OrderFullDto } from './v2Hooks-shared';
