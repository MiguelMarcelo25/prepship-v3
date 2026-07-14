import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, qs, type Paginated } from '../lib/api';
import { activeClientRowsQueryOptions } from '../lib/client-query';

// ──────────────────────────────────────────────────────────────────
// useInventory — v4 returns paginated thin rows; adapt to v2's rich
// InventoryItemDto. v4's schema is a subset of v2's, so fields v4 doesn't
// carry (baseUnitQty, units_per_pack, product-vs-package dim split,
// packageId, cuFtOverride, parent/package name joins, lastMovement) are
// defaulted/null. `status` is computed from stockQty vs reorderLevel.
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
  currentStock: number;
  cachedStockQty?: number;
  lastMovement: number | null;
  imageUrl: string | null;
  baseUnits: number;
  status: 'ok' | 'low' | 'out';
  soldLast30Days?: number;
  // 2026-05-13: effective-stock fields surface "what's REALLY on
  // hand" computed from the source-of-truth (received ledger −
  // total sold across all orders), independent of the cached
  // stockQty field. Used by the Inventory page's STOCK column so
  // the value matches operator expectations ("sold 85 → stock −85").
  // Optional because the backend exposes them only on the list
  // endpoint right now; other endpoints (POST/PATCH responses) may
  // not include them.
  totalReceived?: number;
  totalSoldAllTime?: number;
  effectiveStock?: number;
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

type V4InventoryRow = {
  id: number;
  clientId: number | null;
  sku: string;
  name: string | null;
  imageUrl: string | null;
  stockQty: number;
  soldLast30Days?: number;
  totalReceived?: number;
  totalSoldAllTime?: number;
  effectiveStock?: number;
  reorderLevel: number;
  weightOz: number | null;
  length: number | null;
  width: number | null;
  height: number | null;
  parentSkuId: number | null;
  active: boolean;
};

function statusOf(
  stockQty: number,
  reorderLevel: number
): 'ok' | 'low' | 'out' {
  if (stockQty <= 0) return 'out';
  if (stockQty <= reorderLevel) return 'low';
  return 'ok';
}

function transformInventoryRowV4toV2(
  row: V4InventoryRow,
  clientNamesById: Map<number, string>
): InventoryItemDto {
  const clientId = row.clientId ?? 0;
  const l = row.length ?? 0;
  const w = row.width ?? 0;
  const h = row.height ?? 0;
  const baseUnitQty = 1;
  const cachedStockQty = row.stockQty;
  const effectiveStock =
    typeof row.effectiveStock === 'number' ? row.effectiveStock : cachedStockQty;

  return {
    id: row.id,
    clientId,
    sku: row.sku,
    name: row.name ?? '',
    minStock: row.reorderLevel,
    active: row.active,
    weightOz: row.weightOz ?? 0,
    parentSkuId: row.parentSkuId,
    baseUnitQty,
    packageLength: l,
    packageWidth: w,
    packageHeight: h,
    productLength: l,
    productWidth: w,
    productHeight: h,
    packageId: null,
    units_per_pack: 1,
    cuFtOverride: null,
    clientName: clientId ? clientNamesById.get(clientId) ?? '' : '',
    packageName: null,
    packageDimLength: null,
    packageDimWidth: null,
    packageDimHeight: null,
    parentName: null,
    currentStock: effectiveStock,
    cachedStockQty,
    lastMovement: null,
    imageUrl: row.imageUrl,
    baseUnits: effectiveStock * baseUnitQty,
    status: statusOf(effectiveStock, row.reorderLevel),
    soldLast30Days: row.soldLast30Days ?? 0,
    totalReceived: row.totalReceived,
    totalSoldAllTime: row.totalSoldAllTime,
    effectiveStock: row.effectiveStock,
  };
}

export function useInventory(
  options: UseInventoryOptions = {}
): UseInventoryResult {
  const { clientId, search, lowStock, pageSize = 200, page = 1 } = options;

  // 2026-05-12: explicit activeOnly=true so the inventory query's
  // clientName resolution never picks up disabled clients.
  const clientsQuery = useQuery(activeClientRowsQueryOptions());

  const query = useQuery<Paginated<V4InventoryRow>>({
    queryKey: [
      'v2-hooks:inventory',
      clientId,
      search,
      lowStock,
      page,
      pageSize,
    ],
    queryFn: () =>
      api.get<Paginated<V4InventoryRow>>(
        `/inventory${qs({ clientId, search, lowStock, page, pageSize })}`
      ),
    staleTime: 30_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
    placeholderData: (previousData) => previousData,
  });

  const items = useMemo(() => {
    const clientNamesById = new Map<number, string>();
    for (const c of clientsQuery.data ?? []) clientNamesById.set(c.id, c.name);
    return (query.data?.data ?? []).map((row) =>
      transformInventoryRowV4toV2(row, clientNamesById)
    );
  }, [query.data, clientsQuery.data]);

  return {
    items,
    total: query.data?.pagination.total ?? 0,
    isLoading: query.isLoading || clientsQuery.isLoading,
    error: (query.error as Error | null) ?? null,
    refetch: () => query.refetch(),
  };
}
