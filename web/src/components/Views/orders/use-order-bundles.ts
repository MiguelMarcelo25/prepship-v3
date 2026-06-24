import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'

// PS-312/PS-317 (S4) — FE shape of the backend combined-shipment read-model DTO. The frontend renders
// these fields verbatim; it never derives bundle membership or shared facts itself.
export type OrderBundleDto = {
  bundleId: number
  role: 'primary' | 'child'
  status: string
  primaryOrderId: number
  memberOrderIds: number[]
  memberCount: number
  trackingNumber: string | null
  carrierCode: string | null
  serviceCode: string | null
  labelUrl: string | null
  labelShipmentId: string | null
  packageId: number | null
  primaryShipmentId: number | null
}

const EMPTY_BUNDLES: Map<number, OrderBundleDto> = new Map()

/**
 * Fetch the combined-shipment bundle state for the given orders from the scope-safe backend
 * read-model (POST /orders/bundles/resolve). Returns a Map keyed by order id (only orders that
 * belong to a bundle appear). The backend owns membership + the shared facts + the scope check;
 * this hook is a thin reader. The query key is the sorted id set, so it re-fetches only when the
 * visible orders actually change.
 */
export function useOrderBundles(orderIds: number[]): Map<number, OrderBundleDto> {
  const sortedIds = [...new Set(orderIds)].sort((a, b) => a - b)
  const { data } = useQuery({
    queryKey: ['order-bundles', sortedIds],
    enabled: sortedIds.length > 0,
    queryFn: async () => {
      const res = await api.post<{ bundles: Record<string, OrderBundleDto> }>(
        '/orders/bundles/resolve',
        { order_ids: sortedIds },
      )
      const map = new Map<number, OrderBundleDto>()
      for (const [key, dto] of Object.entries(res?.bundles ?? {})) map.set(Number(key), dto)
      return map
    },
  })
  return data ?? EMPTY_BUNDLES
}
