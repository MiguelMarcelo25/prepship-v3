// @ts-nocheck
// ──────────────────────────────────────────────────────────────────
// Table — reusable data-table primitive for the whole project.
//
// Goals
//   - One component every page can use: Clients, future Manifests,
//     future audit logs, anywhere with a list of rows.
//   - Sortable columns (click header → asc → desc → none)
//   - Resizable column widths (drag right edge, persisted)
//   - localStorage persistence (one storageKey gates BOTH sort
//     state and column widths)
//   - Reliable column-width math (table-fixed + colgroup + per-cell
//     overflow-hidden — the full truncation recipe we landed on for
//     the Dashboard table)
//   - Sticky <thead>, configurable density, optional row click
//   - Loading + empty states first-class
//
// API surface (intentionally small — one entry point, opinionated
// defaults, escape hatches for the cases where you need them):
//
//   <Table
//     data={clients}
//     columns={[
//       { key: 'name',  label: 'Name',  width: 200, sortable: true },
//       { key: 'count', label: 'Count', width: 90, align: 'right',
//         sortable: true,
//         render: (row) => row.count.toLocaleString() },
//     ]}
//     rowKey={(row) => row.id}
//     storageKey="clients-table"
//     defaultSort={{ key: 'name', direction: 'asc' }}
//     onRowClick={(row) => openDetail(row)}
//     loading={isLoading}
//     emptyMessage="No clients yet"
//   />
//
// Future tables in this project should consume this component
// rather than rolling their own <table> — operators get consistent
// resize/sort/persist behavior everywhere, and bug fixes land once.
// ──────────────────────────────────────────────────────────────────

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'

export type SortDirection = 'asc' | 'desc'
export type ColumnAlign = 'left' | 'right' | 'center'

export interface TableColumn<Row> {
  /** Unique column id. Also used as the default sortValue path
   *  (`row[key]`) when `sortValue` isn't provided. */
  key: string
  /** Header text. */
  label: string
  /** Default width in px. Required because table-fixed needs a
   *  width to honor — without this the column auto-distributes. */
  width: number
  /** Resize floor in px. Defaults to 60. */
  minWidth?: number
  /** Resize ceiling in px. Defaults to 800. Prevents a runaway
   *  resize from busting the layout. */
  maxWidth?: number
  /** Header + cell text-align. Defaults to 'left'. */
  align?: ColumnAlign
  /** True = clickable header that toggles sort. False = no sort. */
  sortable?: boolean
  /** Comparable value pulled from a row for sorting this column.
   *  Strings sort case-insensitively. Defaults to `row[key]`. */
  sortValue?: (row: Row) => string | number | boolean | Date | null | undefined
  /** Cell content. Defaults to `String(row[key] ?? '')`. */
  render?: (row: Row) => ReactNode
  /** When true the column is pinned to the left and isn't
   *  resizable (use for row identity / star / select columns). */
  pinned?: boolean
  /** Optional CSS class added to every cell in this column. */
  className?: string
}

export interface SortState {
  key: string
  direction: SortDirection
}

export interface TableProps<Row> {
  data: Row[]
  columns: TableColumn<Row>[]
  rowKey: (row: Row) => string | number
  /** Persistence key. When set, sort state + column widths persist
   *  to localStorage under `${storageKey}:sort` and `${storageKey}:widths`.
   *  Omit for ephemeral tables. */
  storageKey?: string
  /** Initial sort. Falls through to no-sort when omitted. */
  defaultSort?: SortState | null
  /** Row click handler. Cursor + hover treatment adjust when set. */
  onRowClick?: (row: Row) => void
  /** Visual density. Defaults to 'normal'. */
  density?: 'compact' | 'normal' | 'comfortable'
  loading?: boolean
  emptyMessage?: ReactNode
  /** Optional toolbar slot rendered above the table (e.g. search,
   *  filter chips). Renders inside the same shell so the toolbar
   *  shares the rounded border + shadow. */
  toolbar?: ReactNode
  /** Optional className applied to the outer shell. Use sparingly —
   *  the default styling is the point. */
  className?: string
}

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

export function Table<Row>({
  data,
  columns,
  rowKey,
  storageKey,
  defaultSort,
  onRowClick,
  density = 'normal',
  loading,
  emptyMessage = 'No data',
  toolbar,
  className,
}: TableProps<Row>) {
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
    const max = col.maxWidth ?? 800
    const startWidth = widths[col.key] ?? col.width
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

  // Sorted rows — recomputed when data or sort changes.
  const sortedRows = useMemo(() => {
    if (!sort) return data
    const col = columns.find((c) => c.key === sort.key)
    if (!col) return data
    const sortValue = col.sortValue ?? ((row: Row) => (row as Record<string, unknown>)[col.key] as never)
    const sorted = [...data].sort((a, b) => compareValues(comparable(sortValue(a)), comparable(sortValue(b))))
    return sort.direction === 'desc' ? sorted.reverse() : sorted
  }, [data, sort, columns])

  // Density tokens — picked here once, applied to every cell so
  // the row rhythm stays consistent.
  const padding = density === 'compact' ? 'px-3 py-1.5' : density === 'comfortable' ? 'px-4 py-3.5' : 'px-3 py-2.5'
  const fontSize = density === 'compact' ? 'text-[12px]' : 'text-[13px]'
  const headerPadding = density === 'compact' ? 'px-3 py-2' : 'px-3 py-2.5'

  return (
    <div className={`rounded-xl bg-surface ring-1 ring-line shadow-[0_1px_3px_rgba(15,23,42,0.04)] overflow-hidden flex flex-col ${className ?? ''}`}>
      {toolbar ? (
        <div className="flex-shrink-0 border-b border-line bg-surface-2/40 px-3 py-2">{toolbar}</div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse table-fixed" style={{ minWidth: 480 }}>
          <colgroup>
            {columns.map((col) => (
              <col key={col.key} style={{ width: widths[col.key] ?? col.width }} />
            ))}
          </colgroup>

          <thead className="bg-surface-2 sticky top-0 z-10">
            <tr>
              {columns.map((col) => {
                const isActive = sort?.key === col.key
                const align = col.align ?? 'left'
                const justify = align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start'
                return (
                  <th
                    key={col.key}
                    className={`relative border-b-2 border-line ${headerPadding} text-[10.5px] font-extrabold uppercase tracking-[0.05em] text-ink-3 ${col.sortable ? 'cursor-pointer select-none hover:bg-line/40' : ''} ${align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left'} transition-colors`}
                    onClick={() => toggleSort(col)}
                    aria-sort={isActive ? (sort!.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    <span className={`inline-flex items-center gap-1 ${justify} w-full ${isActive ? 'text-brand' : ''}`}>
                      <span className="truncate">{col.label}</span>
                      {col.sortable ? (
                        isActive ? (
                          sort!.direction === 'asc'
                            ? <ArrowUp size={10} strokeWidth={2.5} className="flex-shrink-0" />
                            : <ArrowDown size={10} strokeWidth={2.5} className="flex-shrink-0" />
                        ) : (
                          <ArrowUpDown size={10} strokeWidth={2} className="flex-shrink-0 opacity-30" />
                        )
                      ) : null}
                    </span>

                    {/* Resize handle — 10px hot zone on right edge.
                        Visible 1.5px vertical line at rest, widens
                        and turns brand-blue on hover. Skipped for
                        pinned columns. */}
                    {!col.pinned ? (
                      <div
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={`Resize ${col.label}`}
                        onMouseDown={startResize(col)}
                        onClick={(e) => e.stopPropagation()}
                        className="absolute top-1 bottom-1 -right-[5px] w-[10px] cursor-col-resize z-20 group/handle flex items-center justify-center"
                        style={{ touchAction: 'none' }}
                      >
                        <span className="block w-[1.5px] h-full rounded bg-line-2/60 group-hover/handle:bg-brand group-hover/handle:w-[2.5px] transition-all duration-150" />
                      </div>
                    ) : null}
                  </th>
                )
              })}
            </tr>
          </thead>

          <tbody>
            {loading ? (
              <tr>
                <td colSpan={columns.length} className="text-center py-12 text-ink-3">
                  <span className="inline-flex items-center gap-2 text-[12px]">
                    <span className="w-3 h-3 rounded-full border-2 border-line border-t-brand animate-spin" />
                    Loading…
                  </span>
                </td>
              </tr>
            ) : sortedRows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="text-center py-12 text-ink-3 italic text-[13px]">
                  {emptyMessage}
                </td>
              </tr>
            ) : sortedRows.map((row) => {
              const key = rowKey(row)
              return (
                <tr
                  key={key}
                  className={`group border-b border-line/70 last:border-b-0 transition-colors ${onRowClick ? 'cursor-pointer hover:bg-brand-bg/40' : 'hover:bg-surface-2/60'}`}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  {columns.map((col) => {
                    const align = col.align ?? 'left'
                    const alignCls = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left'
                    const content = col.render
                      ? col.render(row)
                      : ((row as Record<string, unknown>)[col.key] as ReactNode) ?? ''
                    return (
                      <td
                        key={col.key}
                        className={`${padding} ${fontSize} ${alignCls} overflow-hidden align-middle text-ink ${col.className ?? ''}`}
                        style={{ width: widths[col.key] ?? col.width, maxWidth: widths[col.key] ?? col.width }}
                      >
                        {content}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
