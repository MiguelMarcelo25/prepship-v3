import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
  SHARED_DATA_STALE_MS,
  SHARED_DATA_CACHE_MS,
  type ClientDto,
  type UseClientsResult,
  type V4ClientFullRow,
  transformClientRowV4toV2,
} from './v2Hooks-shared';

export type { ClientDto, UseClientsResult };

// Admin-only: returns ACTIVE + INACTIVE clients. Use this for the
// Clients management screen, anywhere the operator needs to re-enable
// a disabled tenant, or any audit/report that should show the full
// roster. Separate query key from useClients() so React Query keeps
// the two caches distinct — toggling a client's active flag
// invalidates both, but a routine refetch of one doesn't trigger the
// other.
export function useAllClients(): UseClientsResult {
  const query = useQuery<V4ClientFullRow[]>({
    queryKey: ['v2-hooks:clients', 'include-inactive'],
    queryFn: () => api.get<V4ClientFullRow[]>('/clients?includeInactive=true'),
    staleTime: SHARED_DATA_STALE_MS,
    gcTime: SHARED_DATA_CACHE_MS,
    refetchOnWindowFocus: false,
  });

  const clients = useMemo(() => {
    const rows = query.data ?? [];
    const namesById = new Map<number, string>();
    for (const row of rows) namesById.set(row.id, row.name);
    return rows.map((row) => transformClientRowV4toV2(row, namesById));
  }, [query.data]);

  return {
    clients,
    isLoading: query.isLoading,
    error: (query.error as Error | null) ?? null,
  };
}
