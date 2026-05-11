// @ts-nocheck
import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  CircleX,
  Filter,
  LayoutDashboard,
  Loader2,
  Package,
  RefreshCw,
  Star,
  TrendingUp,
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
  helper,
  tone,
  icon,
  spark,
}: {
  title: string
  value: string
  helper: React.ReactNode
  tone?: 'green' | 'orange' | 'red' | 'blue'
  icon?: React.ReactNode
  spark?: number[]
}) {
  const toneClass =
    tone === 'green'
      ? 'text-ok bg-ok/10 ring-ok/20'
      : tone === 'orange'
        ? 'text-warn bg-warn/10 ring-warn/20'
        : tone === 'red'
          ? 'text-danger bg-danger/10 ring-danger/20'
          : 'text-brand bg-brand-bg ring-brand/20'

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-card border border-line bg-surface px-4 py-3 shadow-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-2xs font-semibold uppercase tracking-[0.05em] text-ink-3">{title}</div>
          <div className="mt-2 text-[26px] font-extrabold leading-none tracking-[-0.02em] text-ink font-mono tabular-nums">
            {value}
          </div>
          <div className="mt-2 text-tiny">{helper}</div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          {icon ? <div className={`grid h-9 w-9 place-items-center rounded-full ring-1 ${toneClass}`}>{icon}</div> : null}
          {spark ? <MiniSparkline values={spark} positive={tone !== 'red'} /> : null}
        </div>
      </div>
    </motion.div>
  )
}

function ChangeText({ pct, inverse = false }: { pct: number; inverse?: boolean }) {
  const isGood = inverse ? pct <= 0 : pct >= 0
  const flat = Math.abs(pct) < 0.1
  return (
    <span className={`inline-flex items-center gap-1 font-semibold ${flat ? 'text-ink-3' : isGood ? 'text-ok' : 'text-danger'}`}>
      {flat ? null : pct >= 0 ? <ArrowUpRight size={12} strokeWidth={2.5} /> : <ArrowDownRight size={12} strokeWidth={2.5} />}
      {formatPct(pct)} <span className="font-normal text-ink-3">vs prior 30 days</span>
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
        apiClient.fetchAnalysisDailySales({ from: currentFrom, to: currentTo, topN: 8, clientId: cid }),
        apiClient.fetchAnalysisDailySales({ from: priorFrom, to: priorTo, topN: 8, clientId: cid }),
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

        return {
          sku,
          product: String(analysis?.name ?? top?.name ?? inventory?.name ?? sku),
          client: String(analysis?.clientName ?? inventory?.clientName ?? selectedClient?.name ?? 'All Clients'),
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

  const sortedSkuRows = useMemo(
    () =>
      sortRows(
        skuRows,
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
    [skuRows, sortState],
  )

  const totalPages = Math.max(1, Math.ceil(sortedSkuRows.length / TABLE_PAGE_SIZE))
  const pageRows = sortedSkuRows.slice((page - 1) * TABLE_PAGE_SIZE, page * TABLE_PAGE_SIZE)

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

  const maxTopSku = Math.max(...skuRows.slice(0, 10).map((row) => row.units30), 1)

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
    <div id="view-dashboard" className="view-content !overflow-y-auto !bg-page !p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <div className="grid h-9 w-9 place-items-center rounded-card bg-brand text-white shadow-sm">
              <LayoutDashboard size={18} strokeWidth={2.5} />
            </div>
            <div>
              <h2 className="text-[20px] font-extrabold tracking-[-0.02em] text-ink">
                Inventory & Stockout Prevention
              </h2>
              <p className="text-tiny text-ink-3">
                Monitor inventory health, days of supply, and take action to prevent stockouts
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="text-tiny font-medium text-ink-3">Data as of {formatDataTimestamp()}</div>
          <button
            type="button"
            onClick={() => loadDashboard('refresh')}
            className="inline-flex h-9 items-center gap-1.5 rounded-card border border-line bg-surface px-3 text-tiny font-semibold text-ink-2 shadow-sm hover:bg-surface-2"
          >
            <RefreshCw size={13} strokeWidth={2.5} className={refreshing ? 'animate-spin' : ''} />
            Refresh
          </button>
          <label className="inline-flex h-9 items-center gap-2 rounded-card border border-line bg-surface px-3 shadow-sm">
            <Filter size={13} strokeWidth={2.5} className="text-ink-3" />
            <select
              value={selectedClientId ?? ''}
              onChange={(event) => setSelectedClientId(event.target.value ? Number(event.target.value) : null)}
              className="bg-transparent text-tiny font-semibold text-ink outline-none"
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
          helper={<ChangeText pct={relativePct(kpis.currentUnits7, kpis.priorUnits7)} />}
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
          helper={<ChangeText pct={relativePct(kpis.revenue30, kpis.priorRevenue30)} />}
          spark={trend.map((point) => point.current)}
        />
        <KpiCard
          title="In Stock"
          value={`${formatInt(kpis.inStock)} SKUs`}
          tone="green"
          icon={<CheckCircle2 size={18} strokeWidth={2.25} />}
          helper={<span className="text-ink-3">{Math.round((kpis.inStock / kpis.totalStockSkus) * 100)}% of total SKUs</span>}
        />
        <KpiCard
          title="Low Stock"
          value={`${formatInt(kpis.lowStock)} SKUs`}
          tone="orange"
          icon={<AlertTriangle size={18} strokeWidth={2.25} />}
          helper={<span className="text-ink-3">{Math.round((kpis.lowStock / kpis.totalStockSkus) * 100)}% of total SKUs</span>}
        />
        <KpiCard
          title="Out of Stock"
          value={`${formatInt(kpis.outStock)} SKUs`}
          tone="red"
          icon={<CircleX size={18} strokeWidth={2.25} />}
          helper={<span className="text-ink-3">{Math.round((kpis.outStock / kpis.totalStockSkus) * 100)}% of total SKUs</span>}
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
            {sortedSkuRows.slice(0, 5).map((row, index) => (
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
            {sortedSkuRows.length === 0 ? (
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
          <div className="flex flex-wrap items-center gap-3 text-2xs text-ink-3">
            <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-ok" /> at least +20%</span>
            <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-ok/40" /> +10% to +20%</span>
            <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-warn/35" /> -10% to +10%</span>
            <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-warn" /> -10% to -20%</span>
            <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-danger" /> below -20%</span>
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
          </div>
        </div>
      </section>

      <section className="rounded-card border border-line bg-surface shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            <h3 className="text-sm font-extrabold text-ink">SKU Performance Summary</h3>
            <p className="text-tiny text-ink-3">Revenue, velocity, stock status, and restock signals</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-card border border-line bg-surface-2 px-3 py-1.5 text-tiny font-semibold text-ink-2">
              {selectedClient?.name ?? 'All Clients'}
            </span>
            <span className="rounded-card border border-line bg-surface-2 px-3 py-1.5 text-tiny font-semibold text-ink-2">
              {formatInt(sortedSkuRows.length)} SKUs
            </span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1320px] border-collapse text-sm2">
            <thead className="bg-surface-2">
              <tr>
                <th className="w-9 border-b-2 border-line px-3 py-2" />
                <SortableHeader sortKey="sku" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} className="border-b-2 border-line px-3 py-2 text-left text-2xs font-bold uppercase tracking-[0.04em] text-ink-3">SKU</SortableHeader>
                <SortableHeader sortKey="product" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} className="border-b-2 border-line px-3 py-2 text-left text-2xs font-bold uppercase tracking-[0.04em] text-ink-3">Product</SortableHeader>
                <SortableHeader sortKey="client" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} className="border-b-2 border-line px-3 py-2 text-left text-2xs font-bold uppercase tracking-[0.04em] text-ink-3">Store</SortableHeader>
                <SortableHeader sortKey="revenue" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} align="right" className="border-b-2 border-line px-3 py-2 text-right text-2xs font-bold uppercase tracking-[0.04em] text-ink-3">Revenue</SortableHeader>
                <SortableHeader sortKey="avgPrice" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} align="right" className="border-b-2 border-line px-3 py-2 text-right text-2xs font-bold uppercase tracking-[0.04em] text-ink-3">Avg. Price</SortableHeader>
                <SortableHeader sortKey="avgShipping" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} align="right" className="border-b-2 border-line px-3 py-2 text-right text-2xs font-bold uppercase tracking-[0.04em] text-ink-3">Avg. Shipping</SortableHeader>
                <SortableHeader sortKey="status" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} className="border-b-2 border-line px-3 py-2 text-left text-2xs font-bold uppercase tracking-[0.04em] text-ink-3">Stock Status</SortableHeader>
                <SortableHeader sortKey="daysSupply" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} align="right" className="border-b-2 border-line px-3 py-2 text-right text-2xs font-bold uppercase tracking-[0.04em] text-ink-3">Days Supply</SortableHeader>
                <SortableHeader sortKey="restockQty" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} align="right" className="border-b-2 border-line px-3 py-2 text-right text-2xs font-bold uppercase tracking-[0.04em] text-ink-3">Restock Qty</SortableHeader>
                <SortableHeader sortKey="units7" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} align="right" className="border-b-2 border-line px-3 py-2 text-right text-2xs font-bold uppercase tracking-[0.04em] text-ink-3">7-Day Units</SortableHeader>
                <SortableHeader sortKey="units30" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} align="right" className="border-b-2 border-line px-3 py-2 text-right text-2xs font-bold uppercase tracking-[0.04em] text-ink-3">30-Day Units</SortableHeader>
                <SortableHeader sortKey="priorAvg" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} align="right" className="border-b-2 border-line px-3 py-2 text-right text-2xs font-bold uppercase tracking-[0.04em] text-ink-3">30-Day Avg.</SortableHeader>
                <SortableHeader sortKey="changePct" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} align="right" className="border-b-2 border-line px-3 py-2 text-right text-2xs font-bold uppercase tracking-[0.04em] text-ink-3">vs Prior 30 Days</SortableHeader>
                <th className="border-b-2 border-line px-3 py-2 text-left text-2xs font-bold uppercase tracking-[0.04em] text-ink-3">Trend</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row) => (
                <tr key={row.sku} className="border-b border-line last:border-b-0 hover:bg-brand-bg/30">
                  <td className="px-3 py-2 text-ink-3"><Star size={13} strokeWidth={2} /></td>
                  <td className="px-3 py-2 font-mono text-xs font-semibold text-brand">{row.sku}</td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => onOpenSku?.(row.sku)}
                      className="flex max-w-[320px] items-center gap-2 text-left"
                    >
                      <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-md border border-line bg-surface-2">
                        {row.imageUrl ? (
                          <img src={row.imageUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
                        ) : (
                          <Package size={15} strokeWidth={2.25} className="text-ink-3" />
                        )}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-semibold text-ink hover:text-brand">{row.product}</span>
                      </span>
                    </button>
                  </td>
                  <td className="px-3 py-2 text-xs text-ink-2">{row.client}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-ink">{formatMoney(row.revenue)}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-ink-2">{formatMoneySmall(row.avgPrice)}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-ink-2">{formatMoneySmall(row.avgShipping)}</td>
                  <td className="px-3 py-2"><StatusBadge status={row.status} /></td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-ink-2">{row.daysSupply == null ? '-' : formatInt(row.daysSupply)}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-ink-2">{formatInt(row.restockQty)}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-ink-2">{formatInt(row.units7)}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs font-semibold text-ink">{formatInt(row.units30)}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-ink-2">{formatInt(row.priorAvg)}</td>
                  <td className="px-3 py-2 text-right">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-bold ${row.changePct >= 0 ? 'bg-ok/10 text-ok' : 'bg-danger/10 text-danger'}`}>
                      {row.changePct >= 0 ? <ArrowUpRight size={11} strokeWidth={2.5} /> : <ArrowDownRight size={11} strokeWidth={2.5} />}
                      {formatPct(row.changePct)}
                    </span>
                  </td>
                  <td className="px-3 py-2"><TinyTrend values={last(row.trend, 12)} negative={row.changePct < 0} /></td>
                </tr>
              ))}
              {pageRows.length === 0 ? (
                <tr>
                  <td colSpan={15} className="px-3 py-10 text-center text-sm text-ink-3">
                    No SKU performance data for this filter.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 text-tiny text-ink-3">
          <div>
            Showing {sortedSkuRows.length === 0 ? 0 : (page - 1) * TABLE_PAGE_SIZE + 1} to {Math.min(page * TABLE_PAGE_SIZE, sortedSkuRows.length)} of {formatInt(sortedSkuRows.length)} SKUs
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={page <= 1}
              className="h-8 rounded-card border border-line bg-surface px-3 font-semibold text-ink-2 disabled:opacity-40"
            >
              Prev
            </button>
            <span className="rounded-card border border-line bg-brand px-3 py-1.5 font-bold text-white">{page}</span>
            <button
              type="button"
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              disabled={page >= totalPages}
              className="h-8 rounded-card border border-line bg-surface px-3 font-semibold text-ink-2 disabled:opacity-40"
            >
              Next
            </button>
            <span className="ml-2 font-semibold text-ink-2">10 / page</span>
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
