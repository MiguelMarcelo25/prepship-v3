import { lazy, Suspense, useContext, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from 'react'
import { motion } from 'framer-motion'
import { Check, ListFilter, Loader2, Pencil, Receipt, SlidersHorizontal, X } from 'lucide-react'
import { apiClient } from '../../api/client'
// PS-275: the new $0-shipping prep-fee review POST has no apiClient wrapper
// (that adapter is out of this ticket's scope); call the shared low-level
// client directly. Additive, behind the backend shippingZeroNeedsReview flag.
import { api } from '../../lib/api'
import BulkBoxCostModal from './BulkBoxCostModal'
import BoxReviewSweepModal from './BoxReviewSweepModal'
import { ToastContext } from '../../contexts/ToastContext'
import type { PackageDto } from '../../types/api'
import {
  BILLING_DETAIL_COLUMNS,
  buildBackfillRefRatesToast,
  buildBillingConfigInput,
  buildBillingPackagePriceRows,
  buildBillingSummaryTotals,
  buildFetchRefRatesDoneText,
  buildFetchRefRatesProgressText,
  buildFetchRefRatesStartText,
  buildGenerateBillingStatus,
  classifyBillingDetailPanel,
  computeBillingDetailMetrics,
  createBillingConfigDraftMap,
  formatBillingShipDate,
  formatBillingMoney,
  getBillingDetailColumnStorageKey,
  getBillingInitialRange,
  getBillingInvoiceUrl,
  getBillingPresetRange,
  getDefaultBillingDetailColumnIds,
  getVisibleBillingDetailColumns,
  readBillingDetailColumnIds,
  reorderBillingDetailColumnIds,
  toggleBillingDetailColumnIds,
  type BillingConfigDraft,
  type BillingConfigDto,
  type BillingDetailColumnId,
  type BillingDetailDto,
  type BillingPackagePriceDto,
  type BillingPresetId,
  type BillingSummaryDto,
} from './billing-parity'
import { AnalysisPagination } from './AnalysisPagination'
import { nextSortState, sortRows, type SortState } from '../SortableTable'
import { Table, type TableColumn } from '../ui/Table'
// PS-155: Billing summary table extracted to ./BillingSummaryTable (behavior-preserving).
import { BillingSummaryTable } from './BillingSummaryTable'
// PS-155: filter row, client-filter panel, and detail client strip extracted (behavior-preserving).
import { BillingFilters } from './BillingFilters'
import { BillingClientFilterPanel } from './BillingClientFilterPanel'
import { BillingDetailClientStrip } from './BillingDetailClientStrip'
// PS-155: per-client detail table extracted (behavior-preserving; rows/sort/totals/handlers
// stay here and are passed as props, the table calls the pure computeBillingDetailMetrics).
import { BillingDetailTable } from './BillingDetailTable'
import { BillingLineItemWarningSummary } from './BillingLineItemWarningSummary'
import { hasBillingNoBoxCostAlert } from './BillingNoBoxCostAction'
import { BillingNoBoxCostPreview } from './BillingNoBoxCostPreview'
// PS-155: Client Billing Config + Package Pricing tables extracted (behavior-preserving; the
// config/price DRAFT state + setters and the Save handlers stay here and are passed as props).
import { BillingConfigTable } from './BillingConfigTable'
import { BillingCarrierMarginTable } from './BillingCarrierMarginTable'
import { ConfirmModal } from '../ui/ConfirmModal'
import { BillingPackagePricingTable } from './BillingPackagePricingTable'
import './BillingView.css'

const OrderDetailDrawer = lazy(() => import('../OrderDetailDrawer'))

interface BillingDetailState {
  open: boolean
  loading: boolean
  clientId: number | null
  clientName: string
  rows: BillingDetailDto[]
  error: string | null
}

type BillingEditDraft = {
  pickPack: string
  additional: string
  packageCost: string
  shipping: string
  // PS — selected Box Size package id (billing-line-only override). '' = keep
  // the shipment-derived box.
  packageId: string
}

type BillingEditModalState = {
  row: BillingDetailDto
  draft: BillingEditDraft
  saving: boolean
  error: string | null
} | null

type ShippingMarginSummaryDto = {
  rowCount: number
  marginRowCount: number
  frozenCount: number
  projectedCount: number
  missingBillableCount: number
  missingActualCostCount: number
  missingAnyProofCount: number
  actualShippingTotal: number
  billableShippingTotal: number
  marginTotal: number
  marginPct: number | null
}

// PS-296 (FE): the backend carrier/account margin rollup (analytics.carriers[]) — was
// fetched but discarded; surfaced as the Billing "Margin by carrier / account" breakdown.
type ShippingMarginCarrierDto = {
  carrierCode: string | null
  serviceCode: string | null
  providerAccountNickname: string | null
  accountDisplayName?: string | null
  accountDisplaySource?: string | null
  actualShippingTotal: number
  billableShippingTotal: number
  marginTotal: number
  marginPct: number | null
  marginRowCount: number
  negativeMarginCount: number
}

// PS-296 (FE, req6): per-shipment margin reconciliation rows (backend analytics.rows[]).
type ShippingMarginRowDto = {
  orderNumber: string | null
  orderId: number | null
  shipmentId: number | null
  shipDate: string | null
  carrierCode: string | null
  serviceCode: string | null
  providerAccountNickname: string | null
  accountDisplayName?: string | null
  accountDisplaySource?: string | null
  actualShippingCost: number | null
  billableShippingAmount: number | null
  marginAmount: number | null
  marginPct: number | null
  state: string
  missingProofReasons: string[]
}

const SHIPPING_MARGIN_DRILLDOWN_LIMIT = 250

const EMPTY_SHIPPING_MARGIN_SUMMARY: ShippingMarginSummaryDto = {
  rowCount: 0,
  marginRowCount: 0,
  frozenCount: 0,
  projectedCount: 0,
  missingBillableCount: 0,
  missingActualCostCount: 0,
  missingAnyProofCount: 0,
  actualShippingTotal: 0,
  billableShippingTotal: 0,
  marginTotal: 0,
  marginPct: null,
}

const SUMMARY_COL_COUNT = 8
const BILLING_DETAIL_PAGE_SIZE_OPTIONS = [25, 50, 100, 250]
const BILLING_CLIENT_FILTER_STORAGE_KEY = 'billing_summary_client_filter_v1'
const BILLING_GENERATE_BATCH_DAYS = 7
const SHIPSTATION_BILLING_CLIENT_NAMES = [
  'eBay - DJC',
  'Heritage Kids Press',
  'HUGRAB',
  'KimlyParc',
  'Manual Orders',
  'Techtok',
  'Tran Agency',
  'Walmart - DJC',
]
const SHIPSTATION_BILLING_CLIENT_NAME_SET = new Set(
  SHIPSTATION_BILLING_CLIENT_NAMES.map(normalizeBillingClientName),
)

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
    case 'shipDate': return row.shipDate ? new Date(row.shipDate) : null
    case 'carrierNickname': return row.carrierNickname || row.providerAccountNickname || row.carrier_nickname || row.provider_account_nickname || row.carrierCode || row.carrier_code || ''
    case 'itemNames': return row.itemNames || row.description
    case 'itemSkus': return row.itemSkus
    case 'totalQty': return row.totalQty || row.qty
    case 'pickpack': return metrics.pickPack
    case 'additional': return metrics.additional
    case 'packageCost': return metrics.packageCost
    case 'packageName': return row.packageName
    case 'selectedRate': return row.selectedRateCost ?? row.selected_rate_cost
    case 'upsss': return row.ref_ups_rate
    case 'uspsss': return row.ref_usps_rate
    case 'shipping': return metrics.shipping
    case 'total': return metrics.total
    case 'margin': return metrics.margin
    default: return ''
  }
}

function createBillingEditDraft(row: BillingDetailDto): BillingEditDraft {
  const metrics = computeBillingDetailMetrics(row)
  return {
    pickPack: metrics.pickPack.toFixed(2),
    additional: metrics.additional.toFixed(2),
    packageCost: metrics.packageCost.toFixed(2),
    shipping: metrics.shipping.toFixed(2),
    packageId: (row as Record<string, unknown>).packageId != null ? String((row as Record<string, unknown>).packageId) : '',
  }
}

function parseMoneyDraft(value: string) {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function marginColor(value: number) {
  if (value > 0) return 'var(--green)'
  if (value < 0) return 'var(--red)'
  return 'var(--text3)'
}

function normalizeBillingClientName(value: string | null | undefined) {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

function isShipStationBillingClientName(value: string | null | undefined) {
  return SHIPSTATION_BILLING_CLIENT_NAME_SET.has(normalizeBillingClientName(value))
}

function parseDateInput(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isNaN(date.getTime()) ? null : date
}

function formatDateInputUtc(value: Date) {
  return value.toISOString().slice(0, 10)
}

function splitBillingRangeIntoBatches(fromValue: string, toValue: string, batchDays = BILLING_GENERATE_BATCH_DAYS) {
  const start = parseDateInput(fromValue)
  const end = parseDateInput(toValue)
  if (!start || !end || start > end) return []

  const batches: Array<{ from: string; to: string }> = []
  const cursor = new Date(start)
  while (cursor <= end) {
    const batchStart = new Date(cursor)
    const batchEnd = new Date(cursor)
    batchEnd.setUTCDate(batchEnd.getUTCDate() + Math.max(1, batchDays) - 1)
    if (batchEnd > end) batchEnd.setTime(end.getTime())
    batches.push({
      from: formatDateInputUtc(batchStart),
      to: formatDateInputUtc(batchEnd),
    })
    cursor.setUTCDate(cursor.getUTCDate() + Math.max(1, batchDays))
  }
  return batches
}

function isoToDateInput(value: string | null | undefined) {
  if (!value) return null
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value)
  if (match) return match[1]!
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return formatDateInputUtc(date)
}

function billingRangeDays(fromValue: string, toValue: string) {
  const start = parseDateInput(fromValue)
  const end = parseDateInput(toValue)
  if (!start || !end || start > end) return 0
  return Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1
}

function readBillingClientFilterIds() {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(BILLING_CLIENT_FILTER_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((value) => Number.parseInt(String(value), 10))
      .filter((value) => Number.isFinite(value) && value > 0)
  } catch {
    return []
  }
}

export default function BillingView() {
  const toastContext = useContext(ToastContext)
  const initialRange = getBillingInitialRange(typeof window === 'undefined' ? new Date('2026-03-22T00:00:00Z') : new Date())
  const detailWrapRef = useRef<HTMLDivElement | null>(null)
  const fetchRefPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const [configs, setConfigs] = useState<BillingConfigDto[]>([])
  const [configDrafts, setConfigDrafts] = useState<Record<number, BillingConfigDraft>>({})
  const [configsLoading, setConfigsLoading] = useState(true)
  const [packages, setPackages] = useState<PackageDto[]>([])
  const [selectedPkgClientId, setSelectedPkgClientId] = useState('')
  const [savedPackagePrices, setSavedPackagePrices] = useState<BillingPackagePriceDto[]>([])
  const [packagePriceDrafts, setPackagePriceDrafts] = useState<Record<number, string>>({})
  const [packagePricingLoading, setPackagePricingLoading] = useState(false)
  const [packagePricingError, setPackagePricingError] = useState<string | null>(null)
  const [activePreset, setActivePreset] = useState<BillingPresetId | null>('last_30')
  const [from, setFrom] = useState(initialRange.from)
  const [to, setTo] = useState(initialRange.to)
  // PS-311: bulk box-cost modal — open when the operator chooses to apply a reviewed box cost to
  // EVERY order with that box in the current (client + date range).
  const [bulkBoxCostOpen, setBulkBoxCostOpen] = useState(false)
  // PS-311b: the needs-review box-cost sweep (date range picker + same-box-size apply).
  const [boxReviewSweepOpen, setBoxReviewSweepOpen] = useState(false)
  // Regenerate Range confirmation — a styled modal instead of the native browser confirm().
  const [regenerateConfirmOpen, setRegenerateConfirmOpen] = useState(false)
  const [summaryRows, setSummaryRows] = useState<BillingSummaryDto[]>([])
  const [clientFilterOpen, setClientFilterOpen] = useState(false)
  const [selectedBillingClientIds, setSelectedBillingClientIds] = useState<number[]>(readBillingClientFilterIds)
  const [summarySort, setSummarySort] = useState<SortState<string>>(null)
  const [detailSort, setDetailSort] = useState<SortState<BillingDetailColumnId>>(null)
  const [summaryPage, setSummaryPage] = useState(1)
  const [summaryPageSize, setSummaryPageSize] = useState(25)
  const [summaryLoading, setSummaryLoading] = useState(true)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [shippingMarginSummary, setShippingMarginSummary] = useState<ShippingMarginSummaryDto>(EMPTY_SHIPPING_MARGIN_SUMMARY)
  const [shippingMarginLoading, setShippingMarginLoading] = useState(false)
  const [shippingMarginError, setShippingMarginError] = useState<string | null>(null)
  // PS-296 (FE): the carrier/account margin breakdown rows (backend analytics.carriers[]).
  const [shippingMarginCarriers, setShippingMarginCarriers] = useState<ShippingMarginCarrierDto[]>([])
  // PS-296 (FE, req6): per-shipment reconciliation rows (backend analytics.rows[]), collapsed by default.
  const [shippingMarginRows, setShippingMarginRows] = useState<ShippingMarginRowDto[]>([])
  const [shippingMarginDrilldownOpen, setShippingMarginDrilldownOpen] = useState(false)
  const [generateLoading, setGenerateLoading] = useState(false)
  const [generateStatus, setGenerateStatus] = useState('')
  const [fetchRefRunning, setFetchRefRunning] = useState(false)
  const [fetchRefStatus, setFetchRefStatus] = useState('')
  const [backfillLoading, setBackfillLoading] = useState(false)
  const [detailState, setDetailState] = useState<BillingDetailState>({
    open: false,
    loading: false,
    clientId: null,
    clientName: '',
    rows: [],
    error: null,
  })
  const [detailPage, setDetailPage] = useState(1)
  const [detailPageSize, setDetailPageSize] = useState(50)
  const [orderDetailModalId, setOrderDetailModalId] = useState<number | null>(null)
  const [billingEditModal, setBillingEditModal] = useState<BillingEditModalState>(null)
  // PS-275: in-flight flag for the $0-shipping prep-fee review POST. Separate
  // from the edit-modal save state so the review action does not entangle with
  // the line-item save. Additive — only used when shippingZeroNeedsReview.
  const [zeroShippingReviewSaving, setZeroShippingReviewSaving] = useState(false)
  // PS — client package prices (packageId -> charge) for the open detail
  // client, used to auto-fill Box Cost when the operator changes the Box Size.
  const [billingEditPackagePrices, setBillingEditPackagePrices] = useState<Record<number, number>>({})
  const [detailColumnIds, setDetailColumnIds] = useState<BillingDetailColumnId[]>(() => {
    if (typeof window === 'undefined') return readBillingDetailColumnIds()
    return readBillingDetailColumnIds(window.localStorage)
  })
  // Drag-to-reorder state: tracks which column the user grabbed so we
  // can highlight the drop target and commit the swap on dragend.
  // Stored as refs (instead of state) for two reasons: (a) the drag
  // payload survives re-renders during the dragover stream, and (b) we
  // don't want re-renders firing on every mousemove during a drag.
  const dragColumnIdRef = useRef<BillingDetailColumnId | null>(null)
  const [dragOverColumnId, setDragOverColumnId] = useState<BillingDetailColumnId | null>(null)

  function handleColumnDragStart(columnId: BillingDetailColumnId, event: ReactDragEvent) {
    dragColumnIdRef.current = columnId
    // Setting a payload + 'move' effect activates the native drag
    // cursor. The data string is unused by us — only React tracks it.
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', columnId)
  }

  function handleColumnDragOver(columnId: BillingDetailColumnId, event: ReactDragEvent) {
    // preventDefault is required to allow drop. Without it, browsers
    // reject the drop with the no-entry cursor.
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (dragColumnIdRef.current && dragColumnIdRef.current !== columnId) {
      setDragOverColumnId(columnId)
    }
  }

  function handleColumnDrop(columnId: BillingDetailColumnId, event: ReactDragEvent) {
    event.preventDefault()
    const fromId = dragColumnIdRef.current
    dragColumnIdRef.current = null
    setDragOverColumnId(null)
    if (!fromId || fromId === columnId) return
    setDetailColumnIds((current) => reorderBillingDetailColumnIds(current, fromId, columnId))
  }

  function handleColumnDragEnd() {
    dragColumnIdRef.current = null
    setDragOverColumnId(null)
  }

  const packagePricingRows = useMemo(
    () => buildBillingPackagePriceRows(savedPackagePrices, packagePriceDrafts),
    [savedPackagePrices, packagePriceDrafts],
  )
  const availableBillingClients = useMemo(() => configs.map((config) => ({
    clientId: Number(config.clientId),
    clientName: config.clientName,
    inShipStation: isShipStationBillingClientName(config.clientName),
  })).filter((client) => Number.isFinite(client.clientId) && client.clientId > 0), [configs])
  const allBillingClientIds = useMemo(
    () => availableBillingClients.map((client) => client.clientId),
    [availableBillingClients],
  )
  const selectedBillingClientIdSet = useMemo(
    () => new Set(selectedBillingClientIds),
    [selectedBillingClientIds],
  )
  const billingClientFilterActive = selectedBillingClientIds.length > 0
  const billingClientQueryIds = useMemo(
    () => (billingClientFilterActive ? selectedBillingClientIds : undefined),
    [billingClientFilterActive, selectedBillingClientIds],
  )
  const filteredSummaryRows = useMemo(() => {
    if (!billingClientFilterActive) return summaryRows
    return summaryRows.filter((row) => selectedBillingClientIdSet.has(Number(row.clientId)))
  }, [billingClientFilterActive, selectedBillingClientIdSet, summaryRows])
  const excludedBillingClientNames = useMemo(() => {
    if (!billingClientFilterActive) return []
    return availableBillingClients
      .filter((client) => !selectedBillingClientIdSet.has(client.clientId))
      .map((client) => client.clientName)
  }, [availableBillingClients, billingClientFilterActive, selectedBillingClientIdSet])
  const missingShipStationClientNames = useMemo(() => {
    const prepShipNames = new Set(availableBillingClients.map((client) => normalizeBillingClientName(client.clientName)))
    return SHIPSTATION_BILLING_CLIENT_NAMES.filter((name) => !prepShipNames.has(normalizeBillingClientName(name)))
  }, [availableBillingClients])
  const selectedBillingClientCount = billingClientFilterActive
    ? selectedBillingClientIds.length
    : availableBillingClients.length
  const sortedSummaryRows = useMemo(() => sortRows(
    filteredSummaryRows,
    summarySort,
    (row, key) => {
      switch (key) {
        case 'client':
          return row.clientName
        case 'orders':
          return row.orderCount
        case 'pickPack':
          return row.pickPackTotal
        case 'additional':
          return row.additionalTotal
        case 'package':
          return row.packageTotal
        case 'storage':
          return row.storageTotal
        case 'shipping':
          return row.shippingTotal
        case 'total':
          return row.fulfillmentFeeTotal ?? row.grandTotal
        default:
          return ''
      }
    },
    (row) => row.clientName,
  ), [filteredSummaryRows, summarySort])
  const selectedDetailSummary = useMemo(() => {
    if (!detailState.clientId) return null
    return filteredSummaryRows.find((row) => Number(row.clientId) === Number(detailState.clientId)) ?? null
  }, [detailState.clientId, filteredSummaryRows])

  // PS-069 — what the open client's Summary row claims, so a nonzero summary
  // with zero detail rows renders a mismatch warning instead of a silent
  // "No line items found".
  const selectedSummaryOrders = Number(selectedDetailSummary?.orderCount ?? 0)
  const selectedSummaryTotal = Number(
    selectedDetailSummary?.fulfillmentFeeTotal ?? selectedDetailSummary?.grandTotal ?? selectedDetailSummary?.total ?? 0,
  )
  const detailPanelState = classifyBillingDetailPanel({
    loading: detailState.loading,
    hasError: Boolean(detailState.error),
    rowCount: detailState.rows.length,
    summaryOrders: selectedSummaryOrders,
    summaryTotal: selectedSummaryTotal,
  })

  const summaryTotals = useMemo(() => buildBillingSummaryTotals(filteredSummaryRows), [filteredSummaryRows])
  const visibleDetailColumns = useMemo(() => getVisibleBillingDetailColumns(detailColumnIds), [detailColumnIds])
  // PS-362: /billing/details returns backend-owned order-level rows.
  // React renders the DTO instead of collapsing raw billing fee lines.
  const mergedDetailRows = useMemo(
    () => {
      const merged = detailState.rows
      // Back-compat for old cached raw-line payloads. Fresh PS-362 payloads
      // already carry this backend-owned order-level flag.
      const zeroReviewByOrderId = new Map<unknown, boolean>()
      for (const raw of detailState.rows) {
        const oid = (raw as { orderId?: unknown }).orderId
        if (oid == null || oid === '') continue
        if ((raw as { shippingZeroNeedsReview?: unknown }).shippingZeroNeedsReview === true) {
          zeroReviewByOrderId.set(oid, true)
        }
      }
      if (zeroReviewByOrderId.size === 0) return merged
      return merged.map((row) => {
        const oid = (row as { orderId?: unknown }).orderId
        return oid != null && zeroReviewByOrderId.get(oid)
          ? ({ ...(row as Record<string, unknown>), shippingZeroNeedsReview: true } as typeof row)
          : row
      })
    },
    [detailState.rows],
  )
  const sortedDetailRows = useMemo(() => sortRows(
    mergedDetailRows,
    detailSort,
    (row, key) => {
      const metrics = computeBillingDetailMetrics(row)

      switch (key) {
        case 'actions':
          return ''
        case 'orderNumber':
          return row.orderNumber || row.orderId
        case 'shipDate':
          return row.shipDate ? new Date(row.shipDate) : null
        case 'carrierNickname':
          return row.carrierNickname || row.providerAccountNickname || row.carrier_nickname || row.provider_account_nickname || row.carrierCode || row.carrier_code || ''
        case 'itemNames':
          return row.itemNames || row.description
        case 'itemSkus':
          return row.itemSkus
        case 'totalQty':
          return row.totalQty || row.qty
        case 'pickpack':
          return metrics.pickPack
        case 'additional':
          return metrics.additional
        case 'packageCost':
          return metrics.packageCost
        case 'packageName':
          return row.packageName
        case 'selectedRate':
          return row.selectedRateCost ?? row.selected_rate_cost
        case 'upsss':
          return row.ref_ups_rate
        case 'uspsss':
          return row.ref_usps_rate
        case 'shipping':
          return metrics.shipping
        case 'total':
          return metrics.total
        case 'margin':
          return metrics.margin
        default:
          return ''
      }
    },
    (row) => row.orderNumber || row.id,
  ), [detailSort, mergedDetailRows])
  const billingNoBoxCostRows = useMemo(
    () => sortedDetailRows.filter(hasBillingNoBoxCostAlert),
    [sortedDetailRows],
  )
  const summaryPageCount = Math.max(1, Math.ceil(sortedSummaryRows.length / summaryPageSize))
  const currentSummaryPage = Math.min(Math.max(summaryPage, 1), summaryPageCount)
  const pagedSummaryRows = useMemo(() => {
    const start = (currentSummaryPage - 1) * summaryPageSize
    return sortedSummaryRows.slice(start, start + summaryPageSize)
  }, [currentSummaryPage, sortedSummaryRows, summaryPageSize])
  const detailPageCount = Math.max(1, Math.ceil(sortedDetailRows.length / detailPageSize))
  const currentDetailPage = Math.min(Math.max(detailPage, 1), detailPageCount)
  const detailRowOffset = (currentDetailPage - 1) * detailPageSize
  const selectedBillingRangeDays = useMemo(() => billingRangeDays(from, to), [from, to])
  const regenerateRangeBlocked = activePreset === 'all' || selectedBillingRangeDays > 120
  const pagedDetailRows = useMemo(() => {
    const start = (currentDetailPage - 1) * detailPageSize
    return sortedDetailRows.slice(start, start + detailPageSize)
  }, [currentDetailPage, detailPageSize, sortedDetailRows])
  const detailTotals = useMemo(() => {
    // Totals iterate the merged rows so we don't double-count an order
    // whose pick_pack and shipping arrived as separate API rows. Each
    // merged row holds the per-lineType subtotals on a single object.
    return mergedDetailRows.reduce((acc, row) => {
      const metrics = computeBillingDetailMetrics(row)
      return {
        // PS — the "Pick & Pack" column shows the flat first-unit fee only;
        // extra-unit charges live in the "Addl Units" column. Use metrics.pickPack
        // (base), not pickPackFee (base + additional), so the two don't overlap.
        pickPack: acc.pickPack + metrics.pickPack,
        additional: acc.additional + metrics.additional,
        packageCost: acc.packageCost + metrics.packageCost,
        shipping: acc.shipping + metrics.shipping,
        total: acc.total + metrics.fulfillmentFee,
        margin: acc.margin + metrics.margin,
      }
    }, { pickPack: 0, additional: 0, packageCost: 0, shipping: 0, total: 0, margin: 0 })
  }, [mergedDetailRows])

  useEffect(() => {
    return () => {
      if (fetchRefPollRef.current) clearInterval(fetchRefPollRef.current)
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(getBillingDetailColumnStorageKey(), JSON.stringify(detailColumnIds))
  }, [detailColumnIds])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(BILLING_CLIENT_FILTER_STORAGE_KEY, JSON.stringify(selectedBillingClientIds))
  }, [selectedBillingClientIds])

  useEffect(() => {
    if (allBillingClientIds.length === 0) return
    const allowed = new Set(allBillingClientIds)
    setSelectedBillingClientIds((current) => {
      const cleaned = current.filter((clientId) => allowed.has(clientId))
      return cleaned.length === current.length ? current : cleaned
    })
  }, [allBillingClientIds])

  useEffect(() => {
    setSummaryPage(1)
  }, [from, to, selectedBillingClientIds])

  useEffect(() => {
    if (!detailState.open || detailState.clientId == null || !billingClientFilterActive) return
    if (selectedBillingClientIdSet.has(detailState.clientId)) return
    setDetailState((current) => ({ ...current, open: false }))
  }, [billingClientFilterActive, detailState.clientId, detailState.open, selectedBillingClientIdSet])

  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(sortedSummaryRows.length / summaryPageSize))
    setSummaryPage((current) => Math.min(current, maxPage))
  }, [sortedSummaryRows.length, summaryPageSize])

  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(sortedDetailRows.length / detailPageSize))
    setDetailPage((current) => Math.min(current, maxPage))
  }, [sortedDetailRows.length, detailPageSize])

  useEffect(() => {
    setSummaryPage(1)
  }, [summarySort])

  useEffect(() => {
    setDetailPage(1)
  }, [detailSort])

  function handleSummarySort(key: string) {
    setSummaryPage(1)
    setSummarySort((current) => nextSortState(current, key))
  }

  function handleDetailSort(key: BillingDetailColumnId) {
    setDetailPage(1)
    setDetailSort((current) => nextSortState(current, key))
  }

  function setBillingClientFilter(nextIds: number[]) {
    const unique = [...new Set(nextIds)]
    const normalized =
      unique.length === allBillingClientIds.length && allBillingClientIds.length > 0
        ? []
        : unique
    setSelectedBillingClientIds(normalized)
    setSummaryPage(1)
  }

  function handleToggleBillingClient(clientId: number) {
    const currentSet = billingClientFilterActive
      ? new Set(selectedBillingClientIds)
      : new Set(allBillingClientIds)

    if (currentSet.has(clientId)) {
      currentSet.delete(clientId)
    } else {
      currentSet.add(clientId)
    }

    setBillingClientFilter(allBillingClientIds.filter((id) => currentSet.has(id)))
  }

  function handleSelectShipStationBillingClients() {
    setBillingClientFilter(
      availableBillingClients
        .filter((client) => client.inShipStation)
        .map((client) => client.clientId),
    )
  }

  function handleSelectAllBillingClients() {
    setBillingClientFilter([])
  }

  useEffect(() => {
    let active = true

    const loadConfigs = async () => {
      setConfigsLoading(true)

      try {
        const [nextConfigs, nextPackages] = await Promise.all([
          apiClient.fetchBillingConfigs(),
          apiClient.fetchPackages().catch(() => [] as PackageDto[]),
        ])

        if (!active) return

        setConfigs(nextConfigs)
        setConfigDrafts(createBillingConfigDraftMap(nextConfigs))
        setPackages(nextPackages)

        setSelectedPkgClientId((current) => {
          if (current && nextConfigs.some((config) => String(config.clientId) === current)) return current
          return nextConfigs.length > 0 ? String(nextConfigs[0]!.clientId) : ''
        })
      } catch (error) {
        if (!active) return
        toastContext?.addToast(error instanceof Error ? error.message : 'Failed to load billing config', 'error')
      } finally {
        if (active) setConfigsLoading(false)
      }
    }

    void loadConfigs()

    return () => {
      active = false
    }
  }, [toastContext])

  useEffect(() => {
    if (!selectedPkgClientId) return

    let active = true

    const loadPackagePrices = async () => {
      setPackagePricingLoading(true)
      setPackagePricingError(null)

      try {
        const rows = await apiClient.fetchBillingPackagePrices(Number(selectedPkgClientId))
        if (!active) return

        setSavedPackagePrices(rows)
        const nextRows = buildBillingPackagePriceRows(rows)
        setPackagePriceDrafts(Object.fromEntries(nextRows.map((row) => [row.packageId, (Number(row.charge) || 0).toFixed(2)])))
      } catch (error) {
        if (!active) return
        setSavedPackagePrices([])
        setPackagePriceDrafts({})
        setPackagePricingError(error instanceof Error ? error.message : 'Failed to load package prices')
      } finally {
        if (active) setPackagePricingLoading(false)
      }
    }

    void loadPackagePrices()

    return () => {
      active = false
    }
  }, [selectedPkgClientId])

  useEffect(() => {
    if (!from || !to) return

    let active = true

    const loadSummary = async () => {
      setSummaryLoading(true)
      setSummaryError(null)
      setShippingMarginLoading(true)
      setShippingMarginError(null)

      try {
        const [rows, marginAnalytics] = await Promise.all([
          apiClient.fetchBillingSummary(from, to, billingClientQueryIds),
          apiClient.fetchShippingMarginAnalytics(from, to, billingClientQueryIds),
        ])
        if (!active) return
        setSummaryRows(rows)
        setShippingMarginSummary(marginAnalytics?.summary ?? EMPTY_SHIPPING_MARGIN_SUMMARY)
        setShippingMarginCarriers(marginAnalytics?.carriers ?? [])
        setShippingMarginRows((marginAnalytics?.rows ?? []) as ShippingMarginRowDto[])
      } catch (error) {
        if (!active) return
        setSummaryRows([])
        setShippingMarginSummary(EMPTY_SHIPPING_MARGIN_SUMMARY)
        setShippingMarginCarriers([])
        setShippingMarginRows([])
        setSummaryError(error instanceof Error ? error.message : 'Error loading summary')
        setShippingMarginError(error instanceof Error ? error.message : 'Error loading shipping margin')
      } finally {
        if (active) {
          setSummaryLoading(false)
          setShippingMarginLoading(false)
        }
      }
    }

    void loadSummary()

    return () => {
      active = false
    }
  }, [from, to, billingClientQueryIds])

  useEffect(() => {
    if (!from || !to || !detailState.open || detailState.clientId == null) return

    let active = true
    const clientId = detailState.clientId
    const clientName = detailState.clientName

    setDetailPage(1)
    setDetailState((current) => (
      current.open && current.clientId === clientId
        ? { ...current, loading: true, rows: [], error: null }
        : current
    ))

    void apiClient.fetchBillingDetails(from, to, clientId)
      .then((rows) => {
        if (!active) return
        setDetailState({
          open: true,
          loading: false,
          clientId,
          clientName,
          rows,
          error: null,
        })
      })
      .catch((error) => {
        if (!active) return
        setDetailState({
          open: true,
          loading: false,
          clientId,
          clientName,
          rows: [],
          error: error instanceof Error ? error.message : 'Error loading details',
        })
      })

    return () => {
      active = false
    }
  // Reload the open detail table only when the operator changes the date filter.
  // Opening a new client still goes through handleLoadDetails to avoid duplicate fetches.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to])

  async function handleSaveConfig(clientId: number) {
    const draft = configDrafts[clientId]
    if (!draft) return

    try {
      await apiClient.updateBillingConfig(clientId, buildBillingConfigInput(draft))
      setConfigs((current) => current.map((config) => config.clientId === clientId ? {
        ...config,
        ...buildBillingConfigInput(draft),
      } : config))
      toastContext?.addToast('✅ Config saved', 'success')
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Failed to save config', 'error')
    }
  }

  // PS-220 (P4): opt a client in/out of the SHIPP house-account margin model. Immediate (not draft-
  // based) — the flag is written via a dedicated admin endpoint, not the drizzle billing-config save.
  async function handleToggleHouseAccount(clientId: number, enabled: boolean) {
    try {
      const result = await apiClient.setClientHouseAccount(clientId, enabled)
      const shippingMarginPolicyMode =
        result?.shippingMarginPolicyMode ?? (enabled ? 'next_best_customer_rate' : 'pass_through')
      setConfigs((current) => current.map((config) => config.clientId === clientId ? {
        ...config,
        houseAccountEnabled: enabled,
        shippingMarginPolicyMode,
      } : config))
      toastContext?.addToast(enabled ? '✅ Margin mode enabled' : 'Margin mode disabled', 'success')
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Failed to update margin mode', 'error')
    }
  }

  async function handleGenerateBilling(forceRegenerate = false) {
    if (!from || !to) {
      toastContext?.addToast('Select a date range first', 'error')
      return
    }

    if (forceRegenerate && regenerateRangeBlocked) {
      toastContext?.addToast('Regenerate Range is limited to 120 days. Use Update Billing for All/history.', 'error')
      return
    }

    // The Regenerate confirmation is now handled by the styled ConfirmModal (regenerateConfirmOpen),
    // which only calls this with forceRegenerate=true AFTER the operator confirms.

    setGenerateLoading(true)
    setGenerateStatus('')

    try {
      const targetClientIds = billingClientFilterActive
        ? selectedBillingClientIds.filter((clientId) => allBillingClientIds.includes(clientId))
        : []
      let generated = 0
      let alreadyCurrent = 0

      if (targetClientIds.length > 0) {
        const batchPlan: Array<{ clientId: number; clientName: string; batches: Array<{ from: string; to: string }> }> = []

        for (let index = 0; index < targetClientIds.length; index += 1) {
          const clientId = targetClientIds[index]!
          const clientName = availableBillingClients.find((client) => client.clientId === clientId)?.clientName ?? 'client'
          let batchFrom = from
          let batchTo = to

          if (!forceRegenerate) {
            setGenerateStatus(`Checking ${clientName} (${index + 1}/${targetClientIds.length})...`)
            const status = await apiClient.fetchBillingGenerationStatus(from, to, clientId)
            if (status?.upToDate) {
              alreadyCurrent += 1
              continue
            }
            batchFrom = isoToDateInput(status?.missingFrom) ?? from
            batchTo = isoToDateInput(status?.missingTo) ?? to
          }

          const batches = splitBillingRangeIntoBatches(batchFrom, batchTo)
          if (batches.length) batchPlan.push({ clientId, clientName, batches })
        }

        const totalSteps = batchPlan.reduce((sum, plan) => sum + plan.batches.length, 0)
        let step = 0
        for (const plan of batchPlan) {
          for (const batch of plan.batches) {
            step += 1
            setGenerateStatus(`${forceRegenerate ? 'Regenerating' : 'Updating'} ${plan.clientName}: ${batch.from} to ${batch.to} (${step}/${totalSteps})...`)
            const result = await apiClient.generateBilling(batch.from, batch.to, plan.clientId)
            generated += Number(result.generated ?? result.count ?? 0)
          }
        }
      } else {
        let batchFrom = from
        let batchTo = to

        if (!forceRegenerate) {
          setGenerateStatus('Checking billing freshness...')
          const status = await apiClient.fetchBillingGenerationStatus(from, to)
          if (status?.upToDate) {
            alreadyCurrent = 1
          } else {
            batchFrom = isoToDateInput(status?.missingFrom) ?? from
            batchTo = isoToDateInput(status?.missingTo) ?? to
          }
        }

        const batches = alreadyCurrent && !forceRegenerate ? [] : splitBillingRangeIntoBatches(batchFrom, batchTo)
        if (!alreadyCurrent && !batches.length) {
          toastContext?.addToast('Select a valid billing date range first', 'error')
          return
        }

        for (let index = 0; index < batches.length; index += 1) {
          const batch = batches[index]!
          setGenerateStatus(`${forceRegenerate ? 'Regenerating' : 'Updating'} all clients: ${batch.from} to ${batch.to} (${index + 1}/${batches.length})...`)
          const result = await apiClient.generateBilling(batch.from, batch.to)
          generated += Number(result.generated ?? result.count ?? 0)
        }
      }
      const result = { generated }
      if (generated > 0) {
        toastContext?.addToast(`Billing ${forceRegenerate ? 'regenerated' : 'updated'}: ${result.generated} line items`, 'success')
      } else {
        toastContext?.addToast('Billing is already up to date', 'success')
      }

      const [rows, marginAnalytics] = await Promise.all([
        apiClient.fetchBillingSummary(from, to, billingClientQueryIds),
        apiClient.fetchShippingMarginAnalytics(from, to, billingClientQueryIds),
      ])
      const rowsForStatus = targetClientIds.length > 0
        ? rows.filter((row) => targetClientIds.includes(Number(row.clientId)))
        : rows
      const totals = buildBillingSummaryTotals(rowsForStatus)
      setGenerateStatus(generated > 0 ? buildGenerateBillingStatus(result.generated, totals.fulfillmentFee) : `Billing already up to date - total ${formatBillingMoney(totals.fulfillmentFee)}`)
      setSummaryRows(rows)
      setShippingMarginSummary(marginAnalytics?.summary ?? EMPTY_SHIPPING_MARGIN_SUMMARY)
      setShippingMarginCarriers(marginAnalytics?.carriers ?? [])
      setShippingMarginRows((marginAnalytics?.rows ?? []) as ShippingMarginRowDto[])
      setShippingMarginError(null)
      setSummaryError(null)
      const detailTarget =
        detailState.open && detailState.clientId
          ? rowsForStatus.find((row) => row.clientId === detailState.clientId)
          : rowsForStatus.find((row) => (row.orderCount || 0) > 0 || (row.grandTotal || row.total || 0) > 0)
      if (detailTarget) {
        await handleLoadDetails(detailTarget.clientId, detailTarget.clientName)
      }
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Failed to update billing', 'error')
    } finally {
      setGenerateLoading(false)
    }
  }

  async function handleLoadDetails(clientId: number, clientName: string) {
    setDetailPage(1)
    setDetailState({
      open: true,
      loading: true,
      clientId,
      clientName,
      rows: [],
      error: null,
    })

    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        detailWrapRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      })
    }

    try {
      const rows = await apiClient.fetchBillingDetails(from, to, clientId)
      setDetailState({
        open: true,
        loading: false,
        clientId,
        clientName,
        rows,
        error: null,
      })
    } catch (error) {
      setDetailState({
        open: true,
        loading: false,
        clientId,
        clientName,
        rows: [],
        error: error instanceof Error ? error.message : 'Error loading details',
      })
    }
  }

  function handleOpenBillingEdit(row: BillingDetailDto) {
    if (!row.orderId || !detailState.clientId) return
    setBillingEditModal({
      row,
      draft: createBillingEditDraft(row),
      saving: false,
      error: null,
    })
    // Load the client's saved package prices so changing the Box Size can
    // auto-fill Box Cost from the same source billing uses.
    const clientId = Number(detailState.clientId)
    void apiClient.fetchBillingPackagePrices(clientId)
      .then((prices) => {
        const map: Record<number, number> = {}
        for (const p of prices ?? []) {
          const pid = Number(p.packageId ?? p.package_id)
          const price = Number(p.price ?? p.charge)
          if (Number.isFinite(pid) && Number.isFinite(price)) map[pid] = price
        }
        setBillingEditPackagePrices(map)
      })
      .catch(() => setBillingEditPackagePrices({}))
  }

  // PS — operator changed the Box Size: set the package + auto-fill Box Cost
  // from the client's saved price for that box (still manually overridable).
  function handleBillingEditPackageChange(value: string) {
    setBillingEditModal((current) => {
      if (!current) return current
      const pid = Number(value)
      const price = Number.isFinite(pid) ? billingEditPackagePrices[pid] : undefined
      return {
        ...current,
        draft: {
          ...current.draft,
          packageId: value,
          packageCost: price != null ? price.toFixed(2) : current.draft.packageCost,
        },
        error: null,
      }
    })
  }

  function handleBillingEditDraftChange(field: keyof BillingEditDraft, value: string) {
    setBillingEditModal((current) => current ? {
      ...current,
      draft: {
        ...current.draft,
        [field]: value,
      },
      error: null,
    } : current)
  }

  async function handleSaveBillingEdit() {
    if (!billingEditModal || !detailState.clientId) return
    const orderId = Number(billingEditModal.row.orderId)
    if (!Number.isFinite(orderId) || orderId <= 0) return

    setBillingEditModal((current) => current ? { ...current, saving: true, error: null } : current)
    try {
      await apiClient.updateBillingDetail(orderId, detailState.clientId, {
        pickPack: parseMoneyDraft(billingEditModal.draft.pickPack),
        additional: parseMoneyDraft(billingEditModal.draft.additional),
        packageCost: parseMoneyDraft(billingEditModal.draft.packageCost),
        shipping: parseMoneyDraft(billingEditModal.draft.shipping),
        // billing-line-only Box Size override (null = keep shipment box)
        packageId: billingEditModal.draft.packageId ? Number(billingEditModal.draft.packageId) : null,
      })

      const [rows] = await Promise.all([
        apiClient.fetchBillingDetails(from, to, detailState.clientId),
        apiClient.fetchBillingSummary(from, to, billingClientQueryIds).then((nextRows) => {
          setSummaryRows(nextRows)
          setSummaryError(null)
        }),
        apiClient.fetchShippingMarginAnalytics(from, to, billingClientQueryIds).then((marginAnalytics) => {
          setShippingMarginSummary(marginAnalytics?.summary ?? EMPTY_SHIPPING_MARGIN_SUMMARY)
          setShippingMarginCarriers(marginAnalytics?.carriers ?? [])
          setShippingMarginRows((marginAnalytics?.rows ?? []) as ShippingMarginRowDto[])
          setShippingMarginError(null)
        }),
      ])

      setDetailState((current) => ({
        ...current,
        rows,
        loading: false,
        error: null,
      }))
      setBillingEditModal(null)
      toastContext?.addToast('Billing detail saved', 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save billing detail'
      setBillingEditModal((current) => current ? { ...current, saving: false, error: message } : current)
      toastContext?.addToast(message, 'error')
    }
  }

  // PS-275: record the operator's $0-shipping review decision (waive the prep
  // fee, or keep it). Thin — the backend owns what may be waived and persists a
  // durable, reversible billing_fee_waivers row; we just POST the decision and
  // re-pull the details + summary so the screen reflects the new state. A
  // 'waived' decision needs an "Update Billing" regenerate to zero the prep
  // lines (the toast says so); the badge updates immediately from the refresh.
  async function handleZeroShippingReview(decision: 'waived' | 'not_waived') {
    if (!billingEditModal || !detailState.clientId) return
    const orderId = Number(billingEditModal.row.orderId)
    if (!Number.isFinite(orderId) || orderId <= 0) return

    setZeroShippingReviewSaving(true)
    try {
      await api.post(`/billing/zero-shipping-review/${orderId}`, {
        clientId: detailState.clientId,
        decision,
      })

      const [rows] = await Promise.all([
        apiClient.fetchBillingDetails(from, to, detailState.clientId),
        apiClient.fetchBillingSummary(from, to, billingClientQueryIds).then((nextRows) => {
          setSummaryRows(nextRows)
          setSummaryError(null)
        }),
        apiClient.fetchShippingMarginAnalytics(from, to, billingClientQueryIds).then((marginAnalytics) => {
          setShippingMarginSummary(marginAnalytics?.summary ?? EMPTY_SHIPPING_MARGIN_SUMMARY)
          setShippingMarginCarriers(marginAnalytics?.carriers ?? [])
          setShippingMarginRows((marginAnalytics?.rows ?? []) as ShippingMarginRowDto[])
          setShippingMarginError(null)
        }),
      ])

      setDetailState((current) => ({ ...current, rows, loading: false, error: null }))
      setBillingEditModal(null)
      toastContext?.addToast(
        decision === 'waived'
          ? 'Prep fee marked waived — run "Update Billing" for this range to zero the prep lines.'
          : 'Recorded: prep fee kept for this $0-shipping order.',
        'success',
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to record review'
      toastContext?.addToast(message, 'error')
    } finally {
      setZeroShippingReviewSaving(false)
    }
  }

  async function handleSavePackagePrices() {
    if (!selectedPkgClientId) {
      toastContext?.addToast('Select a client first', 'error')
      return
    }
    if (packagePricingRows.length === 0) {
      toastContext?.addToast('No package sizes found for this client yet.', 'info')
      return
    }

    try {
      await apiClient.saveBillingPackagePrices({
        clientId: Number(selectedPkgClientId),
        prices: packagePricingRows.map((row) => ({
          packageId: row.packageId,
          price: Number.parseFloat(packagePriceDrafts[row.packageId] ?? String(row.charge)) || 0,
        })),
      })

      setSavedPackagePrices(packagePricingRows.map((row) => ({
        packageId: row.packageId,
        price: Number.parseFloat(packagePriceDrafts[row.packageId] ?? String(row.charge)) || 0,
        // TODO PS-257: BillingPackagePriceDto.is_custom is typed boolean but the
        // billing pipeline round-trips it as a 0/1 int (DB convention) — cast keeps
        // the existing 0/1 runtime value byte-identical.
        is_custom: (row.isCustom ? 1 : 0) as unknown as boolean,
        name: row.name,
        length: row.length,
        width: row.width,
        height: row.height,
        dimsText: row.dimsText,
        ourCost: row.ourCost,
        usageCount: row.usageCount,
        usageSources: row.usageSources,
      })))
      toastContext?.addToast('Package prices saved ✓', 'success')
      // PS-068: a price change makes already-generated billing for this client
      // stale. "Update Billing" now detects price/config changes (price-aware
      // freshness) and rebuilds the affected range at the new price. Surface the
      // next step so the operator doesn't have to guess a regenerate is needed.
      toastContext?.addToast(
        'Existing billing for this client is now out of date — run "Update Billing" for the affected date range to apply the new prices.',
        'info',
      )
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Error saving prices', 'error')
    }
  }

  async function handleFetchRefRates() {
    setFetchRefRunning(true)
    setFetchRefStatus('Starting…')

    try {
      const result = await apiClient.fetchBillingReferenceRates()
      const nextStatus = buildFetchRefRatesStartText(result)
      setFetchRefStatus(nextStatus)

      if (result.total === 0) {
        setFetchRefRunning(false)
        return
      }

      if (fetchRefPollRef.current) clearInterval(fetchRefPollRef.current)

      fetchRefPollRef.current = setInterval(() => {
        void apiClient.fetchBillingReferenceRateStatus()
          .then((status) => {
            setFetchRefStatus(buildFetchRefRatesProgressText(status))

            if (!status.running) {
              if (fetchRefPollRef.current) clearInterval(fetchRefPollRef.current)
              fetchRefPollRef.current = null
              setFetchRefStatus(buildFetchRefRatesDoneText(status))
              setFetchRefRunning(false)
              toastContext?.addToast(`Ref rates fetched: ${status.done} rate combos`, 'success')
            }
          })
          .catch(() => {
            if (fetchRefPollRef.current) clearInterval(fetchRefPollRef.current)
            fetchRefPollRef.current = null
            setFetchRefStatus('Error — check console')
            setFetchRefRunning(false)
            toastContext?.addToast('Failed to start ref rate fetch', 'error')
          })
      }, 5000)
    } catch (error) {
      if (fetchRefPollRef.current) clearInterval(fetchRefPollRef.current)
      fetchRefPollRef.current = null
      setFetchRefStatus('Error — check console')
      setFetchRefRunning(false)
      toastContext?.addToast(error instanceof Error ? error.message : 'Failed to start ref rate fetch', 'error')
    }
  }

  async function handleBackfillRefRates() {
    setBackfillLoading(true)

    try {
      const result = await apiClient.backfillBillingReferenceRates({ from, to })
      toastContext?.addToast(buildBackfillRefRatesToast(result), 'success')
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Backfill failed', 'error')
    } finally {
      setBackfillLoading(false)
    }
  }

  function handleExportInvoice(clientId: number, clientName: string) {
    if (!from || !to) {
      toastContext?.addToast('⚠ Select a date range first', 'error')
      return
    }

    toastContext?.addToast(`📄 Opening invoice for ${clientName || 'client'}…`, 'success')
    void apiClient.openBillingInvoice(clientId, from, to).then((ok) => {
      if (!ok) {
        toastContext?.addToast('Failed to open invoice — check console', 'error')
      }
    })
  }

  // PS-208: same invoice, Excel download. Passes the picked days verbatim —
  // the backend owns all calendar-day semantics.
  function handleExportInvoiceXlsx(clientId: number, clientName: string) {
    if (!from || !to) {
      toastContext?.addToast('⚠ Select a date range first', 'error')
      return
    }

    toastContext?.addToast(`📊 Downloading Excel invoice for ${clientName || 'client'}…`, 'success')
    void apiClient.openBillingInvoiceXlsx(clientId, from, to).then((ok) => {
      if (!ok) {
        toastContext?.addToast('Failed to download Excel invoice — check console', 'error')
      }
    })
  }

  // PS-468: same invoice, CSV download. Passes the picked days verbatim — the
  // backend owns all calendar-day semantics and the column derivation.
  function handleExportInvoiceCsv(clientId: number, clientName: string) {
    if (!from || !to) {
      toastContext?.addToast('⚠ Select a date range first', 'error')
      return
    }

    toastContext?.addToast(`📑 Downloading CSV invoice for ${clientName || 'client'}…`, 'success')
    void apiClient.openBillingInvoiceCsv(clientId, from, to).then((ok) => {
      if (!ok) {
        toastContext?.addToast('Failed to download CSV invoice — check console', 'error')
      }
    })
  }

  const billingEditMetrics = billingEditModal ? computeBillingDetailMetrics(billingEditModal.row) : null
  const billingEditDraftTotal = billingEditModal
    ? parseMoneyDraft(billingEditModal.draft.pickPack)
      + parseMoneyDraft(billingEditModal.draft.additional)
      + parseMoneyDraft(billingEditModal.draft.packageCost)
      + parseMoneyDraft(billingEditModal.draft.shipping)
    : 0
  const billingEditDraftMargin = billingEditModal && billingEditMetrics
    ? parseMoneyDraft(billingEditModal.draft.shipping) - billingEditMetrics.ourCost
    : 0

  return (
    <div id="view-billing" className="view-content !p-5 !overflow-y-auto flex flex-col">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        className="order-0 flex items-center gap-3 mb-5"
      >
        <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-600 flex items-center justify-center shadow-md ring-1 ring-emerald-400/20">
          <Receipt size={20} strokeWidth={2.25} className="text-white" />
        </div>
        <div>
          <h2 className="text-[16px] font-extrabold text-ink font-display tracking-tight">Billing Dashboard</h2>
          <p className="text-tiny text-ink-3 mt-0.5">Per-client billing config, package pricing and invoice history</p>
        </div>
      </motion.div>

      <div className="order-1 rounded-xl bg-surface ring-1 ring-line p-4 mb-[18px]">
        <div className="flex items-center gap-2 mb-3">
          <SlidersHorizontal size={16} strokeWidth={2.25} className="text-ink-3" aria-hidden="true" />
          <h3 className="text-[13px] font-semibold text-ink">Generate &amp; summary</h3>
        </div>

        <BillingFilters
          activePreset={activePreset}
          from={from}
          to={to}
          generateLoading={generateLoading}
          regenerateRangeBlocked={regenerateRangeBlocked}
          backfillLoading={backfillLoading}
          fetchRefRunning={fetchRefRunning}
          fetchRefStatus={fetchRefStatus}
          generateStatus={generateStatus}
          onSelectPreset={(preset) => {
            const range = getBillingPresetRange(preset)
            setActivePreset(preset)
            setFrom(range.from)
            setTo(range.to)
          }}
          onFromChange={(value) => {
            setActivePreset(null)
            setFrom(value)
          }}
          onToChange={(value) => {
            setActivePreset(null)
            setTo(value)
          }}
          onGenerate={() => void handleGenerateBilling()}
          onRegenerate={() => setRegenerateConfirmOpen(true)}
          onBackfillRefRates={() => void handleBackfillRefRates()}
          onFetchRefRates={() => void handleFetchRefRates()}
        />

        <BillingClientFilterPanel
          clientFilterOpen={clientFilterOpen}
          selectedBillingClientCount={selectedBillingClientCount}
          availableBillingClients={availableBillingClients as { clientId: number; clientName: string; inShipStation: boolean }[]}
          summaryRowsLength={summaryRows.length}
          billingClientFilterActive={billingClientFilterActive}
          excludedBillingClientNames={excludedBillingClientNames as string[]}
          selectedBillingClientIdSet={selectedBillingClientIdSet}
          missingShipStationClientNames={missingShipStationClientNames}
          onToggleAdvanced={() => setClientFilterOpen((open) => !open)}
          onSelectShipStation={handleSelectShipStationBillingClients}
          onSelectAll={handleSelectAllBillingClients}
          onToggleClient={handleToggleBillingClient}
        />

        <div
          aria-label="Shipping margin analytics"
          className="grid gap-2.5 my-3.5"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}
        >
          {[
            ['Actual shipping', formatBillingMoney(shippingMarginSummary.actualShippingTotal, { dashIfZero: true })],
            ['Billable shipping', formatBillingMoney(shippingMarginSummary.billableShippingTotal, { dashIfZero: true })],
            ['Margin', formatBillingMoney(shippingMarginSummary.marginTotal, { dashIfZero: true })],
            ['Margin %', shippingMarginSummary.marginPct == null ? '—' : `${shippingMarginSummary.marginPct.toFixed(2)}%`],
            ['Rows', `${shippingMarginSummary.marginRowCount}/${shippingMarginSummary.rowCount}`],
            ['State', `${shippingMarginSummary.frozenCount} frozen · ${shippingMarginSummary.projectedCount} projected`],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg bg-surface-2 px-3 py-2.5 min-w-0">
              <div className="text-[10.5px] text-ink-3 truncate">{label}</div>
              <div
                className="text-[15px] font-bold tabular-nums truncate"
                style={label === 'Margin' ? { color: marginColor(shippingMarginSummary.marginTotal) } : undefined}
              >
                {value}
              </div>
            </div>
          ))}
        </div>
        {(shippingMarginLoading || shippingMarginError || shippingMarginSummary.missingAnyProofCount > 0) ? (
          <div className="text-[11px] mb-3" style={{ color: shippingMarginError ? 'var(--red)' : 'var(--text3)' }}>
            {shippingMarginLoading
              ? 'Loading shipping margin…'
              : shippingMarginError
                ? shippingMarginError
                : `${shippingMarginSummary.missingAnyProofCount} shipment(s) missing proof (${shippingMarginSummary.missingBillableCount} billable, ${shippingMarginSummary.missingActualCostCount} actual)`}
          </div>
        ) : null}
        <div className="billing-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, margin: '0 0 14px' }}>
          {/* PS-155: Client Billing Config table extracted to <BillingConfigTable />.
              The config DRAFT state (configDrafts) + setter and the Save handler
              (handleSaveConfig → buildBillingConfigInput → updateBillingConfig) stay here. */}
          <BillingConfigTable
            configs={configs}
            configsLoading={configsLoading}
            configDrafts={configDrafts}
            setConfigDrafts={setConfigDrafts}
            onSaveConfig={handleSaveConfig}
            onToggleHouseAccount={handleToggleHouseAccount}
          />

          {/* PS-155: Package Pricing card extracted to <BillingPackagePricingTable />.
              The price DRAFT state (packagePriceDrafts) + setter, selected-client state,
              the PURE-built packagePricingRows, and the Save handler stay here. */}
          <BillingPackagePricingTable
            configs={configs}
            selectedPkgClientId={selectedPkgClientId}
            setSelectedPkgClientId={setSelectedPkgClientId}
            packagePricingRows={packagePricingRows}
            packagePriceDrafts={packagePriceDrafts}
            setPackagePriceDrafts={setPackagePriceDrafts}
            packagePricingLoading={packagePricingLoading}
            packagePricingError={packagePricingError}
            onSavePackagePrices={handleSavePackagePrices}
          />
        </div>
        {/* PS-296 (FE): carrier/account margin breakdown — consumes the backend
            analytics.carriers[] rollup. Now on the shared <Table> with pagination
            (BillingCarrierMarginTable); renders nothing when there are no carrier rows. */}
        <BillingCarrierMarginTable carriers={shippingMarginCarriers} />
        {/* PS-296 (FE, req6): per-shipment reconciliation drilldown — consumes the backend
            analytics.rows[] (previously discarded). Collapsed by default; capped with a
            visible "showing X of N" note (no silent truncation). Display-only. */}
        {shippingMarginRows.length > 0 ? (
          <div style={{ margin: '0 0 14px' }}>
            <button
              type="button"
              onClick={() => setShippingMarginDrilldownOpen((open) => !open)}
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.04em' }}
            >
              {shippingMarginDrilldownOpen ? '▾' : '▸'} Per-order reconciliation ({shippingMarginRows.length})
            </button>
            {shippingMarginDrilldownOpen ? (
              <div style={{ overflowX: 'auto', marginTop: 6 }}>
                <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse', whiteSpace: 'nowrap' }}>
                  <thead>
                    <tr style={{ color: 'var(--text3)', textAlign: 'right', borderBottom: '1px solid var(--border)' }}>
                      <th style={{ textAlign: 'left', padding: '3px 8px 3px 0' }}>Order #</th>
                      <th style={{ textAlign: 'left', padding: '3px 8px' }}>Shipment</th>
                      <th style={{ textAlign: 'left', padding: '3px 8px' }}>Ship date</th>
                      <th style={{ textAlign: 'left', padding: '3px 8px' }}>Carrier / account</th>
                      <th style={{ padding: '3px 8px' }}>Cost</th>
                      <th style={{ padding: '3px 8px' }}>Billable</th>
                      <th style={{ padding: '3px 8px' }}>Margin</th>
                      <th style={{ padding: '3px 8px' }}>%</th>
                      <th style={{ textAlign: 'left', padding: '3px 0 3px 8px' }}>Issues</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shippingMarginRows.slice(0, SHIPPING_MARGIN_DRILLDOWN_LIMIT).map((row, index) => (
                      <tr key={`${row.shipmentId ?? ''}|${row.orderId ?? ''}|${index}`} style={{ textAlign: 'right', borderBottom: '1px solid var(--border-subtle, rgba(0,0,0,0.05))' }}>
                        <td style={{ textAlign: 'left', padding: '3px 8px 3px 0', fontWeight: 600 }}>{row.orderNumber ?? '—'}</td>
                        <td style={{ textAlign: 'left', padding: '3px 8px', color: 'var(--text3)' }}>{row.shipmentId ?? '—'}</td>
                        <td style={{ textAlign: 'left', padding: '3px 8px', color: 'var(--text2)' }}>{row.shipDate ? row.shipDate.slice(0, 10) : '—'}</td>
                        <td style={{ textAlign: 'left', padding: '3px 8px' }}>{row.carrierCode ?? '—'}{row.serviceCode ? ` · ${row.serviceCode}` : ''}{(row.accountDisplayName ?? row.providerAccountNickname) ? ` (${row.accountDisplayName ?? row.providerAccountNickname})` : ''}</td>
                        <td style={{ padding: '3px 8px' }}>{row.actualShippingCost == null ? '—' : formatBillingMoney(row.actualShippingCost)}</td>
                        <td style={{ padding: '3px 8px' }}>{row.billableShippingAmount == null ? '—' : formatBillingMoney(row.billableShippingAmount)}</td>
                        <td style={{ padding: '3px 8px', fontWeight: 700, color: row.marginAmount == null ? 'var(--text3)' : marginColor(row.marginAmount) }}>{row.marginAmount == null ? '—' : formatBillingMoney(row.marginAmount)}</td>
                        <td style={{ padding: '3px 8px' }}>{row.marginPct == null ? '—' : `${row.marginPct.toFixed(1)}%`}</td>
                        <td style={{ textAlign: 'left', padding: '3px 0 3px 8px', color: (row.missingProofReasons ?? []).length > 0 ? 'var(--red)' : 'var(--text3)' }}>{(row.missingProofReasons ?? []).length > 0 ? (row.missingProofReasons ?? []).join(', ') : (row.state ?? '')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {shippingMarginRows.length > SHIPPING_MARGIN_DRILLDOWN_LIMIT ? (
                  <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 4 }}>
                    Showing first {SHIPPING_MARGIN_DRILLDOWN_LIMIT} of {shippingMarginRows.length} shipments — narrow the date range to see the rest.
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Summary table — migrated 2026-05-12 to the reusable <Table>
            primitive (components/ui/Table.tsx). Operator-controlled
            sort / column widths / column order / column visibility +
            pagination, all persisted to 'billing-summary-table:*' in
            localStorage. The Total row is rendered via Table's
            footerRow API so it stays pinned to the bottom of tbody
            and shows the sum of the FULL dataset (not just the page). */}
        <BillingSummaryTable
          sortedSummaryRows={sortedSummaryRows}
          summaryLoading={summaryLoading}
          summaryError={summaryError}
          summaryTotals={summaryTotals}
          detailState={detailState}
          handleLoadDetails={handleLoadDetails}
          handleExportInvoice={handleExportInvoice}
          handleExportInvoiceXlsx={handleExportInvoiceXlsx}
          handleExportInvoiceCsv={handleExportInvoiceCsv}
        />

        {detailState.open ? (
          <div ref={detailWrapRef} style={{ display: 'block', marginTop: 16, borderTop: '2px solid var(--border)', paddingTop: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <h3 style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', margin: 0 }}>Line Items — {detailState.clientName}</h3>
              <button className="btn btn-ghost btn-xs" type="button" onClick={() => setDetailState((current) => ({ ...current, open: false }))}>✕ Close</button>
              <BillingLineItemWarningSummary rows={sortedDetailRows} onOpenWarningRow={handleOpenBillingEdit} />
              {/* PS-275: surface HOW MANY of the currently-rendered line items
                  need the $0-shipping prep-fee review, so operators don't have
                  to open each Edit modal to find them. Count derives from the
                  SAME sortedDetailRows the table maps over (no refetch). Renders
                  nothing when zero — additive + default-inert. */}
              {(() => {
                const needReview = sortedDetailRows.filter((row) => row.shippingZeroNeedsReview === true && row.feeWaiverDecision == null).length
                return needReview > 0 ? (
                  <span
                    role="status"
                    title="Rows with a recorded $0.00 shipping cost awaiting a prep-fee decision (waive or keep). Use the amber Review button on the row."
                    style={{
                      fontSize: 10.5,
                      fontWeight: 800,
                      color: '#b45309',
                      background: '#fef3c7',
                      border: '1px solid #fde68a',
                      borderRadius: 6,
                      padding: '2px 8px',
                      lineHeight: 1.5,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {needReview} $0-shipping need review
                  </span>
                ) : null
              })()}
            </div>

            <BillingDetailClientStrip
              sortedSummaryRows={sortedSummaryRows}
              detailState={detailState}
              selectedDetailSummary={selectedDetailSummary}
              onLoadDetails={handleLoadDetails as unknown as (clientId: number, clientName: string | null | undefined) => void}
            />

            {/* Detail table — migrated 2026-05-12 to the reusable
                <Table> primitive. Sort, widths, column order,
                column visibility, AND pagination all live inside
                Table under 'billing-detail-table:*'. The legacy
                column-toggle pill bar above the table is removed —
                operators use Table's "Columns ▾" picker instead
                (top-right of the table toolbar). Totals row goes
                through Table's footerRow API. */}
            {/* PS-155: detail-table JSX extracted to <BillingDetailTable /> (behavior-preserving).
                It CALLS computeBillingDetailMetrics(row) (pure — byte-identical output) and imports
                BILLING_DETAIL_COLUMNS / formatBillingMoney from ./billing-parity. The rows array,
                sort state, totals, and async handlers stay here and are passed as props. */}
            <BillingDetailTable
              detailState={detailState}
              detailPanelState={detailPanelState}
              selectedSummaryOrders={selectedSummaryOrders}
              selectedSummaryTotal={selectedSummaryTotal}
              sortedDetailRows={sortedDetailRows}
              detailTotals={detailTotals as { pickPack: number; additional: number; packageCost: number; shipping: number; total: number; margin: number }}
              onOpenBillingEdit={handleOpenBillingEdit}
              onOpenOrderDetail={setOrderDetailModalId}
            />
          </div>
        ) : null}
      </div>
      {billingEditModal ? (
        <div className="billing-edit-backdrop" role="presentation" onMouseDown={() => !billingEditModal.saving && setBillingEditModal(null)}>
          <div className="billing-edit-modal" role="dialog" aria-modal="true" aria-label="Edit billing detail" onMouseDown={(event) => event.stopPropagation()}>
            <div className="billing-edit-head">
              <div>
                <h3>Edit Billing Detail</h3>
                <p>{billingEditModal.row.orderNumber || `Order ${billingEditModal.row.orderId}`}</p>
              </div>
              <button className="btn btn-ghost btn-xs" type="button" disabled={billingEditModal.saving} onClick={() => setBillingEditModal(null)}>
                <X size={14} aria-hidden="true" />
              </button>
            </div>

            <div className="billing-edit-readonly-grid">
              <div><span>Order #</span><strong>{billingEditModal.row.orderNumber || '—'}</strong></div>
              <div><span>Ship Date</span><strong>{formatBillingShipDate(billingEditModal.row.shipDate)}</strong></div>
              <div><span>Carrier</span><strong>{billingEditModal.row.carrierNickname || billingEditModal.row.providerAccountNickname || billingEditModal.row.carrierCode || '—'}</strong></div>
              <div><span>Qty</span><strong>{billingEditModal.row.totalQty || billingEditModal.row.qty || 0}</strong></div>
              <div><span>Item Name</span><strong>{billingEditModal.row.itemNames || billingEditModal.row.description || '—'}</strong></div>
              <div><span>SKU</span><strong>{billingEditModal.row.itemSkus || '—'}</strong></div>
              <div>
                <span>Box Size</span>
                <select
                  className="ship-select billing-edit-box-select"
                  style={{ width: '100%', fontSize: 12, fontWeight: 600 }}
                  value={billingEditModal.draft.packageId}
                  disabled={billingEditModal.saving}
                  onChange={(event) => handleBillingEditPackageChange(event.target.value)}
                >
                  <option value="">{billingEditModal.row.packageName ? `${billingEditModal.row.packageName} (shipment box)` : '— (shipment box)'}</option>
                  {packages.map((pkg) => {
                    const id = String(pkg.packageId ?? pkg.id)
                    return <option key={id} value={id}>{pkg.name || id}</option>
                  })}
                </select>
              </div>
              <div><span>Selected Rate</span><strong>{formatBillingMoney(billingEditModal.row.selectedRateCost ?? billingEditModal.row.selected_rate_cost, { dashIfZero: true })}</strong></div>
              <div><span>UPS SS</span><strong>{formatBillingMoney(billingEditModal.row.ref_ups_rate, { dashIfZero: true })}</strong></div>
              <div><span>USPS SS</span><strong>{formatBillingMoney(billingEditModal.row.ref_usps_rate, { dashIfZero: true })}</strong></div>
            </div>

            {hasBillingNoBoxCostAlert(billingEditModal.row) ? (
              <BillingNoBoxCostPreview
                rows={billingNoBoxCostRows}
                activeRow={billingEditModal.row}
                onOpenBillingEdit={handleOpenBillingEdit}
              />
            ) : null}

            {/* PS-207: backend box-review flag — the shipped box could not be
                resolved (or selected box ≠ shipment dims). Picking a Box Size
                and/or typing a Box Cost below resolves it: the save persists a
                billing_box_resolutions directive that survives regeneration. */}
            {billingEditModal.row.packageCostNeedsReview ? (
              <div
                role="alert"
                style={{
                  margin: '8px 0',
                  padding: '8px 12px',
                  border: '1px solid #fde68a',
                  borderRadius: 8,
                  background: 'rgba(245, 158, 11, 0.10)',
                  fontSize: 11.5,
                  color: 'var(--text)',
                }}
              >
                <strong style={{ color: '#b45309' }}>Box needs review:</strong>{' '}
                {billingEditModal.row.packageCostReviewReason || 'the shipped box could not be matched to a known package.'}
                {' '}Pick the correct Box Size (or set a Box Cost) and Save — the decision persists across billing regeneration.
                {/* PS-311b: sweep this SAME unmatched box size across a date range you pick — set the
                    cost once and apply it to every needs-review bill of this box for THIS client
                    (preview-first, gated). Available for any needs-review box (no package pick needed,
                    since unmatched custom boxes have no package to choose). */}
                {detailState.clientId != null ? (
                  <div style={{ marginTop: 8 }}>
                    <button
                      data-box-review-sweep-trigger
                      className="btn btn-secondary btn-xs"
                      type="button"
                      onClick={() => setBoxReviewSweepOpen(true)}
                    >
                      Set this box cost across a date range…
                    </button>
                  </div>
                ) : null}
                {/* PS-311: once a real box is chosen from the dropdown, re-price every order ALREADY
                    billed for that resolved box in the current client + date range. */}
                {billingEditModal.draft.packageId && detailState.clientId != null ? (
                  <div style={{ marginTop: 8 }}>
                    <button
                      data-bulk-box-cost-trigger
                      className="btn btn-secondary btn-xs"
                      type="button"
                      onClick={() => setBulkBoxCostOpen(true)}
                    >
                      Re-price the chosen box across {from} → {to}…
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* PS-275: $0-shipping review. The backend flags a billed shipping
                line of EXACTLY $0.00 (shippingZeroNeedsReview) — a real recorded
                zero-dollar label, distinct from a missing cost. The operator
                decides: WAIVE the prep fee (the order shipped free, so comp the
                prep), or KEEP it. The decision is durable + reversible; a waive
                takes effect on the next "Update Billing". Additive, behind the
                backend flag — canary; needs DJ eyeball. */}
            {billingEditModal.row.shippingZeroNeedsReview && billingEditModal.row.feeWaiverDecision == null ? (
              <div
                role="group"
                aria-label="Review $0 shipping"
                style={{
                  margin: '8px 0',
                  padding: '8px 12px',
                  border: '1px solid #bfdbfe',
                  borderRadius: 8,
                  background: 'rgba(59, 130, 246, 0.08)',
                  fontSize: 11.5,
                  color: 'var(--text)',
                }}
              >
                <div style={{ marginBottom: 6 }}>
                  <strong style={{ color: '#1d4ed8' }}>$0 shipping — review:</strong>{' '}
                  this order shipped at a recorded cost of exactly $0.00 — often the customer handled
                  shipping themselves. If they did, waive the DR PREPPER prep/fulfillment fees.
                  {billingEditModal.row.feeWaived ? ' Prep fee is currently WAIVED.' : ''}
                </div>
                {/* PS-275 (item 1): enumerate exactly what a waive zeroes — ONLY the prep/fulfillment
                    fee lines, for THIS client — so the operator decides safely. */}
                <div style={{ marginBottom: 8, fontSize: 11, opacity: 0.85 }}>
                  Client <strong>{detailState.clientName || '—'}</strong> — waiving sets these to $0:{' '}
                  Pick &amp; Pack <strong>{formatBillingMoney(Number(billingEditModal.draft.pickPack || 0))}</strong>
                  {' '}+ Add&apos;l Units <strong>{formatBillingMoney(Number(billingEditModal.draft.additional || 0))}</strong>
                  {' '}= <strong>{formatBillingMoney(Number(billingEditModal.draft.pickPack || 0) + Number(billingEditModal.draft.additional || 0))}</strong>
                  {' '}prep. Box, storage, shipping label, product &amp; marketplace fees are NOT touched.
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="btn btn-secondary btn-xs"
                    type="button"
                    disabled={zeroShippingReviewSaving}
                    onClick={() => void handleZeroShippingReview('waived')}
                  >
                    {zeroShippingReviewSaving ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : null}
                    Customer handled shipping — set prep fees to $0
                  </button>
                  <button
                    className="btn btn-ghost btn-xs"
                    type="button"
                    disabled={zeroShippingReviewSaving}
                    onClick={() => void handleZeroShippingReview('not_waived')}
                  >
                    DR PREPPER handled — keep fees
                  </button>
                </div>
              </div>
            ) : billingEditModal.row.feeWaived ? (
              // PS-275 (item 3): a recorded waive only takes effect on the next "Update Billing"
              // regenerate (which re-applies applyPrepFeeWaiver). Until then the prep lines still bill,
              // so DISTINGUISH "pending" (decision saved, prep not yet zeroed) from "applied" — never let
              // the operator believe the fee is already off the invoice. Pending = feeWaived AND the
              // row's prep total is still > 0.
              (Number(billingEditModal.draft.pickPack || 0) + Number(billingEditModal.draft.additional || 0)) > 0 ? (
                <div
                  role="status"
                  style={{
                    margin: '8px 0', padding: '6px 12px',
                    border: '1px solid #fde68a', borderRadius: 8,
                    background: 'rgba(245, 158, 11, 0.10)', fontSize: 11.5, color: '#92400e',
                  }}
                >
                  <strong>Prep fee waived — pending.</strong> The decision is saved; run{' '}
                  <strong>Update Billing</strong> for this range to zero the prep lines on the invoice. (Reversible.)
                </div>
              ) : (
                <div
                  role="status"
                  style={{
                    margin: '8px 0', padding: '6px 12px',
                    border: '1px solid #bbf7d0', borderRadius: 8,
                    background: 'rgba(34, 197, 94, 0.08)', fontSize: 11.5, color: '#166534',
                  }}
                >
                  <strong>Prep fee waived — applied</strong> ($0 prep). Reversible via Update Billing.
                </div>
              )
            ) : billingEditModal.row.feeWaiverDecision === 'not_waived' ? (
              <div
                role="status"
                style={{
                  margin: '8px 0',
                  padding: '6px 12px',
                  border: '1px solid #bfdbfe',
                  borderRadius: 8,
                  background: 'rgba(59, 130, 246, 0.08)',
                  fontSize: 11.5,
                  color: '#1d4ed8',
                }}
              >
                <strong>$0 shipping reviewed — prep fee kept.</strong> Reversible via the $0-shipping review action if this order should be waived later.
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button
                    className="btn btn-secondary btn-xs"
                    type="button"
                    disabled={zeroShippingReviewSaving}
                    onClick={() => void handleZeroShippingReview('waived')}
                  >
                    {zeroShippingReviewSaving ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : null}
                    Change to waive prep fees
                  </button>
                </div>
              </div>
            ) : null}

            <div className="billing-edit-money-grid">
              <label>
                <span>Pick & Pack</span>
                <input type="number" min="0" step="0.01" value={billingEditModal.draft.pickPack} onChange={(event) => handleBillingEditDraftChange('pickPack', event.target.value)} />
              </label>
              <label>
                <span>Addl Units</span>
                <input type="number" min="0" step="0.01" value={billingEditModal.draft.additional} onChange={(event) => handleBillingEditDraftChange('additional', event.target.value)} />
              </label>
              <label>
                <span>Box Cost</span>
                <input type="number" min="0" step="0.01" value={billingEditModal.draft.packageCost} onChange={(event) => handleBillingEditDraftChange('packageCost', event.target.value)} />
              </label>
              <label>
                <span>Shipping</span>
                <input type="number" min="0" step="0.01" value={billingEditModal.draft.shipping} onChange={(event) => handleBillingEditDraftChange('shipping', event.target.value)} />
              </label>
            </div>

            <div className="billing-edit-total-row">
              <div><span>Total</span><strong>{formatBillingMoney(billingEditDraftTotal)}</strong></div>
              <div><span>Shipping Margin</span><strong style={{ color: marginColor(billingEditDraftMargin) }}>{billingEditDraftMargin > 0 ? '+' : ''}${billingEditDraftMargin.toFixed(2)}</strong></div>
            </div>

            {billingEditModal.error ? <div className="billing-edit-error">{billingEditModal.error}</div> : null}

            <div className="billing-edit-actions">
              <button className="btn btn-secondary btn-sm" type="button" disabled={billingEditModal.saving} onClick={() => setBillingEditModal(null)}>Cancel</button>
              <button className="btn btn-primary btn-sm" type="button" disabled={billingEditModal.saving} onClick={() => void handleSaveBillingEdit()}>
                {billingEditModal.saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* PS-311: bulk box-cost modal — opened from the per-order edit modal's box-review action.
          Previews + applies the reviewed box cost across the whole client + date-range scope. */}
      {bulkBoxCostOpen && billingEditModal && billingEditModal.draft.packageId && detailState.clientId != null ? (
        <BulkBoxCostModal
          clientId={detailState.clientId}
          clientName={detailState.clientName || `Client ${detailState.clientId}`}
          dateFrom={from}
          dateTo={to}
          packageId={Number(billingEditModal.draft.packageId)}
          packageLabel={
            packages.find((pkg) => pkg.packageId === Number(billingEditModal.draft.packageId))?.name ??
            `Box #${billingEditModal.draft.packageId}`
          }
          onClose={() => setBulkBoxCostOpen(false)}
          onApplied={() => {
            // Re-fetch the summary so the bulk-re-priced box costs show immediately.
            void apiClient.fetchBillingSummary(from, to, billingClientQueryIds).then((rows) => setSummaryRows(rows)).catch(() => {})
          }}
        />
      ) : null}

      {/* PS-311b: the needs-review box-cost sweep — a date range picker + same-box-size apply across
          the current client. Available for any needs-review row (no package pick needed). */}
      {boxReviewSweepOpen && billingEditModal && billingEditModal.row.orderId != null && detailState.clientId != null ? (
        <BoxReviewSweepModal
          clientId={detailState.clientId}
          clientName={detailState.clientName || `Client ${detailState.clientId}`}
          sourceOrderId={Number(billingEditModal.row.orderId)}
          boxLabel={(() => {
            const reason = billingEditModal.row.packageCostReviewReason || ''
            const m = reason.match(/\(([^)]+)\)/)
            return m?.[1] ?? (reason || 'this box')
          })()}
          initialFrom={from}
          initialTo={to}
          onClose={() => setBoxReviewSweepOpen(false)}
          onApplied={() => {
            // Refresh the summary and reload the open detail grid so the swept (now resolved) box
            // costs show immediately.
            void apiClient.fetchBillingSummary(from, to, billingClientQueryIds).then((rows) => setSummaryRows(rows)).catch(() => {})
            if (detailState.clientId != null) void handleLoadDetails(detailState.clientId, detailState.clientName || '')
          }}
        />
      ) : null}

      {/* Regenerate Range confirmation — styled modal replacing the native browser confirm(). */}
      <ConfirmModal
        open={regenerateConfirmOpen}
        title="Regenerate billing range?"
        description={
          <>
            Rebuild billing for <strong>{selectedBillingRangeDays} day(s)</strong> ({from} → {to}). This recreates the
            line items for the selected range and is slower than Update Billing.
          </>
        }
        confirmLabel="Regenerate"
        cancelLabel="Cancel"
        tone="info"
        onConfirm={() => {
          setRegenerateConfirmOpen(false)
          void handleGenerateBilling(true)
        }}
        onCancel={() => setRegenerateConfirmOpen(false)}
      />

      {orderDetailModalId != null ? (
        <Suspense fallback={null}>
          <OrderDetailDrawer
            orderId={orderDetailModalId}
            presentation="modal"
            closeLabel="Close"
            closeTitle="Close order details"
            onClose={() => setOrderDetailModalId(null)}
          />
        </Suspense>
      ) : null}
    </div>
  )
}
