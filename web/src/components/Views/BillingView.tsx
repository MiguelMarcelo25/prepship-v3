// @ts-nocheck
import { lazy, Suspense, useContext, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from 'react'
import { motion } from 'framer-motion'
import { Check, ListFilter, Loader2, Pencil, Receipt, SlidersHorizontal, X } from 'lucide-react'
import { apiClient } from '../../api/client'
import { ToastContext } from '../../contexts/ToastContext'
import type {
  BillingConfigDto,
  BillingDetailDto,
  BillingPackagePriceDto,
  BillingSummaryDto,
  PackageDto,
} from '../../types/api'
import {
  BILLING_DETAIL_COLUMNS,
  aggregateBillingDetailRowsByOrder,
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
  formatBillingDateTime,
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
  type BillingDetailColumnId,
  type BillingPresetId,
} from './billing-parity'
import { AnalysisPagination } from './AnalysisPagination'
import { nextSortState, sortRows } from '../SortableTable'
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
// PS-155: Client Billing Config + Package Pricing tables extracted (behavior-preserving; the
// config/price DRAFT state + setters and the Save handlers stay here and are passed as props).
import { BillingConfigTable } from './BillingConfigTable'
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
  bestRate: 100,
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
    case 'bestRate': return row.actualLabelCost
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
  const [activePreset, setActivePreset] = useState<BillingPresetId>('last_30')
  const [from, setFrom] = useState(initialRange.from)
  const [to, setTo] = useState(initialRange.to)
  const [summaryRows, setSummaryRows] = useState<BillingSummaryDto[]>([])
  const [clientFilterOpen, setClientFilterOpen] = useState(false)
  const [selectedBillingClientIds, setSelectedBillingClientIds] = useState<number[]>(readBillingClientFilterIds)
  const [summarySort, setSummarySort] = useState(null)
  const [detailSort, setDetailSort] = useState(null)
  const [summaryPage, setSummaryPage] = useState(1)
  const [summaryPageSize, setSummaryPageSize] = useState(25)
  const [summaryLoading, setSummaryLoading] = useState(true)
  const [summaryError, setSummaryError] = useState<string | null>(null)
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
    () => buildBillingPackagePriceRows(packages, savedPackagePrices, packagePriceDrafts),
    [packages, savedPackagePrices, packagePriceDrafts],
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
  // Collapse per-lineType API rows into one row per order. Without this
  // the same order shows up 2-5 times in the table — once per fee type
  // — which is what we're fixing here.
  const mergedDetailRows = useMemo(
    () => aggregateBillingDetailRowsByOrder(detailState.rows),
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
        case 'bestRate':
          return row.actualLabelCost
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
          return nextConfigs.length > 0 ? String(nextConfigs[0].clientId) : ''
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
        const nextRows = buildBillingPackagePriceRows(packages, rows)
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
  }, [packages, selectedPkgClientId])

  useEffect(() => {
    if (!from || !to) return

    let active = true

    const loadSummary = async () => {
      setSummaryLoading(true)
      setSummaryError(null)

      try {
        const rows = await apiClient.fetchBillingSummary(from, to)
        if (!active) return
        setSummaryRows(rows)
      } catch (error) {
        if (!active) return
        setSummaryRows([])
        setSummaryError(error instanceof Error ? error.message : 'Error loading summary')
      } finally {
        if (active) setSummaryLoading(false)
      }
    }

    void loadSummary()

    return () => {
      active = false
    }
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

  async function handleGenerateBilling(forceRegenerate = false) {
    if (!from || !to) {
      toastContext?.addToast('Select a date range first', 'error')
      return
    }

    if (forceRegenerate && regenerateRangeBlocked) {
      toastContext?.addToast('Regenerate Range is limited to 120 days. Use Update Billing for All/history.', 'error')
      return
    }

    if (
      forceRegenerate &&
      typeof window !== 'undefined' &&
      !window.confirm(`Regenerate billing for ${selectedBillingRangeDays} day(s)? This rebuild is slower than Update Billing.`)
    ) {
      return
    }

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
          const clientId = targetClientIds[index]
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
          const batch = batches[index]
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

      const rows = await apiClient.fetchBillingSummary(from, to)
      const rowsForStatus = targetClientIds.length > 0
        ? rows.filter((row) => targetClientIds.includes(Number(row.clientId)))
        : rows
      const totals = buildBillingSummaryTotals(rowsForStatus)
      setGenerateStatus(generated > 0 ? buildGenerateBillingStatus(result.generated, totals.fulfillmentFee) : `Billing already up to date - total ${formatBillingMoney(totals.fulfillmentFee)}`)
      setSummaryRows(rows)
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
        apiClient.fetchBillingSummary(from, to).then((nextRows) => {
          setSummaryRows(nextRows)
          setSummaryError(null)
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

  async function handleSavePackagePrices() {
    if (!selectedPkgClientId) {
      toastContext?.addToast('Select a client first', 'error')
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
        is_custom: row.isCustom ? 1 : 0,
        name: row.name,
        length: packages.find((pkg) => pkg.packageId === row.packageId)?.length ?? null,
        width: packages.find((pkg) => pkg.packageId === row.packageId)?.width ?? null,
        height: packages.find((pkg) => pkg.packageId === row.packageId)?.height ?? null,
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
    <div id="view-billing" className="view-content !p-5 !overflow-y-auto">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        className="flex items-center gap-3 mb-5"
      >
        <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-600 flex items-center justify-center shadow-md ring-1 ring-emerald-400/20">
          <Receipt size={20} strokeWidth={2.25} className="text-white" />
        </div>
        <div>
          <h2 className="text-[16px] font-extrabold text-ink font-display tracking-tight">Billing Dashboard</h2>
          <p className="text-tiny text-ink-3 mt-0.5">Per-client billing config, package pricing and invoice history</p>
        </div>
      </motion.div>

      <div className="billing-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, marginBottom: 18 }}>
        {/* PS-155: Client Billing Config table extracted to <BillingConfigTable />.
            The config DRAFT state (configDrafts) + setter and the Save handler
            (handleSaveConfig → buildBillingConfigInput → updateBillingConfig) stay here. */}
        <BillingConfigTable
          configs={configs}
          configsLoading={configsLoading}
          configDrafts={configDrafts}
          setConfigDrafts={setConfigDrafts}
          onSaveConfig={handleSaveConfig}
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

      <div className="markup-card">
        <h3 style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 12 }}>Generate &amp; Summary</h3>

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
          onRegenerate={() => void handleGenerateBilling(true)}
          onBackfillRefRates={() => void handleBackfillRefRates()}
          onFetchRefRates={() => void handleFetchRefRates()}
        />

        <BillingClientFilterPanel
          clientFilterOpen={clientFilterOpen}
          selectedBillingClientCount={selectedBillingClientCount}
          availableBillingClients={availableBillingClients}
          summaryRowsLength={summaryRows.length}
          billingClientFilterActive={billingClientFilterActive}
          excludedBillingClientNames={excludedBillingClientNames}
          selectedBillingClientIdSet={selectedBillingClientIdSet}
          missingShipStationClientNames={missingShipStationClientNames}
          onToggleAdvanced={() => setClientFilterOpen((open) => !open)}
          onSelectShipStation={handleSelectShipStationBillingClients}
          onSelectAll={handleSelectAllBillingClients}
          onToggleClient={handleToggleBillingClient}
        />

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
        />

        {detailState.open ? (
          <div ref={detailWrapRef} style={{ display: 'block', marginTop: 16, borderTop: '2px solid var(--border)', paddingTop: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <h3 style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', margin: 0 }}>Line Items — {detailState.clientName}</h3>
              <button className="btn btn-ghost btn-xs" type="button" onClick={() => setDetailState((current) => ({ ...current, open: false }))}>✕ Close</button>
            </div>

            <BillingDetailClientStrip
              sortedSummaryRows={sortedSummaryRows}
              detailState={detailState}
              selectedDetailSummary={selectedDetailSummary}
              onLoadDetails={handleLoadDetails}
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
              detailTotals={detailTotals}
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
              <div><span>Ship Date</span><strong>{formatBillingDateTime(billingEditModal.row.shipDate)}</strong></div>
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
              <div><span>Best Rate</span><strong>{formatBillingMoney(billingEditModal.row.actualLabelCost, { dashIfZero: true })}</strong></div>
              <div><span>UPS SS</span><strong>{formatBillingMoney(billingEditModal.row.ref_ups_rate, { dashIfZero: true })}</strong></div>
              <div><span>USPS SS</span><strong>{formatBillingMoney(billingEditModal.row.ref_usps_rate, { dashIfZero: true })}</strong></div>
            </div>

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
