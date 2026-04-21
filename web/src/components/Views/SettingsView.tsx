// @ts-nocheck
import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { apiClient } from '../../api/client'
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
