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

// ──────────────────────────────────────────────────────────────────
// useClients — v4 returns flat rows with `id`; adapt to v2 ClientDto.
// Resolves `rateSourceName` by looking up the referenced client's name
// in the same list. Derives `hasOwnAccount` from the server's redacted
// credential-presence booleans. Shares the `['v2-hooks:clients']` query key with useOrders
// so React Query dedupes the /clients fetch.
// ──────────────────────────────────────────────────────────────────

// 2026-05-12 visibility hardening: useClients() now ALWAYS requests
// active-only clients from the backend. Previously it called bare
// /clients and relied on the route's `activeOnly=true` default — which
// works today but is one default-flip away from leaking inactive
// clients into every consumer (Settings, CarrierIntegrationsCard,
// future surfaces). Explicit is better than implicit.
//
// Admin paths that NEED to see disabled clients should use
// useAllClients() (below) — that hook explicitly passes
// includeInactive=true, signaling at the call site that this is a
// management surface, not a data view.
export function useClients(): UseClientsResult {
  const query = useQuery<V4ClientFullRow[]>({
    queryKey: ['v2-hooks:clients', 'active-only'],
    queryFn: () => api.get<V4ClientFullRow[]>('/clients?activeOnly=true'),
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
