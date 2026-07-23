import type { QueryClient } from '@tanstack/react-query'

import { clientQueryKeys } from './client-query'
import { endpointQueryKeys } from './endpoint-query-keys'

/**
 * PS-458: the single frontend owner for cache families affected by a client
 * create, update, delete, active-state toggle, or store sync.
 *
 * Backend endpoints remain authoritative for the returned data. This helper
 * only tells TanStack Query which frontend snapshots are stale after the
 * mutation succeeds.
 */
export const clientDependentQueryKeys = [
  clientQueryKeys.root,
  endpointQueryKeys.storesRoot,
  endpointQueryKeys.countsRoot,
  endpointQueryKeys.inventoryRoot,
  ['clients-order-stats'] as const,
  ['orders-count'] as const,
  ['v2-hooks:orders'] as const,
  endpointQueryKeys.billingConfigs,
  endpointQueryKeys.billingSummaryRoot,
  ['analysis-sku-breakdown'] as const,
  ['analysis-sku-daily'] as const,
] as const

export function invalidateClientDependentQueries(queryClient: QueryClient): void {
  for (const queryKey of clientDependentQueryKeys) {
    void queryClient.invalidateQueries({ queryKey })
  }
}
