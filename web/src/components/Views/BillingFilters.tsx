// PS-155: Billing "Generate & Summary" filter row extracted from BillingView.tsx.
// Preset/date state and the single Update Billing action stay owned by BillingView.
import { Loader2 } from 'lucide-react'
import type { BillingPresetId } from './billing-parity'

const BILLING_PRESETS: Array<[BillingPresetId, string]> = [
  ['all', 'All'],
  ['this_month', 'This Month'],
  ['last_month', 'Last Month'],
  ['last_30', 'Last 30 Days'],
  ['last_90', 'Last 90 Days'],
]

export function BillingFilters({
  activePreset,
  from,
  to,
  generateLoading,
  generateStatus,
  onSelectPreset,
  onFromChange,
  onToChange,
  onGenerate,
}: {
  activePreset: BillingPresetId | null
  from: string
  to: string
  generateLoading: boolean
  generateStatus: string
  onSelectPreset: (preset: BillingPresetId) => void
  onFromChange: (value: string) => void
  onToChange: (value: string) => void
  onGenerate: () => void
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap mb-3">
      <div className="flex gap-1.5 flex-wrap">
        {BILLING_PRESETS.map(([preset, label]) => (
          <button
            key={preset}
            className={`btn btn-outline btn-sm analysis-preset${activePreset === preset ? ' active' : ''}`}
            type="button"
            onClick={() => onSelectPreset(preset)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
        <span className="text-ink-3">From</span>
        <input type="date" className="ship-select" style={{ width: 140, fontSize: 12 }} value={from} onChange={(event) => onFromChange(event.target.value)} />
        <span className="text-ink-3">To</span>
        <input type="date" className="ship-select" style={{ width: 140, fontSize: 12 }} value={to} onChange={(event) => onToChange(event.target.value)} />
      </div>
      <div className="flex items-center gap-1.5 flex-wrap ml-auto">
        <button className="btn btn-primary btn-sm" type="button" onClick={onGenerate} disabled={generateLoading}>
          {generateLoading ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Loader2 size={12} strokeWidth={2.5} className="animate-spin" aria-hidden />
              Updating...
            </span>
          ) : (
            'Update Billing'
          )}
        </button>
        <span className="text-[12px] text-ink-3">{generateStatus}</span>
      </div>
    </div>
  )
}
