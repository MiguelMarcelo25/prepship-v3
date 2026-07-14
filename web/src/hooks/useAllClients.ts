import { useQuery } from '@tanstack/react-query';
import {
  type ClientDto,
  type UseClientsResult,
} from './v2Hooks-shared';
import { clientDtosFromRows, includeInactiveClientRowsQueryOptions } from '../lib/client-query';

export type { ClientDto, UseClientsResult };

// Admin-only: returns ACTIVE + INACTIVE clients. Use this for the
// Clients management screen, anywhere the operator needs to re-enable
// a disabled tenant, or any audit/report that should show the full
// roster. Separate query key from useClients() so React Query keeps
// the two caches distinct — toggling a client's active flag
// invalidates both, but a routine refetch of one doesn't trigger the
// other.
export function useAllClients(): UseClientsResult {
  const query = useQuery({
    ...includeInactiveClientRowsQueryOptions(),
    select: clientDtosFromRows,
  });

  return {
    clients: query.data ?? [],
    isLoading: query.isLoading,
    error: (query.error as Error | null) ?? null,
  };
}
