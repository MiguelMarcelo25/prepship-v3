// Shared data hook for all 10 Clients-page variants. Each variant
// renders the same underlying data (clients + per-client order
// stats) through wildly different aesthetics — by routing through
// one hook we keep the data plumbing in ONE place and the variants
// stay purely presentational. Adding a new variant becomes ~150 LOC
// of JSX, not 150 + a copy of every mutation handler.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'

export type Client = {
  id: number
  name: string
  contactName: string | null
  email: string | null
  phone: string | null
  active: boolean
  storeIds: number[]
}

export type ClientStats = {
  clientId: number
  total: number
  awaiting: number
  shipped: number
  cancelled: number
  onHold: number
  other: number
}

export type BackfillResult = { updated: number; message?: string }

export interface ClientsDataResult {
  clients: Client[]
  statsByClient: Map<number, ClientStats>
  isLoading: boolean
  sync: ReturnType<typeof useMutation<{ inserted: number; updated: number; message: string }, Error, void>>
  remove: ReturnType<typeof useMutation<unknown, Error, number>>
  toggleActive: ReturnType<typeof useMutation<Client, Error, { id: number; active: boolean }, { previous?: Client[] }>>
  backfill: ReturnType<typeof useMutation<BackfillResult, Error, { id: number; overwrite: boolean }>>
}

export function useClientsData(): ClientsDataResult {
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['clients', 'admin'],
    queryFn: () => api.get<Client[]>('/clients?includeInactive=true'),
  })

  const stats = useQuery({
    queryKey: ['clients-order-stats', 'admin'],
    queryFn: () =>
      api.get<{ data: ClientStats[] }>('/clients/order-stats?includeInactive=true'),
  })
  const statsByClient = new Map<number, ClientStats>(
    (stats.data?.data ?? []).map((s) => [s.clientId, s]),
  )

  const remove = useMutation<unknown, Error, number>({
    mutationFn: (id: number) => api.delete(`/clients/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clients'] })
      queryClient.invalidateQueries({ queryKey: ['clients', 'admin'] })
    },
  })

  const toggleActive = useMutation<Client, Error, { id: number; active: boolean }, { previous?: Client[] }>({
    mutationFn: ({ id, active }) =>
      api.patch<Client>(`/clients/${id}`, { active }),
    onMutate: async ({ id, active }) => {
      await queryClient.cancelQueries({ queryKey: ['clients', 'admin'] })
      const previous = queryClient.getQueryData<Client[]>(['clients', 'admin'])
      queryClient.setQueryData<Client[]>(['clients', 'admin'], (current) =>
        current?.map((c) => (c.id === id ? { ...c, active } : c)),
      )
      return { previous }
    },
    onError: (err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['clients', 'admin'], context.previous)
      }
      alert(`Active toggle failed: ${err.message}`)
    },
    onSuccess: (client) => {
      window.dispatchEvent(
        new CustomEvent('prepship:client-active-changed', {
          detail: { clientId: client.id, active: client.active },
        }),
      )
    },
    onSettled: () => {
      // Cascade-invalidate every cache that depends on client active state
      ;[
        ['clients'],
        ['clients', 'admin'],
        ['clients-order-stats'],
        ['clients-order-stats', 'admin'],
        ['orders-count'],
        ['v2-hooks:clients'],
        ['v2-hooks:orders'],
        ['inventory'],
        ['billing-config'],
        ['billing-summary'],
        ['analysis-sku-breakdown'],
        ['analysis-sku-daily'],
      ].forEach((key) => queryClient.invalidateQueries({ queryKey: key }))
    },
  })

  const sync = useMutation<{ inserted: number; updated: number; message: string }, Error, void>({
    mutationFn: () =>
      api.post<{ inserted: number; updated: number; message: string }>(
        '/clients/sync-stores',
        {},
      ),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ['clients'] })
      alert(r.message)
    },
    onError: (err) => alert(`Sync failed: ${err.message}`),
  })

  const backfill = useMutation<BackfillResult, Error, { id: number; overwrite: boolean }>({
    mutationFn: (args) =>
      api.post<BackfillResult>(
        `/clients/${args.id}/backfill-orders${args.overwrite ? '?overwrite=true' : ''}`,
        {},
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['orders'] })
      queryClient.invalidateQueries({ queryKey: ['orders-count'] })
    },
  })

  return {
    clients: data ?? [],
    statsByClient,
    isLoading,
    sync,
    remove,
    toggleActive,
    backfill,
  }
}
