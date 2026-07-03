// PS-155: Per-client billing detail table extracted verbatim from BillingView.tsx
// (behavior-preserving). Detail rows carry phantom fields
// (carrier_nickname / ref_ups_rate / stalePackagePrice / packageId …) not on a hand-written
// DTO — the index-signature BillingDetailDto from ./billing-parity covers them.
//
// The money cells call computeBillingDetailMetrics(row) — a PURE helper from ./billing-parity
// (same input → byte-identical output), so calling it here is equivalent to the parent computing
// it. The detail rows array (sortedDetailRows), sort state plumbing, totals, and all async
// handlers stay in BillingView and arrive as props. detailSortValueOf / marginColor /
// DETAIL_COLUMN_WIDTHS / DEFAULT_BILLING_DETAIL_COLUMN_IDS_SET / BILLING_DETAIL_PAGE_SIZE_OPTIONS
// are byte-identical copies of the parent's pure module-level helpers/constants.
import type { CSSProperties } from 'react'
import { Pencil } from 'lucide-react'
import { BillingNoBoxCostAction, hasBillingNoBoxCostAlert } from './BillingNoBoxCostAction'
import { BillingZeroShippingBadge, hasBillingZeroShippingReview } from './BillingZeroShippingBadge'
import type { BillingDetailColumnId, BillingDetailDto, BillingDetailPanelState } from './billing-parity'
import {
  billingShipDateSortValue,
  BILLING_DETAIL_COLUMNS,
  computeBillingDetailMetrics,
  formatBillingShipDate,
  formatBillingMoney,
  getDefaultBillingDetailColumnIds,
} from './billing-parity'
import { Table, type TableColumn } from '../ui/Table'

const BILLING_DETAIL_PAGE_SIZE_OPTIONS = [25, 50, 100, 250]

// Detail-table column default widths (px). Used by the migrated
// <Table>-driven detail render. Anything not listed defaults to 110.
const DETAIL_COLUMN_WIDTHS: Partial<Record<BillingDetailColumnId, number>> = {
  actions: 88,
  orderNumber: 130,
  shipDate: 130,
  carrierNickname: 110,
  itemNames: 220,
  itemSkus: 160,
  totalQty: 60,
  pickpack: 100,
  additional: 100,
  packageCost: 100,
  packageName: 110,
  selectedRate: 100,
  upsss: 90,
  uspsss: 90,
  shipping: 110,
  total: 110,
  margin: 130,
}

// Set membership lookup for "is this column shown by default?". The
// list comes from billing-parity so the canonical defaults stay in
// one place; we just convert to a Set for O(1) lookup during column
// definition mapping in the JSX.
const DEFAULT_BILLING_DETAIL_COLUMN_IDS_SET = new Set<BillingDetailColumnId>(getDefaultBillingDetailColumnIds())

// Pluck the comparable sort value for a detail row by column id.
// Mirrors the switch in the old sortedDetailRows useMemo (computed
// once per cell in Table — recomputing metrics is cheap because
// computeBillingDetailMetrics is pure and small).
function detailSortValueOf(row: BillingDetailDto, key: BillingDetailColumnId): string | number | Date | null | undefined {
  const metrics = computeBillingDetailMetrics(row)
  switch (key) {
    case 'actions': return ''
    case 'orderNumber': return row.orderNumber || row.orderId
    case 'shipDate': return billingShipDateSortValue(row.shipDate)
    case 'carrierNickname': return row.carrierNickname || row.providerAccountNickname || row.carrier_nickname || row.provider_account_nickname || row.carrierCode || row.carrier_code || ''
    case 'itemNames': return row.itemNames || row.description
    case 'itemSkus': return row.itemSkus
    case 'totalQty': return row.totalQty || row.qty
    case 'pickpack': return metrics.pickPack
    case 'additional': return metrics.additional
    case 'packageCost': return metrics.packageCost
    case 'packageName': return row.packageName
    case 'selectedRate': return row.selectedRateCost ?? row.selected_rate_cost
    case 'upsss': return row.refUpsRate ?? row.ref_ups_rate
    case 'uspsss': return row.refUspsRate ?? row.ref_usps_rate
    case 'shipping': return metrics.shipping
    case 'total': return metrics.total
    case 'margin': return metrics.margin
    default: return ''
  }
}

function marginColor(value: number) {
  if (value > 0) return 'var(--green)'
  if (value < 0) return 'var(--red)'
  return 'var(--text3)'
}

function splitBillingDetailLines(value: string): string[] {
  return value.split(/\r?\n| \| /).filter((line) => line.trim())
}

export function BillingDetailTable({
  detailState,
  detailPanelState,
  selectedSummaryOrders,
  selectedSummaryTotal,
  sortedDetailRows,
  detailTotals,
  columnsAnchorEl,
  onOpenBillingEdit,
  onOpenOrderDetail,
  onOpenStorageProof,
}: {
  detailState: { open: boolean; loading: boolean; clientName: string; error: string | null }
  detailPanelState: BillingDetailPanelState
  selectedSummaryOrders: number
  selectedSummaryTotal: number
  sortedDetailRows: BillingDetailDto[]
  detailTotals: {
    pickPack: number
    additional: number
    packageCost: number
    shipping: number
    total: number
    margin: number
  }
  columnsAnchorEl?: HTMLElement | null
  onOpenBillingEdit: (row: BillingDetailDto) => void
  onOpenOrderDetail: (orderId: number) => void
  // PS-373 (slice 2): admin drilldown into the frozen storage proof. Optional —
  // when provided, the storage line's cell becomes a button that opens the
  // per-SKU / per-interval evidence. Passed through from BillingView.
  onOpenStorageProof?: () => void
}) {
  if (detailState.error) {
    return (
      <div
        role="alert"
        style={{
          padding: 14,
          border: '1px solid var(--red)',
          borderRadius: 8,
          background: 'rgba(239, 68, 68, 0.10)',
          color: 'var(--text)',
        }}
      >
        <div style={{ fontWeight: 700, color: 'var(--red)' }}>Billing details failed to load.</div>
        <div style={{ marginTop: 4, fontSize: 12 }}>{detailState.error}</div>
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>
          The Summary above may be cached. Try <strong>Update Billing</strong>, then reopen Line Items. If it
          persists, the details API is erroring — check server logs.
        </div>
      </div>
    )
  }

  if (detailPanelState === 'mismatch') {
    return (
      <div
        role="alert"
        style={{
          padding: 14,
          border: '1px solid #f59e0b',
          borderRadius: 8,
          background: 'rgba(245, 158, 11, 0.10)',
          color: 'var(--text)',
        }}
      >
        <div style={{ fontWeight: 700, color: '#b45309' }}>Summary / line-item mismatch</div>
        <div style={{ marginTop: 4, fontSize: 12 }}>
          Summary shows {selectedSummaryOrders} order{selectedSummaryOrders === 1 ? '' : 's'}
          {selectedSummaryTotal > 0 ? ` (${formatBillingMoney(selectedSummaryTotal)})` : ''} for{' '}
          {detailState.clientName}, but no line items loaded for this date range.
        </div>
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>
          The summary is likely stale, or billing was mid-update. Click <strong>Update Billing</strong> to rebuild,
          then reopen Line Items.
        </div>
      </div>
    )
  }

  return (
    <Table<BillingDetailDto>
      data={sortedDetailRows}
      columns={BILLING_DETAIL_COLUMNS.map((column) => {
        const defaultHidden = !DEFAULT_BILLING_DETAIL_COLUMN_IDS_SET.has(column.id)
        const baseWidth = DETAIL_COLUMN_WIDTHS[column.id] ?? 110
        const tdStyleBase: CSSProperties = {
          padding: '5px 10px',
          textAlign: column.align === 'right' ? 'right' : column.align === 'center' ? 'center' : 'left',
        }
        return {
          key: column.id,
          label: column.label,
          width: baseWidth,
          minWidth: 70,
          align: column.align,
          sortable: column.id !== 'actions',
          // 2026-05-13: every column toggleable + draggable per
          // operator request (Awaiting-Shipment parity). The
          // upstream `column.always` flag in BILLING_DETAIL_COLUMNS
          // is intentionally ignored here — Columns ▾ picker's
          // Reset button covers the safety case if an operator
          // hides too much by accident.
          hideable: column.id !== 'actions',
          sortValue: (row) => detailSortValueOf(row, column.id),
          render: (row) => {
            const metrics = computeBillingDetailMetrics(row)
            const lineLabel = row.itemNames || row.description || ''
            switch (column.id) {
              case 'actions':
                return row.orderId ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <button
                      type="button"
                      className="billing-detail-edit-button"
                      title="Edit billing details"
                      onClick={(event) => { event.stopPropagation(); onOpenBillingEdit(row) }}
                    >
                      <Pencil size={13} aria-hidden="true" />
                      <span>Edit</span>
                    </button>
                    {/* PS-275: row-level affordance so operators can SEE which
                        rows need the $0-shipping review without opening every
                        Edit modal. Gated on the backend per-row flag; opens the
                        SAME edit modal (the review section already lives there).
                        Additive — rows without the flag render only Edit. */}
                    {row.shippingZeroNeedsReview && row.feeWaiverDecision == null ? (
                      <button
                        type="button"
                        title={`${(row.zeroShippingReviewLabel as string) || '$0 shipping'} — review the prep fee (waive or keep). Opens the edit modal.`}
                        onClick={(event) => { event.stopPropagation(); onOpenBillingEdit(row) }}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 3,
                          minHeight: 26,
                          padding: '4px 6px',
                          fontSize: 10.5,
                          fontWeight: 800,
                          cursor: 'pointer',
                          color: '#b45309',
                          background: '#fef3c7',
                          border: '1px solid #fde68a',
                          borderRadius: 6,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        Review
                      </button>
                    ) : null}
                  </span>
                ) : (
                  <span style={{ color: 'var(--text4)' }}>—</span>
                )
              case 'orderNumber':
                if (row.orderId) {
                  return (
                    <button
                      type="button"
                      className="inventory-inline-button"
                      title="Open order detail"
                      onClick={(e) => { e.stopPropagation(); onOpenOrderDetail(row.orderId as number) }}
                      style={{ fontWeight: 600, color: 'var(--ss-blue)' }}
                    >
                      {row.orderNumber}
                    </button>
                  )
                }
                // PS-373 (slice 2): the storage line has no order — make it a
                // drilldown into the frozen per-SKU / per-interval proof (admin).
                if (row.lineType === 'storage' && onOpenStorageProof) {
                  return (
                    <button
                      type="button"
                      className="inventory-inline-button"
                      title="View the storage-fee proof (per-SKU cubic-foot-days)"
                      onClick={(e) => { e.stopPropagation(); onOpenStorageProof() }}
                      style={{ fontWeight: 600, color: 'var(--ss-blue)' }}
                    >
                      Storage · proof ▸
                    </button>
                  )
                }
                return <span style={{ color: 'var(--text2)' }}>{row.orderNumber || 'Storage'}</span>
              case 'shipDate':
                return <span style={{ color: 'var(--text2)', fontSize: 11 }}>{formatBillingShipDate(row.shipDate)}</span>
              case 'carrierNickname': {
                const carrierText = row.carrierNickname || row.providerAccountNickname || row.carrier_nickname || row.provider_account_nickname || row.carrierCode || row.carrier_code || ''
                return <span style={{ color: carrierText ? 'var(--text)' : 'var(--text4)', fontSize: 11, fontWeight: carrierText ? 600 : 400 }}>{carrierText || '-'}</span>
              }
              case 'itemNames':
                return (
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11 }} title={lineLabel}>
                    {lineLabel ? splitBillingDetailLines(lineLabel).map((name: string, index: number) => (
                      <div key={`name-${index}`} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
                    )) : <span style={{ color: 'var(--text4)' }}>—</span>}
                  </div>
                )
              case 'itemSkus': {
                const skuText = row.itemSkus || ''
                return (
                  <div style={{ fontFamily: 'monospace', fontSize: 10.5, color: 'var(--text2)' }}>
                    {skuText ? splitBillingDetailLines(skuText).map((sku: string, index: number) => (
                      <div key={`sku-${index}`}>{sku || '—'}</div>
                    )) : <span style={{ color: 'var(--text4)' }}>—</span>}
                  </div>
                )
              }
              case 'totalQty':
                return <span>{row.totalQty || row.qty || 0}</span>
              case 'pickpack':
                // PS — flat first-unit Pick & Pack fee only; extra units
                // are shown in the Addl Units column (not folded in here).
                return formatBillingMoney(metrics.pickPack)
              case 'additional':
                return formatBillingMoney(metrics.additional, { dashIfZero: true })
              case 'packageCost':
                // PS-207: the shipped box could not be resolved to a known
                // package (or selected box ≠ shipment dims) — the backend
                // emitted a $0.00 package_cost_missing review line. Render the
                // backend flag as an amber NEEDS REVIEW chip; clicking opens
                // the Edit Billing Detail modal to resolve (box and/or price
                // → persisted in billing_box_resolutions). No FE policy math.
                if (row.packageCostNeedsReview) {
                  return (
                    <button
                      type="button"
                      title={`${row.packageCostReviewReason || 'Shipped box needs review'} — click to resolve`}
                      onClick={(event) => { event.stopPropagation(); onOpenBillingEdit(row) }}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 3,
                        background: 'transparent',
                        border: 'none',
                        padding: 0,
                        cursor: 'pointer',
                      }}
                    >
                      <span
                        style={{
                          fontSize: 8.5,
                          fontWeight: 700,
                          color: '#b45309',
                          background: '#fef3c7',
                          border: '1px solid #fde68a',
                          borderRadius: 4,
                          padding: '0 3px',
                          lineHeight: 1.4,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        NEEDS REVIEW
                      </span>
                    </button>
                  )
                }
                if (hasBillingNoBoxCostAlert(row)) return <BillingNoBoxCostAction row={row} onOpenBillingEdit={onOpenBillingEdit} />
                // PS-068: badge box charges whose stored price predates the
                // client's latest package-price/config change, so operators can
                // see un-repriced rows before exporting (run Update Billing to fix).
                return row.stalePackagePrice ? (
                  <span
                    title="Box price changed since this was billed — run Update Billing to re-price this range"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}
                  >
                    {formatBillingMoney(metrics.packageCost, { dashIfZero: true })}
                    <span
                      style={{
                        fontSize: 8.5,
                        fontWeight: 700,
                        color: '#b45309',
                        background: '#fef3c7',
                        border: '1px solid #fde68a',
                        borderRadius: 4,
                        padding: '0 3px',
                        lineHeight: 1.4,
                      }}
                    >
                      STALE
                    </span>
                  </span>
                ) : (
                  formatBillingMoney(metrics.packageCost, { dashIfZero: true })
                )
              case 'packageName':
                return <span style={{ fontSize: 10.5, color: 'var(--text2)' }}>{row.packageName || '—'}</span>
              case 'selectedRate':
                return (
                  <span
                    data-billing-rate="selectedRate"
                    style={{ fontSize: 11 }}
                    className={metrics.chargedRate === 'selectedRate' ? 'billing-detail-rate-hit' : undefined}
                  >
                    {formatBillingMoney(row.selectedRateCost ?? row.selected_rate_cost, { dashIfZero: true })}
                  </span>
                )
              case 'upsss':
                return (
                  <span style={{ fontSize: 11, color: (row.refUpsRate ?? row.ref_ups_rate) ? '#2563eb' : undefined }} className={metrics.chargedRate === 'upsss' ? 'billing-detail-rate-hit' : undefined}>
                    {formatBillingMoney(row.refUpsRate ?? row.ref_ups_rate, { dashIfZero: true })}
                  </span>
                )
              case 'uspsss':
                return (
                  <span style={{ fontSize: 11, color: (row.refUspsRate ?? row.ref_usps_rate) ? '#16a34a' : undefined }} className={metrics.chargedRate === 'uspsss' ? 'billing-detail-rate-hit' : undefined}>
                    {formatBillingMoney(row.refUspsRate ?? row.ref_usps_rate, { dashIfZero: true })}
                  </span>
                )
              case 'shipping':
                // PS-376: every $0-shipping row shows the backend-owned review
                // badge (with its reason) right in the Shipping cell. SS-charged
                // rows are >$0, so they never carry the badge.
                if (metrics.ssCharged) {
                  return (
                    <>
                      <span style={{ color: '#b45309', fontWeight: 600 }}>{formatBillingMoney(metrics.shipping)}</span>
                      <span style={{ fontSize: 9, color: 'var(--text3)', marginLeft: 3 }}>↑SS</span>
                    </>
                  )
                }
                return hasBillingZeroShippingReview(row) ? (
                  <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                    <span>{formatBillingMoney(metrics.shipping)}</span>
                    <BillingZeroShippingBadge row={row} />
                  </span>
                ) : (
                  formatBillingMoney(metrics.shipping)
                )
              case 'total':
                return <span style={{ fontWeight: 700, color: 'var(--green)' }}>{formatBillingMoney(metrics.fulfillmentFee)}</span>
              case 'margin':
                return (
                  <span style={{ fontSize: 11, color: marginColor(metrics.margin), fontWeight: 600 }}>
                    {metrics.margin > 0 ? '+' : ''}${metrics.margin.toFixed(2)}
                  </span>
                )
              default:
                return null
            }
          },
          defaultHidden,
        } satisfies TableColumn<BillingDetailDto>
      })}
      rowKey={(row) => row.id ?? `${row.orderId ?? 'storage'}-${row.lineType ?? 'detail'}-${row.description ?? 'row'}`}
      storageKey="billing-detail-table-v3-newest-first"
      defaultSort={{ key: 'shipDate', direction: 'desc' }}
      paginated
      stickyPagination
      defaultPageSize={50}
      pageSizeOptions={BILLING_DETAIL_PAGE_SIZE_OPTIONS}
      loading={detailState.loading}
      columnsAnchorEl={columnsAnchorEl}
      emptyMessage="No line items found."
      rowClassName={(row) => (computeBillingDetailMetrics(row).ssCharged ? 'billing-detail-ss-row' : undefined)}
      footerRow={(cols) => cols.map((c) => {
        const td: CSSProperties = {
          padding: '6px 10px',
          textAlign: c.align === 'right' ? 'right' : c.align === 'center' ? 'center' : 'left',
          fontWeight: 700,
        }
        switch (c.key) {
          case 'orderNumber': return <td key={c.key} style={td}>Total</td>
          case 'pickpack': return <td key={c.key} style={td}>{formatBillingMoney(detailTotals.pickPack)}</td>
          case 'additional': return <td key={c.key} style={td}>{formatBillingMoney(detailTotals.additional, { dashIfZero: true })}</td>
          case 'packageCost': return <td key={c.key} style={td}>{formatBillingMoney(detailTotals.packageCost, { dashIfZero: true })}</td>
          case 'shipping': return <td key={c.key} style={td}>{formatBillingMoney(detailTotals.shipping)}</td>
          case 'total': return <td key={c.key} style={{ ...td, fontWeight: 800, color: 'var(--green)' }}>{formatBillingMoney(detailTotals.total)}</td>
          case 'margin': return <td key={c.key} style={{ ...td, color: marginColor(detailTotals.margin) }}>${detailTotals.margin.toFixed(2)}</td>
          default: return <td key={c.key} style={td} />
        }
      })}
    />
  )
}
