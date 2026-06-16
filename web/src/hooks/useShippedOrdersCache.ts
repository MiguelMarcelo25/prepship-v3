import { useRef, useCallback } from "react";

export interface UseShippedOrdersCacheResult {
  getCache: () => any[];
  setCache: (orders: any[]) => void;
  clearCache: () => void;
}

export function useShippedOrdersCache(): UseShippedOrdersCacheResult {
  const cacheRef = useRef<any[]>([]);

  const getCache = useCallback(() => {
    return cacheRef.current;
  }, []);

  const setCache = useCallback((orders: any[]) => {
    cacheRef.current = orders;
  }, []);

  const clearCache = useCallback(() => {
    cacheRef.current = [];
  }, []);

  return {
    getCache,
    setCache,
    clearCache,
  };
}
