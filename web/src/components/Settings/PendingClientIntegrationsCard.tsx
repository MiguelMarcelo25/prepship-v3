import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, RefreshCw, Search, Trash2 } from 'lucide-react'
import { api } from '../../lib/api'
import { formatCaDateShort, formatCaTimeOnly } from '../../lib/ca-time'
import { SortableHeader, nextSortState, sortRows, type SortState } from '../SortableTable'

type PendingSortKey = 'provider' | 'label' | 'client' | 'account' | 'source' | 'submitted'

interface PendingIntegration {
  id: number
  clientId: number | null
  provider: string
  label: string | null
  accountIdentifier: string | null
  source: string
  active: boolean
  createdAt: string
}

interface CutoverDryRun {
  clientId: number
  shopifyStoreAccountId: number
  shipstationStoreIds: number[]
  syncAnchorAt: string
  shipstationAwaitingCount: number
  shipstationTotalCount: number
  shopifyExistingCount: number
  duplicateCandidates: Array<{
    orderNumber: string
    shipstationOrderId: number
    shopifyOrderId: number
    shipToPostalCode: string | null
  }>
}

type CutoverInputState = Record<number, {
  shipstationStoreIds: string
  syncAnchorAt: string
}>

async function deleteCarrierIntegration(id: number): Promise<void> {
  await api.delete(`/carrier-accounts?id=${id}`)
}

async function approveCarrierIntegration(id: number): Promise<void> {
  await api.patch(`/carrier-accounts?id=${id}`, { source: 'admin' })
}

async function deleteStoreIntegration(id: number): Promise<void> {
  await api.delete(`/store-accounts?id=${id}`)
}

function parseStoreIds(value: string): number[] {
  return [...new Set(
    value
      .split(/[,\s]+/)
      .map((part) => Number(part.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
      .map((n) => Math.trunc(n)),
  )].sort((a, b) => a - b)
}

function localDateTimeToIso(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const parsed = new Date(trimmed)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}

function submittedLabel(value: string | null | undefined): string {
  if (!value) return 'submission'
  return value
}

export function PendingClientIntegrationsCard({ queriesEnabled = true }: { queriesEnabled?: boolean } = {}) {
  const queryClient = useQueryClient()
  const [removing, setRemoving] = useState<Record<string, boolean>>({})
  const [approving, setApproving] = useState<Record<string, boolean>>({})
  const [dryRunning, setDryRunning] = useState<Record<number, boolean>>({})
  const [dryRuns, setDryRuns] = useState<Record<number, CutoverDryRun>>({})
  const [cutoverInputs, setCutoverInputs] = useState<CutoverInputState>({})
  const [actionError, setActionError] = useState<string | null>(null)
  const [carrierSortState, setCarrierSortState] = useState<SortState<PendingSortKey>>(null)
  const [storeSortState, setStoreSortState] = useState<SortState<PendingSortKey>>(null)

  const pendingCarriersQuery = useQuery<{ data: PendingIntegration[] }>({
    queryKey: ['settings', 'pending-carrier-integrations'],
    enabled: queriesEnabled,
    queryFn: () => api.get<{ data: PendingIntegration[] }>('/carrier-accounts?source=portal&pending=1'),
  })
  const pendingStoresQuery = useQuery<{ data: PendingIntegration[] }>({
    queryKey: ['settings', 'pending-store-integrations'],
    enabled: queriesEnabled,
    queryFn: () => api.get<{ data: PendingIntegration[] }>('/store-accounts?source=portal&pending=1'),
  })
  const carrierItems = Array.isArray(pendingCarriersQuery.data?.data) ? pendingCarriersQuery.data.data : []
  const storeItems = Array.isArray(pendingStoresQuery.data?.data) ? pendingStoresQuery.data.data : []
  const loading = (
    pendingCarriersQuery.data == null && (!queriesEnabled || pendingCarriersQuery.isPending)
  ) || (
    pendingStoresQuery.data == null && (!queriesEnabled || pendingStoresQuery.isPending)
  )
    || pendingCarriersQuery.isFetching
    || pendingStoresQuery.isFetching
  const queryError = pendingCarriersQuery.error ?? pendingStoresQuery.error
  const state: { kind: 'idle' | 'loading' | 'error'; message?: string } = loading
    ? { kind: 'loading' }
    : pendingCarriersQuery.isError || pendingStoresQuery.isError
      ? { kind: 'error', message: queryError instanceof Error ? queryError.message : 'Unknown error' }
      : { kind: 'idle' }

  const sortPending = (
    items: PendingIntegration[],
    sortState: SortState<PendingSortKey>,
  ) => sortRows(
    items,
    sortState,
    (item, key) => {
      switch (key) {
        case 'provider':
          return item.provider
        case 'label':
          return item.label
        case 'client':
          return item.clientId
        case 'account':
          return item.accountIdentifier
        case 'source':
          return item.source
        case 'submitted':
          return item.createdAt ? new Date(item.createdAt) : null
        default:
          return ''
      }
    },
    (item) => item.id,
  )

  const sortedCarrierItems = useMemo(
    () => sortPending(carrierItems, carrierSortState),
    [carrierItems, carrierSortState],
  )
  const shopifyStoreItems = useMemo(
    () => storeItems.filter((item) => item.provider === 'shopify'),
    [storeItems],
  )
  const sortedStoreItems = useMemo(
    () => sortPending(shopifyStoreItems, storeSortState),
    [shopifyStoreItems, storeSortState],
  )

  const refresh = async () => {
    await Promise.all([pendingCarriersQuery.refetch(), pendingStoresQuery.refetch()])
  }

  const setCutoverInput = (id: number, patch: Partial<CutoverInputState[number]>) => {
    setCutoverInputs((prev) => ({
      ...prev,
      [id]: {
        shipstationStoreIds: prev[id]?.shipstationStoreIds ?? '',
        syncAnchorAt: prev[id]?.syncAnchorAt ?? '',
        ...patch,
      },
    }))
  }

  const cutoverPayload = (item: PendingIntegration) => {
    if (item.clientId == null) {
      throw new Error('This Shopify submission has no client scope.')
    }
    const input = cutoverInputs[item.id] ?? { shipstationStoreIds: '', syncAnchorAt: '' }
    const shipstationStoreIds = parseStoreIds(input.shipstationStoreIds)
    if (shipstationStoreIds.length === 0) {
      throw new Error('Enter at least one ShipStation store ID before approval.')
    }
    return {
      clientId: item.clientId,
      shopifyStoreAccountId: item.id,
      shipstationStoreIds,
      syncAnchorAt: localDateTimeToIso(input.syncAnchorAt),
    }
  }

  const handleRemoveCarrier = async (id: number) => {
    if (!window.confirm('Remove this pending carrier integration?')) return
    setActionError(null)
    const key = `carrier:${id}`
    setRemoving((prev) => ({ ...prev, [key]: true }))
    try {
      await deleteCarrierIntegration(id)
      queryClient.setQueryData<{ data: PendingIntegration[] }>(
        ['settings', 'pending-carrier-integrations'],
        (current) => current ? { ...current, data: current.data.filter((item) => item.id !== id) } : current,
      )
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setRemoving((prev) => ({ ...prev, [key]: false }))
    }
  }

  const handleRemoveStore = async (id: number) => {
    if (!window.confirm('Remove this pending Shopify store connection?')) return
    setActionError(null)
    const key = `store:${id}`
    setRemoving((prev) => ({ ...prev, [key]: true }))
    try {
      await deleteStoreIntegration(id)
      queryClient.setQueryData<{ data: PendingIntegration[] }>(
        ['settings', 'pending-store-integrations'],
        (current) => current ? { ...current, data: current.data.filter((item) => item.id !== id) } : current,
      )
      setDryRuns((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setRemoving((prev) => ({ ...prev, [key]: false }))
    }
  }

  const handleApproveCarrier = async (id: number, label: string | null) => {
    const friendly = submittedLabel(label)
    if (!window.confirm(`Approve "${friendly}" as an admin carrier?`)) return
    setActionError(null)
    const key = `carrier:${id}`
    setApproving((prev) => ({ ...prev, [key]: true }))
    try {
      await approveCarrierIntegration(id)
      queryClient.setQueryData<{ data: PendingIntegration[] }>(
        ['settings', 'pending-carrier-integrations'],
        (current) => current ? { ...current, data: current.data.filter((item) => item.id !== id) } : current,
      )
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setApproving((prev) => ({ ...prev, [key]: false }))
    }
  }

  const handleDryRunCutover = async (item: PendingIntegration) => {
    setActionError(null)
    setDryRunning((prev) => ({ ...prev, [item.id]: true }))
    try {
      const payload = cutoverPayload(item)
      const res = await api.post<{ data: CutoverDryRun }>('/store-source-cutovers/dry-run', payload)
      setDryRuns((prev) => ({ ...prev, [item.id]: res.data }))
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setDryRunning((prev) => ({ ...prev, [item.id]: false }))
    }
  }

  const handleApplyCutover = async (item: PendingIntegration) => {
    setActionError(null)
    let payload: ReturnType<typeof cutoverPayload>
    try {
      payload = cutoverPayload(item)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
      return
    }
    const friendly = submittedLabel(item.label)
    if (!window.confirm(
      `Approve "${friendly}" and cut over from ShipStation store ID(s) ${payload.shipstationStoreIds.join(', ')}?`
    )) return

    const key = `store:${item.id}`
    setApproving((prev) => ({ ...prev, [key]: true }))
    try {
      await api.post('/store-source-cutovers/apply', payload)
      queryClient.setQueryData<{ data: PendingIntegration[] }>(
        ['settings', 'pending-store-integrations'],
        (current) => current ? { ...current, data: current.data.filter((row) => row.id !== item.id) } : current,
      )
      setDryRuns((prev) => {
        const next = { ...prev }
        delete next[item.id]
        return next
      })
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setApproving((prev) => ({ ...prev, [key]: false }))
    }
  }

  const hasNoItems = carrierItems.length === 0 && shopifyStoreItems.length === 0

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-line bg-surface shadow-sm">
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            <h3 className="m-0 text-sm font-extrabold text-ink">Pending Client Integrations</h3>
            <p className="m-0 mt-1 text-[11.5px] leading-relaxed text-ink-3">
              Client-submitted carrier credentials and Shopify store connections awaiting admin review.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={state.kind === 'loading'}
            className="inline-flex h-8 items-center gap-1.5 rounded border border-line bg-surface-2 px-3 text-[11px] font-bold text-ink hover:bg-surface disabled:cursor-wait disabled:opacity-60"
          >
            <RefreshCw size={13} />
            {state.kind === 'loading' ? 'Refreshing' : 'Refresh'}
          </button>
        </div>

        <div className="px-4 py-3">
          {state.kind === 'error' && !hasNoItems ? (
            <div className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700">
              {state.message}
            </div>
          ) : null}

          {actionError ? (
            <div className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700">
              {actionError}
            </div>
          ) : null}

          {state.kind === 'loading' ? (
            <div className="text-xs text-ink-3">Loading...</div>
          ) : hasNoItems ? (
            <div className="rounded border border-dashed border-line bg-surface-2 px-4 py-8 text-center text-xs text-ink-3">
              No pending submissions.
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              <section>
                <div className="mb-2 flex items-end justify-between gap-3">
                  <div>
                    <h4 className="m-0 text-xs font-extrabold uppercase tracking-normal text-ink-2">Carrier Submissions</h4>
                    <p className="m-0 mt-0.5 text-[11px] text-ink-3">Approved carriers become available for rates and label purchase.</p>
                  </div>
                </div>
                {sortedCarrierItems.length === 0 ? (
                  <div className="rounded border border-dashed border-line bg-surface-2 px-3 py-4 text-center text-[11px] text-ink-3">
                    No pending carrier submissions.
                  </div>
                ) : (
                  <PendingTable
                    items={sortedCarrierItems}
                    sortState={carrierSortState}
                    onSort={(key) => setCarrierSortState((current) => nextSortState(current, key))}
                    actions={(item) => {
                      const key = `carrier:${item.id}`
                      return (
                        <div className="inline-flex justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => void handleApproveCarrier(item.id, item.label)}
                            disabled={!!approving[key] || !!removing[key]}
                            className="inline-flex h-7 items-center gap-1 rounded bg-brand px-2.5 text-[11px] font-bold text-white disabled:cursor-wait disabled:opacity-60"
                          >
                            <CheckCircle2 size={13} />
                            {approving[key] ? 'Approving' : 'Approve'}
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleRemoveCarrier(item.id)}
                            disabled={!!removing[key] || !!approving[key]}
                            className="inline-flex h-7 items-center gap-1 rounded border border-red-200 bg-red-50 px-2.5 text-[11px] font-bold text-red-700 disabled:cursor-wait disabled:opacity-60"
                          >
                            <Trash2 size={13} />
                            {removing[key] ? 'Removing' : 'Remove'}
                          </button>
                        </div>
                      )
                    }}
                  />
                )}
              </section>

              <section>
                <div className="mb-2 flex items-end justify-between gap-3">
                  <div>
                    <h4 className="m-0 text-xs font-extrabold uppercase tracking-normal text-ink-2">Shopify Store Cutovers</h4>
                    <p className="m-0 mt-0.5 text-[11px] text-ink-3">Approval activates Shopify sync and stops new ShipStation awaiting imports for the selected legacy stores.</p>
                  </div>
                </div>
                {sortedStoreItems.length === 0 ? (
                  <div className="rounded border border-dashed border-line bg-surface-2 px-3 py-4 text-center text-[11px] text-ink-3">
                    No pending Shopify store submissions.
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    {sortedStoreItems.map((item) => {
                      const input = cutoverInputs[item.id] ?? { shipstationStoreIds: '', syncAnchorAt: '' }
                      const dryRun = dryRuns[item.id]
                      const key = `store:${item.id}`
                      return (
                        <div key={item.id} className="rounded border border-line bg-surface-2 p-3">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-[240px]">
                              <div className="text-xs font-extrabold text-ink">{item.label ?? 'Shopify'}</div>
                              <div className="mt-0.5 text-[11px] text-ink-3">
                                Client {item.clientId != null ? `#${item.clientId}` : '(none)'} · {item.accountIdentifier ?? 'unknown shop'} · submitted {formatCaDateShort(item.createdAt)}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => void handleRemoveStore(item.id)}
                              disabled={!!removing[key] || !!approving[key]}
                              className="inline-flex h-7 items-center gap-1 rounded border border-red-200 bg-red-50 px-2.5 text-[11px] font-bold text-red-700 disabled:cursor-wait disabled:opacity-60"
                            >
                              <Trash2 size={13} />
                              {removing[key] ? 'Removing' : 'Remove'}
                            </button>
                          </div>

                          <div className="mt-3 grid gap-2 md:grid-cols-[1.25fr_0.9fr_auto]">
                            <label className="block">
                              <span className="block text-[10px] font-bold uppercase tracking-normal text-ink-3">Cut over from ShipStation store ID(s)</span>
                              <input
                                value={input.shipstationStoreIds}
                                onChange={(event) => setCutoverInput(item.id, { shipstationStoreIds: event.target.value })}
                                placeholder="376661, 123456"
                                className="mt-1 h-8 w-full rounded border border-line bg-surface px-2 text-xs text-ink outline-none focus:border-brand"
                              />
                            </label>
                            <label className="block">
                              <span className="block text-[10px] font-bold uppercase tracking-normal text-ink-3">Shopify sync anchor</span>
                              <input
                                type="datetime-local"
                                value={input.syncAnchorAt}
                                onChange={(event) => setCutoverInput(item.id, { syncAnchorAt: event.target.value })}
                                className="mt-1 h-8 w-full rounded border border-line bg-surface px-2 text-xs text-ink outline-none focus:border-brand"
                              />
                            </label>
                            <div className="flex items-end gap-1.5">
                              <button
                                type="button"
                                onClick={() => void handleDryRunCutover(item)}
                                disabled={!!dryRunning[item.id] || !!approving[key]}
                                className="inline-flex h-8 items-center gap-1 rounded border border-line bg-surface px-2.5 text-[11px] font-bold text-ink hover:bg-surface-2 disabled:cursor-wait disabled:opacity-60"
                              >
                                <Search size={13} />
                                {dryRunning[item.id] ? 'Checking' : 'Dry Run'}
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleApplyCutover(item)}
                                disabled={!!approving[key] || !!dryRunning[item.id]}
                                className="inline-flex h-8 items-center gap-1 rounded bg-brand px-2.5 text-[11px] font-bold text-white disabled:cursor-wait disabled:opacity-60"
                              >
                                <CheckCircle2 size={13} />
                                {approving[key] ? 'Applying' : 'Approve + Cut Over'}
                              </button>
                            </div>
                          </div>

                          {dryRun ? (
                            <div className="mt-3 grid gap-2 text-[11px] text-ink-2 md:grid-cols-4">
                              <div className="rounded border border-line bg-surface px-2 py-1.5">
                                <div className="font-bold text-ink">{dryRun.shipstationAwaitingCount}</div>
                                <div className="text-ink-3">ShipStation awaiting</div>
                              </div>
                              <div className="rounded border border-line bg-surface px-2 py-1.5">
                                <div className="font-bold text-ink">{dryRun.shipstationTotalCount}</div>
                                <div className="text-ink-3">ShipStation total</div>
                              </div>
                              <div className="rounded border border-line bg-surface px-2 py-1.5">
                                <div className="font-bold text-ink">{dryRun.shopifyExistingCount}</div>
                                <div className="text-ink-3">Shopify existing</div>
                              </div>
                              <div className="rounded border border-line bg-surface px-2 py-1.5">
                                <div className="font-bold text-ink">{dryRun.duplicateCandidates.length}</div>
                                <div className="text-ink-3">Duplicate candidates</div>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      )
                    })}
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function PendingTable({
  items,
  sortState,
  onSort,
  actions,
}: {
  items: PendingIntegration[]
  sortState: SortState<PendingSortKey>
  onSort: (key: PendingSortKey) => void
  actions: (item: PendingIntegration) => React.ReactNode
}) {
  return (
    <div className="responsive-table-wrap">
      <table className="w-full min-w-[760px] border-collapse text-xs">
        <thead>
          <tr className="border-b border-line bg-surface-2">
            <SortableHeader sortKey="provider" sortState={sortState} onSort={onSort} style={th}>Provider</SortableHeader>
            <SortableHeader sortKey="label" sortState={sortState} onSort={onSort} style={th}>Label</SortableHeader>
            <SortableHeader sortKey="client" sortState={sortState} onSort={onSort} style={th}>Client</SortableHeader>
            <SortableHeader sortKey="account" sortState={sortState} onSort={onSort} style={th}>Account ID</SortableHeader>
            <SortableHeader sortKey="source" sortState={sortState} onSort={onSort} style={th}>Source</SortableHeader>
            <SortableHeader sortKey="submitted" sortState={sortState} onSort={onSort} align="right" style={{ ...th, textAlign: 'right' }}>Submitted</SortableHeader>
            <th style={{ ...th, textAlign: 'right' }}>Action</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-b border-line">
              <td style={td}><b>{item.provider.toUpperCase()}</b></td>
              <td style={td}>{item.label ?? <span className="text-ink-3">-</span>}</td>
              <td style={td}>
                {item.clientId != null ? (
                  <span className="font-mono">#{item.clientId}</span>
                ) : (
                  <span className="text-ink-3">(none)</span>
                )}
              </td>
              <td style={{ ...td, fontFamily: 'monospace', fontSize: 11 }}>
                {item.accountIdentifier ?? <span className="text-ink-3">-</span>}
              </td>
              <td style={td}>
                <span className="rounded border border-line bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-3">
                  {item.source}
                </span>
              </td>
              <td style={{ ...td, textAlign: 'right', color: 'var(--text3)', fontSize: 11 }}>
                {formatCaDateShort(item.createdAt)}{' '}
                <span className="text-[10px]">{formatCaTimeOnly(item.createdAt)} CA</span>
              </td>
              <td style={{ ...td, textAlign: 'right' }}>{actions(item)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '6px 8px',
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: 0,
  color: 'var(--text3)',
}

const td: React.CSSProperties = {
  padding: '6px 8px',
  verticalAlign: 'middle',
}
