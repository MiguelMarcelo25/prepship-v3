// PS-155: Billing "Generate & Summary" filter row extracted verbatim from BillingView.tsx
// (behavior-preserving). All state, the generate/regenerate/backfill/fetch handlers, and the
// preset-range computation stay OWNED by BillingView and are passed in as props — this file is
// pure presentation, so the displayed controls can never drift from the parent's state.
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
  regenerateRangeBlocked,
  backfillLoading,
  fetchRefRunning,
  fetchRefStatus,
  generateStatus,
  onSelectPreset,
  onFromChange,
  onToChange,
  onGenerate,
  onRegenerate,
  onBackfillRefRates,
  onFetchRefRates,
}: {
  activePreset: BillingPresetId | null
  from: string
  to: string
  generateLoading: boolean
  regenerateRangeBlocked: boolean
  backfillLoading: boolean
  fetchRefRunning: boolean
  fetchRefStatus: string
  generateStatus: string
  onSelectPreset: (preset: BillingPresetId) => void
  onFromChange: (value: string) => void
  onToChange: (value: string) => void
  onGenerate: () => void
  onRegenerate: () => void
  onBackfillRefRates: () => void
  onFetchRefRates: () => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--text2)' }}>
        <span>From</span>
        <input type="date" className="ship-select" style={{ width: 140, fontSize: 12 }} value={from} onChange={(event) => onFromChange(event.target.value)} />
        <span>To</span>
        <input type="date" className="ship-select" style={{ width: 140, fontSize: 12 }} value={to} onChange={(event) => onToChange(event.target.value)} />
      </div>
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
      <button className="btn btn-outline btn-sm" type="button" onClick={onRegenerate} disabled={generateLoading || regenerateRangeBlocked} title={regenerateRangeBlocked ? 'Regenerate Range is limited to 120 days. Use Update Billing for All/history.' : 'Rebuild every billing row in the selected date range. Use this only when pricing rules changed or history needs repair.'}>
        Regenerate Range
      </button>
      <button
        className="btn btn-ghost btn-sm"
        type="button"
        title="Populate SS USPS/UPS reference rates from rate cache"
        disabled={backfillLoading}
        onClick={onBackfillRefRates}
      >
        {backfillLoading ? '↺ Backfilling…' : '↺ Backfill Ref Rates'}
      </button>
      <button
        className="btn btn-ghost btn-sm"
        type="button"
        title="Re-fetch live SS USPS/UPS reference rates for all reference_rate clients (runs in background)"
        disabled={fetchRefRunning}
        onClick={onFetchRefRates}
      >
        ⚡ Fetch Ref Rates
      </button>
      <span style={{ fontSize: 10.5, color: 'var(--text3)', marginLeft: 4 }}>{fetchRefStatus}</span>
      <span style={{ fontSize: 12, color: 'var(--text3)' }}>{generateStatus}</span>
    </div>
  )
}
