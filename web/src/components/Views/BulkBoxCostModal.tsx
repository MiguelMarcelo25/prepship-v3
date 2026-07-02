// PS-311 (slice 3): operator UI to bulk-apply a reviewed box cost to EVERY order billed for a
// given box in the current (client + date range). PREVIEW-FIRST + gated: it calls the read-only
// /billing/box-cost/bulk/preview to show the exact impact (orders affected / finalized-skipped /
// before→after invoice total), and the Apply button stays DISABLED until a cost is entered, a
// preview has been fetched, and the operator ticks the confirm box. Apply calls
// /billing/box-cost/bulk/apply (the backend writes billing_box_resolutions + regenerates + audits;
// finalized invoices are never touched). Thin consumer — owns no money logic of its own.
import { useState } from 'react'
import { api } from '../../lib/api'

type BulkBoxCostPreview = {
  matchedOrderCount: number
  finalizedOrderCount: number
  editableOrderCount: number
  newCost: number
  beforeTotal: number
  afterTotal: number
  delta: number
  sampleOrderNumbers: string[]
}

type BulkBoxCostApplyResult = {
  matchedOrderCount: number
  appliedOrderCount: number
  skippedFinalizedCount: number
  newCost: number
}

export type BulkBoxCostModalProps = {
  clientId: number
  clientName: string
  dateFrom: string
  dateTo: string
  packageId: number
  packageLabel: string
  initialCost?: string | number | null
  onClose: () => void
  onApplied: () => void
}

function money(n: number): string {
  return `$${(Number.isFinite(n) ? n : 0).toFixed(2)}`
}

function initialCostString(value: string | number | null | undefined): string {
  if (value == null) return ''
  const trimmed = String(value).trim()
  if (!trimmed) return ''
  const numeric = Number(trimmed)
  return Number.isFinite(numeric) ? numeric.toFixed(2) : trimmed
}

export default function BulkBoxCostModal(props: BulkBoxCostModalProps) {
  const [cost, setCost] = useState(() => initialCostString(props.initialCost))
  const [preview, setPreview] = useState<BulkBoxCostPreview | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [doneMsg, setDoneMsg] = useState<string | null>(null)

  const costNum = Number(cost)
  const costValid = cost.trim() !== '' && Number.isFinite(costNum) && costNum >= 0

  const scopeBody = () => ({
    clientId: props.clientId,
    dateFrom: props.dateFrom,
    dateTo: props.dateTo,
    packageId: props.packageId,
    newCost: costNum,
  })

  async function runPreview() {
    if (!costValid) return
    setBusy(true)
    setError(null)
    setConfirmed(false)
    setDoneMsg(null)
    try {
      const res = await api.post('/billing/box-cost/bulk/preview', scopeBody())
      setPreview((res as { data?: BulkBoxCostPreview } | null)?.data ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Preview failed')
      setPreview(null)
    } finally {
      setBusy(false)
    }
  }

  async function runApply() {
    if (!preview || !confirmed || preview.editableOrderCount === 0 || !costValid) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.post('/billing/box-cost/bulk/apply', {
        ...scopeBody(),
        note: `Bulk box-cost review: ${props.packageLabel}`,
      })
      const r = (res as { data?: BulkBoxCostApplyResult } | null)?.data
      setDoneMsg(
        `Applied to ${r?.appliedOrderCount ?? 0} order(s)` +
          (r && r.skippedFinalizedCount > 0 ? `, skipped ${r.skippedFinalizedCount} finalized invoice(s)` : '') +
          '.',
      )
      props.onApplied()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Apply failed')
    } finally {
      setBusy(false)
    }
  }

  const applyDisabled =
    busy || doneMsg != null || !preview || !confirmed || preview.editableOrderCount === 0 || !costValid

  return (
    <div
      data-bulk-box-cost-modal
      role="dialog"
      aria-label="Bulk set box cost"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) props.onClose()
      }}
    >
      <div
        style={{
          background: 'var(--surface, #fff)',
          color: 'var(--text)',
          borderRadius: 12,
          padding: 20,
          width: 460,
          maxWidth: '92vw',
          boxShadow: '0 10px 40px rgba(0,0,0,0.25)',
          fontSize: 13,
        }}
      >
        <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>Set this box cost across the date range</h3>
        <div style={{ fontSize: 11.5, opacity: 0.8, marginBottom: 14 }}>
          Box <strong>{props.packageLabel}</strong> · Client <strong>{props.clientName}</strong> ·{' '}
          {props.dateFrom} → {props.dateTo}
        </div>

        <label style={{ display: 'block', marginBottom: 10 }}>
          <span style={{ display: 'block', fontSize: 11.5, opacity: 0.85, marginBottom: 4 }}>New box cost ($ per order)</span>
          <input
            data-bulk-box-cost-input
            type="number"
            min="0"
            step="0.01"
            value={cost}
            onChange={(e) => {
              setCost(e.target.value)
              setPreview(null)
              setConfirmed(false)
              setDoneMsg(null)
            }}
            style={{ width: 140, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border, #ccc)' }}
          />
        </label>

        <button
          className="btn btn-secondary btn-xs"
          type="button"
          disabled={!costValid || busy}
          onClick={() => void runPreview()}
        >
          {busy && !preview ? 'Previewing…' : 'Preview impact'}
        </button>

        {error ? (
          <div role="alert" style={{ marginTop: 10, color: '#b91c1c', fontSize: 12 }}>
            {error}
          </div>
        ) : null}

        {preview ? (
          <div
            style={{
              marginTop: 12,
              padding: 12,
              borderRadius: 8,
              background: 'rgba(59,130,246,0.06)',
              border: '1px solid #bfdbfe',
              fontSize: 12,
            }}
          >
            <div>
              <strong>{preview.editableOrderCount}</strong> order(s) will be re-priced to{' '}
              <strong>{money(preview.newCost)}</strong> each.
            </div>
            {preview.finalizedOrderCount > 0 ? (
              <div style={{ color: '#b45309', marginTop: 2 }}>
                {preview.finalizedOrderCount} finalized (invoiced) order(s) will be SKIPPED.
              </div>
            ) : null}
            <div style={{ marginTop: 4 }}>
              Box-cost total: <strong>{money(preview.beforeTotal)}</strong> →{' '}
              <strong>{money(preview.afterTotal)}</strong> (
              {preview.delta >= 0 ? '+' : ''}
              {money(preview.delta)})
            </div>
            {preview.sampleOrderNumbers.length ? (
              <div style={{ marginTop: 4, opacity: 0.75 }}>e.g. {preview.sampleOrderNumbers.join(', ')}</div>
            ) : null}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10 }}>
              <input
                data-bulk-box-cost-confirm
                type="checkbox"
                checked={confirmed}
                disabled={preview.editableOrderCount === 0 || doneMsg != null}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              I confirm re-pricing these {preview.editableOrderCount} order(s).
            </label>
          </div>
        ) : null}

        {doneMsg ? (
          <div role="status" style={{ marginTop: 12, color: '#15803d', fontSize: 12, fontWeight: 600 }}>
            ✓ {doneMsg}
          </div>
        ) : null}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className="btn btn-secondary btn-xs" type="button" disabled={busy} onClick={props.onClose}>
            {doneMsg ? 'Close' : 'Cancel'}
          </button>
          <button className="btn btn-primary btn-xs" type="button" disabled={applyDisabled} onClick={() => void runApply()}>
            {busy && preview ? 'Applying…' : 'Apply to editable orders'}
          </button>
        </div>
      </div>
    </div>
  )
}
