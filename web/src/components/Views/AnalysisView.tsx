// @ts-nocheck
import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { BarChart3 } from 'lucide-react'
import {
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  BarChart,
  Bar,
} from 'recharts'
import type {
  AnalysisDailySalesResponse,
  AnalysisSkuDto,
} from '@prepshipv2/contracts/analysis/contracts'
import { ApiError, apiClient } from '../../api/client'
import { ToastContext } from '../../contexts/ToastContext'
import type { ClientDto, InventorySkuOrdersDto } from '../../types/api'
import {
  filterAnalysisRows,
  formatAnalysisMoney,
  getAnalysisEmptyMessage,
  getAnalysisPresetRange,
  getAnalysisSummaryText,
  getInitialAnalysisFilters,
  sortAnalysisRows,
  buildAnalysisTotals,
  type AnalysisSortDir,
  type AnalysisSortKey,
} from './analysis-parity'
import { AnalysisDataTable } from './AnalysisDataTable'
import { AnalysisPagination } from './AnalysisPagination'
import type { AnalysisTableColumn, ColumnWidths } from './AnalysisTableHeader'
import { AnalysisTopSkusChart } from './AnalysisTopSkusChart'
import OrderDetailDrawer from '../OrderDetailDrawer'
import { ColumnResizeHandle } from './ColumnResizeHandle'
import './InventoryView.css'
import './AnalysisView.css'

// SKU drawer's "Recent Orders" table — user-resizable columns. Widths persist
// per-browser via localStorage so the layout sticks across page loads. Defaults
// roughly match the previous fixed-CSS layout; no <colgroup> means the table
// stays auto-sized until the user drags a handle.
type DrawerOrdersColumnKey = 'orderNum' | 'customer' | 'qty' | 'cost' | 'status' | 'date'
const DRAWER_ORDERS_COLUMN_DEFAULTS: Record<DrawerOrdersColumnKey, number> = {
  orderNum: 150,
  customer: 200,
  qty: 60,
  cost: 110,
  status: 110,
  date: 100,
}
const DRAWER_ORDERS_COLUMN_MIN: Record<DrawerOrdersColumnKey, number> = {
  orderNum: 90,
  customer: 100,
  qty: 50,
  cost: 70,
  status: 80,
  date: 80,
}
const DRAWER_ORDERS_STORAGE_KEY = 'analysis_sku_drawer_widths'

function readStoredDrawerOrderWidths(): Partial<Record<DrawerOrdersColumnKey, number>> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(DRAWER_ORDERS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const cleaned: Partial<Record<DrawerOrdersColumnKey, number>> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (
        (key === 'orderNum' || key === 'customer' || key === 'qty' || key === 'cost' || key === 'status' || key === 'date')
        && typeof value === 'number'
        && Number.isFinite(value)
        && value > 0
      ) {
        cleaned[key as DrawerOrdersColumnKey] = value
      }
    }
    return cleaned
  } catch {
    return {}
  }
}

const TABLE_COLUMN_COUNT = 10
const ANALYSIS_PAGE_SIZE_OPTIONS = [25, 50, 100]

const COLUMN_SIZES = ['narrow', 'medium', 'wide'] as const
type ColumnSize = (typeof COLUMN_SIZES)[number]
const DEFAULT_COLUMN_SIZE: ColumnSize = 'medium'

function readStoredColumnSize(): ColumnSize {
  if (typeof window === 'undefined') return DEFAULT_COLUMN_SIZE
  const stored = window.localStorage.getItem('analysis_column_size')
  return COLUMN_SIZES.includes(stored as ColumnSize)
    ? (stored as ColumnSize)
    : DEFAULT_COLUMN_SIZE
}

function readStoredColumnWidths(): ColumnWidths {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem('analysis_column_widths')
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const cleaned: ColumnWidths = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        cleaned[key as keyof ColumnWidths] = value
      }
    }
    return cleaned
  } catch {
    return {}
  }
}

const ANALYSIS_TABLE_COLUMNS: AnalysisTableColumn[] = [
  { key: 'name' },
  { key: 'sku' },
  { key: 'client' },
  { key: 'orders', align: 'right' },
  { key: 'pending', title: 'Awaiting shipment - not yet labeled', align: 'right' },
  { key: 'external', title: 'Orders shipped externally (no ShipStation label)', align: 'right' },
  { key: 'qty', align: 'right' },
  { key: 'stdOrders', title: 'SS-labeled standard service orders (count + avg cost)', align: 'right' },
  { key: 'expOrders', title: 'SS-labeled expedited service orders (count + avg cost)', align: 'right' },
  {
    key: 'total',
    title: 'Total SS label cost (proportionally allocated across SKUs in multi-item orders)',
    align: 'right',
  },
]

interface AnalysisDataState {
  loading: boolean
  error: string | null
  rows: AnalysisSkuDto[]
  orderCount: number
  chartData: AnalysisDailySalesResponse | null
}

// CA-time delegation per boss directive 2026-05-07. AnalysisView
// pulls from `orders.raw` JSON (paymentDate, shipByDate, etc) which
// originate from ShipStation V1 — same naive-PT-stamped-Z convention
// as orderDate. Normalize bare strings to Z (matching prior behavior)
// then route to formatNaivePt* helpers in ca-time.ts.
import { formatNaivePtDateLong, formatNaivePtDateTime } from '../../lib/ca-time'

function formatDateOnly(value: string | null | undefined) {
  if (!value) return '-'
  const result = formatNaivePtDateLong(value)
  return result === '—' ? '-' : result
}

function formatDateTime(value: unknown) {
  if (!value) return '-'
  const raw = String(value).trim()
  if (!raw) return '-'
  const normalized = /(?:z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`
  const result = formatNaivePtDateTime(normalized)
  return result === '—' ? '-' : result
}

function asRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : []
}

function displayText(value: unknown, fallback = '-') {
  if (value == null || value === '') return fallback
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value)
}

function numberValue(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function formatMoneyValue(value: unknown) {
  const num = numberValue(value)
  return num == null ? '-' : `$${num.toFixed(2)}`
}

function formatStatusText(value: unknown) {
  const raw = displayText(value, '').replace(/_/g, ' ').trim()
  return raw ? raw.replace(/\b\w/g, (char) => char.toUpperCase()) : '-'
}

function getOrderRaw(order: unknown) {
  return asRecord(asRecord(order).raw)
}

function getOrderItems(order: unknown) {
  const row = asRecord(order)
  const raw = getOrderRaw(order)
  return asArray(row.items).length ? asArray(row.items) : asArray(raw.items)
}

function getOrderShipTo(order: unknown) {
  const row = asRecord(order)
  const rawShipTo = asRecord(getOrderRaw(order).shipTo)
  return {
    name: rawShipTo.name ?? row.shipToName,
    company: rawShipTo.company,
    street1: rawShipTo.street1,
    street2: rawShipTo.street2,
    city: rawShipTo.city ?? row.shipToCity,
    state: rawShipTo.state ?? row.shipToState,
    postalCode: rawShipTo.postalCode ?? row.shipToPostalCode,
    country: rawShipTo.country ?? 'US',
    phone: rawShipTo.phone,
    addressVerified: rawShipTo.addressVerified,
  }
}

const LEGACY_CLIENT_ID_BY_STORE_ID = new Map<number, number>([
  [367706, 7],
  [363392, 8],
  [376661, 9],
  [277422, 10],
  [376827, 10],
])

const LEGACY_CLIENT_ID_BY_CURRENT_ID = new Map<number, number>([
  [8, 7],
  [9, 8],
  [10, 9],
  [11, 10],
  [12, 11],
])

function getDisplayClientId(order: unknown) {
  const row = asRecord(order)
  const canonicalOrder = asRecord(row.canonicalOrder)
  const rowClient = asRecord(row.client)
  const canonicalClient = asRecord(canonicalOrder.client)
  const legacyClientId = numberValue(
    row.legacyClientId
    ?? canonicalOrder.legacyClientId
    ?? rowClient.legacyId
    ?? canonicalClient.legacyId,
  )
  if (legacyClientId != null) return legacyClientId

  const storeId = numberValue(
    row.storeId
    ?? canonicalOrder.storeId
    ?? rowClient.storeId
    ?? canonicalClient.storeId,
  )
  if (storeId != null) {
    const mapped = LEGACY_CLIENT_ID_BY_STORE_ID.get(storeId)
    if (mapped != null) return mapped
  }

  const clientId = numberValue(row.clientId ?? canonicalOrder.clientId ?? rowClient.id ?? canonicalClient.id)
  if (clientId != null) {
    const mapped = LEGACY_CLIENT_ID_BY_CURRENT_ID.get(clientId)
    return mapped ?? clientId
  }

  return '-'
}

function formatAddressLines(address: Record<string, unknown>) {
  const cityLine = [address.city, address.state, address.postalCode]
    .map((part) => displayText(part, ''))
    .filter(Boolean)
    .join(', ')
  return [
    address.name,
    address.company,
    address.street1,
    address.street2,
    cityLine,
    address.country,
  ]
    .map((part) => displayText(part, ''))
    .filter(Boolean)
}

function getItemQty(item: unknown) {
  return numberValue(asRecord(item).quantity ?? asRecord(item).qty) ?? 1
}

function getItemUnitPrice(item: unknown) {
  return asRecord(item).unitPrice ?? asRecord(item).unit_price
}

function getItemTotal(item: unknown) {
  const unit = numberValue(getItemUnitPrice(item))
  if (unit == null) return null
  return unit * getItemQty(item)
}

function sumNumericValues(values: unknown[]) {
  let total = 0
  let hasValue = false

  for (const value of values) {
    const numeric = numberValue(value)
    if (numeric == null) continue
    total += numeric
    hasValue = true
  }

  return hasValue ? total : null
}

function getItemsTotal(items: unknown[]) {
  return sumNumericValues(items.map((item) => getItemTotal(item)))
}

function getShipmentCost(shipment: unknown) {
  const shipmentRecord = asRecord(shipment)
  return shipmentRecord.labelCost ?? shipmentRecord.label_cost ?? shipmentRecord.cost
}

function getShipmentsTotal(shipments: unknown[]) {
  return sumNumericValues(shipments.map((shipment) => getShipmentCost(shipment)))
}

function isAdjustmentItem(item: unknown) {
  const itemRecord = asRecord(item)
  const sku = displayText(itemRecord.sku, '').trim()
  const unit = numberValue(getItemUnitPrice(item))
  const total = numberValue(itemRecord.total ?? itemRecord.lineItemTotal ?? getItemTotal(item))
  const hasAdjustmentFlag =
    itemRecord.adjustment === true
    || itemRecord.isAdjustment === true
    || itemRecord.type === 'adjustment'
    || itemRecord.type === 'discount'

  return hasAdjustmentFlag || (!sku && ((unit != null && unit < 0) || (total != null && total < 0)))
}

function formatOrderWeight(order: unknown) {
  const row = asRecord(order)
  const rawWeight = asRecord(getOrderRaw(order).weight)
  const weightOz = numberValue(row.weightOz ?? rawWeight.value)
  if (weightOz == null) return '-'
  const units = displayText(rawWeight.units, 'ounces').toLowerCase()
  if (units.startsWith('pound')) return `${weightOz} lb`
  return `${weightOz} oz`
}

function formatOrderDimensions(order: unknown) {
  const rawDims = asRecord(getOrderRaw(order).dimensions)
  const length = numberValue(rawDims.length)
  const width = numberValue(rawDims.width)
  const height = numberValue(rawDims.height)
  if (length == null || width == null || height == null) return '-'
  return `${length} x ${width} x ${height} ${displayText(rawDims.units, 'in')}`
}

function DetailField({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="analysis-order-field">
      <span>{label}</span>
      <strong>{displayText(value)}</strong>
    </div>
  )
}

function DetailSection({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="analysis-order-section">
      <h4>{title}</h4>
      {children}
    </section>
  )
}

function buildDrawerChartRows(dailySales: InventorySkuOrdersDto['dailySales']) {
  if (!Array.isArray(dailySales)) return []
  return dailySales.map((row) => ({
    day: row.day,
    units: Number(row.units) || 0,
  }))
}

function buildDrawerYAxisTicks(maxValue: number) {
  const maxTick = Math.max(1, Math.round(maxValue))
  return Array.from(
    new Set([
      Math.max(1, Math.round(maxTick / 3)),
      Math.max(1, Math.round((maxTick * 2) / 3)),
      maxTick,
    ]),
  )
}

function DrawerBarValueLabel(props: {
  x?: number
  y?: number
  width?: number
  height?: number
  value?: number
}) {
  const value = Number(props.value) || 0
  if (value <= 0) return null

  const x = Number(props.x) || 0
  const y = Number(props.y) || 0
  const width = Number(props.width) || 0
  const height = Number(props.height) || 0
  const drawInside = height >= 12

  return (
    <text
      x={x + width / 2}
      y={drawInside ? y + 9 : y - 4}
      textAnchor="middle"
      fill={drawInside ? '#fff' : '#e07a00'}
      fontSize={9}
      fontWeight={700}
    >
      {value}
    </text>
  )
}

interface AnalysisViewProps {
  /** Pre-fill the SKU search field. Set by the Dashboard click-to-open flow. */
  initialSearch?: string
}

export default function AnalysisView({ initialSearch }: AnalysisViewProps = {}) {
  const toastContext = useContext(ToastContext)
  const stickyPanelRef = useRef<HTMLDivElement | null>(null)
  const initialFilters = getInitialAnalysisFilters(
    typeof window === 'undefined' ? null : window.localStorage,
  )
  const [from, setFrom] = useState(initialFilters.from)
  const [to, setTo] = useState(initialFilters.to)
  const [presetDays, setPresetDays] = useState<number | null>(initialFilters.presetDays)
  const [clientId, setClientId] = useState('')
  const [search, setSearch] = useState(initialSearch ?? '')

  // Keep search in sync if the parent passes a new initialSearch (e.g. user
  // returns to dashboard and clicks a different SKU). Only fires when the
  // incoming prop is non-empty so it never *clears* a search the user is
  // typing into the field directly.
  useEffect(() => {
    if (initialSearch && initialSearch !== search) {
      setSearch(initialSearch)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSearch])
  // Sort state — persisted to localStorage so the operator's choice
  // survives reloads (page-size selector follows the same pattern).
  // Defaults to qty desc which was the previous hard-locked behavior,
  // so first-time loads look identical to before.
  const SORT_STORAGE_KEY = 'prepship_analysis_sort'
  type StoredSort = { key: AnalysisSortKey; dir: AnalysisSortDir }
  const ALLOWED_SORT_KEYS: AnalysisSortKey[] = [
    'name', 'sku', 'client', 'orders', 'pending', 'external', 'qty', 'stdOrders', 'expOrders', 'total',
  ]
  const [sortKey, setSortKey] = useState<AnalysisSortKey>(() => {
    if (typeof window === 'undefined') return 'qty'
    try {
      const raw = window.localStorage.getItem(SORT_STORAGE_KEY)
      if (!raw) return 'qty'
      const parsed = JSON.parse(raw) as StoredSort
      return ALLOWED_SORT_KEYS.includes(parsed.key) ? parsed.key : 'qty'
    } catch {
      return 'qty'
    }
  })
  const [sortDir, setSortDir] = useState<AnalysisSortDir>(() => {
    if (typeof window === 'undefined') return 'desc'
    try {
      const raw = window.localStorage.getItem(SORT_STORAGE_KEY)
      if (!raw) return 'desc'
      const parsed = JSON.parse(raw) as StoredSort
      return parsed.dir === 'asc' ? 'asc' : 'desc'
    } catch {
      return 'desc'
    }
  })
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [columnSize, setColumnSize] = useState<ColumnSize>(readStoredColumnSize)
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>(readStoredColumnWidths)
  const [drawerOrderWidths, setDrawerOrderWidths] = useState<Partial<Record<DrawerOrdersColumnKey, number>>>(
    readStoredDrawerOrderWidths
  )
  const [clients, setClients] = useState<ClientDto[]>([])
  const [dataState, setDataState] = useState<AnalysisDataState>({
    loading: true,
    error: null,
    rows: [],
    orderCount: 0,
    chartData: null,
  })
  const [skuDrawer, setSkuDrawer] = useState<InventorySkuOrdersDto | null>(null)
  const [skuDrawerTitle, setSkuDrawerTitle] = useState('Loading…')
  const [skuDrawerError, setSkuDrawerError] = useState<string | null>(null)
  const [skuDrawerOpen, setSkuDrawerOpen] = useState(false)
  const [skuDrawerLoading, setSkuDrawerLoading] = useState(false)
  const [orderDetailDrawer, setOrderDetailDrawer] = useState<{ orderId: number; status?: string | null } | null>(null)
  const [orderModal, setOrderModal] = useState({
    open: false,
    loading: false,
    error: null as string | null,
    order: null as Record<string, unknown> | null,
    orderNumber: '',
  })
  const filteredRows = useMemo(
    () => filterAnalysisRows(dataState.rows, search),
    [dataState.rows, search],
  )
  const sortedRows = useMemo(
    () => sortAnalysisRows(filteredRows, sortKey, sortDir),
    [filteredRows, sortKey, sortDir],
  )
  const totals = useMemo(() => buildAnalysisTotals(sortedRows), [sortedRows])
  const pagedRows = useMemo(() => {
    const start = (page - 1) * pageSize
    return sortedRows.slice(start, start + pageSize)
  }, [page, pageSize, sortedRows])
  const maxQty = useMemo(
    () => Math.max(...sortedRows.map((row) => row.qty), 1),
    [sortedRows],
  )
  const drawerChartRows = useMemo(
    () => (skuDrawer ? buildDrawerChartRows(skuDrawer.dailySales) : []),
    [skuDrawer],
  )
  const drawerYAxisMax = useMemo(
    () => Math.max(...drawerChartRows.map((row) => row.units), 1),
    [drawerChartRows],
  )
  const drawerYAxisTicks = useMemo(
    () => buildDrawerYAxisTicks(drawerYAxisMax),
    [drawerYAxisMax],
  )
  const drawerAvgStandardShippingCost = useMemo(
    () => numberValue(skuDrawer?.avgStandardShippingCost) ?? 0,
    [skuDrawer],
  )

  // Load clients once for the filter dropdown.
  useEffect(() => {
    let active = true
    const loadClients = async () => {
      try {
        const nextClients = await apiClient.fetchClients()
        if (active) setClients(nextClients)
      } catch {}
    }
    void loadClients()
    return () => {
      active = false
    }
  }, [])

  // Persist date filters to localStorage so presets survive reloads.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (from) window.localStorage.setItem('analysis_from', from)
    if (to) window.localStorage.setItem('analysis_to', to)
    if (presetDays == null) {
      window.localStorage.removeItem('analysis_preset_days')
      return
    }
    window.localStorage.setItem('analysis_preset_days', String(presetDays))
  }, [from, to, presetDays])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem('analysis_column_size', columnSize)
  }, [columnSize])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem('analysis_column_widths', JSON.stringify(columnWidths))
  }, [columnWidths])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(DRAWER_ORDERS_STORAGE_KEY, JSON.stringify(drawerOrderWidths))
  }, [drawerOrderWidths])

  function getDrawerOrderColumnWidth(key: DrawerOrdersColumnKey): number {
    return drawerOrderWidths[key] ?? DRAWER_ORDERS_COLUMN_DEFAULTS[key]
  }
  function handleResizeDrawerOrderColumn(key: DrawerOrdersColumnKey, width: number) {
    setDrawerOrderWidths((current) => ({ ...current, [key]: width }))
  }
  function handleResetDrawerOrderColumn(key: DrawerOrdersColumnKey) {
    setDrawerOrderWidths((current) => {
      if (!(key in current)) return current
      const { [key]: _removed, ...rest } = current
      return rest
    })
  }

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const panel = stickyPanelRef.current
    const container = panel?.closest<HTMLElement>('#view-analysis')
    if (!panel || !container) return undefined

    const updateStickyOffset = () => {
      const height = Math.ceil(panel.getBoundingClientRect().height)
      container.style.setProperty('--analysis-table-sticky-top', `${height + 1}px`)
    }

    updateStickyOffset()

    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(updateStickyOffset)
      : null
    observer?.observe(panel)
    window.addEventListener('resize', updateStickyOffset)

    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', updateStickyOffset)
      container.style.removeProperty('--analysis-table-sticky-top')
    }
  }, [])

  function handleResizeColumn(key: AnalysisSortKey, width: number) {
    setColumnWidths((current) => ({ ...current, [key]: width }))
  }

  function handleResetColumn(key: AnalysisSortKey) {
    setColumnWidths((current) => {
      if (!(key in current)) return current
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  function stepColumnSize(direction: -1 | 1) {
    setColumnSize((current) => {
      const index = COLUMN_SIZES.indexOf(current)
      const next = Math.min(
        COLUMN_SIZES.length - 1,
        Math.max(0, index + direction),
      )
      return COLUMN_SIZES[next]
    })
  }

  const columnSizeIndex = COLUMN_SIZES.indexOf(columnSize)

  useEffect(() => {
    setPage(1)
  }, [from, to, clientId, search])

  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(sortedRows.length / pageSize))
    setPage((currentPage) => Math.min(currentPage, maxPage))
  }, [pageSize, sortedRows.length])

  // Main load: SKU breakdown + daily sales chart data, in parallel.
  useEffect(() => {
    let active = true
    const loadAnalysis = async () => {
      setDataState((current) => ({ ...current, loading: true, error: null }))
      try {
        const query = {
          from: from || undefined,
          to: to || undefined,
          clientId: clientId ? Number.parseInt(clientId, 10) : undefined,
        }
        const [skuData, chartData] = await Promise.all([
          apiClient.fetchAnalysisSkus(query),
          apiClient.fetchAnalysisDailySales(query).catch(() => null),
        ])
        if (!active) return
        setDataState({
          loading: false,
          error: null,
          rows: skuData.skus || [],
          orderCount: skuData.orderCount || 0,
          chartData,
        })
      } catch (error) {
        if (!active) return
        setDataState((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : 'Failed to load analysis',
        }))
      }
    }
    void loadAnalysis()
    return () => {
      active = false
    }
  }, [from, to, clientId])

  useEffect(() => {
    if (!orderModal.open) return undefined
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeOrderDetails()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [orderModal.open])

  function handlePresetClick(days: number) {
    const range = getAnalysisPresetRange(days)
    setPresetDays(days)
    setFrom(range.from)
    setTo(range.to)
  }

  async function openSkuDrawer(invSkuId: number) {
    setSkuDrawerOpen(true)
    setSkuDrawerLoading(true)
    setSkuDrawerError(null)
    setSkuDrawer(null)
    setSkuDrawerTitle('Loading…')
    try {
      const result = await apiClient.fetchInventorySkuOrders(invSkuId, { from, to })
      setSkuDrawer(result)
      setSkuDrawerTitle(result.name || result.sku)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load SKU activity'
      setSkuDrawerError(message)
      setSkuDrawerTitle(
        error instanceof ApiError && error.status === 404 ? 'SKU not found' : 'Error',
      )
      toastContext?.addToast(message, 'error')
    } finally {
      setSkuDrawerLoading(false)
    }
  }

  async function openOrderDetails(order: Record<string, unknown>) {
    const orderId = numberValue(order.orderId)
    if (orderId == null) {
      toastContext?.addToast('This order row does not include a valid order id.', 'error')
      return
    }
    setOrderDetailDrawer({ orderId, status: displayText(order.orderStatus, '') || null })
  }

  function closeOrderDetails() {
    setOrderModal((current) => ({ ...current, open: false }))
  }

  // Click a column header to toggle sort:
  //   - First click on a NEW column → sort by that column, descending
  //     (most natural default for numeric columns; alphabetical-Z for
  //     text columns is unusual but consistent and easy to flip).
  //   - Subsequent clicks on the SAME column → toggle asc ↔ desc.
  // Result is persisted to localStorage so the operator's preferred
  // sort survives reloads. Page resets to 1 so they don't end up on
  // page 5 of newly-resorted data with a different leading row.
  function handleSort(key: AnalysisSortKey) {
    const nextDir: AnalysisSortDir =
      key === sortKey ? (sortDir === 'asc' ? 'desc' : 'asc') : 'desc'
    setSortKey(key)
    setSortDir(nextDir)
    setPage(1)
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(
          SORT_STORAGE_KEY,
          JSON.stringify({ key, dir: nextDir })
        )
      } catch {
        /* localStorage quota exceeded or disabled — non-fatal */
      }
    }
  }

  const hasChart =
    dataState.chartData
    && (dataState.chartData.topSkus?.length ?? 0) > 0
    && (dataState.chartData.dates?.length ?? 0) > 0
  const modalOrder = orderModal.order
  const modalRaw = getOrderRaw(modalOrder)
  const modalShipTo = getOrderShipTo(modalOrder)
  const modalAllItems = getOrderItems(modalOrder)
  const modalItems = modalAllItems.filter((item) => !isAdjustmentItem(item))
  const modalAdjustments = modalAllItems.filter(isAdjustmentItem)
  const modalShipments = asArray(asRecord(modalOrder).shipments)
  const modalItemsTotal = getItemsTotal(modalItems)
  const modalShipmentTotal = getShipmentsTotal(modalShipments)

  return (
    <div className="view-content" id="view-analysis">
      <div
        ref={stickyPanelRef}
        className="analysis-sticky-panel"
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 30,
          background: 'var(--bg)',
          paddingBottom: 6,
          margin: '0 -18px 10px -18px',
          padding: '12px 18px 8px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginBottom: 10,
            flexWrap: 'wrap',
          }}
        >
          <motion.div
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="flex items-center gap-2.5"
          >
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-violet-500 to-violet-600 flex items-center justify-center shadow-md ring-1 ring-violet-400/20">
              <BarChart3 size={18} strokeWidth={2.25} className="text-white" />
            </div>
            <h2 className="text-[15px] font-extrabold text-ink font-display tracking-tight m-0">SKU Analysis</h2>
          </motion.div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {[
              { days: 30, label: '30d' },
              { days: 90, label: '90d' },
              { days: 180, label: '180d' },
              { days: 365, label: '1yr' },
              { days: 0, label: 'All' },
            ].map((preset) => (
              <button
                key={preset.days}
                type="button"
                className={`btn btn-outline btn-sm analysis-preset${presetDays === preset.days ? ' active' : ''}`}
                onClick={() => handlePresetClick(preset.days)}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 12,
              color: 'var(--text2)',
            }}
          >
            <input
              id="analysis-from"
              type="date"
              className="ship-select"
              style={{ width: 130, fontSize: 11.5 }}
              value={from}
              onChange={(event) => {
                setFrom(event.target.value)
                setPresetDays(null)
              }}
            />
            <span>–</span>
            <input
              id="analysis-to"
              type="date"
              className="ship-select"
              style={{ width: 130, fontSize: 11.5 }}
              value={to}
              onChange={(event) => {
                setTo(event.target.value)
                setPresetDays(null)
              }}
            />
          </div>
          <input
            id="analysis-search"
            type="text"
            placeholder="Search SKU or item…"
            className="ship-select"
            style={{ width: 160, fontSize: 12 }}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <select
            id="analysis-client"
            className="filter-sel"
            style={{ fontSize: 12 }}
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
          >
            <option value="">All Clients</option>
            {clients.map((client, i) => {
              const id = client.clientId ?? client.id ?? i
              return (
                <option key={id} value={String(id)}>
                  {client.name}
                </option>
              )
            })}
          </select>
          <span
            id="analysis-summary"
            style={{ fontSize: 11.5, color: 'var(--text3)', marginLeft: 'auto' }}
          >
            {getAnalysisSummaryText(dataState.rows.length, dataState.orderCount)}
          </span>
          <div
            className="inline-flex items-center gap-0 border border-line-2 rounded-md bg-surface p-0.5 ml-2 h-7"
            role="group"
            aria-label="Column width"
          >
            <button
              type="button"
              className="appearance-none border-0 bg-transparent text-ink-2 text-[10px] leading-none w-[22px] h-[22px] inline-flex items-center justify-center rounded-[5px] cursor-pointer transition-colors duration-150 enabled:hover:bg-[rgba(42,91,215,.10)] enabled:hover:text-brand disabled:opacity-35 disabled:cursor-not-allowed"
              onClick={() => stepColumnSize(-1)}
              disabled={columnSizeIndex === 0}
              aria-label="Narrower columns"
              title="Narrower columns"
            >
              ◀
            </button>
            <span className="text-[10px] font-bold uppercase tracking-[0.05em] text-ink-3 px-2 min-w-[74px] text-center [font-variant:small-caps]">
              {columnSize}
            </span>
            <button
              type="button"
              className="appearance-none border-0 bg-transparent text-ink-2 text-[10px] leading-none w-[22px] h-[22px] inline-flex items-center justify-center rounded-[5px] cursor-pointer transition-colors duration-150 enabled:hover:bg-[rgba(42,91,215,.10)] enabled:hover:text-brand disabled:opacity-35 disabled:cursor-not-allowed"
              onClick={() => stepColumnSize(1)}
              disabled={columnSizeIndex === COLUMN_SIZES.length - 1}
              aria-label="Wider columns"
              title="Wider columns"
            >
              ▶
            </button>
          </div>
        </div>

        {hasChart ? (
          <AnalysisTopSkusChart data={dataState.chartData!} />
        ) : null}
      </div>

      {dataState.loading ? (
        <div
          id="analysis-loading"
          style={{ textAlign: 'center', padding: 30, color: 'var(--text3)', fontSize: 13 }}
        >
          ⏳ Loading…
        </div>
      ) : null}

      <AnalysisDataTable
        columns={ANALYSIS_TABLE_COLUMNS}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={handleSort}
        columnWidths={columnWidths}
        onResizeColumn={handleResizeColumn}
        onResetColumn={handleResetColumn}
        columnSize={columnSize}
        rows={dataState.loading ? [] : pagedRows}
        totals={totals}
        maxQty={maxQty}
        loading={dataState.loading}
        error={dataState.error}
        emptyMessage={getAnalysisEmptyMessage(search)}
        onRowClick={(invSkuId) => void openSkuDrawer(invSkuId)}
      />

      {!dataState.loading && !dataState.error && sortedRows.length > 0 ? (
        <AnalysisPagination
          page={page}
          pageSize={pageSize}
          pageSizeOptions={ANALYSIS_PAGE_SIZE_OPTIONS}
          totalItems={sortedRows.length}
          onPageChange={setPage}
          onPageSizeChange={(nextPageSize) => {
            setPageSize(nextPageSize)
            setPage(1)
          }}
        />
      ) : null}

      {skuDrawerOpen ? (
        <div className="inventory-drawer-overlay" onClick={() => setSkuDrawerOpen(false)}>
          <div
            className="inventory-drawer-panel analysis-sku-drawer-panel"
            onClick={(event) => event.stopPropagation()}
          >
            <div
              style={{
                padding: '16px 20px',
                borderBottom: '1px solid var(--border)',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                flexShrink: 0,
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>
                  {skuDrawerTitle}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--text3)',
                    marginTop: 2,
                    fontFamily: 'monospace',
                  }}
                >
                  {skuDrawer?.sku ?? ''}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSkuDrawerOpen(false)}
                style={{
                  padding: '5px 10px',
                  border: '1px solid var(--border2)',
                  borderRadius: 6,
                  background: 'var(--surface2)',
                  color: 'var(--text)',
                  cursor: 'pointer',
                  fontSize: 13,
                }}
              >
                x
              </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px' }}>
              {skuDrawerLoading ? (
                <div className="loading">
                  <div className="spinner" />
                </div>
              ) : skuDrawerError ? (
                <div style={{ color: 'var(--red)', padding: 16 }}>
                  Failed to load: {skuDrawerError}
                </div>
              ) : skuDrawer ? (
                <>
                  <div
                    style={{
                      display: 'flex',
                      gap: 12,
                      marginBottom: 18,
                      flexWrap: 'wrap',
                    }}
                  >
                    <div
                      style={{
                        background: 'var(--surface2)',
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        padding: '10px 16px',
                        flex: 1,
                        minWidth: 120,
                      }}
                    >
                      <div
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          letterSpacing: '.4px',
                          color: 'var(--text3)',
                          marginBottom: 4,
                        }}
                      >
                        30-Day Units Sold
                      </div>
                      <div style={{ fontSize: 22, fontWeight: 800, color: '#e07a00' }}>
                        {skuDrawer.totalUnits.toLocaleString()}
                      </div>
                    </div>
                    <div
                      style={{
                        background: 'var(--surface2)',
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        padding: '10px 16px',
                        flex: 1,
                        minWidth: 120,
                      }}
                    >
                      <div
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          letterSpacing: '.4px',
                          color: 'var(--text3)',
                          marginBottom: 4,
                        }}
                      >
                        Avg. Standard Shipping Cost
                      </div>
                      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)' }}>
                        {drawerAvgStandardShippingCost > 0
                          ? formatAnalysisMoney(drawerAvgStandardShippingCost)
                          : '—'}
                      </div>
                    </div>
                    <div
                      style={{
                        background: 'var(--surface2)',
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        padding: '10px 16px',
                        flex: 1,
                        minWidth: 120,
                      }}
                    >
                      <div
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          letterSpacing: '.4px',
                          color: 'var(--text3)',
                          marginBottom: 4,
                        }}
                      >
                        Avg/Day (30d)
                      </div>
                      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)' }}>
                        {(skuDrawer.totalUnits / 30).toFixed(1)}
                      </div>
                    </div>
                  </div>

                  <div
                    style={{
                      background: 'var(--surface2)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      padding: '14px 16px',
                      marginBottom: 18,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: 'var(--text)',
                        marginBottom: 10,
                      }}
                    >
                      📊 Units Sold — Last 30 Days
                    </div>
                    <div style={{ width: '100%', height: 160 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                          data={drawerChartRows}
                          margin={{ top: 10, right: 8, bottom: 6, left: 0 }}
                        >
                          <CartesianGrid
                            stroke="var(--border)"
                            strokeDasharray="3 3"
                            vertical={false}
                          />
                          <XAxis
                            dataKey="day"
                            tick={{ fontSize: 9, fill: 'var(--text3)' }}
                            tickFormatter={(value: string) =>
                              typeof value === 'string' ? value.slice(5) : value
                            }
                            minTickGap={16}
                          />
                          <YAxis
                            axisLine={false}
                            tickLine={false}
                            tick={{ fontSize: 9, fill: 'var(--text3)' }}
                            ticks={drawerYAxisTicks}
                            domain={[0, drawerYAxisMax]}
                            width={28}
                            allowDecimals={false}
                            interval={0}
                          />
                          <Tooltip
                            contentStyle={{
                              background: 'rgba(20,20,30,.92)',
                              border: 'none',
                              borderRadius: 6,
                              color: '#fff',
                              fontSize: 11,
                            }}
                            itemStyle={{ color: '#fff' }}
                            labelStyle={{ color: '#fff', fontWeight: 700 }}
                          />
                          <Bar dataKey="units" fill="#e07a00" isAnimationActive={false}>
                            <LabelList
                              dataKey="units"
                              content={(props) => <DrawerBarValueLabel {...props} />}
                            />
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: 'var(--text)',
                      marginBottom: 8,
                    }}
                  >
                    Recent Orders ({skuDrawer.orders.length})
                  </div>
                  {skuDrawer.orders.length === 0 ? (
                    <div
                      style={{
                        color: 'var(--text3)',
                        fontSize: 12,
                        padding: 16,
                        textAlign: 'center',
                      }}
                    >
                      No orders found for this SKU.
                    </div>
                  ) : (
                    <div className="analysis-orders-table-wrap">
                      <table className="analysis-orders-table" style={{ tableLayout: 'fixed' }}>
                        <colgroup>
                          <col style={{ width: getDrawerOrderColumnWidth('orderNum') }} />
                          <col style={{ width: getDrawerOrderColumnWidth('customer') }} />
                          <col style={{ width: getDrawerOrderColumnWidth('qty') }} />
                          <col style={{ width: getDrawerOrderColumnWidth('cost') }} />
                          <col style={{ width: getDrawerOrderColumnWidth('status') }} />
                          <col style={{ width: getDrawerOrderColumnWidth('date') }} />
                        </colgroup>
                        <thead>
                          <tr>
                            <th style={{ position: 'relative' }}>
                              Order #
                              <ColumnResizeHandle
                                getStartWidth={() => getDrawerOrderColumnWidth('orderNum')}
                                onChange={(w) => handleResizeDrawerOrderColumn('orderNum', w)}
                                onReset={() => handleResetDrawerOrderColumn('orderNum')}
                                minWidth={DRAWER_ORDERS_COLUMN_MIN.orderNum}
                              />
                            </th>
                            <th className="is-center" style={{ position: 'relative' }}>
                              Customer
                              <ColumnResizeHandle
                                getStartWidth={() => getDrawerOrderColumnWidth('customer')}
                                onChange={(w) => handleResizeDrawerOrderColumn('customer', w)}
                                onReset={() => handleResetDrawerOrderColumn('customer')}
                                minWidth={DRAWER_ORDERS_COLUMN_MIN.customer}
                              />
                            </th>
                            <th className="is-center" style={{ position: 'relative' }}>
                              Qty
                              <ColumnResizeHandle
                                getStartWidth={() => getDrawerOrderColumnWidth('qty')}
                                onChange={(w) => handleResizeDrawerOrderColumn('qty', w)}
                                onReset={() => handleResetDrawerOrderColumn('qty')}
                                minWidth={DRAWER_ORDERS_COLUMN_MIN.qty}
                              />
                            </th>
                            <th className="is-center" style={{ position: 'relative' }}>
                              Cost
                              <ColumnResizeHandle
                                getStartWidth={() => getDrawerOrderColumnWidth('cost')}
                                onChange={(w) => handleResizeDrawerOrderColumn('cost', w)}
                                onReset={() => handleResetDrawerOrderColumn('cost')}
                                minWidth={DRAWER_ORDERS_COLUMN_MIN.cost}
                              />
                            </th>
                            <th className="is-center" style={{ position: 'relative' }}>
                              Status
                              <ColumnResizeHandle
                                getStartWidth={() => getDrawerOrderColumnWidth('status')}
                                onChange={(w) => handleResizeDrawerOrderColumn('status', w)}
                                onReset={() => handleResetDrawerOrderColumn('status')}
                                minWidth={DRAWER_ORDERS_COLUMN_MIN.status}
                              />
                            </th>
                            <th style={{ position: 'relative' }}>
                              Date
                              <ColumnResizeHandle
                                getStartWidth={() => getDrawerOrderColumnWidth('date')}
                                onChange={(w) => handleResizeDrawerOrderColumn('date', w)}
                                onReset={() => handleResetDrawerOrderColumn('date')}
                                minWidth={DRAWER_ORDERS_COLUMN_MIN.date}
                              />
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {skuDrawer.orders.map((order) => {
                            const orderStatus = displayText(order.orderStatus, '').trim()
                            const statusClass =
                              orderStatus === 'shipped'
                                ? 'is-shipped'
                                : orderStatus === 'awaiting_shipment'
                                  ? 'is-awaiting'
                                  : 'is-other'
                            const statusLabel = orderStatus
                              ? orderStatus.replace(/_/g, ' ')
                              : '—'

                            return (
                              <tr key={order.orderId}>
                                <td className="col-order-num">
                                  <button
                                    type="button"
                                    className="analysis-order-link"
                                    onClick={(event) => {
                                      event.preventDefault()
                                      event.stopPropagation()
                                      void openOrderDetails(order)
                                    }}
                                  >
                                    {order.orderNumber || String(order.orderId)}
                                  </button>
                                </td>
                                <td className="col-customer is-center">{displayText(order.shipToName)}</td>
                                <td className="col-qty is-center">{order.qty || 1}</td>
                                <td className="col-cost is-center">
                                  {order.externallyShipped ? (
                                    <span
                                      className="analysis-status-pill is-external"
                                      title="Externally fulfilled — shipped without a PrepShip label"
                                    >
                                      EXT
                                    </span>
                                  ) : (
                                    formatMoneyValue(order.standardShippingCost)
                                  )}
                                </td>
                                <td className="is-center">
                                  <span className={`analysis-status-pill ${statusClass}`}>
                                    {statusLabel}
                                  </span>
                                </td>
                                <td className="col-date">{formatDateOnly(order.orderDate)}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <OrderDetailDrawer
        orderId={orderDetailDrawer?.orderId ?? null}
        displayStatus={orderDetailDrawer?.status ?? undefined}
        presentation="centered"
        onClose={() => setOrderDetailDrawer(null)}
      />

      {orderModal.open ? (
        <div
          className="analysis-order-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`Order details ${orderModal.orderNumber}`}
          onClick={closeOrderDetails}
        >
          <div
            className="analysis-order-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="analysis-order-modal-header">
              <div>
                <div className="analysis-order-kicker">Order Details</div>
                <h3>{orderModal.orderNumber}</h3>
              </div>
              <button
                type="button"
                className="analysis-order-modal-close"
                onClick={closeOrderDetails}
                aria-label="Close order details"
              >
                x
              </button>
            </div>

            <div className="analysis-order-modal-body">
              {orderModal.loading ? (
                <div className="analysis-order-modal-state">
                  <div className="spinner" />
                  <span>Loading complete order details...</span>
                </div>
              ) : orderModal.error ? (
                <div className="analysis-order-modal-error">
                  <strong>Unable to load order</strong>
                  <span>{orderModal.error}</span>
                </div>
              ) : modalOrder ? (
                <>
                  <div className="analysis-order-simple-summary">
                    <div>
                      <span>Status</span>
                      <strong>{formatStatusText(asRecord(modalOrder).orderStatus)}</strong>
                    </div>
                    <div>
                      <span>Order Total</span>
                      <strong>{formatMoneyValue(modalItemsTotal ?? asRecord(modalOrder).orderTotal ?? modalRaw.orderTotal)}</strong>
                    </div>
                    <div>
                      <span>Shipping</span>
                      <strong>{formatMoneyValue(modalShipmentTotal ?? asRecord(modalOrder).shippingAmount ?? modalRaw.shippingAmount)}</strong>
                    </div>
                    <div>
                      <span>Items</span>
                      <strong>{modalItems.length.toLocaleString()}</strong>
                    </div>
                  </div>

                  <div className="analysis-order-sections">
                    <DetailSection title="Shipment Details">
                      <DetailField label="Ship To" value={modalShipTo.name} />
                      <div className="analysis-address-block">
                        {formatAddressLines(modalShipTo).length ? (
                          formatAddressLines(modalShipTo).map((line) => <div key={line}>{line}</div>)
                        ) : (
                          <span>-</span>
                        )}
                      </div>
                      <DetailField label="Phone" value={modalShipTo.phone} />
                      <DetailField label="Email" value={asRecord(modalOrder).customerEmail ?? modalRaw.customerEmail} />
                    </DetailSection>

                    <DetailSection title="Cost Summary">
                      <DetailField label="Product Total" value={formatMoneyValue(modalItemsTotal ?? modalRaw.amountPaid)} />
                      <DetailField label="Shipping" value={formatMoneyValue(modalShipmentTotal ?? modalRaw.shippingAmount)} />
                      <DetailField label="Tax" value={formatMoneyValue(modalRaw.taxAmount)} />
                      <DetailField label="Total Paid" value={formatMoneyValue(modalRaw.amountPaid)} />
                    </DetailSection>

                    <DetailSection title="Configure Shipment">
                      <DetailField label="Carrier" value={asRecord(modalOrder).carrierCode ?? modalRaw.carrierCode} />
                      <DetailField label="Service" value={asRecord(modalOrder).serviceCode ?? modalRaw.serviceCode} />
                      <DetailField label="Requested Service" value={modalRaw.requestedShippingService} />
                      <DetailField label="Package" value={modalRaw.packageCode} />
                      <DetailField label="Weight" value={formatOrderWeight(modalOrder)} />
                      <DetailField label="Dimensions" value={formatOrderDimensions(modalOrder)} />
                    </DetailSection>

                    <DetailSection title="Timeline">
                      <DetailField label="Order Date" value={formatDateTime(asRecord(modalOrder).orderDate ?? modalRaw.orderDate)} />
                      <DetailField label="Date Paid" value={formatDateTime(modalRaw.paymentDate ?? modalRaw.datePaid)} />
                      <DetailField label="Ship By" value={formatDateTime(modalRaw.shipByDate)} />
                      <DetailField label="Client ID" value={getDisplayClientId(modalOrder)} />
                    </DetailSection>
                  </div>

                  <div className="analysis-order-wide-section">
                    <h4>Line Items</h4>
                    {modalItems.length ? (
                      <div className="analysis-order-table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>SKU</th>
                              <th>Product</th>
                              <th>Qty</th>
                              <th>Unit</th>
                              <th>Total</th>
                            </tr>
                          </thead>
                          <tbody>
                            {modalItems.map((item, index) => {
                              const itemRecord = asRecord(item)
                              return (
                                <tr key={`${displayText(itemRecord.sku, 'item')}-${index}`}>
                                  <td>{displayText(itemRecord.sku, 'No SKU')}</td>
                                  <td>{displayText(itemRecord.name)}</td>
                                  <td>{getItemQty(item)}</td>
                                  <td>{formatMoneyValue(getItemUnitPrice(item))}</td>
                                  <td>{formatMoneyValue(getItemTotal(item))}</td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="analysis-empty-note">No line items are available for this order.</div>
                    )}
                  </div>

                  {modalAdjustments.length ? (
                    <div className="analysis-order-wide-section">
                      <h4>Discounts / Adjustments</h4>
                      <div className="analysis-order-table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Code</th>
                              <th>Description</th>
                              <th>Qty</th>
                              <th>Unit</th>
                              <th>Total</th>
                            </tr>
                          </thead>
                          <tbody>
                            {modalAdjustments.map((item, index) => {
                              const itemRecord = asRecord(item)
                              const adjustmentCode =
                                displayText(itemRecord.sku, '').trim()
                                || displayText(itemRecord.code, '').trim()
                                || displayText(itemRecord.name, '').trim()
                                || 'Discount'
                              const adjustmentDescription =
                                displayText(itemRecord.description, '').trim()
                                || (adjustmentCode === 'Discount' ? 'Adjustment' : 'Discount')
                              return (
                                <tr key={`${displayText(itemRecord.sku ?? itemRecord.name, 'adjustment')}-${index}`}>
                                  <td>{adjustmentCode}</td>
                                  <td>{adjustmentDescription}</td>
                                  <td>{getItemQty(item)}</td>
                                  <td>{formatMoneyValue(getItemUnitPrice(item))}</td>
                                  <td>{formatMoneyValue(getItemTotal(item))}</td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : null}

                  <div className="analysis-order-wide-section">
                    <h4>Shipments</h4>
                    {modalShipments.length ? (
                      <div className="analysis-order-table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Tracking</th>
                              <th>Carrier</th>
                              <th>Service</th>
                              <th>Cost</th>
                              <th>Ship Date</th>
                            </tr>
                          </thead>
                          <tbody>
                            {modalShipments.map((shipment, index) => {
                              const shipmentRecord = asRecord(shipment)
                              return (
                                <tr key={`${displayText(shipmentRecord.trackingNumber, 'shipment')}-${index}`}>
                                  <td>{displayText(shipmentRecord.trackingNumber)}</td>
                                  <td>{displayText(shipmentRecord.carrierCode)}</td>
                                  <td>{displayText(shipmentRecord.serviceCode)}</td>
                                  <td>{formatMoneyValue(getShipmentCost(shipment))}</td>
                                  <td>{formatDateTime(shipmentRecord.shipDate ?? shipmentRecord.labelShipDate)}</td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="analysis-empty-note">No shipment records are linked to this order.</div>
                    )}
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
