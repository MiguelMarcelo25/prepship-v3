// @ts-nocheck
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { apiClient } from '../../api/client'
import { api } from '../../lib/api'
import { useShippingAccounts } from '../../hooks'
import { ToastContext } from '../../contexts/ToastContext'
import { useMarkups } from '../../contexts/MarkupsContext'
import type { MarkupType } from '../../types/markups'
import {
  buildSettingsMarkupRows,
  buildSettingsRefetchStatus,
  getSettingsMarkupEmptyMessage,
  getSettingsMarkupSavedToastMessage,
  type SettingsRefetchState,
  parseSettingsMarkupInput,
} from './settings-parity'

export default function SettingsView() {
  const toastContext = useContext(ToastContext)
  const { accounts, isLoading: accountsLoading, error: accountsError } = useShippingAccounts()
  const { markups, loading: markupsLoading, saveMarkup } = useMarkups()
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [refetchState, setRefetchState] = useState<SettingsRefetchState>({ kind: 'idle' })
  const saveToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refetchResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestSaveRequestRef = useRef(0)

  const markupRows = useMemo(
    () => buildSettingsMarkupRows(accounts, markups, drafts),
    [accounts, markups, drafts],
  )

  const refetchStatus = buildSettingsRefetchStatus(refetchState)

  useEffect(() => () => {
    if (saveToastTimerRef.current) clearTimeout(saveToastTimerRef.current)
    if (refetchResetTimerRef.current) clearTimeout(refetchResetTimerRef.current)
  }, [])

  useEffect(() => {
    if (refetchState.kind !== 'success') return

    if (refetchResetTimerRef.current) clearTimeout(refetchResetTimerRef.current)
    refetchResetTimerRef.current = setTimeout(() => {
      setRefetchState({ kind: 'idle' })
    }, 5000)

    return () => {
      if (refetchResetTimerRef.current) clearTimeout(refetchResetTimerRef.current)
    }
  }, [refetchState])

  function queueMarkupSavedToast() {
    if (saveToastTimerRef.current) clearTimeout(saveToastTimerRef.current)
    saveToastTimerRef.current = setTimeout(() => {
      toastContext?.addToast(getSettingsMarkupSavedToastMessage(), 'success')
    }, 600)
  }

  function handleMarkupChange(shippingProviderId: number, nextType: MarkupType, nextValue: string) {
    setDrafts((current) => ({
      ...current,
      [shippingProviderId]: nextValue,
    }))

    latestSaveRequestRef.current += 1
    const requestId = latestSaveRequestRef.current
    queueMarkupSavedToast()

    void saveMarkup(shippingProviderId, nextType, parseSettingsMarkupInput(nextValue)).catch((error) => {
      if (requestId !== latestSaveRequestRef.current) return
      if (saveToastTimerRef.current) clearTimeout(saveToastTimerRef.current)
      toastContext?.addToast(error instanceof Error ? error.message : 'Failed to save markup', 'error')
    })
  }

  // ── Sandbox / test orders ────────────────────────────────────────────────
  const [testClients, setTestClients] = useState<
    Array<{ id: number; name: string; order_count: number }>
  >([])
  const [sandboxState, setSandboxState] = useState<
    | { kind: 'idle' }
    | { kind: 'loading'; op: 'seed' | 'purge' | 'refresh' }
    | { kind: 'success'; message: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' })
  const [seedCount, setSeedCount] = useState<string>('25')

  const refreshTestClients = useCallback(async () => {
    try {
      const res = await api.get<{
        data: Array<{ id: number; name: string; order_count: number }>
      }>('/admin/test-clients')
      setTestClients(res.data ?? [])
    } catch (err) {
      setSandboxState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to load test clients',
      })
    }
  }, [])

  useEffect(() => {
    void refreshTestClients()
  }, [refreshTestClients])

  async function handleSeedTestOrders() {
    const count = Number.parseInt(seedCount, 10)
    if (!Number.isFinite(count) || count <= 0) {
      toastContext?.addToast('Enter a positive seed count', 'error')
      return
    }
    setSandboxState({ kind: 'loading', op: 'seed' })
    try {
      const res = await api.post<{ seeded: number; clientName: string }>(
        '/admin/seed-test-orders',
        { count }
      )
      setSandboxState({
        kind: 'success',
        message: `Seeded ${res.seeded} test order(s) under "${res.clientName}"`,
      })
      toastContext?.addToast(`✅ Seeded ${res.seeded} test orders`, 'success')
      await refreshTestClients()
    } catch (err) {
      setSandboxState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Seed failed',
      })
    }
  }

  async function handlePurgeTestOrders() {
    if (
      !window.confirm(
        'Delete every order under every test-flagged client?\n\n' +
          'This also deletes their shipments, billing lines, and inventory ledger entries. ' +
          'This cannot be undone.'
      )
    ) {
      return
    }
    setSandboxState({ kind: 'loading', op: 'purge' })
    try {
      const res = await api.post<{
        deleted: {
          orders: number
          shipments: number
          ledger: number
          billing: number
        }
      }>('/admin/purge-test-orders', {})
      const d = res.deleted
      setSandboxState({
        kind: 'success',
        message: `Deleted ${d.orders} order(s), ${d.shipments} shipment(s), ${d.ledger} ledger entries, ${d.billing} billing line(s)`,
      })
      toastContext?.addToast(`🧹 Purged ${d.orders} test orders`, 'success')
      await refreshTestClients()
    } catch (err) {
      setSandboxState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Purge failed',
      })
    }
  }

  async function handleRefetchAllRates() {
    setRefetchState({ kind: 'loading' })

    try {
      const result = await apiClient.clearAndRefetchAllRates()
      setRefetchState({ kind: 'success', result })
    } catch (error) {
      setRefetchState({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }

  return (
    <div id="view-settings" className="view-content">
      <h2 style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)', marginBottom: 3 }}>⚙️ Markup Settings</h2>
      <p style={{ color: 'var(--text3)', fontSize: 12, marginBottom: 16 }}>$ or % markup added per carrier account — applied to displayed rates in the Rate Browser.</p>

      <div className="markup-card">
        <h3>Rate Browser — Account Markups</h3>
        <p style={{ fontSize: 11.5, color: 'var(--text3)', margin: '0 0 12px' }}>$ or % added to displayed rates per carrier account. Useful for billing clients above cost.</p>
        <div id="settings-rb-markups">
          {markupRows.length > 0 ? markupRows.map((row) => (
            <div key={row.shippingProviderId} className="markup-row">
              <span className="markup-label">{row.label}</span>
              <select
                value={row.type}
                onChange={(event) => handleMarkupChange(row.shippingProviderId, event.target.value as MarkupType, row.inputValue)}
                style={{
                  width: 52,
                  marginRight: 4,
                  border: '1px solid var(--border)',
                  borderRadius: 3,
                  padding: '3px 2px',
                  background: 'var(--surface)',
                  fontSize: 12,
                  color: 'var(--text)',
                }}
                aria-label={`${row.label} markup type`}
              >
                <option value="flat">$</option>
                <option value="pct">%</option>
              </select>
              <input
                className="markup-input-lg"
                type="number"
                min="0"
                step="0.25"
                value={row.inputValue}
                placeholder="0"
                onChange={(event) => handleMarkupChange(row.shippingProviderId, row.type, event.target.value)}
                aria-label={`${row.label} markup value`}
              />
              <span className="markup-preview mu-preview">{row.preview}</span>
            </div>
          )) : (
            <span style={{ fontSize: 12, color: 'var(--text3)' }}>
              {accountsLoading || markupsLoading ? 'Loading carrier accounts...' : getSettingsMarkupEmptyMessage()}
            </span>
          )}
        </div>
        {accountsError ? (
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--red)' }}>
            ⚠ Unable to refresh carrier accounts: {accountsError.message}
          </div>
        ) : null}
      </div>

      <div className="markup-card" style={{ marginTop: 16 }}>
        <h3>🧪 Sandbox — Test Orders</h3>
        <p style={{ fontSize: 11.5, color: 'var(--text3)', margin: '0 0 12px' }}>
          Clients flagged <code>is_test=true</code> are fully isolated: their orders never sync from ShipStation, never create real postage, never bill, and never touch inventory.
        </p>

        {testClients.length > 0 ? (
          <div style={{ marginBottom: 12, fontSize: 12, color: 'var(--text2)' }}>
            <b>Active test clients:</b>
            <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
              {testClients.map((c) => (
                <li key={c.id}>
                  {c.name}{' '}
                  <span style={{ color: 'var(--text3)' }}>
                    — {c.order_count} order{c.order_count === 1 ? '' : 's'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div style={{ marginBottom: 12, fontSize: 12, color: 'var(--orange, #d97706)' }}>
            ⚠ No clients flagged <code>is_test=true</code>. Run the purge SQL in the Supabase editor first — see <code>drizzle/apply-test-client-purge.sql</code>.
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12, color: 'var(--text2)' }}>
            Count:{' '}
            <input
              type="number"
              min="1"
              max="200"
              value={seedCount}
              onChange={(e) => setSeedCount(e.target.value)}
              style={{
                width: 70,
                padding: '3px 6px',
                border: '1px solid var(--border)',
                borderRadius: 3,
                background: 'var(--surface)',
                color: 'var(--text)',
                fontSize: 12,
              }}
            />
          </label>
          <button
            type="button"
            onClick={() => void handleSeedTestOrders()}
            disabled={sandboxState.kind === 'loading' || testClients.length === 0}
            style={{
              padding: '6px 14px',
              background: '#d97706',
              color: 'white',
              border: 'none',
              borderRadius: 4,
              cursor: sandboxState.kind === 'loading' || testClients.length === 0 ? 'default' : 'pointer',
              fontSize: 13,
              fontWeight: 600,
              opacity: sandboxState.kind === 'loading' || testClients.length === 0 ? 0.5 : 1,
            }}
          >
            🧪 Seed Test Orders
          </button>
          <button
            type="button"
            onClick={() => void handlePurgeTestOrders()}
            disabled={sandboxState.kind === 'loading' || testClients.length === 0}
            style={{
              padding: '6px 14px',
              background: 'var(--red, #dc2626)',
              color: 'white',
              border: 'none',
              borderRadius: 4,
              cursor: sandboxState.kind === 'loading' || testClients.length === 0 ? 'default' : 'pointer',
              fontSize: 13,
              fontWeight: 600,
              opacity: sandboxState.kind === 'loading' || testClients.length === 0 ? 0.5 : 1,
            }}
          >
            🧹 Purge Test Orders
          </button>
        </div>

        {sandboxState.kind !== 'idle' ? (
          <div
            style={{
              marginTop: 8,
              fontSize: 12,
              color:
                sandboxState.kind === 'error'
                  ? 'var(--red)'
                  : sandboxState.kind === 'success'
                    ? 'var(--green, #16a34a)'
                    : 'var(--text3)',
            }}
          >
            {sandboxState.kind === 'loading'
              ? sandboxState.op === 'seed'
                ? 'Seeding…'
                : sandboxState.op === 'purge'
                  ? 'Purging…'
                  : 'Loading…'
              : sandboxState.kind === 'error'
                ? `✗ ${sandboxState.message}`
                : `✓ ${sandboxState.message}`}
          </div>
        ) : null}
      </div>

      <div className="markup-card" style={{ marginTop: 16 }}>
        <h3>Cache Management</h3>
        <p style={{ fontSize: 11.5, color: 'var(--text3)', margin: '0 0 12px' }}>Clear rate cache and refetch all rates for awaiting_shipment orders.</p>
        <button
          id="btn-refetch-all-rates"
          type="button"
          onClick={() => void handleRefetchAllRates()}
          disabled={refetchState.kind === 'loading'}
          style={{
            padding: '8px 16px',
            background: 'var(--ss-blue)',
            color: 'white',
            border: 'none',
            borderRadius: 4,
            cursor: refetchState.kind === 'loading' ? 'default' : 'pointer',
            fontSize: 13,
            fontWeight: 600,
            transition: 'background 200ms',
            opacity: refetchState.kind === 'loading' ? 0.5 : 1,
          }}
          onMouseEnter={(event) => {
            if (refetchState.kind !== 'loading') event.currentTarget.style.background = 'var(--ss-blue2)'
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.background = 'var(--ss-blue)'
          }}
        >
          🔄 Refetch All Rates &amp; Clear Cache
        </button>
        <div
          id="refetch-status"
          style={{
            marginTop: 8,
            fontSize: 12,
            color: refetchStatus.color,
            display: refetchStatus.visible ? 'block' : 'none',
          }}
        >
          {refetchStatus.text}
        </div>
      </div>
    </div>
  )
}
