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
import type { CSSProperties, ReactNode } from 'react'
import { Pencil } from 'lucide-react'
import { BillingNoBoxCostAction, hasBillingNoBoxCostAlert } from './BillingNoBoxCostAction'
import { BillingZeroShippingBadge, hasBillingZeroShippingReview } from './BillingZeroShippingBadge'
import type { BillingDetailColumnId, BillingDetailDto, BillingDetailPanelState } from './billing-parity'
import {
  billingShipDateSortValue,
  billingDetailQtyDisplay,
  billingDetailQtySortValue,
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
  // PS-505: the Order # cell now also carries the duplicate-order marker that used to
  // live in the removed Status column, so it needs the width that column gave back.
  orderNumber: 170,
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
    // PS-488 M3: sort on the backend's displayReference so a Return sorts under its own
    // identity (#1234-RETURN, #1234-RETURN-2) rather than the outbound order number it
    // shares with the shipment row. orderNumber/orderId remain the fallback for rows
    // with no reference; orderId stays navigation-only and is never visible identity.
    case 'orderNumber': return row.displayReference || row.orderNumber || row.orderId
    case 'shipDate': return billingShipDateSortValue(row.billingEffectiveDate ?? row.shipDate)
    case 'carrierNickname': return row.carrierNickname || row.providerAccountNickname || row.carrier_nickname || row.provider_account_nickname || row.carrierCode || row.carrier_code || ''
    case 'itemNames': return row.itemNames || row.description
    case 'itemSkus': return row.itemSkus
    case 'totalQty': return billingDetailQtySortValue(row)
    // PS-488 AC-6: sort on the backend value. No fallback chain — an absent field
    // must sort as absent, not be reconstructed from shipping/pickpack.
    case 'rowType': return (row.rowType as string) ?? ''
    case 'destination': return (row.destination as string) ?? ''
    case 'returnPostage': return Number(row.returnPostageTotal ?? 0)
    case 'returnProcessing': return Number(row.returnProcessingTotal ?? 0)
    case 'returnTotal': return metrics.returnTotal
    case 'pickpack': return metrics.pickPack
    case 'additional': return metrics.additional
    case 'packageCost': return metrics.packageCost
    case 'packageName': return row.packageName
    case 'selectedRate': return row.selectedRateCost ?? row.selected_rate_cost
    case 'upsss': return row.refUpsRate ?? row.ref_ups_rate
    case 'uspsss': return row.refUspsRate ?? row.ref_usps_rate
    case 'shipping': return metrics.shipping
    // PS-505 corrective: the 'total' column is Fulfillment Fee and must sort on it, not
    // on the row total — sorting a column by a number it does not display is its own bug.
    case 'total': return metrics.fulfillmentFee
    case 'rowTotal': return metrics.total
    case 'margin': return metrics.margin
    default: return ''
  }
}

function marginColor(value: number | null) {
  // PS-505: null is "cost never proven", not zero. It gets the muted colour a blank
  // cell should have rather than the neutral-zero colour, which would read as a
  // margin of exactly nothing having been calculated.
  if (value == null) return 'var(--text4)'
  if (value > 0) return 'var(--green)'
  if (value < 0) return 'var(--red)'
  return 'var(--text3)'
}

function splitBillingDetailLines(value: string): string[] {
  return value.split(/\r?\n| \| /).filter((line) => line.trim())
}

function manualBillingOverrideLineTypes(row: BillingDetailDto): string[] {
  const raw = row.manualBillingOverrideLineTypes ?? row.manual_billing_override_line_types
  return Array.isArray(raw) ? raw.map((value) => String(value)) : []
}

function hasManualBillingOverride(row: BillingDetailDto, lineType: string): boolean {
  return manualBillingOverrideLineTypes(row).includes(lineType)
}

function MoneyWithBillingBadges({
  children,
  badges,
}: {
  children: ReactNode
  badges: string[]
}) {
  const visibleBadges = badges.filter(Boolean)
  if (!visibleBadges.length) return <>{children}</>
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
      <span>{children}</span>
      {visibleBadges.map((badge) => (
        <span
          key={badge}
          title={badge}
          style={{
            fontSize: 8.5,
            fontWeight: 700,
            color: 'var(--text2)',
            background: 'var(--bg2)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: '0 3px',
            lineHeight: 1.4,
            whiteSpace: 'nowrap',
          }}
        >
          {badge}
        </span>
      ))}
    </span>
  )
}

type BillingStatusTone = 'neutral' | 'red' | 'purple' | 'amber' | 'blue'

function billingStatusLifecycle(row: BillingDetailDto): string {
  return String(row.billingLifecycleStatus || 'fulfilled')
}

function billingStatusLabel(row: BillingDetailDto): string {
  const label = typeof row.billingStatusLabel === 'string' ? row.billingStatusLabel.trim() : ''
  return label || 'Fulfilled'
}

function billingStatusTone(row: BillingDetailDto): BillingStatusTone {
  const tone = String(row.billingStatusTone || 'neutral')
  if (tone === 'red' || tone === 'purple' || tone === 'amber' || tone === 'blue') return tone
  return 'neutral'
}

function billingStatusChipStyle(tone: BillingStatusTone): CSSProperties {
  const styles: Record<BillingStatusTone, CSSProperties> = {
    neutral: {
      color: 'var(--text2)',
      background: 'var(--surface2)',
      border: '1px solid var(--border)',
    },
    red: {
      color: '#b91c1c',
      background: '#fee2e2',
      border: '1px solid #fecaca',
    },
    purple: {
      color: '#6d28d9',
      background: '#ede9fe',
      border: '1px solid #ddd6fe',
    },
    amber: {
      color: '#b45309',
      background: '#fef3c7',
      border: '1px solid #fde68a',
    },
    blue: {
      color: '#1d4ed8',
      background: '#dbeafe',
      border: '1px solid #bfdbfe',
    },
  }
  return {
    ...styles[tone],
    borderRadius: 4,
    display: 'inline-flex',
    fontSize: 10,
    fontWeight: 800,
    lineHeight: 1.4,
    maxWidth: '100%',
    overflow: 'hidden',
    padding: '1px 5px',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }
}

/**
 * PS-488 M3 — every return lifecycle value the backend can emit.
 *
 * Two call sites below each spelled out `'return' || 'return_label' ||
 * 'return_processing'` and both omitted the CANONICAL names the generator actually
 * writes — 'return_postage' and 'return_processing_fee'. A row carrying either of those
 * therefore lost its Return styling and its Return backup label entirely, while a row
 * carrying the legacy spelling kept them. Listed once so the two sites cannot drift apart
 * again, and so adding a lifecycle value has exactly one place to touch.
 *
 * The aggregated Billing rows now resolve to the single stable 'return', but this must
 * still cover the component values: they remain reachable on unaggregated reads and on
 * Client Portal rows, and styling that silently drops a case is worse than no styling.
 */
const RETURN_LIFECYCLE_STATUSES = new Set([
  'return',
  'return_label',
  'return_processing',
  'return_postage',
  'return_processing_fee',
])

function isReturnLifecycle(row: BillingDetailDto): boolean {
  return RETURN_LIFECYCLE_STATUSES.has(String(billingStatusLifecycle(row) ?? ''))
}

function billingOrderBackupStatus(row: BillingDetailDto): 'Cancelled' | 'Return' | null {
  const lifecycle = billingStatusLifecycle(row)
  if (lifecycle === 'cancelled_no_charge' || lifecycle === 'cancelled_billable' || row.billingStatusBadge === 'CANCELLED') {
    return 'Cancelled'
  }
  if (isReturnLifecycle(row)) return 'Return'
  return null
}

function billingStatusRowClass(row: BillingDetailDto): string | null {
  const lifecycle = billingStatusLifecycle(row)
  if (lifecycle === 'cancelled_no_charge' || lifecycle === 'cancelled_billable') return 'billing-detail-status-cancelled'
  if (isReturnLifecycle(row)) return 'billing-detail-status-return'
  return null
}

export function BillingDetailTable({
  detailState,
  detailPanelState,
  selectedSummaryOrders,
  selectedSummaryTotal,
  sortedDetailRows,
  detailTotals,
  columnsAnchorEl,
  readOnlyReason,
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
    /** PS-505: fulfillment SERVICE fees only — matches the Fulfillment Fee cells. */
    fulfillmentFee: number
    returnTotal: number
    /** PS-505: the Row Total column's footer. A different concept from fulfillmentFee. */
    total: number
    margin: number | null
  }
  columnsAnchorEl?: HTMLElement | null
  readOnlyReason: string | null
  onOpenBillingEdit: (row: BillingDetailDto) => void
  onOpenOrderDetail: (orderId: number) => void
  // PS-373 (slice 2): admin drilldown into the frozen storage proof. Optional —
  // when provided, the storage line's cell becomes a button that opens the
  // per-SKU / per-interval evidence. Passed through from BillingView.
  onOpenStorageProof?: (row: BillingDetailDto) => void
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
                      disabled={Boolean(readOnlyReason)}
                      title={readOnlyReason ?? 'Edit billing details'}
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
                        disabled={Boolean(readOnlyReason)}
                        title={readOnlyReason ?? `${(row.zeroShippingReviewLabel as string) || '$0 shipping'} — review the prep fee (waive or keep). Opens the edit modal.`}
                        onClick={(event) => { event.stopPropagation(); onOpenBillingEdit(row) }}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 3,
                          minHeight: 26,
                          padding: '4px 6px',
                          fontSize: 10.5,
                          fontWeight: 800,
                          cursor: readOnlyReason ? 'not-allowed' : 'pointer',
                          opacity: readOnlyReason ? 0.55 : 1,
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
                  const backupStatus = billingOrderBackupStatus(row)
                  const backupTone = billingStatusTone(row)
                  return (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <button
                        type="button"
                        className="inventory-inline-button"
                        title="Open order detail"
                        onClick={(e) => { e.stopPropagation(); onOpenOrderDetail(row.orderId as number) }}
                        style={{ fontWeight: 600, color: 'var(--ss-blue)' }}
                      >
                        {/* PS-488 M3: the backend owns visible identity. A Return row
                            shows its persisted reference (#1234-RETURN); the outbound
                            row shows its order number. The click target still opens the
                            related order — navigation by orderId, identity by
                            displayReference. No suffix is assembled here. */}
                        {row.displayReference || row.orderNumber}
                      </button>
                      {row.destinationIsInternational === true ? (
                        <span
                          data-billing-badge="INTERNATIONAL"
                          title={
                            row.destinationCountry
                              ? `International destination (${row.destinationCountry})`
                              : 'International destination'
                          }
                          style={{
                            fontSize: 8.5,
                            padding: '0 3px',
                            borderRadius: 3,
                            fontWeight: 700,
                            letterSpacing: 0.2,
                            border: '1px solid var(--ss-blue)',
                            color: 'var(--ss-blue)',
                            background: 'transparent',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {row.destinationCountry || 'INTL'}
                        </span>
                      ) : null}
                      {backupStatus === 'Cancelled' ? (
                        <span
                          data-billing-badge="CANCELLED"
                          title={billingStatusLabel(row)}
                          style={{ ...billingStatusChipStyle(backupTone), fontSize: 8.5, padding: '0 3px' }}
                        >
                          Cancelled
                        </span>
                      ) : backupStatus ? (
                        <span
                          data-billing-badge="RETURN"
                          title={billingStatusLabel(row)}
                          style={{ ...billingStatusChipStyle(backupTone), fontSize: 8.5, padding: '0 3px' }}
                        >
                          {backupStatus}
                        </span>
                      ) : null}
                    </span>
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
                      onClick={(e) => { e.stopPropagation(); onOpenStorageProof(row) }}
                      style={{ fontWeight: 600, color: 'var(--ss-blue)' }}
                    >
                      Storage · proof ▸
                    </button>
                  )
                }
                return <span style={{ color: 'var(--text2)' }}>{row.orderNumber || 'Storage'}</span>
              // PS-505: the standalone Billing Status cell is removed. The backend
              // lifecycle facts are still consumed — row styling, the cancelled/return
              // classes and the essential badges all read billingStatusLifecycle/Tone
              // below — but there is no Status column, and the duplicate-order marker
              // now rides in the Order # cell rather than being re-surfaced here.
              case 'shipDate':
                return row.rolledFromWeekend === true ? (
                  <span className="flex flex-col text-tiny leading-tight text-ink-2">
                    <span>Billed {formatBillingShipDate(row.billingEffectiveDate)}</span>
                    <span className="text-ink-3">Fulfilled {formatBillingShipDate(row.actualActivityDate ?? row.shipDate)}</span>
                  </span>
                ) : (
                  <span className="text-tiny text-ink-2">{formatBillingShipDate(row.billingEffectiveDate ?? row.shipDate)}</span>
                )
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
              // ── PS-488 AC-6 ──────────────────────────────────────────────
              // All four render backend-owned values verbatim. No country test, no
              // reference assembly, no summing: PrepShip decides, this displays.
              case 'rowType':
                return <span>{(row.rowType as string) ?? '—'}</span>
              case 'destination':
                // 'Needs Review' is a real backend answer, shown as-is rather than
                // softened to a dash — a gap on a money surface should look like one.
                return (
                  <span data-billing-destination={(row.destination as string) ?? ''}>
                    {(row.destination as string) ?? '—'}
                  </span>
                )
              case 'returnPostage':
              case 'returnProcessing': {
                const isPostage = column.id === 'returnPostage'
                const value = isPostage ? row.returnPostageTotal : row.returnProcessingTotal
                // PS-488 M3: PRESENCE, not the number. The aggregate reports 0 for a fee
                // the return was never charged, so reading the number alone rendered
                // "$0.00 postage" on a processing-only return — indistinguishable from a
                // postage charge that was genuinely waived. The backend now says which
                // it is, and a fee that does not exist gets no cell value.
                const present = isPostage ? row.hasReturnPostageLine : row.hasReturnProcessingLine
                if (present === false) {
                  return <span style={{ color: 'var(--text4)' }}>—</span>
                }
                // AC-5: not-yet-billable return money is blank, never a fabricated
                // $0.00 — an invented zero reads as a decision that was never made.
                if (value === null || value === undefined) {
                  return <span style={{ color: 'var(--text4)' }}>—</span>
                }
                return <span>${Number(value).toFixed(2)}</span>
              }
              case 'totalQty':
                return <span>{billingDetailQtyDisplay(row)}</span>
              case 'pickpack':
                // PS — flat first-unit Pick & Pack fee only; extra units
                // are shown in the Addl Units column (not folded in here).
                return (
                  <MoneyWithBillingBadges
                    badges={[
                      hasManualBillingOverride(row, 'pick_pack') ? 'Manual override' : '',
                      row.feeWaived ? 'Prep fee waived' : '',
                    ]}
                  >
                    {formatBillingMoney(metrics.pickPack)}
                  </MoneyWithBillingBadges>
                )
              case 'additional':
                return (
                  <MoneyWithBillingBadges badges={[hasManualBillingOverride(row, 'additional_unit') ? 'Manual override' : '']}>
                    {formatBillingMoney(metrics.additional, { dashIfZero: true })}
                  </MoneyWithBillingBadges>
                )
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
                      disabled={Boolean(readOnlyReason)}
                      title={readOnlyReason ?? `${row.packageCostReviewReason || 'Shipped box needs review'} — click to resolve`}
                      onClick={(event) => { event.stopPropagation(); onOpenBillingEdit(row) }}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 3,
                        background: 'transparent',
                        border: 'none',
                        padding: 0,
                        cursor: readOnlyReason ? 'not-allowed' : 'pointer',
                        opacity: readOnlyReason ? 0.55 : 1,
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
                if (hasBillingNoBoxCostAlert(row)) {
                  return (
                    <BillingNoBoxCostAction
                      row={row}
                      onOpenBillingEdit={onOpenBillingEdit}
                      disabledReason={readOnlyReason}
                    />
                  )
                }
                // PS-068: badge box charges whose stored price predates the
                // client's latest package-price/config change, so operators can
                // see un-repriced rows before exporting (run Update Billing to fix).
                return (
                  <MoneyWithBillingBadges badges={[hasManualBillingOverride(row, 'package_cost') ? 'Manual override' : '']}>
                    {row.stalePackagePrice ? (
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
                    )}
                  </MoneyWithBillingBadges>
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
                    <MoneyWithBillingBadges badges={[hasManualBillingOverride(row, 'shipping') ? 'Shipping override' : '']}>
                      <span style={{ color: '#b45309', fontWeight: 600 }}>{formatBillingMoney(metrics.shipping)}</span>
                      <span style={{ fontSize: 9, color: 'var(--text3)', marginLeft: 3 }}>↑SS</span>
                    </MoneyWithBillingBadges>
                  )
                }
                return hasBillingZeroShippingReview(row) ? (
                  <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                    <MoneyWithBillingBadges badges={[hasManualBillingOverride(row, 'shipping') ? 'Shipping override' : '']}>
                      {formatBillingMoney(metrics.shipping)}
                    </MoneyWithBillingBadges>
                    <BillingZeroShippingBadge row={row} />
                  </span>
                ) : (
                  <MoneyWithBillingBadges badges={[hasManualBillingOverride(row, 'shipping') ? 'Shipping override' : '']}>
                    {formatBillingMoney(metrics.shipping)}
                  </MoneyWithBillingBadges>
                )
              case 'total':
                // PS-505 corrective: fulfillment SERVICE fees. 4.49 on #3074, and 0 on a
                // Return row because every outbound bucket is zero there.
                return <span style={{ fontWeight: 700 }}>{formatBillingMoney(metrics.fulfillmentFee, { dashIfZero: true })}</span>
              case 'rowTotal':
                // PS-505 corrective: the whole row — 12.44 outbound, 10.55 on the return.
                return <span style={{ fontWeight: 700, color: 'var(--green)' }}>{formatBillingMoney(metrics.total)}</span>
              case 'margin':
                // PS-505: blank when the cost was never proven. Previously the FE
                // coerced an absent selected-rate cost to $0.00 and rendered the whole
                // shipping charge as margin — a fabricated profit on a money column.
                if (metrics.margin === null) {
                  return <span style={{ fontSize: 11, color: 'var(--text4)' }}>—</span>
                }
                return (
                  <span style={{ fontSize: 11, color: marginColor(metrics.margin), fontWeight: 600 }}>
                    {metrics.margin > 0 ? '+' : ''}${metrics.margin.toFixed(2)}
                  </span>
                )
              case 'returnTotal': {
                // PS-505: a Return row's own money. Blank on outbound rows — zero return
                // money is not a $0.00 return charge, it is the absence of a return.
                if (row.rowType !== 'Return') {
                  return <span style={{ color: 'var(--text4)' }}>—</span>
                }
                return <span style={{ fontWeight: 700 }}>{formatBillingMoney(metrics.returnTotal)}</span>
              }
              default:
                return null
            }
          },
          defaultHidden,
        } satisfies TableColumn<BillingDetailDto>
      })}
      rowKey={(row) => (
        // PS-488 M3: a Return row keys on its relational returnId, so two returns on one
        // order get stable distinct keys that depend on neither orderNumber (which they
        // share with the outbound row) nor on which component line the aggregate kept.
        row.returnId != null
          ? `return:${row.returnId}`
          : row.id ?? `${row.orderId ?? 'storage'}-${row.lineType ?? 'detail'}-${row.description ?? 'row'}`
      )}
      storageKey="billing-detail-table-v3-newest-first"
      defaultSort={{ key: 'shipDate', direction: 'desc' }}
      paginated
      stickyPagination
      defaultPageSize={50}
      pageSizeOptions={BILLING_DETAIL_PAGE_SIZE_OPTIONS}
      loading={detailState.loading}
      columnsAnchorEl={columnsAnchorEl}
      emptyMessage="No line items found."
      rowClassName={(row) => {
        const classes = [
          computeBillingDetailMetrics(row).ssCharged ? 'billing-detail-ss-row' : '',
          billingStatusRowClass(row) || '',
        ].filter(Boolean)
        return classes.length ? classes.join(' ') : undefined
      }}
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
          // PS-505 corrective: each footer now sums the SAME concept its cells render.
          case 'total': return <td key={c.key} style={{ ...td, fontWeight: 800 }}>{formatBillingMoney(detailTotals.fulfillmentFee)}</td>
          case 'returnTotal': return <td key={c.key} style={{ ...td, fontWeight: 700 }}>{formatBillingMoney(detailTotals.returnTotal, { dashIfZero: true })}</td>
          case 'rowTotal': return <td key={c.key} style={{ ...td, fontWeight: 800, color: 'var(--green)' }}>{formatBillingMoney(detailTotals.total)}</td>
          case 'margin': return (
            <td key={c.key} style={{ ...td, color: marginColor(detailTotals.margin) }}>
              {detailTotals.margin === null ? '—' : `$${detailTotals.margin.toFixed(2)}`}
            </td>
          )
          default: return <td key={c.key} style={td} />
        }
      })}
    />
  )
}
