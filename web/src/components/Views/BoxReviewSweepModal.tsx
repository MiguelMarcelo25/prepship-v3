// PS-311b: the NEEDS-REVIEW box-cost sweep modal. Opened from the Edit Billing Detail modal's
// "Box needs review" section. The operator picks a START and END date RIGHT HERE, types the box
// cost, previews EXACTLY which same-box-size bills will change (before/after), then applies — and
// every still-unmatched order with the SAME box (e.g. Custom 6.5x4x2) in that (client + range) gets
// the cost, persistently. Thin consumer: owns no money logic — the backend re-derives the box
// signature from the source order, scopes by client, skips finalized invoices, and writes the
// durable billing_box_resolutions override. Cross-client isolation is enforced server-side.
import { useState } from 'react'
import { api } from '../../lib/api'

type ByDimsPreview = {
  matchedOrderCount: number
  finalizedOrderCount: number
  editableOrderCount: number
  newCost: number
  beforeTotal: number
  afterTotal: number
  delta: number
  sampleOrderNumbers: string[]
  signature: string | null
}

type ByDimsApplyResult = {
  matchedOrderCount: number
  appliedOrderCount: number
  skippedFinalizedCount: number
  newCost: number
  signature: string | null
}

export type BoxReviewSweepModalProps = {
  clientId: number
  clientName: string
  sourceOrderId: number
  boxLabel: string
  initialFrom: string
  initialTo: string
  onClose: () => void
  onApplied: () => void
}

function money(n: number): string {
  return `$${(Number.isFinite(n) ? n : 0).toFixed(2)}`
}

export default function BoxReviewSweepModal(props: BoxReviewSweepModalProps) {
  const [from, setFrom] = useState(props.initialFrom)
  const [to, setTo] = useState(props.initialTo)
  const [cost, setCost] = useState('')
  const [preview, setPreview] = useState<ByDimsPreview | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [doneMsg, setDoneMsg] = useState<string | null>(null)
  const [undoneMsg, setUndoneMsg] = useState<string | null>(null)

  const costNum = Number(cost)
  const costValid = cost.trim() !== '' && Number.isFinite(costNum) && costNum >= 0
  const rangeValid = from.trim() !== '' && to.trim() !== '' && from <= to

  const scopeBody = () => ({
    clientId: props.clientId,
    dateFrom: from,
    dateTo: to,
    sourceOrderId: props.sourceOrderId,
    newCost: costNum,
  })

  // Any change to the inputs invalidates a stale preview, so Apply can never fire on old numbers.
  function resetPreview() {
    setPreview(null)
    setConfirmed(false)
    setDoneMsg(null)
    setUndoneMsg(null)
  }

  async function runPreview() {
    if (!costValid || !rangeValid) return
    setBusy(true)
    setError(null)
    setConfirmed(false)
    setDoneMsg(null)
    try {
      const res = await api.post('/billing/box-cost/by-dims/preview', scopeBody())
      setPreview((res as { data?: ByDimsPreview } | null)?.data ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Preview failed')
      setPreview(null)
    } finally {
      setBusy(false)
    }
  }

  async function runApply() {
    if (!preview || !confirmed || preview.editableOrderCount === 0 || !costValid || !rangeValid) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.post('/billing/box-cost/by-dims/apply', scopeBody())
      const r = (res as { data?: ByDimsApplyResult } | null)?.data
      setDoneMsg(
        `Applied to ${r?.appliedOrderCount ?? 0} bill(s)` +
          (r && r.skippedFinalizedCount > 0 ? `, skipped ${r.skippedFinalizedCount} finalized invoice(s)` : '') +
          '.',
      )
      setUndoneMsg(null)
      props.onApplied()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Apply failed')
    } finally {
      setBusy(false)
    }
  }

  // Undo the sweep just applied: the backend re-derives the marker from this order and removes only
  // the resolutions the sweep created, sending those bills back to needs-review.
  async function runUndo() {
    setBusy(true)
    setError(null)
    try {
      const res = await api.post('/billing/box-cost/by-dims/revert', {
        clientId: props.clientId,
        dateFrom: from,
        dateTo: to,
        sourceOrderId: props.sourceOrderId,
      })
      const r = (res as { data?: { revertedOrderCount: number; skippedFinalizedCount?: number } } | null)?.data
      setDoneMsg(null)
      setUndoneMsg(
        `Reverted ${r?.revertedOrderCount ?? 0} bill(s) back to needs review` +
          (r && r.skippedFinalizedCount && r.skippedFinalizedCount > 0
            ? `, kept ${r.skippedFinalizedCount} finalized invoice(s) unchanged`
            : '') +
          '.',
      )
      props.onApplied()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Undo failed')
    } finally {
      setBusy(false)
    }
  }

  const applyDisabled =
    busy || doneMsg != null || !preview || !confirmed || preview.editableOrderCount === 0 || !costValid || !rangeValid

  const dateInputStyle = { padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border, #ccc)', fontSize: 12 }

  return (
    <div
      data-box-review-sweep-modal
      role="dialog"
      aria-label="Set box cost across a date range"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1100,
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
          width: 480,
          maxWidth: '92vw',
          boxShadow: '0 10px 40px rgba(0,0,0,0.25)',
          fontSize: 13,
        }}
      >
        <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>Set this box cost across a date range</h3>
        <div style={{ fontSize: 11.5, opacity: 0.8, marginBottom: 14 }}>
          Box <strong>{props.boxLabel}</strong> · Client <strong>{props.clientName}</strong> — applies only to{' '}
          <strong>needs-review</strong> bills of this box size in <strong>{props.clientName}</strong> (no other store).
        </div>

        {/* The date range picker lives HERE — Start + End are editable, default to the current range. */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11.5, opacity: 0.85 }}>Start date</span>
            <input
              data-box-review-sweep-from
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => {
                setFrom(e.target.value)
                resetPreview()
              }}
              style={dateInputStyle}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11.5, opacity: 0.85 }}>End date</span>
            <input
              data-box-review-sweep-to
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => {
                setTo(e.target.value)
                resetPreview()
              }}
              style={dateInputStyle}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11.5, opacity: 0.85 }}>Box cost ($ per bill)</span>
            <input
              data-box-review-sweep-cost
              type="number"
              min="0"
              step="0.01"
              value={cost}
              onChange={(e) => {
                setCost(e.target.value)
                resetPreview()
              }}
              style={{ width: 130, ...dateInputStyle }}
            />
          </label>
        </div>

        {!rangeValid && from && to ? (
          <div style={{ color: '#b45309', fontSize: 11.5, marginBottom: 8 }}>Start date must be on or before the end date.</div>
        ) : null}

        <button
          className="btn btn-secondary btn-xs"
          type="button"
          disabled={!costValid || !rangeValid || busy}
          onClick={() => void runPreview()}
        >
          {busy && !preview ? 'Previewing…' : 'Preview what changes'}
        </button>

        {error ? (
          <div role="alert" style={{ marginTop: 10, color: '#b91c1c', fontSize: 12 }}>
            {error}
          </div>
        ) : null}

        {preview && preview.signature == null ? (
          <div style={{ marginTop: 12, padding: 12, borderRadius: 8, background: 'rgba(245,158,11,0.10)', border: '1px solid #fde68a', fontSize: 12 }}>
            This bill is not a needs-review box, so there is nothing to sweep.
          </div>
        ) : preview ? (
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
              <strong>{preview.editableOrderCount}</strong> needs-review bill(s) with box{' '}
              <strong>{props.boxLabel}</strong> will be set to <strong>{money(preview.newCost)}</strong> each.
            </div>
            {preview.finalizedOrderCount > 0 ? (
              <div style={{ color: '#b45309', marginTop: 2 }}>
                {preview.finalizedOrderCount} finalized (invoiced) bill(s) will be SKIPPED.
              </div>
            ) : null}
            <div style={{ marginTop: 4 }}>
              Box-cost total: <strong>{money(preview.beforeTotal)}</strong> → <strong>{money(preview.afterTotal)}</strong> (
              {preview.delta >= 0 ? '+' : ''}
              {money(preview.delta)})
            </div>
            {preview.sampleOrderNumbers.length ? (
              <div style={{ marginTop: 4, opacity: 0.75 }}>e.g. {preview.sampleOrderNumbers.join(', ')}</div>
            ) : null}
            {preview.editableOrderCount === 0 ? (
              <div style={{ marginTop: 6, color: '#b45309' }}>No editable needs-review bills of this box in the selected range.</div>
            ) : (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10 }}>
                <input
                  data-box-review-sweep-confirm
                  type="checkbox"
                  checked={confirmed}
                  disabled={doneMsg != null}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                I confirm changing these {preview.editableOrderCount} bill(s).
              </label>
            )}
          </div>
        ) : null}

        {doneMsg ? (
          <div role="status" style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ color: '#15803d', fontSize: 12, fontWeight: 600 }}>✓ {doneMsg}</span>
            <button
              data-box-review-sweep-undo
              className="btn btn-ghost btn-xs"
              type="button"
              disabled={busy}
              onClick={() => void runUndo()}
              title="Remove the cost this sweep just applied and send those bills back to needs review"
            >
              {busy ? 'Undoing…' : '↩ Undo this sweep'}
            </button>
          </div>
        ) : null}

        {undoneMsg ? (
          <div role="status" style={{ marginTop: 12, color: '#6b7280', fontSize: 12, fontWeight: 600 }}>
            ↩ {undoneMsg}
          </div>
        ) : null}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className="btn btn-secondary btn-xs" type="button" disabled={busy} onClick={props.onClose}>
            {doneMsg ? 'Close' : 'Cancel'}
          </button>
          <button className="btn btn-primary btn-xs" type="button" disabled={applyDisabled} onClick={() => void runApply()}>
            {busy && preview ? 'Applying…' : 'Apply across range'}
          </button>
        </div>
      </div>
    </div>
  )
}
