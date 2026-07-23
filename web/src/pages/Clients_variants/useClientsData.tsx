// Shared data hook for all 10 Clients-page variants. Each variant
// renders the same underlying data (clients + per-client order
// stats) through wildly different aesthetics — by routing through
// one hook we keep the data plumbing in ONE place and the variants
// stay purely presentational. Adding a new variant becomes ~150 LOC
// of JSX, not 150 + a copy of every mutation handler.

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { invalidateClientDependentQueries } from '../../lib/client-cache-invalidation'
import { clientQueryKeys, includeInactiveClientRowsQueryOptions } from '../../lib/client-query'
import {
  ConfirmActiveToggleDialog,
  type ConfirmActiveTogglePending,
} from '../../components/ConfirmActiveToggleDialog'

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
export type OrderStatus = 'awaiting_shipment' | 'shipped' | 'cancelled'

export interface ClientsDataResult {
  clients: Client[]
  statsByClient: Map<number, ClientStats>
  isLoading: boolean
  openClientOrders: (client: Client, status: OrderStatus) => void
  sync: ReturnType<typeof useMutation<{ inserted: number; updated: number; message: string }, Error, void>>
  remove: ReturnType<typeof useMutation<unknown, Error, number>>
  // toggleActive's `.mutate({id, active})` no longer fires the
  // mutation directly — it opens a confirmation dialog first and only
  // mutates on confirm. From a caller's perspective the call signature
  // is identical to a vanilla useMutation result, so the existing 11
  // Clients-page variants don't need to change anything. The dialog
  // node lives at `confirmActiveToggleDialog` below and must be
  // rendered somewhere in the variant tree (one line per variant).
  toggleActive: ReturnType<typeof useMutation<Client, Error, { id: number; active: boolean }, { previous?: Client[] }>>
  backfill: ReturnType<typeof useMutation<BackfillResult, Error, { id: number; overwrite: boolean }>>
  // Drop this somewhere in the variant's JSX — it's a portal so it
  // can render anywhere and still float above the rest of the page.
  confirmActiveToggleDialog: ReactNode
}

export function useClientsData(): ClientsDataResult {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const openClientOrders = useCallback(
    (client: Client, status: OrderStatus) => {
      const params = new URLSearchParams({
        clientId: String(client.id),
        includeInactiveClients: 'true',
        clientName: client.name,
      })
      navigate(`/orders/${status}?${params.toString()}`)
    },
    [navigate],
  )

  const { data, isLoading } = useQuery({
    ...includeInactiveClientRowsQueryOptions(),
    select: (rows): Client[] => rows.map((row) => ({
      ...row,
      storeIds: row.storeIds ?? [],
    })),
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
      invalidateClientDependentQueries(queryClient)
    },
  })

  const toggleActive = useMutation<Client, Error, { id: number; active: boolean }, { previous?: Client[] }>({
    mutationFn: ({ id, active }) =>
      api.patch<Client>(`/clients/${id}`, { active }),
    onMutate: async ({ id, active }) => {
      await queryClient.cancelQueries({ queryKey: clientQueryKeys.includeInactive })
      const previous = queryClient.getQueryData<Client[]>(clientQueryKeys.includeInactive)
      queryClient.setQueryData<Client[]>(clientQueryKeys.includeInactive, (current) =>
        current?.map((c) => (c.id === id ? { ...c, active } : c)),
      )
      return { previous }
    },
    onError: (err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(clientQueryKeys.includeInactive, context.previous)
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
      invalidateClientDependentQueries(queryClient)
    },
  })

  const sync = useMutation<{ inserted: number; updated: number; message: string }, Error, void>({
    mutationFn: () =>
      api.post<{ inserted: number; updated: number; message: string }>(
        '/clients/sync-stores',
        {},
      ),
    onSuccess: (r) => {
      invalidateClientDependentQueries(queryClient)
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

  // Confirmation gate over the real toggleActive mutation.
  //
  // Each variant calls `toggleActive.mutate({id, active})` as before,
  // but instead of immediately PATCHing the client we stash the
  // intent in `pendingToggle` state and the ConfirmActiveToggleDialog
  // mounts. Only when the operator clicks "Yes" does the mutation
  // actually run. Cancel/ESC/backdrop drops the pending intent.
  //
  // The mutation object's other fields (isPending, error, reset, …)
  // forward through unchanged so variants that read e.g.
  // `toggleActive.isPending` for spinner state still work.
  const [pendingToggle, setPendingToggle] = useState<ConfirmActiveTogglePending | null>(null)

  const requestToggle = useCallback(
    ({ id, active }: { id: number; active: boolean }) => {
      const client = (data ?? []).find((c) => c.id === id)
      setPendingToggle({
        clientId: id,
        clientName: client?.name ?? `Client #${id}`,
        nextActive: active,
      })
    },
    [data],
  )

  const cancelToggle = useCallback(() => setPendingToggle(null), [])
  const confirmToggle = useCallback(() => {
    if (!pendingToggle) return
    toggleActive.mutate({ id: pendingToggle.clientId, active: pendingToggle.nextActive })
    setPendingToggle(null)
  }, [pendingToggle, toggleActive])

  // Proxy object — same shape as a useMutation return value, but with
  // .mutate() intercepted to open the confirm dialog instead of
  // firing immediately. useMemo prevents identity churn (referential
  // stability matters for any variant that lists toggleActive in
  // useCallback / useEffect deps).
  const gatedToggleActive = useMemo(
    () => ({
      ...toggleActive,
      mutate: requestToggle,
    }),
    [toggleActive, requestToggle],
  ) as typeof toggleActive

  const confirmActiveToggleDialog = (
    <ConfirmActiveToggleDialog
      pending={pendingToggle}
      onConfirm={confirmToggle}
      onCancel={cancelToggle}
      isPending={toggleActive.isPending}
    />
  )

  return {
    clients: data ?? [],
    statsByClient,
    isLoading,
    openClientOrders,
    sync,
    remove,
    toggleActive: gatedToggleActive,
    backfill,
    confirmActiveToggleDialog,
  }
}
