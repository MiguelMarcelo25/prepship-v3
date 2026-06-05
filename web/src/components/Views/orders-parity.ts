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

// PS-077 (+ follow-up): the internal `bestrate` column — shown as "Best Rate" in
// Awaiting and relabeled "Selected Rate" in Shipped/Cancelled — has compact
// content ($9.91 / optional $8.62 / — / Ext. Label / Missing shipment sync), so
// it may shrink well below the old 175px floor in EVERY view. The min width here
// is just the RESIZE floor; the default DISPLAY width stays wide (TABLE_COLUMNS
// bestrate.width = 175), so the column looks unchanged until the operator drags
// it narrow (and that compact width is saved).
const BESTRATE_COMPACT_MIN_WIDTH = 88

export function getColumnMinWidth(
  key: TableColumnKey,
  // Retained for call-site symmetry / future per-status tuning; both Awaiting
  // "Best Rate" and Shipped/Cancelled "Selected Rate" now share the compact floor.
  _currentStatus?: 'awaiting_shipment' | 'shipped' | 'cancelled',
) {
  if (key === 'bestrate' || key === 'test_bestRate') return BESTRATE_COMPACT_MIN_WIDTH
  return COLUMN_MIN_WIDTHS[key] ?? 40
}

function normalizeColumnWidth(
  key: TableColumnKey,
  width: unknown,
  fallback: number,
  currentStatus?: 'awaiting_shipment' | 'shipped' | 'cancelled',
) {
  const numericWidth = typeof width === 'number' && Number.isFinite(width) ? width : fallback
  return Math.max(getColumnMinWidth(key, currentStatus), numericWidth)
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

export interface PrintQueueSkuLine {
  sku: string
  description: string
  qty: number
  // PS-070 — identity metadata so no-SKU eBay lines group by title and render a
  // safe pick label instead of "UNKNOWN SKU". Optional for back-compat with any
  // caller that builds a bare {sku,description,qty}.
  groupToken?: string
  kind?: 'sku' | 'title' | 'unresolved'
  cardTitle?: string
  skuLineText?: string
}

export interface PrintQueueGroup {
  groupId: string
  label: string
  description: string
  perOrderQty: number
  totalQty: number
  skuLines: PrintQueueSkuLine[]
  isMultiSku: boolean
  searchText: string
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

function normalizeSkuText(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || null
}

function normalizeSkuKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function getSkuLineQty(value: unknown): number {
  const qty = Number(value ?? 1)
  return Number.isFinite(qty) && qty > 0 ? Math.trunc(qty) : 1
}

// ── PS-070 — safe item identity (mirrors src/services/print-queue-identity.ts) ──
// Blank-SKU eBay lines are kept (keyed by title/id) instead of dropped, so they
// stay in multi-SKU combos, group by title, and render a pickable label rather
// than "UNKNOWN SKU". scripts/ps-070-ebay-nosku-identity-guard.ts asserts this
// matches the backend module token-for-token.
export const UNRESOLVED_QUEUE_ITEM_LABEL = 'UNRESOLVED EBAY ITEM'
export const NO_SKU_PICK_NOTE = 'no SKU — eBay item'
export const UNRESOLVED_QUEUE_ITEM_PICK_NOTE = 'UNRESOLVED EBAY ITEM — review order details'

function normalizeTitleKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function firstStableId(line: Record<string, unknown>): string {
  for (const key of ['itemId', 'variationId', 'lineItemId', 'legacyItemId', 'productId']) {
    const raw = line[key]
    const s = raw == null ? '' : String(raw).trim()
    if (s) return `${key}:${s}`
  }
  return ''
}

export function resolveQueueLineIdentity(line: unknown): PrintQueueSkuLine & { groupToken: string; kind: 'sku' | 'title' | 'unresolved'; cardTitle: string; skuLineText: string } {
  const obj = line && typeof line === 'object' ? line as Record<string, unknown> : {}
  const sku = String(obj.sku ?? '').trim()
  const title = String(obj.description ?? obj.name ?? obj.title ?? '').trim()
  if (sku) {
    return { sku, description: title, qty: 1, groupToken: `SKU:${normalizeSkuKey(sku)}`, kind: 'sku', cardTitle: title || sku, skuLineText: `sku: ${sku}` }
  }
  const id = firstStableId(obj)
  if (title) {
    const token = id ? `EBAY_ID:${id}|TITLE:${normalizeTitleKey(title)}` : `NOSKU:${normalizeTitleKey(title)}`
    return { sku: '', description: title, qty: 1, groupToken: token, kind: 'title', cardTitle: title, skuLineText: NO_SKU_PICK_NOTE }
  }
  if (id) {
    return { sku: '', description: '', qty: 1, groupToken: `EBAY_ID:${id}`, kind: 'title', cardTitle: `eBay item (${id})`, skuLineText: NO_SKU_PICK_NOTE }
  }
  return { sku: '', description: '', qty: 1, groupToken: 'UNRESOLVED', kind: 'unresolved', cardTitle: UNRESOLVED_QUEUE_ITEM_LABEL, skuLineText: UNRESOLVED_QUEUE_ITEM_PICK_NOTE }
}

export function collapseIdentityLines(lines: unknown): PrintQueueSkuLine[] {
  const rawLines = Array.isArray(lines) ? lines : []
  const collapsed = new Map<string, PrintQueueSkuLine>()
  for (const raw of rawLines) {
    const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const identity = resolveQueueLineIdentity(obj)
    const qty = getSkuLineQty(obj.qty ?? obj.quantity)
    const existing = collapsed.get(identity.groupToken)
    if (existing) {
      existing.qty += qty
      if (!existing.description && identity.description) existing.description = identity.description
    } else {
      collapsed.set(identity.groupToken, {
        sku: identity.sku,
        description: identity.description,
        qty,
        groupToken: identity.groupToken,
        kind: identity.kind,
        cardTitle: identity.cardTitle,
        skuLineText: identity.skuLineText,
      })
    }
  }
  return [...collapsed.values()].sort((left, right) => (left.groupToken ?? '').localeCompare(right.groupToken ?? ''))
}

export function getPrintQueueSkuLines(entry: Pick<PrintQueueEntryDto, 'multi_sku_data' | 'primary_sku' | 'item_description' | 'order_qty' | 'sku_group_id'>): PrintQueueSkuLine[] {
  const fromMulti = collapseIdentityLines(entry.multi_sku_data)
  if (fromMulti.length > 0) return fromMulti

  // Prefer the explicit primary_sku / item_description (a no-SKU eBay order has
  // primary_sku='' but item_description=<title>, which resolves to a NOSKU:title
  // identity). Only fall back to the legacy `SKU:<sku>` group-id parse for old
  // rows that have neither — and never treat a `SKU:NOSKU:...` combo wrapper as
  // a real sku.
  const primarySku = normalizeSkuText(entry.primary_sku)
  const description = normalizeSkuText(entry.item_description)
  if (primarySku || description) {
    return collapseIdentityLines([{
      sku: primarySku ?? '',
      description: description ?? '',
      qty: getQueueEntryQty(entry as PrintQueueEntryDto),
    }])
  }

  const groupId = String(entry.sku_group_id ?? '')
  const legacySku = groupId.startsWith('SKU:') && !groupId.startsWith('SKU:NOSKU:') && !groupId.startsWith('SKU:EBAY_ID:')
    ? normalizeSkuText(groupId.slice(4))
    : null
  if (legacySku) {
    return collapseIdentityLines([{ sku: legacySku, description: '', qty: getQueueEntryQty(entry as PrintQueueEntryDto) }])
  }
  return []
}

export function buildPrintQueueSkuComboKey(lines: PrintQueueSkuLine[]): string {
  return lines
    .map((line) => `${line.groupToken ?? `SKU:${normalizeSkuKey(line.sku)}`}:${getSkuLineQty(line.qty)}`)
    .sort((left, right) => left.localeCompare(right))
    .join('|')
}

function buildPrintQueueSearchText(lines: PrintQueueSkuLine[], entry: PrintQueueEntryDto): string {
  return [
    entry.order_number,
    entry.order_id,
    entry.primary_sku,
    entry.sku_group_id,
    entry.item_description,
    ...lines.flatMap((line) => [line.sku, line.description, String(line.qty)]),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
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
      return [column.key, normalizeColumnWidth(column.key, savedWidth, column.width, currentStatus)]
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

export function buildColumnPrefs(
  columns: TableColumnConfig[],
  hiddenColumns: Set<TableColumnKey>,
  widths: Record<TableColumnKey, number>,
  currentStatus?: 'awaiting_shipment' | 'shipped' | 'cancelled',
): ColumnPrefs {
  const normalizedWidths = Object.fromEntries(
    columns.map((column) => [
      column.key,
      normalizeColumnWidth(column.key, widths[column.key], column.width, currentStatus),
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
  const nextStatusPrefs = buildColumnPrefs(columns, hiddenColumns, widths, currentStatus)
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

  // Color palette per operator request 2026-05-09: every blue/green
  // accent in the daily strip should be #03A9F4 (Material Light Blue
  // 500) instead of the previous emerald/indigo mix. Orange (warn)
  // is preserved for the in-progress 50–99% state — that one is
  // semantically meaningful ("running behind") and the operator only
  // asked to drop blue and green, not warn-orange.
  const BRAND_BLUE = '#03A9F4'
  return {
    shipped,
    pct,
    barFill: Math.min(100, pct),
    // 100% complete → brand blue (was emerald). 50–99% → orange (warn,
    // unchanged). <50% → brand blue (was indigo).
    barColor: pct >= 100 ? BRAND_BLUE : pct >= 50 ? '#e07a00' : BRAND_BLUE,
    needToShipColor: stats.needToShip > 0 ? '#e07a00' : 'var(--text3)',
    upcomingColor: stats.upcomingOrders > 0 ? BRAND_BLUE : 'var(--text3)',
  }
}

export function groupPrintQueueEntries(entries: PrintQueueEntryDto[]): PrintQueueGroup[] {
  const groups = new Map<string, PrintQueueGroup>()

  for (const entry of entries) {
    if (entry.status !== 'queued') continue

    const qty = getQueueEntryQty(entry)
    const skuLines = getPrintQueueSkuLines(entry)
    const comboKey = buildPrintQueueSkuComboKey(skuLines)
    const isMultiSku = skuLines.length > 1
    const groupIdentity = comboKey
      ? `${isMultiSku ? 'COMBO' : 'SKU'}:${comboKey}`
      : entry.sku_group_id
    const groupKey = `${groupIdentity}|qty:${qty}`
    const existing = groups.get(groupKey)
    if (existing) {
      existing.orders.push(entry)
      existing.totalQty += qty
      existing.searchText = `${existing.searchText} ${buildPrintQueueSearchText(skuLines, entry)}`.trim()
      continue
    }

    const primaryLine = skuLines[0]
    groups.set(groupKey, {
      groupId: groupKey,
      // PS-070 — for no-SKU lines primaryLine.sku is '', so fall through to the
      // product title (cardTitle/description) instead of showing the raw
      // sku_group_id; SKU orders still label by their SKU as before.
      label: isMultiSku ? 'MULTI-SKU' : (primaryLine?.sku || primaryLine?.cardTitle || primaryLine?.description || entry.primary_sku || entry.item_description || entry.sku_group_id),
      description: isMultiSku ? skuLines.map((line) => `${line.sku || line.cardTitle || line.description} x${line.qty}`).join(' + ') : (primaryLine?.cardTitle || primaryLine?.description || entry.item_description || ''),
      perOrderQty: qty,
      totalQty: qty,
      skuLines,
      isMultiSku,
      searchText: buildPrintQueueSearchText(skuLines, entry),
      orders: [entry],
    })
  }

  // Sort the orders WITHIN each group ascending by order number (natural sort,
  // so 1231 < 1239 < 1247 and non-numeric ids like 18-14712-00854 still order
  // sensibly). This drives both the displayed list and the order the labels are
  // sent to print (Print Group sends group.orders.map(queue_entry_id)).
  for (const group of groups.values()) {
    group.orders.sort((a, b) =>
      String(a.order_number ?? '').localeCompare(String(b.order_number ?? ''), undefined, {
        numeric: true,
        sensitivity: 'base',
      }),
    )
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
  // PS-070 — collapseIdentityLines KEEPS no-SKU eBay lines (keyed by title/id)
  // instead of dropping them, so multi-SKU combos stay complete and a no-SKU
  // order still queues with a real pick identity + title.
  const skuLines = collapseIdentityLines(activeItems)
  const orderQty = skuLines.reduce((sum, item) => sum + item.qty, 0)
  const primaryLine = skuLines[0]
  const primarySku = primaryLine?.sku || toStringValue(activeItems[0]?.sku) || ''
  const itemDescription = primaryLine?.cardTitle || primaryLine?.description || toStringValue(activeItems[0]?.name)
  const comboKey = buildPrintQueueSkuComboKey(skuLines)
  // Persist a stable, minimal {sku, description, qty} shape; the backend
  // re-resolves identity from it. Keep no-SKU lines (sku may be '').
  const multiSkuData = skuLines.length > 1
    ? skuLines.map((line) => ({ sku: line.sku, description: line.description, qty: line.qty }))
    : null

  return {
    order_id: String(order.orderId),
    order_number: order.orderNumber,
    client_id: order.clientId,
    label_url: labelUrl,
    sku_group_id: comboKey
      ? skuLines.length > 1 ? `COMBO:${comboKey}` : `SKU:${comboKey}`
      : `ORDER:${order.orderId}`,
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
  ratePrefetchRunning?: boolean
  ratePrefetchJob?: {
    total?: number
    processed?: number
    updated?: number
    status?: string
  } | null
}) {
  if (sync.status === 'syncing') {
    return {
      className: 'sync-pill syncing',
      text: `${sync.mode === 'full' ? 'Full sync' : 'Syncing'}… (${sync.page || 0})`,
    }
  }

  if (sync.ratePrefetchRunning || sync.ratePrefetchJob?.status === 'running') {
    const total = Number(sync.ratePrefetchJob?.total ?? 0)
    const processed = Number(sync.ratePrefetchJob?.processed ?? 0)
    const updated = Number(sync.ratePrefetchJob?.updated ?? 0)
    const progress = total > 0 ? `${processed}/${total}` : 'starting'
    return {
      className: 'sync-pill syncing',
      text: updated > 0
        ? `Best rates ${progress} - ${updated} updated`
        : `Best rates ${progress}`,
    }
  }

  if (sync.status === 'done') {
    // Render in California time (DST-aware) with explicit "CA" label,
    // per boss directive (2026-05-07): all operator-facing times are
    // CA time. lastSync is a numeric ms-since-epoch from Date.now()
    // — true UTC, so we use formatCaTimeOnly (the CA-flavored helper)
    // not formatNaivePtTimeOnly (which is for naive-stamped-Z fields).
    const syncTime = sync.lastSync
      ? `${new Intl.DateTimeFormat('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
          timeZone: 'America/Los_Angeles',
        }).format(new Date(sync.lastSync))} CA`
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

// ── PS-071 — bounded/actionable Awaiting-Shipment rate cell state ──────────────
// The Carrier / Shipping Account / Best Rate / Ship Margin cells used to render
// an infinite spinner whenever an awaiting order had dims+weight but no
// displayable best rate — so if carrier accounts hadn't loaded, auto-rating was
// skipped, or a rate genuinely came back empty, the cell spun forever and the
// operator had to open Browse Rates to unstick it. This pure classifier gives
// every cell a TERMINAL, actionable state instead. Unit-tested in
// scripts/ps-071-rate-cell-state-guard.ts.
export type AwaitingRateCellState =
  | 'ready' // a displayable best rate exists -> render the rate
  | 'add-dims' // not rateable yet: missing dims/weight
  | 'error' // PS-075: passive rating finished with an ERROR for this request key
  | 'unavailable' // auto-rating resolved for this request with no rate -> Retry/Browse
  | 'loading-carriers' // carrier accounts still loading (bounded)
  | 'no-carrier-account' // accounts loaded but none available -> actionable
  | 'deferred' // rateable, but not currently in the visible live auto-rating slice
  | 'calculating' // a stale saved rate is being refreshed (bounded spinner)
  | 'pending' // rate request queued / in flight (bounded spinner)

export function classifyAwaitingRateCellState(input: {
  hasDims: boolean
  hasWeight: boolean
  hasDisplayableBestRate: boolean
  isCalculatingBestRate: boolean
  resolvedNoRate: boolean
  /** PS-075: passive rating resolved for THIS request key with an error. */
  resolvedError?: boolean
  hasCarrierContext: boolean
  accountsLoading: boolean
  isAutoRatingActive?: boolean
}): AwaitingRateCellState {
  if (input.hasDisplayableBestRate) return 'ready'
  if (!input.hasDims || !input.hasWeight) return 'add-dims'
  // A resolved error/no-rate is TERMINAL — never a spinner. Error is checked
  // first so a repeatedly-failing passive fetch shows "rate error", not an
  // endless 'pending' spinner.
  if (input.resolvedError) return 'error'
  if (input.resolvedNoRate) return 'unavailable'
  if (!input.hasCarrierContext) {
    return input.accountsLoading ? 'loading-carriers' : 'no-carrier-account'
  }
  if (input.isAutoRatingActive === false) return 'deferred'
  if (input.isCalculatingBestRate) return 'calculating'
  return 'pending'
}

export type AwaitingBestRateWorkflowInput = {
  bestRateState?: string | null
  allowedActions?: {
    canUseSavedRate?: boolean | null
    requiresRerate?: boolean | null
    canCreateLabel?: boolean | null
  } | null
} | null

export type AwaitingRateCellStateInput = Parameters<typeof classifyAwaitingRateCellState>[0]

export function classifyAwaitingRateCellStateWithWorkflow(
  workflow: AwaitingBestRateWorkflowInput,
  fallbackInput: AwaitingRateCellStateInput,
): AwaitingRateCellState {
  if (!workflow?.bestRateState) return classifyAwaitingRateCellState(fallbackInput)
  switch (workflow.bestRateState) {
    case 'fresh':
      return 'ready'
    case 'partial_carrier_failure':
    case 'blocked':
      return 'error'
    case 'missing':
      return 'unavailable'
    case 'stale':
    case 'mismatched_request':
      return fallbackInput.hasDims && fallbackInput.hasWeight
        ? fallbackInput.isAutoRatingActive === false
          ? 'deferred'
          : 'calculating'
        : 'add-dims'
    case 'unknown':
    default:
      return classifyAwaitingRateCellState(fallbackInput)
  }
}

/** States that show a (bounded) spinner vs. a terminal/actionable label.
 * 'deferred' now spins too: passive auto-rating drains the FULL visible queue,
 * so a deferred row is simply awaiting its turn and is guaranteed to resolve —
 * it shows a loading spinner instead of a parked "—". */
export function awaitingRateCellIsSpinner(state: AwaitingRateCellState): boolean {
  return state === 'calculating' || state === 'pending' || state === 'deferred'
}

/** A resolved passive auto-rate entry for one order row, keyed by request fingerprint. */
export type AutoBestRateEntry = {
  key: string
  rate: Record<string, unknown> | null
  error?: string
  pending?: boolean
}

/**
 * PS-081 — reduce a SETTLED passive auto-rate fetch (success, no-rate, or error)
 * into (a) the row entry to record and (b) whether the open panel preview may
 * also be updated.
 *
 * The row entry is ALWAYS produced — even when the triggering effect run was
 * superseded (`cancelled`). This is the fix for the infinite-spinner deadlock:
 * the passive effect re-runs whenever an order is selected (its detail loads),
 * which cancelled the in-flight fetch; the old code then skipped the entry write
 * (`if (!cancelled)`) while clearing the watchdog and leaving the request key in
 * `requestedRef`, stranding the row on `calculating` forever. Always recording
 * the keyed entry guarantees the cell resolves to ready / unavailable / error.
 *
 * Safety (PS-078): the entry is keyed by the EXACT request fingerprint. The row
 * only treats it as displayable when that key matches the CURRENT request, so a
 * superseded/stale entry can never be presented as the authoritative rate or
 * widen label authority. Only the PANEL preview side effects are gated on
 * cancellation, so a superseded run can't clobber the panel for an order the
 * operator has since switched away from (and an error never previews a rate).
 */
export function planSettledAutoRate(input: {
  requestKey: string
  rate: Record<string, unknown> | null
  error?: string | null
  cancelled: boolean
  isPanelOrder: boolean
}): { entry: AutoBestRateEntry; applyPanelPreview: boolean } {
  const entry: AutoBestRateEntry = input.error
    ? { key: input.requestKey, rate: null, error: input.error }
    : { key: input.requestKey, rate: input.rate }
  const applyPanelPreview = !input.cancelled && input.isPanelOrder && !input.error
  return { entry, applyPanelPreview }
}

/**
 * PS-082 — decide how clicking Browse Rates reconciles the Awaiting table's
 * Best Rate (and the selected service) to the LIVE best rate.
 *
 * Operator behaviour: opening Browse Rates re-quotes live; if the live best
 * differs from the table's cached best, the table adopts the live best (Best
 * Rate column + selected ship account/service). Equal -> nothing changes.
 *
 * Returns:
 *  - shouldUpdate: persist the live best + change the selection (only when the
 *    live best is a usable rate AND differs from the cached best by >= 1 cent).
 *  - entry: the row entry to record (keyed by the EXACT request fingerprint), so
 *    the table shows the verified-current rate even when it matched. null when
 *    there is no usable live rate.
 *  - selection: the ship account/service to select, or null when the live rate
 *    lacks a provider/service.
 *
 * Safety (PS-078): the caller re-quotes with the table's exact request params
 * before calling this, and the entry is keyed by that fingerprint — so the
 * adopted rate is always the live best for the conditions the label will use.
 * Sub-cent float noise is ignored so carrier rounding can't churn the row.
 */
export function planBrowseRateReconcile(input: {
  requestKey: string
  liveBest: Record<string, unknown> | null
  liveBestAmount: number | null
  currentBestAmount: number | null
  providerAccountId: number | null
  serviceCode: string | null
}): {
  shouldUpdate: boolean
  entry: AutoBestRateEntry | null
  selection: { shipAccountId: string; serviceCode: string } | null
} {
  if (!input.liveBest || input.liveBestAmount == null || input.liveBestAmount <= 0) {
    return { shouldUpdate: false, entry: null, selection: null }
  }
  const cents = (value: number) => Math.round(value * 100)
  const shouldUpdate =
    input.currentBestAmount == null ||
    input.currentBestAmount <= 0 ||
    cents(input.liveBestAmount) !== cents(input.currentBestAmount)
  const selection =
    input.providerAccountId != null && input.serviceCode
      ? { shipAccountId: String(input.providerAccountId), serviceCode: input.serviceCode }
      : null
  return { shouldUpdate, entry: { key: input.requestKey, rate: input.liveBest }, selection }
}

export type BatchRecalculateScope = 'selected' | 'filtered'

export type BatchRecalculateRowStatus =
  | 'pending'
  | 'running'
  | 'updated'
  | 'cleared'
  | 'blocked'
  | 'timed-out'
  | 'skipped'

export type BatchRecalculateRowState = {
  status: BatchRecalculateRowStatus
  message?: string | null
}

export function batchRecalculateStatusIsTerminal(status: BatchRecalculateRowStatus): boolean {
  return status === 'updated' ||
    status === 'cleared' ||
    status === 'blocked' ||
    status === 'timed-out' ||
    status === 'skipped'
}

export function buildBatchRecalculateProgress(rows: Record<number, BatchRecalculateRowState>) {
  const values = Object.values(rows)
  const total = values.length
  const completed = values.filter((row) => batchRecalculateStatusIsTerminal(row.status)).length
  const updated = values.filter((row) => row.status === 'updated').length
  const cleared = values.filter((row) => row.status === 'cleared').length
  const blocked = values.filter((row) => row.status === 'blocked').length
  const timedOut = values.filter((row) => row.status === 'timed-out').length
  const skipped = values.filter((row) => row.status === 'skipped').length
  const running = values.filter((row) => row.status === 'running').length
  const pending = values.filter((row) => row.status === 'pending').length
  return {
    total,
    completed,
    percent: total > 0 ? Math.round((completed / total) * 100) : 0,
    updated,
    cleared,
    blocked,
    timedOut,
    skipped,
    running,
    pending,
  }
}

export function canRetryBatchRecalculateRow(row: Pick<BatchRecalculateRowState, 'status'>): boolean {
  return row.status === 'timed-out' || row.status === 'blocked' || row.status === 'cleared'
}

export function selectBatchRecalculateOrderIds(input: {
  currentStatus?: string | null
  scope: BatchRecalculateScope
  orders: Array<{ orderId: number; orderStatus?: string | null }>
  selectedOrderIds: number[]
  visibleOrderIds: number[]
  matchingOrderIds?: number[]
}): { orderIds: number[]; skippedImmutable: number; blockedReason?: string } {
  if (input.currentStatus !== 'awaiting_shipment') {
    return {
      orderIds: [],
      skippedImmutable: 0,
      blockedReason: 'Batch Recalculate is only available in Awaiting Shipment.',
    }
  }

  const orderById = new Map(input.orders.map((order) => [order.orderId, order]))
  const sourceIds =
    input.scope === 'selected'
      ? input.selectedOrderIds
      : input.matchingOrderIds ?? input.visibleOrderIds
  const seen = new Set<number>()
  const orderIds: number[] = []
  let skippedImmutable = 0

  for (const orderId of sourceIds) {
    if (seen.has(orderId)) continue
    seen.add(orderId)
    const order = orderById.get(orderId)
    if (!order) continue
    if (order.orderStatus !== 'awaiting_shipment') {
      skippedImmutable += 1
      continue
    }
    orderIds.push(orderId)
  }

  return { orderIds, skippedImmutable }
}

// ─── Send-to-Queue routing (direct carriers vs ShipStation) ─────────────────
// The Render queue job's label creator (createLabelV2) is ShipStation-only —
// it sends `se-<providerId>` to ShipStation, which rejects a direct carrier's
// synthetic id. So a direct-carrier order that still needs a label must be
// routed to the Vercel /carriers/labels path (buy the label there, then add the
// created label to the queue). Everything else stays on the backend create/
// recover job. This is the pure decision the queue action consumes so it can be
// unit-tested without buying real postage.
export type StrictBestRateCarrierStatus = {
  carrierId?: string | null
  carrierName?: string | null
  status?: string | null
  rateCount?: number | null
  error?: string | null
}

export type StrictBestRateRecalculateDecision =
  | {
      action: 'apply'
      entry: AutoBestRateEntry
      selectedPid: number
      serviceCode: string
      rate: Record<string, unknown>
    }
  | {
      action: 'clear'
      entry: AutoBestRateEntry
      message: string
    }
  | {
      action: 'blocked'
      entry: AutoBestRateEntry
      message: string
    }

function strictCarrierStatusLabel(status: StrictBestRateCarrierStatus): string {
  return String(status.carrierName ?? status.carrierId ?? 'Carrier').trim() || 'Carrier'
}

/**
 * Strict Recalculate decision:
 * - every in-scope carrier must be live or a clean no-service unavailable
 * - cached/loading/error/unknown statuses block the update
 * - clean no-rate responses clear saved best rate so stale rates never survive
 */
export function planStrictBestRateRecalculate(input: {
  requestKey: string
  liveBest: Record<string, unknown> | null
  liveBestAmount: number | null
  providerAccountId: number | null
  serviceCode: string | null
  carrierStatuses: StrictBestRateCarrierStatus[]
}): StrictBestRateRecalculateDecision {
  if (!Array.isArray(input.carrierStatuses) || input.carrierStatuses.length === 0) {
    const message = 'Recalculate could not confirm carrier completion. Try again.'
    return { action: 'blocked', entry: { key: input.requestKey, rate: null, error: message }, message }
  }

  const blockedStatus = input.carrierStatuses.find((carrier) => {
    const status = String(carrier.status ?? '').toLowerCase()
    return status !== 'live' && status !== 'unavailable'
  })
  if (blockedStatus) {
    const status = String(blockedStatus.status ?? 'unknown').toLowerCase()
    const message = `${strictCarrierStatusLabel(blockedStatus)} did not complete live recalculation (${status}). No rate was updated.`
    return { action: 'blocked', entry: { key: input.requestKey, rate: null, error: message }, message }
  }

  if (!input.liveBest || input.liveBestAmount == null || input.liveBestAmount <= 0) {
    const message = 'No live rates were returned for this shipment.'
    return { action: 'clear', entry: { key: input.requestKey, rate: null }, message }
  }

  if (input.providerAccountId == null || !input.serviceCode) {
    const message = 'Live best rate is missing account or service identity. No rate was updated.'
    return { action: 'blocked', entry: { key: input.requestKey, rate: null, error: message }, message }
  }

  return {
    action: 'apply',
    entry: { key: input.requestKey, rate: input.liveBest },
    selectedPid: input.providerAccountId,
    serviceCode: input.serviceCode,
    rate: input.liveBest,
  }
}

export type QueueOrderRoute = 'direct-create' | 'backend'

export function classifyQueueOrderRoute(
  input: {
    /** The order already has a queueable (non-[object Object]) label URL. */
    hasQueueableLabel: boolean
    /** Test-client order — must never buy real postage; backend forces a mock. */
    isTest: boolean
    /** Selected/best rate resolves to a direct carrier_accounts synthetic id. */
    isDirectCarrier: boolean
  },
  options: { existingLabelOnly?: boolean; batchTestMode?: boolean } = {},
): QueueOrderRoute {
  // Never create a label in these cases — defer to the backend job:
  if (options.existingLabelOnly) return 'backend' // caller only wants existing labels queued
  if (options.batchTestMode) return 'backend' // test run → backend mock, no real postage
  if (input.isTest) return 'backend' // test-client order → backend mock
  if (input.hasQueueableLabel) return 'backend' // already bought → backend queues it as-is
  // A direct-carrier order that still needs a label is the ONLY case the backend
  // can't handle. Buy it via the Vercel direct path, then queue.
  if (input.isDirectCarrier) return 'direct-create'
  return 'backend' // ShipStation provider → backend createLabelV2
}
