import { useMemo, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import type { PackageDto } from '../../types/api'
import type { BillingDetailDto } from './billing-parity'
import {
  BULK_IMPORT_STATUS_LABEL,
  bulkImportReadyRows,
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

type BillingBulkImportModalProps = {
  clientName: string
  detailRows: BillingDetailDto[]
  packages: PackageDto[]
  onClose: () => void
  /** Applies one resolved row through the existing audited detail PATCH. */
  onApplyRow: (row: BulkImportReadyRow, reason: string) => Promise<void>
  onFinished: () => void
}

export function BillingBulkImportModal({
  clientName,
  detailRows,
  packages,
  onClose,
  onApplyRow,
  onFinished,
}: BillingBulkImportModalProps) {
  const [text, setText] = useState('')
  const [reason, setReason] = useState('')
  const [applying, setApplying] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [outcomes, setOutcomes] = useState<BulkImportApplyOutcome[] | null>(null)

  const resolved = useMemo(
    () => resolveBulkImportRows(parseBulkImportText(text), detailRows, packages),
    [text, detailRows, packages],
  )
  const ready = useMemo(() => bulkImportReadyRows(resolved), [resolved])
  const problems = useMemo(() => resolved.filter((row) => row.status !== 'ready'), [resolved])

  const canApply = ready.length > 0 && reason.trim().length >= 3 && !applying

  async function apply() {
    if (!canApply) return
    setApplying(true)
    setOutcomes(null)
    setProgress({ done: 0, total: ready.length })
    const results: BulkImportApplyOutcome[] = []
    // Sequential on purpose: each row is an independent audited invoice-line edit,
    // exactly as if typed by hand. Firing them in parallel would make a partial
    // failure much harder to read back.
    for (const row of ready) {
      try {
        await onApplyRow(row, reason.trim())
        results.push({ lineNumber: row.lineNumber, orderNumberRaw: row.orderNumberRaw, ok: true, message: 'Applied' })
      } catch (err) {
        results.push({
          lineNumber: row.lineNumber,
          orderNumberRaw: row.orderNumberRaw,
          ok: false,
          message: err instanceof Error ? err.message : 'Failed',
        })
      }
      setProgress((current) => ({ ...current, done: current.done + 1 }))
    }
    setOutcomes(results)
    setApplying(false)
    onFinished()
  }

  const applied = outcomes?.filter((outcome) => outcome.ok).length ?? 0
  const failed = outcomes?.filter((outcome) => !outcome.ok).length ?? 0

  return (
    <div className="billing-edit-backdrop" role="presentation" onMouseDown={() => !applying && onClose()}>
      <div
        className="billing-edit-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Import billing corrections"
        style={{ maxWidth: 820 }}
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

        <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '4px 0 6px' }}>
          One order per line: <strong>Order #</strong>, <strong>Box</strong>,{' '}
          <strong>Shipping</strong> — separated by tabs (a paste from Sheets), commas, or spaces.
          Leave the box or the amount out to leave that field alone. Each row is saved as a normal
          invoice-line edit with the reason below.
        </p>

        <textarea
          value={text}
          disabled={applying}
          onChange={(event) => setText(event.target.value)}
          placeholder={'2515\t9x6x3\t20.83\n2521\t12x10x3\t20.72'}
          spellCheck={false}
          style={{ width: '100%', minHeight: 120, fontFamily: 'monospace', fontSize: 12, padding: 8 }}
        />

        {resolved.length ? (
          <div style={{ margin: '8px 0', fontSize: 12 }}>
            <strong>{ready.length}</strong> ready
            {problems.length ? <> · <strong style={{ color: '#b45309' }}>{problems.length}</strong> need attention</> : null}
          </div>
        ) : null}

        {problems.length ? (
          <div
            style={{
              maxHeight: 150,
              overflowY: 'auto',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: 6,
              marginBottom: 8,
              fontSize: 11.5,
            }}
          >
            {problems.map((row) => (
              <div key={`${row.lineNumber}-${row.orderNumberRaw}`} style={{ padding: '2px 0' }}>
                <strong>Line {row.lineNumber}</strong> · {row.orderNumberRaw} ·{' '}
                <span style={{ color: '#b45309' }}>{BULK_IMPORT_STATUS_LABEL[row.status]}</span>
                {row.detail ? <> — {row.detail}</> : null}
              </div>
            ))}
          </div>
        ) : null}

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
          <div style={{ fontSize: 12, marginBottom: 8 }}>
            <Loader2 size={12} className="spin" aria-hidden="true" /> Applying {progress.done} of {progress.total}…
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
                    Line {outcome.lineNumber} · {outcome.orderNumberRaw} — {outcome.message}
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
