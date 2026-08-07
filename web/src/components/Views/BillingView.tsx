import { lazy, Suspense, useContext, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from 'react'
// FE-2 (audit 2.2 slice 2): every billing GET now flows through React Query
// (['billing', ...] keys) so remounts within staleTime paint from cache with
// zero refetches. Mutations stay imperative and invalidate the same keys the
// old code refetched manually — useQueryClient exists for those invalidations
// and for the local cache patches that replace setConfigs/setSavedPackagePrices.
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ListFilter, Loader2, Pencil, SlidersHorizontal } from 'lucide-react'
import { apiClient } from '../../api/client'
// PS-275: the new $0-shipping prep-fee review POST has no apiClient wrapper
// (that adapter is out of this ticket's scope); call the shared low-level
// client directly. Additive, behind the backend shippingZeroNeedsReview flag.
import { api, qs } from '../../lib/api'
import { endpointQueryKeys } from '../../lib/endpoint-query-keys'
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
  getBillingInvoiceUrl,
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
import { BillingBulkImportModal } from './BillingBulkImportModal'
import type { BulkImportReadyRow } from './billing-bulk-import'
import {
  BillingCloseWorkflowPanel,
  type BillingCreditDraft,
  type BillingCreditNoteDto,
  type BillingFinalizationDto,
} from './BillingCloseWorkflowPanel'
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

type BillingFinalizeIntent = {
  clientId: number
  clientName: string
  dateFrom: string
  dateTo: string
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

// FE-2 (audit 2.2 slice 2): billing GET data now lives in the React Query cache
// (keyed under ['billing', ...]) instead of per-mount useState, so navigating
// away and back re-renders the cached DTOs instantly instead of refiring the
// billing endpoints. These module-level empty fallbacks keep referential
// identity stable across renders while a query has no data yet (memo deps
// depend on it). They are read-only — every consumer treats them as immutable.
const EMPTY_BILLING_CONFIGS: BillingConfigDto[] = []
const EMPTY_PACKAGES: PackageDto[] = []
const EMPTY_BILLING_PACKAGE_PRICES: BillingPackagePriceDto[] = []
const EMPTY_BILLING_SUMMARY_ROWS: BillingSummaryDto[] = []
const EMPTY_BILLING_DETAIL_ROWS: BillingDetailDto[] = []
const EMPTY_SHIPPING_MARGIN_CARRIERS: ShippingMarginCarrierDto[] = []
const EMPTY_SHIPPING_MARGIN_ROWS: ShippingMarginRowDto[] = []
const EMPTY_BILLING_FINALIZATIONS: BillingFinalizationDto[] = []
const EMPTY_BILLING_CREDIT_NOTES: BillingCreditNoteDto[] = []

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
    case 'shipDate': return row.billingEffectiveDate ?? row.shipDate
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
  const detailWrapRef = useRef<HTMLDivElement | null>(null)
  const fetchRefPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const billingUpdateRunningRef = useRef(false)

  // FE-2 (audit 2.2 slice 2): configs/packages/saved prices/summary/margin/detail
  // rows are React Query data now (derived consts below the drag handlers). Only
  // operator-editable drafts and UI intent remain as useState.
  const [configDrafts, setConfigDrafts] = useState<Record<number, BillingConfigDraft>>({})
  const [selectedPkgClientId, setSelectedPkgClientId] = useState('')
  const [packagePriceDrafts, setPackagePriceDrafts] = useState<Record<number, string>>({})
  const [activePreset, setActivePreset] = useState<BillingPresetId | null>('last_30')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const billingPresetWindowQuery = useQuery<{ from: string; to: string }>({
    queryKey: ['billing', 'preset-window', activePreset],
    enabled: activePreset != null,
    queryFn: () => api.get(`/billing/preset-window${qs({ preset: activePreset ?? undefined })}`),
  })
  useEffect(() => {
    if (activePreset == null || !billingPresetWindowQuery.data) return
    setFrom(billingPresetWindowQuery.data.from)
    setTo(billingPresetWindowQuery.data.to)
  }, [activePreset, billingPresetWindowQuery.data])
  // PS-311: bulk box-cost modal — open when the operator chooses to apply a reviewed box cost to
  // EVERY order with that box in the current (client + date range).
  const [bulkBoxCostOpen, setBulkBoxCostOpen] = useState(false)
  const [bulkImportOpen, setBulkImportOpen] = useState(false)
  // PS-311b: the needs-review box-cost sweep (date range picker + same-box-size apply).
  const [boxReviewSweepOpen, setBoxReviewSweepOpen] = useState(false)
  const [hugrabShippingFloorOpen, setHugrabShippingFloorOpen] = useState(false)
  const [detailColumnsAnchorEl, setDetailColumnsAnchorEl] = useState<HTMLElement | null>(null)
  // Regenerate Range confirmation — a styled modal instead of the native browser confirm().
  const [regenerateConfirmOpen, setRegenerateConfirmOpen] = useState(false)
  const [billingFinalizeIntent, setBillingFinalizeIntent] = useState<BillingFinalizeIntent | null>(null)
  const [billingFinalizeLoading, setBillingFinalizeLoading] = useState(false)
  const [billingCreditSubmitting, setBillingCreditSubmitting] = useState(false)
  const [selectedFinalizationId, setSelectedFinalizationId] = useState<string | null>(null)
  const [clientFilterOpen, setClientFilterOpen] = useState(false)
  const [selectedBillingClientIds, setSelectedBillingClientIds] = useState<number[]>(readBillingClientFilterIds)
  const [summarySort, setSummarySort] = useState<SortState<string>>(null)
  const [detailSort, setDetailSort] = useState<SortState<BillingDetailColumnId>>(null)
  const [summaryPage, setSummaryPage] = useState(1)
  const [summaryPageSize, setSummaryPageSize] = useState(25)
  const [shippingMarginDrilldownOpen, setShippingMarginDrilldownOpen] = useState(false)
  const [generateLoading, setGenerateLoading] = useState(false)
  const [generateStatus, setGenerateStatus] = useState('')
  const [fetchRefRunning, setFetchRefRunning] = useState(false)
  const [fetchRefStatus, setFetchRefStatus] = useState('')
  const [backfillLoading, setBackfillLoading] = useState(false)
  // FE-2 (audit 2.2 slice 2): which client's line-items panel is open is pure UI
  // intent; the panel's rows/loading/error now come from the ['billing','details']
  // query (see detailQuery below) and are assembled into detailStateForView for
  // the child components that consume the old six-field shape.
  const [detailState, setDetailState] = useState<{ open: boolean; clientId: number | null; clientName: string }>({
    open: false,
    clientId: null,
    clientName: '',
  })
  const [detailPage, setDetailPage] = useState(1)
  const [detailPageSize, setDetailPageSize] = useState(50)
  const [orderDetailModalId, setOrderDetailModalId] = useState<number | null>(null)
  // PS-373 (slice 2): storage-fee proof drilldown, opened from the storage line.
  const [storageProofDay, setStorageProofDay] = useState<string | null>(null)
  const [billingEditModal, setBillingEditModal] = useState<BillingEditModalState>(null)
  const billingEditDraftCacheRef = useRef<BillingEditDraftCache>({})
  // PS-275: in-flight flag for the $0-shipping prep-fee review POST. Separate
  // from the edit-modal save state so the review action does not entangle with
  // the line-item save. Additive — only used when shippingZeroNeedsReview.
  const [zeroShippingReviewSaving, setZeroShippingReviewSaving] = useState(false)
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

  // ── FE-2 (audit 2.2 slice 2): billing GETs as React Query hooks ────────────
  // Every queryFn calls the SAME apiClient method the old imperative loaders
  // used, with byte-identical params. TanStack now owns all request freshness
  // and mutation invalidation for these endpoint families. What changed is the
  // component layer: remounts within the 5-minute staleTime paint from the query
  // cache with zero requests, and mutations invalidate the matching ['billing',…]
  // key prefixes instead of manually refetching + setState. PS-316 holds — the
  // backend DTOs render verbatim through derived consts; no billing money is
  // computed in the FE.
  const queryClient = useQueryClient()

  // Same atomic pair the old loadConfigs effect fetched: packages ride along
  // (non-fatal .catch → []) so the config table and Box Size dropdown appear
  // together, exactly like before.
  const billingConfigsQuery = useQuery<BillingConfigDto[]>({
    queryKey: endpointQueryKeys.billingConfigs,
    queryFn: () => apiClient.fetchBillingConfigs(),
  })
  const billingPackagesQuery = useQuery<PackageDto[]>({
    queryKey: endpointQueryKeys.packages(),
    queryFn: () => apiClient.fetchPackages(),
  })
  const configs = billingConfigsQuery.data ?? EMPTY_BILLING_CONFIGS
  const packages = billingPackagesQuery.data ?? EMPTY_PACKAGES
  const configsLoading = billingConfigsQuery.isPending

  // Config drafts are operator-editable useState seeded from the loaded configs —
  // the same seeding the old loadConfigs success handler did. The ref makes the
  // seed once-per-mount so a same-mount cache patch (setQueryData after a config
  // save) never clobbers in-progress operator edits; a remount re-seeds from the
  // cached configs instantly.
  const configDraftsSeededRef = useRef(false)
  useEffect(() => {
    const data = billingConfigsQuery.data
    if (!data || configDraftsSeededRef.current) return
    configDraftsSeededRef.current = true
    setConfigDrafts(createBillingConfigDraftMap(data))
    setSelectedPkgClientId((current) => {
      if (current && data.some((config) => String(config.clientId) === current)) return current
      return data.length > 0 ? String(data[0]!.clientId) : ''
    })
  }, [billingConfigsQuery.data])
  // Same error toast the old loadConfigs catch showed (fires once per failure).
  useEffect(() => {
    if (!billingConfigsQuery.isError) return
    const error = billingConfigsQuery.error
    toastContext?.addToast(error instanceof Error ? error.message : 'Failed to load billing config', 'error')
  }, [billingConfigsQuery.isError, billingConfigsQuery.error, toastContext])

  // Package pricing for the client picked in the pricing table.
  const packagePricesQuery = useQuery<BillingPackagePriceDto[]>({
    queryKey: endpointQueryKeys.billingPackagePrices(selectedPkgClientId ? Number(selectedPkgClientId) : null),
    enabled: Boolean(selectedPkgClientId),
    queryFn: () => apiClient.fetchBillingPackagePrices(Number(selectedPkgClientId)),
  })
  const savedPackagePrices = packagePricesQuery.data ?? EMPTY_BILLING_PACKAGE_PRICES
  const packagePricingLoading = Boolean(selectedPkgClientId) && packagePricesQuery.isPending
  const packagePricingError = packagePricesQuery.isError
    ? (packagePricesQuery.error instanceof Error ? packagePricesQuery.error.message : 'Failed to load package prices')
    : null

  // Price drafts are operator-editable useState seeded per client from the saved
  // rows — the same reset the old loadPackagePrices success/error handler did on
  // every client switch. The ref keys the seed by client so a same-client cache
  // patch (setQueryData after Save Prices) keeps the operator's draft strings.
  const packagePriceDraftsSeededForRef = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedPkgClientId) return
    if (packagePricesQuery.isError) {
      if (packagePriceDraftsSeededForRef.current !== `error:${selectedPkgClientId}`) {
        packagePriceDraftsSeededForRef.current = `error:${selectedPkgClientId}`
        setPackagePriceDrafts({})
      }
      return
    }
    const rows = packagePricesQuery.data
    if (!rows || packagePriceDraftsSeededForRef.current === selectedPkgClientId) return
    packagePriceDraftsSeededForRef.current = selectedPkgClientId
    const nextRows = buildBillingPackagePriceRows(rows)
    setPackagePriceDrafts(Object.fromEntries(nextRows.map((row) => [row.packageId, (Number(row.charge) || 0).toFixed(2)])))
  }, [selectedPkgClientId, packagePricesQuery.data, packagePricesQuery.isError])

  // PS — client package prices (packageId -> charge) for the open detail client,
  // used to auto-fill Box Cost when the operator changes the Box Size. Shares the
  // ['billing','package-prices', clientId] key with the pricing table above, so a
  // price save there is immediately visible here. Fetch fires when the edit modal
  // opens (the old handleOpenBillingEdit fetch), served from cache within staleTime.
  // Also needed by the paste import, which applies the same box→price rule.
  const billingEditPricesClientId = (billingEditModal || bulkImportOpen) && detailState.clientId != null
    ? Number(detailState.clientId)
    : null
  const billingEditPackagePricesQuery = useQuery<BillingPackagePriceDto[]>({
    queryKey: endpointQueryKeys.billingPackagePrices(billingEditPricesClientId),
    enabled: billingEditPricesClientId != null,
    queryFn: async () => {
      // Defensive: enabled above guarantees a client id when this runs.
      if (billingEditPricesClientId == null) return EMPTY_BILLING_PACKAGE_PRICES
      return apiClient.fetchBillingPackagePrices(billingEditPricesClientId)
    },
  })
  // Same map the old .then handler built; a load failure leaves it empty exactly
  // like the old .catch(() => setBillingEditPackagePrices({})) did.
  const billingEditPackagePrices = useMemo(() => {
    const map: Record<number, number> = {}
    for (const p of billingEditPackagePricesQuery.data ?? []) {
      const pid = Number(p.packageId ?? p.package_id)
      const price = Number(p.price ?? p.charge)
      if (Number.isFinite(pid) && Number.isFinite(price)) map[pid] = price
    }
    return map
  }, [billingEditPackagePricesQuery.data])
  // Same backend-owned rows, as ids: the edit modal groups this client's priced
  // boxes first. Display order only — the charge still comes from the map above.
  const billingEditPricedPackageIds = useMemo(
    () => Object.keys(billingEditPackagePrices).map(Number).filter(Number.isFinite),
    [billingEditPackagePrices],
  )

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

  // ── Summary + shipping-margin queries ──────────────────────────────────────
  // The old loadSummary effect fired these two requests in one Promise.all on
  // every from/to/filter change; they stay two parallel requests, now as two
  // stable-keyed queries so each panel's error reflects its own request and so
  // mutation invalidation can match the exact per-endpoint refresh sets the old
  // handlers refetched (bulk box-cost refreshes summary but NOT margin).
  const billingRangeReady = Boolean(from && to)
  const summaryQuery = useQuery<BillingSummaryDto[]>({
    queryKey: endpointQueryKeys.billingSummary(from, to, billingClientQueryIds),
    enabled: billingRangeReady,
    queryFn: () => apiClient.fetchBillingSummary(from, to, billingClientQueryIds),
  })
  const summaryRows = summaryQuery.data ?? EMPTY_BILLING_SUMMARY_ROWS
  const summaryLoading = summaryQuery.isPending
  // Same message rule the old catch used. Only surfaced when there is no data to
  // show (first load of this key): the old code never blanked already-rendered
  // rows on a post-mutation refetch failure — those paths toast instead.
  const summaryError = summaryQuery.isError && summaryQuery.data === undefined
    ? (summaryQuery.error instanceof Error ? summaryQuery.error.message : 'Error loading summary')
    : null

  const shippingMarginQuery = useQuery({
    queryKey: endpointQueryKeys.shippingMargin(from, to, billingClientQueryIds),
    enabled: billingRangeReady,
    queryFn: () => apiClient.fetchShippingMarginAnalytics(from, to, billingClientQueryIds),
  })
  const shippingMarginSummary: ShippingMarginSummaryDto = shippingMarginQuery.data?.summary ?? EMPTY_SHIPPING_MARGIN_SUMMARY
  // PS-296 (FE): the carrier/account margin breakdown rows (backend analytics.carriers[]),
  // read via a typed derived const (was a useState setter before FE-2); no data → EMPTY.
  const shippingMarginCarriers: ShippingMarginCarrierDto[] = shippingMarginQuery.data?.carriers ?? EMPTY_SHIPPING_MARGIN_CARRIERS
  // PS-296 (FE, req6): per-shipment reconciliation rows (backend analytics.rows[]), collapsed by default.
  const shippingMarginRows = (shippingMarginQuery.data?.rows ?? EMPTY_SHIPPING_MARGIN_ROWS) as ShippingMarginRowDto[]
  const shippingMarginLoading = shippingMarginQuery.isPending
  const shippingMarginError = shippingMarginQuery.isError && shippingMarginQuery.data === undefined
    ? (shippingMarginQuery.error instanceof Error ? shippingMarginQuery.error.message : 'Error loading shipping margin')
    : null

  // ── Detail (line items) query for the open client ──────────────────────────
  // PS-069/PS-362: key includes the open client + range, so switching clients or
  // dates re-keys the query (the old [from, to] effect refired the fetch and
  // handleLoadDetails did the per-client fetch). `enabled` gates fetching to an
  // actually-open panel; re-opening a cached client within staleTime paints
  // instantly with zero requests, and a mutation invalidation marks every cached
  // client stale so the next open refetches — the old always-fetch-fresh result.
  const detailQuery = useQuery<BillingDetailDto[]>({
    queryKey: ['billing', 'details', from, to, detailState.clientId],
    enabled: billingRangeReady && detailState.open && detailState.clientId != null,
    queryFn: async () => {
      // Defensive: enabled above guarantees an open client when this runs (the
      // null check also narrows the type for the call below).
      if (detailState.clientId == null) return EMPTY_BILLING_DETAIL_ROWS
      return apiClient.fetchBillingDetails(from, to, detailState.clientId)
    },
  })
  const detailRows = detailQuery.data ?? EMPTY_BILLING_DETAIL_ROWS
  const detailLoading = detailState.open && detailState.clientId != null && detailQuery.isPending
  // Same message rule the old handleLoadDetails catch used. NOT gated on missing
  // data: a failed details refetch must surface in the panel —
  // classifyBillingDetailPanel puts hasError before rows (PS-069's honesty rule).
  const detailError = detailQuery.isError
    ? (detailQuery.error instanceof Error ? detailQuery.error.message : 'Error loading details')
    : null
  // The child tables consume the same {open, loading, clientId, clientName, rows,
  // error} shape the old useState held — assembled from UI intent + query state.
  const detailStateForView: BillingDetailState = useMemo(() => ({
    open: detailState.open,
    loading: detailLoading,
    clientId: detailState.clientId,
    clientName: detailState.clientName,
    rows: detailRows,
    error: detailError,
  }), [detailState.open, detailState.clientId, detailState.clientName, detailLoading, detailRows, detailError])

  // Audit 5.7: the backend finalization policy remains the only billing-close
  // authority. These queries render its immutable DTOs and fail closed while
  // the selected client's lock status is unknown; the UI never derives invoice
  // totals, remaining credit, overlap eligibility, or editability itself.
  const billingFinalizationsQuery = useQuery<BillingFinalizationDto[]>({
    queryKey: ['billing', 'finalizations', from, to, detailState.clientId],
    enabled: billingRangeReady && detailState.open && detailState.clientId != null,
    queryFn: async () => {
      if (detailState.clientId == null) return EMPTY_BILLING_FINALIZATIONS
      const response = await api.get<{ data: BillingFinalizationDto[] }>(
        `/billing/finalizations${qs({ clientId: detailState.clientId, dateFrom: from, dateTo: to })}`,
      )
      return response.data
    },
  })
  const billingFinalizations = billingFinalizationsQuery.data ?? EMPTY_BILLING_FINALIZATIONS
  const billingFinalizationStatusLoading = detailState.open
    && detailState.clientId != null
    && billingFinalizationsQuery.isPending
  const billingFinalizationStatusError = billingFinalizationsQuery.isError
    ? (billingFinalizationsQuery.error instanceof Error
        ? billingFinalizationsQuery.error.message
        : 'Failed to verify finalized-period status')
    : null
  const activeFinalizationId = billingFinalizations.some((row) => row.id === selectedFinalizationId)
    ? selectedFinalizationId
    : billingFinalizations[0]?.id ?? null

  const billingCreditNotesQuery = useQuery<BillingCreditNoteDto[]>({
    queryKey: ['billing', 'credit-notes', detailState.clientId, activeFinalizationId],
    enabled: detailState.open && detailState.clientId != null && activeFinalizationId != null,
    queryFn: async () => {
      if (detailState.clientId == null || activeFinalizationId == null) return EMPTY_BILLING_CREDIT_NOTES
      const response = await api.get<{ data: BillingCreditNoteDto[] }>(
        `/billing/credit-notes${qs({ clientId: detailState.clientId, finalizationId: activeFinalizationId })}`,
      )
      return response.data
    },
  })
  const billingCreditNotes = billingCreditNotesQuery.data ?? EMPTY_BILLING_CREDIT_NOTES
  const billingCreditNotesError = billingCreditNotesQuery.isError
    ? (billingCreditNotesQuery.error instanceof Error
        ? billingCreditNotesQuery.error.message
        : 'Failed to load credit memos')
    : null
  const billingPeriodReadOnlyReason = billingFinalizationStatusLoading
    ? 'Checking finalized-period lock'
    : billingFinalizationStatusError
      ? 'Finalized-period status is unavailable'
      : billingFinalizations.length > 0
        ? 'This billing period is finalized'
        : null

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
          return row.grandTotal ?? row.total ?? row.fulfillmentFeeTotal
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
    selectedDetailSummary?.grandTotal ?? selectedDetailSummary?.total ?? selectedDetailSummary?.fulfillmentFeeTotal ?? 0,
  )
  const detailPanelState = classifyBillingDetailPanel({
    loading: detailLoading,
    hasError: Boolean(detailError),
    rowCount: detailRows.length,
    summaryOrders: selectedSummaryOrders,
    summaryTotal: selectedSummaryTotal,
  })

  const summaryTotals = useMemo(() => buildBillingSummaryTotals(filteredSummaryRows), [filteredSummaryRows])
  const visibleDetailColumns = useMemo(() => getVisibleBillingDetailColumns(detailColumnIds), [detailColumnIds])
  // PS-362: /billing/details returns backend-owned order-level rows.
  // React renders the DTO instead of collapsing raw billing fee lines.
  const mergedDetailRows = useMemo(
    () => {
      const merged = detailRows
      // Back-compat for old cached raw-line payloads. Fresh PS-362 payloads
      // already carry this backend-owned order-level flag.
      const zeroReviewByOrderId = new Map<unknown, boolean>()
      for (const raw of detailRows) {
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
    [detailRows],
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
          return row.billingEffectiveDate ?? row.shipDate
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
        total: acc.total + metrics.total,
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

  // FE-2 (audit 2.2 slice 2): the config/package-price/summary/margin/detail
  // loads that used to live in effects here are React Query hooks above. This
  // effect keeps the one piece of the old [from, to] detail effect that was not
  // a fetch: resetting the detail pager when the operator changes the date
  // filter while a client is open (the reload itself now happens because the
  // date is part of the ['billing','details'] query key).
  useEffect(() => {
    if (!from || !to || !detailState.open || detailState.clientId == null) return
    setDetailPage(1)
  // Only when the operator changes the date filter — opening a client resets the
  // pager in handleLoadDetails.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to])

  async function handleSaveConfig(clientId: number) {
    const draft = configDrafts[clientId]
    if (!draft) return

    try {
      await apiClient.updateBillingConfig(clientId, buildBillingConfigInput(draft))
      // Same zero-request local patch the old setConfigs applied, now on the
      // ['billing','configs'] cache entry (the PATCH already cleared the adapter's
      // canonical config entry, so the next real fetch is fresh).
      queryClient.setQueryData<BillingConfigDto[]>(
        endpointQueryKeys.billingConfigs,
        (current) => current
          ? current.map((config) => config.clientId === clientId ? {
                ...config,
                ...buildBillingConfigInput(draft),
              } : config)
          : current,
      )
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
      // Same zero-request local patch the old setConfigs applied (see handleSaveConfig).
      queryClient.setQueryData<BillingConfigDto[]>(
        endpointQueryKeys.billingConfigs,
        (current) => current
          ? current.map((config) => config.clientId === clientId ? {
                ...config,
                houseAccountEnabled: enabled,
                shippingMarginPolicyMode,
              } : config)
          : current,
      )
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
      let finalizedSkipped = 0
      let finalizedStorageSkipped = 0
      let finalizedAdjustments = 0
      let finalizedCredits = 0
      let finalizedDebits = 0
      let finalizedUntouched = 0
      let alreadyCurrent = 0

      if (targetClientIds.length > 0) {
        const batchPlan: Array<{ clientId: number; clientName: string; batches: Array<{ from: string; to: string }> }> = []

        // One freshness probe per client, fired in PARALLEL — this loop used
        // to await each probe serially (N clients × the status round-trip
        // before any generation started). The backend verdict per client is
        // unchanged; only the wall-clock shape of the fan-out changed.
        const statusByClientId = new Map<number, Awaited<ReturnType<typeof apiClient.fetchBillingGenerationStatus>>>()
        if (!forceRegenerate) {
          setStatus(`Checking billing freshness for ${targetClientIds.length} client${targetClientIds.length === 1 ? '' : 's'}...`)
          const statuses = await Promise.all(
            targetClientIds.map((clientId) => apiClient.fetchBillingGenerationStatus(from, to, clientId)),
          )
          targetClientIds.forEach((clientId, index) => statusByClientId.set(clientId, statuses[index]))
        }

        for (let index = 0; index < targetClientIds.length; index += 1) {
          const clientId = targetClientIds[index]!
          const clientName = availableBillingClients.find((client) => client.clientId === clientId)?.clientName ?? 'client'
          let batchFrom = from
          let batchTo = to

          if (!forceRegenerate) {
            const status = statusByClientId.get(clientId)
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
            finalizedSkipped += Number(result.skippedFinalizedOrderCount ?? 0)
            finalizedStorageSkipped += Number(result.skippedFinalizedStorageCount ?? 0)
            finalizedAdjustments += Number(result.finalizedAdjustmentCount ?? 0)
            finalizedCredits += Number(result.finalizedAdjustmentCreditCount ?? 0)
            finalizedDebits += Number(result.finalizedAdjustmentDebitCount ?? 0)
            finalizedUntouched += Number(result.finalizedAdjustmentUntouchedCount ?? 0)
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
          finalizedSkipped += Number(result.skippedFinalizedOrderCount ?? 0)
          finalizedStorageSkipped += Number(result.skippedFinalizedStorageCount ?? 0)
          finalizedAdjustments += Number(result.finalizedAdjustmentCount ?? 0)
          finalizedCredits += Number(result.finalizedAdjustmentCreditCount ?? 0)
          finalizedDebits += Number(result.finalizedAdjustmentDebitCount ?? 0)
          finalizedUntouched += Number(result.finalizedAdjustmentUntouchedCount ?? 0)
        }
      }
      const result = { generated, finalizedSkipped, finalizedStorageSkipped, finalizedAdjustments }
      const finalizedGroupSkipped = finalizedSkipped + finalizedStorageSkipped
      const finalizedNote = [
        finalizedAdjustments > 0
          ? `${finalizedAdjustments} current-period adjustment${finalizedAdjustments === 1 ? '' : 's'} (${finalizedCredits} credit, ${finalizedDebits} debit)`
          : '',
        finalizedUntouched > 0
          ? `${finalizedUntouched} finalized order${finalizedUntouched === 1 ? '' : 's'} unchanged`
          : '',
        finalizedStorageSkipped > 0
          ? `${finalizedStorageSkipped} finalized storage period${finalizedStorageSkipped === 1 ? '' : 's'}`
          : '',
      ].filter(Boolean).join(' and ')
      if (!silent) {
        if (generated > 0) {
          const finalizedSuffix = finalizedNote ? `; ${finalizedNote}` : ''
          toastContext?.addToast(`Billing ${forceRegenerate ? 'regenerated' : 'updated'}: ${result.generated} line items${finalizedSuffix}`, 'success')
        } else if (finalizedGroupSkipped > 0 || finalizedAdjustments > 0 || finalizedUntouched > 0) {
          toastContext?.addToast(finalizedNote, 'success')
        } else {
          toastContext?.addToast('Billing is already up to date', 'success')
        }
      }

      // FE-2 (audit 2.2 slice 2): post-generate freshness via key invalidation —
      // the active summary/margin queries refetch immediately, which is the same
      // two requests the old manual Promise.all fired (generateBilling already
      // invalidated the canonical endpoint entries). throwOnError preserves the
      // old semantics: a failed refresh rejects into the catch below and toasts.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: endpointQueryKeys.billingSummaryRoot }, { throwOnError: true }),
        queryClient.invalidateQueries({ queryKey: endpointQueryKeys.shippingMarginRoot }, { throwOnError: true }),
      ])
      const rows = queryClient.getQueryData<BillingSummaryDto[]>(
        endpointQueryKeys.billingSummary(from, to, billingClientQueryIds),
      ) ?? []
      const rowsForStatus = targetClientIds.length > 0
        ? rows.filter((row) => targetClientIds.includes(Number(row.clientId)))
        : rows
      const totals = buildBillingSummaryTotals(rowsForStatus)
      const finalizedStatus = finalizedNote ? ` · ${finalizedNote}` : ''
      setStatus(`${generated > 0 ? buildGenerateBillingStatus(result.generated, totals.grand) : `Billing already up to date - total ${formatBillingMoney(totals.grand)}`}${finalizedStatus}`)
      // Generated line items make every cached details payload stale. The open
      // panel's active query refetches now (awaited, errors staying panel-local
      // exactly like the old handleLoadDetails catch); cached clients refetch
      // when next opened — the old always-fetch-fresh-on-open result.
      await queryClient.invalidateQueries({ queryKey: ['billing', 'details'] })
      const detailTarget =
        detailState.open && detailState.clientId
          ? rowsForStatus.find((row) => row.clientId === detailState.clientId)
          : rowsForStatus.find((row) => (row.orderCount || 0) > 0 || (row.grandTotal || row.total || 0) > 0)
      if (detailTarget) {
        // ?? '' — the summary DTO's clientName is nullable; the old any[] rows
        // passed null through untyped, and every consumer already handled it
        // via `|| ''`-style fallbacks, so empty string is behavior-identical.
        handleLoadDetails(detailTarget.clientId, detailTarget.clientName ?? '')
      }
    } catch (error) {
      if (!silent) toastContext?.addToast(error instanceof Error ? error.message : 'Failed to update billing', 'error')
    } finally {
      billingUpdateRunningRef.current = false
      if (!silent) setGenerateLoading(false)
    }
  }

  function handleLoadDetails(clientId: number, clientName: string) {
    setDetailPage(1)
    // Opening a client keys the ['billing','details'] query: first open fetches,
    // re-opening a cached client within staleTime paints instantly with zero
    // requests, and an invalidated (post-mutation) client refetches — the same
    // outcomes the old imperative fetch produced, minus the redundant refires.
    setDetailState({
      open: true,
      clientId,
      clientName,
    })

    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        detailWrapRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      })
    }
  }

  function handleRequestBillingFinalize() {
    if (detailState.clientId == null) return
    setBillingFinalizeIntent({
      clientId: detailState.clientId,
      clientName: detailState.clientName,
      dateFrom: from,
      dateTo: to,
    })
  }

  async function handleFinalizeBillingPeriod() {
    const intent = billingFinalizeIntent
    if (!intent || billingFinalizeLoading) return

    setBillingFinalizeLoading(true)
    try {
      const response = await api.post<{
        data: { finalization: BillingFinalizationDto; alreadyFinalized: boolean }
      }>('/billing/finalize', {
        clientId: intent.clientId,
        dateFrom: intent.dateFrom,
        dateTo: intent.dateTo,
      })
      const result = response.data
      const queryKey = ['billing', 'finalizations', intent.dateFrom, intent.dateTo, intent.clientId] as const
      queryClient.setQueryData<BillingFinalizationDto[]>(queryKey, (current) => {
        const rows = current ?? []
        return rows.some((row) => row.id === result.finalization.id)
          ? rows.map((row) => row.id === result.finalization.id ? result.finalization : row)
          : [result.finalization, ...rows]
      })

      if (
        detailState.clientId === intent.clientId
        && from === intent.dateFrom
        && to === intent.dateTo
      ) {
        setSelectedFinalizationId(result.finalization.id)
        setBillingEditModal(null)
        setBulkBoxCostOpen(false)
        setBoxReviewSweepOpen(false)
        setHugrabShippingFloorOpen(false)
      }
      setBillingFinalizeIntent(null)
      void queryClient.invalidateQueries({ queryKey: ['billing', 'finalizations'] })
      void queryClient.invalidateQueries({ queryKey: ['billing', 'details', intent.dateFrom, intent.dateTo, intent.clientId] })
      toastContext?.addToast(
        result.alreadyFinalized ? 'Billing period was already finalized' : 'Billing period finalized and locked',
        'success',
      )
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Failed to finalize billing period', 'error')
    } finally {
      setBillingFinalizeLoading(false)
    }
  }

  async function handleCreateBillingCredit(draft: BillingCreditDraft): Promise<boolean> {
    const clientId = detailState.clientId
    if (clientId == null || billingCreditSubmitting) return false

    setBillingCreditSubmitting(true)
    try {
      const response = await api.post<{
        data: {
          creditNote: BillingCreditNoteDto
          finalization: BillingFinalizationDto
          alreadyCreated: boolean
        }
      }>('/billing/credit-notes', {
        clientId,
        finalizationId: draft.finalizationId,
        adjustmentKind: draft.adjustmentKind,
        amount: draft.amount,
        reason: draft.reason,
        idempotencyKey: draft.idempotencyKey,
      })
      const result = response.data
      queryClient.setQueryData<BillingFinalizationDto[]>(
        ['billing', 'finalizations', from, to, clientId],
        (current) => (current ?? []).map((row) => (
          row.id === result.finalization.id ? result.finalization : row
        )),
      )
      queryClient.setQueryData<BillingCreditNoteDto[]>(
        ['billing', 'credit-notes', clientId, draft.finalizationId],
        (current) => {
          const rows = current ?? []
          return rows.some((row) => row.id === result.creditNote.id)
            ? rows.map((row) => row.id === result.creditNote.id ? result.creditNote : row)
            : [...rows, result.creditNote]
        },
      )
      void queryClient.invalidateQueries({ queryKey: ['billing', 'finalizations'] })
      void queryClient.invalidateQueries({ queryKey: ['billing', 'credit-notes', clientId, draft.finalizationId] })
      toastContext?.addToast(
        result.alreadyCreated ? 'Billing adjustment already exists' : 'Billing adjustment created',
        'success',
      )
      return true
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Failed to create billing adjustment', 'error')
      return false
    } finally {
      setBillingCreditSubmitting(false)
    }
  }

  async function refreshBillingAfterHugrabFloor() {
    try {
      // Same refresh set the old manual Promise.all fetched — summary + margin +
      // (only if a panel is open) details — via key invalidation: only ACTIVE
      // queries refetch, so a closed panel fires no details request, exactly like
      // the old Promise.resolve(null) branch. throwOnError keeps the old
      // semantics: any refetch failure rejects into the catch below and toasts.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: endpointQueryKeys.billingSummaryRoot }, { throwOnError: true }),
        queryClient.invalidateQueries({ queryKey: endpointQueryKeys.shippingMarginRoot }, { throwOnError: true }),
        queryClient.invalidateQueries({ queryKey: ['billing', 'details'] }, { throwOnError: true }),
      ])
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Failed to refresh billing rows', 'error')
    }
  }

  function handleOpenBillingEdit(row: BillingDetailDto) {
    if (billingPeriodReadOnlyReason) {
      toastContext?.addToast(`${billingPeriodReadOnlyReason}. Use a credit memo for finalized corrections.`, 'error')
      return
    }
    if (!row.orderId || !detailState.clientId) return
    setBillingEditModal((current) => {
      const cache = current
        ? rememberBillingEditDraft(billingEditDraftCacheRef.current, current.row, current.draft)
        : billingEditDraftCacheRef.current
      billingEditDraftCacheRef.current = cache
      return {
        row,
        draft: billingEditDraftForRow(cache, row, createBillingEditDraft(row)),
        saving: false,
        error: null,
      }
    })
    // The client's saved package prices (to auto-fill Box Cost on Box Size
    // change) load via billingEditPackagePricesQuery, which enables itself when
    // this modal state opens — same trigger as the old imperative fetch here.
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

  // PS — pasted Box Size / Shipping corrections. Each row goes through the SAME
  // audited detail PATCH a manual edit uses, so finalized-invoice refusal,
  // permissions and the before/after audit row are unchanged. The import adds no
  // second write path; it only saves the operator typing each row by hand.
  // clientId is a parameter, not a gate: the modal only renders with a client
  // selected, and a resolved `ready` row has a non-null orderId by type. Nothing
  // here decides whether the edit is permitted — the backend still does.
  async function handleBulkImportRow(clientId: number, row: BulkImportReadyRow, reason: string) {
    const current = detailRows.find((detail) => Number(detail.orderId ?? detail.order_id) === row.orderId)
    await apiClient.updateBillingDetail(row.orderId, clientId, {
      // Only the pasted fields move; everything else is resent at its current value.
      pickPack: Number(current?.pickPack ?? current?.pick_pack ?? 0) || 0,
      additional: Number(current?.additional ?? 0) || 0,
      // Same rule the manual Box Size change applies: a new box takes that box's
      // saved client price. Falls back to the current cost when the client has no
      // price row for it, exactly as handleBillingEditPackageChange does.
      packageCost: row.packageId != null && billingEditPackagePrices[row.packageId] != null
        ? billingEditPackagePrices[row.packageId]
        : Number(current?.packageCost ?? current?.package_cost ?? 0) || 0,
      shipping: row.shipping != null
        ? row.shipping
        : Number(current?.shipping ?? 0) || 0,
      packageId: row.packageId != null
        ? row.packageId
        : (current?.packageId ? Number(current.packageId) : null),
      reason,
    }, { deferReads: true })
  }

  async function handleBulkImportFinished() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['billing', 'details'] }),
      queryClient.invalidateQueries({ queryKey: endpointQueryKeys.billingSummaryRoot }),
      queryClient.invalidateQueries({ queryKey: endpointQueryKeys.shippingMarginRoot }),
    ])
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
        reason: billingEditModal.draft.reason.trim(),
      })

      // PS-375: refresh details + summary + margin after the PATCH — the same
      // three requests the old Promise.all fired, via key invalidation (the PATCH
      // already invalidated the canonical endpoint entries; the open panel's rows
      // swap in when its active query settles). throwOnError preserves the old
      // semantics: a failed refresh rejects into the catch below (modal stays
      // open with the error) instead of silently showing stale rows.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['billing', 'details'] }, { throwOnError: true }),
        queryClient.invalidateQueries({ queryKey: endpointQueryKeys.billingSummaryRoot }, { throwOnError: true }),
        queryClient.invalidateQueries({ queryKey: endpointQueryKeys.shippingMarginRoot }, { throwOnError: true }),
      ])
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

      // Same re-pull the old Promise.all did (details + summary + margin) via key
      // invalidation, so the badge updates immediately from the refreshed rows.
      // throwOnError: a failed refresh rejects into the catch below and toasts.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['billing', 'details'] }, { throwOnError: true }),
        queryClient.invalidateQueries({ queryKey: endpointQueryKeys.billingSummaryRoot }, { throwOnError: true }),
        queryClient.invalidateQueries({ queryKey: endpointQueryKeys.shippingMarginRoot }, { throwOnError: true }),
      ])
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

      // Same zero-request local update the old setSavedPackagePrices applied, now
      // written to the client's ['billing','package-prices'] cache entry (the PUT
      // already invalidated the canonical endpoint entry). The per-client seed ref
      // above keeps the operator's draft strings untouched by this patch.
      queryClient.setQueryData<BillingPackagePriceDto[]>(
        endpointQueryKeys.billingPackagePrices(Number(selectedPkgClientId)),
        packagePricingRows.map((row) => ({
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
        })),
      )
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
            setActivePreset(preset)
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
          detailState={detailStateForView}
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
              loading={detailLoading}
              isHugrabClient={isHugrabDetailClient}
              readOnlyReason={billingPeriodReadOnlyReason}
              columnsAnchorRef={setDetailColumnsAnchorEl}
              onClose={() => setDetailState((current) => ({ ...current, open: false }))}
              onOpenWarningRow={handleOpenBillingEdit}
              onOpenHugrabBulk={() => setHugrabShippingFloorOpen(true)}
            />

            <BillingDetailClientStrip
              sortedSummaryRows={sortedSummaryRows}
              detailState={detailStateForView}
              selectedDetailSummary={selectedDetailSummary}
              onLoadDetails={handleLoadDetails as unknown as (clientId: number, clientName: string | null | undefined) => void}
            />

            {detailState.clientId != null ? (
              <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '6px 0' }}>
                <button
                  data-billing-bulk-import-trigger
                  className="btn btn-secondary btn-xs"
                  type="button"
                  onClick={() => setBulkImportOpen(true)}
                >
                  Import Box Size &amp; Shipping...
                </button>
              </div>
            ) : null}

            <BillingCloseWorkflowPanel
              clientName={detailState.clientName}
              dateFrom={from}
              dateTo={to}
              finalizations={billingFinalizations}
              selectedFinalizationId={activeFinalizationId}
              creditNotes={billingCreditNotes}
              statusLoading={billingFinalizationStatusLoading}
              statusError={billingFinalizationStatusError}
              creditNotesLoading={Boolean(activeFinalizationId) && billingCreditNotesQuery.isPending}
              creditNotesError={billingCreditNotesError}
              creditSubmitting={billingCreditSubmitting}
              onSelectFinalization={setSelectedFinalizationId}
              onRequestFinalize={handleRequestBillingFinalize}
              onCreateCredit={handleCreateBillingCredit}
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
              detailState={detailStateForView}
              detailPanelState={detailPanelState}
              selectedSummaryOrders={selectedSummaryOrders}
              selectedSummaryTotal={selectedSummaryTotal}
              sortedDetailRows={sortedDetailRows}
              detailTotals={detailTotals as { pickPack: number; additional: number; packageCost: number; shipping: number; total: number; margin: number }}
              columnsAnchorEl={detailColumnsAnchorEl}
              readOnlyReason={billingPeriodReadOnlyReason}
              onOpenBillingEdit={handleOpenBillingEdit}
              onOpenOrderDetail={setOrderDetailModalId}
              onOpenStorageProof={(row) => {
                const day = String(row.actualActivityDate ?? row.shipDate ?? '').slice(0, 10)
                if (day) setStorageProofDay(day)
              }}
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

      {storageProofDay && detailState.clientId != null ? (
        <BillingStorageProofModal
          clientId={detailState.clientId}
          clientName={detailState.clientName}
          from={storageProofDay}
          to={storageProofDay}
          onClose={() => setStorageProofDay(null)}
        />
      ) : null}

      {billingEditModal ? (
        <BillingEditDetailModal
          modal={billingEditModal}
          packages={packages}
          clientPricedPackageIds={billingEditPricedPackageIds}
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

      {bulkImportOpen && detailState.clientId != null ? (
        <BillingBulkImportModal
          clientName={detailState.clientName || ''}
          detailRows={detailRows}
          packages={packages}
          onClose={() => setBulkImportOpen(false)}
          onApplyRow={(row, reason) => handleBulkImportRow(detailState.clientId as number, row, reason)}
          onFinished={handleBulkImportFinished}
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
          // Same refresh set the old callback fetched manually: summary (errors
          // swallowed, like the old .catch(() => {})) + the open client's details.
          // Margin analytics was NOT refreshed here, so its key is deliberately
          // not invalidated ("nothing more" than the old request set).
          void queryClient.invalidateQueries({ queryKey: endpointQueryKeys.billingSummaryRoot }).catch(() => {})
          if (detailState.clientId != null) {
            void queryClient.invalidateQueries({ queryKey: ['billing', 'details'] })
            void handleLoadDetails(detailState.clientId, detailState.clientName || '')
          }
        }}
        onCloseBoxReviewSweep={() => setBoxReviewSweepOpen(false)}
        onBoxReviewSweepApplied={() => {
          // Same refresh set as onBulkBoxCostApplied above (summary + open details).
          void queryClient.invalidateQueries({ queryKey: endpointQueryKeys.billingSummaryRoot }).catch(() => {})
          if (detailState.clientId != null) {
            void queryClient.invalidateQueries({ queryKey: ['billing', 'details'] })
            void handleLoadDetails(detailState.clientId, detailState.clientName || '')
          }
        }}
        onCloseHugrabShippingFloor={() => setHugrabShippingFloorOpen(false)}
        onHugrabShippingFloorApplied={() => {
          void refreshBillingAfterHugrabFloor()
        }}
      />

      <ConfirmModal
        open={billingFinalizeIntent != null}
        title="Finalize this billing period?"
        description={billingFinalizeIntent ? (
          <>
            Close <strong>{billingFinalizeIntent.clientName}</strong> for{' '}
            <strong>{billingFinalizeIntent.dateFrom} → {billingFinalizeIntent.dateTo}</strong>. The backend will
            freeze the invoice lines and totals. This cannot be undone; later corrections post as current-period credit or debit adjustments.
          </>
        ) : null}
        confirmLabel="Finalize and lock"
        cancelLabel="Keep open"
        tone="info"
        loading={billingFinalizeLoading}
        onConfirm={() => { void handleFinalizeBillingPeriod() }}
        onCancel={() => {
          if (!billingFinalizeLoading) setBillingFinalizeIntent(null)
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
