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
  const { page = 1, pageSize = 50, storeId, clientId, dateStart, dateEnd } = options;

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
      const response = await apiClient.listOrders({
        page: pageNum,
        pageSize,
        orderStatus: status,
        storeId,
        clientId,
        dateStart,
        dateEnd,
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
  }, [status, pageSize, storeId, clientId, dateStart, dateEnd]);

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
