// ──────────────────────────────────────────────────────────────────
// useTableState — the state engine behind <Table>.
//
// PS-157: extracted VERBATIM from Table.tsx. This hook owns ALL of the
// table's interactive state and its localStorage persistence:
//   - sort state (key + direction)
//   - pagination (page + pageSize, client + server modes)
//   - column visibility (hiddenKeys)
//   - column order (orderKeys + drag-reorder handlers)
//   - column widths (widths + resize / auto-fit handlers)
//   - the Columns picker open/close + click-outside
//   - all derived data: orderedColumns, sorted/pinned/paged rows,
//     fitted column widths, viewport-fit math
//
// Table.tsx is now a pure renderer: it calls `useTableState({...})`
// and reads `ts.*`. Behaviour is byte-identical to the pre-refactor
// component — nothing here changed except the move. RENDERING (the
// <table>, <thead>, <tbody>, toolbar, Columns popover JSX, pagination
// bar) stays in Table.tsx.
//
// Refs that the rendering attaches to DOM nodes (tableScrollRef,
// theadRef, tbodyRef) live here because the resize / auto-fit / drag
// handlers read them; Table.tsx threads them onto the JSX.
// ──────────────────────────────────────────────────────────────────

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
// Type-only default import so the verbatim `React.DragEvent<...>` annotations
// moved from Table.tsx resolve under strict tsc (erased at build — no runtime
// React namespace import is added).
import type React from 'react'
import type { SortState, TableColumn } from './Table'

// localStorage helpers — defensive, never throw.
function readStoredSort(storageKey: string | undefined): SortState | null {
  if (!storageKey || typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(`${storageKey}:sort`)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.key === 'string' && (parsed.direction === 'asc' || parsed.direction === 'desc')) {
      return parsed as SortState
    }
  } catch { /* localStorage blocked */ }
  return null
}

function readStoredWidths(storageKey: string | undefined): Record<string, number> {
  if (!storageKey || typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(`${storageKey}:widths`)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v
    }
    return out
  } catch { /* non-fatal */ return {} }
}

function readStoredOrder(storageKey: string | undefined): string[] | null {
  if (!storageKey || typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(`${storageKey}:order`)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    return parsed.filter((k): k is string => typeof k === 'string')
  } catch { /* non-fatal */ return null }
}

// Pagination state persistence — page number and chosen page size.
// Each lives under its own subkey so we can read/write independently.
function readStoredPage(storageKey: string | undefined): number | null {
  if (!storageKey || typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(`${storageKey}:page`)
    const n = raw ? Number.parseInt(raw, 10) : Number.NaN
    return Number.isFinite(n) && n >= 1 ? n : null
  } catch { return null }
}

function readStoredPageSize(storageKey: string | undefined, options: number[]): number | null {
  if (!storageKey || typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(`${storageKey}:pageSize`)
    const n = raw ? Number.parseInt(raw, 10) : Number.NaN
    return options.includes(n) ? n : null
  } catch { return null }
}

function readStoredHidden(storageKey: string | undefined): string[] | null {
  // Persisted as an array of column keys that the operator has
  // CHOSEN to hide. Stored as an explicit list so the absence of
  // localStorage cleanly falls back to "everything visible" (or to
  // the column's defaultHidden flag) instead of erroneously
  // hiding every column when storage is empty.
  if (!storageKey || typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(`${storageKey}:hidden`)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    return parsed.filter((k): k is string => typeof k === 'string')
  } catch { /* non-fatal */ return null }
}

// Comparable extractor — strings get lowercased so sort is
// case-insensitive (default behavior expected by operators looking
// for "amazon" + "Amazon" to land together).
function comparable(val: unknown): number | string | null {
  if (val == null) return null
  if (val instanceof Date) return val.getTime()
  if (typeof val === 'boolean') return val ? 1 : 0
  if (typeof val === 'number') return Number.isFinite(val) ? val : null
  return String(val).toLowerCase()
}

function compareValues(a: ReturnType<typeof comparable>, b: ReturnType<typeof comparable>): number {
  // Nulls always sort LAST regardless of direction — industry standard
  // (Excel, Numbers, every SQL ORDER BY ... NULLS LAST). Predictable.
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b))
}

// Default pagination options when caller doesn't supply pageSizeOptions
// but does opt into `paginated`. Operators on the Inventory page use
// [10,20,50,100,200]; this default mirrors the Packages page so most
// callers don't need to set the array explicitly.
const DEFAULT_PAGE_SIZE_OPTIONS = [25, 50, 100]

export interface UseTableStateParams<Row> {
  data: Row[]
  columns: TableColumn<Row>[]
  storageKey?: string
  defaultSort?: SortState | null
  showColumnControls?: boolean
  paginated?: boolean
  pageSizeOptions?: number[]
  defaultPageSize?: number
  serverPagination?: {
    page: number
    pageSize: number
    totalItems: number
    onPageChange: (page: number) => void
    onPageSizeChange: (pageSize: number) => void
  }
  pinRowToBottom?: (row: Row) => boolean
  loading?: boolean
}

export function useTableState<Row>({
  data,
  columns,
  storageKey,
  defaultSort,
  showColumnControls = true,
  paginated,
  pageSizeOptions,
  defaultPageSize,
  serverPagination,
  pinRowToBottom,
  loading,
}: UseTableStateParams<Row>) {
  // Sort state — reads stored value first, falls through to default.
  const [sort, setSort] = useState<SortState | null>(() => readStoredSort(storageKey) ?? defaultSort ?? null)
  useEffect(() => {
    if (!storageKey) return
    try {
      if (sort) window.localStorage.setItem(`${storageKey}:sort`, JSON.stringify(sort))
      else window.localStorage.removeItem(`${storageKey}:sort`)
    } catch { /* non-fatal */ }
  }, [sort, storageKey])

  // Column widths state. Stored values clamped against each column's
  // current minWidth on read so a stale narrow width from an older
  // version doesn't make a column unreadable.
  const [widths, setWidths] = useState<Record<string, number>>(() => {
    const stored = readStoredWidths(storageKey)
    const cleaned: Record<string, number> = {}
    for (const col of columns) {
      const min = col.minWidth ?? 60
      const max = col.maxWidth ?? 800
      const v = stored[col.key]
      if (typeof v === 'number') cleaned[col.key] = Math.max(min, Math.min(max, v))
    }
    return cleaned
  })
  useEffect(() => {
    if (!storageKey) return
    try { window.localStorage.setItem(`${storageKey}:widths`, JSON.stringify(widths)) } catch { /* non-fatal */ }
  }, [widths, storageKey])

  // Column ORDER state. Defensive migration on read:
  //   - filter out unknown keys (stale localStorage from removed cols)
  //   - append any keys that are NEW since the operator's last save
  //     so newly-shipped columns auto-appear at the end
  // Pinned columns are forced back to their declared positions on
  // every render (they're non-reorderable by contract).
  const initialOrderKeys = columns.map((c) => c.key)
  const [orderKeys, setOrderKeys] = useState<string[]>(() => {
    const stored = readStoredOrder(storageKey)
    if (!stored) return initialOrderKeys
    const known = new Set(initialOrderKeys)
    const seen = new Set<string>()
    const cleaned: string[] = []
    for (const k of stored) {
      if (known.has(k) && !seen.has(k)) { cleaned.push(k); seen.add(k) }
    }
    for (const k of initialOrderKeys) {
      if (!seen.has(k)) cleaned.push(k)
    }
    return cleaned
  })
  useEffect(() => {
    if (!storageKey) return
    try { window.localStorage.setItem(`${storageKey}:order`, JSON.stringify(orderKeys)) } catch { /* non-fatal */ }
  }, [orderKeys, storageKey])

  // Column HIDDEN state. Stored as a list of keys the operator
  // has chosen to hide. On first load (no stored value), hide
  // any columns flagged `defaultHidden`. Once the operator
  // interacts with the picker, the stored array is authoritative.
  // Non-hideable columns are always kept visible.
  const [hiddenKeys, setHiddenKeys] = useState<string[]>(() => {
    const stored = readStoredHidden(storageKey)
    if (stored) {
      const known = new Set(columns.map((c) => c.key))
      const hideable = new Set(columns.filter((c) => c.hideable !== false).map((c) => c.key))
      return stored.filter((k) => known.has(k) && hideable.has(k))
    }
    return columns.filter((c) => c.defaultHidden && c.hideable !== false).map((c) => c.key)
  })
  useEffect(() => {
    if (!storageKey) return
    try { window.localStorage.setItem(`${storageKey}:hidden`, JSON.stringify(hiddenKeys)) } catch { /* non-fatal */ }
  }, [hiddenKeys, storageKey])

  // Resolve column metadata in the operator's chosen order, then
  // strip out hidden columns. Pinned columns are KEPT at their
  // declared positions even if orderKeys moved them — pinned means
  // "this column does not move." Pinned columns CAN still be
  // hidden via the picker if their `hideable` is not explicitly
  // false (operators may want to free up screen space).
  const orderedColumns = useMemo<TableColumn<Row>[]>(() => {
    // PS-157: `as const` is a TYPE-LEVEL tuple hint (no runtime effect) so the
    // strict tsconfig infers Map<string, TableColumn<Row>> instead of widening
    // the entries to (string | TableColumn<Row>)[]. Behaviour is unchanged.
    const byKey = new Map(columns.map((c) => [c.key, c] as const))
    // Step 1: pinned columns stay at their declared indexes
    const pinnedAt: { col: TableColumn<Row>; index: number }[] = []
    columns.forEach((c, i) => { if (c.pinned) pinnedAt.push({ col: c, index: i }) })
    // Step 2: reorderable columns sorted by orderKeys
    const reorderable = orderKeys
      .map((k) => byKey.get(k))
      .filter((c): c is TableColumn<Row> => !!c && !c.pinned)
    // Step 3: stitch: insert pinned at their original indexes
    const result: TableColumn<Row>[] = [...reorderable]
    pinnedAt.forEach(({ col, index }) => result.splice(index, 0, col))
    // Step 4: filter out hidden columns
    const hidden = new Set(showColumnControls ? hiddenKeys : [])
    return result.filter((c) => !hidden.has(c.key))
  }, [columns, orderKeys, hiddenKeys, showColumnControls])
  const columnWidths = useMemo<Record<string, number>>(() => {
    const desired: Record<string, number> = {}
    for (const col of orderedColumns) {
      const raw = widths[col.key] ?? col.width
      const fallback = Number.isFinite(col.width) ? col.width : 120
      const min = col.minWidth ?? 60
      const max = col.maxWidth ?? 800
      const resolved = Number.isFinite(raw) ? raw : fallback
      desired[col.key] = Math.max(min, Math.min(max, resolved))
    }
    return desired
  }, [orderedColumns, widths])
  const tableScrollRef = useRef<HTMLDivElement | null>(null)
  const [tableViewportWidth, setTableViewportWidth] = useState(0)
  useEffect(() => {
    const el = tableScrollRef.current
    if (!el) return
    const measure = () => setTableViewportWidth(el.clientWidth)
    measure()
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure)
      observer.observe(el)
      return () => observer.disconnect()
    }
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])
  const fittedColumnWidths = useMemo<Record<string, number>>(() => {
    const next = { ...columnWidths }
    if (!tableViewportWidth || orderedColumns.length === 0) return next

    // PS-157: `!` non-null assertions below are TYPE-LEVEL ONLY (erased at
    // runtime, so behaviour is byte-identical to the original @ts-nocheck
    // Table.tsx). They satisfy `noUncheckedIndexedAccess` — every key read
    // here was populated for all `orderedColumns` by the columnWidths memo.
    const total = orderedColumns.reduce((sum, col) => sum + next[col.key]!, 0)
    if (total <= tableViewportWidth) return next

    let overflow = total - tableViewportWidth
    const shrinkable = orderedColumns.reduce((sum, col) => {
      const min = col.minWidth ?? 60
      return sum + Math.max(0, next[col.key]! - min)
    }, 0)
    if (shrinkable <= 0) return next

    for (const col of orderedColumns) {
      const min = col.minWidth ?? 60
      const room = Math.max(0, next[col.key]! - min)
      if (room <= 0) continue
      const reduction = Math.min(room, overflow * (room / shrinkable))
      next[col.key] = next[col.key]! - reduction
    }

    let fittedTotal = orderedColumns.reduce((sum, col) => sum + next[col.key]!, 0)
    for (const col of orderedColumns) {
      if (fittedTotal <= tableViewportWidth) break
      const min = col.minWidth ?? 60
      const room = Math.max(0, next[col.key]! - min)
      const reduction = Math.min(room, fittedTotal - tableViewportWidth)
      next[col.key] = next[col.key]! - reduction
      fittedTotal -= reduction
    }
    return next
  }, [columnWidths, orderedColumns, tableViewportWidth])
  const getColumnFitMax = (col: TableColumn<Row>) => {
    const min = col.minWidth ?? 60
    const configuredMax = col.maxWidth ?? 800
    const viewport = tableScrollRef.current?.clientWidth ?? tableViewportWidth
    if (!viewport) return configuredMax
    const otherMinimums = orderedColumns.reduce((sum, other) => (
      other.key === col.key ? sum : sum + (other.minWidth ?? 60)
    ), 0)
    return Math.max(min, Math.min(configuredMax, viewport - otherMinimums))
  }
  const tableMinWidth = useMemo(() => (
    Math.min(tableViewportWidth || 480, Math.max(480, orderedColumns.reduce((sum, col) => sum + (col.minWidth ?? 60), 0)))
  ), [orderedColumns, tableViewportWidth])

  // Columns picker open state — controlled here so the toolbar
  // trigger button and the dropdown body share the same state.
  const [columnsPickerOpen, setColumnsPickerOpen] = useState(false)
  const columnsPickerRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!columnsPickerOpen) return
    const onDown = (e: globalThis.MouseEvent) => {
      if (!columnsPickerRef.current) return
      if (e.target instanceof Node && columnsPickerRef.current.contains(e.target)) return
      setColumnsPickerOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setColumnsPickerOpen(false) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [columnsPickerOpen])

  const toggleHidden = (key: string) => {
    setHiddenKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
  }
  const resetWidths = () => setWidths({})
  const resetOrder = () => setOrderKeys(columns.map((c) => c.key))
  const resetHidden = () => setHiddenKeys(columns.filter((c) => c.defaultHidden && c.hideable !== false).map((c) => c.key))
  const resetAll = () => { resetWidths(); resetOrder(); resetHidden() }

  // Drag-reorder state — which key is being dragged, which is the
  // current drop target. Used for visual feedback (faded source,
  // inset shadow on target).
  const [draggingKey, setDraggingKey] = useState<string | null>(null)
  const [dragOverKey, setDragOverKey] = useState<string | null>(null)
  const handleDragStart = (col: TableColumn<Row>) => (event: React.DragEvent<HTMLTableCellElement>) => {
    if (col.pinned) {
      event.preventDefault()
      return
    }
    setDraggingKey(col.key)
    // setData required by Firefox to actually initiate the drag
    event.dataTransfer.setData('text/plain', col.key)
    event.dataTransfer.effectAllowed = 'move'
  }
  const handleDragOver = (col: TableColumn<Row>) => (event: React.DragEvent<HTMLTableCellElement>) => {
    if (col.pinned || !draggingKey || draggingKey === col.key) return
    event.preventDefault() // required to enable drop
    event.dataTransfer.dropEffect = 'move'
    if (dragOverKey !== col.key) setDragOverKey(col.key)
  }
  const handleDrop = (col: TableColumn<Row>) => (event: React.DragEvent<HTMLTableCellElement>) => {
    event.preventDefault()
    const from = draggingKey
    setDraggingKey(null)
    setDragOverKey(null)
    if (col.pinned || !from || from === col.key) return
    setOrderKeys((prev) => {
      const fromIdx = prev.indexOf(from)
      const toIdx = prev.indexOf(col.key)
      if (fromIdx === -1 || toIdx === -1) return prev
      const next = [...prev]
      next.splice(fromIdx, 1)
      next.splice(toIdx, 0, from)
      return next
    })
  }
  const handleDragEnd = () => {
    setDraggingKey(null)
    setDragOverKey(null)
  }

  const toggleSort = (col: TableColumn<Row>) => {
    if (!col.sortable) return
    setSort((current) => {
      if (!current || current.key !== col.key) return { key: col.key, direction: 'desc' }
      if (current.direction === 'desc') return { key: col.key, direction: 'asc' }
      return null // third click clears sort
    })
  }

  // Resize gesture — window-level handlers so the drag continues
  // even when the cursor leaves the handle (standard CSV-viewer
  // pattern). Captures startX + startWidth at mousedown.
  const resizingRef = useRef<{ key: string; startX: number; startWidth: number; min: number; max: number } | null>(null)
  const startResize = (col: TableColumn<Row>) => (event: ReactMouseEvent<HTMLDivElement>) => {
    if (col.pinned) return
    event.preventDefault()
    event.stopPropagation()
    const min = col.minWidth ?? 60
    const max = getColumnFitMax(col)
    const startWidth = fittedColumnWidths[col.key] ?? columnWidths[col.key] ?? col.width
    resizingRef.current = { key: col.key, startX: event.clientX, startWidth, min, max }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const onMove = (e: MouseEvent) => {
      const ctx = resizingRef.current
      if (!ctx) return
      const next = Math.max(ctx.min, Math.min(ctx.max, ctx.startWidth + (e.clientX - ctx.startX)))
      setWidths((prev) => ({ ...prev, [ctx.key]: next }))
    }
    const onUp = () => {
      resizingRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Auto-fit a column to its content (double-click the resize handle).
  // Measures the actual rendered text in every visible cell of the
  // column, finds the widest one, adds a small padding buffer, and
  // clamps to [minWidth, maxWidth]. Industry-standard Excel/Numbers
  // gesture — operators expect this to "just work" on double-click.
  const tbodyRef = useRef<HTMLTableSectionElement | null>(null)
  const theadRef = useRef<HTMLTableSectionElement | null>(null)
  const autoFitColumn = (col: TableColumn<Row>) => {
    if (col.pinned) return
    const min = col.minWidth ?? 60
    const max = getColumnFitMax(col)
    const PADDING = 28 // px — covers the cell's px-3 (12px each side) + a tiny safety margin
    const colIndex = orderedColumns.findIndex((c) => c.key === col.key)
    if (colIndex === -1) return
    let widest = 0
    // Measure header label
    const headerCell = theadRef.current?.querySelector(`th[data-col-key="${col.key}"]`) as HTMLElement | null
    if (headerCell) {
      const span = headerCell.querySelector('span.truncate') as HTMLElement | null
      // scrollWidth = the natural content width, even when truncated
      if (span) widest = Math.max(widest, span.scrollWidth)
    }
    // Measure body cells
    const cells = tbodyRef.current?.querySelectorAll<HTMLElement>(`td[data-col-key="${col.key}"]`)
    cells?.forEach((cell) => {
      // Walk to the deepest single content node — scrollWidth on the
      // <td> itself is clamped to its own width because of
      // overflow-hidden, so we look inside.
      const inner = (cell.firstElementChild as HTMLElement | null) ?? cell
      widest = Math.max(widest, inner.scrollWidth)
    })
    if (widest === 0) return
    const next = Math.max(min, Math.min(max, widest + PADDING))
    setWidths((prev) => ({ ...prev, [col.key]: next }))
  }

  // Sorted rows — recomputed when data or sort changes.
  // If `pinRowToBottom` is provided, the result is stably partitioned
  // into `[unpinned, pinned]` so the operator's sort still applies
  // within each group. `pinnedRows` is exposed separately so the
  // pagination logic below can paginate ONLY the unpinned set and
  // append the pinned tail to every page — otherwise a 7-row pinned
  // cluster on a 50-per-page view of 200 rows would live on page 4,
  // invisible until the operator clicks through. (Inventory bug
  // 2026-05-12: operator saw "7 deactivated" in the toolbar badge
  // but couldn't see any greyscale rows because pagination hid them.)
  const { sortedRows, pinnedRows, unpinnedRows } = useMemo(() => {
    let result: Row[]
    if (!sort) {
      result = data
    } else {
      const col = columns.find((c) => c.key === sort.key)
      if (!col) {
        result = data
      } else {
        const sortValue = col.sortValue ?? ((row: Row) => (row as Record<string, unknown>)[col.key] as never)
        const sorted = [...data].sort((a, b) => compareValues(comparable(sortValue(a)), comparable(sortValue(b))))
        result = sort.direction === 'desc' ? sorted.reverse() : sorted
      }
    }
    if (!pinRowToBottom) {
      return { sortedRows: result, pinnedRows: [] as Row[], unpinnedRows: result }
    }
    // Stable partition: keep relative order within each group so
    // the operator's sort is preserved among active rows and among
    // pinned rows separately.
    const top: Row[] = []
    const bottom: Row[] = []
    for (const row of result) {
      if (pinRowToBottom(row)) bottom.push(row)
      else top.push(row)
    }
    return { sortedRows: [...top, ...bottom], pinnedRows: bottom, unpinnedRows: top }
  }, [data, sort, columns, pinRowToBottom])

  // ─── Pagination state (only used when `paginated` is true) ───────────────
  // Resolve effective pageSizeOptions + initial page size. Reads stored
  // pageSize first, then defaultPageSize prop, then falls back to a
  // sensible default within the options array.
  const effectivePageSizeOptions = pageSizeOptions ?? DEFAULT_PAGE_SIZE_OPTIONS
  const initialPageSize = useMemo(() => {
    if (!paginated) return effectivePageSizeOptions[0] ?? 50
    const stored = readStoredPageSize(storageKey, effectivePageSizeOptions)
    if (stored != null) return stored
    if (defaultPageSize != null && effectivePageSizeOptions.includes(defaultPageSize)) {
      return defaultPageSize
    }
    return effectivePageSizeOptions.includes(50) ? 50 : effectivePageSizeOptions[0] ?? 50
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [page, setPage] = useState<number>(() => readStoredPage(storageKey) ?? 1)
  const [pageSize, setPageSize] = useState<number>(initialPageSize)
  const usingServerPagination = Boolean(paginated && serverPagination)

  // Persist page + pageSize when they change.
  useEffect(() => {
    if (!paginated || !storageKey || typeof window === 'undefined') return
    try { window.localStorage.setItem(`${storageKey}:page`, String(page)) } catch { /* non-fatal */ }
  }, [page, paginated, storageKey])
  useEffect(() => {
    if (!paginated || !storageKey || typeof window === 'undefined') return
    try { window.localStorage.setItem(`${storageKey}:pageSize`, String(pageSize)) } catch { /* non-fatal */ }
  }, [pageSize, paginated, storageKey])

  // Reset to page 1 whenever the data length shrinks or the sort
  // changes — both cases can make the current page invalid. Using
  // length as a proxy for "the result set meaningfully changed" so
  // mutation-style row updates don't reset the page.
  const lastDataLengthRef = useRef(data.length)
  useEffect(() => {
    if (!paginated || usingServerPagination) return
    if (data.length < lastDataLengthRef.current) setPage(1)
    lastDataLengthRef.current = data.length
  }, [data.length, paginated, usingServerPagination])
  useEffect(() => {
    if (paginated && !usingServerPagination) setPage(1)
  }, [sort?.key, sort?.direction, paginated, usingServerPagination])

  // Clamp page when total shrinks past the operator's current page —
  // a defensive second layer for cases the length-change effect misses
  // (e.g., an externally controlled data array that swaps wholesale
  // but happens to have the same length, with different rows).
  // NOTE: maxPage is computed against UNPINNED rows because pinned
  // rows aren't paginated — they're always appended below every page.
  useEffect(() => {
    if (!paginated || usingServerPagination) return
    const maxPage = Math.max(1, Math.ceil(unpinnedRows.length / pageSize))
    if (page > maxPage) setPage(maxPage)
  }, [unpinnedRows.length, pageSize, page, paginated, usingServerPagination])

  // Slice for the visible page. Pinned rows are appended AFTER the
  // paginated slice so they appear on every page (e.g., "deactivated
  // SKUs at the bottom" on the Inventory table). When pagination is
  // off, hand sortedRows through unchanged so the rest of the render
  // path is identical and there are no surprises.
  const pagedRows = useMemo(() => {
    if (!paginated) return sortedRows
    if (usingServerPagination) return sortedRows
    const start = (page - 1) * pageSize
    const slice = unpinnedRows.slice(start, start + pageSize)
    return pinnedRows.length > 0 ? [...slice, ...pinnedRows] : slice
  }, [paginated, usingServerPagination, sortedRows, unpinnedRows, pinnedRows, page, pageSize])

  useEffect(() => {
    const el = tableScrollRef.current
    if (!el) return
    const nextWidth = el.clientWidth
    setTableViewportWidth((current) => (Math.abs(current - nextWidth) > 1 ? nextWidth : current))
  }, [
    pagedRows.length,
    orderedColumns.length,
    loading,
    paginated,
    usingServerPagination,
    page,
    pageSize,
    serverPagination?.page,
    serverPagination?.pageSize,
  ])

  // Hideable columns surfaced in the picker. Render in the
  // declared `columns` order (not the operator's reordered order)
  // so the picker layout stays stable as columns get dragged.
  const pickerColumns = showColumnControls ? columns.filter((c) => c.hideable !== false) : []
  const visibleCount = orderedColumns.length
  const totalToggleable = pickerColumns.length

  const paginationTotalItems = usingServerPagination
    ? Math.max(0, Number(serverPagination?.totalItems) || 0)
    : unpinnedRows.length
  const paginationPage = usingServerPagination ? (serverPagination?.page ?? 1) : page
  const paginationPageSize = usingServerPagination ? (serverPagination?.pageSize ?? pageSize) : pageSize
  const handlePaginationPageChange = usingServerPagination
    ? serverPagination!.onPageChange
    : setPage
  const handlePaginationPageSizeChange = usingServerPagination
    ? serverPagination!.onPageSizeChange
    : (nextSize: number) => { setPageSize(nextSize); setPage(1) }

  return {
    // sort
    sort,
    toggleSort,
    // column order / drag
    orderedColumns,
    draggingKey,
    dragOverKey,
    setDragOverKey,
    handleDragStart,
    handleDragOver,
    handleDrop,
    handleDragEnd,
    // column widths / resize / auto-fit
    fittedColumnWidths,
    columnWidths,
    tableMinWidth,
    startResize,
    autoFitColumn,
    // refs (attached by the renderer)
    tableScrollRef,
    theadRef,
    tbodyRef,
    // column visibility / picker
    hiddenKeys,
    toggleHidden,
    resetWidths,
    resetOrder,
    resetAll,
    columnsPickerOpen,
    setColumnsPickerOpen,
    columnsPickerRef,
    pickerColumns,
    visibleCount,
    totalToggleable,
    // rows
    sortedRows,
    pagedRows,
    // pagination
    effectivePageSizeOptions,
    paginationTotalItems,
    paginationPage,
    paginationPageSize,
    handlePaginationPageChange,
    handlePaginationPageSizeChange,
  }
}
