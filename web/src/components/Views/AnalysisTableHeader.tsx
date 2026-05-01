import { useEffect, useRef } from 'react'
import {
  ANALYSIS_SORT_LABELS,
  type AnalysisSortDir,
  type AnalysisSortKey,
} from './analysis-parity'
import './AnalysisDataTable.css'

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
}

const MIN_COLUMN_WIDTH = 60
const MAX_COLUMN_WIDTH = 600

function clampWidth(value: number) {
  return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, value))
}

function getSortIndicator(active: boolean, direction: AnalysisSortDir) {
  if (!active) return '↕'
  return direction === 'asc' ? '↑' : '↓'
}

export function AnalysisTableHeader({
  columns,
  sortKey,
  sortDir,
  onSort,
  widths,
  onResizeColumn,
  onResetColumn,
}: AnalysisTableHeaderProps) {
  const thRefs = useRef<Partial<Record<AnalysisSortKey, HTMLTableCellElement | null>>>({})

  return (
    <thead className="analysis-table-head">
      <tr>
        {columns.map((column, columnIndex) => {
          const active = sortKey === column.key
          const ariaSort = active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'
          const explicitWidth = widths?.[column.key]
          const isLast = columnIndex === columns.length - 1

          return (
            <th
              key={column.key}
              ref={(node) => {
                thRefs.current[column.key] = node
              }}
              title={column.title}
              aria-sort={ariaSort}
              className={[
                'analysis-table-head-cell',
                `is-${column.align ?? 'left'}`,
                active ? 'is-active' : '',
              ].filter(Boolean).join(' ')}
              style={explicitWidth ? { width: explicitWidth, minWidth: explicitWidth } : undefined}
            >
              <button
                type="button"
                className="analysis-table-sort-button"
                onClick={() => onSort(column.key)}
              >
                <span className="analysis-table-sort-label">
                  {ANALYSIS_SORT_LABELS[column.key]}
                </span>
                <span className="analysis-table-sort-icon" aria-hidden="true">
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

interface ColumnResizeHandleProps {
  getStartWidth: () => number
  onChange: (width: number) => void
  onReset?: () => void
}

function ColumnResizeHandle({ getStartWidth, onChange, onReset }: ColumnResizeHandleProps) {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  useEffect(() => {
    function handleMove(event: MouseEvent) {
      const drag = dragRef.current
      if (!drag) return
      const next = clampWidth(drag.startWidth + (event.clientX - drag.startX))
      onChange(next)
    }
    function handleUp() {
      if (!dragRef.current) return
      dragRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleUp)
    return () => {
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleUp)
    }
  }, [onChange])

  return (
    <span
      className="analysis-col-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize column"
      onMouseDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
        dragRef.current = { startX: event.clientX, startWidth: getStartWidth() }
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
      }}
      onDoubleClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onReset?.()
      }}
      onClick={(event) => {
        event.stopPropagation()
      }}
      title="Drag to resize · Double-click to reset"
    />
  )
}
