/**
 * FilterSelect
 * ------------
 * Custom dropdown to replace native <select> in toolbar filters
 * (e.g. "All Categories", "All Brands" in the dashboard's SKU
 * Performance Summary).
 *
 * Why custom instead of <select>:
 *   - Native <select> dropdowns let the BROWSER decide whether to
 *     open above or below the trigger based on available space.
 *     Operators reported the dashboard's "All Categories" select
 *     opening UPWARD (covering the heatmap above), which was
 *     disorienting. This component always opens BELOW the trigger
 *     unless it would clip the viewport bottom.
 *   - We get consistent theming (matching DateRangePicker, etc.)
 *     and the same click-outside / Esc / focus behavior as every
 *     other popover in the app.
 *
 * Self-contained — zero dependencies beyond React + lucide-react
 * (which the app already imports everywhere). Click-outside +
 * Esc dismissal mirror the DateRangePicker pattern.
 */

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Check as CheckIcon } from 'lucide-react'

type Props = {
  /** Currently selected value. Empty string = the "all/placeholder" choice. */
  value: string
  onChange: (next: string) => void
  /** Options to pick from. The "all" choice is rendered automatically as
   *  the first row with the empty-string value. */
  options: string[]
  /** Label shown when nothing is selected ("All Brands", "All Categories"). */
  placeholder: string
  ariaLabel: string
  className?: string
}

export function FilterSelect({
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
  className,
}: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const displayLabel = value || placeholder

  return (
    <div ref={wrapperRef} className={`relative inline-block ${className ?? ''}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex h-9 items-center gap-2 rounded-card border border-line bg-surface pl-3 pr-8 text-tiny font-semibold text-ink-2 outline-none hover:bg-surface-2 ${
          open ? 'border-brand ring-2 ring-brand/30' : ''
        }`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span className="max-w-[180px] truncate">{displayLabel}</span>
        <ChevronDown
          size={12}
          strokeWidth={2.5}
          className={`absolute right-2.5 text-ink-3 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open ? (
        <div
          className="absolute left-0 top-[calc(100%+4px)] z-30 max-h-64 w-56 overflow-y-auto overflow-x-hidden rounded-card border border-line bg-surface shadow-lg"
          role="listbox"
          aria-label={ariaLabel}
        >
          {/* "All" / placeholder row — always first, always visible.
              Highlighted when no specific value is selected. */}
          <button
            type="button"
            onClick={() => {
              onChange('')
              setOpen(false)
            }}
            className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-tiny font-semibold transition-colors ${
              value === '' ? 'bg-brand/10 text-brand' : 'text-ink hover:bg-surface-2'
            }`}
            role="option"
            aria-selected={value === ''}
          >
            <span className="truncate">{placeholder}</span>
            {value === '' ? <CheckIcon size={12} strokeWidth={3} className="flex-shrink-0" /> : null}
          </button>
          {/* Faint divider between "All" and the per-option list */}
          <div className="border-t border-line" />
          {options.map((opt) => {
            const active = value === opt
            return (
              <button
                key={opt}
                type="button"
                onClick={() => {
                  onChange(opt)
                  setOpen(false)
                }}
                className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-tiny font-semibold transition-colors ${
                  active ? 'bg-brand/10 text-brand' : 'text-ink hover:bg-surface-2'
                }`}
                role="option"
                aria-selected={active}
              >
                <span className="truncate" title={opt}>{opt}</span>
                {active ? <CheckIcon size={12} strokeWidth={3} className="flex-shrink-0" /> : null}
              </button>
            )
          })}
          {options.length === 0 ? (
            <div className="px-3 py-2 text-center text-2xs text-ink-3">No options available</div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
