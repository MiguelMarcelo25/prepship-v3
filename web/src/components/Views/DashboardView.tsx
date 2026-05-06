// @ts-nocheck
import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  LayoutDashboard,
  Package,
  Truck,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Box,
  ShoppingCart,
  Activity,
  Loader2,
  Inbox,
  ArrowUpRight,
  ArrowDownRight,
} from 'lucide-react'
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts'
import { apiClient } from '../../api/client'

type DailyStats = {
  totalOrders: number
  needToShip: number
  upcomingOrders: number
  shipped?: number
  window?: { from?: string; to?: string; fromLabel?: string; toLabel?: string }
}

type CountsByStatus = Record<string, number>

type InventoryAlert = {
  invSkuId?: number
  sku?: string
  itemName?: string
  stockOnHand?: number
  minStock?: number
  status?: string
}

type SalesPoint = { day: string; total: number }
type OrderPoint = { day: string; awaiting: number; shipped: number; cancelled: number; total: number }

type TopSku = { sku: string; name?: string; total_qty: number }

type HeatmapBand = 'high' | 'mid' | 'flat' | 'dip' | 'low'

type HeatmapCell = {
  day: string
  qty: number
  deviation: number // % vs prior baseline (e.g. 25 = +25%)
  band: HeatmapBand
}

type HeatmapRow = {
  sku: string
  label: string
  priorAvg: number
  cells: HeatmapCell[]
}

function bandFromDeviation(deviation: number): HeatmapBand {
  if (deviation >= 20) return 'high'
  if (deviation >= 10) return 'mid'
  if (deviation > -10) return 'flat'
  if (deviation > -20) return 'dip'
  return 'low'
}

const BAND_COLORS: Record<HeatmapBand, string> = {
  high: 'bg-emerald-500',
  mid: 'bg-emerald-300',
  flat: 'bg-slate-100',
  dip: 'bg-amber-300',
  low: 'bg-rose-500',
}

const BAND_RING: Record<HeatmapBand, string> = {
  high: 'ring-emerald-600/20',
  mid: 'ring-emerald-400/20',
  flat: 'ring-line/50',
  dip: 'ring-amber-400/30',
  low: 'ring-rose-600/20',
}

const num = (v: unknown, fallback = 0) => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

function formatInt(n: number): string {
  return n.toLocaleString('en-US')
}

function formatDayLabel(iso: string): string {
  // Accepts "YYYY-MM-DD"
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  if (!y || !m || !d) return iso
  const date = new Date(Number(y), Number(m) - 1, Number(d))
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function relativeChange(current: number, prior: number): { pct: number; direction: 'up' | 'down' | 'flat' } {
  if (prior <= 0 && current <= 0) return { pct: 0, direction: 'flat' }
  if (prior <= 0) return { pct: 100, direction: 'up' }
  const pct = ((current - prior) / prior) * 100
  if (Math.abs(pct) < 0.5) return { pct: 0, direction: 'flat' }
  return { pct: Math.round(Math.abs(pct) * 10) / 10, direction: pct > 0 ? 'up' : 'down' }
}

interface KpiTileProps {
  icon: React.ReactNode
  iconBg: string
  iconRing: string
  label: string
  value: string
  helper?: React.ReactNode
  delay?: number
}

function KpiTile({ icon, iconBg, iconRing, label, value, helper, delay = 0 }: KpiTileProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      whileHover={{ y: -2 }}
      className="bg-surface rounded-2xl border border-line shadow-sm hover:shadow-md transition-shadow p-4"
    >
      <div className="flex items-start gap-3">
        <div
          className={`w-10 h-10 rounded-lg flex items-center justify-center shadow-sm ring-1 ${iconBg} ${iconRing}`}
        >
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-tiny text-ink-3 font-semibold uppercase tracking-[0.06em]">{label}</div>
          <div className="text-[24px] font-extrabold text-ink font-display tracking-[-0.03em] mt-0.5 font-mono tabular-nums leading-none">
            {value}
          </div>
          {helper ? <div className="mt-1.5 text-tiny">{helper}</div> : null}
        </div>
      </div>
    </motion.div>
  )
}

function ChangePill({ pct, direction }: { pct: number; direction: 'up' | 'down' | 'flat' }) {
  if (direction === 'flat') {
    return <span className="text-ink-3 text-tiny font-mono tabular-nums">— flat</span>
  }
  const positive = direction === 'up'
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-tiny font-mono tabular-nums font-bold ${
        positive ? 'text-emerald-600' : 'text-rose-600'
      }`}
    >
      {positive ? <ArrowUpRight size={11} strokeWidth={2.75} /> : <ArrowDownRight size={11} strokeWidth={2.75} />}
      {pct}%
    </span>
  )
}

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-3">
      <h3 className="text-[14px] font-extrabold text-ink font-display tracking-tight">{title}</h3>
      {subtitle ? <p className="text-tiny text-ink-3 mt-0.5">{subtitle}</p> : null}
    </div>
  )
}

interface DashboardViewProps {
  onOpenSku?: (sku: string) => void
}

export default function DashboardView({ onOpenSku }: DashboardViewProps = {}) {
  const [counts, setCounts] = useState<CountsByStatus | null>(null)
  const [stats, setStats] = useState<DailyStats | null>(null)
  const [alerts, setAlerts] = useState<InventoryAlert[]>([])
  const [trend, setTrend] = useState<SalesPoint[]>([])
  const [orderTrend, setOrderTrend] = useState<OrderPoint[]>([])
  const [topSkus, setTopSkus] = useState<TopSku[]>([])
  const [heatmap, setHeatmap] = useState<{ dates: string[]; rows: HeatmapRow[] }>({ dates: [], rows: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const today = new Date()
        const ago30 = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 30)
        const ago60 = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 60)
        const fromIso = ago30.toISOString().split('T')[0]
        const toIso = today.toISOString().split('T')[0]
        const fromIsoPrior = ago60.toISOString().split('T')[0]
        const toIsoPrior = ago30.toISOString().split('T')[0]

        // Fetch orders for the trend chart. The /orders endpoint caps pageSize
        // at 200 (validation in src/lib/pagination.ts), so we page through:
        //  1. First page reveals total page count.
        //  2. Pull remaining pages in parallel, capped at 25 pages = 5000 rows.
        const fetchAllOrdersInRange = async () => {
          const PAGE_SIZE = 200
          const PAGE_CAP = 25
          const first = await apiClient
            .fetchOrders({ dateStart: fromIso, dateEnd: toIso, pageSize: PAGE_SIZE, page: 1 })
            .catch(() => null)
          if (!first) return null
          const allOrders = Array.isArray((first as any).orders) ? [...(first as any).orders] : []
          const totalPages = Math.min(num((first as any).pages, 1), PAGE_CAP)
          if (totalPages > 1) {
            const remaining = await Promise.all(
              Array.from({ length: totalPages - 1 }, (_, i) => i + 2).map((page) =>
                apiClient
                  .fetchOrders({ dateStart: fromIso, dateEnd: toIso, pageSize: PAGE_SIZE, page })
                  .then((res: any) => (Array.isArray(res?.orders) ? res.orders : []))
                  .catch(() => []),
              ),
            )
            for (const batch of remaining) allOrders.push(...batch)
          }
          return { orders: allOrders, total: num((first as any).total) }
        }

        const [countsRes, statsRes, alertsRes, salesRes, priorSalesRes, ordersRes] = await Promise.allSettled([
          apiClient.fetchCounts(),
          apiClient.fetchDailyStats(),
          apiClient.fetchInventoryAlerts().catch(() => []),
          apiClient
            .fetchAnalysisDailySales({ from: fromIso, to: toIso, limit: 6 })
            .catch(() => null),
          apiClient
            .fetchAnalysisDailySales({ from: fromIsoPrior, to: toIsoPrior, limit: 6 })
            .catch(() => null),
          fetchAllOrdersInRange(),
        ])

        if (cancelled) return

        if (countsRes.status === 'fulfilled') {
          const raw = countsRes.value as any
          const map: CountsByStatus = {}
          // The v2-apiClient `fetchCounts` returns:
          //   { byStatus: [{orderStatus, cnt}, ...], byStatusStore: [...] }
          // We also defensively handle a few legacy shapes.
          if (raw && typeof raw === 'object') {
            if (Array.isArray(raw.byStatus)) {
              raw.byStatus.forEach((row: any) => {
                const status = row?.orderStatus ?? row?.status
                if (status) map[String(status)] = num(row.cnt ?? row.count ?? row.total)
              })
            } else if (Array.isArray(raw)) {
              raw.forEach((row: any) => {
                const status = row?.orderStatus ?? row?.status
                if (status) map[String(status)] = num(row.cnt ?? row.count ?? row.total)
              })
            } else if (raw.byStatus && typeof raw.byStatus === 'object') {
              for (const k of Object.keys(raw.byStatus)) map[k] = num((raw.byStatus as any)[k])
            } else {
              for (const k of Object.keys(raw)) {
                const v = (raw as any)[k]
                if (typeof v === 'number') map[k] = v
                else if (v && typeof v === 'object' && 'count' in v) map[k] = num((v as any).count)
              }
            }
          }
          setCounts(map)
        }

        if (statsRes.status === 'fulfilled') {
          setStats(statsRes.value as DailyStats)
        }

        if (alertsRes.status === 'fulfilled') {
          const raw = Array.isArray(alertsRes.value) ? alertsRes.value : []
          setAlerts(raw.slice(0, 8))
        }

        if (salesRes.status === 'fulfilled' && salesRes.value) {
          const raw: any = salesRes.value
          const dates: string[] = Array.isArray(raw.dates) ? raw.dates : []
          const series: Record<string, number[]> = raw.series && typeof raw.series === 'object' ? raw.series : {}
          const points: SalesPoint[] = dates.map((day, idx) => {
            let total = 0
            for (const sku of Object.keys(series)) total += num(series[sku]?.[idx])
            return { day, total }
          })
          setTrend(points)

          const skusRaw: any[] = Array.isArray(raw.topSkus) ? raw.topSkus : []
          const topSkusList = skusRaw
            .map((s: any) => ({
              sku: String(s?.sku ?? ''),
              name: s?.name ?? s?.itemName ?? undefined,
              total_qty: num(s?.total_qty ?? s?.totalQty),
            }))
            .filter((s: TopSku) => s.sku)
          setTopSkus(topSkusList)

          // Build heatmap rows: for each top SKU, compute % deviation per day
          // against that SKU's average daily qty in the *prior* 30-day window.
          // Falls back to current-window mean if prior data is missing for the
          // SKU (avoids dividing by zero on brand-new items).
          const priorRaw: any =
            priorSalesRes.status === 'fulfilled' && priorSalesRes.value ? priorSalesRes.value : null
          const priorSeries: Record<string, number[]> =
            priorRaw && priorRaw.series && typeof priorRaw.series === 'object' ? priorRaw.series : {}

          const computeAvg = (arr: number[] | undefined): number => {
            if (!Array.isArray(arr) || arr.length === 0) return 0
            const sum = arr.reduce((a, b) => a + num(b), 0)
            return sum / arr.length
          }

          const heatmapRows: HeatmapRow[] = topSkusList.slice(0, 6).map((sku) => {
            const skuSeries: number[] = Array.isArray(series[sku.sku]) ? series[sku.sku] : []
            const priorAvg = computeAvg(priorSeries[sku.sku])
            // If prior data is empty, fall back to the current-window mean so
            // every cell still gets a meaningful baseline.
            const baseline = priorAvg > 0 ? priorAvg : computeAvg(skuSeries) || 1
            const cells: HeatmapCell[] = dates.map((day, i) => {
              const qty = num(skuSeries[i])
              const deviation = baseline > 0 ? ((qty - baseline) / baseline) * 100 : 0
              return { day, qty, deviation, band: bandFromDeviation(deviation) }
            })
            return {
              sku: sku.sku,
              label: sku.name || sku.sku,
              priorAvg,
              cells,
            }
          })
          setHeatmap({ dates, rows: heatmapRows })
        }

        // Build order trend (real orders per day) — independent of analysis SKU
        // data. The chart will use this; the SKU-units series stays available
        // for any future stacked view.
        if (ordersRes.status === 'fulfilled' && ordersRes.value) {
          const payload: any = ordersRes.value
          const rows: any[] = Array.isArray(payload?.orders) ? payload.orders : []

          // Build a continuous 30-day axis so days with zero orders still show.
          const axis: string[] = []
          for (let i = 0; i < 31; i++) {
            const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 30 + i)
            axis.push(d.toISOString().split('T')[0])
          }
          const buckets: Record<string, OrderPoint> = {}
          axis.forEach((day) => {
            buckets[day] = { day, awaiting: 0, shipped: 0, cancelled: 0, total: 0 }
          })

          for (const order of rows) {
            const raw = order?.orderDate ?? order?.createDate ?? order?.shipByDate ?? order?.modifyDate
            if (!raw) continue
            const day = String(raw).slice(0, 10) // 'YYYY-MM-DD'
            const bucket = buckets[day]
            if (!bucket) continue
            const status = String(order?.orderStatus ?? order?.status ?? '').toLowerCase()
            if (status === 'awaiting_shipment') bucket.awaiting += 1
            else if (status === 'shipped') bucket.shipped += 1
            else if (status === 'cancelled') bucket.cancelled += 1
            bucket.total += 1
          }

          setOrderTrend(axis.map((day) => buckets[day]))
        }
      } catch (loadError) {
        if (cancelled) return
        setError(loadError instanceof Error ? loadError.message : 'Failed to load dashboard')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [])

  const orderTrendStats = useMemo(() => {
    if (!orderTrend.length) return { sum: 0, current: 0, prior: 0, change: { pct: 0, direction: 'flat' as const } }
    const sum = orderTrend.reduce((acc, p) => acc + p.total, 0)
    const half = Math.max(1, Math.floor(orderTrend.length / 2))
    const prior = orderTrend.slice(0, half).reduce((acc, p) => acc + p.total, 0)
    const current = orderTrend.slice(half).reduce((acc, p) => acc + p.total, 0)
    return { sum, current, prior, change: relativeChange(current, prior) }
  }, [orderTrend])

  const topSkuMax = useMemo(() => topSkus.reduce((m, s) => Math.max(m, s.total_qty), 0), [topSkus])

  const awaiting = num(counts?.awaiting_shipment)
  const shipped = num(counts?.shipped)
  const cancelled = num(counts?.cancelled)
  const totalActive = awaiting + shipped + cancelled

  const lowStockCount = alerts.filter((a) => num(a.stockOnHand) > 0).length
  const outOfStockCount = alerts.filter((a) => num(a.stockOnHand) <= 0).length

  return (
    <div id="view-dashboard" className="view-content !p-5 !overflow-y-auto !bg-page">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        className="flex items-start justify-between gap-3 mb-5 flex-wrap"
      >
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-brand to-indigo-700 flex items-center justify-center shadow-lg ring-1 ring-brand/30">
            <LayoutDashboard size={22} strokeWidth={2.25} className="text-white" />
          </div>
          <div>
            <h2 className="text-[18px] font-extrabold text-ink font-display tracking-[-0.025em]">Dashboard</h2>
            <p className="text-tiny text-ink-3 mt-0.5">
              Live overview of fulfillment, inventory health, and sales velocity
            </p>
          </div>
        </div>

        {stats?.window?.fromLabel && stats?.window?.toLabel ? (
          <div className="inline-flex items-center gap-1.5 text-tiny text-ink-2 bg-surface px-3 py-2 rounded-lg border border-line shadow-sm">
            <Activity size={12} strokeWidth={2.25} className="text-brand" />
            <span className="text-ink-3">Today's window:</span>
            <span className="font-mono font-semibold text-ink">
              {stats.window.fromLabel} → {stats.window.toLabel}
            </span>
          </div>
        ) : null}
      </motion.div>

      {/* Loading */}
      <AnimatePresence>
        {loading ? (
          <motion.div
            key="loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 mb-4"
          >
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="bg-surface rounded-2xl border border-line p-4 h-[96px] flex items-center gap-3"
              >
                <div className="w-10 h-10 rounded-lg bg-line/60 animate-pulse" />
                <div className="flex-1 space-y-2">
                  <div className="w-20 h-2.5 rounded bg-line/60 animate-pulse" />
                  <div className="w-28 h-5 rounded bg-line/60 animate-pulse" />
                  <div className="w-16 h-2.5 rounded bg-line/60 animate-pulse" />
                </div>
              </div>
            ))}
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Error */}
      {error ? (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-4 px-4 py-3 rounded-xl border border-danger/20 bg-danger-bg text-danger text-tiny font-semibold flex items-center gap-2"
        >
          <AlertTriangle size={14} strokeWidth={2.5} />
          {error}
        </motion.div>
      ) : null}

      {!loading ? (
        <>
          {/* KPI tiles row — real totals from fetchCounts */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
            <KpiTile
              delay={0.02}
              label="Total Orders · 30d"
              value={formatInt(orderTrendStats.sum)}
              icon={<ShoppingCart size={18} strokeWidth={2.25} className="text-white" />}
              iconBg="bg-gradient-to-br from-brand to-indigo-600"
              iconRing="ring-brand/20"
              helper={
                orderTrend.length > 0 ? (
                  <span className="inline-flex items-center gap-1">
                    <ChangePill pct={orderTrendStats.change.pct} direction={orderTrendStats.change.direction} />
                    <span className="text-ink-3">vs prior half</span>
                  </span>
                ) : (
                  <span className="text-ink-3">no orders</span>
                )
              }
            />
            <KpiTile
              delay={0.05}
              label="Awaiting"
              value={formatInt(awaiting)}
              icon={<Box size={18} strokeWidth={2.25} className="text-white" />}
              iconBg="bg-gradient-to-br from-sky-500 to-sky-600"
              iconRing="ring-sky-300/30"
              helper={
                <span className="text-ink-3">
                  <span className="font-mono tabular-nums font-semibold text-ink-2">{formatInt(num(stats?.needToShip))}</span>{' '}
                  need to ship today
                </span>
              }
            />
            <KpiTile
              delay={0.08}
              label="Shipped"
              value={formatInt(shipped)}
              icon={<Truck size={18} strokeWidth={2.25} className="text-white" />}
              iconBg="bg-gradient-to-br from-emerald-500 to-emerald-600"
              iconRing="ring-emerald-300/30"
              helper={
                totalActive > 0 ? (
                  <span className="text-ink-3">
                    <span className="font-mono tabular-nums font-semibold text-emerald-700">
                      {Math.round((shipped / totalActive) * 100)}%
                    </span>{' '}
                    of all orders
                  </span>
                ) : (
                  <span className="text-ink-3">no orders yet</span>
                )
              }
            />
            <KpiTile
              delay={0.11}
              label="Cancelled"
              value={formatInt(cancelled)}
              icon={<TrendingDown size={18} strokeWidth={2.25} className="text-white" />}
              iconBg="bg-gradient-to-br from-slate-500 to-slate-600"
              iconRing="ring-slate-300/30"
              helper={
                totalActive > 0 ? (
                  <span className="text-ink-3">
                    <span className="font-mono tabular-nums font-semibold text-ink-2">
                      {((cancelled / totalActive) * 100).toFixed(1)}%
                    </span>{' '}
                    cancellation rate
                  </span>
                ) : (
                  <span className="text-ink-3">—</span>
                )
              }
            />
            <KpiTile
              delay={0.14}
              label="Inventory Alerts"
              value={formatInt(alerts.length)}
              icon={<AlertTriangle size={18} strokeWidth={2.25} className="text-white" />}
              iconBg="bg-gradient-to-br from-rose-500 to-rose-600"
              iconRing="ring-rose-300/30"
              helper={
                alerts.length > 0 ? (
                  <span className="text-ink-3">
                    <span className="font-mono tabular-nums font-semibold text-rose-600">{outOfStockCount}</span> out ·{' '}
                    <span className="font-mono tabular-nums font-semibold text-amber-600">{lowStockCount}</span> low
                  </span>
                ) : (
                  <span className="text-emerald-600 font-semibold">All stocked ✓</span>
                )
              }
            />
          </div>

          {/* Sales Performance Heatmap */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15, duration: 0.3 }}
            className="bg-surface rounded-2xl border border-line shadow-sm p-4 mb-4"
          >
            <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
              <SectionHeader
                title="Sales Performance Heatmap"
                subtitle="Top SKUs · last 30 days · color = % deviation vs prior 30-day daily average"
              />
            </div>

            {heatmap.rows.length === 0 ? (
              <div className="h-[200px] flex flex-col items-center justify-center gap-2">
                <Inbox size={28} strokeWidth={2} className="text-ink-4" />
                <div className="text-tiny text-ink-3">Not enough sales history for a heatmap.</div>
              </div>
            ) : (
              <>
                <div className="overflow-x-auto pb-1">
                  <div className="inline-block min-w-full">
                    {/* Day-number header row */}
                    <div className="flex items-end gap-px mb-1 select-none">
                      <div className="w-[140px] flex-shrink-0 pr-2 text-2xs text-ink-3 font-mono uppercase tracking-wider">
                        SKU
                      </div>
                      <div className="flex gap-px">
                        {heatmap.dates.map((iso) => {
                          const date = (() => {
                            const [y, m, d] = iso.split('-').map(Number)
                            if (!y || !m || !d) return null
                            return new Date(y, m - 1, d)
                          })()
                          const dayNum = date ? date.getDate() : '?'
                          const isFirstOfMonth = date ? date.getDate() === 1 : false
                          return (
                            <div key={iso} className="w-5 flex flex-col items-center">
                              {isFirstOfMonth ? (
                                <span className="text-2xs text-ink-2 font-bold uppercase tracking-wider mb-0.5">
                                  {date!.toLocaleDateString('en-US', { month: 'short' })}
                                </span>
                              ) : (
                                <span className="text-2xs text-transparent mb-0.5 leading-none">·</span>
                              )}
                              <span className="text-2xs text-ink-3 font-mono tabular-nums leading-none">{dayNum}</span>
                            </div>
                          )
                        })}
                      </div>
                    </div>

                    {/* Cell rows */}
                    <motion.div
                      variants={{ hidden: {}, show: { transition: { staggerChildren: 0.04 } } }}
                      initial="hidden"
                      animate="show"
                    >
                      {heatmap.rows.map((row) => {
                        const interactive = Boolean(onOpenSku)
                        const openRow = () => onOpenSku?.(row.sku)
                        return (
                          <motion.div
                            key={row.sku}
                            variants={{
                              hidden: { opacity: 0, x: -6 },
                              show: { opacity: 1, x: 0, transition: { duration: 0.25 } },
                            }}
                            className="flex items-center gap-px mb-px"
                          >
                            <button
                              type="button"
                              onClick={interactive ? openRow : undefined}
                              disabled={!interactive}
                              title={`${row.label}\nSKU: ${row.sku}\nPrior daily avg: ${row.priorAvg.toFixed(1)}${interactive ? '\nClick to open in Analysis' : ''}`}
                              aria-label={`Open ${row.label} in Analysis`}
                              className={`w-[140px] flex-shrink-0 pr-2 text-tiny text-ink-2 font-medium truncate text-left transition-colors duration-150 rounded-sm ${interactive ? 'hover:text-brand hover:underline cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40' : 'cursor-default'}`}
                            >
                              {row.label}
                            </button>
                            <div className="flex gap-px">
                              {row.cells.map((cell, i) => {
                                const sign = cell.deviation >= 0 ? '+' : ''
                                const tooltip = `${row.label}\n${cell.day}: ${formatInt(cell.qty)} units (${sign}${cell.deviation.toFixed(0)}% vs prior avg)${interactive ? '\nClick to open in Analysis' : ''}`
                                return (
                                  <motion.button
                                    type="button"
                                    key={`${row.sku}-${i}`}
                                    initial={{ opacity: 0, scale: 0.5 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    transition={{ delay: 0.18 + i * 0.005, duration: 0.18 }}
                                    whileHover={{ scale: 1.4, zIndex: 10 }}
                                    onClick={interactive ? openRow : undefined}
                                    disabled={!interactive}
                                    title={tooltip}
                                    aria-label={tooltip}
                                    className={`w-5 h-5 rounded-[3px] ring-1 transition-shadow hover:shadow-md ${BAND_COLORS[cell.band]} ${BAND_RING[cell.band]} ${interactive ? 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50' : 'cursor-default'}`}
                                  />
                                )
                              })}
                            </div>
                          </motion.div>
                        )
                      })}
                    </motion.div>
                  </div>
                </div>

                {/* Legend */}
                <div className="flex items-center gap-x-4 gap-y-1.5 mt-4 pt-3 border-t border-line text-2xs text-ink-3 flex-wrap">
                  <span className="font-semibold text-ink-2">Performance vs prior 30 days:</span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded-sm bg-emerald-500 ring-1 ring-emerald-600/20" /> ≥ +20%
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded-sm bg-emerald-300 ring-1 ring-emerald-400/20" /> +10% to +20%
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded-sm bg-slate-100 ring-1 ring-line/50" /> -10% to +10%
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded-sm bg-amber-300 ring-1 ring-amber-400/30" /> -10% to -20%
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded-sm bg-rose-500 ring-1 ring-rose-600/20" /> ≤ -20%
                  </span>
                </div>
              </>
            )}
          </motion.div>

          {/* Sales trend (full width, 2/3) + Top SKUs (1/3) */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-4">
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.18, duration: 0.3 }}
              className="lg:col-span-2 bg-surface rounded-2xl border border-line shadow-sm p-4"
            >
              <div className="flex items-start justify-between gap-3 mb-3">
                <SectionHeader
                  title="Orders per Day"
                  subtitle="Last 30 days · real orders by created date · split by current status"
                />
                <div className="text-right flex-shrink-0">
                  <div className="text-[20px] font-extrabold text-ink font-mono tabular-nums tracking-[-0.02em] leading-none">
                    {formatInt(orderTrendStats.sum)}
                  </div>
                  <div className="text-tiny text-ink-3 mt-0.5">total orders</div>
                  <div className="mt-1">
                    <ChangePill pct={orderTrendStats.change.pct} direction={orderTrendStats.change.direction} />
                    <span className="ml-1 text-tiny text-ink-3">vs first half</span>
                  </div>
                </div>
              </div>
              {orderTrend.length > 0 && orderTrendStats.sum > 0 ? (
                <div className="h-[220px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={orderTrend} margin={{ top: 6, right: 6, left: -16, bottom: 0 }}>
                      <defs>
                        <linearGradient id="dashShippedFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#16a34a" stopOpacity={0.4} />
                          <stop offset="100%" stopColor="#16a34a" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="dashAwaitingFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#2a5bd7" stopOpacity={0.32} />
                          <stop offset="100%" stopColor="#2a5bd7" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="dashCancelledFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#dc2626" stopOpacity={0.28} />
                          <stop offset="100%" stopColor="#dc2626" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="#eef0f4" strokeDasharray="3 3" vertical={false} />
                      <XAxis
                        dataKey="day"
                        tickFormatter={formatDayLabel}
                        tick={{ fill: '#8a95a3', fontSize: 10 }}
                        axisLine={{ stroke: '#e1e4e8' }}
                        tickLine={false}
                        minTickGap={20}
                      />
                      <YAxis
                        tick={{ fill: '#8a95a3', fontSize: 10 }}
                        axisLine={false}
                        tickLine={false}
                        width={32}
                        allowDecimals={false}
                      />
                      <Tooltip
                        cursor={{ stroke: '#c8cdd5', strokeDasharray: '3 3' }}
                        contentStyle={{
                          background: '#fff',
                          border: '1px solid #e1e4e8',
                          borderRadius: 8,
                          fontSize: 12,
                          fontFamily: 'Geist, system-ui, sans-serif',
                          boxShadow: '0 4px 16px -4px rgba(15,23,42,0.08)',
                        }}
                        labelFormatter={formatDayLabel}
                        formatter={(value: number, name: string) => [formatInt(num(value)), name]}
                      />
                      <Area
                        type="monotone"
                        dataKey="shipped"
                        name="Shipped"
                        stackId="orders"
                        stroke="#16a34a"
                        strokeWidth={1.5}
                        fill="url(#dashShippedFill)"
                        activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }}
                      />
                      <Area
                        type="monotone"
                        dataKey="awaiting"
                        name="Awaiting"
                        stackId="orders"
                        stroke="#2a5bd7"
                        strokeWidth={1.5}
                        fill="url(#dashAwaitingFill)"
                        activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }}
                      />
                      <Area
                        type="monotone"
                        dataKey="cancelled"
                        name="Cancelled"
                        stackId="orders"
                        stroke="#dc2626"
                        strokeWidth={1.5}
                        fill="url(#dashCancelledFill)"
                        activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="h-[220px] flex flex-col items-center justify-center gap-2">
                  <Inbox size={28} strokeWidth={2} className="text-ink-4" />
                  <div className="text-tiny text-ink-3">No orders in the last 30 days.</div>
                </div>
              )}
              {/* Legend chips */}
              {orderTrend.length > 0 && orderTrendStats.sum > 0 ? (
                <div className="flex items-center gap-x-4 gap-y-1 mt-3 pt-3 border-t border-line text-tiny flex-wrap">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded-sm bg-emerald-600/80 ring-1 ring-emerald-700/30" />
                    <span className="text-ink-2 font-medium">Shipped</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded-sm bg-brand/70 ring-1 ring-brand/30" />
                    <span className="text-ink-2 font-medium">Awaiting</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded-sm bg-rose-600/70 ring-1 ring-rose-700/30" />
                    <span className="text-ink-2 font-medium">Cancelled</span>
                  </span>
                </div>
              ) : null}
            </motion.div>

            {/* Top SKUs */}
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.22, duration: 0.3 }}
              className="bg-surface rounded-2xl border border-line shadow-sm p-4 flex flex-col"
            >
              <SectionHeader title="Top SKUs (30d)" subtitle="By total units sold" />
              {topSkus.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center gap-2 py-6">
                  <Package size={26} strokeWidth={2} className="text-ink-4" />
                  <div className="text-tiny text-ink-3">No SKU data available.</div>
                </div>
              ) : (
                <ul className="space-y-2.5 mt-1">
                  {topSkus.slice(0, 6).map((sku, idx) => {
                    const pct = topSkuMax > 0 ? Math.max(4, (sku.total_qty / topSkuMax) * 100) : 0
                    const interactive = Boolean(onOpenSku)
                    const open = () => onOpenSku?.(sku.sku)
                    return (
                      <motion.li
                        key={sku.sku}
                        initial={{ opacity: 0, x: -6 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: 0.24 + idx * 0.04, duration: 0.2 }}
                      >
                        <button
                          type="button"
                          disabled={!interactive}
                          onClick={interactive ? open : undefined}
                          title={interactive ? `Open ${sku.name || sku.sku} in Analysis` : (sku.name || sku.sku)}
                          aria-label={`Open ${sku.name || sku.sku} in Analysis`}
                          className={`w-full text-left group rounded-md p-1.5 -m-1.5 transition-colors duration-150 ${interactive ? 'hover:bg-brand-bg/40 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40' : 'cursor-default'}`}
                        >
                          <div className="flex items-baseline justify-between gap-2 mb-1">
                            <div className="min-w-0 flex-1">
                              <div className={`text-[12.5px] font-semibold truncate ${interactive ? 'text-ink group-hover:text-brand' : 'text-ink'}`}>
                                {sku.name || sku.sku}
                              </div>
                              <div className="text-2xs text-ink-3 font-mono tabular-nums truncate">{sku.sku}</div>
                            </div>
                            <div className="text-tiny font-bold text-ink font-mono tabular-nums whitespace-nowrap">
                              {formatInt(sku.total_qty)}
                            </div>
                          </div>
                          <div className="h-1.5 bg-line/60 rounded-full overflow-hidden">
                            <motion.div
                              className="h-full rounded-full bg-gradient-to-r from-brand to-indigo-500"
                              initial={{ width: 0 }}
                              animate={{ width: `${pct}%` }}
                              transition={{ delay: 0.3 + idx * 0.04, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
                            />
                          </div>
                        </button>
                      </motion.li>
                    )
                  })}
                </ul>
              )}
            </motion.div>
          </div>

          {/* Inventory alerts list (full width) */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.28, duration: 0.3 }}
            className="bg-surface rounded-2xl border border-line shadow-sm p-4"
          >
            <div className="flex items-center justify-between gap-3 mb-3">
              <SectionHeader title="Inventory Alerts" subtitle="SKUs with low or zero stock" />
              {alerts.length > 0 ? (
                <span className="inline-flex items-center gap-1.5 text-tiny font-bold text-rose-700 bg-rose-50 ring-1 ring-rose-200 px-2 py-0.5 rounded-md font-mono tabular-nums">
                  <AlertTriangle size={11} strokeWidth={2.5} />
                  {alerts.length}
                </span>
              ) : null}
            </div>
            {alerts.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-10">
                <div className="w-12 h-12 rounded-full bg-emerald-50 ring-2 ring-emerald-200 flex items-center justify-center">
                  <Package size={22} strokeWidth={2.25} className="text-emerald-600" />
                </div>
                <div className="text-sm font-semibold text-emerald-700 font-display">All SKUs are stocked</div>
                <div className="text-tiny text-ink-3">No inventory below the alert threshold.</div>
              </div>
            ) : (
              <motion.div
                variants={{ hidden: {}, show: { transition: { staggerChildren: 0.04 } } }}
                initial="hidden"
                animate="show"
                className="grid grid-cols-1 md:grid-cols-2 gap-2"
              >
                {alerts.map((alert) => {
                  const stock = num(alert.stockOnHand)
                  const min = num(alert.minStock, 0)
                  const isOut = stock <= 0
                  const accent = isOut ? 'rose' : 'amber'
                  return (
                    <motion.div
                      key={`${alert.invSkuId ?? alert.sku}`}
                      variants={{
                        hidden: { opacity: 0, y: 6 },
                        show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 320, damping: 24 } },
                      }}
                      whileHover={{ y: -1 }}
                      className={`relative flex items-center gap-3 rounded-xl border bg-surface p-3 transition-shadow hover:shadow-md ${
                        isOut ? 'border-rose-200/70' : 'border-amber-200/70'
                      }`}
                    >
                      <span
                        className={`absolute left-0 inset-y-2 w-1 rounded-r-full ${
                          isOut ? 'bg-rose-500' : 'bg-amber-500'
                        }`}
                      />
                      <div
                        className={`w-9 h-9 rounded-lg flex items-center justify-center bg-${accent}-50 ring-1 ring-${accent}-200 ml-2`}
                      >
                        {isOut ? (
                          <AlertTriangle size={16} strokeWidth={2.25} className="text-rose-600" />
                        ) : (
                          <TrendingDown size={16} strokeWidth={2.25} className="text-amber-600" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[12.5px] font-semibold text-ink truncate" title={alert.itemName ?? alert.sku}>
                          {alert.itemName || alert.sku || 'Unknown SKU'}
                        </div>
                        <div className="text-2xs text-ink-3 font-mono tabular-nums truncate">{alert.sku}</div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div
                          className={`text-[15px] font-extrabold font-mono tabular-nums leading-none ${
                            isOut ? 'text-rose-600' : 'text-amber-600'
                          }`}
                        >
                          {formatInt(stock)}
                        </div>
                        <div className="text-2xs text-ink-3 mt-0.5 font-mono tabular-nums">
                          {min > 0 ? `min ${formatInt(min)}` : isOut ? 'OUT' : 'low'}
                        </div>
                      </div>
                    </motion.div>
                  )
                })}
              </motion.div>
            )}
          </motion.div>

          {/* Footer note */}
          <div className="mt-3 text-center text-2xs text-ink-3">
            <Loader2 size={10} strokeWidth={2.5} className="inline-block mr-1 align-text-bottom" />
            Auto-refreshes when you reload. Sync runs every 3 min from the topbar.
          </div>
        </>
      ) : null}
    </div>
  )
}
