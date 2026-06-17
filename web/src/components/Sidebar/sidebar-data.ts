// TODO PS-257: InitCountsDto / InitStoreDto are not exported by ../../types/api
// (the counts/store init DTOs were never added there). Until v4 grows real init
// contracts, the structural shapes consumed by buildSidebarSections are declared
// locally — matching the SidebarOrders.tsx / useSidebarController.ts precedent —
// so the index narrowing below stays well-typed.
interface InitStoreDto {
  storeId: number;
  storeName: string;
  isTest?: boolean;
}
interface InitCountsByStatusRow {
  orderStatus: string;
  cnt: number;
}
interface InitCountsByStatusStoreRow {
  orderStatus: string;
  storeId: number | null;
  cnt: number;
}
interface InitCountsDto {
  byStatus?: InitCountsByStatusRow[];
  byStatusStore?: InitCountsByStatusStoreRow[];
}

export type SidebarOrderStatus = "awaiting_shipment" | "shipped" | "cancelled";

export interface SidebarStoreRow {
  storeId: number;
  name: string;
  cnt: number;
  isTest?: boolean;
}

export interface SidebarSection {
  total: number;
  stores: SidebarStoreRow[];
}

export const SIDEBAR_STATUSES: SidebarOrderStatus[] = ["awaiting_shipment", "shipped", "cancelled"];

function isSidebarStatus(value: string): value is SidebarOrderStatus {
  return SIDEBAR_STATUSES.includes(value as SidebarOrderStatus);
}

// Synthetic store_id ranges issued by api/store-accounts.ts when a
// marketplace integration is added. When orders show up tagged with one
// of these synthetic ids before the matching clients row syncs through
// /clients (or when the clients row was deleted but orders remain), we
// fall back to a friendly provider name rather than the raw "Store
// 9000001" placeholder. Keep these ranges in sync with
// SYNTHETIC_STORE_OFFSETS in api/store-accounts.ts.
function syntheticStoreFallbackName(storeId: number): string | null {
  if (storeId >= 9_000_000 && storeId < 9_100_000) return "Walmart Store";
  if (storeId >= 9_100_000 && storeId < 9_200_000) return "Amazon Store";
  if (storeId >= 9_200_000 && storeId < 9_300_000) return "Shopify Store";
  if (storeId >= 9_300_000 && storeId < 9_400_000) return "Etsy Store";
  if (storeId >= 9_400_000 && storeId < 9_500_000) return "TikTok Shop";
  if (storeId >= 9_500_000 && storeId < 9_600_000) return "eBay Store";
  if (storeId >= 9_600_000 && storeId < 9_700_000) return "WooCommerce Store";
  if (storeId >= 9_700_000 && storeId < 9_800_000) return "BigCommerce Store";
  return null;
}

export function buildSidebarSections(
  stores: InitStoreDto[],
  counts: InitCountsDto | null,
): Record<SidebarOrderStatus, SidebarSection> {
  const sections: Record<SidebarOrderStatus, SidebarSection> = {
    awaiting_shipment: { total: 0, stores: [] },
    shipped: { total: 0, stores: [] },
    cancelled: { total: 0, stores: [] },
  };

  const storeNameById = new Map<number, string>();
  const testStoreIds = new Set<number>();
  for (const store of stores) {
    storeNameById.set(store.storeId, store.storeName);
    if ((store as { isTest?: boolean }).isTest === true) {
      testStoreIds.add(store.storeId);
    }
  }

  for (const row of counts?.byStatus ?? []) {
    if (!isSidebarStatus(row.orderStatus)) continue;
    sections[row.orderStatus].total = row.cnt;
  }

  for (const row of counts?.byStatusStore ?? []) {
    if (!isSidebarStatus(row.orderStatus) || row.storeId == null) continue;
    sections[row.orderStatus].stores.push({
      storeId: row.storeId,
      name:
        storeNameById.get(row.storeId) ??
        syntheticStoreFallbackName(row.storeId) ??
        `Store ${row.storeId}`,
      cnt: row.cnt,
      isTest: testStoreIds.has(row.storeId),
    });
  }

  const globalTotals = new Map<number, number>();
  for (const status of SIDEBAR_STATUSES) {
    for (const store of sections[status].stores) {
      globalTotals.set(store.storeId, (globalTotals.get(store.storeId) ?? 0) + store.cnt);
    }
  }

  for (const status of SIDEBAR_STATUSES) {
    const mergedStores = [...sections[status].stores];
    const seenStoreIds = new Set(mergedStores.map((store) => store.storeId));

    for (const store of stores) {
      if (seenStoreIds.has(store.storeId)) continue;
      mergedStores.push({
        storeId: store.storeId,
        name: store.storeName,
        cnt: 0,
        isTest: (store as { isTest?: boolean }).isTest === true,
      });
    }

    mergedStores.sort((left, right) => {
      return (
        (globalTotals.get(right.storeId) ?? 0) - (globalTotals.get(left.storeId) ?? 0) ||
        left.name.localeCompare(right.name)
      );
    });

    sections[status].stores = mergedStores;
  }

  return sections;
}
