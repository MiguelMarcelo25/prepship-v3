import { useState } from 'react'
import { api } from '../lib/api'

// 2026-05-13: 7/30/90/180-day quick range selector for the Units
// Sold Trend panel. Clicking a preset replaces the dashboard-wide
// dateRange so every panel (trend chart, heatmap, KPIs) reflects
// the same window — the dashboard is already wired to refetch
// when dateRange changes (useEffect at line ~1547).
//
// "Active" detection compares the current range LENGTH in days
// to each preset, not the date strings themselves. Operators can
// also pick custom ranges via the DateRangePicker — a 7-day window
// they typed manually still highlights the 7d preset, so the UI
// reflects the actual range regardless of how it got set.
export function RangeToggle({
  value,
  onChange,
}: {
  value: { from: string; to: string }
  onChange: (next: { from: string; to: string }) => void
}) {
  const [loadingDays, setLoadingDays] = useState<number | null>(null)
  const presets: Array<{ days: number; label: string }> = [
    { days: 7,   label: '7d' },
    { days: 30,  label: '30d' },
    { days: 90,  label: '90d' },
    { days: 180, label: '180d' },
  ]

  // Compute the active preset by measuring the current range. Add
  // 1 because the range is inclusive on both ends. Round to handle
  // tz/DST edge cases where the math might be 29.99 / 30.01.
  const rangeDays = (() => {
    const from = new Date(value.from).getTime()
    const to = new Date(value.to).getTime()
    if (!Number.isFinite(from) || !Number.isFinite(to)) return 0
    return Math.round((to - from) / 86_400_000) + 1
  })()

  const setRange = async (days: number) => {
    setLoadingDays(days)
    try {
      const range = await api.get<{ from: string; to: string }>(`/analysis/preset-window?days=${days}`)
      onChange(range)
    } catch (error) {
      console.warn('[RangeToggle] backend preset resolution failed:', error)
    } finally {
      setLoadingDays(null)
    }
  }

  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-md ring-1 ring-line p-0.5 bg-surface"
      role="group"
      aria-label="Select time range"
    >
      {presets.map((preset) => {
        const active = rangeDays === preset.days
        return (
          <button
            key={preset.days}
            type="button"
            onClick={() => { void setRange(preset.days) }}
            disabled={loadingDays != null}
            title={`Last ${preset.days} days`}
            aria-pressed={active}
            className={`inline-flex h-6 items-center justify-center rounded px-2 text-[11px] font-extrabold tabular-nums transition ${
              active
                ? 'bg-brand text-white shadow-sm'
                : 'text-ink-3 hover:text-ink hover:bg-surface-2'
            }`}
          >
            {preset.label}
          </button>
        )
      })}
    </div>
  )
}

export default RangeToggle
