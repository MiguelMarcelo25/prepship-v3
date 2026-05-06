// @ts-nocheck
import { useState, useEffect, useCallback } from "react";
import { apiClient } from "../api/client";
import type { InitStoreDto } from "../types/api";

export interface UseInitStoresResult {
  stores: InitStoreDto[];
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export function useInitStores(): UseInitStoresResult {
  const [stores, setStores] = useState<InitStoreDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchStores = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await apiClient.fetchStores();
      setStores(data);
    } catch (err) {
      const error = err instanceof Error ? err : new Error("Failed to fetch init stores");
      setError(error);
      console.error("[useInitStores]", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStores();
  }, [fetchStores]);

  // Real-time refresh on client active-toggle: when the user toggles a
  // client's `active` flag in Inventory > Clients, the store list must
  // refetch immediately so the sidebar drops/restores the corresponding
  // store row. The `prepship:client-active-changed` event is dispatched
  // from InventoryView's handleToggleClientActive after the PATCH
  // succeeds. Without this listener, the sidebar would only update on
  // page reload (or on the next interval-driven refresh elsewhere).
  useEffect(() => {
    const handler = () => {
      void fetchStores();
    };
    window.addEventListener('prepship:client-active-changed', handler);
    return () => {
      window.removeEventListener('prepship:client-active-changed', handler);
    };
  }, [fetchStores]);

  return {
    stores,
    loading,
    error,
    refetch: fetchStores,
  };
}
