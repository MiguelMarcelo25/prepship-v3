// @ts-nocheck
import type { AnalysisSkuDto } from '@prepshipv2/contracts/analysis/contracts'
import {
  AnalysisTableHeader,
  type AnalysisTableColumn,
  type ColumnWidths,
} from './AnalysisTableHeader'
import {
  formatAnalysisMoney,
  type AnalysisSortDir,
  type AnalysisSortKey,
  type AnalysisTotals,
} from './analysis-parity'
import './AnalysisDataTable.css'

const TABLE_COLUMN_COUNT = 10

export type AnalysisColumnSize = 'narrow' | 'medium' | 'wide'

interface AnalysisDataTableProps {
  columns: AnalysisTableColumn[]
  sortKey: AnalysisSortKey
  sortDir: AnalysisSortDir
  onSort: (key: AnalysisSortKey) => void
  columnWidths: ColumnWidths
  onResizeColumn: (key: AnalysisSortKey, width: number) => void
  onResetColumn: (key: AnalysisSortKey) => void
  columnSize: AnalysisColumnSize
  rows: AnalysisSkuDto[]
  totals: AnalysisTotals
  maxQty: number
  loading: boolean
  error: string | null
  emptyMessage: string
  onRowClick: (invSkuId: number) => void
}

const SHELL_CLASSES =
  'overflow-visible border border-line rounded-[10px] bg-surface shadow-[0_1px_3px_rgba(15,23,42,.05),0_1px_2px_rgba(15,23,42,.03)]'

const TABLE_BASE_CLASSES = 'w-full border-separate border-spacing-0'

function tableClassesFor(size: AnalysisColumnSize) {
  if (size === 'narrow') return `${TABLE_BASE_CLASSES} table-auto min-w-full text-[14px]`
  if (size === 'wide') return `${TABLE_BASE_CLASSES} table-auto min-w-[1400px] text-[14px]`
  return `${TABLE_BASE_CLASSES} table-auto min-w-full text-[14px]`
}

function cellPaddingFor(size: AnalysisColumnSize) {
  if (size === 'narrow') return 'px-1.5 py-2.5'
  if (size === 'wide') return 'px-5 py-2.5'
  return 'px-3 py-2.5'
}

function nameMaxWidthFor(size: AnalysisColumnSize) {
  if (size === 'narrow') return 'max-w-[140px]'
  if (size === 'wide') return 'max-w-[320px]'
  return 'max-w-[220px]'
}

function pillSizeFor(size: AnalysisColumnSize) {
  if (size === 'narrow') return 'px-1.5 py-px text-[10px]'
  if (size === 'wide') return 'px-2.5 py-0.5 text-xs2'
  return 'px-2 py-0.5 text-[10.5px]'
}

function skuClassesFor(size: AnalysisColumnSize, isLink: boolean) {
  return [
    cellPaddingFor(size),
    'text-[14px]',
    "font-bold tabular-nums font-['JetBrains_Mono','Fira_Code',ui-monospace,monospace] !text-[#1d4ed8]",
    isLink ? 'underline decoration-[1px] underline-offset-2 decoration-[#1d4ed8]' : '',
    'border-b border-line align-middle',
  ]
    .filter(Boolean)
    .join(' ')
}

function clientClassesFor(size: AnalysisColumnSize) {
  return `${cellPaddingFor(size)} text-[14px] text-ink-2 border-b border-line align-middle`
}

const TD_BASE = 'border-b border-line align-middle text-ink'

export function AnalysisDataTable({
  columns,
  sortKey,
  sortDir,
  onSort,
  columnWidths,
  onResizeColumn,
  onResetColumn,
  columnSize,
  rows,
  totals,
  maxQty,
  loading,
  error,
  emptyMessage,
  onRowClick,
}: AnalysisDataTableProps) {
  const showRows = !loading && !error && rows.length > 0
  const showEmpty = !loading && !error && rows.length === 0

  const cellPadding = cellPaddingFor(columnSize)
  const nameMaxWidth = nameMaxWidthFor(columnSize)
  const pillSize = pillSizeFor(columnSize)

  return (
    <div className={SHELL_CLASSES}>
      <table id="analysis-table" className={tableClassesFor(columnSize)}>
        <AnalysisTableHeader
          columns={columns}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={onSort}
          widths={columnWidths}
          onResizeColumn={onResizeColumn}
          onResetColumn={onResetColumn}
          columnSize={columnSize}
        />
        <tbody id="analysis-tbody">
          {error ? (
            <tr>
              <td colSpan={TABLE_COLUMN_COUNT} className="px-5 py-12 text-center text-danger text-[13px] font-semibold">
                Error: {error}
              </td>
            </tr>
          ) : showEmpty ? (
            <tr>
              <td colSpan={TABLE_COLUMN_COUNT} className="px-5 py-12 text-center text-ink-3 text-[13px]">
                {emptyMessage}
              </td>
            </tr>
          ) : showRows ? (
            rows.map((row) => {
              const qtyBarWidth = Math.round((row.qty / maxQty) * 80)
              const isClickable = Boolean(row.invSkuId)
              const stdAvg =
                row.standardShipCount > 0
                  ? (row.standardShipTotal ?? 0) / row.standardShipCount
                  : 0
              const expAvg =
                row.expeditedShipCount > 0
                  ? (row.expeditedShipTotal ?? 0) / row.expeditedShipCount
                  : 0

              const rowClasses = [
                'transition-[background,box-shadow] duration-150',
                'even:bg-[#fafbfc]',
                isClickable
                  ? 'cursor-pointer hover:bg-[#eef4ff] hover:shadow-[inset_3px_0_0_var(--ss-blue)]'
                  : '',
              ]
                .filter(Boolean)
                .join(' ')

              return (
                <tr
                  key={`${row.sku || row.name}-${row.clientName}`}
                  className={rowClasses}
                  title={isClickable ? 'View SKU details' : undefined}
                  tabIndex={isClickable ? 0 : undefined}
                  onKeyDown={
                    isClickable
                      ? (event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            onRowClick(row.invSkuId as number)
                          }
                        }
                      : undefined
                  }
                  onClick={
                    isClickable ? () => onRowClick(row.invSkuId as number) : undefined
                  }
                >
                  <td
                    className={`${cellPadding} ${nameMaxWidth} overflow-hidden text-ellipsis whitespace-nowrap font-medium text-ink ${TD_BASE}`}
                    title={row.name}
                  >
                    {row.name}
                  </td>
                  <td className={skuClassesFor(columnSize, isClickable)}>
                    {row.sku || <span className="text-line-2">—</span>}
                  </td>
                  <td className={clientClassesFor(columnSize)}>
                    {row.clientName || '—'}
                  </td>
                  <td className={`${cellPadding} text-right whitespace-nowrap tabular-nums font-bold ${TD_BASE}`}>
                    {row.orders}
                  </td>
                  <td className={`${cellPadding} text-right whitespace-nowrap tabular-nums ${TD_BASE}`}>
                    {row.pendingOrders > 0 ? (
                      <span
                        className={`inline-flex items-center gap-1 ${pillSize} rounded-full font-bold leading-snug tabular-nums bg-[rgba(224,122,0,.12)] text-[#b86200]`}
                      >
                        {row.pendingOrders}
                        <span className="text-[9px] font-semibold opacity-75">pend</span>
                      </span>
                    ) : (
                      <span className="text-line-2">—</span>
                    )}
                  </td>
                  <td className={`${cellPadding} text-right whitespace-nowrap tabular-nums ${TD_BASE}`}>
                    {row.externalOrders > 0 ? (
                      <span
                        className={`inline-flex items-center gap-1 ${pillSize} rounded-full font-bold leading-snug tabular-nums bg-[rgba(138,149,163,.16)] text-ink-2`}
                      >
                        {row.externalOrders}
                        <span className="text-[9px] font-semibold opacity-75">ext</span>
                      </span>
                    ) : (
                      <span className="text-line-2">—</span>
                    )}
                  </td>
                  <td className={`${cellPadding} text-right whitespace-nowrap tabular-nums ${TD_BASE}`}>
                    <span className="inline-flex items-center justify-end gap-[7px]">
                      <span
                        className="h-1.5 rounded-[3px] opacity-65 min-w-[1px] bg-gradient-to-r from-brand to-[#5b8def]"
                        style={{ width: qtyBarWidth }}
                      />
                      <span className="font-semibold text-[14px] min-w-[36px] text-right tabular-nums">
                        {row.qty.toLocaleString()}
                      </span>
                    </span>
                  </td>
                  <td className={`${cellPadding} text-right whitespace-nowrap tabular-nums ${TD_BASE}`}>
                    {row.standardShipCount > 0 ? (
                      <>
                        <span className="font-bold">{row.standardShipCount}</span>
                        <span className="ml-1.5 text-[10.5px] font-semibold tabular-nums text-ok">
                          {formatAnalysisMoney(stdAvg)}
                        </span>
                      </>
                    ) : (
                      <span className="text-line-2">—</span>
                    )}
                  </td>
                  <td className={`${cellPadding} text-right whitespace-nowrap tabular-nums ${TD_BASE}`}>
                    {row.expeditedShipCount > 0 ? (
                      <>
                        <span
                          className={`inline-flex items-center gap-1 ${pillSize} rounded-full font-bold leading-snug tabular-nums bg-[rgba(224,122,0,.12)] text-[#b86200]`}
                        >
                          {row.expeditedShipCount}
                        </span>
                        <span className="ml-1.5 text-[10.5px] font-semibold tabular-nums text-ink-3">
                          {formatAnalysisMoney(expAvg)}
                        </span>
                      </>
                    ) : (
                      <span className="text-line-2">—</span>
                    )}
                  </td>
                  <td className={`${cellPadding} text-right whitespace-nowrap tabular-nums font-extrabold text-[14px] text-ink ${TD_BASE}`}>
                    {row.totalShipping > 0 ? (
                      formatAnalysisMoney(row.totalShipping)
                    ) : (
                      <span className="text-ink-3">—</span>
                    )}
                  </td>
                </tr>
              )
            })
          ) : null}
        </tbody>
        <tfoot id="analysis-tfoot">
          {showRows ? (
            <tr className="bg-gradient-to-b from-[#f8fafc] to-[#eef3f8] border-t-2 border-line font-bold">
              <td colSpan={3} className={`${cellPadding} text-[14px] border-t-2 border-line text-ink tabular-nums`}>
                <span className="text-ink-3 font-extrabold text-[10px] uppercase tracking-[0.06em] mr-2.5">
                  TOTALS
                </span>
                {totals.skuCount.toLocaleString()} SKUs
              </td>
              <td className={`${cellPadding} text-right text-[14px] border-t-2 border-line text-ink tabular-nums`}>
                {totals.totalOrders.toLocaleString()}
              </td>
              <td className={`${cellPadding} text-right text-[14px] border-t-2 border-line text-[#b86200] tabular-nums`}>
                {totals.totalPending > 0 ? totals.totalPending.toLocaleString() : '—'}
              </td>
              <td className={`${cellPadding} text-right text-[14px] border-t-2 border-line text-ink-3 tabular-nums`}>
                {totals.totalExternal > 0 ? totals.totalExternal.toLocaleString() : '—'}
              </td>
              <td className={`${cellPadding} text-right text-[14px] border-t-2 border-line text-ink tabular-nums`}>
                {totals.totalQty.toLocaleString()}
              </td>
              <td className={`${cellPadding} text-right text-[14px] border-t-2 border-line text-ink tabular-nums`}>
                {totals.totalStdCount > 0 ? totals.totalStdCount.toLocaleString() : '—'}
              </td>
              <td className={`${cellPadding} text-right text-[14px] border-t-2 border-line text-[#b86200] tabular-nums`}>
                {totals.totalExpCount > 0 ? totals.totalExpCount.toLocaleString() : '—'}
              </td>
              <td className={`${cellPadding} text-right text-[13px] border-t-2 border-line text-ink font-extrabold tabular-nums`}>
                {totals.totalShipping > 0 ? formatAnalysisMoney(totals.totalShipping) : '—'}
              </td>
            </tr>
          ) : null}
        </tfoot>
      </table>
    </div>
  )
}
