import { useState, useEffect } from "react";
import { apiClient } from "../api/client";

export interface UseOrdersWithDetailsResult {
  orders: any[];
  isLoading: boolean;
  error: Error | null;
}

export function useOrdersWithDetails(): UseOrdersWithDetailsResult {
  const [orders, setOrders] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let mounted = true;

    const fetchOrders = async () => {
      try {
        setIsLoading(true);
        setError(null);

        // Fetch orders from API (awaiting shipment by default)
        const response = await apiClient.fetchOrders({
          page: 1,
          pageSize: 1000,
          orderStatus: "awaiting_shipment",
        });

        if (mounted) {
          setOrders(response.orders || []);
        }
      } catch (err) {
        if (mounted) {
          const errorObj = err instanceof Error ? err : new Error(String(err));
          setError(errorObj);
          console.error("Failed to fetch orders:", errorObj);
        }
      } finally {
        if (mounted) {
          setIsLoading(false);
        }
      }
    };

    fetchOrders();

    return () => {
      mounted = false;
    };
  }, []);

  return { orders, isLoading, error };
}
