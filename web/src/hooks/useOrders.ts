// @ts-nocheck
import { useState, useEffect, useCallback } from "react";
import { apiClient } from "../api/client";
import type { OrderSummaryDto } from "../types/api";

export interface UseOrdersOptions {
  page?: number;
  pageSize?: number;
  storeId?: number;
  clientId?: number;
  dateStart?: string;
  dateEnd?: string;
  hideTestOrders?: boolean;
  includeInactiveClients?: boolean;
  sortBy?: 'sku';
  /**
   * Free-text search applied server-side across orderNumber, customer
   * name/email, ship-to fields, SKUs, item names, and tracking numbers.
   * When non-empty, status + storeId filters are bypassed so the search
   * is GLOBAL — looking across awaiting / shipped / cancelled / every
   * store at once. This matches the user's mental model when they type
   * into the search bar at the top of /orders.
   */
  search?: string;
  /**
   * Exact-match SKU filter applied server-side. When set, the backend
   * returns only orders whose items[] contains a matching SKU. Lives
   * separate from `search` because the user picks it from a dropdown
   * (so the value is always exact, not a substring). Pagination works
   * correctly — picking a SKU returns its actual orders across all
   * pages, not just whatever happens to be on page 1.
   */
  sku?: string;
}

export interface UseOrdersResult {
  orders: OrderSummaryDto[];
  total: number;
  pages: number;
  currentPage: number;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  goToPage: (page: number) => Promise<void>;
}

export function useOrders(status: string, options: UseOrdersOptions = {}): UseOrdersResult {
  const { page = 1, pageSize = 50, storeId, clientId, dateStart, dateEnd, hideTestOrders, includeInactiveClients, search, sku, sortBy } = options;

  const [orders, setOrders] = useState<OrderSummaryDto[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(page);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchOrders = useCallback(async (pageNum: number) => {
    setLoading(true);
    setError(null);

    try {
      // GLOBAL SEARCH MODE: when the user has typed something into the
      // search box, bypass the status + storeId filters so the query
      // hits EVERY order in the DB (awaiting + shipped + cancelled,
      // across all stores). This matches user intent — a search box
      // at the top of /orders should find your stuff regardless of
      // which tab/store you happen to be looking at.
      //
      // Date range still applies: most operators only want to find
      // RECENT matches; bypassing date too would scan years of history
      // and timeout on big DBs.
      //
      // Empty search → behave like before: scoped to status + store.
      const trimmedSearch = (search ?? '').trim();
      const trimmedSku = (sku ?? '').trim();
      const isGlobal = trimmedSearch.length > 0;

      const response = await apiClient.listOrders({
        page: pageNum,
        pageSize,
        // Drop status + store filters when search is active.
        ...(isGlobal
          ? {} // global: no status/store filter
          : { orderStatus: status, storeId, clientId }),
        dateStart,
        dateEnd,
        hideTestOrders,
        includeInactiveClients,
        sortBy,
        // Forward search to backend so the SQL ilike runs server-side
        // across orderNumber, name, email, ship-to, items, tracking, etc.
        // Previously this was silently dropped here, so search was a
        // client-side-only filter limited to the current page.
        ...(isGlobal ? { search: trimmedSearch } : {}),
        // Forward exact-match SKU filter to backend. Empty string is
        // omitted entirely so the backend treats 'no filter' the same
        // as no parameter.
        ...(trimmedSku ? { sku: trimmedSku } : {}),
      });

      setOrders(response.orders);
      setTotal(response.total);
      setPages(response.pages);
      setCurrentPage(pageNum);
    } catch (err) {
      const error = err instanceof Error ? err : new Error("Failed to fetch orders");
      setError(error);
      console.error("[useOrders]", error);
    } finally {
      setLoading(false);
    }
  }, [status, pageSize, storeId, clientId, dateStart, dateEnd, hideTestOrders, includeInactiveClients, search, sku, sortBy]);

  useEffect(() => {
    void fetchOrders(page);
  }, [fetchOrders, page]);

  const goToPage = useCallback(
    async (pageNum: number) => {
      await fetchOrders(pageNum);
    },
    [fetchOrders]
  );

  return {
    orders,
    total,
    pages,
    currentPage,
    loading,
    error,
    refetch: () => fetchOrders(currentPage),
    goToPage,
  };
}
