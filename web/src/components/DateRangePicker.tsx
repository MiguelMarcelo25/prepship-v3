/**
 * DateRangePicker
 * ---------------
 * Reusable date-range picker built specifically for the operator
 * dashboards. Two output dates: `from` and `to` (inclusive, ISO
 * YYYY-MM-DD strings). The component holds NO server state — it
 * just calls onChange when the operator commits a new range.
 *
 * What's in the popover
 *
 *   ┌─────────────────────────────────────────────────┐
 *   │ Today           │  ‹  April 2026  ›  [Y][M][D]  │
 *   │ Yesterday       │  ┌──────────────────────┐     │
 *   │ Last 7 days     │  │ Mon Tue Wed ...      │     │
 *   │ Last 15 days    │  │  1   2   3  ...      │     │
 *   │ Last 30 days    │  │  …                   │     │
 *   │ This month      │  └──────────────────────┘     │
 *   │ Last month      │                                │
 *   │ Last 90 days    │  From: [Apr 14, 2026]          │
 *   │ Year to date    │  To:   [May 13, 2026]          │
 *   │                 │                  [Cancel] [✓]  │
 *   └─────────────────────────────────────────────────┘
 *
 * Calendar view modes
 *   - Day  (default): a 7×6 grid of dates. Click to set from/to.
 *   - Month: a 3×4 grid of months. Click → switch back to Day view
 *            with the selected month displayed.
 *   - Year:  a 3×4 grid of years.  Click → switch back to Day view
 *            with the selected year. The Y/M/D buttons in the
 *            header switch between views.
 *
 * Selection model
 *   - First click sets `from` and clears `to`.
 *   - Second click sets `to` (and swaps if the click is earlier
 *     than the existing `from`).
 *   - Presets set both `from` and `to` at once.
 *   - Apply commits the chosen range via onChange; Cancel discards.
 *
 * Why a custom picker (instead of a library)
 *   - Library pickers (react-day-picker, react-datepicker, MUI X)
 *     each pull in 30–80kb of code, often with their own date
 *     library (date-fns, moment, dayjs). Our app is already shipping
 *     a 1.5MB Home chunk — adding another picker package would
 *     hurt FCP for a fairly simple UX.
 *   - This file is ~330 LOC and uses ZERO dependencies beyond React.
 *     All date math is hand-rolled on `Date`, no library needed.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Calendar, ChevronLeft, ChevronRight, X } from 'lucide-react'

// ----------------- public types -----------------

export type DateRange = {
  /** Inclusive start, YYYY-MM-DD. */
  from: string
  /** Inclusive end, YYYY-MM-DD. */
  to: string
}

export type DateRangePresetId =
  | 'today'
  | 'yesterday'
  | 'last7'
  | 'last15'
  | 'last30'
  | 'thisMonth'
  | 'lastMonth'
  | 'last90'
  | 'ytd'

type Props = {
  value: DateRange
  onChange: (next: DateRange) => void
  /** Optional label shown to the left of the trigger button. */
  label?: string
  /** Optional className for the trigger button. */
  className?: string
}

// ----------------- date helpers -----------------

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function toIso(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function fromIso(s: string): Date {
  const parts = s.split('-').map((n) => Number(n))
  const y = parts[0] ?? new Date().getFullYear()
  const m = parts[1] ?? 1
  const d = parts[2] ?? 1
  return new Date(y, m - 1, d)
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d)
  out.setDate(out.getDate() + days)
  return out
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0)
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function isWithin(d: Date, fromD: Date, toD: Date): boolean {
  const lo = fromD <= toD ? fromD : toD
  const hi = fromD <= toD ? toD : fromD
  const dt = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  return dt >= new Date(lo.getFullYear(), lo.getMonth(), lo.getDate()).getTime()
    && dt <= new Date(hi.getFullYear(), hi.getMonth(), hi.getDate()).getTime()
}

function formatHuman(iso: string): string {
  if (!iso) return ''
  const d = fromIso(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatRangeLabel(range: DateRange): string {
  if (!range.from || !range.to) return 'Select date range'
  if (range.from === range.to) return formatHuman(range.from)
  const fromD = fromIso(range.from)
  const toD = fromIso(range.to)
  if (fromD.getFullYear() === toD.getFullYear()) {
    return `${fromD.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${formatHuman(range.to)}`
  }
  return `${formatHuman(range.from)} – ${formatHuman(range.to)}`
}

// ----------------- preset resolver -----------------

function computePreset(id: DateRangePresetId, today: Date): DateRange {
  switch (id) {
    case 'today':
      return { from: toIso(today), to: toIso(today) }
    case 'yesterday': {
      const y = addDays(today, -1)
      return { from: toIso(y), to: toIso(y) }
    }
    case 'last7':
      return { from: toIso(addDays(today, -6)), to: toIso(today) }
    case 'last15':
      return { from: toIso(addDays(today, -14)), to: toIso(today) }
    case 'last30':
      return { from: toIso(addDays(today, -29)), to: toIso(today) }
    case 'thisMonth':
      return { from: toIso(startOfMonth(today)), to: toIso(today) }
    case 'lastMonth': {
      const start = new Date(today.getFullYear(), today.getMonth() - 1, 1)
      const end = endOfMonth(start)
      return { from: toIso(start), to: toIso(end) }
    }
    case 'last90':
      return { from: toIso(addDays(today, -89)), to: toIso(today) }
    case 'ytd':
      return { from: toIso(new Date(today.getFullYear(), 0, 1)), to: toIso(today) }
  }
}

const PRESETS: Array<{ id: DateRangePresetId; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'last7', label: 'Last 7 days' },
  { id: 'last15', label: 'Last 15 days' },
  { id: 'last30', label: 'Last 30 days' },
  { id: 'thisMonth', label: 'This month' },
  { id: 'lastMonth', label: 'Last month' },
  { id: 'last90', label: 'Last 90 days' },
  { id: 'ytd', label: 'Year to date' },
]

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAY_NAMES = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

// ----------------- component -----------------

export function DateRangePicker({ value, onChange, label, className }: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  // Draft range edited inside the popover. Only committed on Apply.
  const [draft, setDraft] = useState<DateRange>(value)
  // Calendar view state — which month is visible, what view mode.
  const [viewDate, setViewDate] = useState<Date>(() => fromIso(value.from || toIso(new Date())))
  const [viewMode, setViewMode] = useState<'day' | 'month' | 'year'>('day')
  // After first click in day-mode, we're picking the 'to' endpoint.
  const [pickingTo, setPickingTo] = useState(false)

  const popoverRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // Reset draft whenever the popover opens (so cancel + reopen is clean).
  useEffect(() => {
    if (open) {
      setDraft(value)
      setViewDate(fromIso(value.from || toIso(new Date())))
      setViewMode('day')
      setPickingTo(false)
    }
  }, [open, value.from, value.to])

  // Click-outside + Esc-to-close behavior.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (popoverRef.current?.contains(t)) return
      if (triggerRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // ----- preset click → commit immediately (no extra Apply needed) -----
  const applyPreset = (id: DateRangePresetId) => {
    const next = computePreset(id, new Date())
    onChange(next)
    setOpen(false)
  }

  // ----- day cell click → first sets from, second sets to -----
  const onDayClick = (day: Date) => {
    const iso = toIso(day)
    if (!pickingTo) {
      setDraft({ from: iso, to: iso })
      setPickingTo(true)
    } else {
      const from = fromIso(draft.from)
      if (day < from) {
        setDraft({ from: iso, to: draft.from })
      } else {
        setDraft({ from: draft.from, to: iso })
      }
      setPickingTo(false)
    }
  }

  const applyDraft = () => {
    if (draft.from && draft.to) {
      onChange(draft)
      setOpen(false)
    }
  }

  // ----- day grid cells -----
  const dayGrid = useMemo(() => {
    const firstOfMonth = startOfMonth(viewDate)
    const startWeekday = firstOfMonth.getDay()
    const gridStart = addDays(firstOfMonth, -startWeekday)
    // 6 weeks × 7 days = 42 cells, covers any month layout.
    return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i))
  }, [viewDate])

  const fromD = draft.from ? fromIso(draft.from) : null
  const toD = draft.to ? fromIso(draft.to) : null
  const todayD = new Date()

  return (
    <div className={`relative inline-block ${className ?? ''}`}>
      {label ? (
        <label className="mr-2 text-2xs font-bold uppercase tracking-wider text-ink-3">{label}</label>
      ) : null}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex h-10 items-center gap-2 rounded-card border border-line bg-surface px-3 text-sm2 font-semibold text-ink shadow-sm transition hover:bg-surface-2 ${
          open ? 'border-brand ring-2 ring-brand/30' : ''
        }`}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Calendar size={14} strokeWidth={2.25} className="text-ink-3" />
        <span className="font-mono tabular-nums">{formatRangeLabel(value)}</span>
      </button>

      {open ? (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Select date range"
          className="absolute right-0 top-12 z-40 flex w-[640px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-card border border-line bg-surface shadow-2xl sm:flex-row"
        >
          {/* Presets column */}
          <div className="border-b border-line bg-surface-2/40 p-2 sm:w-44 sm:border-b-0 sm:border-r">
            <div className="grid grid-cols-3 gap-1 sm:grid-cols-1">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => applyPreset(p.id)}
                  className="rounded-md px-3 py-1.5 text-left text-tiny font-semibold text-ink-2 transition hover:bg-brand/10 hover:text-brand"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Calendar column */}
          <div className="flex flex-1 flex-col p-3">
            {/* Header — navigation + view mode switcher */}
            <div className="mb-2 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() =>
                  setViewDate(
                    viewMode === 'year'
                      ? new Date(viewDate.getFullYear() - 12, viewDate.getMonth(), 1)
                      : viewMode === 'month'
                      ? new Date(viewDate.getFullYear() - 1, viewDate.getMonth(), 1)
                      : new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1)
                  )
                }
                className="grid h-7 w-7 place-items-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink"
                aria-label="Previous"
              >
                <ChevronLeft size={16} strokeWidth={2.5} />
              </button>

              <div className="inline-flex overflow-hidden rounded-md ring-1 ring-line">
                {/* Header label that's also a view-mode switcher */}
                <button
                  type="button"
                  onClick={() => setViewMode(viewMode === 'day' ? 'month' : viewMode === 'month' ? 'year' : 'day')}
                  className="px-3 py-1 text-tiny font-extrabold text-ink hover:bg-surface-2"
                  aria-label="Switch calendar view"
                  title={viewMode === 'day' ? 'Click to pick month' : viewMode === 'month' ? 'Click to pick year' : 'Back to days'}
                >
                  {viewMode === 'day'
                    ? `${MONTH_NAMES[viewDate.getMonth()]} ${viewDate.getFullYear()}`
                    : viewMode === 'month'
                    ? viewDate.getFullYear()
                    : `${viewDate.getFullYear() - 6} – ${viewDate.getFullYear() + 5}`}
                </button>
                {/* Explicit D/M/Y switcher */}
                <div className="flex border-l border-line">
                  {(['day', 'month', 'year'] as const).map((m) => {
                    const initial = m.charAt(0).toUpperCase()
                    return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setViewMode(m)}
                      className={`px-2 text-2xs font-extrabold ${viewMode === m ? 'bg-brand text-white' : 'text-ink-3 hover:bg-surface-2 hover:text-ink'}`}
                      aria-pressed={viewMode === m}
                      title={`${initial + m.slice(1)} view`}
                    >
                      {initial}
                    </button>
                    )
                  })}
                </div>
              </div>

              <button
                type="button"
                onClick={() =>
                  setViewDate(
                    viewMode === 'year'
                      ? new Date(viewDate.getFullYear() + 12, viewDate.getMonth(), 1)
                      : viewMode === 'month'
                      ? new Date(viewDate.getFullYear() + 1, viewDate.getMonth(), 1)
                      : new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1)
                  )
                }
                className="grid h-7 w-7 place-items-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink"
                aria-label="Next"
              >
                <ChevronRight size={16} strokeWidth={2.5} />
              </button>
            </div>

            {/* Grid — day / month / year depending on viewMode */}
            {viewMode === 'day' ? (
              <>
                <div className="grid grid-cols-7 gap-0.5 text-center text-[10px] font-extrabold uppercase text-ink-3">
                  {WEEKDAY_NAMES.map((w, i) => (
                    <div key={i} className="py-1">{w}</div>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-0.5">
                  {dayGrid.map((d, i) => {
                    const outside = d.getMonth() !== viewDate.getMonth()
                    const inRange = fromD && toD ? isWithin(d, fromD, toD) : false
                    const isFrom = fromD ? sameDay(d, fromD) : false
                    const isTo = toD ? sameDay(d, toD) : false
                    const isEndpoint = isFrom || isTo
                    const isToday = sameDay(d, todayD)
                    return (
                      <button
                        key={i}
                        type="button"
                        onClick={() => onDayClick(d)}
                        className={`relative h-8 rounded-md text-tiny font-semibold tabular-nums transition ${
                          isEndpoint
                            ? 'bg-brand text-white shadow-sm hover:bg-brand-dark'
                            : inRange
                            ? 'bg-brand/15 text-brand'
                            : outside
                            ? 'text-ink-3/50 hover:bg-surface-2'
                            : 'text-ink hover:bg-surface-2'
                        }`}
                        aria-label={d.toDateString()}
                      >
                        {d.getDate()}
                        {isToday && !isEndpoint ? (
                          <span className="absolute bottom-1 left-1/2 h-0.5 w-3 -translate-x-1/2 rounded-full bg-brand" />
                        ) : null}
                      </button>
                    )
                  })}
                </div>
              </>
            ) : viewMode === 'month' ? (
              <div className="grid flex-1 grid-cols-3 gap-1.5">
                {MONTH_NAMES.map((name, idx) => {
                  const active = viewDate.getMonth() === idx
                  return (
                    <button
                      key={name}
                      type="button"
                      onClick={() => {
                        setViewDate(new Date(viewDate.getFullYear(), idx, 1))
                        setViewMode('day')
                      }}
                      className={`grid place-items-center rounded-md py-3 text-sm2 font-extrabold transition ${
                        active ? 'bg-brand text-white shadow-sm' : 'text-ink hover:bg-surface-2'
                      }`}
                    >
                      {name}
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="grid flex-1 grid-cols-3 gap-1.5">
                {Array.from({ length: 12 }, (_, i) => viewDate.getFullYear() - 6 + i).map((year) => {
                  const active = year === viewDate.getFullYear()
                  return (
                    <button
                      key={year}
                      type="button"
                      onClick={() => {
                        setViewDate(new Date(year, viewDate.getMonth(), 1))
                        setViewMode('month')
                      }}
                      className={`grid place-items-center rounded-md py-3 font-mono text-sm2 font-extrabold tabular-nums transition ${
                        active ? 'bg-brand text-white shadow-sm' : 'text-ink hover:bg-surface-2'
                      }`}
                    >
                      {year}
                    </button>
                  )
                })}
              </div>
            )}

            {/* Footer — from/to inputs + Apply/Cancel */}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
              <div className="flex flex-wrap items-center gap-1.5 text-2xs">
                <span className="font-semibold uppercase tracking-wider text-ink-3">From</span>
                <input
                  type="date"
                  value={draft.from}
                  onChange={(e) => setDraft({ ...draft, from: e.target.value })}
                  className="h-8 rounded-md border border-line bg-surface px-2 font-mono text-tiny text-ink outline-none focus:border-brand focus:ring-1 focus:ring-brand"
                />
                <span className="font-semibold uppercase tracking-wider text-ink-3">To</span>
                <input
                  type="date"
                  value={draft.to}
                  onChange={(e) => setDraft({ ...draft, to: e.target.value })}
                  className="h-8 rounded-md border border-line bg-surface px-2 font-mono text-tiny text-ink outline-none focus:border-brand focus:ring-1 focus:ring-brand"
                />
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="inline-flex h-8 items-center gap-1 rounded-md border border-line bg-surface px-3 text-tiny font-semibold text-ink-2 hover:bg-surface-2"
                >
                  <X size={12} strokeWidth={2.5} /> Cancel
                </button>
                <button
                  type="button"
                  onClick={applyDraft}
                  disabled={!draft.from || !draft.to}
                  className="inline-flex h-8 items-center gap-1 rounded-md bg-brand px-3 text-tiny font-extrabold text-white shadow-sm hover:bg-brand-dark disabled:opacity-50"
                >
                  Apply
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

// ----------------- helpers for callers -----------------

/**
 * Compute the prior comparison range — same length, immediately
 * preceding the current range. Used by dashboards that show
 * "this period vs prior period" comparisons.
 *
 *   current = { 2026-04-14, 2026-05-13 }  → 30 days
 *   prior   = { 2026-03-15, 2026-04-13 }
 */
export function priorRange(current: DateRange): DateRange {
  const from = fromIso(current.from)
  const to = fromIso(current.to)
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1
  const priorTo = addDays(from, -1)
  const priorFrom = addDays(priorTo, -(days - 1))
  return { from: toIso(priorFrom), to: toIso(priorTo) }
}

/**
 * Default range = last 30 days ending today. Convenience for
 * dashboard initial state.
 */
export function defaultLast30(): DateRange {
  const today = new Date()
  return { from: toIso(addDays(today, -29)), to: toIso(today) }
}
