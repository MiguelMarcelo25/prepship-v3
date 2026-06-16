// PS-155: the Billing summary table extracted verbatim from BillingView.tsx (behavior-preserving).
// Note: the billing DTO types (BillingSummaryDto, etc.) are phantom names not actually exported from types/api,
// so they are locally aliased below. The extraction is a verbatim JSX move; build:web is the net.
// Rows + totals (summaryTotals) + the detail/export handlers stay OWNED by BillingView and are passed
// in — money totals are parent-computed, so they cannot drift. Thin presentational <Table> wrapper.
import type { CSSProperties } from 'react'
type BillingSummaryDto = any // TODO PS-257: restore real type
import { formatBillingMoney, type BillingSummaryTotals } from './billing-parity'
import { Table } from '../ui/Table'

const BILLING_SUMMARY_PAGE_SIZE_OPTIONS = [10, 25, 50, 100]

export function BillingSummaryTable({
  sortedSummaryRows,
  summaryLoading,
  summaryError,
  summaryTotals,
  detailState,
  handleLoadDetails,
  handleExportInvoice,
  handleExportInvoiceXlsx,
}: {
  sortedSummaryRows: BillingSummaryDto[]
  summaryLoading: boolean
  summaryError: string | null
  summaryTotals: BillingSummaryTotals
  detailState: { open: boolean; clientId: number | null }
  handleLoadDetails: (clientId: number, clientName: string) => void
  handleExportInvoice: (clientId: number, clientName: string) => void
  // PS-208: Excel download of the same invoice (backend /billing/invoice.xlsx).
  handleExportInvoiceXlsx: (clientId: number, clientName: string) => void
}) {
  return summaryError ? (
    <div style={{ padding: 24, textAlign: 'center', color: 'var(--red)' }}>{summaryError}</div>
  ) : (
    <Table<BillingSummaryDto>
      data={sortedSummaryRows}
      columns={[
        {
          key: 'client',
          label: 'Client',
          width: 220,
          minWidth: 140,
          sortable: true,
          // 2026-05-13: every column toggleable + draggable
          // per operator request (Awaiting-Shipment parity).
          sortValue: (row) => row.clientName ?? '',
          render: (row) => (
            <span className="billing-summary-client-cell" style={{ fontWeight: 600, color: 'var(--ss-blue)' }}>
              {row.clientName}
              <button
                className="btn btn-ghost btn-xs"
                type="button"
                title="Export invoice as PDF"
                style={{ marginLeft: 6, fontSize: 10, padding: '1px 6px', opacity: 0.7 }}
                onClick={(event) => { event.stopPropagation(); handleExportInvoice(row.clientId, row.clientName) }}
              >
                📄 Export
              </button>
              <button
                className="btn btn-ghost btn-xs"
                type="button"
                title="Download invoice as Excel (.xlsx)"
                style={{ marginLeft: 4, fontSize: 10, padding: '1px 6px', opacity: 0.7 }}
                onClick={(event) => { event.stopPropagation(); handleExportInvoiceXlsx(row.clientId, row.clientName) }}
              >
                📊 Excel
              </button>
            </span>
          ),
        },
        { key: 'orders', label: 'Orders', width: 90, minWidth: 70, align: 'right', sortable: true, sortValue: (row) => Number(row.orderCount ?? 0), render: (row) => row.orderCount || 0 },
        { key: 'pickPack', label: 'Pick & Pack', width: 110, minWidth: 90, align: 'right', sortable: true, sortValue: (row) => Number(row.pickPackTotal ?? 0), render: (row) => formatBillingMoney(row.pickPackTotal ?? 0) },
        { key: 'additional', label: 'Addl Units', width: 110, minWidth: 90, align: 'right', sortable: true, sortValue: (row) => Number(row.additionalTotal ?? 0), render: (row) => formatBillingMoney(row.additionalTotal || 0) },
        { key: 'package', label: 'Box Cost', width: 110, minWidth: 90, align: 'right', sortable: true, sortValue: (row) => Number(row.packageTotal ?? 0), render: (row) => formatBillingMoney(row.packageTotal || 0, { dashIfZero: true }) },
        { key: 'storage', label: 'Storage', width: 110, minWidth: 90, align: 'right', sortable: true, sortValue: (row) => Number(row.storageTotal ?? 0), render: (row) => formatBillingMoney(row.storageTotal || 0, { dashIfZero: true }) },
        { key: 'shipping', label: 'Shipping', width: 110, minWidth: 90, align: 'right', sortable: true, sortValue: (row) => Number(row.shippingTotal ?? 0), render: (row) => formatBillingMoney(row.shippingTotal || 0) },
        {
          key: 'total',
          label: 'Fulfillment Fee',
          width: 120,
          minWidth: 100,
          align: 'right',
          sortable: true,
          // 2026-05-13: every column toggleable + draggable
          // per operator request (Awaiting-Shipment parity).
          sortValue: (row) => Number(row.fulfillmentFeeTotal ?? row.grandTotal ?? 0),
          render: (row) => (
            <span style={{ fontWeight: 700, color: 'var(--green)' }}>{formatBillingMoney(row.fulfillmentFeeTotal ?? row.grandTotal ?? 0)}</span>
          ),
        },
      ]}
      rowKey={(row) => row.clientId}
      storageKey="billing-summary-table"
      defaultSort={{ key: 'total', direction: 'desc' }}
      paginated
      defaultPageSize={25}
      pageSizeOptions={BILLING_SUMMARY_PAGE_SIZE_OPTIONS}
      loading={summaryLoading}
      emptyMessage="No billing data. Generate invoices first."
      onRowClick={(row) => void handleLoadDetails(row.clientId, row.clientName)}
      rowClassName={(row) => {
        const active = detailState.open && Number(row.clientId) === Number(detailState.clientId)
        return `billing-summary-row${active ? ' is-detail-selected' : ''}`
      }}
      // Totals row — sum of the FULL dataset, not just the page.
      // Caller iterates the visible columns so cell positions
      // stay aligned after the operator reorders or hides
      // columns via the picker.
      footerRow={(cols) => cols.map((c) => {
        const align = c.align === 'right' ? 'right' : c.align === 'center' ? 'center' : 'left'
        const tdStyle: CSSProperties = { padding: '8px 10px', textAlign: align, fontWeight: 700 }
        // PS-042: tag each footer cell with its column key/align so it can
        // be matched to the matching header/body cell (E2E + so alignment
        // can't silently drift from them). Width/position come from the
        // shared <colgroup>, so cells stay aligned under reorder/hide/resize.
        const common = { 'data-col-key': c.key, 'data-col-align': align, 'data-col-footer': true }
        switch (c.key) {
          case 'client': return <td key={c.key} {...common} style={tdStyle}>Total</td>
          case 'orders': return <td key={c.key} {...common} style={tdStyle}>{summaryTotals.orders}</td>
          case 'pickPack': return <td key={c.key} {...common} style={tdStyle}>{formatBillingMoney(summaryTotals.pickPack)}</td>
          case 'additional': return <td key={c.key} {...common} style={tdStyle}>{formatBillingMoney(summaryTotals.additional)}</td>
          case 'package': return <td key={c.key} {...common} style={tdStyle}>{formatBillingMoney(summaryTotals.package, { dashIfZero: true })}</td>
          case 'storage': return <td key={c.key} {...common} style={tdStyle}>{formatBillingMoney(summaryTotals.storage, { dashIfZero: true })}</td>
          case 'shipping': return <td key={c.key} {...common} style={tdStyle}>{formatBillingMoney(summaryTotals.shipping)}</td>
          case 'total': return <td key={c.key} {...common} style={{ ...tdStyle, fontWeight: 800, color: 'var(--green)', fontSize: 13 }}>{formatBillingMoney(summaryTotals.fulfillmentFee)}</td>
          default: return <td key={c.key} {...common} style={tdStyle} />
        }
      })}
    />
  )
}
