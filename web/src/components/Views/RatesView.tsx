// @ts-nocheck
import { useContext, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { RateDto } from '@prepshipv2/contracts/rates/contracts'
import { apiClient } from '../../api/client'
import { ToastContext } from '../../contexts/ToastContext'
import {
  buildLiveRatesPayload,
  buildRateRows,
  buildRateSelectionToast,
  buildRatesMetaLabel,
  buildRatesSummary,
  getAvailableRates,
  getCarrierBadgeClass,
  getRatesValidationState,
  parseRatesNumber,
  type RatesEmptyState,
  type RatesFormState,
} from './rates-parity'

const DEFAULT_FORM: RatesFormState = {
  weightOz: '16',
  lengthIn: '12',
  widthIn: '9',
  heightIn: '4',
  fromZip: '90248',
  toZip: '',
  markup: '1.00',
}

type RatesResultState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'empty'; empty: RatesEmptyState }
  | { kind: 'error'; message: string }
  | { kind: 'table'; rates: RateDto[] }

function formatMoney(amount: number) {
  return `$${amount.toFixed(2)}`
}

export default function RatesView() {
  const toastContext = useContext(ToastContext)
  const [form, setForm] = useState<RatesFormState>(DEFAULT_FORM)
  const [resultState, setResultState] = useState<RatesResultState>({ kind: 'idle' })

  const markupValue = parseRatesNumber(form.markup)
  const rows = resultState.kind === 'table'
    ? buildRateRows(resultState.rates, markupValue)
    : []

  async function fetchRates() {
    const validation = getRatesValidationState(form)
    if (validation) {
      setResultState({ kind: 'empty', empty: validation })
      return
    }

    setResultState({ kind: 'loading' })

    try {
      const allRates = await apiClient.fetchRates(buildLiveRatesPayload(form))
      if (!Array.isArray(allRates) || allRates.length === 0) {
        setResultState({ kind: 'empty', empty: { icon: '📭', message: 'No rates returned.' } })
        return
      }

      const availableRates = getAvailableRates(allRates)
      if (availableRates.length === 0) {
        setResultState({ kind: 'empty', empty: { icon: '📭', message: 'No available rates returned.' } })
        return
      }

      setResultState({ kind: 'table', rates: availableRates })
    } catch (error) {
      setResultState({ kind: 'error', message: error instanceof Error ? error.message : 'Unknown error' })
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void fetchRates()
  }

  function handleMarkupBlur() {
    void fetchRates()
  }

  function handleMarkupKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return
    event.preventDefault()
    void fetchRates()
  }

  return (
    <div className="view-content" id="view-rates">
      <form className="rate-form" onSubmit={handleSubmit}>
        <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 12, color: 'var(--text)' }}>⚖️ Rate Calculator</h3>
        <div className="form-grid">
          <div className="form-group"><label htmlFor="rWeight">Weight (oz)</label><input id="rWeight" type="number" min="1" value={form.weightOz} onChange={(event) => setForm((current) => ({ ...current, weightOz: event.target.value }))} /></div>
          <div className="form-group"><label htmlFor="rLength">Length (in)</label><input id="rLength" type="number" min="1" value={form.lengthIn} onChange={(event) => setForm((current) => ({ ...current, lengthIn: event.target.value }))} /></div>
          <div className="form-group"><label htmlFor="rWidth">Width (in)</label><input id="rWidth" type="number" min="1" value={form.widthIn} onChange={(event) => setForm((current) => ({ ...current, widthIn: event.target.value }))} /></div>
          <div className="form-group"><label htmlFor="rHeight">Height (in)</label><input id="rHeight" type="number" min="1" value={form.heightIn} onChange={(event) => setForm((current) => ({ ...current, heightIn: event.target.value }))} /></div>
          <div className="form-group"><label htmlFor="rFromZip">From ZIP</label><input id="rFromZip" type="text" value={form.fromZip} onChange={(event) => setForm((current) => ({ ...current, fromZip: event.target.value }))} /></div>
          <div className="form-group"><label htmlFor="rToZip">To ZIP</label><input id="rToZip" type="text" placeholder="e.g. 10001" value={form.toZip} onChange={(event) => setForm((current) => ({ ...current, toZip: event.target.value }))} /></div>
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 9, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" type="submit">🔍 Get Live Rates</button>
          <label style={{ fontSize: 12.5, color: 'var(--text2)', display: 'flex', alignItems: 'center', gap: 7, fontWeight: 500 }}>
            Markup $
            <input
              id="globalMarkup"
              type="number"
              value={form.markup}
              step="0.25"
              min="0"
              onChange={(event) => setForm((current) => ({ ...current, markup: event.target.value }))}
              onBlur={handleMarkupBlur}
              onKeyDown={handleMarkupKeyDown}
              style={{ width: 60, padding: '5px 7px', borderRadius: 5, border: '1px solid var(--border2)', background: 'var(--surface2)', color: 'var(--text)', fontSize: 12.5, textAlign: 'center' }}
            />
          </label>
        </div>
      </form>

      <div id="ratesResult">
        {resultState.kind === 'loading' ? (
          <div className="loading"><div className="spinner" /><div>Fetching live rates…</div></div>
        ) : null}

        {resultState.kind === 'empty' ? (
          <div className="empty-state">
            <div className="empty-icon">{resultState.empty.icon}</div>
            <div>{resultState.empty.message}</div>
          </div>
        ) : null}

        {resultState.kind === 'error' ? (
          <div className="empty-state">
            <div className="empty-icon">⚠️</div>
            <div>Error: {resultState.message}</div>
          </div>
        ) : null}

        {resultState.kind === 'table' ? (
          <div style={{ background: 'var(--surface)', borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', boxShadow: 'var(--shadow)' }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'var(--surface2)', display: 'flex', gap: 8, alignItems: 'center' }}>
              <strong style={{ color: 'var(--text)' }}>{buildRatesSummary(form, rows.length)}</strong>
              <span style={{ fontSize: 11.5, color: 'var(--text3)' }}>{buildRatesMetaLabel(form)}</span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="rates-table">
                <thead>
                  <tr>
                    <th>Carrier</th>
                    <th>Service</th>
                    <th>Base Cost</th>
                    <th>Your Price</th>
                    <th>Profit</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={`${row.rate.carrierCode}-${row.rate.shippingProviderId ?? 'na'}-${row.rate.serviceCode}`} className={row.isBest ? 'best-rate' : undefined}>
                      <td>
                        <span className={`carrier-badge ${getCarrierBadgeClass(row.carrierCode)}`} style={{ fontSize: 9.5, padding: '1px 5px' }}>
                          {row.carrierBadgeLabel}
                        </span>
                      </td>
                      <td>
                        {row.serviceLabel} {row.isBest ? <span className="best-badge">✓ CHEAPEST</span> : null}
                      </td>
                      <td style={{ fontWeight: 700 }}>{formatMoney(row.baseCost)}</td>
                      <td style={{ color: 'var(--orange)', fontWeight: 700 }}>{formatMoney(row.yourPrice)}</td>
                      <td style={{ color: 'var(--green)', fontWeight: 600 }}>+{formatMoney(row.profit)}</td>
                      <td>
                        <button
                          className="btn btn-primary btn-xs"
                          type="button"
                          onClick={() => toastContext?.addToast(buildRateSelectionToast(row))}
                        >
                          Select
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
