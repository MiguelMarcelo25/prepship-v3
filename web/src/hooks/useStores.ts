import { useState, useEffect, useCallback } from "react";
import { apiClient } from "../api/client";
// TODO PS-257: restore real type — @prepshipv2/contracts is erased at runtime and absent in v4.
type ClientDto = any;

export interface UseStoresResult {
  stores: ClientDto[];
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export function useStores(): UseStoresResult {
  const [stores, setStores] = useState<ClientDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchStores = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await apiClient.listClients();
      setStores(data);
    } catch (err) {
      const error = err instanceof Error ? err : new Error("Failed to fetch stores");
      setError(error);
      console.error("[useStores]", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStores();
  }, [fetchStores]);

  return {
    stores,
    loading,
    error,
    refetch: fetchStores,
  };
}
