import { useQuery } from '@tanstack/react-query';
import {
  type ClientDto,
  type UseClientsResult,
} from './v2Hooks-shared';
import { activeClientRowsQueryOptions, clientDtosFromRows } from '../lib/client-query';

export type { ClientDto, UseClientsResult };

// ──────────────────────────────────────────────────────────────────
// useClients — v4 returns flat rows with `id`; adapt to v2 ClientDto.
// Resolves `rateSourceName` by looking up the referenced client's name
// in the same list. Derives `hasOwnAccount` from the server's redacted
// credential-presence booleans. Every active-client consumer shares the
// canonical endpoint key from client-query.ts.
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
  const query = useQuery({
    ...activeClientRowsQueryOptions(),
    select: clientDtosFromRows,
  });

  return {
    clients: query.data ?? [],
    isLoading: query.isLoading,
    error: (query.error as Error | null) ?? null,
  };
}
