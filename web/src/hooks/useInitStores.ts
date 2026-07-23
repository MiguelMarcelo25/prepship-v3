import { useEffect } from "react";
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from "../api/client";
import { endpointQueryKeys } from '../lib/endpoint-query-keys';

// TODO PS-257: restore real InitStoreDto type (not exported by ../types/api)
type InitStoreDto = any;

export interface UseInitStoresResult {
  stores: InitStoreDto[];
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export function useInitStores(): UseInitStoresResult {
  const queryClient = useQueryClient();
  const query = useQuery<InitStoreDto[]>({
    queryKey: endpointQueryKeys.stores,
    queryFn: () => apiClient.fetchStores(),
  });

  // Real-time refresh on client active-toggle: when the user toggles a
  // client's `active` flag in Inventory > Clients, the store list must
  // refetch immediately so the sidebar drops/restores the corresponding
  // store row. The `prepship:client-active-changed` event is dispatched
  // from InventoryView's handleToggleClientActive after the PATCH
  // succeeds. Without this listener, the sidebar would only update on
  // page reload (or on the next interval-driven refresh elsewhere).
  useEffect(() => {
    const handler = () => {
      void queryClient.invalidateQueries({ queryKey: endpointQueryKeys.storesRoot });
    };
    window.addEventListener('prepship:client-active-changed', handler);
    return () => {
      window.removeEventListener('prepship:client-active-changed', handler);
    };
  }, [queryClient]);

  return {
    stores: query.data ?? [],
    loading: query.isPending,
    error: (query.error as Error | null) ?? null,
    refetch: async () => {
      await query.refetch();
    },
  };
}
