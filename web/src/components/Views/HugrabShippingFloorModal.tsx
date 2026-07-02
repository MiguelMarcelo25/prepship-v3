import { useState } from 'react'
import { Loader2, RotateCcw, ShieldCheck, Search } from 'lucide-react'
import { apiClient } from '../../api/client'
import { formatBillingMoney } from './billing-parity'

type HugrabShippingFloorAction = 'floor' | 'revert'

type HugrabShippingFloorPreviewRow = {
  billingLineId: number
  orderId: number | null
  orderNumber: string | null
  shipDate: string | null
  currentShipping: number
  selectedRateCost: number
  nextShipping: number
}

type HugrabShippingFloorPreview = {
  action: HugrabShippingFloorAction
  count: number
  currentTotal: number
  newTotal: number
  delta: number
  selectedRateBelow: number
  targetShipping: number
  sampleRows: HugrabShippingFloorPreviewRow[]
}

const DEFAULT_SELECTED_RATE_BELOW = '7.95'
const DEFAULT_TARGET_SHIPPING = '7.73'

function parsePositiveMoneyInput(value: string): number | null {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.round(parsed * 100) / 100
}

export function HugrabShippingFloorModal({
  dateFrom,
  dateTo,
  onClose,
  onApplied,
}: {
  dateFrom: string
  dateTo: string
  onClose: () => void
  onApplied: () => void
}) {
  const [action, setAction] = useState<HugrabShippingFloorAction>('floor')
  const [preview, setPreview] = useState<HugrabShippingFloorPreview | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [doneMsg, setDoneMsg] = useState<string | null>(null)
  const [selectedRateBelowInput, setSelectedRateBelowInput] = useState(DEFAULT_SELECTED_RATE_BELOW)
  const [targetShippingInput, setTargetShippingInput] = useState(DEFAULT_TARGET_SHIPPING)

  function resetPreviewState() {
    setPreview(null)
    setConfirmed(false)
    setError(null)
    setDoneMsg(null)
  }

  function selectAction(next: HugrabShippingFloorAction) {
    setAction(next)
    resetPreviewState()
  }

  function updateSelectedRateBelow(value: string) {
    setSelectedRateBelowInput(value)
    resetPreviewState()
  }

  function updateTargetShipping(value: string) {
    setTargetShippingInput(value)
    resetPreviewState()
  }

  function currentParams(): { selectedRateBelow: number; targetShipping: number } | null {
    const selectedRateBelow = parsePositiveMoneyInput(selectedRateBelowInput)
    const targetShipping = parsePositiveMoneyInput(targetShippingInput)
    if (selectedRateBelow == null || targetShipping == null) {
      setError('Enter positive dollar values for Selected Rate below and Set Shipping to.')
      setPreview(null)
      setConfirmed(false)
      return null
    }
    return { selectedRateBelow, targetShipping }
  }

  async function runPreview(nextAction = action) {
    const params = currentParams()
    if (!params) return
    setBusy(true)
    setError(null)
    setDoneMsg(null)
    setConfirmed(false)
    try {
      const result = await apiClient.hugrabBillingShippingFloor({
        action: nextAction,
        dateFrom,
        dateTo,
        selectedRateBelow: params.selectedRateBelow,
        targetShipping: params.targetShipping,
      })
      setPreview(result as HugrabShippingFloorPreview)
    } catch (e) {
      setPreview(null)
      setError(e instanceof Error ? e.message : 'Preview failed')
    } finally {
      setBusy(false)
    }
  }

  async function runApply() {
    if (!preview || !confirmed || preview.count === 0) return
    setBusy(true)
    setError(null)
    try {
      const result = await apiClient.hugrabBillingShippingFloor({
        action: preview.action,
        dateFrom,
        dateTo,
        selectedRateBelow: preview.selectedRateBelow,
        targetShipping: preview.targetShipping,
        apply: true,
        expectedCount: preview.count,
      })
      const updated = Number((result as { updatedCount?: number } | null)?.updatedCount ?? 0)
      setDoneMsg(`${preview.action === 'revert' ? 'Reverted' : 'Applied'} ${updated} HUGRAB billing row(s).`)
      setConfirmed(false)
      onApplied()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Apply failed')
    } finally {
      setBusy(false)
    }
  }

  const applyDisabled =
    busy || doneMsg != null || !preview || preview.action !== action || !confirmed || preview.count === 0
  const actionLabel = action === 'revert' ? 'revert' : 'floor'
  const previewLabel = action === 'revert' ? 'Preview revert' : 'Preview floor'
  const selectedRateBelow = parsePositiveMoneyInput(selectedRateBelowInput)
  const targetShipping = parsePositiveMoneyInput(targetShippingInput)
  const selectedRateBelowLabel = selectedRateBelow == null ? 'threshold' : formatBillingMoney(selectedRateBelow)
  const targetShippingLabel = targetShipping == null ? 'shipping' : formatBillingMoney(targetShipping)

  return (
    <div
      data-hugrab-shipping-floor-modal
      role="dialog"
      aria-modal="true"
      aria-label="HUGRAB bulk shipping change"
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/45 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <div className="w-[540px] max-w-[94vw] rounded-lg bg-surface text-ink ring-1 ring-line shadow-[0_18px_60px_rgba(15,23,42,0.24)]">
        <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            <h3 className="m-0 text-[15px] font-extrabold">HUGRAB bulk shipping</h3>
            <p className="mt-1 text-[11.5px] font-medium text-ink-3">
              {dateFrom} to {dateTo}
            </p>
          </div>
          <button className="btn btn-ghost btn-xs" type="button" disabled={busy} onClick={onClose}>
            Close
          </button>
        </div>

        <div className="space-y-3 px-4 py-3">
          <div className="inline-flex rounded-lg bg-surface-2 p-1 ring-1 ring-line" role="group" aria-label="Bulk action">
            <button
              type="button"
              className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[11.5px] font-extrabold transition ${action === 'floor' ? 'bg-brand text-white shadow-sm' : 'text-ink-2 hover:bg-surface hover:text-ink'}`}
              onClick={() => selectAction('floor')}
              disabled={busy}
            >
              <ShieldCheck size={13} aria-hidden="true" />
              Set {targetShippingLabel}
            </button>
            <button
              type="button"
              className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[11.5px] font-extrabold transition ${action === 'revert' ? 'bg-brand text-white shadow-sm' : 'text-ink-2 hover:bg-surface hover:text-ink'}`}
              onClick={() => selectAction('revert')}
              disabled={busy}
            >
              <RotateCcw size={13} aria-hidden="true" />
              Revert
            </button>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="block text-[11px] font-extrabold uppercase tracking-wide text-ink-3">
              Selected Rate below
              <span className="mt-1 flex h-8 items-center rounded-md border border-line bg-surface px-2 text-[12px] font-semibold text-ink focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/15">
                <span className="mr-1 text-ink-3">$</span>
                <input
                  data-hugrab-selected-rate-below-input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={selectedRateBelowInput}
                  onChange={(event) => updateSelectedRateBelow(event.target.value)}
                  disabled={busy}
                  className="h-full w-full border-0 bg-transparent p-0 text-[12px] font-semibold text-ink outline-none"
                />
              </span>
            </label>
            <label className="block text-[11px] font-extrabold uppercase tracking-wide text-ink-3">
              Set Shipping to
              <span className="mt-1 flex h-8 items-center rounded-md border border-line bg-surface px-2 text-[12px] font-semibold text-ink focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/15">
                <span className="mr-1 text-ink-3">$</span>
                <input
                  data-hugrab-target-shipping-input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={targetShippingInput}
                  onChange={(event) => updateTargetShipping(event.target.value)}
                  disabled={busy}
                  className="h-full w-full border-0 bg-transparent p-0 text-[12px] font-semibold text-ink outline-none"
                />
              </span>
            </label>
          </div>

          <div className="text-[12px] leading-5 text-ink-2">
            {action === 'floor'
              ? `Preview HUGRAB shipping rows where Selected Rate is below ${selectedRateBelowLabel}, then set Shipping to ${targetShippingLabel}.`
              : `Preview HUGRAB rows currently at ${targetShippingLabel}, then put Shipping back to the Selected Rate.`}
          </div>

          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy}
            onClick={() => void runPreview(action)}
          >
            {busy && !preview ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Search size={14} aria-hidden="true" />}
            {previewLabel}
          </button>

          {error ? (
            <div role="alert" className="rounded-md bg-red-50 px-3 py-2 text-[12px] font-semibold text-red-700 ring-1 ring-red-200">
              {error}
            </div>
          ) : null}

          {preview ? (
            <div className="rounded-lg bg-surface-2/60 p-3 text-[12px] ring-1 ring-line">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span><strong>{preview.count}</strong> row(s)</span>
                <span>{formatBillingMoney(preview.currentTotal)} to <strong>{formatBillingMoney(preview.newTotal)}</strong></span>
                <span className={preview.delta < 0 ? 'font-extrabold text-red-600' : 'font-extrabold text-green-700'}>
                  {preview.delta >= 0 ? '+' : ''}{formatBillingMoney(preview.delta)}
                </span>
              </div>
              {preview.sampleRows.length ? (
                <div className="mt-2 max-h-32 overflow-y-auto rounded-md bg-surface px-2 py-1 ring-1 ring-line">
                  {preview.sampleRows.slice(0, 8).map((row) => (
                    <div key={row.billingLineId} className="flex items-center justify-between gap-3 border-b border-line/60 py-1 last:border-b-0">
                      <span className="min-w-0 truncate font-semibold text-ink-2">{row.orderNumber ?? `Line ${row.billingLineId}`}</span>
                      <span className="shrink-0 font-mono tabular-nums text-[11px] text-ink-3">
                        {formatBillingMoney(row.currentShipping)} to {formatBillingMoney(row.nextShipping)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
              <label className="mt-3 flex items-center gap-2 text-[12px] font-semibold text-ink">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={preview.count === 0 || doneMsg != null}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                I confirm this {actionLabel} for {preview.count} HUGRAB billing row(s).
              </label>
            </div>
          ) : null}

          {doneMsg ? (
            <div role="status" className="rounded-md bg-green-50 px-3 py-2 text-[12px] font-extrabold text-green-700 ring-1 ring-green-200">
              {doneMsg}
            </div>
          ) : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={onClose}>
            {doneMsg ? 'Done' : 'Cancel'}
          </button>
          <button className="btn btn-primary btn-sm" type="button" disabled={applyDisabled} onClick={() => void runApply()}>
            {busy && preview ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
            {action === 'revert' ? 'Revert rows' : `Apply ${preview ? formatBillingMoney(preview.targetShipping) : targetShippingLabel}`}
          </button>
        </div>
      </div>
    </div>
  )
}
