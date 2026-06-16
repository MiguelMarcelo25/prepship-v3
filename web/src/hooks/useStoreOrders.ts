import { useState, useEffect } from "react";

export interface UseStoreOrdersResult {
  orders: any[];
  isLoading: boolean;
  error: Error | null;
}

export function useStoreOrders(storeId: string): UseStoreOrdersResult {
  const [orders, setOrders] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!storeId) return;

    setIsLoading(true);
    setError(null);

    // TODO: Replace with actual API call once client is available
    setTimeout(() => {
      setOrders([]);
      setIsLoading(false);
    }, 100);
  }, [storeId]);

  return { orders, isLoading, error };
}
