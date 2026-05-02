// @ts-nocheck
import type { OrderPicklistItemDto, OrderSummaryDto, OrdersDailyStatsDto } from '../../types/api'

export type TableColumnKey =
  | 'select'
  | 'date'
  | 'client'
  | 'orderNum'
  | 'customer'
  | 'itemname'
  | 'sku'
  | 'qty'
  | 'weight'
  | 'shipto'
  | 'carrier'
  | 'custcarrier'
  | 'total'
  | 'bestrate'
  | 'margin'
  | 'tracking'
  | 'labelcreated'
  | 'age'
  | 'test_carrierCode'
  | 'test_shippingProviderID'
  | 'test_clientID'
  | 'test_serviceCode'
  | 'test_bestRate'
  | 'test_orderLocal'
  | 'test_shippingAccount'

export interface TableColumnConfig {
  key: TableColumnKey
  label: string
  width: number
}

export interface ColumnPrefs {
  order?: string[]
  hidden?: string[]
  widths?: Record<string, number>
  version?: number
  views?: Partial<Record<'awaiting_shipment' | 'shipped' | 'cancelled', ColumnViewPrefs>>
}

export interface ColumnViewPrefs {
  order?: string[]
  hidden?: string[]
  widths?: Record<string, number>
}

export interface ResolvedColumnPrefs {
  orderedColumns: TableColumnConfig[]
  hiddenColumns: Set<TableColumnKey>
  widths: Record<TableColumnKey, number>
}

const DIAGNOSTIC_COLUMN_KEYS: TableColumnKey[] = [
  'test_carrierCode',
  'test_shippingProviderID',
  'test_clientID',
  'test_shippingAccount',
  'test_serviceCode',
  'test_bestRate',
  'test_orderLocal',
]

const COLUMN_MIN_WIDTHS: Partial<Record<TableColumnKey, number>> = {
  select: 34,
  date: 80,
  client: 90,
  orderNum: 85,
  customer: 120,
  itemname: 160,
  sku: 150,
  bestrate: 175,
  test_bestRate: 175,
}

export function getColumnMinWidth(key: TableColumnKey) {
  return COLUMN_MIN_WIDTHS[key] ?? 40
}

function normalizeColumnWidth(key: TableColumnKey, width: unknown, fallback: number) {
  const numericWidth = typeof width === 'number' && Number.isFinite(width) ? width : fallback
  return Math.max(getColumnMinWidth(key), numericWidth)
}

function shouldUseCanonicalColumnOrder(prefs?: ColumnPrefs | null) {
  const order = prefs?.order
  if (!Array.isArray(order) || order.length === 0) return true

  const hasDiagnostics = DIAGNOSTIC_COLUMN_KEYS.some((key) => order.includes(key))
  if (!hasDiagnostics) return true

  const labelCreatedIndex = order.indexOf('labelcreated')
  const carrierCodeIndex = order.indexOf('test_carrierCode')
  if (labelCreatedIndex !== -1 && carrierCodeIndex !== -1 && labelCreatedIndex < carrierCodeIndex) {
    return true
  }

  const acctIndex = order.indexOf('test_shippingAccount')
  const serviceIndex = order.indexOf('test_serviceCode')
  if (acctIndex !== -1 && serviceIndex !== -1 && acctIndex > serviceIndex) {
    return true
  }

  return false
}

function getColumnPrefsForStatus(
  prefs: ColumnPrefs | null | undefined,
  currentStatus: 'awaiting_shipment' | 'shipped' | 'cancelled',
): ColumnViewPrefs | null {
  return prefs?.views?.[currentStatus] ?? prefs ?? null
}

function hasLegacyColumnPrefs(prefs: ColumnPrefs | null | undefined) {
  return Boolean(prefs && (Array.isArray(prefs.order) || Array.isArray(prefs.hidden) || prefs.widths))
}

export interface PrintQueueEntryDto {
  queue_entry_id: string
  order_id: string
  order_number: string | null
  client_id: number
  label_url: string
  sku_group_id: string
  primary_sku: string | null
  item_description: string | null
  order_qty: number | null
  multi_sku_data?: unknown
  status: 'queued' | 'printed'
  print_count: number
  last_printed_at: string | null
  queued_at: string
}

export interface PrintQueueGroup {
  groupId: string
  label: string
  description: string
  perOrderQty: number
  totalQty: number
  orders: PrintQueueEntryDto[]
}

export interface DailyStripProgress {
  shipped: number
  pct: number
  barFill: number
  barColor: string
  needToShipColor: string
  upcomingColor: string
}

function getQueueEntryQty(entry: PrintQueueEntryDto): number {
  const qty = Number(entry.order_qty ?? 1)
  return Number.isFinite(qty) && qty > 0 ? qty : 1
}

export function resolveColumnPrefs(
  columns: TableColumnConfig[],
  currentStatus: 'awaiting_shipment' | 'shipped' | 'cancelled',
  prefs?: ColumnPrefs | null,
): ResolvedColumnPrefs {
  const statusPrefs = getColumnPrefsForStatus(prefs, currentStatus)
  const columnMap = new Map(columns.map((column) => [column.key, column]))
  const seen = new Set<TableColumnKey>()
  const orderedColumns: TableColumnConfig[] = []
  const savedOrder = shouldUseCanonicalColumnOrder(statusPrefs) ? [] : (statusPrefs?.order ?? [])

  for (const key of savedOrder) {
    if (!columnMap.has(key as TableColumnKey)) continue
    const typedKey = key as TableColumnKey
    if (seen.has(typedKey)) continue
    seen.add(typedKey)
    orderedColumns.push(columnMap.get(typedKey)!)
  }

  for (const column of columns) {
    if (seen.has(column.key)) continue
    seen.add(column.key)
    orderedColumns.push(column)
  }

  const widths = Object.fromEntries(
    columns.map((column) => {
      const savedWidth = statusPrefs?.widths?.[column.key]
      return [column.key, normalizeColumnWidth(column.key, savedWidth, column.width)]
    }),
  ) as Record<TableColumnKey, number>

  const hiddenColumns = new Set<TableColumnKey>()
  for (const key of statusPrefs?.hidden ?? []) {
    if (columnMap.has(key as TableColumnKey)) {
      hiddenColumns.add(key as TableColumnKey)
    }
  }

  if (currentStatus !== 'awaiting_shipment') hiddenColumns.add('age')

  return {
    orderedColumns,
    hiddenColumns,
    widths,
  }
}

export function buildColumnPrefs(columns: TableColumnConfig[], hiddenColumns: Set<TableColumnKey>, widths: Record<TableColumnKey, number>): ColumnPrefs {
  const normalizedWidths = Object.fromEntries(
    columns.map((column) => [
      column.key,
      normalizeColumnWidth(column.key, widths[column.key], column.width),
    ]),
  )

  return {
    order: columns.map((column) => column.key),
    hidden: [...hiddenColumns],
    widths: normalizedWidths,
  }
}

export function buildColumnPrefsForStatus(
  currentPrefs: ColumnPrefs | null | undefined,
  currentStatus: 'awaiting_shipment' | 'shipped' | 'cancelled',
  columns: TableColumnConfig[],
  hiddenColumns: Set<TableColumnKey>,
  widths: Record<TableColumnKey, number>,
): ColumnPrefs {
  const nextStatusPrefs = buildColumnPrefs(columns, hiddenColumns, widths)
  const views = {
    ...(currentPrefs?.views ?? {}),
  }

  if (hasLegacyColumnPrefs(currentPrefs) && !currentPrefs?.views) {
    views.awaiting_shipment = currentPrefs
    views.shipped = currentPrefs
    views.cancelled = currentPrefs
  }

  views[currentStatus] = nextStatusPrefs

  return {
    version: 2,
    views,
  }
}

export function buildDailyStripProgress(stats: OrdersDailyStatsDto): DailyStripProgress {
  const shipped = Math.max(0, stats.totalOrders - stats.needToShip)
  const pct = stats.totalOrders > 0 ? Math.round((shipped / stats.totalOrders) * 100) : 0

  return {
    shipped,
    pct,
    barFill: Math.min(100, pct),
    barColor: pct >= 100 ? '#16a34a' : pct >= 50 ? '#e07a00' : '#2a5bd7',
    needToShipColor: stats.needToShip > 0 ? '#e07a00' : 'var(--text3)',
    upcomingColor: stats.upcomingOrders > 0 ? '#2a5bd7' : 'var(--text3)',
  }
}

export function groupPrintQueueEntries(entries: PrintQueueEntryDto[]): PrintQueueGroup[] {
  const groups = new Map<string, PrintQueueGroup>()

  for (const entry of entries) {
    if (entry.status !== 'queued') continue

    const qty = getQueueEntryQty(entry)
    const groupKey = `${entry.sku_group_id}|qty:${qty}`
    const existing = groups.get(groupKey)
    if (existing) {
      existing.orders.push(entry)
      existing.totalQty += qty
      continue
    }

    groups.set(groupKey, {
      groupId: groupKey,
      label: entry.primary_sku || entry.sku_group_id,
      description: entry.item_description || '',
      perOrderQty: qty,
      totalQty: qty,
      orders: [entry],
    })
  }

  return [...groups.values()].sort((left, right) => {
    const labelCompare = left.label.localeCompare(right.label)
    if (labelCompare !== 0) return labelCompare
    const descriptionCompare = left.description.localeCompare(right.description)
    if (descriptionCompare !== 0) return descriptionCompare
    return left.perOrderQty - right.perOrderQty
  })
}

export function buildQueueAddPayload(order: OrderSummaryDto, labelUrl: string) {
  const items = Array.isArray(order.items) ? order.items as Array<Record<string, unknown>> : []
  const activeItems = items.filter((item) => !item.adjustment)
  const orderQty = activeItems.reduce((sum, item) => sum + toNumber(item.quantity, 1), 0)
  const primarySku = activeItems.length === 1 ? toStringValue(activeItems[0]?.sku) : toStringValue(activeItems[0]?.sku)
  const itemDescription = activeItems.length === 1 ? toStringValue(activeItems[0]?.name) : toStringValue(activeItems[0]?.name)
  const multiSkuData = activeItems.length > 1
    ? activeItems.map((item) => ({
        sku: toStringValue(item.sku),
        description: toStringValue(item.name),
        qty: toNumber(item.quantity, 1),
      }))
    : null

  return {
    order_id: String(order.orderId),
    order_number: order.orderNumber,
    client_id: order.clientId,
    label_url: labelUrl,
    sku_group_id: primarySku ? `SKU:${primarySku}` : `ORDER:${order.orderId}`,
    primary_sku: primarySku,
    item_description: itemDescription,
    order_qty: orderQty || 1,
    multi_sku_data: multiSkuData,
  }
}

export function buildPicklistPrintHtml(
  items: OrderPicklistItemDto[],
  options: {
    generatedAt: string
    dateLabel: string
    statusLabel: string
  },
) {
  const totalUnits = items.reduce((sum, item) => sum + item.totalQty, 0)
  const totalSkus = items.length

  const rows = items.map((item, index) => {
    const image = item.imageUrl
      ? `<img src="${escapeHtml(item.imageUrl)}" style="width:48px;height:48px;object-fit:cover;border-radius:5px;border:1px solid #e0e0e0" onerror="this.style.display='none'">`
      : `<div style="width:48px;height:48px;background:#f5f5f5;border-radius:5px;border:1px solid #e0e0e0;display:flex;align-items:center;justify-content:center;font-size:20px">📦</div>`

    return `<tr style="page-break-inside:avoid">
      <td style="font-size:11px;color:#888;text-align:center">${index + 1}</td>
      <td style="font-size:12px;font-weight:700;color:#333">${escapeHtml(item.clientName || '—')}</td>
      <td style="text-align:center">${image}</td>
      <td>
        <div style="font-weight:600;font-size:13px;color:#1a1a1a;margin-bottom:3px">${escapeHtml(item.name || '—')}</div>
        <div style="font-family:monospace;font-size:11px;color:#666;background:#f5f5f5;display:inline-block;padding:1px 6px;border-radius:3px">${escapeHtml(item.sku)}</div>
      </td>
      <td style="text-align:center">
        <span style="font-size:26px;font-weight:800;color:#1a1a1a">${item.totalQty}</span>
      </td>
      <td style="text-align:center">
        <div style="width:34px;height:34px;border:2px solid #ccc;border-radius:6px;margin:0 auto"></div>
      </td>
    </tr>`
  }).join('')

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
  <title>PrepShip Pick List — ${escapeHtml(options.generatedAt)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #fff; color: #1a1a1a; padding: 24px; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 3px solid #1a1a1a; }
    .header h1 { font-size: 22px; font-weight: 800; }
    .header .meta { font-size: 12px; color: #555; margin-top: 4px; }
    .stats { display: flex; gap: 24px; }
    .stat { text-align: right; }
    .stat .n { font-size: 28px; font-weight: 800; line-height: 1; }
    .stat .l { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: .5px; }
    table { width: 100%; border-collapse: collapse; }
    thead th { background: #1a1a1a; color: #fff; padding: 8px 10px; font-size: 10px; text-transform: uppercase; letter-spacing: .6px; font-weight: 700; }
    thead th:nth-child(1), thead th:nth-child(3), thead th:nth-child(5), thead th:nth-child(6) { text-align: center; }
    tbody tr:nth-child(even) td { background: #fafafa; }
    tbody tr:hover td { background: #f0f4ff; }
    td { padding: 10px; border-bottom: 1px solid #e8e8e8; vertical-align: middle; }
    @media print {
      @page { size: letter portrait; margin: 12mm; }
      body { padding: 0; }
      tbody tr:hover td { background: inherit; }
    }
  </style></head><body>
  <div class="header">
    <div>
      <h1>📦 PrepShip Pick List</h1>
      <div class="meta">Generated: ${escapeHtml(options.generatedAt)} &nbsp;·&nbsp; ${escapeHtml(options.dateLabel)} &nbsp;·&nbsp; Status: ${escapeHtml(options.statusLabel)}</div>
    </div>
    <div class="stats">
      <div class="stat"><div class="n">${totalSkus}</div><div class="l">SKUs</div></div>
      <div class="stat"><div class="n">${totalUnits}</div><div class="l">Total Units</div></div>
    </div>
  </div>
  <table>
    <thead><tr><th>#</th><th>Client</th><th>IMG</th><th>Item / SKU</th><th>Qty to Pick</th><th>✓ Done</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <script>window.onload = () => window.print();<\/script>
  </body></html>`
}

export function formatSyncPill(sync: {
  status: 'idle' | 'syncing' | 'done' | 'error'
  mode: 'idle' | 'incremental' | 'full'
  page: number
  lastSync: number | null
}) {
  if (sync.status === 'syncing') {
    return {
      className: 'sync-pill syncing',
      text: `${sync.mode === 'full' ? 'Full sync' : 'Syncing'}… (${sync.page || 0})`,
    }
  }

  if (sync.status === 'done') {
    const syncTime = sync.lastSync
      ? new Date(sync.lastSync).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : '—'
    return {
      className: 'sync-pill done',
      text: `Last sync ${syncTime}`,
    }
  }

  if (sync.status === 'error') {
    return {
      className: 'sync-pill error',
      text: 'Sync error',
    }
  }

  return {
    className: 'sync-pill',
    text: 'Last sync —',
  }
}

function toStringValue(value: unknown) {
  return typeof value === 'string' ? value : null
}

function toNumber(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
