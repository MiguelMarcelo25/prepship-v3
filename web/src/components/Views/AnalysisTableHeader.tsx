import { useRef } from 'react'
import {
  ANALYSIS_SORT_LABELS,
  type AnalysisSortDir,
  type AnalysisSortKey,
} from './analysis-parity'
import { ColumnResizeHandle } from './ColumnResizeHandle'

export interface AnalysisTableColumn {
  key: AnalysisSortKey
  title?: string
  align?: 'left' | 'right' | 'center'
}

export type ColumnWidths = Partial<Record<AnalysisSortKey, number>>

interface AnalysisTableHeaderProps {
  columns: AnalysisTableColumn[]
  sortKey: AnalysisSortKey
  sortDir: AnalysisSortDir
  onSort: (key: AnalysisSortKey) => void
  widths?: ColumnWidths
  onResizeColumn?: (key: AnalysisSortKey, width: number) => void
  onResetColumn?: (key: AnalysisSortKey) => void
  columnSize?: 'narrow' | 'medium' | 'wide'
}

const MIN_COLUMN_WIDTH = 60

const TH_BASE_CLASSES =
  'p-0 align-middle whitespace-nowrap relative bg-gradient-to-b from-[#f8fafc] to-[#eef3f8] sticky top-[var(--analysis-table-sticky-top,0px)] z-[25] shadow-[0_1px_0_var(--border),0_3px_8px_rgba(15,23,42,.08)]'

function getSortIndicator(active: boolean, direction: AnalysisSortDir) {
  if (!active) return '↕'
  return direction === 'asc' ? '↑' : '↓'
}

function sortButtonPaddingFor(size: 'narrow' | 'medium' | 'wide' | undefined) {
  if (size === 'narrow') return 'px-1.5'
  if (size === 'wide') return 'px-3.5'
  return 'px-2'
}

function alignClasses(align: 'left' | 'right' | 'center' | undefined) {
  if (align === 'right') return { th: 'text-right', btn: 'justify-end' }
  if (align === 'center') return { th: 'text-center', btn: 'justify-center' }
  return { th: 'text-left', btn: 'justify-start' }
}

export function AnalysisTableHeader({
  columns,
  sortKey,
  sortDir,
  onSort,
  widths,
  onResizeColumn,
  onResetColumn,
  columnSize,
}: AnalysisTableHeaderProps) {
  const thRefs = useRef<Partial<Record<AnalysisSortKey, HTMLTableCellElement | null>>>({})
  const sortBtnPad = sortButtonPaddingFor(columnSize)

  return (
    <thead className="bg-gradient-to-b from-[#f8fafc] to-[#eef3f8] border-b border-line">
      <tr>
        {columns.map((column, columnIndex) => {
          const active = sortKey === column.key
          const ariaSort = active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'
          const explicitWidth = widths?.[column.key]
          const isLast = columnIndex === columns.length - 1
          const aligns = alignClasses(column.align)

          return (
            <th
              key={column.key}
              ref={(node) => {
                thRefs.current[column.key] = node
              }}
              title={column.title}
              aria-sort={ariaSort}
              className={`${TH_BASE_CLASSES} ${aligns.th}`}
              style={explicitWidth ? { width: explicitWidth, minWidth: explicitWidth } : undefined}
            >
              <button
                type="button"
                className={`w-full min-h-[34px] inline-flex items-center gap-1.5 ${sortBtnPad} py-[7px] border-0 bg-transparent cursor-pointer font-inherit text-[10px] font-extrabold uppercase tracking-[0.04em] transition-colors duration-150 ${aligns.btn} ${
                  active
                    ? 'text-brand'
                    : 'text-ink-3 hover:bg-[rgba(42,91,215,.08)] hover:text-brand'
                }`}
                onClick={() => onSort(column.key)}
              >
                <span className="overflow-hidden text-ellipsis">
                  {ANALYSIS_SORT_LABELS[column.key]}
                </span>
                <span
                  className={`w-[18px] h-[18px] rounded-full inline-flex items-center justify-center flex-none text-[11px] leading-none ${
                    active ? 'bg-brand text-white' : 'bg-[rgba(148,163,184,.18)] text-ink-3'
                  }`}
                  aria-hidden="true"
                >
                  {getSortIndicator(active, sortDir)}
                </span>
              </button>
              {!isLast && onResizeColumn ? (
                <ColumnResizeHandle
                  getStartWidth={() => {
                    if (explicitWidth) return explicitWidth
                    const node = thRefs.current[column.key]
                    return node ? node.getBoundingClientRect().width : MIN_COLUMN_WIDTH
                  }}
                  onChange={(width) => onResizeColumn(column.key, Math.round(width))}
                  onReset={onResetColumn ? () => onResetColumn(column.key) : undefined}
                />
              ) : null}
            </th>
          )
        })}
      </tr>
    </thead>
  )
}
