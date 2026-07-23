import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../api/client';
import { endpointQueryKeys } from '../lib/endpoint-query-keys';

// ──────────────────────────────────────────────────────────────────
// useInventory — v4 returns paginated thin rows; adapt to v2's rich
// InventoryItemDto. v4's schema is a subset of v2's, so fields v4 doesn't
// carry (baseUnitQty, units_per_pack, product-vs-package dim split,
// packageId, cuFtOverride, parent/package name joins, lastMovement) are
// defaulted/null. Quantity and status are authoritative backend fields.
// Also fetches /clients (deduped via shared key) to resolve `clientName`.
// ──────────────────────────────────────────────────────────────────

export interface InventoryItemDto {
  id: number;
  clientId: number;
  sku: string;
  name: string;
  minStock: number;
  active: boolean;
  weightOz: number;
  parentSkuId: number | null;
  baseUnitQty: number;
  packageLength: number;
  packageWidth: number;
  packageHeight: number;
  productLength: number;
  productWidth: number;
  productHeight: number;
  packageId: number | null;
  units_per_pack: number;
  cuFtOverride: number | null;
  clientName: string;
  packageName: string | null;
  packageDimLength: number | null;
  packageDimWidth: number | null;
  packageDimHeight: number | null;
  parentName: string | null;
  inventoryQuantity: number;
  lastMovement: number | null;
  imageUrl: string | null;
  baseUnits: number;
  status: 'ok' | 'low' | 'out';
  soldLast30Days?: number;
  // 2026-05-13: effective-stock fields surface "what's REALLY on
  // hand" computed from the source-of-truth (received ledger −
  // total sold across all orders), independent of the cached
  // ledger balance. Used by the Inventory page's STOCK column so
  // the value matches operator expectations ("sold 85 → stock −85").
  // Optional because the backend exposes them only on the list
  // endpoint right now; other endpoints (POST/PATCH responses) may
  // not include them.
  totalReceived?: number;
  totalSoldAllTime?: number;
}

export interface UseInventoryOptions {
  clientId?: number;
  search?: string;
  lowStock?: boolean;
  pageSize?: number;
  page?: number;
}

export interface UseInventoryResult {
  items: InventoryItemDto[];
  total: number;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
}

export function useInventory(
  options: UseInventoryOptions = {}
): UseInventoryResult {
  const { clientId, search, lowStock, pageSize = 200, page = 1 } = options;

  const request = { clientId, search, lowStock, page, pageSize };
  const query = useQuery<{
    items: InventoryItemDto[];
    total: number;
    totalPages: number;
    page: number;
    pageSize: number;
  }>({
    queryKey: endpointQueryKeys.inventory(request),
    queryFn: () => apiClient.fetchInventoryPage(request),
    staleTime: 30_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
    placeholderData: (previousData) => previousData,
  });

  return {
    items: query.data?.items ?? [],
    total: query.data?.total ?? 0,
    isLoading: query.isLoading,
    error: (query.error as Error | null) ?? null,
    refetch: () => query.refetch(),
  };
}
