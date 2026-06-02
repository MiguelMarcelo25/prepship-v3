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
const BILLING_SUMMARY_PAGE_SIZE_OPTIONS = [10, 25, 50, 100]
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
    case 'pickpack': return metrics.pickPackFee
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

function getPackageMarginMarkup(row: ReturnType<typeof buildBillingPackagePriceRows>[number]) {
  if (row.marginPct == null || !row.marginColor) {
    return <span style={{ color: 'var(--text4)' }}>—</span>
  }

  return <span style={{ color: row.marginColor, fontWeight: 700 }}>{row.marginPct}%</span>
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
  const [activePreset, setActivePreset] = useState<BillingPresetId>('last_90')
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
          return metrics.pickPackFee
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
        pickPack: acc.pickPack + metrics.pickPackFee,
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

  // Editable numeric cell for the Client Billing Config <Table>. The input
  // fills the cell (width:100%) and right-aligns its own text; the column's
  // `align:'right'` only drives the header label, so the numeric look comes
  // from this inline style (Table hardcodes cell text-align to left).
  function renderConfigNumberCell(
    config: BillingConfigDto,
    field: keyof BillingConfigDraft,
    fallback: string,
    step: string,
    min: string,
    title?: string,
  ) {
    const draft = configDrafts[config.clientId]
    return (
      <input
        type="number"
        step={step}
        min={min}
        className="markup-input-lg billing-config-input"
        style={{ width: '100%', textAlign: 'right', fontSize: 11.5 }}
        title={title}
        value={draft?.[field] ?? fallback}
        onChange={(event) => setConfigDrafts((current) => ({
          ...current,
          [config.clientId]: { ...current[config.clientId], [field]: event.target.value },
        }))}
      />
    )
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
        <div className="markup-card">
          <h3 style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 10 }}>Client Billing Config</h3>
          <div className="billing-config-table-wrap">
            <Table<BillingConfigDto>
              data={configs}
              rowKey={(row) => row.clientId}
              storageKey="billing-config-table"
              density="compact"
              stickyHeader={false}
              showColumnControls={false}
              loading={configsLoading}
              emptyMessage="No clients found."
              defaultSort={{ key: 'client', direction: 'asc' }}
              columns={[
                {
                  key: 'client',
                  label: 'Client',
                  width: 150,
                  minWidth: 120,
                  pinned: true,
                  hideable: false,
                  sortable: true,
                  sortValue: (row) => row.clientName ?? '',
                  render: (row) => <span style={{ fontWeight: 600, fontSize: 11.5 }}>{row.clientName}</span>,
                },
                {
                  key: 'pickPack',
                  label: 'Pick & Pack',
                  width: 84,
                  minWidth: 70,
                  align: 'right',
                  sortable: true,
                  sortValue: (row) => Number(configDrafts[row.clientId]?.pickPackFee ?? row.pickPackFee ?? 0),
                  render: (row) => renderConfigNumberCell(row, 'pickPackFee', '0.00', '0.01', '0'),
                },
                {
                  key: 'additional',
                  label: 'Addl Unit',
                  width: 84,
                  minWidth: 70,
                  align: 'right',
                  sortable: true,
                  sortValue: (row) => Number(configDrafts[row.clientId]?.additionalUnitFee ?? row.additionalUnitFee ?? 0),
                  render: (row) => renderConfigNumberCell(row, 'additionalUnitFee', '0.00', '0.01', '0'),
                },
                {
                  key: 'packageMarkup',
                  label: 'Pkg %',
                  width: 76,
                  minWidth: 64,
                  align: 'right',
                  sortable: true,
                  sortValue: (row) => Number(configDrafts[row.clientId]?.packageCostMarkup ?? row.packageCostMarkup ?? 0),
                  render: (row) => renderConfigNumberCell(row, 'packageCostMarkup', '0.0', '0.1', '0', 'Markup applied to package cost lines (percent)'),
                },
                {
                  key: 'shipPct',
                  label: 'Ship %',
                  width: 76,
                  minWidth: 64,
                  align: 'right',
                  sortable: true,
                  sortValue: (row) => Number(configDrafts[row.clientId]?.shippingMarkupPct ?? row.shippingMarkupPct ?? 0),
                  render: (row) => renderConfigNumberCell(row, 'shippingMarkupPct', '0.0', '0.1', '0'),
                },
                {
                  key: 'shipFlat',
                  label: 'Ship $',
                  width: 84,
                  minWidth: 70,
                  align: 'right',
                  sortable: true,
                  sortValue: (row) => Number(configDrafts[row.clientId]?.shippingMarkupFlat ?? row.shippingMarkupFlat ?? 0),
                  render: (row) => renderConfigNumberCell(row, 'shippingMarkupFlat', '0.00', '0.01', '0'),
                },
                {
                  key: 'storage',
                  label: 'Storage $/cuft',
                  width: 96,
                  minWidth: 80,
                  align: 'right',
                  sortable: true,
                  sortValue: (row) => Number(configDrafts[row.clientId]?.storageFeePerCuFt ?? row.storageFeePerCuFt ?? 0),
                  render: (row) => renderConfigNumberCell(row, 'storageFeePerCuFt', '0.00', '0.01', '0', '$/cuft/month storage fee applied to inventory on hand'),
                },
                {
                  key: 'maxUnits',
                  label: 'Max Units',
                  width: 84,
                  minWidth: 70,
                  align: 'right',
                  sortable: true,
                  sortValue: (row) => Number(configDrafts[row.clientId]?.pickPackMaxUnits ?? row.pickPackMaxUnits ?? 0),
                  render: (row) => renderConfigNumberCell(row, 'pickPackMaxUnits', '1', '1', '1', 'Orders with total units ≤ this value pay only the base Pick & Pack fee; excess units are billed at the Addl Unit rate'),
                },
                {
                  key: 'mode',
                  label: 'Mode',
                  width: 118,
                  minWidth: 100,
                  align: 'center',
                  sortable: true,
                  sortValue: (row) => configDrafts[row.clientId]?.billingMode ?? row.billingMode ?? '',
                  render: (row) => {
                    const draft = configDrafts[row.clientId]
                    return (
                      <select
                        className="ship-select billing-config-select"
                        style={{ width: '100%', fontSize: 10, padding: '2px 4px', borderRadius: 4, border: '1px solid var(--border)' }}
                        value={draft?.billingMode ?? 'per_shipment'}
                        onChange={(event) => setConfigDrafts((current) => ({
                          ...current,
                          [row.clientId]: { ...current[row.clientId], billingMode: event.target.value },
                        }))}
                      >
                        <option value="label_cost">Label Cost</option>
                        <option value="ss_ref_rate">SS Ref Rate ★</option>
                        <option value="per_shipment">Per Shipment</option>
                        <option value="monthly">Monthly</option>
                      </select>
                    )
                  },
                },
                {
                  key: 'active',
                  label: 'Active',
                  width: 64,
                  minWidth: 52,
                  align: 'center',
                  sortable: true,
                  sortValue: (row) => (configDrafts[row.clientId]?.active ?? row.active ?? true) ? 1 : 0,
                  render: (row) => {
                    const draft = configDrafts[row.clientId]
                    return (
                      <input
                        type="checkbox"
                        checked={draft?.active !== false}
                        title="Disable to skip billing-line generation for this client"
                        onChange={(event) => setConfigDrafts((current) => ({
                          ...current,
                          [row.clientId]: { ...current[row.clientId], active: event.target.checked },
                        }))}
                      />
                    )
                  },
                },
                {
                  key: 'actions',
                  label: '',
                  width: 70,
                  minWidth: 60,
                  align: 'center',
                  sortable: false,
                  hideable: false,
                  render: (row) => (
                    <button className="btn btn-outline btn-xs" type="button" onClick={() => void handleSaveConfig(row.clientId)}>Save</button>
                  ),
                },
              ]}
            />
          </div>
        </div>

        <div className="markup-card">
          <div className="billing-package-card-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, gap: 8, flexWrap: 'wrap' }}>
            <h3 style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.4px', margin: 0 }}>Package Pricing by Client</h3>
            <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
              <select className="filter-sel" style={{ fontSize: 12 }} value={selectedPkgClientId} onChange={(event) => setSelectedPkgClientId(event.target.value)}>
                <option value="">Select client…</option>
                {configs.map((config) => (
                  <option key={config.clientId} value={config.clientId}>{config.clientName}</option>
                ))}
              </select>
              <button className="btn btn-primary btn-sm" type="button" onClick={() => void handleSavePackagePrices()}>Save</button>
            </div>
          </div>
          <div className="billing-package-table-wrap">
            {!selectedPkgClientId ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>Select a client to view pricing</div>
            ) : packagePricingError ? (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--red)', fontSize: 12 }}>{packagePricingError}</div>
            ) : (
              <Table
                data={packagePricingRows}
                rowKey={(row) => row.packageId}
                storageKey="billing-package-pricing-table"
                density="compact"
                stickyHeader={false}
                showColumnControls={false}
                loading={packagePricingLoading}
                emptyMessage="No custom packages found"
                defaultSort={{ key: 'box', direction: 'asc' }}
                columns={[
                  {
                    key: 'box',
                    label: 'Box',
                    width: 150,
                    minWidth: 110,
                    pinned: true,
                    hideable: false,
                    sortable: true,
                    sortValue: (row) => row.name ?? '',
                    render: (row) => (
                      <span style={{ fontWeight: 600, fontSize: 12 }}>
                        {row.name}
                        {row.isCustom ? (
                          <span title="Custom override — won't be changed by Set Default" style={{ fontSize: 9, color: 'var(--ss-blue)', marginLeft: 4, fontWeight: 600, letterSpacing: '.3px' }}>CUSTOM</span>
                        ) : null}
                      </span>
                    ),
                  },
                  {
                    key: 'dims',
                    label: 'Dims',
                    width: 120,
                    minWidth: 90,
                    align: 'center',
                    sortable: true,
                    sortValue: (row) => row.dimsText ?? '',
                    render: (row) => <span style={{ fontSize: 11, color: 'var(--text3)' }}>{row.dimsText}</span>,
                  },
                  {
                    key: 'cost',
                    label: 'Our Cost',
                    width: 92,
                    minWidth: 76,
                    align: 'right',
                    sortable: true,
                    sortValue: (row) => row.ourCost,
                    render: (row) => (
                      <span style={{ textAlign: 'right', display: 'block', fontSize: 11.5 }}>
                        {row.ourCost == null ? (
                          <span style={{ color: 'var(--text4)', fontSize: 10.5 }}>not set</span>
                        ) : (
                          <span style={{ color: 'var(--text2)' }}>${row.ourCost.toFixed(3)}</span>
                        )}
                      </span>
                    ),
                  },
                  {
                    key: 'charge',
                    label: 'Charge',
                    width: 92,
                    minWidth: 76,
                    align: 'right',
                    sortable: true,
                    sortValue: (row) => Number(packagePriceDrafts[row.packageId] ?? row.charge ?? 0),
                    render: (row) => (
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        className="markup-input-lg billing-config-input"
                        style={{ width: '100%', textAlign: 'right', fontSize: 12 }}
                        value={packagePriceDrafts[row.packageId] ?? (Number(row.charge) || 0).toFixed(2)}
                        onChange={(event) => setPackagePriceDrafts((current) => ({
                          ...current,
                          [row.packageId]: event.target.value,
                        }))}
                      />
                    ),
                  },
                  {
                    key: 'margin',
                    label: 'Margin',
                    width: 84,
                    minWidth: 64,
                    align: 'right',
                    sortable: true,
                    sortValue: (row) => row.marginPct,
                    render: (row) => <span style={{ display: 'block', textAlign: 'right' }}>{getPackageMarginMarkup(row)}</span>,
                  },
                ]}
              />
            )}
          </div>
        </div>
      </div>

      <div className="markup-card">
        <h3 style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 12 }}>Generate &amp; Summary</h3>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {([
              ['all', 'All'],
              ['this_month', 'This Month'],
              ['last_month', 'Last Month'],
              ['last_30', 'Last 30 Days'],
              ['last_90', 'Last 90 Days'],
            ] as Array<[BillingPresetId, string]>).map(([preset, label]) => (
              <button
                key={preset}
                className={`btn btn-outline btn-sm analysis-preset${activePreset === preset ? ' active' : ''}`}
                type="button"
                onClick={() => {
                  const range = getBillingPresetRange(preset)
                  setActivePreset(preset)
                  setFrom(range.from)
                  setTo(range.to)
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--text2)' }}>
            <span>From</span>
            <input type="date" className="ship-select" style={{ width: 140, fontSize: 12 }} value={from} onChange={(event) => {
              setActivePreset(null)
              setFrom(event.target.value)
            }} />
            <span>To</span>
            <input type="date" className="ship-select" style={{ width: 140, fontSize: 12 }} value={to} onChange={(event) => {
              setActivePreset(null)
              setTo(event.target.value)
            }} />
          </div>
          <button className="btn btn-primary btn-sm" type="button" onClick={() => void handleGenerateBilling()} disabled={generateLoading}>
            {generateLoading ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Loader2 size={12} strokeWidth={2.5} className="animate-spin" aria-hidden />
                Updating...
              </span>
            ) : (
              'Update Billing'
            )}
          </button>
          <button className="btn btn-outline btn-sm" type="button" onClick={() => void handleGenerateBilling(true)} disabled={generateLoading || regenerateRangeBlocked} title={regenerateRangeBlocked ? 'Regenerate Range is limited to 120 days. Use Update Billing for All/history.' : 'Rebuild every billing row in the selected date range. Use this only when pricing rules changed or history needs repair.'}>
            Regenerate Range
          </button>
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            title="Populate SS USPS/UPS reference rates from rate cache"
            disabled={backfillLoading}
            onClick={() => void handleBackfillRefRates()}
          >
            {backfillLoading ? '↺ Backfilling…' : '↺ Backfill Ref Rates'}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            title="Re-fetch live SS USPS/UPS reference rates for all reference_rate clients (runs in background)"
            disabled={fetchRefRunning}
            onClick={() => void handleFetchRefRates()}
          >
            ⚡ Fetch Ref Rates
          </button>
          <span style={{ fontSize: 10.5, color: 'var(--text3)', marginLeft: 4 }}>{fetchRefStatus}</span>
          <span style={{ fontSize: 12, color: 'var(--text3)' }}>{generateStatus}</span>
        </div>

        <div className="billing-client-filter">
          <div className="billing-client-filter-head">
            <div className="billing-client-filter-copy">
              <div className="billing-client-filter-title">
                <ListFilter size={14} strokeWidth={2.4} aria-hidden />
                <span>Client Filter</span>
                <span className="billing-client-filter-count">
                  {selectedBillingClientCount} of {availableBillingClients.length || summaryRows.length} clients
                </span>
              </div>
              <div className="billing-client-filter-subtitle">
                {billingClientFilterActive
                  ? `Visible billing excludes: ${excludedBillingClientNames.length ? excludedBillingClientNames.join(', ') : 'none'}`
                  : 'All PrepShip billing clients are included.'}
              </div>
            </div>
            <div className="billing-client-filter-actions">
              <button className="btn btn-outline btn-sm billing-filter-action" type="button" onClick={handleSelectShipStationBillingClients} title="Show only clients that exist in ShipStation">
                <Check size={12} strokeWidth={2.5} aria-hidden />
                ShipStation only
              </button>
              <button className="btn btn-ghost btn-sm billing-filter-action" type="button" onClick={handleSelectAllBillingClients} title="Restore every PrepShip billing client">
                <X size={12} strokeWidth={2.5} aria-hidden />
                All clients
              </button>
              <button className="btn btn-ghost btn-sm billing-filter-action" type="button" onClick={() => setClientFilterOpen((open) => !open)} aria-expanded={clientFilterOpen}>
                <SlidersHorizontal size={12} strokeWidth={2.5} aria-hidden />
                Advanced
              </button>
            </div>
          </div>

          {clientFilterOpen ? (
            <div className="billing-client-filter-options">
              {availableBillingClients.map((client) => {
                const checked = billingClientFilterActive ? selectedBillingClientIdSet.has(client.clientId) : true
                return (
                  <label key={client.clientId} className={`billing-client-filter-option${checked ? ' is-selected' : ''}${client.inShipStation ? '' : ' is-prepship-only'}`}>
                    <input type="checkbox" checked={checked} onChange={() => handleToggleBillingClient(client.clientId)} />
                    <span className="billing-client-filter-name">{client.clientName}</span>
                    <span className="billing-client-filter-badge">{client.inShipStation ? 'ShipStation' : 'PrepShip only'}</span>
                  </label>
                )
              })}
              {missingShipStationClientNames.length > 0 ? (
                <div className="billing-client-filter-note">
                  ShipStation-only client not in PrepShip billing: {missingShipStationClientNames.join(', ')}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Summary table — migrated 2026-05-12 to the reusable <Table>
            primitive (components/ui/Table.tsx). Operator-controlled
            sort / column widths / column order / column visibility +
            pagination, all persisted to 'billing-summary-table:*' in
            localStorage. The Total row is rendered via Table's
            footerRow API so it stays pinned to the bottom of tbody
            and shows the sum of the FULL dataset (not just the page). */}
        {summaryError ? (
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
                  </span>
                ),
              },
              { key: 'orders', label: 'Orders', width: 90, minWidth: 70, align: 'right', sortable: true, sortValue: (row) => Number(row.orderCount ?? 0), render: (row) => row.orderCount || 0 },
              { key: 'pickPack', label: 'Pick & Pack', width: 110, minWidth: 90, align: 'right', sortable: true, sortValue: (row) => Number(row.pickPackFeeTotal ?? ((row.pickPackTotal ?? 0) + (row.additionalTotal ?? 0))), render: (row) => formatBillingMoney(row.pickPackFeeTotal ?? ((row.pickPackTotal ?? 0) + (row.additionalTotal ?? 0))) },
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
              const tdStyle: React.CSSProperties = { padding: '8px 10px', textAlign: align, fontWeight: 700 }
              // PS-042: tag each footer cell with its column key/align so it can
              // be matched to the matching header/body cell (E2E + so alignment
              // can't silently drift from them). Width/position come from the
              // shared <colgroup>, so cells stay aligned under reorder/hide/resize.
              const common = { 'data-col-key': c.key, 'data-col-align': align, 'data-col-footer': true }
              switch (c.key) {
                case 'client': return <td key={c.key} {...common} style={tdStyle}>Total</td>
                case 'orders': return <td key={c.key} {...common} style={tdStyle}>{summaryTotals.orders}</td>
                case 'pickPack': return <td key={c.key} {...common} style={tdStyle}>{formatBillingMoney(summaryTotals.pickPackFee)}</td>
                case 'additional': return <td key={c.key} {...common} style={tdStyle}>{formatBillingMoney(summaryTotals.additional)}</td>
                case 'package': return <td key={c.key} {...common} style={tdStyle}>{formatBillingMoney(summaryTotals.package, { dashIfZero: true })}</td>
                case 'storage': return <td key={c.key} {...common} style={tdStyle}>{formatBillingMoney(summaryTotals.storage, { dashIfZero: true })}</td>
                case 'shipping': return <td key={c.key} {...common} style={tdStyle}>{formatBillingMoney(summaryTotals.shipping)}</td>
                case 'total': return <td key={c.key} {...common} style={{ ...tdStyle, fontWeight: 800, color: 'var(--green)', fontSize: 13 }}>{formatBillingMoney(summaryTotals.fulfillmentFee)}</td>
                default: return <td key={c.key} {...common} style={tdStyle} />
              }
            })}
          />
        )}

        {detailState.open ? (
          <div ref={detailWrapRef} style={{ display: 'block', marginTop: 16, borderTop: '2px solid var(--border)', paddingTop: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <h3 style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', margin: 0 }}>Line Items — {detailState.clientName}</h3>
              <button className="btn btn-ghost btn-xs" type="button" onClick={() => setDetailState((current) => ({ ...current, open: false }))}>✕ Close</button>
            </div>

            <div className="billing-detail-client-strip" aria-label="Line item client selector">
              <span className="billing-detail-client-strip-label">
                {sortedSummaryRows.length} visible clients
                {selectedDetailSummary ? ` · showing ${Number(selectedDetailSummary.orderCount ?? 0)} orders` : ''}
              </span>
              {sortedSummaryRows.map((row) => {
                const active = Number(row.clientId) === Number(detailState.clientId)
                const orderCount = Number(row.orderCount ?? 0)
                const rowTotal = Number(row.fulfillmentFeeTotal ?? row.grandTotal ?? row.total ?? 0)
                return (
                  <button
                    key={row.clientId}
                    className={`billing-detail-toggle${active ? ' active' : ''}${orderCount === 0 && rowTotal === 0 ? ' is-empty' : ''}`}
                    type="button"
                    aria-pressed={active}
                    onClick={() => void handleLoadDetails(row.clientId, row.clientName)}
                  >
                    <span>{row.clientName}</span>
                    <span className="billing-detail-toggle-meta">{orderCount} orders</span>
                    <span className="billing-detail-toggle-total">{formatBillingMoney(rowTotal)}</span>
                  </button>
                )
              })}
            </div>

            {/* Detail table — migrated 2026-05-12 to the reusable
                <Table> primitive. Sort, widths, column order,
                column visibility, AND pagination all live inside
                Table under 'billing-detail-table:*'. The legacy
                column-toggle pill bar above the table is removed —
                operators use Table's "Columns ▾" picker instead
                (top-right of the table toolbar). Totals row goes
                through Table's footerRow API. */}
            {detailState.error ? (
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--red)' }}>{detailState.error}</div>
            ) : (
              <Table<BillingDetailDto>
                data={sortedDetailRows}
                columns={BILLING_DETAIL_COLUMNS.map((column) => {
                  const defaultHidden = !DEFAULT_BILLING_DETAIL_COLUMN_IDS_SET.has(column.id)
                  const baseWidth = DETAIL_COLUMN_WIDTHS[column.id] ?? 110
                  const tdStyleBase: React.CSSProperties = {
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
                            <button
                              type="button"
                              className="billing-detail-edit-button"
                              title="Edit billing details"
                              onClick={(event) => { event.stopPropagation(); handleOpenBillingEdit(row) }}
                            >
                              <Pencil size={13} aria-hidden="true" />
                              <span>Edit</span>
                            </button>
                          ) : (
                            <span style={{ color: 'var(--text4)' }}>—</span>
                          )
                        case 'orderNumber':
                          return row.orderId ? (
                            <button
                              type="button"
                              className="inventory-inline-button"
                              title="Open order detail"
                              onClick={(e) => { e.stopPropagation(); setOrderDetailModalId(row.orderId as number) }}
                              style={{ fontWeight: 600, color: 'var(--ss-blue)' }}
                            >
                              {row.orderNumber}
                            </button>
                          ) : (
                            <span style={{ color: 'var(--text2)' }}>{row.orderNumber || 'Storage'}</span>
                          )
                        case 'shipDate':
                          return <span style={{ color: 'var(--text2)', fontSize: 11 }}>{formatBillingDateTime(row.shipDate)}</span>
                        case 'carrierNickname': {
                          const carrierText = row.carrierNickname || row.providerAccountNickname || row.carrier_nickname || row.provider_account_nickname || row.carrierCode || row.carrier_code || ''
                          return <span style={{ color: carrierText ? 'var(--text)' : 'var(--text4)', fontSize: 11, fontWeight: carrierText ? 600 : 400 }}>{carrierText || '-'}</span>
                        }
                        case 'itemNames':
                          return (
                            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11 }} title={lineLabel}>
                              {lineLabel ? lineLabel.split(' | ').map((name, index) => (
                                <div key={`name-${index}`} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
                              )) : <span style={{ color: 'var(--text4)' }}>—</span>}
                            </div>
                          )
                        case 'itemSkus': {
                          const skuText = row.itemSkus || ''
                          return (
                            <div style={{ fontFamily: 'monospace', fontSize: 10.5, color: 'var(--text2)' }}>
                              {skuText ? skuText.split(' | ').map((sku, index) => (
                                <div key={`sku-${index}`}>{sku || '—'}</div>
                              )) : <span style={{ color: 'var(--text4)' }}>—</span>}
                            </div>
                          )
                        }
                        case 'totalQty':
                          return <span>{row.totalQty || row.qty || 0}</span>
                        case 'pickpack':
                          return formatBillingMoney(metrics.pickPackFee)
                        case 'additional':
                          return formatBillingMoney(metrics.additional, { dashIfZero: true })
                        case 'packageCost':
                          return formatBillingMoney(metrics.packageCost, { dashIfZero: true })
                        case 'packageName':
                          return <span style={{ fontSize: 10.5, color: 'var(--text2)' }}>{row.packageName || '—'}</span>
                        case 'bestRate':
                          return (
                            <span
                              data-billing-rate="bestRate"
                              style={{ fontSize: 11 }}
                              className={metrics.chargedRate === 'bestRate' ? 'billing-detail-rate-hit' : undefined}
                            >
                              {formatBillingMoney(row.actualLabelCost, { dashIfZero: true })}
                            </span>
                          )
                        case 'upsss':
                          return (
                            <span style={{ fontSize: 11, color: row.ref_ups_rate ? '#2563eb' : undefined }} className={metrics.chargedRate === 'upsss' ? 'billing-detail-rate-hit' : undefined}>
                              {formatBillingMoney(row.ref_ups_rate, { dashIfZero: true })}
                            </span>
                          )
                        case 'uspsss':
                          return (
                            <span style={{ fontSize: 11, color: row.ref_usps_rate ? '#16a34a' : undefined }} className={metrics.chargedRate === 'uspsss' ? 'billing-detail-rate-hit' : undefined}>
                              {formatBillingMoney(row.ref_usps_rate, { dashIfZero: true })}
                            </span>
                          )
                        case 'shipping':
                          return metrics.ssCharged ? (
                            <>
                              <span style={{ color: '#b45309', fontWeight: 600 }}>{formatBillingMoney(metrics.shipping)}</span>
                              <span style={{ fontSize: 9, color: 'var(--text3)', marginLeft: 3 }}>↑SS</span>
                            </>
                          ) : formatBillingMoney(metrics.shipping)
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
                storageKey="billing-detail-table-v2"
                defaultSort={{ key: 'shipDate', direction: 'desc' }}
                paginated
                defaultPageSize={50}
                pageSizeOptions={BILLING_DETAIL_PAGE_SIZE_OPTIONS}
                loading={detailState.loading}
                emptyMessage="No line items found."
                rowClassName={(row) => (computeBillingDetailMetrics(row).ssCharged ? 'billing-detail-ss-row' : undefined)}
                footerRow={(cols) => cols.map((c) => {
                  const td: React.CSSProperties = {
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
            )}
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
