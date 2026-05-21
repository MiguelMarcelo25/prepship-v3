// 2026-05-15: Reusable autosuggest combobox.
//
// Why this exists (operator request 2026-05-15):
//   The Receive Inventory tab used a native HTML <datalist>
//   to suggest SKUs. Chrome's datalist UI is unstyleable and
//   shows ALL ~300+ SKUs as a giant scrollable list before any
//   filtering — the operator had to scroll forever to find a
//   SKU even when they remembered the brand. Native datalists
//   also can't show secondary text (the product name) cleanly
//   alongside the value (the SKU code).
//
// What this provides:
//   • Type-to-filter combobox with keyboard navigation
//     (arrow keys, Enter, Escape, Tab to close)
//   • Ranked matches: exact value > value-prefix > value-substring
//     > label-prefix > label-substring. So typing "B0DR" floats
//     SKUs that START with B0DR above SKUs that merely contain it.
//   • Two-line option layout: SKU code (mono, prominent) over
//     product name (smaller, secondary). Operators recognize
//     either field and the dropdown reads at-a-glance.
//   • Optional empty-state hint so empty queries can surface
//     "type to search" instead of an awkward blank popover.
//   • Click-outside + Esc dismissal mirroring FilterSelect /
//     DateRangePicker conventions in this codebase.
//   • Generic by design — used first on the Receive tab SKU
//     picker but immediately reusable for parent-SKU pickers,
//     bulk-edit drawers, new-order modal SKU lookup, etc.

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { createPortal } from 'react-dom'

export interface AutosuggestOption {
  /** Primary identifier — what gets stored when the user picks this option. */
  value: string
  /** Human-readable secondary text. Searched alongside `value`. */
  label: string
  /** Optional tertiary hint (e.g. inventory count, client name). */
  hint?: string
  /** Optional thumbnail URL rendered to the LEFT of the text content.
   *  When present, an empty placeholder square is reserved even if the
   *  image fails to load — keeps row height stable so keyboard
   *  navigation doesn't shift content under the cursor. Null/undefined
   *  hides the thumbnail column entirely for that option. */
  imageUrl?: string | null
}

interface Props {
  /** Controlled input value. */
  value: string
  /** Fired on every keystroke AND on suggestion pick. */
  onChange: (value: string) => void
  /** Fired ONLY when a suggestion is picked (click or Enter on highlighted). */
  onSelect?: (option: AutosuggestOption) => void
  /** Full universe of options — filtered client-side. */
  options: AutosuggestOption[]
  /** Placeholder text. */
  placeholder?: string
  /** Cap on visible suggestions (perf + readability). Default 8. */
  maxResults?: number
  /** Shown when there are no matches for the current query. Default
   *  null → no popover when no matches. */
  emptyMessage?: string | null
  /** className applied to the input element. Useful for matching
   *  surrounding form styling (e.g. `ship-select` in this app). */
  inputClassName?: string
  /** Inline style overrides for the input element. */
  inputStyle?: CSSProperties
  /** Optional className applied to the suggestion popover. */
  popoverClassName?: string
  /** Inline style overrides for the suggestion popover. */
  popoverStyle?: CSSProperties
  /** Render the popover in document.body so parent overflow containers
   *  cannot clip it. Use for comboboxes embedded in scrollable tables. */
  renderInPortal?: boolean
  /** Should suggestions appear when the input is focused but empty?
   *  Default true — matches operator expectation of "click the field
   *  to see what's available, then narrow by typing." Set false on
   *  high-cardinality lookups where an empty list is meaningless. */
  showOnFocus?: boolean
  /** ARIA label for the input. */
  ariaLabel?: string
  /** Disable the input. */
  disabled?: boolean
  /** Auto-focus on mount. */
  autoFocus?: boolean
}

export interface AutosuggestHandle {
  /** Programmatically focus the input — useful when the parent wants
   *  to move focus into a freshly-added Receive row. */
  focus: () => void
}

// 2026-05-15: hover-magnifier state shape. Mirrors InventoryView's
// ThumbnailPreviewState (web/src/components/Views/InventoryView.tsx)
// so the preview overlay renders identically across the table and
// the autosuggest dropdown — one mental model for operators.
interface ThumbnailPreviewState {
  src: string
  left: number
  top: number
  zoom: number
}

// Position the preview floating to the RIGHT of the cursor, vertically
// centered on it, clamped to viewport bounds so it never clips off-
// screen. Lifted from InventoryView's positionThumbnailPreview helper
// to keep cross-component visual parity. The body-zoom math is
// defensive: some operator setups (browser zoom + OS DPR > 1)
// double-multiply position values; dividing by the resolved zoom
// keeps the overlay anchored to the actual cursor position.
function computePreviewPosition(cursorX: number, cursorY: number): {
  left: number
  top: number
  zoom: number
} {
  const zoomRaw = Number.parseFloat(window.getComputedStyle(document.body).zoom)
  const zoom = Number.isFinite(zoomRaw) && zoomRaw > 0
    ? zoomRaw > 10 ? zoomRaw / 100 : zoomRaw
    : 1
  const width = 170
  const height = 170
  const gap = 14
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const rawLeft = Math.max(gap, Math.min(cursorX + gap, viewportWidth - width - gap))
  const rawTop = Math.max(gap, Math.min(cursorY - height / 2, viewportHeight - height - gap))
  return {
    left: rawLeft / zoom,
    top: rawTop / zoom,
    zoom: 1 / zoom,
  }
}

// Rank a single option against a query. Higher = better match.
// Returns -1 if no match at all. Ranking ladder:
//   100 — exact value match (case-insensitive)
//    80 — value starts with query
//    60 — value contains query (substring elsewhere)
//    40 — label starts with query
//    20 — label contains query
//    -1 — no match
function scoreOption(option: AutosuggestOption, query: string): number {
  if (!query) return 0
  const q = query.toLowerCase()
  const v = option.value.toLowerCase()
  const l = option.label.toLowerCase()
  if (v === q) return 100
  if (v.startsWith(q)) return 80
  if (v.includes(q)) return 60
  if (l.startsWith(q)) return 40
  if (l.includes(q)) return 20
  return -1
}

const Autosuggest = forwardRef<AutosuggestHandle, Props>(function Autosuggest(
  {
    value,
    onChange,
    onSelect,
    options,
    placeholder,
    maxResults = 8,
    emptyMessage = null,
    inputClassName = 'ship-select',
    inputStyle,
    popoverClassName,
    popoverStyle,
    renderInPortal = false,
    showOnFocus = true,
    ariaLabel,
    disabled = false,
    autoFocus = false,
  },
  ref,
) {
  const inputRef = useRef<HTMLInputElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const listboxRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [portalPosition, setPortalPosition] = useState<{ left: number; top: number } | null>(null)
  // 2026-05-15: floating large-preview overlay state. Set on
  // mouseenter of an option's thumbnail, cleared on mouseleave OR
  // when the popover closes (effect below). pointer-events:none on
  // the overlay means hovering over the preview itself doesn't
  // steal hover from the underlying option — no flicker, no
  // hover-trap.
  const [thumbnailPreview, setThumbnailPreview] = useState<ThumbnailPreviewState | null>(null)
  const listboxId = useId()

  // Expose imperative focus to the parent. Used when the operator
  // adds a new Receive row — the parent should be able to focus the
  // SKU field of the new row immediately.
  useImperativeHandle(
    ref,
    () => ({
      focus: () => inputRef.current?.focus(),
    }),
    [],
  )

  // Filter + rank + slice. Memoized on (value, options) so unchanged
  // queries don't re-sort the universe. With 300 SKUs the work is
  // trivial; for larger datasets a debounce would be the next step.
  const matches = useMemo(() => {
    const trimmed = value.trim()
    // Empty query: show first N options as-is so the operator sees
    // a useful list when they click the field. Skip if showOnFocus
    // is disabled.
    if (!trimmed) {
      return showOnFocus ? options.slice(0, maxResults) : []
    }
    const scored: Array<{ option: AutosuggestOption; score: number }> = []
    for (const option of options) {
      const score = scoreOption(option, trimmed)
      if (score < 0) continue
      scored.push({ option, score })
    }
    scored.sort((a, b) => {
      // Primary: rank score desc. Secondary: alphabetical by value
      // so equal-ranked items appear deterministically (B0DR3TB76T
      // before B0DR4TB76T) instead of bouncing between renders.
      if (b.score !== a.score) return b.score - a.score
      return a.option.value.localeCompare(b.option.value)
    })
    return scored.slice(0, maxResults).map((entry) => entry.option)
  }, [value, options, maxResults, showOnFocus])

  // Reset highlighted index when the visible list changes — otherwise
  // the user could press Enter and pick a stale option from a different
  // filter result.
  useEffect(() => {
    setActiveIndex(0)
  }, [value])

  // 2026-05-15: clear the floating preview the moment the popover
  // closes. Without this, picking an option (which closes the
  // popover) would leave the large preview overlay floating on
  // screen until the user moved their cursor.
  useEffect(() => {
    if (!open) setThumbnailPreview(null)
  }, [open])

  const updatePortalPosition = useCallback(() => {
    if (!renderInPortal || typeof window === 'undefined' || !inputRef.current) return
    const rect = inputRef.current.getBoundingClientRect()
    setPortalPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 24)),
      top: Math.min(rect.bottom + 4, window.innerHeight - 16),
    })
  }, [renderInPortal])

  useEffect(() => {
    if (!open || !renderInPortal) return
    updatePortalPosition()
    window.addEventListener('resize', updatePortalPosition)
    window.addEventListener('scroll', updatePortalPosition, true)
    return () => {
      window.removeEventListener('resize', updatePortalPosition)
      window.removeEventListener('scroll', updatePortalPosition, true)
    }
  }, [open, renderInPortal, updatePortalPosition])

  const handleThumbnailEnter = useCallback(
    (event: ReactMouseEvent<HTMLImageElement>, src: string) => {
      if (!src) return
      setThumbnailPreview({
        src,
        ...computePreviewPosition(event.clientX, event.clientY),
      })
    },
    [],
  )

  const handleThumbnailLeave = useCallback(() => {
    setThumbnailPreview(null)
  }, [])

  // Click-outside + Esc dismissal. Mirrors the FilterSelect pattern
  // exactly so popover behavior across the app stays consistent.
  useEffect(() => {
    if (!open) return
    function handlePointerDown(event: MouseEvent) {
      if (!wrapperRef.current) return
      if (wrapperRef.current.contains(event.target as Node)) return
      if (listboxRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  // Scroll the active option into view when it changes via keyboard.
  // Without this, ArrowDown past the visible list silently selects
  // hidden rows below — confusing, and the user can't see what's
  // currently active.
  useEffect(() => {
    if (!open || !listboxRef.current) return
    const activeEl = listboxRef.current.querySelector<HTMLElement>(
      `[data-autosuggest-index="${activeIndex}"]`,
    )
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest' })
    }
  }, [activeIndex, open])

  const commitSelection = useCallback(
    (option: AutosuggestOption) => {
      onChange(option.value)
      onSelect?.(option)
      setOpen(false)
      // Refocus the input after pick so the operator can immediately
      // tab to the next field. Without this, focus jumps to <body>
      // when the popover unmounts.
      setTimeout(() => inputRef.current?.focus(), 0)
    },
    [onChange, onSelect],
  )

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    // Open on first arrow key even if popover was closed — matches
    // standard combobox behavior.
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !open) {
      event.preventDefault()
      updatePortalPosition()
      setOpen(true)
      return
    }

    if (!open) return

    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault()
        setActiveIndex((idx) => Math.min(matches.length - 1, idx + 1))
        return
      }
      case 'ArrowUp': {
        event.preventDefault()
        setActiveIndex((idx) => Math.max(0, idx - 1))
        return
      }
      case 'Enter': {
        if (matches[activeIndex]) {
          event.preventDefault()
          commitSelection(matches[activeIndex])
        }
        return
      }
      case 'Tab': {
        // Tab closes the popover but does NOT pick the highlighted
        // option — Tab is "move on without committing" by web
        // convention. Enter is "pick this one."
        setOpen(false)
        return
      }
      default:
        return
    }
  }

  const showPopover = open && (matches.length > 0 || emptyMessage != null)

  return (
    <div
      ref={wrapperRef}
      className="relative inline-block w-full"
    >
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && matches[activeIndex]
            ? `${listboxId}-option-${activeIndex}`
            : undefined
        }
        aria-label={ariaLabel}
        className={inputClassName}
        style={{ width: '100%', ...inputStyle }}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        // autoComplete=off keeps the BROWSER's native autofill from
        // overlapping our popover — without this Chrome stacks both
        // dropdowns and you get a worst-of-both-worlds UI.
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          onChange(event.target.value)
          updatePortalPosition()
          setOpen(true)
        }}
        onFocus={() => {
          if (showOnFocus) {
            updatePortalPosition()
            setOpen(true)
          }
        }}
        onKeyDown={handleKeyDown}
      />
      {(() => {
        const popover = showPopover ? (
        <div
          ref={listboxRef}
          id={listboxId}
          role="listbox"
          className={`
            ${renderInPortal ? 'fixed' : 'absolute left-0 top-full mt-1'} z-50
            max-h-72 overflow-y-auto
            rounded-lg bg-surface ring-1 ring-line shadow-lg
            text-left
            ${popoverClassName ?? 'right-0'}
          `}
          style={
            renderInPortal
              ? {
                  ...popoverStyle,
                  left: portalPosition?.left ?? 8,
                  top: portalPosition?.top ?? 8,
                  zIndex: 1000,
                }
              : popoverStyle
          }
        >
          {matches.length === 0 && emptyMessage ? (
            <div className="px-3 py-2 text-[12px] text-ink-3 italic">
              {emptyMessage}
            </div>
          ) : (
            matches.map((option, index) => {
              const isActive = index === activeIndex
              return (
                <button
                  key={`${option.value}-${index}`}
                  type="button"
                  id={`${listboxId}-option-${index}`}
                  data-autosuggest-index={index}
                  role="option"
                  aria-selected={isActive}
                  // mousedown not click — click fires AFTER the
                  // input's blur which would close the popover
                  // before the option gets a chance to commit.
                  onMouseDown={(event) => {
                    event.preventDefault()
                    commitSelection(option)
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={`
                    flex w-full items-center gap-2.5 text-left px-3 py-2
                    border-b border-line/50 last:border-b-0
                    transition-colors
                    ${isActive ? 'bg-brand/10' : 'bg-surface hover:bg-surface-2'}
                    focus:outline-none
                  `}
                >
                  {/* Thumbnail column — present only when imageUrl is
                      defined for this option. The 36x36 wrapper is
                      always reserved (not collapsed) so options with
                      missing/loading images don't visually jitter the
                      list as new rows render. loading="lazy" +
                      decoding="async" stagger network fetches so a
                      slow image host doesn't block the dropdown
                      becoming interactive. onError swap to a neutral
                      placeholder ring so a 404 thumbnail doesn't
                      render the broken-image glyph (operator-visible
                      eyesore). */}
                  {option.imageUrl !== undefined ? (
                    <div
                      className="
                        flex-shrink-0 w-9 h-9 rounded
                        bg-surface-2 ring-1 ring-line/70
                        overflow-hidden
                        flex items-center justify-center
                      "
                    >
                      {option.imageUrl ? (
                        <img
                          src={option.imageUrl}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover cursor-zoom-in"
                          onError={(event) => {
                            // Hide on load failure so the empty
                            // placeholder shows instead of the
                            // browser's broken-image glyph.
                            (event.currentTarget as HTMLImageElement).style.display = 'none'
                          }}
                          // 2026-05-15: hover-magnifier preview.
                          // Same UX as the Inventory table thumbnails
                          // — operator hovers, large preview floats
                          // to the right of the cursor. cursor-zoom-in
                          // signals the affordance.
                          onMouseEnter={(event) =>
                            handleThumbnailEnter(event, option.imageUrl ?? '')
                          }
                          onMouseLeave={handleThumbnailLeave}
                        />
                      ) : null}
                    </div>
                  ) : null}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-[12px] font-bold text-ink truncate">
                        {option.value}
                      </span>
                      {option.hint ? (
                        <span className="text-[10.5px] text-ink-3 tabular-nums flex-shrink-0">
                          {option.hint}
                        </span>
                      ) : null}
                    </div>
                    {option.label ? (
                      <div className="text-[11.5px] text-ink-2 truncate mt-0.5">
                        {option.label}
                      </div>
                    ) : null}
                  </div>
                </button>
              )
            })
          )}
        </div>
        ) : null
        return renderInPortal && typeof document !== 'undefined'
          ? createPortal(popover, document.body)
          : popover
      })()}
      {/* 2026-05-15: Floating large-preview overlay shown when the
          operator hovers an option's thumbnail. Position-fixed so it
          floats above EVERY ancestor (including overflow:hidden
          parents like the Receive row container that would clip an
          absolutely-positioned child). pointer-events:none ensures
          hovering the preview itself doesn't intercept the cursor —
          the operator can move smoothly between adjacent options
          without flicker. zoom property handles browser-level zoom
          edge cases (some setups double-multiply position values
          when document.body has a non-1 zoom). */}
      {thumbnailPreview ? (
        <div
          className="
            fixed z-[99999]
            bg-surface ring-1 ring-line rounded-lg
            shadow-2xl p-1
            pointer-events-none
          "
          style={{
            left: `${thumbnailPreview.left}px`,
            top: `${thumbnailPreview.top}px`,
            zoom: String(thumbnailPreview.zoom),
          }}
          aria-hidden
        >
          <img
            src={thumbnailPreview.src}
            alt=""
            referrerPolicy="no-referrer"
            className="w-40 h-40 object-contain rounded block"
          />
        </div>
      ) : null}
    </div>
  )
})

export default Autosuggest
