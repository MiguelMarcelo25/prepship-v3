// @ts-nocheck
import { useEffect, useState } from "react";
import { apiClient } from "../api/client";
import type { OrderFullDto } from "../types/api";

export interface UseOrderDetailResult {
  order: OrderFullDto | null;
  isLoading: boolean;
  error: Error | null;
}

export function useOrderDetail(orderId: string): UseOrderDetailResult {
  const [order, setOrder] = useState<OrderFullDto | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let mounted = true;

    if (!orderId) {
      setOrder(null);
      setIsLoading(false);
      setError(null);
      return () => {
        mounted = false;
      };
    }

    setIsLoading(true);
    setError(null);

    const parsedOrderId = Number.parseInt(orderId, 10);

    void apiClient.fetchOrderFull(parsedOrderId)
      .then((payload) => {
        if (!mounted) return;
        setOrder(payload);
      })
      .catch((err) => {
        if (!mounted) return;
        setOrder(null);
        setError(err instanceof Error ? err : new Error("Failed to fetch order detail"));
      })
      .finally(() => {
        if (!mounted) return;
        setIsLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [orderId]);

  return { order, isLoading, error };
}
