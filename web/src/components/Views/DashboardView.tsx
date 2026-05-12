// @ts-nocheck
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleX,
  Columns3,
  Filter,
  Loader2,
  Package,
  RefreshCw,
  Star,
} from 'lucide-react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { apiClient } from '../../api/client'
import {
  SortableHeader,
  nextSortState,
  sortRows,
  type SortState,
} from '../SortableTable'

type Client = { clientId: number; name: string }

type SalesPayload = {
  dates: string[]
  topSkus: Array<{ sku: string; name?: string; total_qty?: number; totalQty?: number; total?: number }>
  series: Record<string, number[]>
}

type InventoryItem = {
  id?: number
  sku?: string
  name?: string
  imageUrl?: string | null
  clientId?: number | null
  clientName?: string | null
  currentStock?: number
  stockQty?: number
  minStock?: number
  reorderLevel?: number
  soldLast30Days?: number
}

type AnalysisSku = {
  sku: string
  name?: string
  imageUrl?: string | null
  clientId?: number | null
  clientName?: string | null
  qty?: number
  totalShipping?: number
  blendedAvgShipping?: number
  standardAvgShipping?: number
  expeditedAvgShipping?: number
}

type RevenueAgg = {
  revenue: number
  units30: number
  units7: number
}

type TrendPoint = {
  day: string
  current: number
  prior: number
}

type HeatmapCell = {
  day: string
  qty: number
  deviation: number
  tone: 'high' | 'mid' | 'flat' | 'dip' | 'low'
}

type HeatmapRow = {
  label: string
  cells: HeatmapCell[]
}

type DashboardSkuRow = {
  sku: string
  product: string
  client: string
  category: string
  brand: string
  imageUrl?: string | null
  revenue: number
  avgPrice: number
  avgShipping: number
  stock: number
  minStock: number
  status: 'in' | 'low' | 'out'
  daysSupply: number | null
  restockQty: number
  units7: number
  units30: number
  priorUnits30: number
  priorAvg: number
  changePct: number
  trend: number[]
}

type DashboardSortKey =
  | 'sku'
  | 'product'
  | 'client'
  | 'revenue'
  | 'avgPrice'
  | 'avgShipping'
  | 'status'
  | 'daysSupply'
  | 'restockQty'
  | 'units7'
  | 'units30'
  | 'priorAvg'
  | 'changePct'

interface DashboardViewProps {
  onOpenSku?: (sku: string) => void
}

const TABLE_PAGE_SIZE = 10

const COLUMN_OPTIONS = [
  { key: 'store', label: 'Store' },
  { key: 'revenue', label: 'Revenue' },
  { key: 'avgPrice', label: 'Avg. Price' },
  { key: 'avgShipping', label: 'Avg. Shipping' },
  { key: 'stockStatus', label: 'Stock Status' },
  { key: 'daysSupply', label: 'Days Supply' },
  { key: 'restockQty', label: 'Restock Qty' },
  { key: 'units7', label: '7-Day Units' },
  { key: 'units30', label: '30-Day Units' },
  { key: 'priorAvg', label: '30-Day Avg.' },
  { key: 'changePct', label: 'vs Prior 30 Days' },
  // Trend was previously an anchor column (hardcoded at the
  // rightmost edge) but operators asked for it to behave like the
  // other data columns — draggable, resizable, hideable. Sort maps
  // to 'changePct' since the sparkline visualizes that metric.
  { key: 'trend', label: 'Trend' },
] as const

type ColumnKey = typeof COLUMN_OPTIONS[number]['key']

const DEFAULT_VISIBLE_COLUMNS = COLUMN_OPTIONS.reduce(
  (acc, option) => ({ ...acc, [option.key]: true }),
  {} as Record<ColumnKey, boolean>,
)

// ──────────────────────────────────────────────────────────────────
// Column metadata — single source of truth for the SKU Performance
// Summary table. Each entry maps a ColumnKey to:
//   sortKey    — DashboardSortKey to drive the SortableHeader
//   label      — column header text
//   align      — 'left' for text columns, 'right' for numeric
//   width      — default column width in px
//   minWidth   — floor enforced during resize so a column can't
//                collapse to 0 and disappear
//   renderCell — pure function: (row) → JSX for the cell body
//
// Both `<thead>` and `<tbody>` map over the operator's columnOrder
// state and look up metadata here, so reorder + resize affect
// header AND body together in one pass.
// ──────────────────────────────────────────────────────────────────
type ColumnAlign = 'left' | 'right'
interface SkuColumnMeta {
  sortKey: DashboardSortKey
  label: string
  align: ColumnAlign
  width: number
  minWidth: number
  renderCell: (row: DashboardSkuRow) => ReactNode
}

const SKU_COLUMNS: Record<ColumnKey, SkuColumnMeta> = {
  store: {
    sortKey: 'client', label: 'Store', align: 'left', width: 140, minWidth: 90,
    renderCell: (row) => <span className="text-xs text-ink-2 truncate block">{row.client}</span>,
  },
  revenue: {
    sortKey: 'revenue', label: 'Revenue', align: 'right', width: 110, minWidth: 80,
    renderCell: (row) => <span className="text-right font-mono text-xs text-ink">{formatMoney(row.revenue)}</span>,
  },
  avgPrice: {
    sortKey: 'avgPrice', label: 'Avg. Price', align: 'right', width: 110, minWidth: 80,
    renderCell: (row) => <span className="text-right font-mono text-xs text-ink-2">{formatMoneySmall(row.avgPrice)}</span>,
  },
  avgShipping: {
    sortKey: 'avgShipping', label: 'Avg. Shipping', align: 'right', width: 120, minWidth: 90,
    renderCell: (row) => <span className="text-right font-mono text-xs text-ink-2">{formatMoneySmall(row.avgShipping)}</span>,
  },
  stockStatus: {
    sortKey: 'status', label: 'Stock Status', align: 'left', width: 130, minWidth: 100,
    renderCell: (row) => <StatusBadge status={row.status} />,
  },
  daysSupply: {
    sortKey: 'daysSupply', label: 'Days Supply', align: 'right', width: 100, minWidth: 80,
    renderCell: (row) => <span className="text-right font-mono text-xs text-ink-2">{row.daysSupply == null ? '-' : formatInt(row.daysSupply)}</span>,
  },
  restockQty: {
    sortKey: 'restockQty', label: 'Restock Qty', align: 'right', width: 100, minWidth: 80,
    renderCell: (row) => <span className="text-right font-mono text-xs text-ink-2">{formatInt(row.restockQty)}</span>,
  },
  units7: {
    sortKey: 'units7', label: '7-Day Units', align: 'right', width: 100, minWidth: 80,
    renderCell: (row) => <span className="text-right font-mono text-xs text-ink-2">{formatInt(row.units7)}</span>,
  },
  units30: {
    sortKey: 'units30', label: '30-Day Units', align: 'right', width: 110, minWidth: 80,
    renderCell: (row) => <span className="text-right font-mono text-xs font-semibold text-ink">{formatInt(row.units30)}</span>,
  },
  priorAvg: {
    sortKey: 'priorAvg', label: '30-Day Avg.', align: 'right', width: 110, minWidth: 80,
    renderCell: (row) => <span className="text-right font-mono text-xs text-ink-2">{formatInt(row.priorAvg)}</span>,
  },
  changePct: {
    sortKey: 'changePct', label: 'vs Prior 30 Days', align: 'right', width: 140, minWidth: 110,
    renderCell: (row) => (
      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-bold ${row.changePct >= 0 ? 'bg-ok/10 text-ok' : 'bg-danger/10 text-danger'}`}>
        {row.changePct >= 0 ? <ArrowUpRight size={11} strokeWidth={2.5} /> : <ArrowDownRight size={11} strokeWidth={2.5} />}
        {formatPct(row.changePct)}
      </span>
    ),
  },
  // Trend sparkline column. Sort key mirrors 'changePct' so clicking
  // the Trend header reorders the table by the same metric the
  // sparkline visualizes — operators don't need to learn a separate
  // "sort trend by what?" concept. Align left so the sparkline hugs
  // the left edge of the cell; min-width 70 keeps the line readable.
  trend: {
    sortKey: 'changePct', label: 'Trend', align: 'left', width: 90, minWidth: 70,
    renderCell: (row) => <TinyTrend values={last(row.trend, 12)} negative={row.changePct < 0} />,
  },
}

const DEFAULT_COLUMN_ORDER: ColumnKey[] = COLUMN_OPTIONS.map((c) => c.key)
const COLUMN_ORDER_STORAGE_KEY = 'dashboard:sku:column-order'
const COLUMN_WIDTHS_STORAGE_KEY = 'dashboard:sku:column-widths'

// Anchor columns (SKU + Product) — pinned to the left of the data
// columns, NOT reorderable (operators rely on these as the row's
// identity anchor and don't want them shuffled), but resizable
// because product names vary wildly in length. The 'star' and
// 'trend' anchor columns at either end are too narrow to benefit
// from resizing so they stay at static widths in the colgroup.
const ANCHOR_COLUMN_META = {
  sku: { defaultWidth: 110, minWidth: 80, label: 'SKU' },
  product: { defaultWidth: 280, minWidth: 180, label: 'Product' },
} as const
type AnchorColumnKey = keyof typeof ANCHOR_COLUMN_META

// Defensive migration: drop unknown keys (so a stale localStorage
// entry doesn't crash render-time mapping) and append any newly-added
// columns at the end (so returning operators auto-see new columns
// without a manual reset). Same pattern as Inventory + Packages
// column prefs.
function readStoredColumnOrder(): ColumnKey[] {
  if (typeof window === 'undefined') return [...DEFAULT_COLUMN_ORDER]
  try {
    const raw = window.localStorage.getItem(COLUMN_ORDER_STORAGE_KEY)
    if (!raw) return [...DEFAULT_COLUMN_ORDER]
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return [...DEFAULT_COLUMN_ORDER]
    const known = new Set<ColumnKey>(DEFAULT_COLUMN_ORDER)
    const seen = new Set<ColumnKey>()
    const out: ColumnKey[] = []
    for (const k of parsed) {
      if (typeof k === 'string' && known.has(k as ColumnKey) && !seen.has(k as ColumnKey)) {
        out.push(k as ColumnKey)
        seen.add(k as ColumnKey)
      }
    }
    // Append any missing keys (new columns shipped after the
    // operator's last save) at the end in default order so they're
    // discoverable but don't jump to the front uninvited.
    for (const k of DEFAULT_COLUMN_ORDER) {
      if (!seen.has(k)) out.push(k)
    }
    return out
  } catch {
    return [...DEFAULT_COLUMN_ORDER]
  }
}

// columnWidths now stores widths for both toggleable columns (keys in
// DEFAULT_COLUMN_ORDER) AND anchor columns (sku, product). The Record
// type is widened to string keys so anchor entries survive the
// round-trip through localStorage.
function readStoredColumnWidths(): Partial<Record<string, number>> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(COLUMN_WIDTHS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Partial<Record<string, number>> = {}
    // Allowed keys are the toggleable column keys + the two anchor
    // column keys. Anything else is dropped as stale state.
    const known = new Set<string>([...DEFAULT_COLUMN_ORDER, 'sku', 'product'])
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (known.has(k) && typeof v === 'number' && v > 0) {
        // Each known key has its own min — pull from SKU_COLUMNS for
        // toggleable, from ANCHOR_COLUMN_META for sku/product. Cap at
        // 600 so a runaway resize can't break layout.
        const min =
          k === 'sku' ? ANCHOR_COLUMN_META.sku.minWidth
          : k === 'product' ? ANCHOR_COLUMN_META.product.minWidth
          : SKU_COLUMNS[k as ColumnKey].minWidth
        out[k] = Math.max(min, Math.min(600, v))
      }
    }
    return out
  } catch {
    return {}
  }
}

function num(value: unknown, fallback = 0) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function formatInt(value: number) {
  return Math.round(value).toLocaleString('en-US')
}

function formatMoney(value: number) {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  })
}

function formatMoneySmall(value: number) {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function formatPct(value: number) {
  if (!Number.isFinite(value)) return '0%'
  return `${value > 0 ? '+' : ''}${value.toFixed(Math.abs(value) >= 10 ? 0 : 1)}%`
}

function dateOnly(daysAgo: number) {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - daysAgo)
  return d.toISOString().slice(0, 10)
}

function formatDayLabel(day: string) {
  if (!day) return ''
  const [year, month, date] = day.split('-').map((part) => Number(part))
  if (!year || !month || !date) return day
  return new Date(year, month - 1, date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

function formatDataTimestamp() {
  return new Date().toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function relativePct(current: number, prior: number) {
  if (prior <= 0 && current <= 0) return 0
  if (prior <= 0) return 100
  return ((current - prior) / prior) * 100
}

function sumValues(values: number[]) {
  return values.reduce((sum, value) => sum + num(value), 0)
}

function last(values: number[], count: number) {
  return values.slice(Math.max(0, values.length - count))
}

function safeArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}

function normalizeSku(value: unknown) {
  return String(value ?? '').trim()
}

function stockStatus(stock: number, minStock: number): DashboardSkuRow['status'] {
  if (stock <= 0) return 'out'
  if (stock <= minStock) return 'low'
  return 'in'
}

function statusLabel(status: DashboardSkuRow['status']) {
  if (status === 'out') return 'Out of Stock'
  if (status === 'low') return 'Low Stock'
  return 'In Stock'
}

function heatmapTone(deviation: number): HeatmapCell['tone'] {
  if (deviation >= 20) return 'high'
  if (deviation >= 10) return 'mid'
  if (deviation > -10) return 'flat'
  if (deviation > -20) return 'dip'
  return 'low'
}

function productFamily(name: string, sku: string) {
  const text = `${name} ${sku}`.toLowerCase()
  if (/ramen|noodle|chapagetti|shin|buldak/.test(text)) return 'Ramen Noodles'
  if (/milk|drink|juice|beverage|soda/.test(text)) return 'Drinks'
  if (/soup|stew|sauce|seasoning/.test(text)) return 'Soups & Sauces'
  if (/book|tagalog|vietnamese|shapes|numbers|colors/.test(text)) return 'Books'
  if (/snack|chip|cracker|cookie|candy/.test(text)) return 'Snacks'
  const words = name.split(/\s+/).filter(Boolean)
  return words.slice(0, 2).join(' ') || sku || 'Other SKUs'
}

async function fetchOrdersWindow(query: {
  from: string
  to: string
  clientId?: number
}) {
  const first = await apiClient.fetchOrders({
    page: 1,
    pageSize: 2000,
    dateStart: query.from,
    dateEnd: query.to,
    ...(query.clientId ? { clientId: query.clientId } : {}),
  })
  const orders = safeArray<any>(first?.orders)
  const pages = Math.min(num(first?.pages, 1), 5)
  if (pages <= 1) return orders

  const rest = await Promise.all(
    Array.from({ length: pages - 1 }, (_, index) =>
      apiClient
        .fetchOrders({
          page: index + 2,
          pageSize: 2000,
          dateStart: query.from,
          dateEnd: query.to,
          ...(query.clientId ? { clientId: query.clientId } : {}),
        })
        .then((res: any) => safeArray<any>(res?.orders))
        .catch(() => [])
    )
  )

  return [...orders, ...rest.flat()]
}

function aggregateOrders(orders: any[], sevenDayStart: string) {
  const bySku = new Map<string, RevenueAgg>()
  let revenue = 0
  let units = 0

  for (const order of orders) {
    const orderTotal = num(order?.orderTotal)
    const orderDay = String(order?.orderDate ?? '').slice(0, 10)
    const items = safeArray<any>(order?.items)
      .map((item) => {
        const sku = normalizeSku(item?.sku)
        const qty = Math.max(0, num(item?.quantity, 1))
        const adjustment = item?.adjustment === true || String(item?.adjustment ?? '').toLowerCase() === 'true'
        return { sku, qty, adjustment }
      })
      .filter((item) => item.sku && item.qty > 0 && !item.adjustment)

    const orderQty = items.reduce((sum, item) => sum + item.qty, 0)
    revenue += orderTotal
    units += orderQty

    for (const item of items) {
      const current = bySku.get(item.sku) ?? { revenue: 0, units30: 0, units7: 0 }
      current.units30 += item.qty
      if (orderDay >= sevenDayStart) current.units7 += item.qty
      current.revenue += orderQty > 0 ? orderTotal * (item.qty / orderQty) : 0
      bySku.set(item.sku, current)
    }
  }

  return { bySku, revenue, units }
}

function buildTrend(current: SalesPayload, prior: SalesPayload): TrendPoint[] {
  const currentDates = safeArray<string>(current?.dates)
  const priorDates = safeArray<string>(prior?.dates)
  const currentSeries = current?.series ?? {}
  const priorSeries = prior?.series ?? {}

  return currentDates.map((day, index) => {
    const currentTotal = Object.keys(currentSeries).reduce(
      (sum, sku) => sum + num(currentSeries[sku]?.[index]),
      0,
    )
    const priorTotal = Object.keys(priorSeries).reduce(
      (sum, sku) => sum + num(priorSeries[sku]?.[index] ?? priorSeries[sku]?.[priorDates.length - currentDates.length + index]),
      0,
    )
    return { day, current: currentTotal, prior: priorTotal }
  })
}

function buildHeatmap(current: SalesPayload, prior: SalesPayload): HeatmapRow[] {
  const dates = safeArray<string>(current?.dates)
  const currentSeries = current?.series ?? {}
  const priorSeries = prior?.series ?? {}
  const familyBuckets = new Map<string, { current: number[]; prior: number[]; total: number }>()

  for (const sku of safeArray<any>(current?.topSkus)) {
    const key = normalizeSku(sku?.sku)
    if (!key) continue
    const family = productFamily(String(sku?.name ?? ''), key)
    const bucket = familyBuckets.get(family) ?? {
      current: Array.from({ length: dates.length }, () => 0),
      prior: Array.from({ length: dates.length }, () => 0),
      total: 0,
    }
    const currentValues = currentSeries[key] ?? []
    const priorValues = priorSeries[key] ?? []
    for (let index = 0; index < dates.length; index += 1) {
      const currentQty = num(currentValues[index])
      const priorQty = num(priorValues[index])
      bucket.current[index] += currentQty
      bucket.prior[index] += priorQty
      bucket.total += currentQty
    }
    familyBuckets.set(family, bucket)
  }

  return [...familyBuckets.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 6)
    .map(([label, bucket]) => {
      const baseline = sumValues(bucket.prior) / Math.max(1, bucket.prior.length)
      const fallback = sumValues(bucket.current) / Math.max(1, bucket.current.length) || 1
      const compareTo = baseline > 0 ? baseline : fallback
      return {
        label,
        cells: dates.slice(-15).map((day, offset) => {
          const index = dates.length - 15 + offset
          const qty = num(bucket.current[index])
          const deviation = compareTo > 0 ? ((qty - compareTo) / compareTo) * 100 : 0
          return {
            day,
            qty,
            deviation,
            tone: heatmapTone(deviation),
          }
        }),
      }
    })
}

function MiniSparkline({ values, positive = true }: { values: number[]; positive?: boolean }) {
  const points = values.length ? values : [0, 0]
  const max = Math.max(...points, 1)
  const min = Math.min(...points, 0)
  const span = Math.max(1, max - min)
  const width = 62
  const height = 28
  const step = width / Math.max(1, points.length - 1)
  const path = points
    .map((value, index) => {
      const x = index * step
      const y = height - ((value - min) / span) * (height - 4) - 2
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className={`h-7 w-16 ${positive ? 'text-brand' : 'text-danger'}`} aria-hidden="true">
      <path d={path} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function KpiCard({
  title,
  value,
  suffix,
  helper,
  tone,
  icon,
  spark,
  progress,
}: {
  title: string
  value: string
  suffix?: string
  helper: React.ReactNode
  tone?: 'green' | 'orange' | 'red' | 'blue'
  icon?: React.ReactNode
  spark?: number[]
  progress?: number
}) {
  const toneClass =
    tone === 'green'
      ? 'text-ok bg-ok/10 ring-ok/20'
      : tone === 'orange'
        ? 'text-warn bg-warn/10 ring-warn/20'
        : tone === 'red'
          ? 'text-danger bg-danger/10 ring-danger/20'
          : 'text-brand bg-brand-bg ring-brand/20'
  const titleClass =
    tone === 'green'
      ? 'text-ok'
      : tone === 'orange'
        ? 'text-warn'
        : tone === 'red'
          ? 'text-danger'
          : 'text-ink-2'
  const progressClass =
    tone === 'green'
      ? 'bg-ok'
      : tone === 'orange'
        ? 'bg-warn'
        : tone === 'red'
          ? 'bg-danger'
          : 'bg-brand'

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex min-h-[118px] flex-col justify-between rounded-card border border-line bg-surface px-4 py-3 shadow-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className={`text-xs font-semibold ${titleClass}`}>{title}</div>
          <div className="mt-3 flex items-end gap-1.5 text-[26px] font-extrabold leading-none tracking-[-0.02em] text-ink font-mono tabular-nums">
            {value}
            {suffix ? <span className="pb-0.5 text-xs font-bold tracking-normal text-ink-2">{suffix}</span> : null}
          </div>
          <div className="mt-2 text-tiny">{helper}</div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          {icon ? <div className={`grid h-9 w-9 place-items-center rounded-full ring-1 ${toneClass}`}>{icon}</div> : null}
          {spark ? <MiniSparkline values={spark} positive={tone !== 'red'} /> : null}
        </div>
      </div>
      {typeof progress === 'number' ? (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-line/70">
          <div className={`h-full rounded-full ${progressClass}`} style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
        </div>
      ) : null}
    </motion.div>
  )
}

function ChangeText({ pct, inverse = false, label = 'prior 30 days' }: { pct: number; inverse?: boolean; label?: string }) {
  const isGood = inverse ? pct <= 0 : pct >= 0
  const flat = Math.abs(pct) < 0.1
  return (
    <span className={`inline-flex items-center gap-1 font-semibold ${flat ? 'text-ink-3' : isGood ? 'text-ok' : 'text-danger'}`}>
      {flat ? null : pct >= 0 ? <ArrowUpRight size={12} strokeWidth={2.5} /> : <ArrowDownRight size={12} strokeWidth={2.5} />}
      {formatPct(pct)} <span className="font-normal text-ink-3">vs {label}</span>
    </span>
  )
}

function StatusBadge({ status }: { status: DashboardSkuRow['status'] }) {
  const classes =
    status === 'in'
      ? 'bg-ok/10 text-ok'
      : status === 'low'
        ? 'bg-warn/10 text-warn'
        : 'bg-danger/10 text-danger'
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-bold ${classes}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${status === 'in' ? 'bg-ok' : status === 'low' ? 'bg-warn' : 'bg-danger'}`} />
      {statusLabel(status)}
    </span>
  )
}

function TinyTrend({ values, negative = false }: { values: number[]; negative?: boolean }) {
  return <MiniSparkline values={values} positive={!negative} />
}

export default function DashboardView({ onOpenSku }: DashboardViewProps = {}) {
  const [clients, setClients] = useState<Client[]>([])
  const [selectedClientId, setSelectedClientId] = useState<number | null>(null)
  const [currentSales, setCurrentSales] = useState<SalesPayload>({ dates: [], topSkus: [], series: {} })
  const [priorSales, setPriorSales] = useState<SalesPayload>({ dates: [], topSkus: [], series: {} })
  const [inventoryRows, setInventoryRows] = useState<InventoryItem[]>([])
  const [analysisRows, setAnalysisRows] = useState<AnalysisSku[]>([])
  const [currentOrders, setCurrentOrders] = useState<any[]>([])
  const [priorOrders, setPriorOrders] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sortState, setSortState] = useState<SortState<DashboardSortKey>>({ key: 'units30', direction: 'desc' })
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(TABLE_PAGE_SIZE)
  const [categoryFilter, setCategoryFilter] = useState('')
  const [brandFilter, setBrandFilter] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [showColumns, setShowColumns] = useState(false)
  const [visibleColumns, setVisibleColumns] = useState<Record<ColumnKey, boolean>>(DEFAULT_VISIBLE_COLUMNS)

  // Operator-defined column order + widths for the SKU Performance
  // Summary table. Persisted to localStorage so each browser remembers
  // its own layout. Defensive migrations (readStored*) drop unknown
  // keys + append newly-added columns at the end.
  const [columnOrder, setColumnOrder] = useState<ColumnKey[]>(() => readStoredColumnOrder())
  // Widened to string-key Record so anchor columns ('sku', 'product')
  // can store their own widths alongside the toggleable column keys.
  const [columnWidths, setColumnWidths] = useState<Partial<Record<string, number>>>(() => readStoredColumnWidths())
  useEffect(() => {
    try { window.localStorage.setItem(COLUMN_ORDER_STORAGE_KEY, JSON.stringify(columnOrder)) } catch { /* localStorage full / private mode — non-fatal */ }
  }, [columnOrder])
  useEffect(() => {
    try { window.localStorage.setItem(COLUMN_WIDTHS_STORAGE_KEY, JSON.stringify(columnWidths)) } catch { /* non-fatal */ }
  }, [columnWidths])

  // Drag-reorder state: which column is being dragged and which is
  // currently being hovered over as a drop target. UI uses these for
  // visual feedback (opacity-40 on the source, inset shadow on the
  // target) and the actual reorder fires on onDrop.
  const [draggingColumn, setDraggingColumn] = useState<ColumnKey | null>(null)
  const [dragOverColumn, setDragOverColumn] = useState<ColumnKey | null>(null)
  const handleColumnDragStart = (key: ColumnKey) => (event: React.DragEvent<HTMLTableCellElement>) => {
    setDraggingColumn(key)
    // dataTransfer.setData is required to start a drag in Firefox;
    // the value itself doesn't matter — we read state, not the
    // payload, on drop.
    event.dataTransfer.setData('text/plain', key)
    event.dataTransfer.effectAllowed = 'move'
  }
  const handleColumnDragOver = (key: ColumnKey) => (event: React.DragEvent<HTMLTableCellElement>) => {
    if (draggingColumn == null || draggingColumn === key) return
    event.preventDefault() // required to enable drop
    event.dataTransfer.dropEffect = 'move'
    if (dragOverColumn !== key) setDragOverColumn(key)
  }
  const handleColumnDrop = (key: ColumnKey) => (event: React.DragEvent<HTMLTableCellElement>) => {
    event.preventDefault()
    const from = draggingColumn
    setDraggingColumn(null)
    setDragOverColumn(null)
    if (!from || from === key) return
    setColumnOrder((prev) => {
      const fromIdx = prev.indexOf(from)
      const toIdx = prev.indexOf(key)
      if (fromIdx === -1 || toIdx === -1) return prev
      const next = [...prev]
      next.splice(fromIdx, 1)
      next.splice(toIdx, 0, from)
      return next
    })
  }
  const handleColumnDragEnd = () => {
    setDraggingColumn(null)
    setDragOverColumn(null)
  }

  // Resize: mousedown on the right-edge handle captures the starting
  // X and the column's current width, then mousemove updates the
  // width based on the X delta. The handlers are registered on
  // window (not the handle) so the drag continues even if the cursor
  // moves outside the cell — same pattern as standard browser column
  // resizing in CSV viewers.
  // Resize handler now takes minWidth + defaultWidth directly instead
  // of looking them up in SKU_COLUMNS — that way anchor columns (sku,
  // product) can use the same handler without forcing them into the
  // SKU_COLUMNS type. `key` is widened to string for the same reason.
  const resizingRef = useRef<{ key: string; startX: number; startWidth: number; minWidth: number } | null>(null)
  const handleColumnResizeStart = (key: string, minWidth: number, defaultWidth: number) => (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const startWidth = columnWidths[key as ColumnKey] ?? defaultWidth
    resizingRef.current = { key, startX: event.clientX, startWidth, minWidth }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const onMove = (e: MouseEvent) => {
      const ctx = resizingRef.current
      if (!ctx) return
      const delta = e.clientX - ctx.startX
      const next = Math.max(ctx.minWidth, Math.min(600, ctx.startWidth + delta))
      setColumnWidths((prev) => ({ ...prev, [ctx.key]: next }))
    }
    const onUp = () => {
      resizingRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  const handleResetColumnLayout = () => {
    setColumnOrder([...DEFAULT_COLUMN_ORDER])
    setColumnWidths({})
  }

  // The list of currently-visible columns in their operator-defined
  // order — used to drive thead, tbody, and colgroup in a single pass.
  const visibleColumnOrder = useMemo(
    () => columnOrder.filter((k) => visibleColumns[k]),
    [columnOrder, visibleColumns],
  )

  const selectedClient = useMemo(
    () => (selectedClientId == null ? null : clients.find((client) => client.clientId === selectedClientId) ?? null),
    [clients, selectedClientId],
  )

  const loadDashboard = async (mode: 'initial' | 'refresh' = 'initial') => {
    if (mode === 'initial') setLoading(true)
    else setRefreshing(true)
    setError(null)

    try {
      const currentFrom = dateOnly(29)
      const currentTo = dateOnly(0)
      const priorFrom = dateOnly(59)
      const priorTo = dateOnly(30)
      const sevenFrom = dateOnly(6)
      const cid = selectedClientId ?? undefined

      const [
        clientsRes,
        currentSalesRes,
        priorSalesRes,
        inventoryRes,
        analysisRes,
        currentOrdersRes,
        priorOrdersRes,
      ] = await Promise.all([
        apiClient.listClients().catch(() => []),
        apiClient.fetchAnalysisDailySales({ from: currentFrom, to: currentTo, topN: 15, clientId: cid }),
        apiClient.fetchAnalysisDailySales({ from: priorFrom, to: priorTo, topN: 15, clientId: cid }),
        apiClient.fetchInventory({ ...(cid ? { clientId: cid } : {}) }).catch(() => []),
        apiClient.fetchAnalysisSkus({ from: currentFrom, to: currentTo, limit: 200, clientId: cid }).catch(() => ({ skus: [] })),
        fetchOrdersWindow({ from: currentFrom, to: currentTo, clientId: cid }),
        fetchOrdersWindow({ from: priorFrom, to: priorTo, clientId: cid }),
      ])

      const nextClients = safeArray<any>(clientsRes)
        .map((client) => ({
          clientId: num(client?.clientId ?? client?.id),
          name: String(client?.name ?? '').trim(),
        }))
        .filter((client) => client.clientId > 0 && client.name)
        .sort((left, right) => left.name.localeCompare(right.name))

      setClients(nextClients)
      setCurrentSales(currentSalesRes ?? { dates: [], topSkus: [], series: {} })
      setPriorSales(priorSalesRes ?? { dates: [], topSkus: [], series: {} })
      setInventoryRows(safeArray<InventoryItem>(inventoryRes))
      setAnalysisRows(safeArray<AnalysisSku>(analysisRes?.skus))
      setCurrentOrders(safeArray<any>(currentOrdersRes))
      setPriorOrders(safeArray<any>(priorOrdersRes))
      setPage(1)

      if (cid && !nextClients.some((client) => client.clientId === cid)) {
        setSelectedClientId(null)
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load dashboard')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    void loadDashboard('initial')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClientId])

  const trend = useMemo(() => buildTrend(currentSales, priorSales), [currentSales, priorSales])
  const heatmap = useMemo(() => buildHeatmap(currentSales, priorSales), [currentSales, priorSales])

  const currentAgg = useMemo(() => aggregateOrders(currentOrders, dateOnly(6)), [currentOrders])
  const priorAgg = useMemo(() => aggregateOrders(priorOrders, dateOnly(36)), [priorOrders])

  const inventoryBySku = useMemo(() => {
    const map = new Map<string, InventoryItem>()
    for (const item of inventoryRows) {
      const sku = normalizeSku(item?.sku)
      if (!sku) continue
      if (!map.has(sku)) map.set(sku, item)
    }
    return map
  }, [inventoryRows])

  const unitsBySku7 = useMemo(() => {
    const map = new Map<string, number>()
    const series = currentSales.series ?? {}
    for (const sku of Object.keys(series)) {
      map.set(sku, sumValues(last(series[sku] ?? [], 7)))
    }
    return map
  }, [currentSales])

  const unitsBySku30 = useMemo(() => {
    const map = new Map<string, number>()
    const series = currentSales.series ?? {}
    for (const sku of Object.keys(series)) {
      map.set(sku, sumValues(series[sku] ?? []))
    }
    return map
  }, [currentSales])

  const priorUnitsBySku30 = useMemo(() => {
    const map = new Map<string, number>()
    const series = priorSales.series ?? {}
    for (const sku of Object.keys(series)) {
      map.set(sku, sumValues(series[sku] ?? []))
    }
    return map
  }, [priorSales])

  const skuRows = useMemo<DashboardSkuRow[]>(() => {
    const seen = new Set<string>()
    const allSkus = [
      ...analysisRows.map((row) => normalizeSku(row.sku)),
      ...safeArray<any>(currentSales.topSkus).map((row) => normalizeSku(row?.sku)),
      ...inventoryRows.map((row) => normalizeSku(row.sku)),
    ].filter(Boolean)

    return allSkus
      .filter((sku) => {
        if (seen.has(sku)) return false
        seen.add(sku)
        return true
      })
      .map((sku) => {
        const analysis = analysisRows.find((row) => normalizeSku(row.sku) === sku)
        const top = safeArray<any>(currentSales.topSkus).find((row) => normalizeSku(row?.sku) === sku)
        const inventory = inventoryBySku.get(sku)
        const orderAgg = currentAgg.bySku.get(sku)
        const priorOrderAgg = priorAgg.bySku.get(sku)
        const units30 = unitsBySku30.get(sku) ?? orderAgg?.units30 ?? num(analysis?.qty)
        const units7 = unitsBySku7.get(sku) ?? orderAgg?.units7 ?? 0
        const priorUnits30 = priorUnitsBySku30.get(sku) ?? priorOrderAgg?.units30 ?? 0
        const revenue = orderAgg?.revenue ?? 0
        const stock = num(inventory?.currentStock ?? inventory?.stockQty)
        const minStock = num(inventory?.minStock ?? inventory?.reorderLevel)
        const dailyRate = units30 > 0 ? units30 / 30 : 0
        const daysSupply = dailyRate > 0 ? stock / dailyRate : null
        const targetStock = Math.max(minStock, dailyRate * 14)
        const status = stockStatus(stock, minStock)
        const totalShipping = num(analysis?.totalShipping)
        const avgShipping =
          num(analysis?.blendedAvgShipping) ||
          num(analysis?.standardAvgShipping) ||
          num(analysis?.expeditedAvgShipping) ||
          (units30 > 0 ? totalShipping / units30 : 0)
        const product = String(analysis?.name ?? top?.name ?? inventory?.name ?? sku)
        const client = String(analysis?.clientName ?? inventory?.clientName ?? selectedClient?.name ?? 'All Clients')
        const category = productFamily(product, sku)
        const brand = product.split(/\s+/).find(Boolean)?.replace(/[^\w&-]/g, '') || 'Other'

        return {
          sku,
          product,
          client,
          category,
          brand,
          imageUrl: analysis?.imageUrl ?? inventory?.imageUrl ?? null,
          revenue,
          avgPrice: units30 > 0 ? revenue / units30 : 0,
          avgShipping,
          stock,
          minStock,
          status,
          daysSupply,
          restockQty: Math.max(0, Math.ceil(targetStock - stock)),
          units7,
          units30,
          priorUnits30,
          priorAvg: priorUnits30 / 30,
          changePct: relativePct(units30, priorUnits30),
          trend: currentSales.series?.[sku] ?? [],
        }
      })
      .filter((row) => row.sku && (row.units30 > 0 || row.stock !== 0 || row.revenue > 0))
  }, [
    analysisRows,
    currentAgg,
    currentSales,
    inventoryBySku,
    inventoryRows,
    priorAgg,
    priorSales,
    priorUnitsBySku30,
    selectedClient,
    unitsBySku7,
    unitsBySku30,
      ])

  const categories = useMemo(
    () => [...new Set(skuRows.map((row) => row.category).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [skuRows],
  )

  const brands = useMemo(
    () => [...new Set(skuRows.map((row) => row.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [skuRows],
  )

  const filteredSkuRows = useMemo(
    () =>
      skuRows.filter((row) => {
        if (categoryFilter && row.category !== categoryFilter) return false
        if (brandFilter && row.brand !== brandFilter) return false
        return true
      }),
    [brandFilter, categoryFilter, skuRows],
  )

  const sortedSkuRows = useMemo(
    () =>
      sortRows(
        filteredSkuRows,
        sortState,
        (row, key) => {
          switch (key) {
            case 'sku':
              return row.sku
            case 'product':
              return row.product
            case 'client':
              return row.client
            case 'revenue':
              return row.revenue
            case 'avgPrice':
              return row.avgPrice
            case 'avgShipping':
              return row.avgShipping
            case 'status':
              return row.status
            case 'daysSupply':
              return row.daysSupply ?? Number.POSITIVE_INFINITY
            case 'restockQty':
              return row.restockQty
            case 'units7':
              return row.units7
            case 'units30':
              return row.units30
            case 'priorAvg':
              return row.priorAvg
            case 'changePct':
              return row.changePct
            default:
              return row.units30
          }
        },
        (row) => row.sku,
      ),
    [filteredSkuRows, sortState],
  )

  const totalPages = Math.max(1, Math.ceil(sortedSkuRows.length / pageSize))
  const pageRows = sortedSkuRows.slice((page - 1) * pageSize, page * pageSize)

  const topSkuRows = useMemo(
    () => [...skuRows].sort((left, right) => right.units30 - left.units30).slice(0, 5),
    [skuRows],
  )

  useEffect(() => {
    setPage(1)
  }, [brandFilter, categoryFilter, pageSize, selectedClientId, sortState.direction, sortState.key])

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages))
  }, [totalPages])

  const paginationItems = useMemo(() => {
    const pages = new Set([1, totalPages, page - 1, page, page + 1].filter((value) => value >= 1 && value <= totalPages))
    const sorted = [...pages].sort((a, b) => a - b)
    const items: Array<number | 'ellipsis'> = []
    sorted.forEach((value, index) => {
      if (index > 0 && value - sorted[index - 1] > 1) items.push('ellipsis')
      items.push(value)
    })
    return items
  }, [page, totalPages])

  const visibleColumnCount = 4 + COLUMN_OPTIONS.filter((option) => visibleColumns[option.key]).length

  const kpis = useMemo(() => {
    const currentUnits30 = sumValues(trend.map((point) => point.current))
    const priorUnits30 = sumValues(trend.map((point) => point.prior))
    const currentUnits7 = sumValues(last(trend.map((point) => point.current), 7))
    const priorUnits7 = sumValues(last(trend.map((point) => point.prior), 7))
    const inStock = inventoryRows.filter((item) => {
      const stock = num(item.currentStock ?? item.stockQty)
      const min = num(item.minStock ?? item.reorderLevel)
      return stock > min
    }).length
    const lowStock = inventoryRows.filter((item) => {
      const stock = num(item.currentStock ?? item.stockQty)
      const min = num(item.minStock ?? item.reorderLevel)
      return stock > 0 && stock <= min
    }).length
    const outStock = inventoryRows.filter((item) => num(item.currentStock ?? item.stockQty) <= 0).length
    const totalStockSkus = Math.max(1, inventoryRows.length)

    return {
      currentUnits30,
      priorUnits30,
      currentUnits7,
      priorUnits7,
      revenue30: currentAgg.revenue,
      priorRevenue30: priorAgg.revenue,
      inStock,
      lowStock,
      outStock,
      totalStockSkus,
    }
  }, [currentAgg.revenue, inventoryRows, priorAgg.revenue, trend])

  const maxTopSku = Math.max(...topSkuRows.map((row) => row.units30), 1)

  if (loading) {
    return (
      <div id="view-dashboard" className="view-content !overflow-y-auto !bg-page !p-5">
        <div className="space-y-4">
          <div className="h-12 w-80 animate-pulse rounded-card bg-surface-3" />
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="h-28 animate-pulse rounded-card border border-line bg-surface" />
            ))}
          </div>
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
            <div className="h-72 animate-pulse rounded-card border border-line bg-surface xl:col-span-2" />
            <div className="h-72 animate-pulse rounded-card border border-line bg-surface" />
          </div>
          <div className="h-72 animate-pulse rounded-card border border-line bg-surface" />
        </div>
      </div>
    )
  }

  return (
    <div id="view-dashboard" className="view-content !overflow-y-auto !bg-page !p-4 sm:!p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-extrabold leading-tight tracking-[-0.02em] text-ink">
            Inventory & Stockout Prevention
          </h1>
          <p className="mt-0.5 text-xs text-ink-3">
            Monitor inventory health, days of supply, and take action to prevent stockouts
          </p>
        </div>

        <div className="relative flex flex-wrap items-center gap-3">
          <div className="text-xs font-medium text-ink-3">Data as of {formatDataTimestamp()}</div>
          <button
            type="button"
            onClick={() => loadDashboard('refresh')}
            className="grid h-9 w-9 place-items-center rounded-card text-ink-2 hover:bg-surface-2 hover:text-brand"
            aria-label="Refresh dashboard"
            title="Refresh dashboard"
          >
            <RefreshCw size={16} strokeWidth={2.25} className={refreshing ? 'animate-spin' : ''} />
          </button>
          <button
            type="button"
            onClick={() => setShowFilters((open) => !open)}
            className="inline-flex h-10 items-center gap-2 rounded-card border border-line bg-surface px-4 text-sm2 font-semibold text-ink shadow-sm hover:bg-surface-2"
            aria-expanded={showFilters}
          >
            <Filter size={15} strokeWidth={2.25} className="text-ink-3" />
            Filters
          </button>
          {showFilters ? (
            <div className="absolute right-0 top-12 z-20 w-72 rounded-card border border-line bg-surface p-3 shadow-lg">
              <div className="mb-2 text-xs font-extrabold text-ink">Dashboard Filters</div>
              <label className="mb-2 block">
                <span className="mb-1 block text-2xs font-bold uppercase tracking-[0.04em] text-ink-3">Client</span>
                <select
                  value={selectedClientId ?? ''}
                  onChange={(event) => setSelectedClientId(event.target.value ? Number(event.target.value) : null)}
                  className="h-9 w-full rounded-card border border-line bg-surface px-3 text-sm2 font-semibold text-ink outline-none"
                  aria-label="Filter dashboard by client"
                >
                  <option value="">All Clients</option>
                  {clients.map((client) => (
                    <option key={client.clientId} value={client.clientId}>
                      {client.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="mb-2 block">
                <span className="mb-1 block text-2xs font-bold uppercase tracking-[0.04em] text-ink-3">Category</span>
                <select
                  value={categoryFilter}
                  onChange={(event) => setCategoryFilter(event.target.value)}
                  className="h-9 w-full rounded-card border border-line bg-surface px-3 text-sm2 font-semibold text-ink outline-none"
                  aria-label="Filter dashboard by category"
                >
                  <option value="">All Categories</option>
                  {categories.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-2xs font-bold uppercase tracking-[0.04em] text-ink-3">Brand</span>
                <select
                  value={brandFilter}
                  onChange={(event) => setBrandFilter(event.target.value)}
                  className="h-9 w-full rounded-card border border-line bg-surface px-3 text-sm2 font-semibold text-ink outline-none"
                  aria-label="Filter dashboard by brand"
                >
                  <option value="">All Brands</option>
                  {brands.map((brand) => (
                    <option key={brand} value={brand}>
                      {brand}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => {
                  setSelectedClientId(null)
                  setCategoryFilter('')
                  setBrandFilter('')
                }}
                className="mt-3 h-9 w-full rounded-card border border-line bg-surface-2 text-sm2 font-semibold text-ink-2 hover:bg-surface-3"
              >
                Reset filters
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="mb-4 rounded-card border border-danger/30 bg-danger/10 px-4 py-3 text-sm font-semibold text-danger">
          {error}
        </div>
      ) : null}

      <div className="mb-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-6">
        <KpiCard
          title="Total 7-Day Units"
          value={formatInt(kpis.currentUnits7)}
          helper={<ChangeText pct={relativePct(kpis.currentUnits7, kpis.priorUnits7)} label="prior 7 days" />}
          spark={last(trend.map((point) => point.current), 10)}
        />
        <KpiCard
          title="Total 30-Day Units"
          value={formatInt(kpis.currentUnits30)}
          helper={<ChangeText pct={relativePct(kpis.currentUnits30, kpis.priorUnits30)} />}
          spark={trend.map((point) => point.current)}
        />
        <KpiCard
          title="Total Revenue"
          value={formatMoney(kpis.revenue30)}
          helper={<ChangeText pct={relativePct(kpis.revenue30, kpis.priorRevenue30)} label="prior 30 days" />}
          spark={trend.map((point) => point.current)}
        />
        <KpiCard
          title="In Stock"
          value={formatInt(kpis.inStock)}
          suffix="SKUs"
          tone="green"
          icon={<Package size={18} strokeWidth={2.25} />}
          helper={<span className="text-ink-3">{Math.round((kpis.inStock / kpis.totalStockSkus) * 100)}% of total SKUs</span>}
          progress={(kpis.inStock / kpis.totalStockSkus) * 100}
        />
        <KpiCard
          title="Low Stock"
          value={formatInt(kpis.lowStock)}
          suffix="SKUs"
          tone="orange"
          icon={<AlertTriangle size={18} strokeWidth={2.25} />}
          helper={<span className="text-ink-3">{Math.round((kpis.lowStock / kpis.totalStockSkus) * 100)}% of total SKUs</span>}
          progress={(kpis.lowStock / kpis.totalStockSkus) * 100}
        />
        <KpiCard
          title="Out of Stock"
          value={formatInt(kpis.outStock)}
          suffix="SKUs"
          tone="red"
          icon={<CircleX size={18} strokeWidth={2.25} />}
          helper={<span className="text-ink-3">{Math.round((kpis.outStock / kpis.totalStockSkus) * 100)}% of total SKUs</span>}
          progress={(kpis.outStock / kpis.totalStockSkus) * 100}
        />
      </div>

      <div className="mb-3 grid grid-cols-1 gap-3 xl:grid-cols-3">
        <section className="rounded-card border border-line bg-surface p-4 shadow-sm xl:col-span-2">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-extrabold text-ink">Units Sold Trend</h3>
              <div className="mt-2 flex items-center gap-5 text-2xs text-ink-3">
                <span className="inline-flex items-center gap-2">
                  <span className="h-0.5 w-8 rounded-full bg-brand" />
                  Current 30 Days
                </span>
                <span className="inline-flex items-center gap-2">
                  <span className="h-0.5 w-8 rounded-full border-t border-dashed border-ink-3" />
                  Prior 30 Days
                </span>
              </div>
            </div>
            {selectedClient ? (
              <span className="rounded-full bg-brand-bg px-2 py-1 text-2xs font-bold text-brand">
                {selectedClient.name}
              </span>
            ) : null}
          </div>
          <div className="h-[260px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trend} margin={{ top: 8, right: 14, bottom: 4, left: -12 }}>
                <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="day" tickFormatter={formatDayLabel} tick={{ fontSize: 10, fill: 'var(--text3)' }} tickLine={false} axisLine={{ stroke: 'var(--line)' }} minTickGap={24} />
                <YAxis tick={{ fontSize: 10, fill: 'var(--text3)' }} tickLine={false} axisLine={false} allowDecimals={false} width={42} />
                <Tooltip
                  labelFormatter={formatDayLabel}
                  formatter={(value: number, name: string) => [formatInt(num(value)), name === 'current' ? 'Current 30 Days' : 'Prior 30 Days']}
                  contentStyle={{
                    background: 'var(--surface)',
                    border: '1px solid var(--line)',
                    borderRadius: 8,
                    boxShadow: '0 12px 28px rgba(15,23,42,0.08)',
                    fontSize: 12,
                  }}
                />
                <Line type="monotone" dataKey="prior" stroke="var(--text3)" strokeWidth={1.5} strokeDasharray="4 4" dot={false} activeDot={{ r: 4 }} />
                <Line type="monotone" dataKey="current" stroke="var(--brand)" strokeWidth={2.25} dot={{ r: 2 }} activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--surface)' }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="rounded-card border border-line bg-surface p-4 shadow-sm">
          <h3 className="text-sm font-extrabold text-ink">Top SKUs (30d)</h3>
          <p className="mb-3 text-tiny text-ink-3">By total units sold</p>
          <div className="space-y-3">
            {topSkuRows.map((row, index) => (
              <button
                key={row.sku}
                type="button"
                onClick={() => onOpenSku?.(row.sku)}
                className="group grid w-full grid-cols-[22px_minmax(0,1fr)_44px] items-start gap-2 text-left"
              >
                <div className="pt-0.5 text-xs font-extrabold text-ink-2">{index + 1}</div>
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold text-ink group-hover:text-brand">{row.product}</div>
                  <div className="truncate text-2xs font-mono text-ink-3">{row.sku}</div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line/70">
                    <div className="h-full rounded-full bg-brand" style={{ width: `${Math.max(5, (row.units30 / maxTopSku) * 100)}%` }} />
                  </div>
                </div>
                <div className="pt-0.5 text-right text-xs font-bold text-ink font-mono tabular-nums">{formatInt(row.units30)}</div>
              </button>
            ))}
            {topSkuRows.length === 0 ? (
              <div className="grid h-40 place-items-center text-tiny text-ink-3">No SKU data available.</div>
            ) : null}
          </div>
        </section>
      </div>

      <section className="mb-3 rounded-card border border-line bg-surface p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-extrabold text-ink">Sales Performance Heatmap by SKU Family</h3>
            <p className="text-tiny text-ink-3">Performance vs prior 30 days</p>
          </div>
        </div>
        <div className="overflow-x-auto">
          <div className="min-w-[900px] space-y-1.5">
            <div className="grid grid-cols-[150px_repeat(15,minmax(34px,1fr))] gap-1 text-2xs font-semibold text-ink-3">
              <div />
              {heatmap[0]?.cells.map((cell) => (
                <div key={cell.day} className="text-center">{formatDayLabel(cell.day).replace(' ', ' ')}</div>
              ))}
            </div>
            {heatmap.map((row) => (
              <div key={row.label} className="grid grid-cols-[150px_repeat(15,minmax(34px,1fr))] items-center gap-1">
                <div className="truncate pr-2 text-xs font-semibold text-ink-2" title={row.label}>{row.label}</div>
                {row.cells.map((cell) => {
                  const toneClass =
                    cell.tone === 'high'
                      ? 'bg-ok'
                      : cell.tone === 'mid'
                        ? 'bg-ok/40'
                        : cell.tone === 'flat'
                          ? 'bg-warn/20'
                          : cell.tone === 'dip'
                            ? 'bg-warn'
                            : 'bg-danger'
                  return (
                    <div
                      key={`${row.label}-${cell.day}`}
                      title={`${formatDayLabel(cell.day)}: ${formatInt(cell.qty)} units, ${formatPct(cell.deviation)} vs baseline`}
                      className={`h-4 rounded-[3px] ring-1 ring-line/30 ${toneClass}`}
                    />
                  )
                })}
              </div>
            ))}
            {heatmap.length === 0 ? (
              <div className="grid h-32 place-items-center text-tiny text-ink-3">No heatmap data available.</div>
            ) : null}
            <div className="flex flex-wrap items-center justify-center gap-5 pt-2 text-2xs text-ink-3">
              <span className="mr-1">Performance vs prior 30 days</span>
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-ok" /> &ge; +20%</span>
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-ok/40" /> +10% to +20%</span>
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-warn/20" /> -10% to +10%</span>
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-warn" /> -10% to -20%</span>
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-danger" /> &le; -20%</span>
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-card border border-line bg-surface shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            <h3 className="text-sm font-extrabold text-ink">SKU Performance Summary</h3>
            <p className="text-tiny text-ink-3">Revenue, velocity, stock status, and restock signals</p>
          </div>
          <div className="relative flex flex-wrap items-center gap-2">
            <select
              value={categoryFilter}
              onChange={(event) => setCategoryFilter(event.target.value)}
              className="h-9 rounded-card border border-line bg-surface px-3 text-tiny font-semibold text-ink-2 outline-none hover:bg-surface-2"
              aria-label="Filter SKU table by category"
            >
              <option value="">All Categories</option>
              {categories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
            <select
              value={brandFilter}
              onChange={(event) => setBrandFilter(event.target.value)}
              className="h-9 rounded-card border border-line bg-surface px-3 text-tiny font-semibold text-ink-2 outline-none hover:bg-surface-2"
              aria-label="Filter SKU table by brand"
            >
              <option value="">All Brands</option>
              {brands.map((brand) => (
                <option key={brand} value={brand}>
                  {brand}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setShowColumns((open) => !open)}
              className="inline-flex h-9 items-center gap-2 rounded-card border border-line bg-surface px-3 text-tiny font-semibold text-ink-2 hover:bg-surface-2"
              aria-expanded={showColumns}
            >
              <Columns3 size={14} strokeWidth={2.25} />
              Columns
              <ChevronDown size={13} strokeWidth={2.25} />
            </button>
            {showColumns ? (
              <div className="absolute right-0 top-10 z-20 w-60 rounded-card border border-line bg-surface shadow-lg overflow-hidden flex flex-col" style={{ maxHeight: 'min(420px, 70vh)' }}>
                {/* Sticky header with Reset action — pinned visible
                    so an operator who's shuffled columns into a mess
                    can recover without scrolling to find the button. */}
                <div className="flex items-center justify-between border-b border-line bg-surface-2/50 px-3 py-2 flex-shrink-0">
                  <span className="text-2xs font-extrabold uppercase tracking-[0.05em] text-ink-3">Columns</span>
                  <button
                    type="button"
                    onClick={() => {
                      handleResetColumnLayout()
                      setVisibleColumns(DEFAULT_VISIBLE_COLUMNS)
                    }}
                    className="text-2xs font-bold text-brand hover:underline"
                    title="Restore default column order, widths, and visibility"
                  >
                    Reset
                  </button>
                </div>
                {/* List rendered in operator's CURRENT order so it
                    mirrors the table visually — hidden columns float
                    to the bottom (greyed) for easy re-enable. */}
                <div className="flex-1 min-h-0 overflow-y-auto p-2" style={{ overscrollBehavior: 'contain' }}>
                  {(() => {
                    const visible = columnOrder.filter((k) => visibleColumns[k])
                    const hidden = columnOrder.filter((k) => !visibleColumns[k])
                    return [...visible, ...hidden].map((key) => {
                      const column = COLUMN_OPTIONS.find((c) => c.key === key)!
                      const isHidden = !visibleColumns[key]
                      return (
                        <label key={key} className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs font-semibold hover:bg-surface-2 ${isHidden ? 'text-ink-3 opacity-70' : 'text-ink-2'}`}>
                          <input
                            type="checkbox"
                            checked={!isHidden}
                            onChange={(event) =>
                              setVisibleColumns((current) => ({
                                ...current,
                                [column.key]: event.target.checked,
                              }))
                            }
                            className="h-3.5 w-3.5 rounded border-line"
                          />
                          {column.label}
                        </label>
                      )
                    })
                  })()}
                </div>
                <div className="border-t border-line bg-surface-2/50 px-3 py-1.5 text-[10.5px] text-ink-3 leading-snug flex-shrink-0">
                  Drag a column header to reorder · drag the right edge to resize.
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div className="overflow-x-auto">
          {/* table-fixed + <colgroup> is the duo that makes column
              widths actually obey our colWidths state. Without
              table-fixed the browser uses content-derived auto-widths
              and ignores <col width>. The 1320px min-width preserves
              the legacy "comfy density" feel when no resize has
              happened yet; resize state overrides this naturally. */}
          <table className="w-full min-w-[1320px] table-fixed border-collapse text-sm2">
            <colgroup>
              {/* Star is the only remaining static-width anchor
                  (36px, too narrow to benefit from resize). SKU +
                  Product are resizable anchors (no reorder). All
                  toggleable columns INCLUDING the Trend sparkline
                  flow through the .map() — Trend joined the data
                  columns 2026-05-12 per operator request. */}
              <col style={{ width: 36 }} />
              <col style={{ width: columnWidths.sku ?? ANCHOR_COLUMN_META.sku.defaultWidth }} />
              <col style={{ width: columnWidths.product ?? ANCHOR_COLUMN_META.product.defaultWidth }} />
              {visibleColumnOrder.map((key) => (
                <col key={key} style={{ width: columnWidths[key] ?? SKU_COLUMNS[key].width }} />
              ))}
            </colgroup>
            <thead className="bg-surface-2">
              <tr>
                <th className="border-b-2 border-line px-3 py-2" />
                {/* SKU header — sortable + resizable, NOT reorderable.
                    Resize handle sits on the right edge like the
                    toggleable headers but the <th> itself is not
                    draggable (SKU stays anchored to its position so
                    operators don't lose the row identity column). */}
                <th className="relative select-none border-b-2 border-line px-3 py-2 text-left text-2xs font-bold uppercase tracking-[0.04em] text-ink-3">
                  <SortableHeader
                    sortKey="sku"
                    sortState={sortState}
                    onSort={(key) => setSortState((current) => nextSortState(current, key))}
                    className="block p-0 border-0 bg-transparent w-full"
                  >
                    SKU
                  </SortableHeader>
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize SKU"
                    onMouseDown={handleColumnResizeStart('sku', ANCHOR_COLUMN_META.sku.minWidth, ANCHOR_COLUMN_META.sku.defaultWidth)}
                    onClick={(e) => e.stopPropagation()}
                    draggable={false}
                    className="absolute top-1 bottom-1 -right-[5px] w-[10px] cursor-col-resize flex items-center justify-center group/handle"
                    style={{ touchAction: 'none' }}
                  >
                    <span className="block w-[1.5px] h-full rounded bg-line-2/60 group-hover/handle:bg-brand group-hover/handle:w-[2.5px] transition-all duration-150" />
                  </div>
                </th>
                {/* Product header — same pattern as SKU. */}
                <th className="relative select-none border-b-2 border-line px-3 py-2 text-left text-2xs font-bold uppercase tracking-[0.04em] text-ink-3">
                  <SortableHeader
                    sortKey="product"
                    sortState={sortState}
                    onSort={(key) => setSortState((current) => nextSortState(current, key))}
                    className="block p-0 border-0 bg-transparent w-full"
                  >
                    Product
                  </SortableHeader>
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize Product"
                    onMouseDown={handleColumnResizeStart('product', ANCHOR_COLUMN_META.product.minWidth, ANCHOR_COLUMN_META.product.defaultWidth)}
                    onClick={(e) => e.stopPropagation()}
                    draggable={false}
                    className="absolute top-1 bottom-1 -right-[5px] w-[10px] cursor-col-resize flex items-center justify-center group/handle"
                    style={{ touchAction: 'none' }}
                  >
                    <span className="block w-[1.5px] h-full rounded bg-line-2/60 group-hover/handle:bg-brand group-hover/handle:w-[2.5px] transition-all duration-150" />
                  </div>
                </th>
                {/* Toggleable columns rendered via the operator's
                    columnOrder. Each <th> is HTML5-draggable for
                    reorder and carries a resize handle on its right
                    edge. Sort still works via the inner button (DnD
                    only fires on movement-threshold; a plain click
                    is left alone). */}
                {visibleColumnOrder.map((key) => {
                  const meta = SKU_COLUMNS[key]
                  const isDragging = draggingColumn === key
                  const isDragOver = dragOverColumn === key && draggingColumn !== key
                  // pl-5 reserves room on the left for the drag grip,
                  // pr-5 reserves room on the right for the resize
                  // handle so neither overlaps the label text.
                  const padX = meta.align === 'right' ? 'pr-5 pl-3' : 'pl-5 pr-5'
                  return (
                    <th
                      key={key}
                      draggable
                      onDragStart={handleColumnDragStart(key)}
                      onDragOver={handleColumnDragOver(key)}
                      onDrop={handleColumnDrop(key)}
                      onDragEnd={handleColumnDragEnd}
                      style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
                      className={`group relative select-none border-b-2 border-line ${padX} py-2 ${meta.align === 'right' ? 'text-right' : 'text-left'} text-2xs font-bold uppercase tracking-[0.04em] text-ink-3 transition-colors duration-150 ${
                        isDragging ? 'opacity-40' : ''
                      } ${isDragOver ? 'bg-brand-bg shadow-[inset_3px_0_0_0_var(--brand)]' : ''}`}
                      title={`${meta.label} · drag to reorder · drag right edge to resize`}
                    >
                      {/* Drag grip indicator — three vertical dots on
                          the left edge of every toggleable header.
                          Always faintly visible (text-ink-3/40) so
                          operators can SEE the column is draggable;
                          intensifies on header hover so the
                          affordance is unmistakable when targeting
                          a column. Sits in the pl-5 padding gutter
                          so it never overlaps the label text. */}
                      <span
                        aria-hidden
                        className="absolute left-1 top-1/2 -translate-y-1/2 flex flex-col items-center gap-[2px] text-ink-3/40 group-hover:text-brand transition-colors pointer-events-none"
                        title="Drag to reorder"
                      >
                        <span className="block h-[3px] w-[3px] rounded-full bg-current" />
                        <span className="block h-[3px] w-[3px] rounded-full bg-current" />
                        <span className="block h-[3px] w-[3px] rounded-full bg-current" />
                      </span>
                      {/* SortableHeader is the inner click target —
                          rendering it as a borderless <span> so the
                          parent <th> owns sizing/drag while sort
                          clicks still fire on a non-drag click. */}
                      <SortableHeader
                        sortKey={meta.sortKey}
                        sortState={sortState}
                        onSort={(k) => setSortState((current) => nextSortState(current, k))}
                        align={meta.align}
                        className="block p-0 border-0 bg-transparent w-full"
                      >
                        {meta.label}
                      </SortableHeader>
                      {/* Resize handle — always-visible 1px vertical
                          line on the right edge so operators can SEE
                          where to grab. Surrounded by a 10px hot zone
                          (the outer wrapper) so the click target is
                          big enough to hit easily. Line intensifies
                          + widens to 2px on hover, and turns solid
                          brand-blue while actively resizing.
                          Stops propagation on click/dragStart so a
                          click on the line doesn't fire sort or
                          start a column-reorder drag. */}
                      <div
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={`Resize ${meta.label}`}
                        onMouseDown={handleColumnResizeStart(key, meta.minWidth, meta.width)}
                        onClick={(e) => e.stopPropagation()}
                        onDragStart={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                        }}
                        draggable={false}
                        className="absolute top-1 bottom-1 -right-[5px] w-[10px] cursor-col-resize flex items-center justify-center group/handle"
                        style={{ touchAction: 'none' }}
                      >
                        <span className="block w-[1.5px] h-full rounded bg-line-2/60 group-hover/handle:bg-brand group-hover/handle:w-[2.5px] group-active/handle:bg-brand transition-all duration-150" />
                      </div>
                    </th>
                  )
                })}
                {/* Trend was previously a standalone non-reorderable
                    anchor <th> right here — now part of the
                    visibleColumnOrder map above so it joins the
                    drag/resize family. */}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row) => (
                <tr key={row.sku} className="border-b border-line last:border-b-0 hover:bg-brand-bg/30">
                  <td className="px-3 py-2 text-ink-3 overflow-hidden"><Star size={13} strokeWidth={2} /></td>
                  {/* SKU cell — overflow-hidden + block truncate.
                      Wrapping in a div with block + truncate makes
                      the truncation engage inside the table-fixed
                      cell box; long SKUs now ellipsize instead of
                      bleeding into the Product column. */}
                  <td className="px-3 py-2 overflow-hidden">
                    <div className="block truncate font-mono text-xs font-semibold text-brand">{row.sku}</div>
                  </td>
                  {/* Product cell — was bleeding into Store because
                      the inner button had a hardcoded max-w-[320px]
                      that ignored the actual column width, and the
                      <td> itself had no overflow-hidden. Two fixes:
                      (1) overflow-hidden on the <td>, (2) drop the
                      hardcoded button max-w and let it size to its
                      flex parent (`w-full min-w-0`). The inner span
                      with `truncate` already has `min-w-0` on its
                      flex-parent so it now truncates correctly when
                      the column is narrow. */}
                  <td className="px-3 py-2 overflow-hidden">
                    <button
                      type="button"
                      onClick={() => onOpenSku?.(row.sku)}
                      className="flex w-full min-w-0 items-center gap-2 text-left"
                    >
                      <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-md border border-line bg-surface-2">
                        {row.imageUrl ? (
                          <img src={row.imageUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
                        ) : (
                          <Package size={15} strokeWidth={2.25} className="text-ink-3" />
                        )}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block truncate text-xs font-semibold text-ink hover:text-brand">{row.product}</span>
                      </span>
                    </button>
                  </td>
                  {/* Body cells map over the same visibleColumnOrder
                      as the header, so reorder + visibility changes
                      flow through in a single pass. Each cell's
                      content comes from the column's renderCell()
                      defined in SKU_COLUMNS — no per-column
                      conditional left to drift. */}
                  {visibleColumnOrder.map((key) => {
                    const meta = SKU_COLUMNS[key]
                    return (
                      <td
                        key={key}
                        className={`${meta.align === 'right' ? 'pr-4 pl-3 text-right' : 'px-3 text-left'} py-2 overflow-hidden`}
                      >
                        {meta.renderCell(row)}
                      </td>
                    )
                  })}
                  {/* Trend was rendered as a separate anchor <td>
                      here — now flows through the map above via
                      SKU_COLUMNS.trend.renderCell. */}
                </tr>
              ))}
              {pageRows.length === 0 ? (
                <tr>
                  <td colSpan={visibleColumnCount} className="px-3 py-10 text-center text-sm text-ink-3">
                    No SKU performance data for this filter.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 text-tiny text-ink-3">
          <div>
            Showing {sortedSkuRows.length === 0 ? 0 : (page - 1) * pageSize + 1} to {Math.min(page * pageSize, sortedSkuRows.length)} of {formatInt(sortedSkuRows.length)} SKUs
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={page <= 1}
              className="grid h-8 w-8 place-items-center rounded-card border border-line bg-surface font-semibold text-ink-2 hover:bg-surface-2 disabled:opacity-40"
              aria-label="Previous page"
            >
              <ChevronLeft size={14} strokeWidth={2.25} />
            </button>
            {paginationItems.map((item, index) =>
              item === 'ellipsis' ? (
                <span key={`ellipsis-${index}`} className="px-2 text-ink-3">...</span>
              ) : (
                <button
                  key={item}
                  type="button"
                  onClick={() => setPage(item)}
                  className={`grid h-8 min-w-8 place-items-center rounded-card border px-2 font-bold ${
                    item === page
                      ? 'border-brand bg-brand-bg text-brand ring-1 ring-brand/30'
                      : 'border-line bg-surface text-ink-2 hover:bg-surface-2'
                  }`}
                >
                  {item}
                </button>
              ),
            )}
            <button
              type="button"
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              disabled={page >= totalPages}
              className="grid h-8 w-8 place-items-center rounded-card border border-line bg-surface font-semibold text-ink-2 hover:bg-surface-2 disabled:opacity-40"
              aria-label="Next page"
            >
              <ChevronRight size={14} strokeWidth={2.25} />
            </button>
            <select
              value={pageSize}
              onChange={(event) => setPageSize(Number(event.target.value))}
              className="ml-2 h-8 rounded-card border border-line bg-surface px-3 font-semibold text-ink-2 outline-none hover:bg-surface-2"
              aria-label="Rows per page"
            >
              <option value={10}>10 / page</option>
              <option value={25}>25 / page</option>
              <option value={50}>50 / page</option>
            </select>
          </div>
        </div>
      </section>

      {refreshing ? (
        <div className="fixed bottom-5 right-5 inline-flex items-center gap-2 rounded-card border border-line bg-surface px-3 py-2 text-tiny font-semibold text-ink-2 shadow-lg">
          <Loader2 size={13} strokeWidth={2.5} className="animate-spin text-brand" />
          Refreshing dashboard
        </div>
      ) : null}
    </div>
  )
}
