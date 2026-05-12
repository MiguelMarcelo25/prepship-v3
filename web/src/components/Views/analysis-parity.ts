// @ts-nocheck
import type {
  AnalysisDailySalesResponse,
  AnalysisSkuDto,
} from '@prepshipv2/contracts/analysis/contracts'

export type AnalysisSortKey =
  | 'name'
  | 'sku'
  | 'client'
  | 'orders'
  | 'pending'
  | 'external'
  | 'qty'
  | 'trend'
  | 'stdOrders'
  | 'expOrders'
  | 'total'
  | 'revenue'
  | 'avgPrice'

export type AnalysisSortDir = 'asc' | 'desc'

export interface AnalysisFiltersState {
  from: string
  to: string
  presetDays: number | null
}

export interface AnalysisTotals {
  skuCount: number
  totalOrders: number
  totalPending: number
  totalExternal: number
  totalQty: number
  totalStdCount: number
  totalExpCount: number
  // 2026-05-12: also sum the UNIT totals per service class. The Std /
  // Exp columns display per-unit average pricing (boss directive
  // 2026-05-07), so the math `units × $/unit = class total` only
  // works if we can show both. Order count alone vs per-unit avg
  // does NOT multiply to the subtotal in mixed-pack-size catalogs.
  totalStdQty: number
  totalExpQty: number
  // 2026-05-12 (v2): the Std / Exp cells now show ONLY the dollar
  // subtotal per class (the order/unit breakdown moved to a tooltip),
  // so the footer needs running sums of the per-class dollar subtotals.
  // Source: row.standardShipTotal / row.expeditedShipTotal — the raw
  // SUM(label_cost × qty / order_qty_total) FILTER (...) values from
  // the backend.
  totalStdShipping: number
  totalExpShipping: number
  // 2026-05-12: footer accumulators for the new revenue / avg-price
  // columns. totalRevenue sums the per-SKU revenue across visible
  // rows; avgPrice is computed FE-side from totalRevenue / totalQty
  // (we don't sum avg prices — that's mathematically meaningless).
  totalRevenue: number
  totalShipping: number
}

export const ANALYSIS_CHART_COLORS = ['#2a5bd7', '#16a34a', '#e07a00', '#c62828', '#7c3aed', '#0891b2', '#be185d', '#92400e']

export const ANALYSIS_SORT_LABELS: Record<AnalysisSortKey, string> = {
  name: 'Item Name',
  sku: 'SKU',
  client: 'Client',
  orders: 'Orders',
  pending: 'Pending',
  external: 'Ext. Shipped',
  qty: 'Total Qty',
  trend: 'Units Trend',
  // 2026-05-12 (v3): labels shortened from 'Std Orders' / 'Exp Orders'
  // because the cell body now shows UNITS (not order count) + per-unit
  // average shipping cost. Keeping the old label would be misleading
  // — readers would multiply "orders × per-unit" and get the wrong
  // number. Short labels + per-column tooltip explains the math.
  stdOrders: 'Std',
  expOrders: 'Exp',
  total: 'Total Shipping',
  revenue: 'Total Revenue',
  avgPrice: 'Avg Sell Price',
}

// ──────────────────────────────────────────────────────────────────
// Column layout: visibility + order. Persisted per-browser via
// localStorage so each operator can shape the table to fit their
// workflow (e.g. an inventory operator might hide Std/Exp Orders;
// a billing operator hides Pending/Ext.Shipped). The 'name' column
// is intentionally NOT toggleable — without it rows are unidentifiable.
// ──────────────────────────────────────────────────────────────────

export const DEFAULT_COLUMN_ORDER: AnalysisSortKey[] = [
  'name',
  'sku',
  'client',
  'orders',
  'pending',
  'external',
  'qty',
  'trend',
  'avgPrice',
  'revenue',
  'stdOrders',
  'expOrders',
  'total',
]

// Columns the operator cannot hide via the toggle UI. Without 'name'
// (which renders the thumbnail too) rows have no identity, so it's
// pinned visible. Drag-reorder still works on it.
export const REQUIRED_COLUMNS = new Set<AnalysisSortKey>(['name'])

export interface AnalysisColumnLayout {
  order: AnalysisSortKey[]
  hidden: AnalysisSortKey[]
}

const COLUMN_LAYOUT_STORAGE_KEY = 'analysis_column_layout'

const ALL_KEYS = new Set<AnalysisSortKey>(DEFAULT_COLUMN_ORDER)

function isKnownKey(value: unknown): value is AnalysisSortKey {
  return typeof value === 'string' && ALL_KEYS.has(value as AnalysisSortKey)
}

// Read + sanitize a persisted layout. Defensive against:
//   - JSON that's not an object
//   - unknown keys (e.g. a future-removed column still in storage)
//   - missing keys (e.g. a new column added since the layout was saved
//     — those get appended to the end so the operator sees them)
//   - duplicate entries (we de-dupe by key)
export function readStoredColumnLayout(): AnalysisColumnLayout {
  if (typeof window === 'undefined') {
    return { order: [...DEFAULT_COLUMN_ORDER], hidden: [] }
  }
  try {
    const raw = window.localStorage.getItem(COLUMN_LAYOUT_STORAGE_KEY)
    if (!raw) return { order: [...DEFAULT_COLUMN_ORDER], hidden: [] }
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      return { order: [...DEFAULT_COLUMN_ORDER], hidden: [] }
    }
    const rawOrder = Array.isArray(parsed.order) ? parsed.order : []
    const rawHidden = Array.isArray(parsed.hidden) ? parsed.hidden : []
    const seen = new Set<AnalysisSortKey>()
    const cleanOrder: AnalysisSortKey[] = []
    for (const k of rawOrder) {
      if (isKnownKey(k) && !seen.has(k)) {
        cleanOrder.push(k)
        seen.add(k)
      }
    }
    // Append any DEFAULT_COLUMN_ORDER keys missing from storage so a
    // freshly added column shows up by default for returning users.
    for (const k of DEFAULT_COLUMN_ORDER) {
      if (!seen.has(k)) {
        cleanOrder.push(k)
        seen.add(k)
      }
    }
    const cleanHidden: AnalysisSortKey[] = []
    const hiddenSeen = new Set<AnalysisSortKey>()
    for (const k of rawHidden) {
      if (isKnownKey(k) && !REQUIRED_COLUMNS.has(k) && !hiddenSeen.has(k)) {
        cleanHidden.push(k)
        hiddenSeen.add(k)
      }
    }
    return { order: cleanOrder, hidden: cleanHidden }
  } catch {
    return { order: [...DEFAULT_COLUMN_ORDER], hidden: [] }
  }
}

export function writeStoredColumnLayout(layout: AnalysisColumnLayout): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      COLUMN_LAYOUT_STORAGE_KEY,
      JSON.stringify({ order: layout.order, hidden: layout.hidden }),
    )
  } catch {
    // localStorage can throw in private-browsing / quota-exceeded modes.
    // Layout reverts to in-memory default on next mount; not fatal.
  }
}

// Trend score = (lastHalfAvg - firstHalfAvg) / max(jointMean, 1).
//
// Rationale: a SKU whose daily units grew 1→2 and one that grew 100→200
// should sort to the same trend strength — both doubled. Dividing the
// half-period delta by the joint mean (clamped ≥1 so 0-volume SKUs
// don't NaN) makes the score unit-free and bounded in roughly [-2, +2].
//
// The 5% deadband on `direction` keeps near-flat SKUs from flickering
// green/red on tiny noise — anything within ±5% of the joint mean is
// reported as 'flat' so the sparkline renders in muted grey.
//
// `series` is the aligned daily-units array returned by the analysis
// API (one entry per day in the selected range, zeros for quiet days).
export interface UnitsTrendResult {
  direction: 'up' | 'down' | 'flat'
  /** Normalized half-period delta, ≈ [-2, +2]. */
  strength: number
  firstAvg: number
  lastAvg: number
  total: number
}

const TREND_FLAT_DEADBAND = 0.05

export function computeUnitsTrend(series: number[] | null | undefined): UnitsTrendResult {
  if (!Array.isArray(series) || series.length < 2) {
    return { direction: 'flat', strength: 0, firstAvg: 0, lastAvg: 0, total: 0 }
  }

  const total = series.reduce((acc, value) => acc + (Number.isFinite(value) ? value : 0), 0)
  // Half-window: split the series in two. We slice from the start /
  // from the end so an odd-length series shares the middle sample
  // between halves (less brittle than dropping it).
  const half = Math.floor(series.length / 2)
  if (half === 0) {
    return { direction: 'flat', strength: 0, firstAvg: 0, lastAvg: 0, total }
  }
  const firstHalf = series.slice(0, half)
  const lastHalf = series.slice(series.length - half)
  const avg = (arr: number[]) =>
    arr.reduce((acc, value) => acc + (Number.isFinite(value) ? value : 0), 0) / Math.max(arr.length, 1)
  const firstAvg = avg(firstHalf)
  const lastAvg = avg(lastHalf)
  const jointMean = Math.max((firstAvg + lastAvg) / 2, 1)
  const strength = (lastAvg - firstAvg) / jointMean

  let direction: UnitsTrendResult['direction'] = 'flat'
  if (strength > TREND_FLAT_DEADBAND) direction = 'up'
  else if (strength < -TREND_FLAT_DEADBAND) direction = 'down'

  return { direction, strength, firstAvg, lastAvg, total }
}

export function formatAnalysisDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function getAnalysisPresetRange(days: number, now = new Date()) {
  const today = new Date(now)
  const to = formatAnalysisDate(today)
  if (days === 0) {
    return { from: '', to }
  }

  const fromDate = new Date(today)
  fromDate.setDate(fromDate.getDate() - days)
  return { from: formatAnalysisDate(fromDate), to }
}

export function getInitialAnalysisFilters(storage?: Pick<Storage, 'getItem'> | null, now = new Date()): AnalysisFiltersState {
  const fallback = {
    ...getAnalysisPresetRange(30, now),
    presetDays: 30,
  }

  if (!storage) return fallback

  const savedPreset = storage.getItem('analysis_preset_days')
  if (savedPreset !== null) {
    const days = Number.parseInt(savedPreset, 10)
    if (!Number.isNaN(days)) {
      return {
        ...getAnalysisPresetRange(days, now),
        presetDays: days,
      }
    }
  }

  const savedFrom = storage.getItem('analysis_from') ?? ''
  const savedTo = storage.getItem('analysis_to') ?? ''
  if (savedFrom || savedTo) {
    return {
      from: savedFrom || (savedTo ? '' : fallback.from),
      to: savedTo || fallback.to,
      presetDays: null,
    }
  }

  return fallback
}

export function getAnalysisSummaryText(skuCount: number, orderCount: number) {
  return `${skuCount} SKUs · ${orderCount.toLocaleString()} orders`
}

export function filterAnalysisRows(rows: AnalysisSkuDto[], search: string) {
  const query = search.trim().toLowerCase()
  if (!query) return rows
  return rows.filter((row) =>
    (row.sku || '').toLowerCase().includes(query)
    || (row.name || '').toLowerCase().includes(query),
  )
}

const NUMERIC_ANALYSIS_SORT_KEYS = new Set<AnalysisSortKey>([
  'orders',
  'pending',
  'external',
  'qty',
  'trend',
  'stdOrders',
  'expOrders',
  'total',
  'revenue',
  'avgPrice',
])

function toAnalysisNumber(value: unknown) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') {
    const normalized = value.replace(/[$,]/g, '').trim()
    if (!normalized) return 0
    const parsed = Number.parseFloat(normalized)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function getSortValue(row: AnalysisSkuDto, key: AnalysisSortKey) {
  switch (key) {
    case 'name':
      return (row.name || '').toLowerCase()
    case 'sku':
      return (row.sku || '').toLowerCase()
    case 'client':
      return (row.clientName || '').toLowerCase()
    case 'orders':
      return row.orders
    case 'pending':
      return row.pendingOrders
    case 'external':
      return row.externalOrders
    case 'qty':
      return row.qty
    case 'trend':
      // Sort by the same normalized strength score the cell displays.
      // SKUs with no series (no daily array yet) sort as flat (0).
      return computeUnitsTrend((row as { dailyQty?: number[] }).dailyQty ?? []).strength
    case 'stdOrders':
      return row.standardShipCount
    case 'expOrders':
      return row.expeditedShipCount
    case 'total':
      return row.totalShipping
    case 'revenue':
      return (row as { totalRevenue?: number }).totalRevenue ?? 0
    case 'avgPrice':
      return (row as { avgSellingPrice?: number }).avgSellingPrice ?? 0
  }
}

export function sortAnalysisRows(rows: AnalysisSkuDto[], sortKey: AnalysisSortKey, sortDir: AnalysisSortDir) {
  const direction = sortDir === 'asc' ? 1 : -1
  return [...rows].sort((left, right) => {
    const leftValue = getSortValue(left, sortKey)
    const rightValue = getSortValue(right, sortKey)

    if (NUMERIC_ANALYSIS_SORT_KEYS.has(sortKey)) {
      const diff = toAnalysisNumber(leftValue) - toAnalysisNumber(rightValue)
      if (diff !== 0) return diff * direction

      const leftName = `${left.name || ''}|${left.sku || ''}`.toLowerCase()
      const rightName = `${right.name || ''}|${right.sku || ''}`.toLowerCase()
      return leftName.localeCompare(rightName)
    }

    if (leftValue < rightValue) return -direction
    if (leftValue > rightValue) return direction
    return 0
  })
}

export function buildAnalysisTotals(rows: AnalysisSkuDto[]): AnalysisTotals {
  return rows.reduce<AnalysisTotals>((totals, row) => ({
    skuCount: totals.skuCount + 1,
    totalOrders: totals.totalOrders + toAnalysisNumber(row.orders),
    totalPending: totals.totalPending + toAnalysisNumber(row.pendingOrders),
    totalExternal: totals.totalExternal + toAnalysisNumber(row.externalOrders),
    totalQty: totals.totalQty + toAnalysisNumber(row.qty),
    totalStdCount: totals.totalStdCount + toAnalysisNumber(row.standardShipCount),
    totalExpCount: totals.totalExpCount + toAnalysisNumber(row.expeditedShipCount),
    // Per-class UNIT totals. The API ships these as standardShipQtyTotal
    // / expeditedShipQtyTotal (see v2-apiClient.ts) — populated by the
    // backend's std_qty_total / exp_qty_total SUM(qty) FILTER queries.
    totalStdQty:
      totals.totalStdQty
      + toAnalysisNumber((row as { standardShipQtyTotal?: number }).standardShipQtyTotal),
    totalExpQty:
      totals.totalExpQty
      + toAnalysisNumber((row as { expeditedShipQtyTotal?: number }).expeditedShipQtyTotal),
    totalStdShipping:
      totals.totalStdShipping
      + toAnalysisNumber((row as { standardShipTotal?: number }).standardShipTotal),
    totalExpShipping:
      totals.totalExpShipping
      + toAnalysisNumber((row as { expeditedShipTotal?: number }).expeditedShipTotal),
    totalShipping: totals.totalShipping + toAnalysisNumber(row.totalShipping),
    totalRevenue:
      totals.totalRevenue
      + toAnalysisNumber((row as { totalRevenue?: number }).totalRevenue),
  }), {
    skuCount: 0,
    totalOrders: 0,
    totalPending: 0,
    totalExternal: 0,
    totalQty: 0,
    totalStdCount: 0,
    totalExpCount: 0,
    totalStdQty: 0,
    totalExpQty: 0,
    totalStdShipping: 0,
    totalExpShipping: 0,
    totalShipping: 0,
    totalRevenue: 0,
  })
}

export function getAnalysisEmptyMessage(search: string) {
  return search.trim() ? 'No results matching your search' : 'No orders in this date range'
}

export function getAnalysisSortDirection(nextKey: AnalysisSortKey, currentKey: AnalysisSortKey, currentDir: AnalysisSortDir): AnalysisSortDir {
  if (nextKey === currentKey) {
    return currentDir === 'asc' ? 'desc' : 'asc'
  }

  return nextKey === 'name' || nextKey === 'sku' || nextKey === 'client' ? 'asc' : 'desc'
}

export function getChartSelectionRange(data: Pick<AnalysisDailySalesResponse, 'dates'>, dragStart: number, dragEnd: number, chartLeft: number, chartWidth: number) {
  if (!data.dates.length || chartWidth <= 0) return null

  const x1 = Math.min(dragStart, dragEnd)
  const x2 = Math.max(dragStart, dragEnd)
  if (x2 - x1 < 8) return null

  const maxIndex = Math.max(data.dates.length - 1, 1)
  const startIndex = Math.max(0, Math.round(((x1 - chartLeft) / chartWidth) * maxIndex))
  const endIndex = Math.min(data.dates.length - 1, Math.round(((x2 - chartLeft) / chartWidth) * maxIndex))

  return {
    from: data.dates[startIndex] ?? data.dates[0],
    to: data.dates[endIndex] ?? data.dates[data.dates.length - 1],
  }
}

export function getAnalysisChartMaxValue(data: AnalysisDailySalesResponse) {
  let maxValue = 1
  data.topSkus.forEach((sku) => {
    const rowMax = Math.max(...(data.series[sku.sku] || [0]))
    if (rowMax > maxValue) maxValue = rowMax
  })
  return maxValue
}

export function formatAnalysisMoney(amount: number | null | undefined) {
  if (!amount) return '—'
  return `$${amount.toFixed(2)}`
}
