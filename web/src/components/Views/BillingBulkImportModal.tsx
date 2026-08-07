import { useMemo, useState } from 'react'
import { Check, Loader2, Plus, X } from 'lucide-react'
import type { PackageDto } from '../../types/api'
import type { BillingDetailDto } from './billing-parity'
import {
  BULK_IMPORT_STATUS_LABEL,
  bulkImportReadyRows,
  bulkImportRowsFromFields,
  parseBulkImportText,
  resolveBulkImportRows,
  type BulkImportReadyRow,
} from './billing-bulk-import'

export type BulkImportApplyOutcome = {
  lineNumber: number
  orderNumberRaw: string
  ok: boolean
  message: string
}

type ImportField = {
  id: number
  orderNumberRaw: string
  boxRaw: string
  shippingRaw: string
}

type BillingBulkImportModalProps = {
  clientName: string
  detailRows: BillingDetailDto[]
  packages: PackageDto[]
  onClose: () => void
  /** Applies one resolved row through the existing audited detail PATCH. */
  onApplyRow: (row: BulkImportReadyRow, reason: string) => Promise<void>
  onFinished: () => void
}

let nextFieldId = 1
function emptyField(): ImportField {
  return { id: nextFieldId++, orderNumberRaw: '', boxRaw: '', shippingRaw: '' }
}

export function BillingBulkImportModal({
  clientName,
  detailRows,
  packages,
  onClose,
  onApplyRow,
  onFinished,
}: BillingBulkImportModalProps) {
  const [fields, setFields] = useState<ImportField[]>(() => [emptyField(), emptyField(), emptyField()])
  const [reason, setReason] = useState('')
  const [applying, setApplying] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0, current: '', failed: 0 })
  const [outcomes, setOutcomes] = useState<BulkImportApplyOutcome[] | null>(null)
  /** Per-row apply state, keyed by field id, so each row shows its own outcome. */
  const [rowState, setRowState] = useState<
    Record<number, { state: 'applying' | 'done' | 'failed'; message?: string }>
  >({})

  const resolved = useMemo(
    () => resolveBulkImportRows(bulkImportRowsFromFields(fields), detailRows, packages),
    [fields, detailRows, packages],
  )
  // lineNumber is the 1-based index into `fields`, so status maps back to its row.
  const statusByFieldIndex = useMemo(() => {
    const map = new Map<number, (typeof resolved)[number]>()
    for (const row of resolved) map.set(row.lineNumber - 1, row)
    return map
  }, [resolved])

  const ready = useMemo(() => bulkImportReadyRows(resolved), [resolved])
  const problems = useMemo(() => resolved.filter((row) => row.status !== 'ready'), [resolved])
  const canApply = ready.length > 0 && reason.trim().length >= 3 && !applying

  function updateField(id: number, key: keyof Omit<ImportField, 'id'>, value: string) {
    setFields((current) => current.map((field) => (field.id === id ? { ...field, [key]: value } : field)))
    // Editing a row that already ran clears its old verdict, so a retyped row is
    // never shown as still Saved or still failed.
    setRowState((current) => {
      if (!current[id]) return current
      const next = { ...current }
      delete next[id]
      return next
    })
  }

  function addField() {
    setFields((current) => [...current, emptyField()])
  }

  function removeField(id: number) {
    setFields((current) => {
      const next = current.filter((field) => field.id !== id)
      return next.length ? next : [emptyField()]
    })
  }

  /**
   * Pasting multi-line text into any Order # cell fills the grid from that row
   * down, so a straight copy out of Sheets still works.
   */
  function onPasteIntoOrder(index: number, event: React.ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData('text')
    if (!text || !/[\n\t,]/.test(text)) return
    event.preventDefault()
    const parsed = parseBulkImportText(text)
    if (!parsed.length) return
    setFields((current) => {
      const next = [...current]
      parsed.forEach((row, offset) => {
        const target = index + offset
        const incoming = {
          orderNumberRaw: row.orderNumberRaw,
          boxRaw: row.boxRaw,
          shippingRaw: row.shippingRaw,
        }
        if (next[target]) next[target] = { ...next[target]!, ...incoming }
        else next.push({ ...emptyField(), ...incoming })
      })
      return next
    })
  }

  async function apply() {
    if (!canApply) return
    setApplying(true)
    setOutcomes(null)
    setRowState({})
    setProgress({ done: 0, total: ready.length, current: ready[0]?.orderNumberRaw ?? '', failed: 0 })
    const results: BulkImportApplyOutcome[] = []
    // `fields` is the render snapshot lineNumber indexes into, so the id stays
    // correct even as rows are cleared underneath.
    const snapshot = fields
    // Sequential on purpose: each row is an independent audited invoice-line edit,
    // exactly as if typed by hand. A partial failure stays readable.
    for (const [index, row] of ready.entries()) {
      const fieldId = snapshot[row.lineNumber - 1]?.id
      setProgress((current) => ({ ...current, current: row.orderNumberRaw }))
      if (fieldId != null) setRowState((current) => ({ ...current, [fieldId]: { state: 'applying' } }))
      let ok = true
      try {
        await onApplyRow(row, reason.trim())
        results.push({ lineNumber: row.lineNumber, orderNumberRaw: row.orderNumberRaw, ok: true, message: 'Applied' })
        if (fieldId != null) {
          setRowState((current) => ({ ...current, [fieldId]: { state: 'done' } }))
          // Saved rows empty out, so what is left on screen is only what still
          // needs attention.
          setFields((current) =>
            current.map((field) =>
              field.id === fieldId ? { ...field, orderNumberRaw: '', boxRaw: '', shippingRaw: '' } : field,
            ),
          )
        }
      } catch (err) {
        ok = false
        const message = err instanceof Error ? err.message : 'Failed'
        results.push({ lineNumber: row.lineNumber, orderNumberRaw: row.orderNumberRaw, ok: false, message })
        // A failed row keeps its values so it can be corrected and re-applied.
        if (fieldId != null) setRowState((current) => ({ ...current, [fieldId]: { state: 'failed', message } }))
      }
      setProgress((current) => ({
        ...current,
        done: index + 1,
        failed: current.failed + (ok ? 0 : 1),
      }))
    }
    setOutcomes(results)
    setApplying(false)
    onFinished()
  }

  const applied = outcomes?.filter((outcome) => outcome.ok).length ?? 0
  const failed = outcomes?.filter((outcome) => !outcome.ok).length ?? 0
  const cell = { fontSize: 12, width: '100%' } as const

  return (
    <div className="billing-edit-backdrop" role="presentation" onMouseDown={() => !applying && onClose()}>
      <div
        className="billing-edit-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Import billing corrections"
        style={{ maxWidth: 760 }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="billing-edit-head">
          <div>
            <h3>Import Box Size &amp; Shipping</h3>
            <p>{clientName}</p>
          </div>
          <button className="btn btn-ghost btn-xs" type="button" disabled={applying} onClick={onClose}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>

        <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '4px 0 8px' }}>
          Fill a row per order, or paste several rows straight into an Order # cell. Leave Box or
          Shipping empty to leave that field alone. Each row is saved as a normal invoice-line edit
          with the reason below.
        </p>

        <div style={{ maxHeight: 300, overflowY: 'auto', marginBottom: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--muted)', fontSize: 10.5, textTransform: 'uppercase' }}>
                <th style={{ padding: '2px 4px', width: '22%' }}>Order #</th>
                <th style={{ padding: '2px 4px', width: '30%' }}>Box Size</th>
                <th style={{ padding: '2px 4px', width: '20%' }}>Shipping</th>
                <th style={{ padding: '2px 4px' }}>Status</th>
                <th style={{ width: 28 }} aria-label="Remove row" />
              </tr>
            </thead>
            <tbody>
              {fields.map((field, index) => {
                const status = statusByFieldIndex.get(index)
                const isProblem = status && status.status !== 'ready'
                return (
                  <tr key={field.id}>
                    <td style={{ padding: '2px 4px' }}>
                      <input
                        className="ship-input"
                        style={cell}
                        value={field.orderNumberRaw}
                        disabled={applying}
                        placeholder="2553"
                        aria-label={`Order number, row ${index + 1}`}
                        onPaste={(event) => onPasteIntoOrder(index, event)}
                        onChange={(event) => updateField(field.id, 'orderNumberRaw', event.target.value)}
                      />
                    </td>
                    <td style={{ padding: '2px 4px' }}>
                      <input
                        className="ship-input"
                        style={cell}
                        value={field.boxRaw}
                        disabled={applying}
                        placeholder="9x6x3"
                        aria-label={`Box size, row ${index + 1}`}
                        onChange={(event) => updateField(field.id, 'boxRaw', event.target.value)}
                      />
                    </td>
                    <td style={{ padding: '2px 4px' }}>
                      <input
                        className="ship-input"
                        style={cell}
                        value={field.shippingRaw}
                        disabled={applying}
                        placeholder="20.72"
                        inputMode="decimal"
                        aria-label={`Shipping, row ${index + 1}`}
                        onChange={(event) => updateField(field.id, 'shippingRaw', event.target.value)}
                      />
                    </td>
                    <td style={{ padding: '2px 4px', fontSize: 11 }}>
                      {rowState[field.id]?.state === 'applying' ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--muted)' }}>
                          <Loader2 size={11} className="spin" aria-hidden="true" /> Saving…
                        </span>
                      ) : rowState[field.id]?.state === 'done' ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#15803d' }}>
                          <Check size={11} aria-hidden="true" /> Saved
                        </span>
                      ) : rowState[field.id]?.state === 'failed' ? (
                        <span style={{ color: '#b91c1c' }}>
                          Failed — {rowState[field.id]?.message}
                        </span>
                      ) : status ? (
                        <span style={{ color: isProblem ? '#b45309' : '#15803d' }}>
                          {BULK_IMPORT_STATUS_LABEL[status.status]}
                          {isProblem && status.detail ? ` — ${status.detail}` : ''}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--muted)' }}>—</span>
                      )}
                    </td>
                    <td style={{ padding: '2px 4px', textAlign: 'right' }}>
                      <button
                        className="btn btn-ghost btn-xs"
                        type="button"
                        disabled={applying}
                        aria-label={`Remove row ${index + 1}`}
                        onClick={() => removeField(field.id)}
                      >
                        <X size={12} aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <button className="btn btn-secondary btn-xs" type="button" disabled={applying} onClick={addField}>
            <Plus size={12} aria-hidden="true" /> Add row
          </button>
          {resolved.length ? (
            <span style={{ fontSize: 12 }}>
              <strong>{ready.length}</strong> ready
              {problems.length ? (
                <> · <strong style={{ color: '#b45309' }}>{problems.length}</strong> need attention</>
              ) : null}
            </span>
          ) : null}
        </div>

        <label style={{ display: 'block', fontSize: 11.5, marginBottom: 8 }}>
          <span style={{ display: 'block', marginBottom: 2 }}>
            Reason for edit <span style={{ color: 'var(--muted)' }}>(applied to every row, required)</span>
          </span>
          <input
            className="ship-input"
            style={{ width: '100%', fontSize: 12 }}
            value={reason}
            disabled={applying}
            placeholder="e.g. Canada re-shipment — external Unishippers cost"
            onChange={(event) => setReason(event.target.value)}
          />
        </label>

        {applying ? (
          <div style={{ fontSize: 12, marginBottom: 8 }} role="status" aria-live="polite">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Loader2 size={12} className="spin" aria-hidden="true" />
              <span>
                Applying <strong>{progress.done}</strong> of {progress.total}
                {progress.current ? <> · order {progress.current}</> : null}
                {progress.failed ? <> · <span style={{ color: '#b91c1c' }}>{progress.failed} failed</span></> : null}
              </span>
            </div>
            <div style={{ height: 4, background: 'var(--bg2)', borderRadius: 999, marginTop: 4, overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%`,
                  background: 'var(--brand, #2563eb)',
                  transition: 'width 120ms linear',
                }}
              />
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
              Saved one order at a time — leave this open until it finishes.
            </div>
          </div>
        ) : null}

        {outcomes ? (
          <div style={{ fontSize: 12, marginBottom: 8 }}>
            <strong>{applied}</strong> applied
            {failed ? <> · <strong style={{ color: '#b91c1c' }}>{failed}</strong> failed</> : null}
            {failed ? (
              <div style={{ maxHeight: 120, overflowY: 'auto', marginTop: 4, fontSize: 11.5 }}>
                {outcomes.filter((outcome) => !outcome.ok).map((outcome) => (
                  <div key={`${outcome.lineNumber}-${outcome.orderNumberRaw}`}>
                    Row {outcome.lineNumber} · {outcome.orderNumberRaw} — {outcome.message}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="billing-edit-actions">
          <button className="btn btn-ghost btn-sm" type="button" disabled={applying} onClick={onClose}>
            {outcomes ? 'Close' : 'Cancel'}
          </button>
          <button className="btn btn-primary btn-sm" type="button" disabled={!canApply} onClick={apply}>
            {applying ? 'Applying…' : `Apply ${ready.length} row${ready.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  )
}
