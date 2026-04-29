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
  | 'stdOrders'
  | 'expOrders'
  | 'total'

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
  stdOrders: 'Std Orders',
  expOrders: 'Exp Orders',
  total: 'Total Shipping',
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
  'stdOrders',
  'expOrders',
  'total',
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
    case 'stdOrders':
      return row.standardShipCount
    case 'expOrders':
      return row.expeditedShipCount
    case 'total':
      return row.totalShipping
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
    totalShipping: totals.totalShipping + toAnalysisNumber(row.totalShipping),
  }), {
    skuCount: 0,
    totalOrders: 0,
    totalPending: 0,
    totalExternal: 0,
    totalQty: 0,
    totalStdCount: 0,
    totalExpCount: 0,
    totalShipping: 0,
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
