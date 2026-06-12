// @ts-nocheck
import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { formatCaDateShort, formatCaTimeOnly } from '../../lib/ca-time'
import { SortableHeader, nextSortState, sortRows } from '../SortableTable'

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

async function deleteIntegration(id: number): Promise<void> {
  await api.delete(`/carrier-accounts?id=${id}`)
}

// PATCH /carrier-accounts?id=N { source: 'admin' } — flips a portal
// submission to admin source so it becomes a fully-active carrier
// account: visible to rate-shop, listed in OrdersView pickers,
// assignable to multiple clients via the main Settings list. This
// is Option B of the 2026-05-12 audit. The endpoint also auto-
// promotes on assignment save (Option A) — this button is for
// operators who want to approve a submission without immediately
// assigning specific clients (the legacy `clientId` foreign key
// keeps the original-owner client wired up either way).
async function approveIntegration(id: number): Promise<void> {
  await api.patch(`/carrier-accounts?id=${id}`, { source: 'admin' })
}

// Lists carrier_accounts rows with source='portal'. The natural-key index on
// (client_id, provider, account_identifier) means duplicates against existing
// admin-added rows simply won't insert — sync becomes idempotent. Admin can
// remove pending entries here; approval/merge flow comes in a follow-up.
export function PendingClientIntegrationsCard() {
  const [items, setItems] = useState<PendingIntegration[]>([])
  const [state, setState] = useState<{ kind: 'idle' | 'loading' | 'error'; message?: string }>({ kind: 'idle' })
  const [removing, setRemoving] = useState<Record<number, boolean>>({})
  // Track per-row approval state independently from removal so the
  // two buttons can show distinct loading labels without colliding.
  const [approving, setApproving] = useState<Record<number, boolean>>({})
  const [actionError, setActionError] = useState<string | null>(null)
  const [sortState, setSortState] = useState(null)
  const sortedItems = useMemo(() => sortRows(
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
  ), [items, sortState])

  const refresh = async () => {
    setState({ kind: 'loading' })
    try {
      const res = await api.get<{ data: PendingIntegration[] }>('/carrier-accounts?source=portal&pending=1')
      setItems(Array.isArray(res?.data) ? res.data : [])
      setState({ kind: 'idle' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      setState({ kind: 'error', message })
    }
  }

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const res = await api.get<{ data: PendingIntegration[] }>('/carrier-accounts?source=portal&pending=1')
        if (!active) return
        setItems(Array.isArray(res?.data) ? res.data : [])
        setState({ kind: 'idle' })
      } catch (error) {
        if (!active) return
        const message = error instanceof Error ? error.message : 'Unknown error'
        setState({ kind: 'error', message })
      }
    })()
    return () => {
      active = false
    }
  }, [])

  const handleRemove = async (id: number) => {
    if (!window.confirm('Remove this pending integration? This permanently deletes the row.')) return
    setActionError(null)
    setRemoving((prev) => ({ ...prev, [id]: true }))
    try {
      await deleteIntegration(id)
      setItems((prev) => prev.filter((it) => it.id !== id))
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setRemoving((prev) => ({ ...prev, [id]: false }))
    }
  }

  // Promote a portal-source submission to admin source. After approval
  // the row drops out of THIS list (its filter is source=portal) and
  // becomes a fully functional carrier in the main Settings list. The
  // confirm dialog spells out the downstream consequence — once
  // approved, the carrier is reachable by rate-shop for any client it's
  // assigned to (or its original-owner client via the legacy clientId
  // fallback).
  const handleApprove = async (id: number, label: string | null) => {
    const friendly = label ?? `submission #${id}`
    if (!window.confirm(
      `Approve "${friendly}"?\n\nThis promotes it to an admin-source carrier — it becomes available for rate-shop and label purchase, and you can multi-assign it to clients from the main Carrier Integrations list.`
    )) return
    setActionError(null)
    setApproving((prev) => ({ ...prev, [id]: true }))
    try {
      await approveIntegration(id)
      // Optimistic: drop it from the pending list. The next refresh
      // confirms by no longer returning it (its source is now 'admin'
      // so the source=portal filter excludes it).
      setItems((prev) => prev.filter((it) => it.id !== id))
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setApproving((prev) => ({ ...prev, [id]: false }))
    }
  }

  return (
    <div className="markup-card" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <h3 style={{ margin: 0 }}>📥 Pending Client Integrations</h3>
          <p style={{ fontSize: 11.5, color: 'var(--text3)', margin: '4px 0 0' }}>
            Carrier credentials submitted by clients via the client portal that haven't been reviewed yet.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={state.kind === 'loading'}
          style={{
            padding: '5px 12px',
            border: '1px solid var(--border)',
            borderRadius: 3,
            background: 'var(--surface2)',
            color: 'var(--text)',
            fontSize: 11,
            fontWeight: 600,
            cursor: state.kind === 'loading' ? 'wait' : 'pointer',
          }}
        >
          {state.kind === 'loading' ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      <div style={{ height: 10 }} />

      {/* Only show the error banner when there are existing items that may
          have been partially loaded. If the list is empty, fall through to
          the empty state — a red banner on a clean slate is just noise. */}
      {state.kind === 'error' && items.length > 0 ? (
        <div style={{
          fontSize: 11,
          color: 'var(--red)',
          background: 'var(--surface2)',
          border: '1px dashed var(--red)',
          borderRadius: 3,
          padding: '6px 10px',
          marginBottom: 8,
        }}>
          ⚠ {state.message}
        </div>
      ) : null}

      {actionError ? (
        <div style={{
          fontSize: 11,
          color: 'var(--red)',
          background: 'var(--surface2)',
          border: '1px dashed var(--red)',
          borderRadius: 3,
          padding: '6px 10px',
          marginBottom: 8,
        }}>
          ⚠ {actionError}
        </div>
      ) : null}

      {state.kind === 'loading' ? (
        <div style={{ fontSize: 11, color: 'var(--text3)' }}>Loading…</div>
      ) : items.length === 0 ? (
        <div style={{
          fontSize: 12,
          color: 'var(--text3)',
          background: 'var(--surface)',
          border: '1px dashed var(--border2)',
          borderRadius: 4,
          padding: 12,
          textAlign: 'center',
        }}>
          No pending submissions.
        </div>
      ) : (
        <div className="responsive-table-wrap">
        <table style={{ width: '100%', minWidth: 760, borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'var(--surface2)', borderBottom: '1px solid var(--border)' }}>
              <SortableHeader sortKey="provider" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} style={th}>Provider</SortableHeader>
              <SortableHeader sortKey="label" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} style={th}>Label</SortableHeader>
              <SortableHeader sortKey="client" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} style={th}>Client</SortableHeader>
              <SortableHeader sortKey="account" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} style={th}>Account ID</SortableHeader>
              <SortableHeader sortKey="source" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} style={th}>Source</SortableHeader>
              <SortableHeader sortKey="submitted" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} align="right" style={{ ...th, textAlign: 'right' }}>Submitted</SortableHeader>
              <th style={{ ...th, textAlign: 'right' }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {sortedItems.map((item) => (
              <tr key={item.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={td}><b>{item.provider.toUpperCase()}</b></td>
                <td style={td}>{item.label ?? <span style={{ color: 'var(--text3)' }}>—</span>}</td>
                <td style={td}>
                  {item.clientId != null ? (
                    <span style={{ fontFamily: 'monospace' }}>#{item.clientId}</span>
                  ) : (
                    <span style={{ color: 'var(--text3)' }}>(none)</span>
                  )}
                </td>
                <td style={{ ...td, fontFamily: 'monospace', fontSize: 11 }}>
                  {item.accountIdentifier ?? <span style={{ color: 'var(--text3)' }}>—</span>}
                </td>
                <td style={td}>
                  <span style={{
                    background: 'var(--surface2)',
                    border: '1px solid var(--border)',
                    borderRadius: 2,
                    padding: '1px 5px',
                    fontSize: 10,
                    color: 'var(--text2)',
                  }}>{item.source}</span>
                </td>
                <td style={{ ...td, textAlign: 'right', color: 'var(--text3)', fontSize: 11 }}>
                  {formatCaDateShort(item.createdAt)}{' '}
                  <span style={{ fontSize: 10 }}>{formatCaTimeOnly(item.createdAt)} CA</span>
                </td>
                <td style={{ ...td, textAlign: 'right' }}>
                  <div style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end' }}>
                    {/* Approve — promote source='portal' → 'admin'.
                        Primary action (filled brand color) because it's
                        the typical happy path for an inbound submission. */}
                    <button
                      type="button"
                      onClick={() => handleApprove(item.id, item.label)}
                      disabled={!!approving[item.id] || !!removing[item.id]}
                      title="Promote to admin · makes this carrier usable for rate-shop and assignable to multiple clients"
                      style={{
                        padding: '3px 10px',
                        border: '1px solid rgb(var(--brand-rgb, 42 91 215))',
                        borderRadius: 3,
                        background: 'rgb(var(--brand-rgb, 42 91 215))',
                        color: '#fff',
                        fontSize: 11,
                        fontWeight: 700,
                        cursor: approving[item.id] ? 'wait' : 'pointer',
                        opacity: approving[item.id] || removing[item.id] ? 0.65 : 1,
                      }}
                    >
                      {approving[item.id] ? 'Approving…' : '✓ Approve'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemove(item.id)}
                      disabled={!!removing[item.id] || !!approving[item.id]}
                      title="Permanently delete this submission"
                      style={{
                        padding: '3px 10px',
                        border: '1px solid var(--red)',
                        borderRadius: 3,
                        background: 'transparent',
                        color: 'var(--red)',
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: removing[item.id] ? 'wait' : 'pointer',
                        opacity: approving[item.id] || removing[item.id] ? 0.65 : 1,
                      }}
                    >
                      {removing[item.id] ? 'Removing…' : 'Remove'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  )
}

const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '6px 8px',
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  color: 'var(--text3)',
}

const td: React.CSSProperties = {
  padding: '6px 8px',
  verticalAlign: 'middle',
}
