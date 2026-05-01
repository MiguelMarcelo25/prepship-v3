// @ts-nocheck
import { useEffect, useState } from 'react'
import { callVercelFunction } from '../../lib/vercelFunction'
import { api } from '../../lib/api'

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

// Lists carrier_accounts rows with source='portal'. The natural-key index on
// (client_id, provider, account_identifier) means duplicates against existing
// admin-added rows simply won't insert — sync becomes idempotent. Admin can
// remove pending entries here; approval/merge flow comes in a follow-up.
export function PendingClientIntegrationsCard() {
  const [items, setItems] = useState<PendingIntegration[]>([])
  const [state, setState] = useState<{ kind: 'idle' | 'loading' | 'error'; message?: string }>({ kind: 'idle' })
  const [removing, setRemoving] = useState<Record<number, boolean>>({})
  const [actionError, setActionError] = useState<string | null>(null)

  const refresh = async () => {
    setState({ kind: 'loading' })
    try {
      const res = await callVercelFunction<{ data: PendingIntegration[] }>('/carrier-accounts?source=portal&pending=1')
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
        const res = await callVercelFunction<{ data: PendingIntegration[] }>('/carrier-accounts?source=portal&pending=1')
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
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'var(--surface2)', borderBottom: '1px solid var(--border)' }}>
              <th style={th}>Provider</th>
              <th style={th}>Label</th>
              <th style={th}>Client</th>
              <th style={th}>Account ID</th>
              <th style={th}>Source</th>
              <th style={{ ...th, textAlign: 'right' }}>Submitted</th>
              <th style={{ ...th, textAlign: 'right' }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
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
                  {new Date(item.createdAt).toLocaleDateString()}{' '}
                  <span style={{ fontSize: 10 }}>{new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </td>
                <td style={{ ...td, textAlign: 'right' }}>
                  <button
                    type="button"
                    onClick={() => handleRemove(item.id)}
                    disabled={!!removing[item.id]}
                    style={{
                      padding: '3px 10px',
                      border: '1px solid var(--red)',
                      borderRadius: 3,
                      background: 'transparent',
                      color: 'var(--red)',
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: removing[item.id] ? 'wait' : 'pointer',
                    }}
                  >
                    {removing[item.id] ? 'Removing…' : 'Remove'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
