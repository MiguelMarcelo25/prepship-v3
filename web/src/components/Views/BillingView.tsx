import { lazy, Suspense, useContext, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from 'react'
import { ListFilter, Loader2, Pencil, SlidersHorizontal } from 'lucide-react'
import { apiClient } from '../../api/client'
// PS-275: the new $0-shipping prep-fee review POST has no apiClient wrapper
// (that adapter is out of this ticket's scope); call the shared low-level
// client directly. Additive, behind the backend shippingZeroNeedsReview flag.
import { api } from '../../lib/api'
import { ToastContext } from '../../contexts/ToastContext'
import type { PackageDto } from '../../types/api'
import {
  BILLING_DETAIL_COLUMNS,
  billingDetailQtySortValue,
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
import BillingStorageProofModal from './BillingStorageProofModal'
import { BillingLineItemsHeader } from './BillingLineItemsHeader'
import { hasBillingNoBoxCostAlert } from './BillingNoBoxCostAction'
import { BillingEditDetailModal, type BillingEditModalViewState } from './BillingEditDetailModal'
import { BillingDashboardHeader } from './BillingDashboardHeader'
import {
  BillingShippingMarginSummary,
  type BillingShippingMarginSummaryDto as ShippingMarginSummaryDto,
} from './BillingShippingMarginSummary'
import {
  BillingShippingMarginReconciliation,
  type BillingShippingMarginReconciliationRow as ShippingMarginRowDto,
} from './BillingShippingMarginReconciliation'
import {
  billingEditDraftForRow,
  clearBillingEditDraft,
  createBillingEditDraft,
  rememberBillingEditDraft,
  type BillingEditDraft,
  type BillingEditDraftCache,
} from './billing-edit-draft-cache'
// PS-155: Client Billing Config + Package Pricing tables extracted (behavior-preserving; the
// config/price DRAFT state + setters and the Save handlers stay here and are passed as props).
import { BillingConfigTable } from './BillingConfigTable'
import { BillingCarrierMarginTable } from './BillingCarrierMarginTable'
import { ConfirmModal } from '../ui/ConfirmModal'
import { BillingPackagePricingTable } from './BillingPackagePricingTable'
import { BillingDetailModalStack } from './BillingDetailModalStack'
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

type BillingEditModalState = BillingEditModalViewState | null

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
    case 'totalQty': return billingDetailQtySortValue(row)
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

function parseMoneyDraft(value: string) {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
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
  const billingUpdateRunningRef = useRef(false)

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
  const [hugrabShippingFloorOpen, setHugrabShippingFloorOpen] = useState(false)
  const [detailColumnsAnchorEl, setDetailColumnsAnchorEl] = useState<HTMLElement | null>(null)
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
  // PS-373 (slice 2): storage-fee proof drilldown, opened from the storage line.
  const [storageProofOpen, setStorageProofOpen] = useState(false)
  const [billingEditModal, setBillingEditModal] = useState<BillingEditModalState>(null)
  const billingEditDraftCacheRef = useRef<BillingEditDraftCache>({})
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
  const isHugrabDetailClient = normalizeBillingClientName(detailState.clientName) === normalizeBillingClientName('HUGRAB')

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
          return billingDetailQtySortValue(row)
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
          return row.refUpsRate ?? row.ref_ups_rate
        case 'uspsss':
          return row.refUspsRate ?? row.ref_usps_rate
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

  async function handleGenerateBilling(options: boolean | { silent?: boolean } = false) {
    const forceRegenerate = typeof options === 'boolean' ? options : false
    const silent = typeof options === 'object' && options.silent === true
    const setStatus = (message: string) => {
      if (!silent) setGenerateStatus(message)
    }

    if (!from || !to) {
      if (!silent) toastContext?.addToast('Select a date range first', 'error')
      return
    }

    if (forceRegenerate && regenerateRangeBlocked) {
      if (!silent) toastContext?.addToast('Regenerate Range is limited to 120 days. Use Update Billing for All/history.', 'error')
      return
    }

    if (billingUpdateRunningRef.current) {
      return
    }

    billingUpdateRunningRef.current = true

    // The Regenerate confirmation is now handled by the styled ConfirmModal (regenerateConfirmOpen),
    // which only calls this with forceRegenerate=true AFTER the operator confirms.

    if (!silent) {
      setGenerateLoading(true)
      setGenerateStatus('')
    }

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
            setStatus(`Checking ${clientName} (${index + 1}/${targetClientIds.length})...`)
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
            setStatus(`${forceRegenerate ? 'Regenerating' : 'Updating'} ${plan.clientName}: ${batch.from} to ${batch.to} (${step}/${totalSteps})...`)
            const result = await apiClient.generateBilling(batch.from, batch.to, plan.clientId)
            generated += Number(result.generated ?? result.count ?? 0)
          }
        }
      } else {
        let batchFrom = from
        let batchTo = to

        if (!forceRegenerate) {
          setStatus('Checking billing freshness...')
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
          if (!silent) toastContext?.addToast('Select a valid billing date range first', 'error')
          return
        }

        for (let index = 0; index < batches.length; index += 1) {
          const batch = batches[index]!
          setStatus(`${forceRegenerate ? 'Regenerating' : 'Updating'} all clients: ${batch.from} to ${batch.to} (${index + 1}/${batches.length})...`)
          const result = await apiClient.generateBilling(batch.from, batch.to)
          generated += Number(result.generated ?? result.count ?? 0)
        }
      }
      const result = { generated }
      if (!silent) {
        if (generated > 0) {
          toastContext?.addToast(`Billing ${forceRegenerate ? 'regenerated' : 'updated'}: ${result.generated} line items`, 'success')
        } else {
          toastContext?.addToast('Billing is already up to date', 'success')
        }
      }

      const [rows, marginAnalytics] = await Promise.all([
        apiClient.fetchBillingSummary(from, to, billingClientQueryIds),
        apiClient.fetchShippingMarginAnalytics(from, to, billingClientQueryIds),
      ])
      const rowsForStatus = targetClientIds.length > 0
        ? rows.filter((row) => targetClientIds.includes(Number(row.clientId)))
        : rows
      const totals = buildBillingSummaryTotals(rowsForStatus)
      setStatus(generated > 0 ? buildGenerateBillingStatus(result.generated, totals.fulfillmentFee) : `Billing already up to date - total ${formatBillingMoney(totals.fulfillmentFee)}`)
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
      if (!silent) toastContext?.addToast(error instanceof Error ? error.message : 'Failed to update billing', 'error')
    } finally {
      billingUpdateRunningRef.current = false
      if (!silent) setGenerateLoading(false)
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

  async function refreshBillingAfterHugrabFloor() {
    try {
      const detailClientId = detailState.clientId
      const detailClientName = detailState.clientName
      const [rows, marginAnalytics, detailRows] = await Promise.all([
        apiClient.fetchBillingSummary(from, to, billingClientQueryIds),
        apiClient.fetchShippingMarginAnalytics(from, to, billingClientQueryIds),
        detailState.open && detailClientId != null
          ? apiClient.fetchBillingDetails(from, to, detailClientId)
          : Promise.resolve(null),
      ])
      setSummaryRows(rows)
      setSummaryError(null)
      setShippingMarginSummary(marginAnalytics?.summary ?? EMPTY_SHIPPING_MARGIN_SUMMARY)
      setShippingMarginCarriers(marginAnalytics?.carriers ?? [])
      setShippingMarginRows((marginAnalytics?.rows ?? []) as ShippingMarginRowDto[])
      setShippingMarginError(null)
      if (detailRows && detailClientId != null) {
        setDetailState({
          open: true,
          loading: false,
          clientId: detailClientId,
          clientName: detailClientName,
          rows: detailRows,
          error: null,
        })
      }
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Failed to refresh billing rows', 'error')
    }
  }

  function handleOpenBillingEdit(row: BillingDetailDto) {
    if (!row.orderId || !detailState.clientId) return
    setBillingEditModal((current) => {
      const cache = current
        ? rememberBillingEditDraft(billingEditDraftCacheRef.current, current.row, current.draft)
        : billingEditDraftCacheRef.current
      const carryFrom = current ? { row: current.row, draft: current.draft } : null
      billingEditDraftCacheRef.current = cache
      return {
        row,
        draft: billingEditDraftForRow(cache, row, createBillingEditDraft(row), carryFrom),
        saving: false,
        error: null,
      }
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

  function handleCloseBillingEditModal() {
    billingEditDraftCacheRef.current = {}
    setBillingEditModal(null)
  }

  function handleOpenNoBoxCostBulkApply(row: BillingDetailDto) {
    const packageId =
      billingEditModal?.draft.packageId ||
      String(row.packageId ?? row.package_id ?? row.selectedPackageId ?? row.selected_package_id ?? '')

    if (!packageId.trim()) {
      toastContext?.addToast('Pick a Box Size first, then bulk set the Box Cost for matching boxes.', 'error')
      handleOpenBillingEdit(row)
      return
    }

    setBulkBoxCostOpen(true)
  }

  // PS — operator changed the Box Size: set the package + auto-fill Box Cost
  // from the client's saved price for that box (still manually overridable).
  function handleBillingEditPackageChange(value: string) {
    setBillingEditModal((current) => {
      if (!current) return current
      const pid = Number(value)
      const price = Number.isFinite(pid) ? billingEditPackagePrices[pid] : undefined
      const draft = {
        ...current.draft,
        packageId: value,
        packageCost: price != null ? price.toFixed(2) : current.draft.packageCost,
      }
      billingEditDraftCacheRef.current = rememberBillingEditDraft(billingEditDraftCacheRef.current, current.row, draft)
      return {
        ...current,
        draft,
        error: null,
      }
    })
  }

  function handleBillingEditDraftChange(field: keyof BillingEditDraft, value: string) {
    setBillingEditModal((current) => {
      if (!current) return current
      const draft = {
        ...current.draft,
        [field]: value,
      }
      billingEditDraftCacheRef.current = rememberBillingEditDraft(billingEditDraftCacheRef.current, current.row, draft)
      return {
        ...current,
        draft,
        error: null,
      }
    })
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
      billingEditDraftCacheRef.current = clearBillingEditDraft(billingEditDraftCacheRef.current, billingEditModal.row)
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
      handleCloseBillingEditModal()
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
      <BillingDashboardHeader />

      <div className="order-2 rounded-xl bg-surface ring-1 ring-line p-4 mb-[18px]">
        <div className="flex items-center gap-2 mb-3">
          <SlidersHorizontal size={16} strokeWidth={2.25} className="text-ink-3" aria-hidden="true" />
          <h3 className="text-[13px] font-semibold text-ink">Generate &amp; summary</h3>
        </div>

        <BillingFilters
          activePreset={activePreset}
          from={from}
          to={to}
          generateLoading={generateLoading}
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

        <BillingShippingMarginSummary
          summary={shippingMarginSummary}
          loading={shippingMarginLoading}
          error={shippingMarginError}
        />
        {/* Layout: Client billing config, Package pricing, and Margin by carrier /
            account each moved to their own separated section cards below, so this
            card stays focused on generating billing and reading the summary. */}

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
            <BillingLineItemsHeader
              clientName={detailState.clientName}
              rows={sortedDetailRows}
              loading={detailState.loading}
              isHugrabClient={isHugrabDetailClient}
              columnsAnchorRef={setDetailColumnsAnchorEl}
              onClose={() => setDetailState((current) => ({ ...current, open: false }))}
              onOpenWarningRow={handleOpenBillingEdit}
              onOpenHugrabBulk={() => setHugrabShippingFloorOpen(true)}
            />

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
              columnsAnchorEl={detailColumnsAnchorEl}
              onOpenBillingEdit={handleOpenBillingEdit}
              onOpenOrderDetail={setOrderDetailModalId}
              onOpenStorageProof={() => setStorageProofOpen(true)}
            />
          </div>
        ) : null}
      </div>

      {/* ── Sections: Client billing config + Package pricing by client (side by side) ──
          Two self-contained cards (each renders its own bordered card + header)
          laid out side by side on wide screens and stacked below xl. The config
          table is much wider (~15 columns), so it takes the larger 3fr track and
          pricing the 2fr track; min-w-0 on each cell lets the cards' own
          horizontal scroll (stickyHeader={false} → overflow-x-auto) handle
          overflow instead of blowing out the row. Placed in the order-1 slot so
          these config cards sit at the TOP (under the dashboard header), above the
          Generate & summary card (order-2). */}
      <div className="order-1 mb-[18px] grid grid-cols-1 xl:grid-cols-[3fr_2fr] gap-[18px] items-start">
        <div className="min-w-0">
          <BillingConfigTable
            configs={configs}
            configsLoading={configsLoading}
            configDrafts={configDrafts}
            setConfigDrafts={setConfigDrafts}
            onSaveConfig={handleSaveConfig}
            onToggleHouseAccount={handleToggleHouseAccount}
          />
        </div>
        <div className="min-w-0">
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
      </div>

      {/* ── Section: Margin by carrier / account ────────────────────────
          Own separated card. BillingCarrierMarginTable titles itself in its
          toolbar ("Margin by carrier / account"); the reconciliation drilldown
          lives with it. PS-296 (FE): consumes analytics.carriers[]. */}
      <div className="order-4 rounded-xl bg-surface ring-1 ring-line p-4 mb-[18px]">
        <BillingCarrierMarginTable carriers={shippingMarginCarriers} />
        <BillingShippingMarginReconciliation
          rows={shippingMarginRows}
          open={shippingMarginDrilldownOpen}
          onToggle={() => setShippingMarginDrilldownOpen((open) => !open)}
        />
      </div>

      {storageProofOpen && detailState.clientId != null ? (
        <BillingStorageProofModal
          clientId={detailState.clientId}
          clientName={detailState.clientName}
          from={from}
          to={to}
          onClose={() => setStorageProofOpen(false)}
        />
      ) : null}

      {billingEditModal ? (
        <BillingEditDetailModal
          modal={billingEditModal}
          packages={packages}
          noBoxCostRows={billingNoBoxCostRows}
          clientId={detailState.clientId}
          clientName={detailState.clientName}
          from={from}
          to={to}
          draftTotal={billingEditDraftTotal}
          draftMargin={billingEditDraftMargin}
          zeroShippingReviewSaving={zeroShippingReviewSaving}
          onClose={handleCloseBillingEditModal}
          onPackageChange={handleBillingEditPackageChange}
          onDraftChange={handleBillingEditDraftChange}
          onOpenBillingEdit={handleOpenBillingEdit}
          onOpenNoBoxCostBulkApply={handleOpenNoBoxCostBulkApply}
          onOpenBoxReviewSweep={() => setBoxReviewSweepOpen(true)}
          onOpenBulkBoxCost={() => setBulkBoxCostOpen(true)}
          onZeroShippingReview={handleZeroShippingReview}
          onSave={handleSaveBillingEdit}
        />
      ) : null}

      <BillingDetailModalStack
        bulkBoxCostOpen={bulkBoxCostOpen}
        boxReviewSweepOpen={boxReviewSweepOpen}
        hugrabShippingFloorOpen={hugrabShippingFloorOpen}
        billingEditModal={billingEditModal}
        clientId={detailState.clientId}
        clientName={detailState.clientName}
        dateFrom={from}
        dateTo={to}
        packages={packages}
        onCloseBulkBoxCost={() => setBulkBoxCostOpen(false)}
        onBulkBoxCostApplied={() => {
          void apiClient.fetchBillingSummary(from, to, billingClientQueryIds).then((rows) => setSummaryRows(rows)).catch(() => {})
          if (detailState.clientId != null) void handleLoadDetails(detailState.clientId, detailState.clientName || '')
        }}
        onCloseBoxReviewSweep={() => setBoxReviewSweepOpen(false)}
        onBoxReviewSweepApplied={() => {
          void apiClient.fetchBillingSummary(from, to, billingClientQueryIds).then((rows) => setSummaryRows(rows)).catch(() => {})
          if (detailState.clientId != null) void handleLoadDetails(detailState.clientId, detailState.clientName || '')
        }}
        onCloseHugrabShippingFloor={() => setHugrabShippingFloorOpen(false)}
        onHugrabShippingFloorApplied={() => {
          void refreshBillingAfterHugrabFloor()
        }}
      />

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
