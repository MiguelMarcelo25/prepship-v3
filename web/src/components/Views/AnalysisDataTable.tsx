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

  return (
    <div className={`analysis-table-shell is-colsize-${columnSize}`}>
      <table id="analysis-table" className="analysis-data-table">
        <AnalysisTableHeader
          columns={columns}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={onSort}
          widths={columnWidths}
          onResizeColumn={onResizeColumn}
          onResetColumn={onResetColumn}
        />
        <tbody id="analysis-tbody">
          {error ? (
            <tr>
              <td colSpan={TABLE_COLUMN_COUNT} className="analysis-error-cell">
                Error: {error}
              </td>
            </tr>
          ) : showEmpty ? (
            <tr>
              <td colSpan={TABLE_COLUMN_COUNT} className="analysis-empty-cell">
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

              return (
                <tr
                  key={`${row.sku || row.name}-${row.clientName}`}
                  className={isClickable ? 'analysis-clickable-row' : undefined}
                  style={isClickable ? { cursor: 'pointer' } : undefined}
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
                  <td className="col-name" title={row.name}>{row.name}</td>
                  <td className={`col-sku${isClickable ? ' is-link' : ''}`}>
                    {row.sku || <span className="analysis-dash">—</span>}
                  </td>
                  <td className="col-client">{row.clientName || '—'}</td>
                  <td className="col-num is-strong">{row.orders}</td>
                  <td className="col-num">
                    {row.pendingOrders > 0 ? (
                      <span className="analysis-pill is-pending">
                        {row.pendingOrders}
                        <span className="analysis-pill-suffix">pend</span>
                      </span>
                    ) : (
                      <span className="analysis-dash">—</span>
                    )}
                  </td>
                  <td className="col-num">
                    {row.externalOrders > 0 ? (
                      <span className="analysis-pill is-external">
                        {row.externalOrders}
                        <span className="analysis-pill-suffix">ext</span>
                      </span>
                    ) : (
                      <span className="analysis-dash">—</span>
                    )}
                  </td>
                  <td className="col-num">
                    <span className="analysis-qty-cell">
                      <span className="analysis-qty-bar" style={{ width: qtyBarWidth }} />
                      <span className="analysis-qty-value">{row.qty.toLocaleString()}</span>
                    </span>
                  </td>
                  <td className="col-num">
                    {row.standardShipCount > 0 ? (
                      <>
                        <span className="is-strong">{row.standardShipCount}</span>
                        <span className="analysis-shipcost-detail is-green">
                          {formatAnalysisMoney(stdAvg)}
                        </span>
                      </>
                    ) : (
                      <span className="analysis-dash">—</span>
                    )}
                  </td>
                  <td className="col-num">
                    {row.expeditedShipCount > 0 ? (
                      <>
                        <span className="analysis-pill is-expedited">{row.expeditedShipCount}</span>
                        <span className="analysis-shipcost-detail">
                          {formatAnalysisMoney(expAvg)}
                        </span>
                      </>
                    ) : (
                      <span className="analysis-dash">—</span>
                    )}
                  </td>
                  <td className="col-num is-total">
                    {row.totalShipping > 0 ? (
                      formatAnalysisMoney(row.totalShipping)
                    ) : (
                      <span className="analysis-dash">—</span>
                    )}
                  </td>
                </tr>
              )
            })
          ) : null}
        </tbody>
        <tfoot id="analysis-tfoot" className="analysis-table-foot">
          {showRows ? (
            <tr>
              <td colSpan={3}>
                <span className="totals-label">TOTALS</span>
                {totals.skuCount.toLocaleString()} SKUs
              </td>
              <td className="col-num">{totals.totalOrders.toLocaleString()}</td>
              <td className="col-num totals-pending">
                {totals.totalPending > 0 ? totals.totalPending.toLocaleString() : '—'}
              </td>
              <td className="col-num totals-external">
                {totals.totalExternal > 0 ? totals.totalExternal.toLocaleString() : '—'}
              </td>
              <td className="col-num">{totals.totalQty.toLocaleString()}</td>
              <td className="col-num">
                {totals.totalStdCount > 0 ? totals.totalStdCount.toLocaleString() : '—'}
              </td>
              <td className="col-num totals-expedited">
                {totals.totalExpCount > 0 ? totals.totalExpCount.toLocaleString() : '—'}
              </td>
              <td className="col-num totals-shipping">
                {totals.totalShipping > 0 ? formatAnalysisMoney(totals.totalShipping) : '—'}
              </td>
            </tr>
          ) : null}
        </tfoot>
      </table>
    </div>
  )
}
