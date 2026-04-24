// @ts-nocheck
import type { InitCountsDto, InitStoreDto } from "../../types/api";

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
      name: storeNameById.get(row.storeId) ?? `Store ${row.storeId}`,
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
