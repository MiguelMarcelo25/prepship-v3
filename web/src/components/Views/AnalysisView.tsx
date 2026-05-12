// @ts-nocheck
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
  DEFAULT_COLUMN_ORDER,
  REQUIRED_COLUMNS,
  readStoredColumnLayout,
  writeStoredColumnLayout,
  ANALYSIS_SORT_LABELS,
  type AnalysisColumnLayout,
} from './analysis-parity'
import { AnalysisDataTable } from './AnalysisDataTable'
import { AnalysisPagination } from './AnalysisPagination'
import type { AnalysisTableColumn, ColumnWidths } from './AnalysisTableHeader'
import { AnalysisTopSkusChart } from './AnalysisTopSkusChart'
import OrderDetailDrawer from '../OrderDetailDrawer'
import { SortableHeader, nextSortState, sortRows } from '../SortableTable'
import { ColumnResizeHandle } from './ColumnResizeHandle'
import './InventoryView.css'
import './AnalysisView.css'

// SKU drawer's "Recent Orders" table — user-resizable columns. Widths persist
// per-browser via localStorage so the layout sticks across page loads. Defaults
// roughly match the previous fixed-CSS layout; no <colgroup> means the table
// stays auto-sized until the user drags a handle.
type DrawerOrdersColumnKey = 'orderNum' | 'customer' | 'qty' | 'cost' | 'status' | 'date'
// Defaults tuned for the 820-px analysis-sku-drawer-panel — the
// content area is ~770 px after panel + table-wrap padding/borders.
// Previous totals (850 px) blew past that and pushed Status off the
// right edge under the old `overflow: hidden` wrap. New totals
// (770 px) fit exactly in the drawer, and the wrap now allows
// horizontal scroll if an operator drags any column wider via
// the resize handles.
const DRAWER_ORDERS_COLUMN_DEFAULTS: Record<DrawerOrdersColumnKey, number> = {
  date: 140,
  orderNum: 140,
  customer: 180,
  qty: 50,
  cost: 160,
  status: 100,
}
const DRAWER_ORDERS_COLUMN_MIN: Record<DrawerOrdersColumnKey, number> = {
  date: 120,
  orderNum: 90,
  customer: 100,
  qty: 44,
  cost: 110,
  status: 70,
}
const DRAWER_ORDERS_STORAGE_KEY = 'analysis_sku_drawer_widths'

// Sort state for the SKU-drawer "Recent Orders" table. Mirrors the main
// analysis grid's pattern (session-only, not persisted): operators can
// re-sort during a session, but a page refresh snaps back to the default
// (date / desc → newest first). Defaulting to desc on a NEW column click
// matches AnalysisView.handleSort behavior so muscle memory carries over.
type DrawerOrdersSortDir = 'asc' | 'desc'
const DEFAULT_DRAWER_ORDERS_SORT_KEY: DrawerOrdersColumnKey = 'date'
const DEFAULT_DRAWER_ORDERS_SORT_DIR: DrawerOrdersSortDir = 'desc'

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
        // Clamp persisted widths up to the current MIN. This handles the
        // 2026-05-09 change where the Date column moved to the leftmost
        // position and now shows a timestamp — returning users had
        // date:100 saved, which is too narrow for "May 8, 2026, 3:45 PM".
        const min = DRAWER_ORDERS_COLUMN_MIN[key as DrawerOrdersColumnKey]
        cleaned[key as DrawerOrdersColumnKey] = Math.max(value, min)
      }
    }
    return cleaned
  } catch {
    return {}
  }
}

const TABLE_COLUMN_COUNT = 13
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
  {
    key: 'trend',
    title:
      'Daily-units trend across the selected range. Green when the latest half outpaces the earliest half, red when the latest half drops below. Click to sort by trend strength.',
    align: 'center',
  },
  // 2026-05-12 boss-requested columns. Avg Sell Price comes first so
  // operators reading left-to-right see the per-unit price before the
  // bulk revenue figure. Revenue = SUM(unit_price × qty) per SKU;
  // Avg Sell Price = revenue / total_qty (units, not orders).
  {
    key: 'avgPrice',
    title:
      'Average selling price per unit = total revenue ÷ total units. Derived from orders.items.unitPrice (camel) or unit_price (snake) — both shapes accepted depending on the marketplace integration that ingested the order.',
    align: 'right',
  },
  {
    key: 'revenue',
    title:
      'Total revenue for this SKU across the selected date range. Sum of (unit_price × qty) over every non-cancelled order. Excludes orders from disabled clients.',
    align: 'right',
  },
  { key: 'stdOrders', title: 'SS-labeled standard service orders (count + avg cost)', align: 'right' },
  { key: 'expOrders', title: 'SS-labeled expedited service orders (count + avg cost)', align: 'right' },
  {
    key: 'total',
    title: 'Total SS label cost (allocated by item units in multi-item orders)',
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

// Extract a comparable value for the SKU-drawer "Recent Orders" sort.
// Returns null when the field is missing — those rows always sort last
// regardless of direction (predictable UX; matches industry standard).
function drawerOrderSortValue(
  order: Record<string, unknown>,
  key: DrawerOrdersColumnKey,
): number | string | null {
  switch (key) {
    case 'date': {
      const raw = order.orderDate
      if (typeof raw !== 'string' || !raw.trim()) return null
      // Same Z-normalization formatDateTime uses, so dates without
      // an explicit offset still parse as UTC (then PT-displayed).
      const normalized = /(?:z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`
      const t = Date.parse(normalized)
      return Number.isFinite(t) ? t : null
    }
    case 'orderNum': {
      // Sort by displayed value: orderNumber if present, else orderId.
      // Lowercase so the sort is case-insensitive (e.g. SP6197 vs sp6197).
      if (typeof order.orderNumber === 'string' && order.orderNumber.trim()) {
        return order.orderNumber.toLowerCase()
      }
      return order.orderId != null ? String(order.orderId) : null
    }
    case 'customer': {
      const v = order.shipToName
      return typeof v === 'string' && v.trim() ? v.toLowerCase() : null
    }
    case 'qty': return numberValue(order.qty) ?? 1
    case 'cost': {
      // EXT rows have no shipping-cost number — treat as null so they
      // group at the bottom regardless of asc/desc.
      if (order.externallyShipped) return null
      return numberValue(order.standardShippingCost)
        ?? numberValue(order.shippingCost)
    }
    case 'status': {
      const v = order.orderStatus
      return typeof v === 'string' && v.trim() ? v.toLowerCase() : null
    }
  }
}

function compareDrawerOrders(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  key: DrawerOrdersColumnKey,
  dir: DrawerOrdersSortDir,
): number {
  const av = drawerOrderSortValue(a, key)
  const bv = drawerOrderSortValue(b, key)
  if (av == null && bv == null) return 0
  if (av == null) return 1
  if (bv == null) return -1
  let cmp: number
  if (typeof av === 'number' && typeof bv === 'number') {
    cmp = av - bv
  } else {
    cmp = String(av).localeCompare(String(bv))
  }
  return dir === 'asc' ? cmp : -cmp
}

function renderDrawerShippingCost(order: Record<string, unknown>) {
  const qty = Math.max(1, Math.round(numberValue(order.qty) ?? 1))
  const unitCost = numberValue(order.standardShippingCost) ?? numberValue(order.shippingCost)
  if (unitCost == null) return '-'

  const totalCost =
    numberValue(order.standardShippingTotal) ??
    numberValue(order.shippingTotal) ??
    unitCost * qty

  if (qty <= 1) {
    return <span className="analysis-cost-unit">{formatMoneyValue(unitCost)}</span>
  }

  const title = `${formatMoneyValue(unitCost)} x ${qty} = ${formatMoneyValue(totalCost)}`

  return (
    <span className="analysis-cost-formula" title={title}>
      <span className="analysis-cost-unit">{formatMoneyValue(unitCost)}</span>
      <span className="analysis-cost-multiplier">X{qty}</span>
      <span className="analysis-cost-total">= {formatMoneyValue(totalCost)}</span>
    </span>
  )
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
  // Sort state — session-only, NOT persisted (boss directive
  // 2026-05-07): every page refresh resets to qty/desc. Within a
  // session the operator can click any column header to re-sort and
  // toggle direction; on reload it always snaps back to "Total Qty,
  // largest first" so the dashboard tells the same story on first
  // glance every time.
  const [sortKey, setSortKey] = useState<AnalysisSortKey>('qty')
  const [sortDir, setSortDir] = useState<AnalysisSortDir>('desc')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [columnSize, setColumnSize] = useState<ColumnSize>(readStoredColumnSize)
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>(readStoredColumnWidths)
  // Per-operator column layout: order + hidden set. Drag a header
  // to reorder; click the "Columns" button (top of the table panel)
  // to toggle visibility. Persisted to localStorage on every change
  // so the layout survives reloads and tab moves.
  const [columnLayout, setColumnLayout] = useState<AnalysisColumnLayout>(readStoredColumnLayout)
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false)
  // Ref to the trigger button + computed viewport coordinates for the
  // popover. The menu is rendered via React Portal into document.body
  // so it escapes the sticky panel's overflow:hidden clipping. We
  // recompute the rect on open, scroll, and resize so the menu stays
  // anchored to the trigger as the page moves underneath it.
  const columnsTriggerRef = useRef<HTMLButtonElement | null>(null)
  const [columnsMenuRect, setColumnsMenuRect] = useState<{ top: number; right: number } | null>(null)
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
  // Sort for the drawer's "Recent Orders" table. Persists across drawer
  // opens within the session (so the operator's sort choice survives
  // jumping between SKUs), resets on page refresh.
  const [drawerOrdersSortKey, setDrawerOrdersSortKey] =
    useState<DrawerOrdersColumnKey>(DEFAULT_DRAWER_ORDERS_SORT_KEY)
  const [drawerOrdersSortDir, setDrawerOrdersSortDir] =
    useState<DrawerOrdersSortDir>(DEFAULT_DRAWER_ORDERS_SORT_DIR)
  const [modalItemsSort, setModalItemsSort] = useState(null)
  const [modalAdjustmentsSort, setModalAdjustmentsSort] = useState(null)
  const [modalShipmentsSort, setModalShipmentsSort] = useState(null)
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
  // Apply the current sort to a copy of skuDrawer.orders. The DTO's
  // `orders` array isn't mutated (toSorted would also work, but spread
  // + sort is broadly polyfilled).
  const sortedDrawerOrders = useMemo(() => {
    if (!skuDrawer) return [] as InventorySkuOrdersDto['orders']
    const orders = skuDrawer.orders ?? []
    return [...orders].sort((a, b) =>
      compareDrawerOrders(
        a as Record<string, unknown>,
        b as Record<string, unknown>,
        drawerOrdersSortKey,
        drawerOrdersSortDir,
      ),
    )
  }, [skuDrawer, drawerOrdersSortKey, drawerOrdersSortDir])

  // Derive the columns array we actually pass to <AnalysisDataTable>:
  //   1. Start from ANALYSIS_TABLE_COLUMNS (which carries align/title meta)
  //   2. Project them in `columnLayout.order` sequence
  //   3. Drop any column listed in `columnLayout.hidden`
  // Falls back to the original ANALYSIS_TABLE_COLUMNS array if the
  // projection ends up empty (defense against malformed storage).
  const displayColumns = useMemo<AnalysisTableColumn[]>(() => {
    const byKey = new Map<AnalysisSortKey, AnalysisTableColumn>()
    for (const col of ANALYSIS_TABLE_COLUMNS) byKey.set(col.key, col)
    const hiddenSet = new Set(columnLayout.hidden)
    const projected: AnalysisTableColumn[] = []
    for (const key of columnLayout.order) {
      if (hiddenSet.has(key)) continue
      const meta = byKey.get(key)
      if (meta) projected.push(meta)
    }
    return projected.length > 0 ? projected : ANALYSIS_TABLE_COLUMNS
  }, [columnLayout])

  // Drag-reorder: insert `fromKey` immediately BEFORE `toKey` in the
  // saved order. Standard spreadsheet semantics — dragging A onto C
  // puts A right before C (A,B,C,D → B,A,C,D when A is dropped on C).
  // The hidden-set is untouched; a reorder doesn't change visibility.
  function handleReorderColumns(fromKey: AnalysisSortKey, toKey: AnalysisSortKey) {
    setColumnLayout((current) => {
      const next = current.order.filter((k) => k !== fromKey)
      const dropIdx = next.indexOf(toKey)
      if (dropIdx < 0) {
        // Defensive: shouldn't happen, but fall back to append-end.
        next.push(fromKey)
      } else {
        next.splice(dropIdx, 0, fromKey)
      }
      return { ...current, order: next }
    })
  }

  // Toggle a column's visibility. REQUIRED_COLUMNS (currently just
  // 'name') can never be hidden — the operator would lose row identity.
  function handleToggleColumnVisibility(key: AnalysisSortKey) {
    if (REQUIRED_COLUMNS.has(key)) return
    setColumnLayout((current) => {
      const hiddenSet = new Set(current.hidden)
      if (hiddenSet.has(key)) hiddenSet.delete(key)
      else hiddenSet.add(key)
      return { ...current, hidden: Array.from(hiddenSet) }
    })
  }

  // "Reset" button in the Columns popover — restore the factory
  // default layout. Doesn't touch sort/widths/sizes; only the column
  // visibility + order. Saves immediately via the persistence effect.
  function handleResetColumnLayout() {
    setColumnLayout({ order: [...DEFAULT_COLUMN_ORDER], hidden: [] })
  }

  // Persist layout on every change. Cheap (one localStorage.setItem
  // per state update; the JSON is ~150 bytes) and ensures the layout
  // survives a hard reload mid-session.
  useEffect(() => {
    writeStoredColumnLayout(columnLayout)
  }, [columnLayout])

  // Click-outside dismisses the Columns popover so it behaves like
  // every other dropdown in the app (date preset menu, etc.). Because
  // the menu is rendered into document.body via portal, the standard
  // `closest('[data-columns-menu]')` check still works (it traverses
  // up from the click target through the real DOM, which now includes
  // the body-anchored menu).
  useEffect(() => {
    if (!columnsMenuOpen) return
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as HTMLElement | null
      if (target?.closest('[data-columns-menu]')) return
      if (target?.closest('[data-columns-trigger]')) return
      setColumnsMenuOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [columnsMenuOpen])

  // Position the portal-rendered popover under the trigger button.
  // Recompute on open + on scroll/resize so the menu stays anchored
  // even if the page moves underneath it. useLayoutEffect (not
  // useEffect) so the position is computed BEFORE first paint —
  // prevents a one-frame flash at top:0,right:0 before the
  // measurement lands.
  useLayoutEffect(() => {
    if (!columnsMenuOpen) {
      setColumnsMenuRect(null)
      return
    }
    function update() {
      const el = columnsTriggerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      // `right` is measured from the viewport's right edge so the
      // popover's right edge aligns with the button's right edge —
      // matches the original absolute `right-0` behavior.
      setColumnsMenuRect({
        top: rect.bottom + 4,
        right: Math.max(8, window.innerWidth - rect.right),
      })
    }
    update()
    // Capture phase on scroll so we catch nested scroll containers
    // (the page-level view-content scrolls, the sticky panel
    // itself does not, but we want defense in depth).
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [columnsMenuOpen])

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
  // Toggle sort: clicking a NEW column starts at desc (highest values
  // / newest dates first), clicking the SAME column flips direction.
  // Mirrors handleSort for the main analysis grid (line ~796) so the
  // two tables feel like the same control.
  function handleSortDrawerOrders(key: DrawerOrdersColumnKey) {
    if (key === drawerOrdersSortKey) {
      setDrawerOrdersSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'))
    } else {
      setDrawerOrdersSortKey(key)
      setDrawerOrdersSortDir('desc')
    }
  }
  function handleResetDrawerOrderColumn(key: DrawerOrdersColumnKey) {
    setDrawerOrderWidths((current) => {
      if (!(key in current)) return current
      const { [key]: _removed, ...rest } = current
      return rest
    })
  }

  // The effect that used to ResizeObserver the .analysis-sticky-panel
  // and write its height into --analysis-table-sticky-top was deleted
  // 2026-05-12 when the panel itself stopped being position:sticky.
  // The CSS variable now stays at its declared default of 0px (set in
  // AnalysisDataTable.css on #view-analysis.view-content), so the
  // table's own sticky thead anchors directly to the top of the
  // view-content scroll container. stickyPanelRef is preserved for
  // legacy callers but no longer drives sticky offset math.

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

  // One-shot cleanup: previous version persisted sort preference
  // to localStorage. Per boss directive 2026-05-07 the analysis
  // sort is now session-only, so wipe any leftover preference
  // from the older implementation on first mount. removeItem on a
  // missing key is a safe no-op.
  useEffect(() => {
    try { window.localStorage.removeItem('prepship_analysis_sort') } catch { /* ignore */ }
  }, [])

  // Click a column header to toggle sort (session-only, no
  // persistence):
  //   - First click on a NEW column → sort by that column, descending
  //   - Subsequent clicks on the SAME column → toggle asc ↔ desc
  //   - Page resets to 1 so the leading row stays visible after sort
  //   - On page refresh, sort snaps back to qty/desc (the default).
  //     The operator's session-time sort choice is intentionally
  //     ephemeral — the dashboard always opens with the same view.
  function handleSort(key: AnalysisSortKey) {
    const nextDir: AnalysisSortDir =
      key === sortKey ? (sortDir === 'asc' ? 'desc' : 'asc') : 'desc'
    setSortKey(key)
    setSortDir(nextDir)
    setPage(1)
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
  const sortedModalItems = useMemo(() => sortRows(
    modalItems,
    modalItemsSort,
    (item, key) => {
      const itemRecord = asRecord(item)
      switch (key) {
        case 'sku':
          return itemRecord.sku
        case 'product':
          return itemRecord.name
        case 'qty':
          return getItemQty(item)
        case 'unit':
          return getItemUnitPrice(item)
        case 'total':
          return getItemTotal(item)
        default:
          return ''
      }
    },
    (item) => asRecord(item).sku ?? asRecord(item).name,
  ), [modalItems, modalItemsSort])
  const sortedModalAdjustments = useMemo(() => sortRows(
    modalAdjustments,
    modalAdjustmentsSort,
    (item, key) => {
      const itemRecord = asRecord(item)
      const adjustmentCode =
        displayText(itemRecord.sku, '').trim()
        || displayText(itemRecord.code, '').trim()
        || displayText(itemRecord.name, '').trim()
        || 'Discount'
      const adjustmentDescription =
        displayText(itemRecord.description, '').trim()
        || (adjustmentCode === 'Discount' ? 'Adjustment' : 'Discount')

      switch (key) {
        case 'code':
          return adjustmentCode
        case 'description':
          return adjustmentDescription
        case 'qty':
          return getItemQty(item)
        case 'unit':
          return getItemUnitPrice(item)
        case 'total':
          return getItemTotal(item)
        default:
          return ''
      }
    },
    (item) => asRecord(item).sku ?? asRecord(item).name,
  ), [modalAdjustments, modalAdjustmentsSort])
  const sortedModalShipments = useMemo(() => sortRows(
    modalShipments,
    modalShipmentsSort,
    (shipment, key) => {
      const shipmentRecord = asRecord(shipment)
      switch (key) {
        case 'tracking':
          return shipmentRecord.trackingNumber
        case 'carrier':
          return shipmentRecord.carrierCode
        case 'service':
          return shipmentRecord.serviceCode
        case 'cost':
          return getShipmentCost(shipment)
        case 'shipDate':
          return shipmentRecord.shipDate || shipmentRecord.labelShipDate
            ? new Date(String(shipmentRecord.shipDate ?? shipmentRecord.labelShipDate))
            : null
        default:
          return ''
      }
    },
    (shipment) => asRecord(shipment).trackingNumber,
  ), [modalShipments, modalShipmentsSort])

  return (
    <div className="view-content" id="view-analysis">
      {/* Sticky behavior on this panel was removed 2026-05-12 per
          operator request — they wanted natural document-flow scroll
          so the chart goes up and out of view as they read the table,
          instead of staying frozen at the top. The .analysis-sticky-
          panel class is kept because it owns the chart's stacking
          context (overflow:hidden + isolation:isolate); only the
          inline position/top/zIndex props are dropped. The CSS
          variable --analysis-table-sticky-top still resolves to 0px
          via the CSS default rule, so the table's own thead sticks
          to the top of the view-content scroll container directly. */}
      <div
        ref={stickyPanelRef}
        className="analysis-sticky-panel"
        style={{
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
          {/* Columns button — opens a checklist popover so the operator
              can toggle individual columns on/off. The 'name' column is
              shown as a disabled checkmark (REQUIRED_COLUMNS) so it
              can't be hidden. The popover itself is rendered via React
              Portal into document.body (see {createPortal(...)} below)
              so it escapes the sticky panel's overflow:hidden — without
              the portal, the popover gets clipped at the panel's
              bottom edge and looks like the list is truncated.
              Click anywhere outside the popover to close. */}
          <div className="ml-2">
            <button
              type="button"
              data-columns-trigger
              ref={columnsTriggerRef}
              onClick={() => setColumnsMenuOpen((v) => !v)}
              aria-haspopup="true"
              aria-expanded={columnsMenuOpen}
              className="inline-flex items-center gap-1.5 h-7 px-2.5 border border-line-2 rounded-md bg-surface text-[10.5px] font-bold uppercase tracking-[0.05em] text-ink-2 cursor-pointer transition-colors duration-150 hover:bg-[rgba(42,91,215,.08)] hover:text-brand hover:border-brand/30"
              title="Show or hide columns · drag column headers to reorder"
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="1.5" y="2.5" width="3.5" height="11" rx="0.7" stroke="currentColor" strokeWidth="1.4" />
                <rect x="6.25" y="2.5" width="3.5" height="11" rx="0.7" stroke="currentColor" strokeWidth="1.4" />
                <rect x="11" y="2.5" width="3.5" height="11" rx="0.7" stroke="currentColor" strokeWidth="1.4" />
              </svg>
              Columns
              <span className="text-ink-3 font-mono tabular-nums">
                ({displayColumns.length}/{DEFAULT_COLUMN_ORDER.length})
              </span>
            </button>
            {columnsMenuOpen && columnsMenuRect && typeof document !== 'undefined' ? createPortal(
              // Three-region menu (header + scrollable body + footer)
              // rendered into document.body via Portal so it escapes
              // the sticky panel's overflow:hidden. position: fixed
              // anchors to viewport coordinates computed from the
              // trigger button's bounding rect (recomputed on
              // scroll/resize in the useLayoutEffect above).
              //
              //   - maxHeight: min(420px, 70vh) caps the menu so it
              //     can't overflow viewport regardless of where the
              //     trigger sits. The inner scrolling region engages
              //     when content exceeds this cap.
              //   - flex flex-col + flex-1 min-h-0 on the body region
              //     is the canonical pattern for "middle child fills
              //     remaining space and scrolls independently" while
              //     header + footer stay pinned.
              //   - overflow-hidden on the outer container keeps the
              //     rounded corners + shadow looking clean — the inner
              //     scrolling region handles overflow-y.
              <div
                data-columns-menu
                role="menu"
                style={{
                  position: 'fixed',
                  top: columnsMenuRect.top,
                  right: columnsMenuRect.right,
                  maxHeight: 'min(420px, 70vh)',
                }}
                className="z-[100] min-w-[230px] bg-surface border border-line rounded-md shadow-[0_8px_24px_-6px_rgba(15,23,42,.18),0_2px_6px_-2px_rgba(15,23,42,.10)] flex flex-col overflow-hidden"
              >
                <div className="px-2 py-1.5 text-[9px] uppercase tracking-[0.08em] font-extrabold text-ink-3 flex items-center justify-between flex-shrink-0 border-b border-line bg-surface-2/40">
                  <span>Visible columns</span>
                  <button
                    type="button"
                    onClick={handleResetColumnLayout}
                    className="appearance-none border-0 bg-transparent text-[9.5px] font-bold text-brand cursor-pointer hover:underline"
                    title="Restore the factory default column order and show all columns"
                  >
                    Reset
                  </button>
                </div>
                {/* Scrollable list region. flex-1 + min-h-0 is the
                    canonical 'allow this flex child to shrink and
                    overflow' incantation — without min-h-0 the flex
                    child would refuse to shrink below content height
                    and the overflow-y-auto would never engage.
                    overscrollBehavior: 'contain' prevents the scroll
                    from chaining to the page when the operator hits
                    top/bottom of the list — no surprise jumps. */}
                <div
                  className="flex-1 min-h-0 overflow-y-auto p-1.5"
                  style={{ overscrollBehavior: 'contain' }}
                >
                  {/* List in the operator's CURRENT order so they see
                      exactly how reordering has shifted things since
                      factory default. Hidden columns are listed at the
                      bottom (grayed) so they're easy to find + re-enable. */}
                  {(() => {
                    const hiddenSet = new Set(columnLayout.hidden)
                    const visibleKeys = columnLayout.order.filter((k) => !hiddenSet.has(k))
                    const hiddenKeys = columnLayout.order.filter((k) => hiddenSet.has(k))
                    return [...visibleKeys, ...hiddenKeys].map((key) => {
                      const isHidden = hiddenSet.has(key)
                      const isRequired = REQUIRED_COLUMNS.has(key)
                      return (
                        <label
                          key={key}
                          className={`flex items-center gap-2 px-2 py-1.5 rounded-[5px] text-[12px] transition-colors duration-100 ${
                            isRequired
                              ? 'text-ink-3 cursor-not-allowed'
                              : 'text-ink cursor-pointer hover:bg-[rgba(42,91,215,.08)]'
                          } ${isHidden ? 'opacity-60' : ''}`}
                          title={
                            isRequired
                              ? 'Item Name is always visible — rows have no identity without it'
                              : isHidden
                                ? 'Hidden · click to show'
                                : 'Visible · click to hide'
                          }
                        >
                          <input
                            type="checkbox"
                            checked={!isHidden}
                            disabled={isRequired}
                            onChange={() => handleToggleColumnVisibility(key)}
                            className="accent-brand cursor-pointer disabled:cursor-not-allowed"
                          />
                          <span className="flex-1">{ANALYSIS_SORT_LABELS[key]}</span>
                          {isRequired ? (
                            <span className="text-[9px] uppercase tracking-[0.04em] text-ink-3 font-semibold">
                              required
                            </span>
                          ) : null}
                        </label>
                      )
                    })
                  })()}
                </div>
                <div className="border-t border-line px-2 py-1.5 text-[10.5px] text-ink-3 leading-snug flex-shrink-0 bg-surface-2/40 flex items-center justify-between">
                  <span>Drag a column header to reorder.</span>
                  {/* Item count hint — at-a-glance signal of how many
                      columns are in the list. If the operator sees
                      e.g. "11 columns" but only 8 fit on screen, they
                      know to scroll the body to find the rest. */}
                  <span className="font-mono tabular-nums text-ink-3/80">
                    {DEFAULT_COLUMN_ORDER.length} columns
                  </span>
                </div>
              </div>,
              document.body
            ) : null}
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
        columns={displayColumns}
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
        onReorder={handleReorderColumns}
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
                          <col style={{ width: getDrawerOrderColumnWidth('date') }} />
                          <col style={{ width: getDrawerOrderColumnWidth('orderNum') }} />
                          <col style={{ width: getDrawerOrderColumnWidth('customer') }} />
                          <col style={{ width: getDrawerOrderColumnWidth('qty') }} />
                          <col style={{ width: getDrawerOrderColumnWidth('cost') }} />
                          <col style={{ width: getDrawerOrderColumnWidth('status') }} />
                        </colgroup>
                        <thead>
                          <tr>
                            {([
                              { key: 'date', label: 'Date', center: false },
                              { key: 'orderNum', label: 'Order #', center: false },
                              { key: 'customer', label: 'Customer', center: true },
                              { key: 'qty', label: 'Qty', center: true },
                              { key: 'cost', label: 'Cost', center: true },
                              { key: 'status', label: 'Status', center: true },
                            ] as Array<{
                              key: DrawerOrdersColumnKey
                              label: string
                              center: boolean
                            }>).map(({ key, label, center }) => {
                              const active = drawerOrdersSortKey === key
                              // Operator preference (2026-05-12): render the
                              // directional arrow ONLY when this column is the
                              // active sort. The neutral up-down "↕" on every
                              // header competes with the label for attention
                              // and adds noise; dropping it makes the active
                              // sort signal much louder (one arrow on the
                              // screen instead of N). Clicking the title still
                              // triggers sort.
                              const indicator = active
                                ? drawerOrdersSortDir === 'asc' ? '↑' : '↓'
                                : null
                              const ariaSort: 'ascending' | 'descending' | 'none' =
                                active
                                  ? drawerOrdersSortDir === 'asc' ? 'ascending' : 'descending'
                                  : 'none'
                              return (
                                <th
                                  key={key}
                                  className={center ? 'is-center' : undefined}
                                  style={{ position: 'relative', padding: 0 }}
                                  aria-sort={ariaSort}
                                >
                                  <button
                                    type="button"
                                    className={`analysis-orders-sort-btn${
                                      center ? ' is-center' : ''
                                    }${active ? ' is-active' : ''}`}
                                    onClick={() => handleSortDrawerOrders(key)}
                                  >
                                    <span>{label}</span>
                                    {indicator ? (
                                      <span
                                        className="analysis-orders-sort-ind is-active"
                                        aria-hidden="true"
                                      >
                                        {indicator}
                                      </span>
                                    ) : null}
                                  </button>
                                  <ColumnResizeHandle
                                    getStartWidth={() => getDrawerOrderColumnWidth(key)}
                                    onChange={(w) => handleResizeDrawerOrderColumn(key, w)}
                                    onReset={() => handleResetDrawerOrderColumn(key)}
                                    minWidth={DRAWER_ORDERS_COLUMN_MIN[key]}
                                  />
                                </th>
                              )
                            })}
                          </tr>
                        </thead>
                        <tbody>
                          {sortedDrawerOrders.map((order) => {
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
                                <td className="col-date">{formatDateTime(order.orderDate)}</td>
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
                                    renderDrawerShippingCost(order)
                                  )}
                                </td>
                                <td className="is-center">
                                  <span className={`analysis-status-pill ${statusClass}`}>
                                    {statusLabel}
                                  </span>
                                </td>
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
                              <SortableHeader sortKey="sku" sortState={modalItemsSort} onSort={(key) => setModalItemsSort((current) => nextSortState(current, key))}>SKU</SortableHeader>
                              <SortableHeader sortKey="product" sortState={modalItemsSort} onSort={(key) => setModalItemsSort((current) => nextSortState(current, key))}>Product</SortableHeader>
                              <SortableHeader sortKey="qty" sortState={modalItemsSort} onSort={(key) => setModalItemsSort((current) => nextSortState(current, key))}>Qty</SortableHeader>
                              <SortableHeader sortKey="unit" sortState={modalItemsSort} onSort={(key) => setModalItemsSort((current) => nextSortState(current, key))}>Unit</SortableHeader>
                              <SortableHeader sortKey="total" sortState={modalItemsSort} onSort={(key) => setModalItemsSort((current) => nextSortState(current, key))}>Total</SortableHeader>
                            </tr>
                          </thead>
                          <tbody>
                            {sortedModalItems.map((item, index) => {
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
                              <SortableHeader sortKey="code" sortState={modalAdjustmentsSort} onSort={(key) => setModalAdjustmentsSort((current) => nextSortState(current, key))}>Code</SortableHeader>
                              <SortableHeader sortKey="description" sortState={modalAdjustmentsSort} onSort={(key) => setModalAdjustmentsSort((current) => nextSortState(current, key))}>Description</SortableHeader>
                              <SortableHeader sortKey="qty" sortState={modalAdjustmentsSort} onSort={(key) => setModalAdjustmentsSort((current) => nextSortState(current, key))}>Qty</SortableHeader>
                              <SortableHeader sortKey="unit" sortState={modalAdjustmentsSort} onSort={(key) => setModalAdjustmentsSort((current) => nextSortState(current, key))}>Unit</SortableHeader>
                              <SortableHeader sortKey="total" sortState={modalAdjustmentsSort} onSort={(key) => setModalAdjustmentsSort((current) => nextSortState(current, key))}>Total</SortableHeader>
                            </tr>
                          </thead>
                          <tbody>
                            {sortedModalAdjustments.map((item, index) => {
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
                              <SortableHeader sortKey="tracking" sortState={modalShipmentsSort} onSort={(key) => setModalShipmentsSort((current) => nextSortState(current, key))}>Tracking</SortableHeader>
                              <SortableHeader sortKey="carrier" sortState={modalShipmentsSort} onSort={(key) => setModalShipmentsSort((current) => nextSortState(current, key))}>Carrier</SortableHeader>
                              <SortableHeader sortKey="service" sortState={modalShipmentsSort} onSort={(key) => setModalShipmentsSort((current) => nextSortState(current, key))}>Service</SortableHeader>
                              <SortableHeader sortKey="cost" sortState={modalShipmentsSort} onSort={(key) => setModalShipmentsSort((current) => nextSortState(current, key))}>Cost</SortableHeader>
                              <SortableHeader sortKey="shipDate" sortState={modalShipmentsSort} onSort={(key) => setModalShipmentsSort((current) => nextSortState(current, key))}>Ship Date</SortableHeader>
                            </tr>
                          </thead>
                          <tbody>
                            {sortedModalShipments.map((shipment, index) => {
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
