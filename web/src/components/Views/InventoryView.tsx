// @ts-nocheck
import { lazy, Suspense, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Boxes,
  Layers,
  PackagePlus,
  AlertTriangle,
  FolderTree,
  History as HistoryIcon,
  Download,
  Pencil,
  Plus,
  RefreshCw,
  Ruler,
  CheckCircle2,
  ClipboardList,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import { apiClient, ApiError } from '../../api/client'
import {
  ConfirmActiveToggleDialog,
  type ConfirmActiveTogglePending,
} from '../ConfirmActiveToggleDialog'
import { api } from '../../lib/api'
import { ToastContext } from '../../contexts/ToastContext'
import { useInitStores } from '../../hooks'
import { SortableHeader, nextSortState, sortRows } from '../SortableTable'
import type {
  ClientDto,
  CreateParentSkuResult,
  InventoryAlertDto,
  InventoryItemDto,
  InventoryLedgerEntryDto,
  InventorySkuOrdersDto,
  PackageDto,
  ParentSkuDto,
  UpdateClientInput,
  UpdateInventoryItemInput,
} from '../../types/api'
import {
  applyReceiveSkuInput,
  buildBulkDimensionUpdates,
  buildInventoryLedgerQuery,
  buildReceiveItems,
  createReceiveDraftRow,
  filterInventoryRows,
  getInventoryCuFt,
  getInventoryDateRangePreset,
  getReceiveRowHints,
  groupInventoryRowsByClient,
  type InventoryTab,
  type ReceiveDraftRow,
  type ReceiveSkuLookup,
} from './inventory-parity'
import { ColumnResizeHandle } from './ColumnResizeHandle'
import { Table, type TableColumn } from '../ui/Table'
import { AnalysisPagination } from './AnalysisPagination'
// 2026-05-15: Receive tab SKU picker upgraded from native HTML
// <datalist> (which Chrome renders as an unstyleable, unfilterable
// 300-row scroll list) to a real autosuggest combobox. See the
// component file header for the full rationale.
import Autosuggest, { type AutosuggestOption } from '../Autosuggest'
import './InventoryView.css'

const OrderDetailDrawer = lazy(() => import('../OrderDetailDrawer'))

// 2026-05-14: per-tab accent palette for the new Settings-style tab
// rail + section header. Lifted from SettingsView so the two pages
// stay visually consistent. Each tab claims its own color identity
// instead of all five tabs reading as one undifferentiated strip:
//   • Stock Levels  → brand-blue   (default operational state)
//   • Receive       → emerald      (incoming / positive movement)
//   • Alerts        → amber        (warning state)
//   • Parent SKUs   → violet       (taxonomy / structure)
//   • History       → rose         (audit trail / past)
// The classnames here mirror SettingsView's ACCENT_* constants
// exactly — if the Settings palette ever changes, mirror that change
// here. (Could be hoisted to a shared module later, but inline for
// now keeps each view self-contained.)
type InventoryAccentTone = 'brand' | 'emerald' | 'amber' | 'rose' | 'violet'
type InventoryRouteTab = 'stock' | 'receive' | 'alerts' | 'parents' | 'history'

const INVENTORY_ACCENT_GRADIENT: Record<InventoryAccentTone, string> = {
  brand: 'from-brand to-indigo-600',
  emerald: 'from-emerald-500 to-emerald-600',
  amber: 'from-amber-500 to-amber-600',
  rose: 'from-rose-500 to-rose-600',
  violet: 'from-violet-500 to-violet-600',
}

const INVENTORY_ACCENT_ICON_BG: Record<InventoryAccentTone, string> = {
  brand: 'from-brand/15 to-brand/5 ring-brand/30',
  emerald: 'from-emerald-500/15 to-emerald-500/5 ring-emerald-500/30',
  amber: 'from-amber-500/15 to-amber-500/5 ring-amber-500/30',
  rose: 'from-rose-500/15 to-rose-500/5 ring-rose-500/30',
  violet: 'from-violet-500/15 to-violet-500/5 ring-violet-500/30',
}

const INVENTORY_ACCENT_ICON_COLOR: Record<InventoryAccentTone, string> = {
  brand: 'text-brand',
  emerald: 'text-emerald-600',
  amber: 'text-amber-600',
  rose: 'text-rose-600',
  violet: 'text-violet-600',
}

// Tab metadata array — paired with the existing `activeTab` state
// machine. Each entry carries everything the rail + section header
// need to render: id (matches existing setActiveTab values), short
// label for the rail pill, full label for the section header, a
// one-line description for the section subtitle, an icon, and the
// accent tone. Order here is the order tabs appear in the rail.
const INVENTORY_TAB_META: Array<{
  id: 'stock' | 'receive' | 'alerts' | 'parents' | 'history'
  short: string
  label: string
  description: string
  icon: LucideIcon
  tone: InventoryAccentTone
}> = [
  {
    id: 'stock',
    short: 'Stock Levels',
    label: 'Stock Levels',
    description:
      'Track on-hand quantity per SKU per client. Adjust min-stock thresholds, edit weights and dimensions, and import new SKUs from existing orders.',
    icon: Layers,
    tone: 'brand',
  },
  {
    id: 'receive',
    short: 'Receive',
    label: 'Receive Inventory',
    description:
      'Log incoming inventory. Pick a client, list the SKUs and quantities received, then post the batch — quantities flow into Stock Levels and a History entry is recorded automatically.',
    icon: PackagePlus,
    tone: 'emerald',
  },
  {
    id: 'alerts',
    short: 'Alerts',
    label: 'Low / Out-of-Stock Alerts',
    description:
      'SKUs at or below their minimum stock threshold. Click any row to jump to it in Stock Levels with the Low/Out filter applied.',
    icon: AlertTriangle,
    tone: 'amber',
  },
  {
    id: 'parents',
    short: 'Parent SKUs',
    label: 'Parent SKUs',
    description:
      'Group child SKUs into parent units (case packs, bundles, kits). Receiving a parent updates every child by its base-unit quantity in one transaction.',
    icon: FolderTree,
    tone: 'violet',
  },
  {
    id: 'history',
    short: 'History',
    label: 'Inventory History',
    description:
      'Audit trail of every inventory adjustment — receives, returns, damage write-offs, and manual edits. Filter by client, type, and date range.',
    icon: HistoryIcon,
    tone: 'rose',
  },
]

// Pagination page-size options — operator-requested 2026-05-12.
// 10 / 20 / 50 / 100 / 200. Default 50 balances "see enough at a
// glance" with "page doesn't take forever to render on slower
// machines." Persisted per-browser so each operator's preferred
// density sticks across reloads.
const INVENTORY_PAGE_SIZE_OPTIONS = [10, 20, 50, 100, 200] as const
const INVENTORY_DEFAULT_PAGE_SIZE = 50
const INVENTORY_PAGE_SIZE_KEY = 'inventory_page_size'
const RECEIVE_INPUT_CLASS = 'h-8 w-full rounded-md border border-line bg-surface px-3 text-[12px] text-ink outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/15 disabled:cursor-not-allowed disabled:opacity-60'
const RECEIVE_LABEL_CLASS = 'text-[10.5px] font-extrabold uppercase tracking-[0.04em] text-ink-3'
const RECEIVE_FIELD_CLASS = 'flex min-w-0 flex-col gap-1.5'
const INVENTORY_HEADER_CLASS = 'inventory-section-header flex flex-wrap items-start gap-4 px-7 pb-4 pt-6 max-md:px-5 max-md:pb-4 max-md:pt-5'
const INVENTORY_HEADER_ACTIONS_CLASS = 'inventory-section-header-actions ml-auto flex max-w-[min(760px,56vw)] flex-wrap items-center justify-end gap-2 pt-0.5 max-md:flex-[1_1_100%] max-md:justify-start max-md:max-w-none max-md:pt-0 max-[520px]:w-full max-[520px]:[&_.btn]:w-full'
const INVENTORY_PANEL_CLASS = 'px-7 pb-8 max-md:px-4 max-md:pb-5'

function readStoredInventoryPageSize(): number {
  if (typeof window === 'undefined') return INVENTORY_DEFAULT_PAGE_SIZE
  const raw = window.localStorage.getItem(INVENTORY_PAGE_SIZE_KEY)
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  return (INVENTORY_PAGE_SIZE_OPTIONS as readonly number[]).includes(parsed)
    ? parsed
    : INVENTORY_DEFAULT_PAGE_SIZE
}

type AdjustType = 'receive' | 'return' | 'damage' | 'adjust'
type AdjustSign = 1 | -1

interface ClientFormState {
  clientId: string
  name: string
  contactName: string
  email: string
  phone: string
  storeIds: string
  rateSourceClientId: string
}

interface EditSkuFormState {
  invSkuId: number
  sku: string
  clientId: number
  minStock: string
  weightOz: string
  unitsPerPack: string
  parentSkuId: string
  baseUnitQty: string
  packageLength: string
  packageWidth: string
  packageHeight: string
  productLength: string
  productWidth: string
  productHeight: string
  packageId: string
  cuFtOverride: string
  previousParentSkuId: number | null
}

interface CreateParentFormState {
  clientId: number
  name: string
  sku: string
  baseUnitQty: string
}

interface AdjustModalState {
  invSkuId: number
  sku: string
  qty: string
  note: string
  date: string
  type: AdjustType
  sign: AdjustSign
}

interface ThumbnailPreviewState {
  src: string
  left: number
  top: number
  zoom: number
}

type InventorySortDirection = 'asc' | 'desc'
type InventorySortKey =
  | 'sku'
  | 'name'
  | 'store'
  | 'weight'
  | 'length'
  | 'width'
  | 'height'
  | 'dims'
  | 'cuFt'
  | 'package'
  | 'stock'
  | 'sold30'
  | 'unitsPerPack'
  | 'totalUnits'
  | 'min'
  | 'status'

interface InventorySortState {
  key: InventorySortKey
  direction: InventorySortDirection
}

// ──────────────────────────────────────────────────────────────────
// Column layout for the Stock Levels table. A superset of
// InventorySortKey — adds 'thumbnail' (image cell, non-sortable) and
// 'actions' (button group, non-sortable). Drag any header to reorder;
// the Columns popover toggles visibility. Layout persists per-browser
// under localStorage.inventory_column_layout.
// ──────────────────────────────────────────────────────────────────
type InventoryColumnKey =
  | 'sku'
  | 'thumbnail'
  | 'name'
  | 'store'
  | 'weight'
  | 'dims'
  | 'cuFt'
  | 'package'
  | 'stock'
  | 'sold30'
  | 'unitsPerPack'
  | 'totalUnits'
  | 'min'
  | 'status'
  | 'actions'

const INVENTORY_DEFAULT_COLUMN_ORDER: InventoryColumnKey[] = [
  'sku', 'thumbnail', 'name', 'store', 'weight', 'dims', 'cuFt', 'package',
  'stock', 'sold30', 'unitsPerPack', 'totalUnits', 'min', 'status', 'actions',
]

// Columns the operator cannot hide. Without sku + name, rows lose all
// identity. The thumbnail is just visual aid (hidable). Actions can be
// hidden too if an operator only does read-only review.
const INVENTORY_REQUIRED_COLUMNS = new Set<InventoryColumnKey>(['sku', 'name'])

const INVENTORY_COLUMN_LABELS: Record<InventoryColumnKey, string> = {
  sku: 'SKU',
  thumbnail: 'Image',
  name: 'Name',
  store: 'Store',
  weight: 'Weight',
  dims: 'Dims (LxWxH)',
  cuFt: 'Cu Ft/Unit',
  package: 'Package',
  stock: 'Stock',
  sold30: 'Sold 30d',
  unitsPerPack: 'Units/Pack',
  totalUnits: 'Total Units',
  min: 'Min',
  status: 'Status',
  actions: 'Actions',
}

const INVENTORY_COLUMN_ALIGN: Record<InventoryColumnKey, 'left' | 'center' | 'right'> = {
  sku: 'left',
  thumbnail: 'left',
  name: 'left',
  store: 'left',
  weight: 'right',
  dims: 'center',
  cuFt: 'center',
  package: 'left',
  stock: 'center',
  sold30: 'center',
  unitsPerPack: 'center',
  totalUnits: 'center',
  min: 'center',
  status: 'center',
  actions: 'left',
}

// Subset of column keys that are also sortable. Used by header
// renderer to decide whether to wrap the label in a sort button.
const INVENTORY_SORTABLE_KEYS = new Set<InventoryColumnKey>([
  'sku', 'name', 'store', 'weight', 'dims', 'cuFt', 'package',
  'stock', 'sold30', 'unitsPerPack', 'totalUnits', 'min', 'status',
])

// Per-column default widths used by both the <colgroup> and the
// resize-handle "start width" computation. 'name' deliberately has
// no default (undefined → flex-fills remaining table width) so long
// product names stay readable. table-fixed honors these widths
// verbatim, so a resize on one column moves only that column.
// columnWidths overrides take precedence on a per-key basis.
const INVENTORY_COLUMN_DEFAULT_WIDTHS: Partial<Record<InventoryColumnKey, number>> = {
  sku: 140,
  thumbnail: 56,
  name: 360,
  store: 125,
  weight: 90,
  dims: 100,
  cuFt: 80,
  package: 110,
  stock: 70,
  sold30: 75,
  unitsPerPack: 85,
  totalUnits: 90,
  min: 55,
  status: 70,
  actions: 128,
}

const INVENTORY_COLUMN_MIN_WIDTH = 50
const INVENTORY_COLUMN_MIN_WIDTHS: Partial<Record<InventoryColumnKey, number>> = {
  sku: 112,
  thumbnail: 56,
  name: 260,
  store: 112,
  weight: 84,
  dims: 96,
  cuFt: 78,
  package: 104,
  stock: 62,
  sold30: 72,
  unitsPerPack: 82,
  totalUnits: 88,
  min: 54,
  status: 70,
  actions: 118,
}

function getInventoryColumnMinWidth(key: InventoryColumnKey): number {
  return INVENTORY_COLUMN_MIN_WIDTHS[key] ?? INVENTORY_COLUMN_MIN_WIDTH
}

type InventoryColumnWidths = Partial<Record<InventoryColumnKey, number>>

interface InventoryColumnLayout {
  order: InventoryColumnKey[]
  hidden: InventoryColumnKey[]
}

const INVENTORY_COLUMN_LAYOUT_KEY = 'inventory_column_layout'
const INVENTORY_ACTIVE_ONLY_KEY = 'inventory_active_only'
const INVENTORY_COLUMN_KEY_SET = new Set<InventoryColumnKey>(INVENTORY_DEFAULT_COLUMN_ORDER)

function isInventoryColumnKey(value: unknown): value is InventoryColumnKey {
  return typeof value === 'string' && INVENTORY_COLUMN_KEY_SET.has(value as InventoryColumnKey)
}

function readStoredInventoryColumnLayout(): InventoryColumnLayout {
  if (typeof window === 'undefined') {
    return { order: [...INVENTORY_DEFAULT_COLUMN_ORDER], hidden: [] }
  }
  try {
    const raw = window.localStorage.getItem(INVENTORY_COLUMN_LAYOUT_KEY)
    if (!raw) return { order: [...INVENTORY_DEFAULT_COLUMN_ORDER], hidden: [] }
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      return { order: [...INVENTORY_DEFAULT_COLUMN_ORDER], hidden: [] }
    }
    const seen = new Set<InventoryColumnKey>()
    const cleanOrder: InventoryColumnKey[] = []
    for (const k of Array.isArray(parsed.order) ? parsed.order : []) {
      if (isInventoryColumnKey(k) && !seen.has(k)) {
        cleanOrder.push(k); seen.add(k)
      }
    }
    for (const k of INVENTORY_DEFAULT_COLUMN_ORDER) {
      if (!seen.has(k)) { cleanOrder.push(k); seen.add(k) }
    }
    const cleanHidden: InventoryColumnKey[] = []
    const hiddenSeen = new Set<InventoryColumnKey>()
    for (const k of Array.isArray(parsed.hidden) ? parsed.hidden : []) {
      if (isInventoryColumnKey(k) && !INVENTORY_REQUIRED_COLUMNS.has(k) && !hiddenSeen.has(k)) {
        cleanHidden.push(k); hiddenSeen.add(k)
      }
    }
    return { order: cleanOrder, hidden: cleanHidden }
  } catch {
    return { order: [...INVENTORY_DEFAULT_COLUMN_ORDER], hidden: [] }
  }
}

function writeStoredInventoryColumnLayout(layout: InventoryColumnLayout): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      INVENTORY_COLUMN_LAYOUT_KEY,
      JSON.stringify({ order: layout.order, hidden: layout.hidden }),
    )
  } catch { /* best-effort */ }
}

function readStoredInventoryActiveOnly(): boolean {
  if (typeof window === 'undefined') return true
  try {
    const raw = window.localStorage.getItem(INVENTORY_ACTIVE_ONLY_KEY)
    // Fresh browsers should open the normal stock view. Operators can
    // still flip to the deactivated-only view and keep that preference.
    return raw === null ? true : raw === 'true'
  } catch {
    return true
  }
}

function writeStoredInventoryActiveOnly(activeOnly: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(INVENTORY_ACTIVE_ONLY_KEY, String(activeOnly))
  } catch { /* best-effort */ }
}

// Per-column resize widths. Sparse map — only contains keys the
// operator has dragged. Missing keys fall back to
// INVENTORY_COLUMN_DEFAULT_WIDTHS at render time. Reader is defensive:
// strips unknown keys, drops anything not a positive finite number.
const INVENTORY_COLUMN_WIDTHS_KEY = 'inventory_column_widths'

function readStoredInventoryColumnWidths(): InventoryColumnWidths {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(INVENTORY_COLUMN_WIDTHS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const cleaned: InventoryColumnWidths = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (
        isInventoryColumnKey(key)
        && typeof value === 'number'
        && Number.isFinite(value)
        && value >= getInventoryColumnMinWidth(key as InventoryColumnKey)
      ) {
        const columnKey = key as InventoryColumnKey
        cleaned[columnKey] = Math.max(getInventoryColumnMinWidth(columnKey), value)
      }
    }
    return cleaned
  } catch {
    return {}
  }
}

function writeStoredInventoryColumnWidths(widths: InventoryColumnWidths): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(INVENTORY_COLUMN_WIDTHS_KEY, JSON.stringify(widths))
  } catch { /* best-effort */ }
}

const inventorySortCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

const inventoryStatusRank: Record<string, number> = {
  out: 0,
  low: 1,
  ok: 2,
}

function toSortNumber(value: unknown) {
  const nextValue = Number(value)
  return Number.isFinite(nextValue) ? nextValue : 0
}

function getInventoryDisplayStock(row: InventoryItemDto) {
  const effectiveStock = Number(row.effectiveStock)
  return Number.isFinite(effectiveStock) ? effectiveStock : toSortNumber(row.currentStock)
}

function getInventoryDisplayStatus(row: InventoryItemDto): 'ok' | 'low' | 'out' {
  const stock = getInventoryDisplayStock(row)
  if (stock <= 0) return 'out'
  if (stock <= toSortNumber(row.minStock)) return 'low'
  return 'ok'
}

function getInventoryStockTooltip(row: InventoryItemDto) {
  const displayStock = getInventoryDisplayStock(row)
  const cachedStock = Number((row as any).cachedStockQty)
  const auditStock = Number.isFinite(cachedStock) ? cachedStock : row.currentStock
  const tooltipParts = [
    `Received: ${row.totalReceived ?? 0}`,
    `Sold shipped all-time: ${row.totalSoldAllTime ?? 0}`,
    `Effective stock: ${displayStock}`,
  ]
  if (typeof row.effectiveStock === 'number' && row.effectiveStock !== auditStock) {
    tooltipParts.push(`Cached stockQty: ${auditStock}`)
  }
  return tooltipParts.join('\n')
}

function getInventoryPackageSortLabel(row: InventoryItemDto) {
  if (row.packageName) return row.packageName
  if (row.packageLength > 0 || row.packageWidth > 0 || row.packageHeight > 0) {
    return `${row.packageLength}x${row.packageWidth}x${row.packageHeight}`
  }
  return ''
}

function getInventorySortValue(row: InventoryItemDto, key: InventorySortKey) {
  switch (key) {
    case 'sku':
      return row.sku || ''
    case 'name':
      return row.name || ''
    case 'store':
      return row.clientName || ''
    case 'weight':
      return toSortNumber(row.weightOz)
    case 'length':
      return toSortNumber(row.productLength || row.packageLength)
    case 'width':
      return toSortNumber(row.productWidth || row.packageWidth)
    case 'height':
      return toSortNumber(row.productHeight || row.packageHeight)
    case 'dims':
      return toSortNumber(row.packageLength) * toSortNumber(row.packageWidth) * toSortNumber(row.packageHeight)
    case 'cuFt':
      return getInventoryCuFt(row)
    case 'package':
      return getInventoryPackageSortLabel(row)
    case 'stock':
      // Sort by the displayed value (effective stock) so the
      // operator's "sort by stock" matches what they see.
      return getInventoryDisplayStock(row)
    case 'sold30':
      return toSortNumber(row.soldLast30Days)
    case 'unitsPerPack':
      return toSortNumber(row.units_per_pack)
    case 'totalUnits':
      return getInventoryDisplayStock(row) * Math.max(1, toSortNumber(row.units_per_pack))
    case 'min':
      return toSortNumber(row.minStock)
    case 'status':
      return inventoryStatusRank[getInventoryDisplayStatus(row)] ?? 99
    default:
      return ''
  }
}

function compareInventoryRows(left: InventoryItemDto, right: InventoryItemDto, sort: InventorySortState) {
  const leftValue = getInventorySortValue(left, sort.key)
  const rightValue = getInventorySortValue(right, sort.key)
  const direction = sort.direction === 'asc' ? 1 : -1
  const comparison =
    typeof leftValue === 'number' && typeof rightValue === 'number'
      ? leftValue - rightValue
      : inventorySortCollator.compare(String(leftValue ?? ''), String(rightValue ?? ''))

  if (comparison !== 0) return comparison * direction
  const fallback = inventorySortCollator.compare(left.sku || '', right.sku || '')
  if (fallback !== 0) return fallback
  return toSortNumber(left.id) - toSortNumber(right.id)
}

function formatWeight(ounces: number | null | undefined) {
  if (!ounces) return '—'
  const pounds = Math.floor(ounces / 16)
  const remaining = Math.round((ounces % 16) * 10) / 10
  if (pounds === 0) return `${remaining} oz`
  if (remaining === 0) return `${pounds} lb`
  return `${pounds} lb ${remaining} oz`
}

// CA-time delegation per boss directive 2026-05-07. InventoryView
// uses these for ledger entries (createdAt — true UTC) and order
// dates (orderDate — naive-PT-stamped-Z). The ledger paths use UTC
// helpers; order paths use naive-PT helpers.
import {
  formatCaDateTime,
  formatNaivePtDateLong,
} from '../../lib/ca-time'

function formatDateTime(value: number | string | null | undefined) {
  // Ledger entries use createdAt (true UTC). Render in CA TZ.
  return formatCaDateTime(value)
}

function formatDateOnly(value: string | null | undefined) {
  // Order dates from orders.raw / orders.orderDate are naive-PT-stamped-Z.
  return formatNaivePtDateLong(value)
}

function getClientRateSourceFormValue(client?: ClientDto | null) {
  if (!client) return ''
  if (client.rateSourceClientId != null) return String(client.rateSourceClientId)
  return client.hasOwnAccount ? String(client.clientId) : ''
}

function getClientRateSourceLabel(client: ClientDto) {
  return client.rateSourceName || (client.hasOwnAccount ? client.name : 'DR PREPPER')
}

function getClientSourceSortLabel(client: ClientDto) {
  const hasShipStationId = client.storeIds.some((id) => id > 0 && id < 9_000_000)
  const lowerName = (client.name ?? '').toLowerCase()

  if (hasShipStationId) return 'ShipStation'
  if (lowerName.includes('walmart')) return 'Walmart'
  if (lowerName.includes('ebay')) return 'eBay'
  if (lowerName.includes('amazon')) return 'Amazon'
  if (lowerName.includes('shopify')) return 'Shopify'
  if (lowerName.includes('etsy')) return 'Etsy'
  if (lowerName.includes('tiktok')) return 'TikTok Shop'
  if (lowerName.includes('woo') || lowerName.includes('woocomm')) return 'WooCommerce'
  if (lowerName.includes('bigcomm') || lowerName.includes('bigcommerce')) return 'BigCommerce'
  if (client.storeIds.length > 0) return 'Direct'
  return 'Manual'
}

function createClientFormState(client?: ClientDto | null): ClientFormState {
  return {
    clientId: client ? String(client.clientId) : '',
    name: client?.name ?? '',
    contactName: client?.contactName ?? '',
    email: client?.email ?? '',
    phone: client?.phone ?? '',
    storeIds: client?.storeIds?.join(', ') ?? '',
    rateSourceClientId: getClientRateSourceFormValue(client),
  }
}

function createEditSkuFormState(item: InventoryItemDto): EditSkuFormState {
  return {
    invSkuId: item.id,
    sku: item.sku,
    clientId: item.clientId,
    minStock: String(item.minStock ?? 0),
    weightOz: String(item.weightOz ?? 0),
    unitsPerPack: String(item.units_per_pack ?? 1),
    parentSkuId: item.parentSkuId ? String(item.parentSkuId) : '',
    baseUnitQty: String(item.baseUnitQty ?? 1),
    packageLength: String(item.packageLength ?? 0),
    packageWidth: String(item.packageWidth ?? 0),
    packageHeight: String(item.packageHeight ?? 0),
    productLength: String(item.productLength ?? 0),
    productWidth: String(item.productWidth ?? 0),
    productHeight: String(item.productHeight ?? 0),
    packageId: item.packageId ? String(item.packageId) : '',
    cuFtOverride: item.cuFtOverride && item.cuFtOverride > 0 ? String(item.cuFtOverride) : '0',
    previousParentSkuId: item.parentSkuId,
  }
}

function drawSkuSalesChart(canvas: HTMLCanvasElement, dailySales: InventorySkuOrdersDto['dailySales']) {
  const dpr = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()
  const parentWidth = canvas.parentElement?.clientWidth ?? 0
  const width = Math.max(260, Math.floor(rect.width || parentWidth || 320))
  const height = Math.max(140, Math.floor(rect.height || 160))
  canvas.width = width * dpr
  canvas.height = height * dpr
  canvas.style.width = '100%'
  canvas.style.maxWidth = '100%'
  canvas.style.height = `${height}px`

  const context = canvas.getContext('2d')
  if (!context) return
  context.scale(dpr, dpr)

  const styles = getComputedStyle(document.documentElement)
  const colorBackground = styles.getPropertyValue('--surface2').trim() || '#f5f5f5'
  const colorGrid = styles.getPropertyValue('--border').trim() || '#e0e0e0'
  const colorText = styles.getPropertyValue('--text3').trim() || '#888'
  const colorBar = '#e07a00'
  const colorToday = '#ff9a1f'

  const padLeft = 36
  const padRight = 8
  const padTop = 10
  const padBottom = 28
  const chartWidth = width - padLeft - padRight
  const chartHeight = height - padTop - padBottom
  const maxValue = Math.max(...dailySales.map((row) => row.units), 1)
  const totalBars = dailySales.length || 1
  const barWidth = Math.max(2, (chartWidth / totalBars) * 0.72)
  const gap = chartWidth / totalBars
  const today = new Date().toISOString().slice(0, 10)

  context.fillStyle = colorBackground
  context.fillRect(0, 0, width, height)

  context.strokeStyle = colorGrid
  context.lineWidth = 1
  context.setLineDash([3, 3])
  for (let grid = 0; grid <= 3; grid += 1) {
    const y = padTop + chartHeight - (grid / 3) * chartHeight
    context.beginPath()
    context.moveTo(padLeft, y)
    context.lineTo(padLeft + chartWidth, y)
    context.stroke()

    if (grid > 0) {
      context.fillStyle = colorText
      context.font = '10px system-ui, sans-serif'
      context.textAlign = 'right'
      context.fillText(String(Math.round((grid / 3) * maxValue)), padLeft - 4, y + 3.5)
    }
  }
  context.setLineDash([])

  dailySales.forEach((row, index) => {
    const currentBarHeight = row.units > 0 ? Math.max(2, (row.units / maxValue) * chartHeight) : 0
    const x = padLeft + index * gap + (gap - barWidth) / 2
    const y = padTop + chartHeight - currentBarHeight
    const isToday = row.day === today

    context.fillStyle = isToday ? colorToday : colorBar
    if (currentBarHeight > 0) {
      const radius = Math.min(3, barWidth / 2)
      context.beginPath()
      context.moveTo(x + radius, y)
      context.lineTo(x + barWidth - radius, y)
      context.quadraticCurveTo(x + barWidth, y, x + barWidth, y + radius)
      context.lineTo(x + barWidth, y + currentBarHeight)
      context.lineTo(x, y + currentBarHeight)
      context.lineTo(x, y + radius)
      context.quadraticCurveTo(x, y, x + radius, y)
      context.closePath()
      context.fill()
    }

    if (currentBarHeight > 14 && row.units > 0) {
      context.fillStyle = '#fff'
      context.font = 'bold 9px system-ui, sans-serif'
      context.textAlign = 'center'
      context.fillText(String(row.units), x + barWidth / 2, y + 10)
    }

    const showLabel = index % 5 === 0 || isToday || index === totalBars - 1
    if (showLabel) {
      context.fillStyle = isToday ? colorBar : colorText
      context.font = isToday ? 'bold 9px system-ui, sans-serif' : '9px system-ui, sans-serif'
      context.textAlign = 'center'
      context.fillText(row.day.slice(5), x + barWidth / 2, height - 6)
    }
  })
}

function positionThumbnailPreview(cursorX: number, cursorY: number) {
  const zoomRaw = Number.parseFloat(window.getComputedStyle(document.body).zoom)
  const zoom = Number.isFinite(zoomRaw) && zoomRaw > 0
    ? zoomRaw > 10 ? zoomRaw / 100 : zoomRaw
    : 1
  const width = 170
  const height = 170
  const gap = 14
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const rawLeft = Math.max(gap, Math.min(cursorX + gap, viewportWidth - width - gap))
  const rawTop = Math.max(gap, Math.min(cursorY - height / 2, viewportHeight - height - gap))

  return {
    left: rawLeft / zoom,
    top: rawTop / zoom,
    zoom: 1 / zoom,
  }
}

function normalizeInventoryClients(nextClients: any[] | undefined): ClientDto[] {
  return (nextClients ?? []).map((client: any) => ({
    ...client,
    clientId: client?.clientId ?? client?.id,
  }))
}

function buildStockQuery(
  stockClientId: string,
  activeOnly: boolean,
  stockSearch = '',
  alertOnly = false,
  page = 1,
  pageSize = 50,
) {
  const query: Record<string, unknown> = { page, pageSize }
  if (stockClientId) query.clientId = Number.parseInt(stockClientId, 10)
  const search = stockSearch.trim()
  if (search) query.search = search
  if (alertOnly) query.lowStock = true
  query.active = activeOnly
  return query
}

function maybeQueryParams(query: Record<string, unknown>) {
  return Object.keys(query).length ? query : undefined
}

interface InventoryViewProps {
  searchQuery?: string
  onOpenOrder?: (orderId: number, status?: string | null) => void
  /**
   * Optional initial tab. Defaults to 'stock'. When set, the user can
   * still freely switch tabs (unless hideTabs is true).
   *
   * Currently unused (the Clients destination now uses the
   * card-based pages/Clients.tsx instead of an InventoryView embed)
   * but kept as a public surface for future single-tab embed use cases.
   */
  initialTab?: InventoryTab | 'alerts' | 'parents'
  activeTab?: InventoryRouteTab
  onTabChange?: (tab: InventoryRouteTab) => void
  /**
   * When true the inventory tab strip is suppressed AND the action
   * buttons (Import SKUs, Bulk Edit, Refresh, etc.) are hidden so
   * the view reads as a single-tab embed. Pair with `viewTitle` to
   * replace the "Inventory" header label.
   *
   * Currently unused — see `initialTab` note.
   */
  hideTabs?: boolean
  /**
   * Optional title override shown next to the box icon when
   * hideTabs is true. Defaults to 'Inventory'.
   */
  viewTitle?: string
}

export default function InventoryView({ onOpenOrder, initialTab, activeTab: controlledActiveTab, onTabChange, hideTabs, viewTitle }: InventoryViewProps = {}) {
  const toastContext = useContext(ToastContext)
  // 2026-05-12 visibility hardening: needed so handleToggleClientActive
  // below can invalidate React Query caches across the app (Sidebar,
  // Dashboard, Analysis, Billing, Inventory) when an operator
  // enables/disables a client from this view. Without it, re-enabling
  // a client wouldn't show up elsewhere until the next 60s staleTime
  // tick or a manual refresh.
  const queryClient = useQueryClient()
  const { stores } = useInitStores()
  const historyDefaults = useMemo(() => getInventoryDateRangePreset(), [])
  // Extend InventoryTab union locally to include ported v2 tabs (alerts, parents)
  const [activeTabState, setActiveTabState] = useState<InventoryTab | 'alerts' | 'parents'>(initialTab ?? 'stock')
  const activeTab = controlledActiveTab ?? activeTabState
  const setActiveTab = (nextTab: InventoryTab | 'alerts' | 'parents') => {
    if (nextTab === 'clients') {
      setActiveTabState(nextTab)
      return
    }
    if (controlledActiveTab == null) setActiveTabState(nextTab)
    onTabChange?.(nextTab)
  }
  // 2026-05-13: anchor element for the <Table>'s Columns ▾ button.
  // Operator asked to move the picker out of the table card and into
  // the page-level toolbar (to the LEFT of "Import SKUs from Orders").
  // We use a callback ref + state so React re-renders Table when the
  // anchor element mounts/unmounts. When this is null, Table renders
  // the Columns button inline as before; when it points to a DOM node,
  // Table portals the same button + popover there. State, persistence,
  // click-outside detection all stay inside Table.
  const [columnsAnchor, setColumnsAnchor] = useState<HTMLElement | null>(null)
  const [clients, setClients] = useState<ClientDto[]>([])
  const [packages, setPackages] = useState<PackageDto[]>([])
  const [itemsState, setItems] = useState<InventoryItemDto[]>([])
  const [alerts, setAlerts] = useState<InventoryAlertDto[]>([])
  const [ledger, setLedger] = useState<InventoryLedgerEntryDto[]>([])
  const [stockLoadingState, setStockLoading] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [bootError, setBootError] = useState<string | null>(null)
  const [stockSearch, setStockSearch] = useState('')
  const [stockClientId, setStockClientId] = useState('')
  const [alertOnly, setAlertOnly] = useState(false)
  // Status mode defaults to Active only so a fresh browser opens the
  // normal Stock Levels view. Operators can still flip to the
  // deactivated-only view, and that preference is persisted locally.
  const [activeOnly, setActiveOnly] = useState<boolean>(readStoredInventoryActiveOnly)
  useEffect(() => {
    writeStoredInventoryActiveOnly(activeOnly)
  }, [activeOnly])
  const [stockPage, setStockPage] = useState(1)
  const [stockPageSize, setStockPageSize] = useState<number>(readStoredInventoryPageSize)
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(INVENTORY_PAGE_SIZE_KEY, String(stockPageSize))
  }, [stockPageSize])
  const stockQueryParams = useMemo(
    () => buildStockQuery(stockClientId, activeOnly, stockSearch, alertOnly, stockPage, stockPageSize),
    [stockClientId, activeOnly, stockSearch, alertOnly, stockPage, stockPageSize],
  )
  const clientsQuery = useQuery({
    queryKey: ['clients'],
    queryFn: () => apiClient.fetchClients(),
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
  })
  const packagesQuery = useQuery({
    queryKey: ['packages', 'custom'],
    queryFn: () => apiClient.fetchPackages('custom'),
    enabled: activeTab === 'receive',
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
  })
  const alertsQuery = useQuery({
    queryKey: ['inventory', 'alerts'],
    queryFn: () => apiClient.fetchInventoryAlerts(),
    enabled: activeTab === 'alerts' || alertOnly,
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  })
  const inventoryQuery = useQuery({
    queryKey: ['inventory', 'stock', stockQueryParams],
    queryFn: () => apiClient.fetchInventoryPage(maybeQueryParams(stockQueryParams)),
    placeholderData: (previousData) => previousData,
    staleTime: 30_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  })
  const items = itemsState
  const stockTotal = inventoryQuery.data?.total ?? items.length
  const stockLoading =
    inventoryQuery.isLoading ||
    stockLoadingState
  useEffect(() => {
    if (clientsQuery.data) setClients(normalizeInventoryClients(clientsQuery.data))
  }, [clientsQuery.data])
  useEffect(() => {
    if (packagesQuery.data) setPackages(packagesQuery.data)
  }, [packagesQuery.data])
  useEffect(() => {
    if (alertsQuery.data) setAlerts(alertsQuery.data)
  }, [alertsQuery.data])
  useEffect(() => {
    if (inventoryQuery.data) setItems(inventoryQuery.data.items)
  }, [inventoryQuery.data])
  useEffect(() => {
    setStockLoading(
      inventoryQuery.isLoading,
    )
  }, [inventoryQuery.isLoading])
  useEffect(() => {
    const error =
      clientsQuery.error ||
      (activeTab === 'receive' ? packagesQuery.error : null) ||
      (activeTab === 'alerts' || alertOnly ? alertsQuery.error : null) ||
      inventoryQuery.error
    setBootError(error ? error instanceof Error ? error.message : 'Failed to load inventory view' : null)
  }, [activeTab, alertOnly, alertsQuery.error, clientsQuery.error, inventoryQuery.error, packagesQuery.error])
  const [stockSort, setStockSort] = useState<InventorySortState | null>(null)
  // Operator-controlled column layout for the Stock Levels table.
  // Drag a header to reorder, use the Columns popover to toggle
  // visibility. Persisted to localStorage.inventory_column_layout
  // so each browser remembers its own shape.
  const [inventoryColumnLayout, setInventoryColumnLayout] = useState<InventoryColumnLayout>(
    readStoredInventoryColumnLayout,
  )
  // 2026-05-12: legacy InventoryView Columns popover state removed.
  // The reusable <Table> at components/ui/Table.tsx now owns the
  // column toggle UI for this page. `inventoryColumnLayout` (above)
  // is kept because the legacy body-cell render switch upstream
  // still reads `effectiveInventoryColumns` from it; only the
  // popover-open / trigger-rect / click-outside / position-layout
  // state belongs to the popover and is gone.
  // Drag-reorder state — `draggingKey` is the source, `dragOverKey`
  // is the current hover target (drives the drop-indicator stripe).
  const [draggingInventoryColumn, setDraggingInventoryColumn] = useState<InventoryColumnKey | null>(null)
  const [dragOverInventoryColumn, setDragOverInventoryColumn] = useState<InventoryColumnKey | null>(null)

  // Effective column list = order with hidden filtered out. Falls
  // back to the factory default when the layout has been corrupted
  // to an empty set.
  const effectiveInventoryColumns = useMemo<InventoryColumnKey[]>(() => {
    const hiddenSet = new Set(inventoryColumnLayout.hidden)
    const filtered = inventoryColumnLayout.order.filter((k) => !hiddenSet.has(k))
    return filtered.length > 0 ? filtered : INVENTORY_DEFAULT_COLUMN_ORDER
  }, [inventoryColumnLayout])

  // Drag-reorder: insert `fromKey` immediately before `toKey`.
  // Identical semantics to the Analysis and Packages tables.
  function handleInventoryColumnReorder(fromKey: InventoryColumnKey, toKey: InventoryColumnKey) {
    setInventoryColumnLayout((current) => {
      const next = current.order.filter((k) => k !== fromKey)
      const idx = next.indexOf(toKey)
      if (idx < 0) next.push(fromKey)
      else next.splice(idx, 0, fromKey)
      return { ...current, order: next }
    })
  }

  function handleInventoryColumnToggle(key: InventoryColumnKey) {
    if (INVENTORY_REQUIRED_COLUMNS.has(key)) return
    setInventoryColumnLayout((current) => {
      const hiddenSet = new Set(current.hidden)
      if (hiddenSet.has(key)) hiddenSet.delete(key)
      else hiddenSet.add(key)
      return { ...current, hidden: Array.from(hiddenSet) }
    })
  }

  function handleInventoryColumnLayoutReset() {
    setInventoryColumnLayout({ order: [...INVENTORY_DEFAULT_COLUMN_ORDER], hidden: [] })
  }

  useEffect(() => {
    writeStoredInventoryColumnLayout(inventoryColumnLayout)
  }, [inventoryColumnLayout])

  // ─── Per-column resize state ───────────────────────────────────────────────
  // Operators drag the resize handle on the right edge of any header
  // to set that column's width. Persists per-browser; cleared per-key
  // by double-clicking the same handle. Bulk-edit mode shares this
  // state but uses its own legacy <colgroup> so the widths there
  // don't apply.
  const [inventoryColumnWidths, setInventoryColumnWidths] =
    useState<InventoryColumnWidths>(readStoredInventoryColumnWidths)

  function handleInventoryResizeColumn(key: InventoryColumnKey, width: number) {
    setInventoryColumnWidths((current) => ({
      ...current,
      [key]: Math.max(getInventoryColumnMinWidth(key), Math.round(width)),
    }))
  }

  function handleInventoryResetColumn(key: InventoryColumnKey) {
    setInventoryColumnWidths((current) => {
      if (!(key in current)) return current
      const { [key]: _removed, ...rest } = current
      return rest
    })
  }

  // Helper used by ColumnResizeHandle.getStartWidth — returns the
  // currently-effective width (override > default > min). Measuring
  // the th's actual DOM width would also work but reading state is
  // cheaper and avoids a layout-thrash on every drag start.
  function getInventoryColumnWidth(key: InventoryColumnKey): number {
    return Math.max(
      getInventoryColumnMinWidth(key),
      inventoryColumnWidths[key]
      ?? INVENTORY_COLUMN_DEFAULT_WIDTHS[key]
      ?? INVENTORY_COLUMN_MIN_WIDTH
    )
  }

  const inventoryTableMinWidth = useMemo(
    () => effectiveInventoryColumns.reduce((sum, key) => sum + getInventoryColumnWidth(key), 0),
    [effectiveInventoryColumns, inventoryColumnWidths],
  )

  useEffect(() => {
    writeStoredInventoryColumnWidths(inventoryColumnWidths)
  }, [inventoryColumnWidths])

  // 2026-05-12: legacy click-outside + position-layout effects that
  // drove the InventoryView Columns popover are gone — the popover
  // itself was removed (the <Table> primitive owns it now). The two
  // effects only fired while inventoryColumnsMenuOpen was true, so
  // dropping them costs nothing at runtime and removes their hooks
  // dependency on state that no longer exists.

  const [clientsSort, setClientsSort] = useState(null)
  const [historySort, setHistorySort] = useState(null)
  const [alertsSort, setAlertsSort] = useState(null)
  const [parentsSort, setParentsSort] = useState(null)
  const [skuOrdersSort, setSkuOrdersSort] = useState(null)
  const [bulkEditMode, setBulkEditMode] = useState(false)
  const [bulkDrafts, setBulkDrafts] = useState<Record<number, { weightOz: string; productLength: string; productWidth: string; productHeight: string }>>({})
  const [receiveClientId, setReceiveClientId] = useState('')
  const [receiveNote, setReceiveNote] = useState('')
  const [receiveDate, setReceiveDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [receiveRows, setReceiveRows] = useState<ReceiveDraftRow[]>([createReceiveDraftRow()])
  const [receiveSkuMap, setReceiveSkuMap] = useState<Record<string, ReceiveSkuLookup>>({})
  const [receiveResultMessage, setReceiveResultMessage] = useState('')
  // 2026-05-15: Receive-tab autosuggest options. Derived from
  // receiveSkuMap so it stays in sync with whatever client filter
  // has populated the lookup. Memoized so the Object.entries +
  // map() doesn't rebuild on every keystroke (each Receive row's
  // <Autosuggest> reads this same array). Sorted alphabetically by
  // SKU code for deterministic ranking ties.
  const receiveSkuOptions = useMemo<AutosuggestOption[]>(
    () =>
      Object.entries(receiveSkuMap)
        .map(([sku, info]) => ({
          value: sku,
          label: info?.name ?? '',
          // 2026-05-15: thread the imageUrl pulled from the inventory
          // row through to the Autosuggest dropdown. null when the
          // row has no image — Autosuggest renders an empty
          // placeholder square in that case (still reserves the
          // 36×36 column so options align cleanly).
          imageUrl: info?.imageUrl ?? null,
        }))
        .sort((a, b) => a.value.localeCompare(b.value)),
    [receiveSkuMap],
  )
  const selectedReceiveClient = useMemo(
    () => clients.find((client) => String(client.clientId) === receiveClientId) ?? null,
    [clients, receiveClientId],
  )
  const receiveSummary = useMemo(() => {
    let validSkuCount = 0
    let totalUnits = 0

    for (const row of receiveRows) {
      const sku = row.sku.trim()
      if (!sku) continue
      const lookup =
        receiveSkuMap[sku] ??
        Object.entries(receiveSkuMap).find(([candidate]) => candidate.toLowerCase() === sku.toLowerCase())?.[1] ??
        null
      const packQty = Number.parseInt(row.qty, 10) || 0
      if (lookup && packQty > 0) validSkuCount += 1
      if (packQty > 0) {
        const unitsPerPack = Math.max(1, Number.parseInt(String(lookup?.unitsPerPack ?? 1), 10) || 1)
        totalUnits += packQty * unitsPerPack
      }
    }

    return {
      rowCount: receiveRows.length,
      validSkuCount,
      totalUnits,
    }
  }, [receiveRows, receiveSkuMap])
  const [historyClientId, setHistoryClientId] = useState('')
  const [historyType, setHistoryType] = useState('')
  const [historyFrom, setHistoryFrom] = useState(historyDefaults.from)
  const [historyTo, setHistoryTo] = useState(historyDefaults.to)
  const [clientFormOpen, setClientFormOpen] = useState(false)
  const [clientForm, setClientForm] = useState<ClientFormState>(createClientFormState())
  const [clientSyncStatus, setClientSyncStatus] = useState('')
  // Per-client optimistic toggle override + pending flag. While the PATCH
  // /clients/:id call is in flight we paint the toggle in its target state
  // immediately (optimistic) and add an .is-pending class for the spinner
  // visual. On success the override is cleared (server data wins on the
  // refetch). On failure we revert and toast.
  const [clientActiveOverrides, setClientActiveOverrides] = useState<Record<number, boolean>>({})
  const [pendingClientToggleId, setPendingClientToggleId] = useState<number | null>(null)
  const [editSkuForm, setEditSkuForm] = useState<EditSkuFormState | null>(null)
  const [parentSkuOptions, setParentSkuOptions] = useState<Record<number, ParentSkuDto[]>>({})
  const [parentModal, setParentModal] = useState<CreateParentFormState | null>(null)
  const [adjustModal, setAdjustModal] = useState<AdjustModalState | null>(null)
  const [skuDrawer, setSkuDrawer] = useState<InventorySkuOrdersDto | null>(null)
  const [skuDrawerTitle, setSkuDrawerTitle] = useState('Loading…')
  const [skuDrawerError, setSkuDrawerError] = useState<string | null>(null)
  const [skuDrawerOpen, setSkuDrawerOpen] = useState(false)
  const [skuDrawerLoading, setSkuDrawerLoading] = useState(false)
  const [orderDetailModal, setOrderDetailModal] = useState<{ orderId: number; status?: string | null } | null>(null)
  const [thumbnailPreview, setThumbnailPreview] = useState<ThumbnailPreviewState | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  // ─── Alerts tab state ──────────────────────────────────────────────────────
  const [alertsClientId, setAlertsClientId] = useState('')
  const [focusInvSkuId, setFocusInvSkuId] = useState<number | null>(null)
  const rowRefs = useRef<Record<number, HTMLTableRowElement | null>>({})

  // ─── Parent SKUs tab state ─────────────────────────────────────────────────
  const [parentsClientId, setParentsClientId] = useState('')
  const [parentsList, setParentsList] = useState<ParentSkuDto[]>([])
  const [parentsLoading, setParentsLoading] = useState(false)
  const [parentsCreateOpen, setParentsCreateOpen] = useState(false)
  const [parentsCreateForm, setParentsCreateForm] = useState<CreateParentFormState>({
    clientId: 0,
    name: '',
    sku: '',
    baseUnitQty: '1',
  })

  // ─── Inline-parent-assign state (per inventory row) ────────────────────────
  const [inlineParentRowId, setInlineParentRowId] = useState<number | null>(null)
  const [inlineParentSaving, setInlineParentSaving] = useState(false)
  // The chain-link button that was clicked to open the popover —
  // captured so we can compute its viewport rect and position the
  // popover via Portal (escaping the td's overflow:hidden which
  // would otherwise clip the dropdown). One state for both row
  // anchor + computed rect; recomputed on scroll/resize.
  const [parentPopoverAnchor, setParentPopoverAnchor] = useState<HTMLElement | null>(null)
  const [parentPopoverRect, setParentPopoverRect] = useState<{ top: number; left: number; minWidth: number } | null>(null)
  // Set of SKU ids currently saving an active-toggle. Drives spinner
  // / disabled state on the per-row toggle pill. Cleared on success
  // or failure so the next click re-engages.
  const [togglingActiveIds, setTogglingActiveIds] = useState<Set<number>>(new Set())

  // Auto-close the parent-SKU popover when the operator clicks anywhere
  // outside it. Matches the columns-menu pattern in the toolbar so the
  // two popovers behave identically. The chain-link button's own
  // onClick still toggles open/closed without conflict — title-attr
  // whitelist below stops the click-outside from immediately reopening
  // it when the toggle itself is clicked. Must live AFTER the state
  // declarations it reads (`inlineParentRowId`) — moving it above
  // hit a TDZ when the bundler hoisted the const, hence this spot.
  useEffect(() => {
    if (inlineParentRowId == null) return
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as HTMLElement | null
      if (target?.closest('[data-inventory-parent-popover]')) return
      if (target?.closest('button[title*="parent SKU"]')) return
      setInlineParentRowId(null)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [inlineParentRowId])

  // Recompute the portal'd parent-SKU popover's viewport coords
  // whenever it opens, or when the page scrolls/resizes. Capture-
  // phase scroll listener catches scrolls in nested containers
  // (the inventory view-content scrolls). useLayoutEffect runs
  // before paint so there's no one-frame flash at (0,0) before
  // measurement lands.
  useLayoutEffect(() => {
    if (inlineParentRowId == null || !parentPopoverAnchor) {
      setParentPopoverRect(null)
      return
    }
    function update() {
      if (!parentPopoverAnchor) return
      const rect = parentPopoverAnchor.getBoundingClientRect()
      setParentPopoverRect({
        top: rect.bottom + 4,
        // Align popover's left edge with the trigger's left edge,
        // but clamp ≥ 8px so it never butts the viewport wall.
        left: Math.max(8, rect.left),
        // minWidth at least 240 (popover's preferred width) or the
        // trigger button's width if the trigger is wider somehow.
        minWidth: Math.max(240, rect.width),
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [inlineParentRowId, parentPopoverAnchor])

  // Toggle a single SKU's active flag. Optimistic update: flip the
  // local `items` row immediately so the pill UI snaps to its new
  // state, then PATCH the server. On failure, roll back + toast.
  async function handleToggleRowActive(row: InventoryItemDto) {
    if (togglingActiveIds.has(row.id)) return
    const nextActive = !(row.active !== false) // null/true → false, false → true
    setTogglingActiveIds((current) => {
      const next = new Set(current)
      next.add(row.id)
      return next
    })
    setItems((prev) => prev.map((r) => (r.id === row.id ? { ...r, active: nextActive } : r)))
    try {
      await apiClient.updateInventoryItem(row.id, { active: nextActive })
      queryClient.setQueriesData({ queryKey: ['inventory', 'stock'] }, (current: any) =>
        Array.isArray(current)
          ? current.map((cachedRow) => (cachedRow.id === row.id ? { ...cachedRow, active: nextActive } : cachedRow))
          : current,
      )
      void queryClient.invalidateQueries({ queryKey: ['inventory'] })
    } catch (error) {
      // Roll back — server didn't accept the change.
      setItems((prev) => prev.map((r) => (r.id === row.id ? { ...r, active: !nextActive } : r)))
      toastContext?.addToast(
        error instanceof Error ? error.message : `Failed to ${nextActive ? 'activate' : 'deactivate'} SKU`,
        'error',
      )
    } finally {
      setTogglingActiveIds((current) => {
        const next = new Set(current)
        next.delete(row.id)
        return next
      })
    }
  }

  useEffect(() => {
    if (!thumbnailPreview) return

    const handleMove = (event: MouseEvent) => {
      setThumbnailPreview((current) => {
        if (!current) return current
        return {
          ...current,
          ...positionThumbnailPreview(event.clientX, event.clientY),
        }
      })
    }

    document.addEventListener('mousemove', handleMove)
    return () => document.removeEventListener('mousemove', handleMove)
  }, [thumbnailPreview])

  // ─── Column definitions for the shared <Table> component ─────────────────
  // 2026-05-12: refactored from inline switch-based cell rendering to the
  // standard <Table> primitive (web/src/components/ui/Table.tsx). Each column
  // provides a render function returning the cell CONTENT (not the <td>
  // wrapper — Table handles the td). Handlers (openSkuDrawer, openEditSku,
  // handleToggleRowActive, etc.) are captured via closure so this memo is
  // recomputed when those identities change. togglingActiveIds is in the
  // deps so the per-row spinner state on the active-toggle pill updates.
  const inventoryColumns = useMemo<TableColumn<InventoryItemDto>[]>(() => [
    {
      key: 'sku',
      label: 'SKU',
      width: 150,
      sortable: true,
      // 2026-05-13: every column toggleable + draggable per operator
      // request (Awaiting-Shipment parity). Reset button in the
      // Columns ▾ picker restores defaults if needed.
      sortValue: (row) => row.sku ?? '',
      render: (row) => (
        <button
          type="button"
          className="inventory-inline-button inventory-cell-link--nowrap"
          style={{ color: 'var(--ss-blue)', fontFamily: 'monospace', fontSize: 11.5 }}
          onClick={(e) => { e.stopPropagation(); void openSkuDrawer(row.id) }}
          title={`${row.sku} - view orders & sales trend`}
        >
          {row.sku}
        </button>
      ),
    },
    {
      key: 'thumbnail',
      label: 'Image',
      width: 56,
      sortable: false,
      render: (row) => (
        row.imageUrl ? (
          <img
            src={row.imageUrl}
            style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 5, display: 'block', cursor: 'zoom-in' }}
            onMouseEnter={(event) => showThumbnailPreview(row.imageUrl ?? '', event)}
            onMouseLeave={() => setThumbnailPreview(null)}
          />
        ) : (
          <div style={{ width: 40, height: 40, background: 'var(--surface3)', border: '1px dashed var(--border)', borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, color: 'var(--text4)', textAlign: 'center', lineHeight: 1.2 }}>no<br />img</div>
        )
      ),
    },
    {
      key: 'name',
      label: 'Name',
      width: 200,
      sortable: true,
      // 2026-05-13: every column toggleable + draggable per operator
      // request (Awaiting-Shipment parity). Reset button in the
      // Columns ▾ picker restores defaults if needed.
      sortValue: (row) => row.name ?? '',
      render: (row) => (
        <button
          type="button"
          className="inventory-inline-button inventory-cell-link--clamp"
          onClick={(e) => { e.stopPropagation(); void openSkuDrawer(row.id) }}
          title={`${row.name || row.sku || 'SKU'} - view orders & sales trend`}
        >
          {row.name || <span style={{ color: 'var(--text3)' }}>—</span>}
        </button>
      ),
    },
    {
      key: 'client',
      label: 'Client',
      width: 130,
      sortable: true,
      sortValue: (row) => row.clientName ?? '',
      render: (row) => (
        <span style={{ color: 'var(--text2)', whiteSpace: 'nowrap' }} title={row.clientName || undefined}>
          {row.clientName || <span style={{ color: 'var(--text4)' }}>&mdash;</span>}
        </span>
      ),
    },
    {
      key: 'weight',
      label: 'Weight',
      width: 90,
      align: 'right',
      sortable: true,
      sortValue: (row) => row.weightOz ?? 0,
      render: (row) => row.weightOz > 0 ? formatWeight(row.weightOz) : <span style={{ color: 'var(--text4)' }}>—</span>,
    },
    {
      key: 'dims',
      label: 'Dims (LxWxH)',
      width: 110,
      align: 'center',
      sortable: true,
      // Sort by total volume — biggest packages float to top when sorting desc.
      sortValue: (row) => (row.packageLength || 0) * (row.packageWidth || 0) * (row.packageHeight || 0),
      render: (row) => (
        <span style={{ fontFamily: 'monospace', fontSize: 11.5 }}>
          {row.packageLength > 0 || row.packageWidth > 0 || row.packageHeight > 0
            ? `${row.packageLength}×${row.packageWidth}×${row.packageHeight}`
            : <span style={{ color: 'var(--text4)' }}>—</span>}
        </span>
      ),
    },
    {
      key: 'cuFt',
      label: 'Cu Ft/Unit',
      width: 90,
      align: 'center',
      sortable: true,
      sortValue: (row) => getInventoryCuFt(row),
      render: (row) => {
        const cuFt = getInventoryCuFt(row)
        return cuFt > 0 ? (
          <span title={row.cuFtOverride && row.cuFtOverride > 0 ? 'Manual override' : 'Auto-computed from product dims'} style={{ color: 'var(--text3)', fontSize: 11 }}>
            {cuFt.toFixed(3)}
            {row.cuFtOverride && row.cuFtOverride > 0
              ? <span style={{ color: 'var(--ss-blue)', fontSize: 9, marginLeft: 2 }}>✎</span>
              : null}
          </span>
        ) : (
          <span style={{ color: 'var(--text4)' }}>—</span>
        )
      },
    },
    {
      key: 'package',
      label: 'Package',
      width: 110,
      sortable: true,
      sortValue: (row) => row.packageName ?? '',
      render: (row) => (
        row.packageName ? (
          <span>{row.packageName}</span>
        ) : (row.packageLength > 0 || row.packageWidth > 0 || row.packageHeight > 0) ? (
          <span style={{ fontFamily: 'monospace', color: 'var(--text3)' }} title="No named package — showing product dims (L×W×H)">
            {row.packageLength}×{row.packageWidth}×{row.packageHeight}
          </span>
        ) : (
          <span style={{ color: 'var(--text4)' }}>—</span>
        )
      ),
    },
    {
      key: 'stock',
      label: 'Stock',
      width: 75,
      align: 'center',
      sortable: true,
      sortValue: (row) => getInventoryDisplayStock(row),
      render: (row) => (
        <span
          title={getInventoryStockTooltip(row)}
          style={{ fontWeight: 700, fontSize: 13, color: getInventoryDisplayStock(row) <= 0 ? 'var(--red)' : 'var(--text)' }}
        >
          {getInventoryDisplayStock(row)}
        </span>
      ),
    },
    {
      key: 'sold30',
      label: 'Sold 30d',
      width: 80,
      align: 'center',
      sortable: true,
      sortValue: (row) => row.soldLast30Days ?? 0,
      render: (row) => (
        <span style={{ fontWeight: 700, fontSize: 12, color: (row.soldLast30Days ?? 0) > 0 ? 'var(--ss-blue)' : 'var(--text3)' }}>
          {row.soldLast30Days ?? 0}
        </span>
      ),
    },
    {
      key: 'unitsPerPack',
      label: 'Units/Pack',
      width: 90,
      align: 'center',
      sortable: true,
      sortValue: (row) => row.units_per_pack ?? 1,
      render: (row) => (
        row.units_per_pack > 1
          ? <span style={{ background: 'var(--ss-blue-bg)', color: 'var(--ss-blue)', fontSize: 10.5, fontWeight: 700, padding: '1px 6px', borderRadius: 4 }}>×{row.units_per_pack}</span>
          : <span style={{ color: 'var(--text3)' }}>—</span>
      ),
    },
    {
      key: 'totalUnits',
      label: 'Total Units',
      width: 95,
      align: 'center',
      sortable: true,
      sortValue: (row) => (row.units_per_pack > 1 ? getInventoryDisplayStock(row) * row.units_per_pack : 0),
      render: (row) => (
        row.units_per_pack > 1
          ? <span style={{ fontWeight: 700, fontSize: 12, color: 'var(--text2)' }}>{getInventoryDisplayStock(row) * row.units_per_pack}</span>
          : <span style={{ color: 'var(--text3)', fontSize: 12 }}>—</span>
      ),
    },
    {
      key: 'min',
      label: 'Min',
      width: 60,
      align: 'center',
      sortable: true,
      sortValue: (row) => row.minStock ?? 0,
      render: (row) => <span style={{ color: 'var(--text3)', fontSize: 12 }}>{row.minStock}</span>,
    },
    {
      key: 'status',
      label: 'Status',
      width: 75,
      align: 'center',
      sortable: true,
      // Sort: out (0) → low (1) → ok (2) so descending puts attention-needers first.
      sortValue: (row) => getInventoryDisplayStatus(row) === 'out' ? 0 : getInventoryDisplayStatus(row) === 'low' ? 1 : 2,
      render: (row) => (
        <span className={`stock-badge ${getInventoryDisplayStatus(row) === 'out' ? 'stock-out' : getInventoryDisplayStatus(row) === 'low' ? 'stock-low' : 'stock-ok'}`}>
          {getInventoryDisplayStatus(row) === 'out' ? 'OUT' : getInventoryDisplayStatus(row) === 'low' ? 'LOW' : 'OK'}
        </span>
      ),
    },
    {
      key: 'actions',
      label: 'Actions',
      width: 200,
      sortable: false,
      render: (row) => (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <button
            className="btn btn-ghost btn-xs"
            type="button"
            onClick={(event) => { event.stopPropagation(); void openEditSku(row) }}
            title="Edit SKU details"
            style={{ flex: '0 0 auto' }}
          >
            ✏️
          </button>
          <button
            className="btn btn-ghost btn-xs"
            type="button"
            title={row.parentSkuId ? 'Change parent SKU' : 'Assign parent SKU'}
            onClick={async (event) => {
              event.stopPropagation()
              const triggerEl = event.currentTarget as HTMLElement
              try {
                await loadParentOptions(row.clientId)
                setInlineParentRowId((current) => {
                  const next = current === row.id ? null : row.id
                  setParentPopoverAnchor(next == null ? null : triggerEl)
                  return next
                })
              } catch (error) {
                toastContext?.addToast(error instanceof Error ? error.message : 'Failed to load parents', 'error')
              }
            }}
            style={{ fontSize: 12, color: row.parentSkuId ? 'var(--ss-blue)' : 'var(--text3)', flex: '0 0 auto' }}
          >
            🔗
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              setAdjustModal({
                invSkuId: row.id, sku: row.sku, qty: '1', note: '',
                date: new Date().toISOString().slice(0, 10), type: 'adjust', sign: 1,
              })
            }}
            title="Adjust stock — add or remove units"
            aria-label="Adjust stock"
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 22, height: 22, padding: 0,
              border: '1px solid var(--ss-blue)', borderRadius: 999,
              background: 'rgba(42,91,215,0.08)', color: 'var(--ss-blue)',
              fontSize: 12, fontWeight: 800, cursor: 'pointer', lineHeight: 1, flex: '0 0 auto',
            }}
          >
            ±
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={row.active !== false}
            aria-label={row.active !== false ? `Deactivate ${row.sku}` : `Activate ${row.sku}`}
            onClick={(event) => { event.stopPropagation(); void handleToggleRowActive(row) }}
            disabled={togglingActiveIds.has(row.id)}
            title={row.active !== false ? 'Active · click to deactivate' : 'Inactive · click to activate'}
            style={{
              background: 'none', border: 0, padding: 0,
              cursor: togglingActiveIds.has(row.id) ? 'wait' : 'pointer',
              opacity: togglingActiveIds.has(row.id) ? 0.5 : 1,
              flex: '0 0 auto',
            }}
          >
            <span
              className={`relative inline-flex items-center w-7 h-3.5 rounded-full transition-colors duration-150 ${row.active !== false ? 'bg-emerald-500' : 'bg-slate-300'}`}
              aria-hidden="true"
            >
              <span
                className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white shadow-sm transition-transform duration-150 ${row.active !== false ? 'translate-x-[14px]' : 'translate-x-0.5'}`}
              />
            </span>
          </button>
        </div>
      ),
    },
  ], [openSkuDrawer, openEditSku, handleToggleRowActive, togglingActiveIds, loadParentOptions, showThumbnailPreview])

  const filteredRows = useMemo(() => {
    return filterInventoryRows(items, {
      search: stockSearch,
      clientId: stockClientId,
      alertOnly,
      activeOnly,
    })
  }, [alertOnly, activeOnly, items, stockClientId, stockSearch])

  // 2026-05-12: Counter for the "Active only" toolbar toggle.
  // Counts off the full `items` array (NOT filteredRows) because we
  // want to surface the global deactivated count regardless of what's
  // currently visible. Tri-state-safe: `null` is treated as active,
  // only an explicit `false` counts. Mirrors the predicate used by
  // pinRowToBottom and filterInventoryRows so the three numbers can't
  // disagree.
  const inactiveCount = useMemo(
    () => items.reduce((sum, row) => (row.active === false ? sum + 1 : sum), 0),
    [items],
  )

  const sortedRows = useMemo(() => {
    if (!stockSort) return filteredRows
    return [...filteredRows].sort((left, right) => compareInventoryRows(left, right, stockSort))
  }, [filteredRows, stockSort])

  // ─── Pagination (Stock Levels tab) ────────────────────────────────────────
  // Operator-requested 2026-05-12: pageSize options 10/20/50/100/200.
  // pageSize persists per-browser; page resets to 1 on any filter/sort
  // change to keep the operator anchored at the top of the new result set.
  // Reset to page 1 whenever the filter/sort/active inputs change so
  // operators don't land on page 7 of a fresh result that only has
  // 2 pages. Mirrors how Packages/Analysis paging hooks behave.
  useEffect(() => {
    setStockPage(1)
  }, [stockSearch, stockClientId, alertOnly, activeOnly, stockPageSize, stockSort])

  // Clamp page when total shrinks (e.g., operator narrows the filter
  // and the previous last-page becomes invalid).
  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(stockTotal / stockPageSize))
    if (stockPage > maxPage) setStockPage(maxPage)
  }, [stockTotal, stockPageSize, stockPage])

  // Slice the sorted/filtered list to just the current page. Grouping
  // happens AFTER pagination so each rendered page shows up to
  // pageSize rows total across all clients (not pageSize per group).
  const pagedRows = useMemo(() => {
    return sortedRows
  }, [sortedRows])

  const groupedRows = useMemo(() => groupInventoryRowsByClient(pagedRows), [pagedRows])
  const storeNameMap = useMemo(() => {
    const nextMap = new Map<number, string>()
    for (const store of stores) {
      nextMap.set(store.storeId, store.storeName)
    }
    return nextMap
  }, [stores])
  const rateSourceOptions = useMemo(() => {
    const selectedRateSourceId = Number.parseInt(clientForm.rateSourceClientId, 10)
    return clients
      .filter((client) => {
        return client.hasOwnAccount || client.clientId === selectedRateSourceId
      })
      .sort((left, right) => left.name.localeCompare(right.name))
  }, [clientForm.rateSourceClientId, clients])
  const sortedClients = useMemo(() => sortRows(
    clients,
    clientsSort,
    (client, key) => {
      const override = clientActiveOverrides[client.clientId]
      const isActive = override !== undefined ? override : (client.active ?? true)

      switch (key) {
        case 'name':
          return client.name
        case 'contact':
          return client.contactName
        case 'email':
          return client.email
        case 'storeId':
          return client.storeIds.join(', ')
        case 'source':
          return getClientSourceSortLabel(client)
        case 'rateSource':
          return getClientRateSourceLabel(client)
        case 'active':
          return isActive
        default:
          return ''
      }
    },
    (client) => client.name,
  ), [clientActiveOverrides, clients, clientsSort])
  const sortedLedger = useMemo(() => sortRows(
    ledger,
    historySort,
    (entry, key) => {
      switch (key) {
        case 'date':
          return entry.createdAt ? new Date(entry.createdAt) : null
        case 'sku':
          return entry.sku
        case 'type':
          return entry.type
        case 'qty':
          return entry.qty
        case 'note':
          return entry.note
        case 'source':
          return entry.createdBy
        default:
          return ''
      }
    },
    (entry) => entry.id,
  ), [historySort, ledger])
  const filteredAlerts = useMemo(() => (
    alertsClientId
      ? alerts.filter((alert: any) => String(alert?.clientId ?? '') === alertsClientId)
      : alerts
  ), [alerts, alertsClientId])
  const sortedAlerts = useMemo(() => sortRows(
    filteredAlerts,
    alertsSort,
    (alert: any, key) => {
      const stock = getInventoryDisplayStock(alert as InventoryItemDto)
      const minStock = alert?.minStock ?? 0
      const clientName = alert?.clientName
        ?? clients.find((client) => client.clientId === alert?.clientId)?.name
        ?? ''

      switch (key) {
        case 'sku':
          return alert?.sku
        case 'name':
          return alert?.name
        case 'client':
          return clientName
        case 'stock':
          return stock
        case 'min':
          return minStock
        case 'status':
          return stock <= 0 ? 0 : minStock > 0 && stock <= minStock ? 1 : 2
        default:
          return ''
      }
    },
    (alert: any) => alert?.sku ?? alert?.id,
  ), [alertsSort, clients, filteredAlerts])
  const sortedParentsList = useMemo(() => sortRows(
    parentsList,
    parentsSort,
    (parent: any, key) => {
      switch (key) {
        case 'name':
          return parent?.name
        case 'sku':
          return parent?.sku
        case 'client':
          return clients.find((client) => client.clientId === parent?.clientId)?.name ?? ''
        case 'baseUnitQty':
          return parent?.baseUnitQty ?? 1
        default:
          return ''
      }
    },
    (parent: any) => parent?.name ?? parent?.parentSkuId ?? parent?.id,
  ), [clients, parentsList, parentsSort])
  const sortedSkuOrders = useMemo(() => sortRows(
    skuDrawer?.orders ?? [],
    skuOrdersSort,
    (order, key) => {
      switch (key) {
        case 'order':
          return order.orderNumber || order.orderId
        case 'customer':
          return order.shipToName
        case 'qty':
          return order.qty || 1
        case 'status':
          return order.orderStatus
        case 'date':
          return order.orderDate ? new Date(order.orderDate) : null
        default:
          return ''
      }
    },
    (order) => order.orderNumber || order.orderId,
  ), [skuDrawer?.orders, skuOrdersSort])

  function handleClientsSort(key: string) {
    setClientsSort((current) => nextSortState(current, key))
  }

  function handleHistorySort(key: string) {
    setHistorySort((current) => nextSortState(current, key))
  }

  function handleAlertsSort(key: string) {
    setAlertsSort((current) => nextSortState(current, key))
  }

  function handleParentsSort(key: string) {
    setParentsSort((current) => nextSortState(current, key))
  }

  function handleSkuOrdersSort(key: string) {
    setSkuOrdersSort((current) => nextSortState(current, key))
  }

  function handleStockSort(key: InventorySortKey) {
    setStockSort((current) => {
      if (current?.key === key) {
        return {
          key,
          direction: current.direction === 'asc' ? 'desc' : 'asc',
        }
      }
      return { key, direction: 'asc' }
    })
  }

  function renderStockSortHeader(
    key: InventorySortKey,
    label: string,
    options: { align?: 'left' | 'center' | 'right'; title?: string } = {},
  ) {
    const isActive = stockSort?.key === key
    const directionLabel = isActive && stockSort.direction === 'asc' ? 'descending' : 'ascending'
    const alignClass = options.align ? `inventory-sort-header--${options.align}` : ''
    const className = ['inventory-sort-header', alignClass, isActive ? 'is-active' : '']
      .filter(Boolean)
      .join(' ')

    return (
      <th
        aria-sort={isActive ? (stockSort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
        style={options.align ? { textAlign: options.align } : undefined}
        title={options.title}
      >
        <button
          type="button"
          className={className}
          onClick={() => handleStockSort(key)}
          title={`Sort by ${label} ${directionLabel}`}
        >
          <span>{label}</span>
          <span className="inventory-sort-indicator">{isActive ? (stockSort.direction === 'asc' ? '^' : 'v') : ''}</span>
        </button>
      </th>
    )
  }

  // Drag-aware header for the Stock Levels table — wraps
  // renderStockSortHeader's logic but also accepts non-sortable
  // columns (thumbnail, actions) which render as a plain <th>.
  // draggable={true} on both the <th> AND the inner button avoids
  // the buttons-eat-mousedown gotcha (HTML5 DnD §6.7.5).
  function renderInventoryColumnHeader(columnKey: InventoryColumnKey) {
    const sortable = INVENTORY_SORTABLE_KEYS.has(columnKey)
    const align = INVENTORY_COLUMN_ALIGN[columnKey]
    const label = INVENTORY_COLUMN_LABELS[columnKey]
    const isDragging = draggingInventoryColumn === columnKey
    const isDragOver =
      dragOverInventoryColumn === columnKey
      && draggingInventoryColumn !== null
      && draggingInventoryColumn !== columnKey

    const dragHandlers = {
      draggable: true as const,
      onDragStart: (e: React.DragEvent) => {
        setDraggingInventoryColumn(columnKey)
        e.dataTransfer.effectAllowed = 'move'
        try { e.dataTransfer.setData('text/plain', columnKey) } catch { /* sandbox */ }
      },
      onDragOver: (e: React.DragEvent) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (dragOverInventoryColumn !== columnKey) setDragOverInventoryColumn(columnKey)
      },
      onDragLeave: () => {
        if (dragOverInventoryColumn === columnKey) setDragOverInventoryColumn(null)
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault()
        const fromKey = draggingInventoryColumn
        setDraggingInventoryColumn(null)
        setDragOverInventoryColumn(null)
        if (fromKey && fromKey !== columnKey) handleInventoryColumnReorder(fromKey, columnKey)
      },
      onDragEnd: () => {
        setDraggingInventoryColumn(null)
        setDragOverInventoryColumn(null)
      },
    }

    const thStyle: React.CSSProperties = {
      textAlign: align,
      userSelect: 'none',
      cursor: isDragging ? 'grabbing' : 'grab',
      opacity: isDragging ? 0.4 : 1,
      boxShadow: isDragOver ? 'inset 3px 0 0 var(--ss-blue, #2a5bd7)' : undefined,
      // position:relative anchors the absolute ColumnResizeHandle on
      // the th's right edge (handle uses `position: absolute; right: -1px`).
      position: 'relative',
    }

    // Reusable resize-handle element rendered on every column except
    // the last (no neighbor to push against). Stops propagation at
    // the source (in ColumnResizeHandle's onMouseDown) so dragging
    // the handle doesn't accidentally fire the column-drag dragstart.
    const resizeHandle = (
      <ColumnResizeHandle
        getStartWidth={() => getInventoryColumnWidth(columnKey)}
        onChange={(width) => handleInventoryResizeColumn(columnKey, Math.round(width))}
        onReset={() => handleInventoryResetColumn(columnKey)}
        minWidth={getInventoryColumnMinWidth(columnKey)}
      />
    )

    // Non-sortable columns (thumbnail, actions) render a plain label.
    if (!sortable) {
      return (
        <th key={columnKey} {...dragHandlers} style={thStyle}>
          <span
            draggable
            style={{ display: 'inline-block', width: '100%', textAlign: align }}
          >
            {columnKey === 'thumbnail' ? '' : label}
          </span>
          {resizeHandle}
        </th>
      )
    }

    const sortKey = columnKey as InventorySortKey
    const isActive = stockSort?.key === sortKey
    const directionLabel = isActive && stockSort?.direction === 'asc' ? 'descending' : 'ascending'
    const alignClass = `inventory-sort-header--${align}`
    const buttonClassName = ['inventory-sort-header', alignClass, isActive ? 'is-active' : '']
      .filter(Boolean)
      .join(' ')

    return (
      <th
        key={columnKey}
        {...dragHandlers}
        aria-sort={isActive ? (stockSort?.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
        style={thStyle}
      >
        <button
          type="button"
          draggable
          className={buttonClassName}
          onClick={() => handleStockSort(sortKey)}
          title={`Sort by ${label} ${directionLabel}`}
          style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
        >
          <span>{label}</span>
          <span className="inventory-sort-indicator">
            {isActive ? (stockSort?.direction === 'asc' ? '^' : 'v') : ''}
          </span>
        </button>
        {resizeHandle}
      </th>
    )
  }

  useEffect(() => {
    if (activeTab !== 'history') return

    let active = true

    const loadHistory = async () => {
      setHistoryLoading(true)
      try {
        const nextLedger = await apiClient.fetchInventoryLedger(buildInventoryLedgerQuery({
          clientId: historyClientId,
          type: historyType,
          from: historyFrom,
          to: historyTo,
        }))
        if (!active) return
        setLedger(nextLedger)
      } catch (error) {
        if (!active) return
        setBootError(error instanceof Error ? error.message : 'Failed to load history')
      } finally {
        if (active) setHistoryLoading(false)
      }
    }

    void loadHistory()

    return () => {
      active = false
    }
  }, [activeTab, historyClientId, historyFrom, historyTo, historyType])

  useEffect(() => {
    let active = true

    const loadReceiveSkuMap = async () => {
      if (!receiveClientId) {
        setReceiveSkuMap({})
        setReceiveRows([createReceiveDraftRow()])
        return
      }

      try {
        const clientRows = await apiClient.fetchInventory({
          clientId: Number.parseInt(receiveClientId, 10),
          includeInactive: true,
        })
        if (!active) return
        const nextMap: Record<string, ReceiveSkuLookup> = {}
        for (const row of clientRows) {
          nextMap[row.sku] = {
            invSkuId: row.id,
            name: row.name || '',
            unitsPerPack: row.units_per_pack || 1,
            // 2026-05-15: forward the inventory row's image URL so
            // the Receive-tab Autosuggest dropdown can render a
            // product thumbnail next to each option. row.imageUrl
            // is already populated by apiClient.fetchInventory —
            // we just stopped throwing it away at the lookup step.
            imageUrl: (row as { imageUrl?: string | null }).imageUrl ?? null,
          }
        }
        setReceiveSkuMap(nextMap)
        setReceiveRows([createReceiveDraftRow()])
      } catch (error) {
        if (!active) return
        toastContext?.addToast(error instanceof Error ? error.message : 'Failed to load client SKUs', 'error')
      }
    }

    void loadReceiveSkuMap()

    return () => {
      active = false
    }
  }, [receiveClientId, toastContext])

  useEffect(() => {
    if (!skuDrawer || !canvasRef.current) return
    const canvas = canvasRef.current
    const redraw = () => drawSkuSalesChart(canvas, skuDrawer.dailySales)
    redraw()

    const resizeTarget = canvas.parentElement
    let observer: ResizeObserver | null = null
    if (resizeTarget && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(redraw)
      observer.observe(resizeTarget)
    }
    window.addEventListener('resize', redraw)

    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', redraw)
    }
  }, [skuDrawer])

  // Load parent SKUs whenever the Parent SKUs tab is active or its client filter changes.
  useEffect(() => {
    if (activeTab !== 'parents') return
    let active = true
    const load = async () => {
      setParentsLoading(true)
      try {
        const cid = parentsClientId ? Number.parseInt(parentsClientId, 10) : undefined
        // listParentSkus accepts clientId?; backend filters when provided.
        const rows = await apiClient.listParentSkus(cid as any)
        if (!active) return
        setParentsList(Array.isArray(rows) ? rows : [])
      } catch (error) {
        if (!active) return
        toastContext?.addToast(error instanceof Error ? error.message : 'Failed to load parent SKUs', 'error')
      } finally {
        if (active) setParentsLoading(false)
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [activeTab, parentsClientId, toastContext])

  // When switching to the Stock tab with a focused SKU, scroll + flash-highlight the row.
  useEffect(() => {
    if (activeTab !== 'stock' || !focusInvSkuId) return
    // Wait a tick for the stock rows to render.
    const timer = window.setTimeout(() => {
      const el = rowRefs.current[focusInvSkuId]
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
      // Clear the focus after 2.5s so the highlight fades.
      window.setTimeout(() => setFocusInvSkuId(null), 2500)
    }, 80)
    return () => window.clearTimeout(timer)
  }, [activeTab, focusInvSkuId, groupedRows])

  async function refreshInventoryView() {
    try {
      // Mirror the loadStock effect's query construction — pass
      // includeInactive only when the toolbar Active-only toggle
      // is OFF so manual refreshes match the current visible filter.
      const nextStockQuery = buildStockQuery(stockClientId, activeOnly, stockSearch, alertOnly, stockPage, stockPageSize)
      const [nextClients, nextPage] = await Promise.all([
        queryClient.fetchQuery({
          queryKey: ['clients'],
          queryFn: () => apiClient.fetchClients(),
          staleTime: 0,
        }),
        queryClient.fetchQuery({
          queryKey: ['inventory', 'stock', nextStockQuery],
          queryFn: () => apiClient.fetchInventoryPage(maybeQueryParams(nextStockQuery)),
          staleTime: 0,
        }),
      ])
      setClients(normalizeInventoryClients(nextClients))
      setItems(nextPage.items)
      if (activeTab === 'alerts' || alertOnly) {
        const nextAlerts = await queryClient.fetchQuery({
          queryKey: ['inventory', 'alerts'],
          queryFn: () => apiClient.fetchInventoryAlerts(),
          staleTime: 0,
        })
        setAlerts(nextAlerts)
      }
      if (activeTab === 'receive') {
        const nextPackages = await queryClient.fetchQuery({
          queryKey: ['packages', 'custom'],
          queryFn: () => apiClient.fetchPackages('custom'),
          staleTime: 0,
        })
        setPackages(nextPackages)
      }
      if (activeTab === 'history') {
        const nextLedger = await apiClient.fetchInventoryLedger(buildInventoryLedgerQuery({
          clientId: historyClientId,
          type: historyType,
          from: historyFrom,
          to: historyTo,
        }))
        setLedger(nextLedger)
      }
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Refresh failed', 'error')
    }
  }

  async function loadParentOptions(clientId: number) {
    if (parentSkuOptions[clientId]) return parentSkuOptions[clientId]
    const nextOptions = await apiClient.listParentSkus(clientId)
    setParentSkuOptions((current) => ({ ...current, [clientId]: nextOptions }))
    return nextOptions
  }

  function initializeBulkDrafts() {
    const nextDrafts: Record<number, { weightOz: string; productLength: string; productWidth: string; productHeight: string }> = {}
    for (const row of filteredRows) {
      nextDrafts[row.id] = {
        weightOz: String(row.weightOz ?? 0),
        productLength: String(row.productLength ?? 0),
        productWidth: String(row.productWidth ?? 0),
        productHeight: String(row.productHeight ?? 0),
      }
    }
    setBulkDrafts(nextDrafts)
  }

  async function handlePopulateInventory() {
    toastContext?.addToast('📥 Scanning orders for SKUs…')
    try {
      const result = await apiClient.populateInventory()
      toastContext?.addToast(`✅ Imported ${result.skusRegistered} SKUs, processed ${result.shippedProcessed} shipments`, 'success')
      await refreshInventoryView()
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Populate failed', 'error')
    }
  }

  // 🧹 Purge Test Data — calls the same /admin/purge-test-orders endpoint
  // SettingsView uses, but surfaces ALL the new counts (inventory rows,
  // print queue, overrides) since the Inventory page is where you'd
  // actually want to confirm test SKUs and ledger entries got cleared.
  // Single window.confirm matches the SettingsView UX (no double-confirm)
  // but the prompt text spells out exactly what happens so an accidental
  // click on a real client doesn't wipe data — the endpoint only ever
  // touches rows belonging to clients flagged is_test=true, so a real
  // client with no test flag is safe even if confirm gets miss-clicked.
  const [purgeBusy, setPurgeBusy] = useState(false)
  async function handlePurgeTestData() {
    if (purgeBusy) return
    if (
      !window.confirm(
        '🧹 Purge ALL data belonging to clients flagged is_test=true?\n\n' +
          'This deletes their orders, shipments, billing line items, ' +
          'inventory ledger entries, order overrides, print queue rows, ' +
          'AND the test SKUs themselves.\n\n' +
          'Real (non-test) clients are NOT touched. This cannot be undone.'
      )
    ) {
      return
    }
    setPurgeBusy(true)
    toastContext?.addToast('🧹 Purging test data…')
    try {
      const res = await api.post<{
        clients?: Array<{ id: number; name: string }>
        deleted: {
          orders: number
          shipments: number
          ledger: number
          billing: number
          inventory: number
          ledgerByInventory: number
          orderOverrides: number
          printQueue: number
          pkgLedger: number
          pkgStockRestored: number
          pkgsAffected: number
        }
        message?: string
      }>('/admin/purge-test-orders', {})

      const d = res.deleted
      const total =
        d.orders +
        d.shipments +
        d.ledger +
        d.billing +
        d.inventory +
        d.ledgerByInventory +
        d.orderOverrides +
        d.printQueue +
        d.pkgLedger

      if (total === 0) {
        toastContext?.addToast(res.message ?? '✓ Already clean — nothing to purge', 'success')
      } else {
        toastContext?.addToast(
          `✅ Purged: ${d.orders} orders, ${d.shipments} shipments, ` +
            `${d.inventory} test SKUs, ${d.ledger + d.ledgerByInventory} ledger, ` +
            `${d.billing} billing, ${d.orderOverrides} overrides, ${d.printQueue} queue, ` +
            `${d.pkgLedger} pkg-ledger (+${d.pkgStockRestored} stock restored)`,
          'success'
        )
      }
      await refreshInventoryView()
      // Notify Sidebar / OrdersView that test data is gone so their
      // counts refresh (same pattern handlePopulateInventory uses).
      window.dispatchEvent(new CustomEvent('prepship:client-active-changed'))
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Purge failed', 'error')
    } finally {
      setPurgeBusy(false)
    }
  }

  async function handleImportDims() {
    toastContext?.addToast('📐 Importing weight & dims from ShipStation…')
    try {
      const result = await apiClient.importInventoryDimensions(stockClientId ? Number.parseInt(stockClientId, 10) : undefined)
      toastContext?.addToast(`✅ Updated ${result.updated} SKUs — ${result.skipped} already had dims, ${result.noMatch} not in SS catalog`, 'success')
      await refreshInventoryView()
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Import failed', 'error')
    }
  }

  async function handleSaveBulkDims() {
    try {
      const result = await apiClient.bulkUpdateInventoryDimensions(buildBulkDimensionUpdates(filteredRows, bulkDrafts))
      setBulkEditMode(false)
      toastContext?.addToast(`✅ Saved dims for ${result.updated} SKUs`, 'success')
      await refreshInventoryView()
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Save failed', 'error')
    }
  }

  async function openEditSku(item: InventoryItemDto) {
    try {
      const tasks: Promise<unknown>[] = [loadParentOptions(item.clientId)]
      if (packages.length === 0) {
        tasks.push(
          queryClient.fetchQuery({
            queryKey: ['packages', 'custom'],
            queryFn: () => apiClient.fetchPackages('custom'),
            staleTime: 5 * 60_000,
          }).then((nextPackages) => setPackages(nextPackages))
        )
      }
      await Promise.all(tasks)
      setEditSkuForm(createEditSkuFormState(item))
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Failed to load parent SKUs', 'error')
    }
  }

  async function handleSaveSku() {
    if (!editSkuForm) return

    const updatePayload: UpdateInventoryItemInput = {
      name: items.find((row) => row.id === editSkuForm.invSkuId)?.name,
      minStock: Number.parseFloat(editSkuForm.minStock) || 0,
      weightOz: Number.parseFloat(editSkuForm.weightOz) || 0,
      length: Number.parseFloat(editSkuForm.packageLength) || 0,
      width: Number.parseFloat(editSkuForm.packageWidth) || 0,
      height: Number.parseFloat(editSkuForm.packageHeight) || 0,
      productLength: Number.parseFloat(editSkuForm.productLength) || 0,
      productWidth: Number.parseFloat(editSkuForm.productWidth) || 0,
      productHeight: Number.parseFloat(editSkuForm.productHeight) || 0,
      packageId: editSkuForm.packageId ? Number.parseInt(editSkuForm.packageId, 10) : null,
      units_per_pack: Math.max(1, Number.parseInt(editSkuForm.unitsPerPack, 10) || 1),
      cuFtOverride: (Number.parseFloat(editSkuForm.cuFtOverride) || 0) > 0 ? Number.parseFloat(editSkuForm.cuFtOverride) : null,
    }

    try {
      const nextParentSkuId = editSkuForm.parentSkuId ? Number.parseInt(editSkuForm.parentSkuId, 10) : null

      if (nextParentSkuId) {
        await apiClient.setInventoryParent(editSkuForm.invSkuId, {
          parentSkuId: nextParentSkuId,
          baseUnitQty: Math.max(1, Number.parseInt(editSkuForm.baseUnitQty, 10) || 1),
        })
      } else if (editSkuForm.previousParentSkuId) {
        await apiClient.setInventoryParent(editSkuForm.invSkuId, {
          parentSkuId: null,
        })
      }

      await apiClient.updateInventoryItem(editSkuForm.invSkuId, updatePayload)
      setEditSkuForm(null)
      toastContext?.addToast('✅ Saved', 'success')
      await refreshInventoryView()
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Save failed', 'error')
    }
  }

  async function handleCreateParent() {
    if (!parentModal) return
    if (!parentModal.name.trim()) {
      toastContext?.addToast('Parent name is required', 'error')
      return
    }

    try {
      const result: CreateParentSkuResult = await apiClient.createParentSku({
        clientId: parentModal.clientId,
        name: parentModal.name.trim(),
        sku: parentModal.sku.trim() || undefined,
        baseUnitQty: Math.max(1, Number.parseInt(parentModal.baseUnitQty, 10) || 1),
      })

      const nextOptions = await apiClient.listParentSkus(parentModal.clientId)
      setParentSkuOptions((current) => ({ ...current, [parentModal.clientId]: nextOptions }))
      setEditSkuForm((current) => {
        if (!current || current.clientId !== parentModal.clientId) return current
        return {
          ...current,
          parentSkuId: String(result.parentSkuId),
        }
      })
      setParentModal(null)
      toastContext?.addToast(`✅ Created parent: ${parentModal.name.trim()}`, 'success')
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Failed to create parent', 'error')
    }
  }

  async function handleInlineParentChange(row: InventoryItemDto, nextValue: string) {
    setInlineParentSaving(true)
    try {
      const nextParentSkuId = nextValue ? Number.parseInt(nextValue, 10) : null
      await apiClient.setInventoryParent(row.id, { parentSkuId: nextParentSkuId })
      toastContext?.addToast(
        nextParentSkuId ? '✅ Parent SKU assigned' : '✅ Parent SKU cleared',
        'success',
      )
      await refreshInventoryView()
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Failed to set parent SKU', 'error')
    } finally {
      setInlineParentSaving(false)
      setInlineParentRowId(null)
    }
  }

  async function handleCreateParentFromTab() {
    if (!parentsCreateForm.clientId) {
      toastContext?.addToast('Select a client first', 'error')
      return
    }
    if (!parentsCreateForm.name.trim()) {
      toastContext?.addToast('Parent name is required', 'error')
      return
    }
    try {
      await apiClient.createParentSku({
        clientId: parentsCreateForm.clientId,
        name: parentsCreateForm.name.trim(),
        sku: parentsCreateForm.sku.trim() || undefined,
        baseUnitQty: Math.max(1, Number.parseInt(parentsCreateForm.baseUnitQty, 10) || 1),
      })
      toastContext?.addToast(`✅ Created parent: ${parentsCreateForm.name.trim()}`, 'success')
      setParentsCreateOpen(false)
      setParentsCreateForm({ clientId: parentsCreateForm.clientId, name: '', sku: '', baseUnitQty: '1' })
      // Reload list (also reset the cache so the edit-SKU modal sees it).
      setParentSkuOptions((current) => ({ ...current, [parentsCreateForm.clientId]: undefined as any }))
      const cid = parentsClientId ? Number.parseInt(parentsClientId, 10) : undefined
      const rows = await apiClient.listParentSkus(cid as any)
      setParentsList(Array.isArray(rows) ? rows : [])
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Failed to create parent', 'error')
    }
  }

  async function handleReceiveSubmit() {
    if (!receiveClientId) {
      toastContext?.addToast('Select a client first', 'error')
      return
    }

    const itemsToReceive = buildReceiveItems(receiveRows, receiveSkuMap)
    if (!itemsToReceive.length) {
      toastContext?.addToast('Add at least one SKU with quantity', 'error')
      return
    }

    const receivedAt = receiveDate
      ? new Date(`${receiveDate}T12:00:00`).toISOString()
      : new Date().toISOString()

    try {
      const result = await apiClient.submitInventoryReceive({
        clientId: Number.parseInt(receiveClientId, 10),
        items: itemsToReceive,
        note: receiveNote.trim() || undefined,
        receivedAt,
      })

      const receivedRows = Array.isArray(result.received) ? result.received : []
      if (!result.ok || receivedRows.length === 0) {
        throw new Error(result.error || 'No inventory rows were received')
      }

      const dateLabel = new Date(receivedAt).toLocaleDateString()
      const failureNote = result.failed ? ` (${result.failed} failed)` : ''
      setReceiveResultMessage(`✅ Received ${receivedRows.length} SKU(s) on ${dateLabel}${failureNote}: ${receivedRows.map((row) => `${row.sku} (${row.qty} units → ${row.newStock} total)`).join(', ')}`)
      setHistoryClientId(receiveClientId)
      setHistoryType('receive')
      setHistoryFrom(receiveDate)
      setHistoryTo(receiveDate)
      setReceiveRows([createReceiveDraftRow()])
      setReceiveNote('')
      setReceiveDate(new Date().toISOString().slice(0, 10))
      await refreshInventoryView()
      toastContext?.addToast('Inventory received', 'success')
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Receive failed', 'error')
    }
  }

  async function handleSaveClient() {
    const selectedRateSourceClientId = clientForm.rateSourceClientId ? Number.parseInt(clientForm.rateSourceClientId, 10) : null
    const currentClientId = clientForm.clientId ? Number.parseInt(clientForm.clientId, 10) : null
    const rateSourceClientId =
      selectedRateSourceClientId != null && currentClientId != null && selectedRateSourceClientId === currentClientId
        ? null
        : selectedRateSourceClientId
    const payload: UpdateClientInput = {
      name: clientForm.name.trim(),
      contactName: clientForm.contactName.trim(),
      email: clientForm.email.trim(),
      phone: clientForm.phone.trim(),
      storeIds: clientForm.storeIds
        .split(',')
        .map((part) => Number.parseInt(part.trim(), 10))
        .filter((value) => Number.isFinite(value)),
      rateSourceClientId,
    }

    if (!payload.name) {
      toastContext?.addToast('Client name is required', 'error')
      return
    }

    try {
      if (clientForm.clientId) {
        await apiClient.updateClientRecord(Number.parseInt(clientForm.clientId, 10), payload)
        toastContext?.addToast('✅ Client updated', 'success')
      } else {
        await apiClient.createClientRecord(payload)
        toastContext?.addToast(`✅ Client "${payload.name}" added`, 'success')
      }

      setClientFormOpen(false)
      setClientForm(createClientFormState())
      await refreshInventoryView()
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Failed to save client', 'error')
    }
  }

  async function handleDeleteClient(client: ClientDto) {
    if (!window.confirm(`Delete client "${client.name}"? Their inventory records will be preserved.`)) return
    try {
      await apiClient.deleteClientRecord(client.clientId)
      toastContext?.addToast('✅ Client deleted', 'success')
      await refreshInventoryView()
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Delete failed', 'error')
    }
  }

  // Toggles the client's `active` flag — same behavior as the Test Orders
  // sidebar switch but per-client. Inactive clients are hidden from the
  // sidebar (init/stores already filters by active=true) and from the
  // sidebar bucket counts. Doesn't delete the client or its data.
  //
  // Optimistic UI: the toggle paints its target state immediately on click
  // (clientActiveOverrides), and the row gets an .is-pending visual
  // (pendingClientToggleId) so the user sees the slide animation right away
  // without waiting for the API round-trip. If the PATCH fails the override
  // is dropped (toggle snaps back) and a toast explains why.
  // 2026-05-12 confirmation gate: clicking the toggle no longer
  // mutates immediately — instead it stages the change in
  // `pendingActiveToggle` and ConfirmActiveToggleDialog appears. The
  // operator must explicitly confirm before the PATCH actually fires.
  // Prevents accidental disable-cascades since enable/disable now
  // propagates instantly across the whole app (per 60344e2/0fc5e14).
  const [pendingActiveToggle, setPendingActiveToggle] = useState<
    (ConfirmActiveTogglePending & { client: ClientDto }) | null
  >(null)
  const [confirmInFlight, setConfirmInFlight] = useState(false)

  function requestToggleClientActive(client: ClientDto) {
    if (pendingClientToggleId === client.clientId) return
    const next = !(client.active ?? true)
    setPendingActiveToggle({
      clientId: client.clientId,
      clientName: client.name ?? `Client #${client.clientId}`,
      nextActive: next,
      client,
    })
  }
  function cancelToggleClientActive() {
    setPendingActiveToggle(null)
  }
  async function confirmToggleClientActive() {
    const pending = pendingActiveToggle
    if (!pending) return
    setConfirmInFlight(true)
    try {
      await handleToggleClientActive(pending.client)
    } finally {
      setConfirmInFlight(false)
      setPendingActiveToggle(null)
    }
  }

  async function handleToggleClientActive(client: ClientDto) {
    if (pendingClientToggleId === client.clientId) return // ignore double-click while pending
    const next = !(client.active ?? true)
    setClientActiveOverrides((current) => ({ ...current, [client.clientId]: next }))
    setPendingClientToggleId(client.clientId)
    try {
      await apiClient.updateClientRecord(client.clientId, { active: next })
      toastContext?.addToast(
        `${next ? '✅' : '⏸️'} ${client.name} ${next ? 'enabled' : 'disabled'}`,
        'success'
      )
      // Real-time sidebar refresh: notify any listeners (sidebar
      // counts + store list) that client visibility just changed.
      // Without this, the sidebar would only refresh on its 10-second
      // interval or when the tab regained focus — meaning the user
      // sees the toggled client linger for several seconds before
      // disappearing. Custom DOM event is a zero-dep cross-component
      // notification channel that doesn't require lifting state up
      // through props.
      window.dispatchEvent(new CustomEvent('prepship:client-active-changed', {
        detail: { clientId: client.clientId, active: next }
      }))
      // 2026-05-12: full React Query cache flush across every surface
      // that reads client-keyed data. Mirrors pages/Clients.tsx so a
      // toggle from THIS view propagates exactly the same way as a
      // toggle from the admin Clients page — sidebar, dashboard,
      // analysis, billing, inventory all repaint within ms instead of
      // waiting for the 60s staleTime tick. Re-enable case especially:
      // toggling a client back ON immediately surfaces them everywhere.
      queryClient.invalidateQueries({ queryKey: ['clients'] })
      queryClient.invalidateQueries({ queryKey: ['clients-order-stats'] })
      queryClient.invalidateQueries({ queryKey: ['orders-count'] })
      queryClient.invalidateQueries({ queryKey: ['v2-hooks:clients'] })
      queryClient.invalidateQueries({ queryKey: ['v2-hooks:orders'] })
      queryClient.invalidateQueries({ queryKey: ['inventory'] })
      queryClient.invalidateQueries({ queryKey: ['billing-config'] })
      queryClient.invalidateQueries({ queryKey: ['billing-summary'] })
      queryClient.invalidateQueries({ queryKey: ['analysis-sku-breakdown'] })
      queryClient.invalidateQueries({ queryKey: ['analysis-sku-daily'] })
      await refreshInventoryView()
      // Drop the override — fresh server data is now authoritative.
      setClientActiveOverrides((current) => {
        const { [client.clientId]: _removed, ...rest } = current
        return rest
      })
    } catch (error) {
      // Revert: drop the override so the toggle snaps back to the server's
      // truth on next render.
      setClientActiveOverrides((current) => {
        const { [client.clientId]: _removed, ...rest } = current
        return rest
      })
      toastContext?.addToast(error instanceof Error ? error.message : 'Toggle failed', 'error')
    } finally {
      setPendingClientToggleId((current) => (current === client.clientId ? null : current))
    }
  }

  async function handleSyncClients() {
    setClientSyncStatus('Syncing…')
    try {
      const result = await apiClient.syncClientsFromStores()
      setClients(result.clients)
      setClientSyncStatus(`✅ ${result.clients.length} clients synced`)
      window.setTimeout(() => setClientSyncStatus(''), 4000)
    } catch (error) {
      setClientSyncStatus(error instanceof Error ? `⚠ Error: ${error.message}` : '⚠ Sync failed')
    }
  }

  async function openSkuDrawer(invSkuId: number) {
    setSkuDrawerOpen(true)
    setSkuDrawerLoading(true)
    setSkuDrawerError(null)
    setSkuDrawer(null)
    setSkuDrawerTitle('Loading…')
    try {
      const result = await apiClient.fetchInventorySkuOrders(invSkuId)
      setSkuDrawer(result)
      setSkuDrawerTitle(result.name || result.sku)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load SKU activity'
      setSkuDrawerError(message)
      setSkuDrawerTitle(error instanceof ApiError && error.status === 404 ? 'SKU not found' : 'Error')
    } finally {
      setSkuDrawerLoading(false)
    }
  }

  function openSkuDrawerOrder(order: InventorySkuOrdersDto['orders'][number]) {
    const orderId = Number(order?.orderId)
    if (!Number.isFinite(orderId) || orderId <= 0) return

    setOrderDetailModal({ orderId, status: order?.orderStatus ?? null })
  }

  async function handleAdjustSubmit() {
    if (!adjustModal) return
    const qty = Number.parseInt(adjustModal.qty, 10) || 0
    if (qty <= 0) {
      toastContext?.addToast('Enter a positive quantity', 'error')
      return
    }

    const signedQty = adjustModal.sign * qty
    const defaultNote = signedQty > 0 ? `Manual ${adjustModal.type}` : 'Manual remove'
    const adjustedAt = adjustModal.date
      ? new Date(`${adjustModal.date}T12:00:00`).toISOString()
      : new Date().toISOString()

    try {
      const result = await apiClient.submitInventoryAdjustment({
        invSkuId: adjustModal.invSkuId,
        qty: signedQty,
        note: adjustModal.note.trim() || defaultNote,
        type: adjustModal.type,
        adjustedAt,
      })
      setAdjustModal(null)
      toastContext?.addToast(`✅ ${adjustModal.type.charAt(0).toUpperCase()}${adjustModal.type.slice(1)} recorded on ${new Date(adjustedAt).toLocaleDateString()}. New total: ${result.newStock}`, 'success')
      await refreshInventoryView()
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Adjust failed', 'error')
    }
  }

  function showThumbnailPreview(src: string, event: ReactMouseEvent<HTMLImageElement>) {
    if (!src) return
    setThumbnailPreview({
      src,
      ...positionThumbnailPreview(event.clientX, event.clientY),
    })
  }

  return (
    <div
      id="view-inventory"
      className="view-content inventory-page-shell !p-0 !overflow-y-auto relative"
      style={!hideTabs ? {
        background:
          'radial-gradient(900px 500px at 8% 0%, rgb(var(--brand-rgb, 42 91 215) / 0.04), transparent 60%), radial-gradient(700px 400px at 100% 100%, rgb(var(--brand-rgb, 42 91 215) / 0.035), transparent 65%), rgb(var(--bg-rgb, 240 242 245))',
      } : undefined}
    >
      {/* 2026-05-14: Inventory header / tab system rewritten to match
          the SettingsView "icon-rail + section-header" pattern (operator
          request — boss wanted the same chrome across both pages so
          /inventory and /settings/markups feel like one design system,
          not two unrelated screens).

          Two render modes:
            • hideTabs=true  → legacy single-icon-+-title header. Used
              when InventoryView is embedded inside the Clients page
              (initialTab="clients" forced; no tab switching exposed).
              Adding the new rail + section header here would clutter
              the Clients page with redundant chrome.
            • hideTabs=false → new Settings-style chrome:
                1) Sticky horizontal icon rail (brand mark + per-tab
                   accent-toned pills + animated underline indicator)
                2) Animated section header (large gradient icon + tab
                   label + tab description + right-side action slot
                   for the existing 200 Low/Out shortcut)
          The activeTab state machine is unchanged — only the visual
          chrome around it is. */}
      {hideTabs ? null : (() => {
        // Resolve the active tab's metadata once per render so the rail
        // and the section header stay in sync. Falls back to the first
        // entry if activeTab is somehow unknown — defensive, shouldn't
        // happen given the typed state machine.
        const activeMeta = INVENTORY_TAB_META.find((t) => t.id === activeTab) ?? INVENTORY_TAB_META[0]
        const ActiveIcon = activeMeta.icon
        return (
          <div className="mb-4">
            {/* ─── HORIZONTAL ICON RAIL ─────────────────────────────
                Sticky strip across the top of the panel (negative
                margin pulls it flush with the page edges since the
                outer container has p-5). Brand mark on the left,
                hairline divider, then accent-toned tab pills with
                an animated underline indicator that morphs between
                positions via Framer's layoutId. */}
            <aside
              className="
                w-full
                border-b border-line
                bg-gradient-to-b from-surface-2 to-surface
                sticky top-0
                z-10
              "
              aria-label="Inventory sections"
            >
              <div
                className="
                  flex flex-row items-center gap-2
                  px-3 sm:px-5 py-3
                  overflow-x-auto
                "
                role="tablist"
              >
                {/* Brand mark — clicking returns to the default Stock
                    Levels view. Mirrors the Settings rail's "back to
                    start" affordance. */}
                <motion.button
                  type="button"
                  initial={{ rotate: -90, scale: 0.5, opacity: 0 }}
                  animate={{ rotate: 0, scale: 1, opacity: 1 }}
                  transition={{ type: 'spring', stiffness: 240, damping: 20, delay: 0.05 }}
                  whileHover={{ scale: 1.04 }}
                  whileTap={{ scale: 0.94 }}
                  onClick={() => setActiveTab('stock')}
                  className="flex w-10 h-10 sm:w-11 sm:h-11 mr-2 rounded-xl bg-gradient-to-br from-sky-500 to-sky-600 items-center justify-center shadow-md ring-1 ring-sky-400/20 flex-shrink-0"
                  title="Inventory — back to Stock Levels"
                  aria-label="Reset to Stock Levels"
                >
                  <Boxes size={18} strokeWidth={2.25} className="text-white" />
                </motion.button>

                {/* Hairline divider between brand mark and tab list */}
                <div className="hidden sm:block w-px h-7 bg-line/80 mr-1 flex-shrink-0" aria-hidden />

                {INVENTORY_TAB_META.map((tab, idx) => {
                  const Icon = tab.icon
                  const isActive = activeTab === tab.id
                  const accentText = INVENTORY_ACCENT_ICON_COLOR[tab.tone]
                  const accentBg = INVENTORY_ACCENT_ICON_BG[tab.tone]
                  // Alerts tab gets a count chip when there ARE alerts —
                  // mirrors the original "Alerts (200)" affordance so
                  // operators don't lose that signal. Other tabs render
                  // just the short label.
                  const showCount = tab.id === 'alerts' && alerts.length > 0
                  return (
                    <motion.button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      aria-controls={`inventory-panel-${tab.id}`}
                      id={`inventory-tab-${tab.id}`}
                      onClick={() => setActiveTab(tab.id)}
                      initial={{ opacity: 0, y: -6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{
                        duration: 0.32,
                        delay: 0.08 + idx * 0.04,
                        ease: [0.22, 1, 0.36, 1],
                      }}
                      whileHover={{ scale: isActive ? 1.0 : 1.06 }}
                      whileTap={{ scale: 0.94 }}
                      title={tab.label}
                      className={`
                        relative group
                        inline-flex items-center justify-center gap-2
                        h-11 px-3 sm:px-3.5
                        rounded-xl flex-shrink-0
                        transition-colors duration-200
                        focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50
                        ${isActive
                          ? `bg-gradient-to-br ${accentBg} ring-1`
                          : 'hover:bg-surface-2 ring-1 ring-transparent hover:ring-line'}
                      `}
                    >
                      {/* Active indicator bar — sits on the BOTTOM
                          edge of the active pill, morphs between
                          positions via Framer's layoutId. layoutId
                          is `inventory-active-indicator` (not the
                          Settings one) so the two pages don't try
                          to share the same animated element if they
                          ever mount in the same tree. */}
                      {isActive ? (
                        <motion.span
                          layoutId="inventory-active-indicator"
                          transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                          className={`
                            absolute bottom-[-9px] left-3 right-3
                            h-[3px] rounded-full
                            bg-gradient-to-r ${INVENTORY_ACCENT_GRADIENT[tab.tone]}
                          `}
                          aria-hidden
                        />
                      ) : null}
                      <Icon
                        size={18}
                        strokeWidth={isActive ? 2.5 : 2.0}
                        className={`transition-colors duration-200 ${isActive ? accentText : 'text-ink-3 group-hover:text-ink-2'}`}
                      />
                      <span
                        className={`
                          hidden sm:inline text-[12.5px] font-bold tracking-tight whitespace-nowrap
                          transition-colors duration-200
                          ${isActive ? accentText : 'text-ink-3 group-hover:text-ink-2'}
                        `}
                      >
                        {tab.short}
                      </span>
                      {/* Alert-count chip — only on the Alerts tab,
                          only when alerts exist. Sized to match the
                          tab pill text without dominating it. */}
                      {showCount ? (
                        <span
                          className={`
                            ml-0.5 inline-flex items-center justify-center
                            min-w-[20px] h-5 px-1.5 rounded-full
                            text-[10px] font-extrabold tabular-nums
                            ${isActive
                              ? 'bg-amber-500 text-white'
                              : 'bg-amber-100 text-amber-700 ring-1 ring-amber-200'}
                          `}
                          aria-label={`${alerts.length} alerts`}
                        >
                          {alerts.length}
                        </span>
                      ) : null}
                    </motion.button>
                  )
                })}
              </div>
            </aside>

            {/* ─── SECTION HEADER ───────────────────────────────────
                Animated header (icon + title + description + action
                slot). Re-keys on activeTab so AnimatePresence treats
                each tab switch as a fresh enter/exit and the icon
                spring-rotates in. mb-4 spacing mirrors the original
                header so downstream toolbar layouts don't shift. */}
            <AnimatePresence mode="wait">
              <motion.header
                key={activeMeta.id}
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                className={INVENTORY_HEADER_CLASS}
              >
                <motion.div
                  initial={{ scale: 0.6, rotate: -8, opacity: 0 }}
                  animate={{ scale: 1, rotate: 0, opacity: 1 }}
                  transition={{ type: 'spring', stiffness: 280, damping: 18, delay: 0.05 }}
                  className={`
                    w-12 h-12 sm:w-14 sm:h-14 rounded-2xl flex-shrink-0
                    bg-gradient-to-br ${INVENTORY_ACCENT_ICON_BG[activeMeta.tone]} ring-1
                    flex items-center justify-center
                    shadow-sm
                  `}
                >
                  <ActiveIcon
                    size={22}
                    strokeWidth={2.25}
                    className={INVENTORY_ACCENT_ICON_COLOR[activeMeta.tone]}
                  />
                </motion.div>
                <div className="flex-1 min-w-0 pt-0.5">
                  <h2 className="text-[22px] sm:text-[26px] font-extrabold text-ink font-display tracking-[-0.022em] leading-tight m-0">
                    {viewTitle ?? activeMeta.label}
                  </h2>
                  <p className="text-[12.5px] sm:text-[13px] text-ink-3 mt-1.5 leading-relaxed max-w-3xl">
                    {activeMeta.description}
                  </p>
                </div>
                <div className={INVENTORY_HEADER_ACTIONS_CLASS}>
                  {activeTab === 'stock' ? (
                    <>
                      <span ref={setColumnsAnchor} className="inventory-columns-anchor" />
                      <button className="btn btn-outline btn-sm inventory-action-button" type="button" onClick={handlePopulateInventory}>
                        <Download size={13} strokeWidth={2.25} />
                        <span>Import SKUs from Orders</span>
                      </button>
                      <button className="btn btn-outline btn-sm inventory-action-button" type="button" onClick={handleImportDims} title="Pull weight & dims from ShipStation product catalog into inventory SKUs">
                        <Ruler size={13} strokeWidth={2.25} />
                        <span>Import Dims from SS</span>
                      </button>
                      <button
                        className="btn btn-outline btn-sm inventory-action-button"
                        type="button"
                        onClick={() => {
                          if (bulkEditMode) {
                            setBulkEditMode(false)
                            return
                          }
                          initializeBulkDrafts()
                          setBulkEditMode(true)
                        }}
                        style={bulkEditMode ? { background: 'var(--ss-blue)', color: '#fff', borderColor: 'var(--ss-blue)' } : undefined}
                      >
                        <Pencil size={13} strokeWidth={2.25} />
                        <span>{bulkEditMode ? 'Exit Bulk' : 'Bulk Edit'}</span>
                      </button>
                    </>
                  ) : null}
                  {alerts.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => {
                        setActiveTab('stock')
                        setAlertOnly(true)
                      }}
                      className="inventory-alert-shortcut"
                      title={`Jump to Stock Levels filtered to ${alerts.length} Low/Out SKUs`}
                    >
                      <AlertTriangle size={14} strokeWidth={2.5} />
                      <span className="tabular-nums">{alerts.length} Low/Out</span>
                    </button>
                  ) : null}
                  {activeTab === 'stock' ? (
                    <button
                      className="btn btn-outline btn-sm inventory-action-button inventory-action-button--danger"
                      type="button"
                      onClick={() => void handlePurgeTestData()}
                      disabled={purgeBusy}
                      title="Delete every order, shipment, inventory SKU, and ledger entry that belongs to a client flagged is_test=true. Does NOT touch real clients."
                      style={{
                        opacity: purgeBusy ? 0.6 : 1,
                        cursor: purgeBusy ? 'wait' : 'pointer',
                      }}
                    >
                      <Trash2 size={13} strokeWidth={2.25} />
                      <span>{purgeBusy ? 'Purging...' : 'Purge Test Data'}</span>
                    </button>
                  ) : null}
                  <button className="btn btn-outline btn-sm inventory-action-button" type="button" onClick={() => void refreshInventoryView()}>
                    <RefreshCw size={13} strokeWidth={2.25} />
                    <span>Refresh</span>
                  </button>
                </div>
              </motion.header>
            </AnimatePresence>
          </div>
        )
      })()}

      {hideTabs ? (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          className="flex items-center gap-4 mb-4 flex-wrap"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-sky-500 to-sky-600 flex items-center justify-center shadow-md ring-1 ring-sky-400/20">
              <Boxes size={20} strokeWidth={2.25} className="text-white" />
            </div>
            <h2 className="text-[16px] font-extrabold text-ink font-display tracking-tight m-0">{viewTitle ?? 'Inventory'}</h2>
          </div>
          <div style={{ flex: 1 }} />
          <button className="btn btn-outline btn-sm inventory-action-button" type="button" onClick={() => void refreshInventoryView()}>
            <RefreshCw size={13} strokeWidth={2.25} />
            <span>Refresh</span>
          </button>
        </motion.div>
      ) : null}

      {bootError ? (
        <div className="empty-state" style={{ marginBottom: 12 }}>Error: {bootError}</div>
      ) : null}

      {activeTab === 'stock' ? (
        <div id="inv-panel-stock" className={INVENTORY_PANEL_CLASS}>
          <div className="inventory-stock-toolbar">
            <div className="search-wrap inventory-stock-search">
              <input
                type="text"
                value={stockSearch}
                onChange={(event) => setStockSearch(event.target.value)}
                placeholder="Filter SKU or name…"
                style={{ width: '100%' }}
              />
            </div>
            <select className="filter-sel" value={stockClientId} onChange={(event) => setStockClientId(event.target.value)}>
              <option value="">All Clients</option>
              {clients.map((client) => (
                <option key={client.clientId} value={client.clientId}>{client.name}</option>
              ))}
            </select>
            <label className="inventory-filter-check">
              <input type="checkbox" checked={alertOnly} onChange={(event) => setAlertOnly(event.target.checked)} /> Low/Out only
            </label>
            {/* Status mode toggle — pill-style switch that swaps
                between TWO distinct views (NOT a show/hide filter):
                  ON  → "Active only" view (just active SKUs)
                  OFF → "Deactivated only" view (just deactivated SKUs)
                Label text changes with the mode so operators always
                know which view they're looking at. The pill colors
                also flip semantics — green when in "active" mode,
                slate when in "deactivated" mode. */}
            <button
              type="button"
              role="switch"
              aria-checked={activeOnly}
              aria-label={activeOnly ? 'Active SKUs view — click to switch to Deactivated' : 'Deactivated SKUs view — click to switch to Active'}
              onClick={() => setActiveOnly((v) => !v)}
              title={activeOnly ? 'Showing active SKUs · click to switch to deactivated' : 'Showing deactivated SKUs · click to switch to active'}
              className="inventory-active-switch inline-flex items-center gap-2 cursor-pointer"
            >
              <span
                className={`relative inline-flex items-center w-7 h-3.5 rounded-full transition-colors duration-150 ${activeOnly ? 'bg-emerald-500' : 'bg-slate-300'}`}
                aria-hidden="true"
              >
                <span
                  className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white shadow-sm transition-transform duration-150 ${activeOnly ? 'translate-x-[14px]' : 'translate-x-0.5'}`}
                />
              </span>
              {activeOnly ? 'Active only' : 'Deactivated only'}
              {/* 2026-05-12: Inline status badge always shows the
                  count of DEACTIVATED SKUs (the "other side" of the
                  mutex). In Active mode this hints how many items
                  exist in the deactivated view; in Deactivated mode
                  it confirms the count visible on screen. When the
                  count is zero we explicitly say so — italic, with
                  a tooltip — so flipping the toggle into an empty
                  view doesn't look like a bug. */}
              {inactiveCount > 0 ? (
                <span
                  style={{
                    color: 'var(--text3)',
                    fontSize: 11,
                    fontWeight: 500,
                    marginLeft: 2,
                  }}
                >
                  · {inactiveCount} deactivated
                </span>
              ) : (
                <span
                  style={{
                    color: 'var(--text3)',
                    fontSize: 11,
                    fontStyle: 'italic',
                    marginLeft: 2,
                  }}
                  title="No SKUs are currently deactivated — toggling will show an empty view"
                >
                  · no deactivated SKUs
                </span>
              )}
            </button>
          </div>

          {bulkEditMode ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, padding: '8px 12px', background: 'var(--ss-blue-bg)', border: '1px solid var(--ss-blue)', borderRadius: 8 }}>
              <span style={{ fontSize: 12, color: 'var(--ss-blue)', fontWeight: 600, flex: 1 }}>✏️ Bulk Dims Mode — edit weight & dims inline, then save all at once</span>
              <button className="btn btn-primary btn-sm" type="button" onClick={handleSaveBulkDims}>💾 Save All</button>
              <button className="btn btn-outline btn-sm" type="button" onClick={() => setBulkEditMode(false)}>✕ Cancel</button>
            </div>
          ) : null}

          {stockLoading ? (
            <div className="loading"><div className="spinner" /><div style={{ fontSize: 12, marginTop: 4 }}>Loading inventory…</div></div>
          ) : sortedRows.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">📭</div>
              <div>
                {alertOnly
                  ? 'No low/out stock'
                  : activeOnly
                    ? 'No active SKUs found'
                    : inactiveCount === 0
                      ? 'No deactivated SKUs · everything is active'
                      : 'No deactivated SKUs match the current filters'}
              </div>
            </div>
          ) : !bulkEditMode ? (
            /* 2026-05-12: NORMAL mode now uses the shared <Table>
               primitive (web/src/components/ui/Table.tsx) per the
               inventory-table-component-design.md refactor. The
               bulk-edit branch below keeps its bespoke grouped
               render because bulk-edit's alternate column set
               (sku + thumbnail + name + store + weight + L + W + H)
               doesn't share schema with normal mode. <Table>
               internally manages sort/widths/order/visibility/
               pagination — Inventory's matching bespoke state still
               exists in this file but is now redundant for normal
               mode (cleanup is a follow-up commit). */
            <Table
              data={filteredRows}
              columns={inventoryColumns}
              rowKey={(row) => row.id}
              storageKey="inventory-stock-levels"
              onRowClick={(row) => void openSkuDrawer(row.id)}
              paginated
              pageSizeOptions={[10, 20, 50, 100, 200]}
              defaultPageSize={50}
              serverPagination={{
                page: stockPage,
                pageSize: stockPageSize,
                totalItems: stockTotal,
                onPageChange: setStockPage,
                onPageSizeChange: (nextSize) => {
                  setStockPageSize(nextSize)
                  setStockPage(1)
                },
              }}
              // 2026-05-13: portal the Columns ▾ button to the
              // page-level toolbar (left of "Import SKUs from
              // Orders"). When `columnsAnchor` is null (initial
              // render, before the span mounts), Table falls back
              // to inline rendering — but the span mounts on the
              // same tick, so the callback ref fires and Table
              // re-renders with the portal target set. No flicker.
              columnsAnchorEl={columnsAnchor}
              // Deactivated SKUs are pinned to the bottom of the
              // sorted result so active rows always appear first.
              // Operator's chosen sort still orders rows WITHIN each
              // group (active rows among themselves, inactive among
              // themselves).
              pinRowToBottom={(row) => row.active === false}
              // Row classes: stack two visual treatments:
              //   • focused-row flash (when navigating from the
              //     SKU drawer) — soft blue fade
              //   • inactive-row greyscale — desaturates + dims the
              //     row so it reads as "paused, not gone"
              rowClassName={(row) => {
                const classes: string[] = []
                if (row.active === false) classes.push('inventory-row-inactive')
                if (focusInvSkuId === row.id) classes.push('inventory-row-focused')
                return classes.join(' ') || undefined
              }}
              loading={stockLoading}
              emptyMessage={
                alertOnly
                  ? 'No low/out stock'
                  : activeOnly
                    ? 'No active SKUs found'
                    : inactiveCount === 0
                      ? 'No deactivated SKUs · everything is active'
                      : 'No deactivated SKUs match the current filters'
              }
            />
          ) : (
            <div id="inv-stock-content">
              {groupedRows.map((group) => (
                <div key={group.clientId} style={{ marginBottom: 18 }}>
                  {/* 2026-05-12: switched the wrapper from overflow-x:auto
                      to overflow-x:clip — same trade-off the prior comment
                      identified, but flipped per operator request. With
                      overflow-x:auto the wrapper was the nearest overflow
                      ancestor for sticky resolution, so the thead never
                      stuck during page-level vertical scroll. With
                      overflow-x:clip the wrapper still clips wide tables
                      (visually identical until you'd scroll horizontally)
                      but does NOT establish a scroll context — so the
                      sticky thead now correctly pins to view-content's
                      vertical scroll. Operators hide columns via the
                      Columns popover instead of scrolling horizontally
                      on narrow screens. */}
                  <div className="inventory-stock-scroll relative rounded-card border border-line bg-white shadow-sm overflow-x-clip">
                    <table
                      className={[
                        // Layout
                        'w-full m-0 table-fixed border-separate border-spacing-0',
                        'inventory-stock-table',

                        // ─── Section title row (brand-colored client name) ───
                        // Sticky at top:0 so the title pins above column
                        // headers when scrolling long lists. z-[80] sits
                        // above column-header z-[70] but below modal overlays.
                        '[&_thead_tr:first-child_th]:sticky [&_thead_tr:first-child_th]:top-0 [&_thead_tr:first-child_th]:z-[80]',
                        '[&_thead_tr:first-child_th]:h-9 [&_thead_tr:first-child_th]:rounded-t-card',
                        '[&_thead_tr:first-child_th]:!bg-brand-bg [&_thead_tr:first-child_th]:text-ink-3',
                        '[&_thead_tr:first-child_th]:border-b [&_thead_tr:first-child_th]:border-line',
                        '[&_thead_tr:first-child_th]:px-4 [&_thead_tr:first-child_th]:text-left',
                        '[&_thead_tr:first-child_th]:text-2xs [&_thead_tr:first-child_th]:font-extrabold',
                        '[&_thead_tr:first-child_th]:uppercase [&_thead_tr:first-child_th]:tracking-[0.05em]',
                        '[&_thead_tr:first-child_th]:shadow-[0_1px_0_rgba(225,228,232,1)]',

                        // ─── Column header row (sortable + draggable headers) ─
                        // Sticky at top-9 so it sits directly below the
                        // section-title row above. The :not() selector
                        // excludes the title row's th from these styles —
                        // first-child rules above own that one.
                        '[&_thead_tr:not(:first-child)_th]:sticky [&_thead_tr:not(:first-child)_th]:top-9 [&_thead_tr:not(:first-child)_th]:z-[70]',
                        '[&_thead_tr:not(:first-child)_th]:bg-surface-2 [&_thead_tr:not(:first-child)_th]:text-ink-3',
                        '[&_thead_tr:not(:first-child)_th]:text-[10px] [&_thead_tr:not(:first-child)_th]:font-extrabold [&_thead_tr:not(:first-child)_th]:uppercase [&_thead_tr:not(:first-child)_th]:tracking-[0.4px]',
                        '[&_thead_tr:not(:first-child)_th]:text-left [&_thead_tr:not(:first-child)_th]:px-2.5 [&_thead_tr:not(:first-child)_th]:py-2',
                        '[&_thead_tr:not(:first-child)_th]:border-b-2 [&_thead_tr:not(:first-child)_th]:border-line [&_thead_tr:not(:first-child)_th]:whitespace-nowrap',
                        '[&_thead_tr:not(:first-child)_th]:shadow-[0_1px_0_var(--border)]',

                        // ─── Body cells ──────────────────────────────────
                        '[&_tbody_td]:px-2.5 [&_tbody_td]:py-2 [&_tbody_td]:text-[12px]',
                        '[&_tbody_td]:border-b [&_tbody_td]:border-line [&_tbody_td]:align-middle',
                        '[&_tbody_td]:overflow-hidden [&_tbody_td]:text-ellipsis',

                        // Last row: drop the bottom border so it doesn't
                        // double up against the wrapper's bottom border.
                        '[&_tbody_tr:last-child_td]:border-b-0',

                        // Zebra striping + hover state on body rows —
                        // matches the Packages table's row polish.
                        '[&_tbody_tr:nth-child(odd)]:bg-white [&_tbody_tr:nth-child(even)]:bg-surface-2',
                        '[&_tbody_tr:hover_td]:bg-brand-bg/60',
                      ].join(' ')}
                      style={bulkEditMode ? { minWidth: 860 } : { minWidth: inventoryTableMinWidth }}
                    >
                      {/* colgroup pins column widths so EVERY client's table
                          renders the same layout — auto-sizing was the cause
                          of the visual drift between groups. */}
                      {bulkEditMode ? (
                        <colgroup>
                          <col style={{ width: 140 }} />
                          <col style={{ width: 48 }} />
                          <col />
                          <col style={{ width: 130 }} />
                          <col style={{ width: 90 }} />
                          <col style={{ width: 72 }} />
                          <col style={{ width: 72 }} />
                          <col style={{ width: 72 }} />
                        </colgroup>
                      ) : (
                        // Colgroup iterates effectiveInventoryColumns so
                        // reorder/hide preserves alignment. Per-column
                        // width resolution: operator drag > INVENTORY_
                        // COLUMN_DEFAULT_WIDTHS > flex-fill (only 'name'
                        // is intentionally undefined → flex-fill). Under
                        // table-fixed these widths are authoritative —
                        // a resize on one column moves only that column.
                        <colgroup>
                          {effectiveInventoryColumns.map((key) => {
                            const explicit = inventoryColumnWidths[key]
                            const fallback = INVENTORY_COLUMN_DEFAULT_WIDTHS[key]
                            const w = explicit ?? fallback
                            return <col key={key} style={w ? { width: w } : undefined} />
                          })}
                        </colgroup>
                      )}
                      <thead>
                        {/* Section title row — brand-bg colspan cell
                            showing the client name. Sticky at top:0
                            so it pins above the column headers when
                            scrolling. The colSpan tracks bulk-edit vs
                            normal column count so the bar always spans
                            the full table. Mirrors PackagesDataTable's
                            section-title-inside-thead pattern. */}
                        <tr>
                          <th
                            colSpan={bulkEditMode ? 8 : effectiveInventoryColumns.length}
                            scope="colgroup"
                          >
                            {group.clientName}
                          </th>
                        </tr>
                        {bulkEditMode ? (
                          <tr>
                            {renderStockSortHeader('sku', 'SKU')}
                            <th />
                            {renderStockSortHeader('name', 'Name')}
                            {renderStockSortHeader('store', 'Store')}
                            {renderStockSortHeader('weight', 'Wt (oz)', { align: 'right' })}
                            {renderStockSortHeader('length', 'L (in)', { align: 'right' })}
                            {renderStockSortHeader('width', 'W (in)', { align: 'right' })}
                            {renderStockSortHeader('height', 'H (in)', { align: 'right' })}
                          </tr>
                        ) : (
                          // Headers iterate the operator's chosen
                          // column order so dragging a header into
                          // a new position also reorders the body
                          // cells (which use the same effectiveColumns
                          // list). Bulk-edit mode above stays on the
                          // legacy hardcoded layout — it's a different
                          // 8-column view where reorder doesn't apply.
                          <tr>
                            {effectiveInventoryColumns.map((key) => renderInventoryColumnHeader(key))}
                          </tr>
                        )}
                      </thead>
                      <tbody>
                        {group.rows.map((row) => {
                          if (bulkEditMode) {
                            const draft = bulkDrafts[row.id] ?? {
                              weightOz: String(row.weightOz ?? 0),
                              productLength: String(row.productLength ?? 0),
                              productWidth: String(row.productWidth ?? 0),
                              productHeight: String(row.productHeight ?? 0),
                            }
                            return (
                              <tr key={row.id}>
                                <td style={{ fontFamily: 'monospace', fontSize: 11 }}>{row.sku}</td>
                                <td style={{ padding: '4px 6px' }}>
                                  {row.imageUrl ? (
                                    <img src={row.imageUrl} style={{ width: 32, height: 32, objectFit: 'cover', borderRadius: 4, display: 'block' }} />
                                  ) : (
                                    <div style={{ width: 32, height: 32, background: 'var(--surface3)', borderRadius: 4, border: '1px dashed var(--border)' }} />
                                  )}
                                </td>
                                <td style={{ fontSize: 11.5, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name || '—'}</td>
                                <td style={{ fontSize: 11.5, color: 'var(--text2)', whiteSpace: 'nowrap' }} title={row.clientName || undefined}>
                                  {row.clientName || <span style={{ color: 'var(--text4)' }}>&mdash;</span>}
                                </td>
                                <td><input type="number" step="0.1" min="0" value={draft.weightOz} onChange={(event) => setBulkDrafts((current) => ({ ...current, [row.id]: { ...draft, weightOz: event.target.value } }))} style={{ padding: '3px 5px', border: '1px solid var(--border2)', borderRadius: 4, background: 'var(--surface2)', color: 'var(--text)', fontSize: 11.5, width: '100%', boxSizing: 'border-box' }} /></td>
                                <td><input type="number" step="0.1" min="0" value={draft.productLength} onChange={(event) => setBulkDrafts((current) => ({ ...current, [row.id]: { ...draft, productLength: event.target.value } }))} style={{ padding: '3px 5px', border: '1px solid var(--border2)', borderRadius: 4, background: 'var(--surface2)', color: 'var(--text)', fontSize: 11.5, width: '100%', boxSizing: 'border-box' }} /></td>
                                <td><input type="number" step="0.1" min="0" value={draft.productWidth} onChange={(event) => setBulkDrafts((current) => ({ ...current, [row.id]: { ...draft, productWidth: event.target.value } }))} style={{ padding: '3px 5px', border: '1px solid var(--border2)', borderRadius: 4, background: 'var(--surface2)', color: 'var(--text)', fontSize: 11.5, width: '100%', boxSizing: 'border-box' }} /></td>
                                <td><input type="number" step="0.1" min="0" value={draft.productHeight} onChange={(event) => setBulkDrafts((current) => ({ ...current, [row.id]: { ...draft, productHeight: event.target.value } }))} style={{ padding: '3px 5px', border: '1px solid var(--border2)', borderRadius: 4, background: 'var(--surface2)', color: 'var(--text)', fontSize: 11.5, width: '100%', boxSizing: 'border-box' }} /></td>
                              </tr>
                            )
                          }

                          const cuFt = getInventoryCuFt(row)
                          const isFocused = focusInvSkuId === row.id
                          return (
                            <tr
                              key={row.id}
                              ref={(el) => { rowRefs.current[row.id] = el }}
                              style={isFocused ? { background: 'var(--ss-blue-bg)', transition: 'background 1.5s ease' } : undefined}
                            >
                              {/* Body cells dispatch by column key so they
                                  render in the operator's chosen order and
                                  only when the column is visible. Each
                                  branch produces the same JSX the
                                  hardcoded version produced. */}
                              {effectiveInventoryColumns.map((columnKey) => {
                                switch (columnKey) {
                                  case 'sku':
                                    return (
                                      <td key="sku" style={{ fontFamily: 'monospace', fontSize: 11.5, minWidth: 0 }}>
                                        <button type="button" className="inventory-inline-button inventory-cell-link--nowrap" style={{ color: 'var(--ss-blue)' }} onClick={() => void openSkuDrawer(row.id)} title={`${row.sku} - view orders & sales trend`}>{row.sku}</button>
                                      </td>
                                    )
                                  case 'thumbnail':
                                    return (
                                      <td key="thumbnail" style={{ padding: '4px 6px' }}>
                                        {row.imageUrl ? (
                                          <img
                                            src={row.imageUrl}
                                            style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 5, display: 'block', cursor: 'zoom-in' }}
                                            onMouseEnter={(event) => showThumbnailPreview(row.imageUrl ?? '', event)}
                                            onMouseLeave={() => setThumbnailPreview(null)}
                                          />
                                        ) : (
                                          <div style={{ width: 40, height: 40, background: 'var(--surface3)', border: '1px dashed var(--border)', borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, color: 'var(--text4)', textAlign: 'center', lineHeight: 1.2 }}>no<br />img</div>
                                        )}
                                      </td>
                                    )
                                  case 'name':
                                    return (
                                      <td key="name" style={{ fontSize: 12, minWidth: 0 }}>
                                        <button type="button" className="inventory-inline-button inventory-cell-link--clamp" onClick={() => void openSkuDrawer(row.id)} title={`${row.name || row.sku || 'SKU'} - view orders & sales trend`}>{row.name || <span style={{ color: 'var(--text3)' }}>—</span>}</button>
                                      </td>
                                    )
                                  case 'store':
                                    return (
                                      <td key="store" style={{ fontSize: 11.5, color: 'var(--text2)', whiteSpace: 'nowrap' }} title={row.clientName || undefined}>
                                        {row.clientName || <span style={{ color: 'var(--text4)' }}>&mdash;</span>}
                                      </td>
                                    )
                                  case 'weight':
                                    return (
                                      <td key="weight" style={{ textAlign: 'right', fontSize: 11.5 }}>{row.weightOz > 0 ? formatWeight(row.weightOz) : <span style={{ color: 'var(--text4)' }}>—</span>}</td>
                                    )
                                  case 'dims':
                                    return (
                                      <td key="dims" style={{ textAlign: 'center', fontSize: 11.5, fontFamily: 'monospace' }}>{row.packageLength > 0 || row.packageWidth > 0 || row.packageHeight > 0 ? `${row.packageLength}×${row.packageWidth}×${row.packageHeight}` : <span style={{ color: 'var(--text4)' }}>—</span>}</td>
                                    )
                                  case 'cuFt':
                                    return (
                                      <td key="cuFt" style={{ textAlign: 'center', fontSize: 11, color: 'var(--text3)' }}>
                                        {cuFt > 0 ? (
                                          <span title={row.cuFtOverride && row.cuFtOverride > 0 ? 'Manual override' : 'Auto-computed from product dims'}>
                                            {cuFt.toFixed(3)}{row.cuFtOverride && row.cuFtOverride > 0 ? <span style={{ color: 'var(--ss-blue)', fontSize: 9, marginLeft: 2 }}>✎</span> : null}
                                          </span>
                                        ) : (
                                          <span style={{ color: 'var(--text4)' }}>—</span>
                                        )}
                                      </td>
                                    )
                                  case 'package':
                                    // Falls back to L×W×H dimensions when no
                                    // named package is assigned — previously a
                                    // bare "—" left the cell empty even when
                                    // the row carried usable dim data.
                                    return (
                                      <td key="package" style={{ fontSize: 11.5 }}>
                                        {row.packageName ? (
                                          row.packageName
                                        ) : (row.packageLength > 0 || row.packageWidth > 0 || row.packageHeight > 0) ? (
                                          <span style={{ fontFamily: 'monospace', color: 'var(--text3)' }} title="No named package — showing product dims (L×W×H)">
                                            {row.packageLength}×{row.packageWidth}×{row.packageHeight}
                                          </span>
                                        ) : (
                                          <span style={{ color: 'var(--text4)' }}>—</span>
                                        )}
                                      </td>
                                    )
                                  case 'stock': {
                                    // 2026-05-13: STOCK now shows the
                                    // operator-correct value computed
                                    // backend-side as `total_received −
                                    // total_sold_all_time` (effectiveStock),
                                    // not the cached stockQty / currentStock.
                                    // currentStock kept available as a
                                    // tooltip fallback so power users can
                                    // see the cached number if they ever
                                    // need to diff against the ledger.
                                    const displayStock = getInventoryDisplayStock(row)
                                    return (
                                      <td
                                        key="stock"
                                        title={getInventoryStockTooltip(row)}
                                        style={{ textAlign: 'center', fontWeight: 700, fontSize: 13, color: displayStock <= 0 ? 'var(--red)' : 'var(--text)' }}
                                      >
                                        {displayStock}
                                      </td>
                                    )
                                  }
                                  case 'sold30':
                                    return (
                                      <td key="sold30" style={{ textAlign: 'center', fontWeight: 700, fontSize: 12, color: (row.soldLast30Days ?? 0) > 0 ? 'var(--ss-blue)' : 'var(--text3)' }}>{row.soldLast30Days ?? 0}</td>
                                    )
                                  case 'unitsPerPack':
                                    return (
                                      <td key="unitsPerPack" style={{ textAlign: 'center', fontSize: 12, color: 'var(--text3)' }}>
                                        {row.units_per_pack > 1 ? <span style={{ background: 'var(--ss-blue-bg)', color: 'var(--ss-blue)', fontSize: 10.5, fontWeight: 700, padding: '1px 6px', borderRadius: 4 }}>×{row.units_per_pack}</span> : '—'}
                                      </td>
                                    )
                                  case 'totalUnits': {
                                    // Use effective stock here too so the
                                    // totalUnits column (effective ×
                                    // units_per_pack) stays consistent.
                                    const displayStock = getInventoryDisplayStock(row)
                                    return (
                                      <td key="totalUnits" style={{ textAlign: 'center', fontSize: 12, color: 'var(--text2)' }}>{row.units_per_pack > 1 ? <span style={{ fontWeight: 700 }}>{displayStock * row.units_per_pack}</span> : '—'}</td>
                                    )
                                  }
                                  case 'min':
                                    return (
                                      <td key="min" style={{ textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>{row.minStock}</td>
                                    )
                                  case 'status':
                                    return (
                                      <td key="status" style={{ textAlign: 'center' }}>
                                        <span className={`stock-badge ${row.status === 'out' ? 'stock-out' : row.status === 'low' ? 'stock-low' : 'stock-ok'}`}>
                                          {row.status === 'out' ? 'OUT' : row.status === 'low' ? 'LOW' : 'OK'}
                                        </span>
                                      </td>
                                    )
                                  case 'actions':
                                    // Action cell — pencil edit, chain-link
                                    // parent SKU (popover via Portal so it
                                    // escapes td's overflow:hidden), icon-only
                                    // ± stock-adjust button, and a per-row
                                    // Active pill toggle that optimistically
                                    // PATCHes the SKU's active flag.
                                    return (
                                      <td key="actions" style={{ whiteSpace: 'nowrap', padding: '4px 8px' }}>
                                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                          <button
                                            className="btn btn-ghost btn-xs"
                                            type="button"
                                            onClick={(event) => { event.stopPropagation(); void openEditSku(row) }}
                                            title="Edit SKU details"
                                            style={{ flex: '0 0 auto' }}
                                          >
                                            ✏️
                                          </button>
                                          {/* Chain-link → opens the parent SKU
                                              popover. Captures `event.currentTarget`
                                              as the popover anchor so the
                                              portal'd popover (rendered at the
                                              bottom of this component) can
                                              compute its viewport coords from
                                              the trigger's bounding rect. */}
                                          <button
                                            className="btn btn-ghost btn-xs"
                                            type="button"
                                            title={row.parentSkuId ? 'Change parent SKU' : 'Assign parent SKU'}
                                            onClick={async (event) => {
                                              event.stopPropagation()
                                              // Snapshot the trigger element BEFORE awaiting
                                              // anything — React event objects get pooled and
                                              // currentTarget becomes null after the await.
                                              const triggerEl = event.currentTarget as HTMLElement
                                              try {
                                                await loadParentOptions(row.clientId)
                                                setInlineParentRowId((current) => {
                                                  const next = current === row.id ? null : row.id
                                                  setParentPopoverAnchor(next == null ? null : triggerEl)
                                                  return next
                                                })
                                              } catch (error) {
                                                toastContext?.addToast(error instanceof Error ? error.message : 'Failed to load parents', 'error')
                                              }
                                            }}
                                            style={{ fontSize: 12, color: row.parentSkuId ? 'var(--ss-blue)' : 'var(--text3)', flex: '0 0 auto' }}
                                          >
                                            🔗
                                          </button>
                                          {/* Icon-only ± Adjust button. Square
                                              pill, no text — operators asked for
                                              less horizontal clutter. The button's
                                              title attribute keeps the affordance
                                              discoverable on hover. */}
                                          <button
                                            type="button"
                                            onClick={(event) => {
                                              event.stopPropagation()
                                              setAdjustModal({
                                                invSkuId: row.id,
                                                sku: row.sku,
                                                qty: '1',
                                                note: '',
                                                date: new Date().toISOString().slice(0, 10),
                                                type: 'adjust',
                                                sign: 1,
                                              })
                                            }}
                                            title="Adjust stock — add or remove units"
                                            aria-label="Adjust stock"
                                            style={{
                                              display: 'inline-flex',
                                              alignItems: 'center',
                                              justifyContent: 'center',
                                              width: 22,
                                              height: 22,
                                              padding: 0,
                                              border: '1px solid var(--ss-blue)',
                                              borderRadius: 999,
                                              background: 'rgba(42,91,215,0.08)',
                                              color: 'var(--ss-blue)',
                                              fontSize: 12,
                                              fontWeight: 800,
                                              cursor: 'pointer',
                                              lineHeight: 1,
                                              flex: '0 0 auto',
                                            }}
                                          >
                                            ±
                                          </button>
                                          {/* Per-row Active toggle. Same pill
                                              vocabulary as the toolbar's "Active
                                              only" filter — green ON, slate OFF,
                                              white pip translating 14px. Clicking
                                              fires handleToggleRowActive which
                                              optimistically flips the local
                                              `items` row and PATCHes the server. */}
                                          <button
                                            type="button"
                                            role="switch"
                                            aria-checked={row.active !== false}
                                            aria-label={row.active !== false ? `Deactivate ${row.sku}` : `Activate ${row.sku}`}
                                            onClick={(event) => { event.stopPropagation(); void handleToggleRowActive(row) }}
                                            disabled={togglingActiveIds.has(row.id)}
                                            title={row.active !== false ? 'Active · click to deactivate' : 'Inactive · click to activate'}
                                            style={{
                                              background: 'none',
                                              border: 0,
                                              padding: 0,
                                              cursor: togglingActiveIds.has(row.id) ? 'wait' : 'pointer',
                                              opacity: togglingActiveIds.has(row.id) ? 0.5 : 1,
                                              flex: '0 0 auto',
                                            }}
                                          >
                                            <span
                                              className={`relative inline-flex items-center w-7 h-3.5 rounded-full transition-colors duration-150 ${row.active !== false ? 'bg-emerald-500' : 'bg-slate-300'}`}
                                              aria-hidden="true"
                                            >
                                              <span
                                                className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white shadow-sm transition-transform duration-150 ${row.active !== false ? 'translate-x-[14px]' : 'translate-x-0.5'}`}
                                              />
                                            </span>
                                          </button>
                                        </div>
                                      </td>
                                    )
                                  default:
                                    return null
                                }
                              })}
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
              {/* Pagination — operator-controlled page size + page nav.
                  Renders below the inventory tables. Reuses
                  AnalysisPagination so all paginated lists in the app
                  share the same visual + behavior vocabulary
                  (Packages, Analysis SKU grid, now Inventory). The
                  totalItems counter reflects the full sortedRows length,
                  not just the current page's worth, so operators see
                  the real result count of their filters. */}
              {stockTotal > 0 ? (
                <div style={{ marginTop: 12 }}>
                  <AnalysisPagination
                    page={stockPage}
                    pageSize={stockPageSize}
                    pageSizeOptions={[...INVENTORY_PAGE_SIZE_OPTIONS]}
                    totalItems={stockTotal}
                    onPageChange={setStockPage}
                    onPageSizeChange={(nextSize) => {
                      setStockPageSize(nextSize)
                      setStockPage(1)
                    }}
                    unitLabel="SKUs"
                    ariaLabel="Inventory pagination"
                  />
                </div>
              ) : null}
            </div>
          )}
        </div>
      ) : null}

      {activeTab === 'receive' ? (
        <div id="inv-panel-receive" className={INVENTORY_PANEL_CLASS}>
          <div id="inv-receive-worksheet" className="w-full max-w-[1280px] rounded-lg border border-line bg-surface shadow-sm">
            <div className="flex flex-wrap items-center gap-3 border-b border-line bg-surface-2 px-4 py-3">
              <div className="flex min-w-[220px] flex-1 items-center gap-2">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-emerald-50 text-emerald-600 ring-1 ring-emerald-200">
                  <ClipboardList size={17} strokeWidth={2.1} />
                </span>
                <div className="min-w-0">
                  <div className="text-[13px] font-extrabold text-ink">Batch worksheet</div>
                  <div className="truncate text-[11px] text-ink-3">
                    {selectedReceiveClient ? selectedReceiveClient.name : 'Choose a client to load SKU options'}
                  </div>
                </div>
              </div>
              <div className="ml-auto grid grid-cols-3 gap-2 text-right max-sm:w-full max-sm:text-left">
                <div className="rounded-md bg-surface px-3 py-1.5 ring-1 ring-line">
                  <div className="text-[10px] font-bold uppercase tracking-[0.04em] text-ink-3">Rows</div>
                  <div className="text-[15px] font-extrabold text-ink">{receiveSummary.rowCount}</div>
                </div>
                <div className="rounded-md bg-surface px-3 py-1.5 ring-1 ring-line">
                  <div className="text-[10px] font-bold uppercase tracking-[0.04em] text-ink-3">Valid SKUs</div>
                  <div className="text-[15px] font-extrabold text-ink">{receiveSummary.validSkuCount}</div>
                </div>
                <div className="rounded-md bg-surface px-3 py-1.5 ring-1 ring-line">
                  <div className="text-[10px] font-bold uppercase tracking-[0.04em] text-ink-3">Total units</div>
                  <div className="text-[15px] font-extrabold text-ink">{receiveSummary.totalUnits}</div>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-[minmax(220px,300px)_minmax(260px,1fr)_minmax(170px,210px)] items-end gap-3 border-b border-line px-4 py-3 max-md:grid-cols-1">
              <label className={RECEIVE_FIELD_CLASS}>
                <span className={RECEIVE_LABEL_CLASS}>Client</span>
                <select className={`${RECEIVE_INPUT_CLASS} pr-8`} value={receiveClientId} onChange={(event) => setReceiveClientId(event.target.value)}>
                  <option value="">Select Client...</option>
                  {clients.map((client) => (
                    <option key={client.clientId} value={client.clientId}>{client.name}</option>
                  ))}
                </select>
              </label>
              <label className={RECEIVE_FIELD_CLASS}>
                <span className={RECEIVE_LABEL_CLASS}>Reference</span>
                <input type="text" value={receiveNote} onChange={(event) => setReceiveNote(event.target.value)} className={RECEIVE_INPUT_CLASS} placeholder="PO, shipment ref, or note" />
              </label>
              <label className={RECEIVE_FIELD_CLASS}>
                <span className={RECEIVE_LABEL_CLASS}>Received on</span>
                <input type="date" value={receiveDate} onChange={(event) => setReceiveDate(event.target.value)} className={RECEIVE_INPUT_CLASS} />
              </label>
            </div>
            <div className="overflow-x-auto">
              <div className="min-w-0 md:min-w-[900px]">
                <div className="grid grid-cols-[32px_minmax(0,1fr)_42px] items-center border-b border-line bg-surface-2 px-4 py-2 text-[10px] font-extrabold uppercase tracking-[0.04em] text-ink-3 md:grid-cols-[44px_minmax(520px,1fr)_96px_150px_48px]">
                  <div>#</div>
                  <div>SKU or product</div>
                  <div className="hidden text-right md:block">Qty</div>
                  <div className="hidden text-right md:block">Units</div>
                  <div />
                </div>
            <div id="inv-recv-rows" className="divide-y divide-line">
              {receiveRows.map((row, index) => {
                const rawSku = row.sku.trim()
                const lookup =
                  rawSku
                    ? receiveSkuMap[rawSku] ??
                      Object.entries(receiveSkuMap).find(([candidate]) => candidate.toLowerCase() === rawSku.toLowerCase())?.[1] ??
                      null
                    : null
                const hints = getReceiveRowHints(row, lookup)
                const packQty = Number.parseInt(row.qty, 10) || 0
                const unitsPerPack = Math.max(1, Number.parseInt(String(lookup?.unitsPerPack ?? 1), 10) || 1)
                const rowTotalUnits = packQty > 0 ? packQty * unitsPerPack : 0
                return (
                  <div key={row.id} className="grid grid-cols-[32px_minmax(0,1fr)_42px] items-start gap-3 px-4 py-3 transition-colors hover:bg-surface-2/70 md:grid-cols-[44px_minmax(520px,1fr)_96px_150px_48px]">
                    <div className="contents">
                      <div className="pt-2 text-[11px] font-bold tabular-nums text-ink-3">{index + 1}</div>
                      {/* 2026-05-15: Was a native <input list=
                          "react-recv-sku-datalist">. Chrome rendered
                          that as an unstyleable, unfilterable 300+
                          row scroll list — operator complaint. Now
                          a real autosuggest combobox: type to
                          filter, ranked matches with product name
                          shown beneath each SKU code, arrow-key
                          navigation, Enter to pick. Reusable
                          component (web/src/components/Autosuggest.tsx)
                          ready for parent-SKU picker, bulk-edit,
                          new-order modal next. */}
                      <div className="min-w-0 max-md:col-span-2">
                        <Autosuggest
                          value={row.sku}
                          options={receiveSkuOptions}
                          placeholder="Search SKU or name"
                          ariaLabel="SKU or product name"
                          inputClassName={`${RECEIVE_INPUT_CLASS} h-9 font-mono`}
                          popoverClassName="right-auto max-w-[calc(100vw-2rem)]"
                          // Receive Inventory SKU dropdown escapes worksheet overflow clipping.
                          renderInPortal
                          maxResults={receiveSkuOptions.length || 50}
                          emptyMessage={
                            row.sku.trim()
                              ? `No SKU matches "${row.sku.trim()}"`
                              : null
                          }
                          onChange={(nextSku) => {
                            setReceiveRows((current) =>
                              current.map((entry) => {
                                if (entry.id !== row.id) return entry
                                return applyReceiveSkuInput(
                                  { ...entry, sku: nextSku },
                                  receiveSkuMap[nextSku.trim()] ?? null,
                                )
                              }),
                            )
                          }}
                          onSelect={(option) => {
                            // onSelect fires AFTER onChange has
                            // already pushed the picked value, so
                            // we don't need to re-apply here. Logged
                            // for analytics-style hooks later if
                            // needed. Currently a no-op intentionally.
                            void option
                          }}
                        />
                        {row.name ? (
                          <div className="mt-1 truncate pl-1 text-[11.5px] font-semibold text-ink" title={row.name}>
                            {row.name}
                          </div>
                        ) : (
                          <div className="mt-1 pl-1 text-[11.5px] text-ink-3">Select a SKU to fill details</div>
                        )}
                        <div className="mt-1 flex min-h-[18px] flex-wrap items-center gap-1.5 text-[10.5px] text-ink-3">
                          {hints.packHint ? (
                            <span className="rounded bg-emerald-50 px-1.5 py-0.5 font-bold text-emerald-700 ring-1 ring-emerald-200">{hints.packHint}</span>
                          ) : null}
                        </div>
                      </div>
                      <div className="max-md:col-start-2 max-md:w-28">
                        <input
                          type="number"
                          className={`${RECEIVE_INPUT_CLASS} h-9 text-right tabular-nums`}
                          placeholder="0"
                          min="1"
                          value={row.qty}
                          onChange={(event) => setReceiveRows((current) => current.map((entry) => entry.id === row.id ? { ...entry, qty: event.target.value } : entry))}
                        />
                      </div>
                      <div className="pt-1.5 text-right max-md:col-start-2 max-md:text-left">
                        <div className="text-[13px] font-extrabold tabular-nums text-ink">{rowTotalUnits || '-'}</div>
                        <div className="mt-0.5 min-h-[14px] text-[10px] font-bold text-brand">{hints.totalHint ?? ''}</div>
                      </div>
                      <button className="mt-1 inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-3 transition hover:bg-danger-bg hover:text-danger focus:outline-none focus:ring-2 focus:ring-danger/20 max-md:col-start-3 max-md:row-start-1" type="button" onClick={() => setReceiveRows((current) => current.length === 1 ? [createReceiveDraftRow()] : current.filter((entry) => entry.id !== row.id))} title="Remove row" aria-label={`Remove receive row ${index + 1}`}>
                        <Trash2 size={15} strokeWidth={2} />
                      </button>
                    </div>
                  </div>
                )
              })}
              {/* 2026-05-15: <datalist id="react-recv-sku-datalist">
                  removed — Autosuggest above replaced it. The
                  unstyleable native datalist showed all 300+ SKUs
                  unfiltered; the new combobox filters as you type
                  and is keyboard-navigable. */}
            </div>
              </div>
            </div>
            <div id="inv-receive-summary" className="flex flex-wrap items-center gap-3 border-t border-line bg-surface-2 px-4 py-3">
              <div className="flex min-w-[220px] flex-1 items-center gap-2 text-[11.5px] text-ink-2">
                <CheckCircle2 size={16} className="text-emerald-600" />
                <span>
                  Ready to receive <strong className="text-ink">{receiveSummary.totalUnits}</strong> total units across <strong className="text-ink">{receiveSummary.validSkuCount}</strong> validated SKU row(s).
                </span>
              </div>
              <button className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-line bg-surface px-3 text-[12px] font-bold text-ink transition hover:bg-surface-2" type="button" onClick={() => setReceiveRows((current) => [...current, createReceiveDraftRow()])}>
                <Plus size={14} strokeWidth={2.2} />
                Add SKU
              </button>
              <button className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-brand px-3.5 text-[12px] font-bold text-white shadow-sm transition hover:bg-brand/90" type="button" onClick={handleReceiveSubmit}>
                <CheckCircle2 size={14} strokeWidth={2.2} />
                Receive All
              </button>
            </div>
            {receiveResultMessage ? (
              <div className="border-t border-emerald-200 bg-emerald-50 px-4 py-3 text-[12px] font-medium text-emerald-700">
                {receiveResultMessage}{' '}
                <button type="button" className="font-bold text-brand underline" onClick={() => setActiveTab('history')}>
                  View History
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {activeTab === 'clients' ? (
        <div id="inv-panel-clients">
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-primary btn-sm" type="button" onClick={() => {
              setClientFormOpen(true)
              setClientForm(createClientFormState())
            }}>
              ＋ Add Client
            </button>
            <button className="btn btn-outline btn-sm" type="button" onClick={() => void handleSyncClients()}>↻ Sync from ShipStation</button>
            <span style={{ fontSize: 11.5, color: 'var(--text3)' }}>{clientSyncStatus}</span>
          </div>

          {clientFormOpen ? (
            <div style={{ display: '', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 14, maxWidth: 540 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginBottom: 10 }}>{clientForm.clientId ? 'Edit Client' : 'Add Client'}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={{ fontSize: 11, color: 'var(--text3)' }}>Client Name *</label>
                  <input type="text" className="ship-select" style={{ width: '100%' }} value={clientForm.name} onChange={(event) => setClientForm((current) => ({ ...current, name: event.target.value }))} />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text3)' }}>Contact Name</label>
                  <input type="text" className="ship-select" style={{ width: '100%' }} value={clientForm.contactName} onChange={(event) => setClientForm((current) => ({ ...current, contactName: event.target.value }))} />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text3)' }}>Email</label>
                  <input type="text" className="ship-select" style={{ width: '100%' }} value={clientForm.email} onChange={(event) => setClientForm((current) => ({ ...current, email: event.target.value }))} />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text3)' }}>Phone</label>
                  <input type="text" className="ship-select" style={{ width: '100%' }} value={clientForm.phone} onChange={(event) => setClientForm((current) => ({ ...current, phone: event.target.value }))} />
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={{ fontSize: 11, color: 'var(--text3)' }}>Rate Source Account</label>
                  <select className="ship-select" style={{ width: '100%' }} value={clientForm.rateSourceClientId} onChange={(event) => setClientForm((current) => ({ ...current, rateSourceClientId: event.target.value }))}>
                    <option value="">DR PREPPER</option>
                    {rateSourceOptions.map((client) => (
                      <option key={client.clientId} value={client.clientId}>{client.name}</option>
                    ))}
                  </select>
                </div>
                {/* Chip-style storeIds editor — replaces the previous
                    comma-separated text input with individually-removable
                    chips so users can drop a single store ID without
                    counting commas. The underlying value is still stored
                    as a comma-separated string in clientForm.storeIds (so
                    handleSaveClient's existing parse logic still works);
                    this is purely a UI-layer transformation. */}
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={{ fontSize: 11, color: 'var(--text3)' }}>ShipStation Store IDs</label>
                  {(() => {
                    const ids = clientForm.storeIds
                      .split(',')
                      .map((s) => s.trim())
                      .filter((s) => s.length > 0 && /^\d+$/.test(s))
                    const removeId = (target: string) => {
                      const next = ids.filter((id) => id !== target).join(', ')
                      setClientForm((current) => ({ ...current, storeIds: next }))
                    }
                    const addIdFromKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
                      if (e.key !== 'Enter' && e.key !== ',' && e.key !== ' ') return
                      e.preventDefault()
                      const raw = (e.currentTarget.value ?? '').trim()
                      if (!raw || !/^\d+$/.test(raw) || ids.includes(raw)) {
                        e.currentTarget.value = ''
                        return
                      }
                      const next = [...ids, raw].join(', ')
                      setClientForm((current) => ({ ...current, storeIds: next }))
                      e.currentTarget.value = ''
                    }
                    return (
                      <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5 rounded-md ring-1 ring-line bg-surface min-h-[36px]">
                        {ids.length === 0 ? (
                          <span className="text-[11px] italic text-ink-3 px-1">No store IDs yet — type below to add</span>
                        ) : (
                          ids.map((id) => {
                            const storeName = storeNameMap.get(Number(id))
                            return (
                              <span
                                key={id}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-brand/10 text-brand text-[11.5px] font-mono font-semibold ring-1 ring-brand/20"
                                title={storeName ? `Store: ${storeName}` : 'Unrecognized store ID'}
                              >
                                #{id}
                                {storeName ? (
                                  <span className="text-[10px] font-sans font-normal text-ink-3 not-italic">({storeName})</span>
                                ) : null}
                                <button
                                  type="button"
                                  onClick={() => removeId(id)}
                                  className="ml-0.5 inline-flex items-center justify-center w-4 h-4 rounded text-brand hover:text-white hover:bg-brand transition"
                                  aria-label={`Remove store ID ${id}`}
                                  title={`Remove ${id}`}
                                >
                                  ×
                                </button>
                              </span>
                            )
                          })
                        )}
                        <input
                          type="text"
                          inputMode="numeric"
                          pattern="\d*"
                          placeholder={ids.length === 0 ? 'e.g. 356678' : '+ add another'}
                          onKeyDown={addIdFromKey}
                          onBlur={(e) => {
                            const raw = e.currentTarget.value.trim()
                            if (raw && /^\d+$/.test(raw) && !ids.includes(raw)) {
                              setClientForm((current) => ({ ...current, storeIds: [...ids, raw].join(', ') }))
                            }
                            e.currentTarget.value = ''
                          }}
                          className="flex-1 min-w-[100px] px-1 py-0.5 text-[12px] bg-transparent border-0 outline-none text-ink placeholder:text-ink-3"
                        />
                      </div>
                    )
                  })()}
                  {/* Multi-store warning — explains the merge semantics so
                      users intentionally adding 2+ IDs know what they're
                      doing (and users who see 2+ existing IDs understand
                      why). */}
                  {clientForm.storeIds.split(',').filter((s) => s.trim()).length > 1 ? (
                    <div className="mt-1.5 text-[10.5px] text-ink-3 leading-snug">
                      <span className="font-semibold text-amber-700">⚠ Multi-store client:</span>{' '}
                      Orders from all listed stores will roll up under this single client for billing, analytics, and reporting. Press <kbd className="px-1 py-0.5 rounded bg-surface-2 ring-1 ring-line text-[10px] font-mono">Enter</kbd> or <kbd className="px-1 py-0.5 rounded bg-surface-2 ring-1 ring-line text-[10px] font-mono">,</kbd> to add an ID; click <kbd className="px-1 py-0.5 rounded bg-surface-2 ring-1 ring-line text-[10px] font-mono">×</kbd> to remove one.
                    </div>
                  ) : (
                    <div className="mt-1.5 text-[10.5px] text-ink-3 leading-snug">
                      Press <kbd className="px-1 py-0.5 rounded bg-surface-2 ring-1 ring-line text-[10px] font-mono">Enter</kbd> or <kbd className="px-1 py-0.5 rounded bg-surface-2 ring-1 ring-line text-[10px] font-mono">,</kbd> to add a store ID.
                    </div>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <button className="btn btn-ghost btn-sm" type="button" onClick={() => {
                  setClientFormOpen(false)
                  setClientForm(createClientFormState())
                }}>
                  Cancel
                </button>
                <button className="btn btn-primary btn-sm" type="button" onClick={handleSaveClient}>💾 Save Client</button>
              </div>
            </div>
          ) : null}

          {!clients.length ? (
            <div className="empty-state">
              <div className="empty-icon">🏢</div>
              <div style={{ marginBottom: 10 }}>No clients yet.</div>
              <button className="btn btn-primary btn-sm" type="button" onClick={() => void handleSyncClients()}>↻ Import from ShipStation Stores</button>
            </div>
          ) : (
            // Tailwind-only Clients table — sticky headers, theme-aware,
            // border-separate so sticky on <th> works (border-collapse:collapse
            // silently disables sticky in all major browsers).
            <div className="bg-surface ring-1 ring-line rounded-lg">
              <table
                className={[
                  'w-full m-0 border-separate border-spacing-0',
                  '[&_thead_th]:sticky [&_thead_th]:top-[-1px] [&_thead_th]:z-10',
                  '[&_thead_th]:bg-surface-2 [&_thead_th]:text-ink-3',
                  '[&_thead_th]:text-[10px] [&_thead_th]:font-extrabold [&_thead_th]:uppercase [&_thead_th]:tracking-[0.4px]',
                  '[&_thead_th]:text-left [&_thead_th]:px-2.5 [&_thead_th]:py-2',
                  '[&_thead_th]:border-b-2 [&_thead_th]:border-line [&_thead_th]:whitespace-nowrap',
                  '[&_thead_th]:shadow-[0_1px_0_var(--border)]',
                  '[&_tbody_td]:px-2.5 [&_tbody_td]:py-2 [&_tbody_td]:text-[12px]',
                  '[&_tbody_td]:border-b [&_tbody_td]:border-line [&_tbody_td]:align-middle',
                  '[&_tbody_tr:last-child_td]:border-b-0',
                  '[&_tbody_tr:hover_td]:bg-surface-2',
                ].join(' ')}
              >
                <thead>
                  <tr>
                    <SortableHeader sortKey="name" sortState={clientsSort} onSort={handleClientsSort}>Name</SortableHeader>
                    <SortableHeader sortKey="contact" sortState={clientsSort} onSort={handleClientsSort}>Contact</SortableHeader>
                    <SortableHeader sortKey="email" sortState={clientsSort} onSort={handleClientsSort}>Email</SortableHeader>
                    <SortableHeader sortKey="storeId" sortState={clientsSort} onSort={handleClientsSort}>Store ID</SortableHeader>
                    <SortableHeader sortKey="source" sortState={clientsSort} onSort={handleClientsSort}>Source</SortableHeader>
                    <SortableHeader sortKey="rateSource" sortState={clientsSort} onSort={handleClientsSort}>Rate Source</SortableHeader>
                    <SortableHeader sortKey="active" sortState={clientsSort} onSort={handleClientsSort} align="center" style={{ textAlign: 'center', width: 70 }}>Active</SortableHeader>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sortedClients.map((client) => {
                    const override = clientActiveOverrides[client.clientId]
                    const isActive = override !== undefined ? override : (client.active ?? true)
                    const isPending = pendingClientToggleId === client.clientId

                    // Source detection — infers the integration channel.
                    //
                    // Priority order:
                    //   1. Any storeId in real ShipStation range (1-99999999,
                    //      excluding the 9_000_000+ synthetic range) →
                    //      SHIPSTATION. eBay/Walmart marketplace clients
                    //      whose orders SYNC THROUGH ShipStation get tagged
                    //      ShipStation here (e.g. "eBay - DJC" with storeId
                    //      #356678 is a ShipStation store that happens to
                    //      sell on eBay; the source is still ShipStation).
                    //   2. Synthetic storeIds (≥ 9_000_000) indicate a
                    //      direct marketplace integration NOT routed through
                    //      ShipStation (e.g. "Walmart Store" #9000001 from
                    //      Jake's direct Walmart Marketplace API). Match
                    //      those by name pattern to the right marketplace.
                    //   3. No storeIds AND no name match → MANUAL.
                    //
                    // The synthetic-ID threshold of 9_000_000 reflects the
                    // convention used in this codebase to flag non-ShipStation
                    // store rows. Real ShipStation store IDs are 6 digits.
                    const SHIPSTATION_MAX = 9_000_000
                    const hasShipStationId = client.storeIds.some((id) => id > 0 && id < SHIPSTATION_MAX)
                    const lowerName = (client.name ?? '').toLowerCase()
                    const sourceInfo: { label: string; cls: string } = hasShipStationId
                      ? { label: 'ShipStation', cls: 'bg-indigo-50 text-indigo-700 ring-indigo-200' }
                      : lowerName.includes('walmart')
                        ? { label: 'Walmart', cls: 'bg-blue-50 text-blue-700 ring-blue-200' }
                        : lowerName.includes('ebay')
                          ? { label: 'eBay', cls: 'bg-rose-50 text-rose-700 ring-rose-200' }
                          : lowerName.includes('amazon')
                            ? { label: 'Amazon', cls: 'bg-amber-50 text-amber-700 ring-amber-200' }
                            : lowerName.includes('shopify')
                              ? { label: 'Shopify', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200' }
                              : lowerName.includes('etsy')
                                ? { label: 'Etsy', cls: 'bg-orange-50 text-orange-700 ring-orange-200' }
                                : lowerName.includes('tiktok')
                                  ? { label: 'TikTok Shop', cls: 'bg-pink-50 text-pink-700 ring-pink-200' }
                                  : lowerName.includes('woo') || lowerName.includes('woocomm')
                                    ? { label: 'WooCommerce', cls: 'bg-violet-50 text-violet-700 ring-violet-200' }
                                    : lowerName.includes('bigcomm') || lowerName.includes('bigcommerce')
                                      ? { label: 'BigCommerce', cls: 'bg-cyan-50 text-cyan-700 ring-cyan-200' }
                                      : client.storeIds.length > 0
                                        ? { label: 'Direct', cls: 'bg-violet-50 text-violet-700 ring-violet-200' }
                                        : { label: 'Manual', cls: 'bg-slate-100 text-slate-600 ring-slate-200' }

                    return (
                    <tr key={client.clientId} style={{ opacity: isActive ? 1 : 0.55, transition: 'opacity .28s ease' }}>
                      <td style={{ fontWeight: 600 }}>{client.name}</td>
                      <td style={{ fontSize: 12 }}>{client.contactName || '—'}</td>
                      <td style={{ fontSize: 12 }}>{client.email || '—'}</td>
                      {/* Store ID — each ID rendered as a small chip with
                          the resolved ShipStation store name in the tooltip
                          (so admins can hover to see what each ID maps to
                          without leaving the table). */}
                      <td>
                        {client.storeIds.length === 0 ? (
                          <span style={{ color: 'var(--text4)' }}>—</span>
                        ) : (
                          <div className="flex flex-wrap items-center gap-1">
                            {client.storeIds.map((id) => {
                              const storeName = storeNameMap.get(id)
                              return (
                                <span
                                  key={id}
                                  className="inline-flex items-center px-1.5 py-px rounded bg-surface-2 text-ink-2 text-[11px] font-mono font-semibold ring-1 ring-line/70"
                                  title={storeName ? `${storeName}` : 'Unrecognized store'}
                                >
                                  #{id}
                                </span>
                              )
                            })}
                          </div>
                        )}
                      </td>
                      {/* Source — colored badge inferred from client name +
                          presence of storeIds. See sourceInfo computation
                          above. */}
                      <td>
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10.5px] font-bold uppercase tracking-wide ring-1 ${sourceInfo.cls}`}
                          title={`Inferred from client name${client.storeIds.length ? ' + ShipStation store IDs' : ''}`}
                        >
                          {sourceInfo.label}
                        </span>
                      </td>
                      <td style={{ fontSize: 12, fontWeight: 500 }}>{getClientRateSourceLabel(client)}</td>
                      <td style={{ textAlign: 'center' }}>
                        <button
                          type="button"
                          className={`ss-test-toggle${isActive ? ' is-on' : ' is-off'}${isPending ? ' is-pending' : ''}`}
                          aria-label={isActive ? `Disable ${client.name}` : `Enable ${client.name}`}
                          aria-busy={isPending}
                          title={isPending ? 'Saving…' : isActive ? `Disable ${client.name} (hide from sidebar + views)` : `Enable ${client.name}`}
                          onClick={() => requestToggleClientActive(client)}
                          disabled={isPending}
                        >
                          <span className="ss-test-toggle-knob" />
                        </button>
                      </td>
                      <td>
                        <button className="btn btn-ghost btn-xs" type="button" onClick={() => {
                          setClientFormOpen(true)
                          setClientForm(createClientFormState(client))
                        }}>
                          Edit
                        </button>
                        <button className="btn btn-ghost btn-xs" type="button" onClick={() => void handleDeleteClient(client)}>
                          Delete
                        </button>
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      {activeTab === 'history' ? (
        <div id="inv-panel-history" className={INVENTORY_PANEL_CLASS}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <select className="filter-sel" value={historyClientId} onChange={(event) => setHistoryClientId(event.target.value)}>
              <option value="">All Clients</option>
              {clients.map((client) => (
                <option key={client.clientId} value={client.clientId}>{client.name}</option>
              ))}
            </select>
            <select className="filter-sel" value={historyType} onChange={(event) => setHistoryType(event.target.value)}>
              <option value="">All Types</option>
              <option value="receive">Receive</option>
              <option value="ship">Ship</option>
              <option value="adjust">Adjust</option>
              <option value="return">Return</option>
              <option value="damage">Damage</option>
            </select>
            <input type="date" className="filter-sel" style={{ fontSize: 11.5, padding: '4px 6px', width: 'auto' }} value={historyFrom} onChange={(event) => setHistoryFrom(event.target.value)} title="From date" />
            <span style={{ color: 'var(--text3)', fontSize: 11 }}>–</span>
            <input type="date" className="filter-sel" style={{ fontSize: 11.5, padding: '4px 6px', width: 'auto' }} value={historyTo} onChange={(event) => setHistoryTo(event.target.value)} title="To date" />
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => {
              setHistoryFrom('')
              setHistoryTo('')
            }} title="Clear dates">
              ✕ Clear
            </button>
          </div>

          {historyLoading ? (
            <div className="loading"><div className="spinner" /></div>
          ) : !ledger.length ? (
            <div className="empty-state">No movements found</div>
          ) : (
            <div id="inv-history-content">
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>Recent Movements</div>
              {/* Tailwind-only History table — same sticky pattern as
                  Stock Levels and Alerts above. NO overflow:hidden on the
                  wrapper (would silently disable sticky on the th cells),
                  table uses border-separate (border-collapse:collapse
                  silently disables sticky on th in all major browsers). */}
              <div className="bg-surface ring-1 ring-line rounded-lg">
                <table
                  className={[
                    'w-full m-0 border-separate border-spacing-0 text-[11.5px]',
                    // Sticky header cells
                    '[&_thead_th]:sticky [&_thead_th]:top-[-1px] [&_thead_th]:z-10',
                    '[&_thead_th]:bg-surface-2 [&_thead_th]:text-ink-3',
                    '[&_thead_th]:text-[10px] [&_thead_th]:font-extrabold [&_thead_th]:uppercase [&_thead_th]:tracking-[0.4px]',
                    '[&_thead_th]:text-left [&_thead_th]:px-2.5 [&_thead_th]:py-2',
                    '[&_thead_th]:border-b-2 [&_thead_th]:border-line [&_thead_th]:whitespace-nowrap',
                    '[&_thead_th]:shadow-[0_1px_0_var(--border)]',
                    // Body cells
                    '[&_tbody_td]:px-2.5 [&_tbody_td]:py-2',
                    '[&_tbody_td]:border-b [&_tbody_td]:border-line [&_tbody_td]:align-middle',
                    '[&_tbody_tr:last-child_td]:border-b-0',
                    '[&_tbody_tr:hover_td]:bg-surface-2',
                  ].join(' ')}
                >
                  <thead>
                    <tr>
                      <SortableHeader sortKey="date" sortState={historySort} onSort={handleHistorySort}>Date</SortableHeader>
                      <SortableHeader sortKey="sku" sortState={historySort} onSort={handleHistorySort}>SKU</SortableHeader>
                      <SortableHeader sortKey="type" sortState={historySort} onSort={handleHistorySort}>Type</SortableHeader>
                      <SortableHeader sortKey="qty" sortState={historySort} onSort={handleHistorySort} align="right" style={{ textAlign: 'right' }}>Qty</SortableHeader>
                      <SortableHeader sortKey="note" sortState={historySort} onSort={handleHistorySort}>Note</SortableHeader>
                      <SortableHeader sortKey="source" sortState={historySort} onSort={handleHistorySort}>Source</SortableHeader>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedLedger.map((entry) => {
                      const typeColor = entry.type === 'receive' ? 'var(--green)' : entry.type === 'adjust' ? 'var(--ss-blue)' : entry.type === 'ship' ? 'var(--red)' : entry.type === 'return' ? 'var(--yellow)' : entry.type === 'damage' ? 'var(--red)' : 'var(--text3)'
                      return (
                        <tr key={entry.id}>
                          <td style={{ color: 'var(--text3)' }}>{formatDateTime(entry.createdAt)}</td>
                          <td style={{ fontFamily: 'monospace' }}>{entry.sku || '—'}</td>
                          <td><span style={{ fontWeight: 700, color: typeColor, textTransform: 'capitalize' }}>{entry.type}</span></td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: entry.qty > 0 ? 'var(--green)' : 'var(--red)' }}>{entry.qty > 0 ? `+${entry.qty}` : entry.qty}</td>
                          <td style={{ color: 'var(--text2)' }}>{entry.note || '—'}</td>
                          <td style={{ color: 'var(--text3)' }}>{entry.createdBy || '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {activeTab === 'alerts' ? (
        <div id="inv-panel-alerts" className={INVENTORY_PANEL_CLASS}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <select className="filter-sel" value={alertsClientId} onChange={(event) => setAlertsClientId(event.target.value)}>
              <option value="">All Clients</option>
              {clients.map((client) => (
                <option key={client.clientId} value={client.clientId}>{client.name}</option>
              ))}
            </select>
            <span style={{ fontSize: 11.5, color: 'var(--text3)' }}>
              {(() => {
                const out = filteredAlerts.filter((a: any) => getInventoryDisplayStock(a as InventoryItemDto) <= 0).length
                const low = filteredAlerts.length - out
                return `${out} out of stock • ${low} low`
              })()}
            </span>
          </div>

          {filteredAlerts.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">✅</div>
              <div>All stocked — no low/out SKUs.</div>
            </div>
          ) : (
            // Tailwind-only Alerts table — same sticky pattern as Stock
            // Levels above. Wrapper has NO overflow:hidden (would disable
            // sticky on the th cells), and the table uses border-separate
            // because border-collapse:collapse silently disables sticky on
            // th in all major browsers (known bug since 2017).
            <div className="bg-surface ring-1 ring-line rounded-lg">
              <table
                className={[
                  'w-full m-0 border-separate border-spacing-0',
                  // Sticky header cells
                  '[&_thead_th]:sticky [&_thead_th]:top-[-1px] [&_thead_th]:z-10',
                  '[&_thead_th]:bg-surface-2 [&_thead_th]:text-ink-3',
                  '[&_thead_th]:text-[10px] [&_thead_th]:font-extrabold [&_thead_th]:uppercase [&_thead_th]:tracking-[0.4px]',
                  '[&_thead_th]:text-left [&_thead_th]:px-2.5 [&_thead_th]:py-2',
                  '[&_thead_th]:border-b-2 [&_thead_th]:border-line [&_thead_th]:whitespace-nowrap',
                  '[&_thead_th]:shadow-[0_1px_0_var(--border)]',
                  // Body cells
                  '[&_tbody_td]:px-2.5 [&_tbody_td]:py-2 [&_tbody_td]:text-[12px]',
                  '[&_tbody_td]:border-b [&_tbody_td]:border-line [&_tbody_td]:align-middle',
                  // Drop bottom border on last row so it doesn't double up
                  '[&_tbody_tr:last-child_td]:border-b-0',
                  // Hover
                  '[&_tbody_tr:hover_td]:bg-surface-2',
                ].join(' ')}
              >
                <thead>
                  <tr>
                    <SortableHeader sortKey="sku" sortState={alertsSort} onSort={handleAlertsSort}>SKU</SortableHeader>
                    <SortableHeader sortKey="name" sortState={alertsSort} onSort={handleAlertsSort}>Name</SortableHeader>
                    <SortableHeader sortKey="client" sortState={alertsSort} onSort={handleAlertsSort}>Client</SortableHeader>
                    <SortableHeader sortKey="stock" sortState={alertsSort} onSort={handleAlertsSort} align="center" style={{ textAlign: 'center' }}>Current Stock</SortableHeader>
                    <SortableHeader sortKey="min" sortState={alertsSort} onSort={handleAlertsSort} align="center" style={{ textAlign: 'center' }}>Min Stock</SortableHeader>
                    <SortableHeader sortKey="status" sortState={alertsSort} onSort={handleAlertsSort} align="center" style={{ textAlign: 'center' }}>Status</SortableHeader>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sortedAlerts.map((alert: any) => {
                    const stock = getInventoryDisplayStock(alert as InventoryItemDto)
                    const minStock = alert?.minStock ?? 0
                    const isOut = stock <= 0
                    const isLow = !isOut && minStock > 0 && stock <= minStock
                    const clientName = alert?.clientName
                      ?? clients.find((c) => c.clientId === alert?.clientId)?.name
                      ?? '—'
                    return (
                      <tr key={alert?.id ?? `${alert?.clientId}-${alert?.sku}`}>
                        <td style={{ fontFamily: 'monospace', fontSize: 11.5 }}>{alert?.sku || '—'}</td>
                        <td style={{ fontSize: 12, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{alert?.name || '—'}</td>
                        <td style={{ fontSize: 12, color: 'var(--text2)' }}>{clientName}</td>
                        <td style={{ textAlign: 'center', fontWeight: 700, fontSize: 13, color: isOut ? 'var(--red)' : 'var(--text)' }}>{stock}</td>
                        <td style={{ textAlign: 'center', fontSize: 12, color: 'var(--text3)' }}>{minStock}</td>
                        <td style={{ textAlign: 'center' }}>
                          <span className={`stock-badge ${isOut ? 'stock-out' : isLow ? 'stock-low' : 'stock-ok'}`}>
                            {isOut ? 'OUT' : isLow ? 'LOW' : 'OK'}
                          </span>
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs"
                            onClick={() => {
                              if (alert?.clientId != null) {
                                setStockClientId(String(alert.clientId))
                              }
                              setAlertOnly(false)
                              setStockSearch('')
                              setFocusInvSkuId(alert?.id ?? null)
                              setActiveTab('stock')
                            }}
                            title="Jump to this SKU on the Stock tab"
                            style={{ color: 'var(--ss-blue)', fontWeight: 600 }}
                          >
                            Go to SKU →
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      {activeTab === 'parents' ? (
        <div id="inv-panel-parents" className={INVENTORY_PANEL_CLASS}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <select className="filter-sel" value={parentsClientId} onChange={(event) => setParentsClientId(event.target.value)}>
              <option value="">All Clients</option>
              {clients.map((client) => (
                <option key={client.clientId} value={client.clientId}>{client.name}</option>
              ))}
            </select>
            <button
              className="btn btn-primary btn-sm"
              type="button"
              onClick={() => {
                const defaultClient = parentsClientId
                  ? Number.parseInt(parentsClientId, 10)
                  : clients[0]?.clientId ?? 0
                setParentsCreateForm({
                  clientId: defaultClient,
                  name: '',
                  sku: '',
                  baseUnitQty: '1',
                })
                setParentsCreateOpen(true)
              }}
            >
              ＋ Create Parent SKU
            </button>
          </div>

          {parentsCreateOpen ? (
            <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 14, maxWidth: 560 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginBottom: 10 }}>Create Parent SKU</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={{ fontSize: 11, color: 'var(--text3)' }}>Client</label>
                  <select
                    className="ship-select"
                    style={{ width: '100%' }}
                    value={parentsCreateForm.clientId ? String(parentsCreateForm.clientId) : ''}
                    onChange={(event) => setParentsCreateForm((current) => ({ ...current, clientId: Number.parseInt(event.target.value, 10) || 0 }))}
                  >
                    <option value="">Select client…</option>
                    {clients.map((client) => (
                      <option key={client.clientId} value={client.clientId}>{client.name}</option>
                    ))}
                  </select>
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={{ fontSize: 11, color: 'var(--text3)' }}>Name *</label>
                  <input
                    type="text"
                    className="ship-select"
                    style={{ width: '100%' }}
                    placeholder="e.g., Banana Drink"
                    value={parentsCreateForm.name}
                    onChange={(event) => setParentsCreateForm((current) => ({ ...current, name: event.target.value }))}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text3)' }}>SKU (optional)</label>
                  <input
                    type="text"
                    className="ship-select"
                    style={{ width: '100%', fontFamily: 'monospace' }}
                    placeholder="e.g., BANANA-DRINK-PARENT"
                    value={parentsCreateForm.sku}
                    onChange={(event) => setParentsCreateForm((current) => ({ ...current, sku: event.target.value }))}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text3)' }}>Base Unit Qty</label>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    className="ship-select"
                    style={{ width: '100%' }}
                    value={parentsCreateForm.baseUnitQty}
                    onChange={(event) => setParentsCreateForm((current) => ({ ...current, baseUnitQty: event.target.value }))}
                  />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <button className="btn btn-ghost btn-sm" type="button" onClick={() => setParentsCreateOpen(false)}>Cancel</button>
                <button className="btn btn-primary btn-sm" type="button" onClick={() => void handleCreateParentFromTab()}>💾 Create</button>
              </div>
            </div>
          ) : null}

          {parentsLoading ? (
            <div className="loading"><div className="spinner" /></div>
          ) : !parentsList.length ? (
            <div className="empty-state">
              <div className="empty-icon">🧬</div>
              <div>No parent SKUs yet.</div>
            </div>
          ) : (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
              <table className="inv-table" style={{ margin: 0 }}>
                <thead>
                  <tr>
                    <SortableHeader sortKey="name" sortState={parentsSort} onSort={handleParentsSort}>Name</SortableHeader>
                    <SortableHeader sortKey="sku" sortState={parentsSort} onSort={handleParentsSort}>SKU</SortableHeader>
                    <SortableHeader sortKey="client" sortState={parentsSort} onSort={handleParentsSort}>Client</SortableHeader>
                    <SortableHeader sortKey="baseUnitQty" sortState={parentsSort} onSort={handleParentsSort} align="center" style={{ textAlign: 'center' }}>Base Unit Qty</SortableHeader>
                  </tr>
                </thead>
                <tbody>
                  {sortedParentsList.map((parent: any) => {
                    const clientName = clients.find((c) => c.clientId === parent?.clientId)?.name ?? '—'
                    return (
                      <tr key={parent?.parentSkuId ?? parent?.id}>
                        <td style={{ fontWeight: 600, fontSize: 12 }}>{parent?.name || '—'}</td>
                        <td style={{ fontFamily: 'monospace', fontSize: 11.5 }}>{parent?.sku || <span style={{ color: 'var(--text4)' }}>—</span>}</td>
                        <td style={{ fontSize: 12, color: 'var(--text2)' }}>{clientName}</td>
                        <td style={{ textAlign: 'center', fontSize: 12, color: 'var(--text3)' }}>{parent?.baseUnitQty ?? 1}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      {/* 2026-05-12: the legacy InventoryView Columns popover that
          lived here was removed alongside its toolbar trigger button
          (see the dedup comment in the toolbar block above). The
          reusable <Table> primitive at components/ui/Table.tsx now
          owns the column toggle UI for this page — single source of
          truth, one popover, no duplicate trigger / popover pair. */}

      {/* Portal'd parent-SKU popover. Rendered into document.body
          (via createPortal) so it escapes the table cell's
          overflow:hidden — previously the dropdown was clipped at
          the cell boundary and the operator couldn't see it. The
          chain-link button's onClick captures the trigger element
          and stores it in `parentPopoverAnchor`; the useLayoutEffect
          above computes viewport coords + recomputes on scroll/resize.
          We re-anchor a referenced row from items so deletes/refreshes
          don't strand the popover with stale data. */}
      {inlineParentRowId != null && parentPopoverRect && typeof document !== 'undefined'
        ? (() => {
            const row = items.find((r) => r.id === inlineParentRowId)
            if (!row) return null
            return createPortal(
              <div
                role="dialog"
                aria-label="Assign parent SKU"
                data-inventory-parent-popover
                onClick={(event) => event.stopPropagation()}
                style={{
                  position: 'fixed',
                  top: parentPopoverRect.top,
                  left: parentPopoverRect.left,
                  zIndex: 9999,
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  boxShadow: '0 8px 24px -6px rgba(15,23,42,.18), 0 2px 6px -2px rgba(15,23,42,.10)',
                  padding: 8,
                  minWidth: parentPopoverRect.minWidth,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                <div style={{ fontSize: 9.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text3)' }}>
                  {row.parentSkuId ? 'Change parent SKU' : 'Assign parent SKU'}
                </div>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <select
                    className="ship-select"
                    style={{ flex: 1, fontSize: 12, padding: '4px 6px' }}
                    defaultValue={row.parentSkuId ? String(row.parentSkuId) : ''}
                    disabled={inlineParentSaving}
                    onChange={(event) => { event.stopPropagation(); void handleInlineParentChange(row, event.target.value) }}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <option value="">— No Parent —</option>
                    {(parentSkuOptions[row.clientId] ?? []).map((option) => (
                      <option key={option.parentSkuId} value={option.parentSkuId}>{option.name}</option>
                    ))}
                  </select>
                  <button
                    className="btn btn-ghost btn-xs"
                    type="button"
                    onClick={(event) => { event.stopPropagation(); setInlineParentRowId(null); setParentPopoverAnchor(null) }}
                    title="Close"
                    style={{ flex: '0 0 auto' }}
                  >
                    ✕
                  </button>
                </div>
              </div>,
              document.body,
            )
          })()
        : null}

      {editSkuForm ? (
        <div className="inventory-overlay" onClick={() => setEditSkuForm(null)}>
          <div className="inventory-modal" onClick={(event) => event.stopPropagation()}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Edit SKU Details</div>
            <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 14, fontFamily: 'monospace' }}>{editSkuForm.sku}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 12 }}>
              <div>
                <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase' }}>Weight (oz)</label>
                <input type="number" className="ship-select" style={{ width: '100%', fontSize: 12 }} value={editSkuForm.weightOz} onChange={(event) => setEditSkuForm((current) => current ? { ...current, weightOz: event.target.value } : current)} />
              </div>
              <div>
                <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase' }}>Min Stock</label>
                <input type="number" className="ship-select" style={{ width: '100%', fontSize: 12 }} value={editSkuForm.minStock} onChange={(event) => setEditSkuForm((current) => current ? { ...current, minStock: event.target.value } : current)} />
              </div>
              <div>
                <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase' }} title="How many individual units are in one of this SKU (e.g. 10 for a 10-pack)">Units / Pack</label>
                <input type="number" className="ship-select" style={{ width: '100%', fontSize: 12 }} min="1" step="1" value={editSkuForm.unitsPerPack} onChange={(event) => setEditSkuForm((current) => current ? { ...current, unitsPerPack: event.target.value } : current)} />
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase' }}>📦 Parent SKU (for variants)</label>
                <select
                  className="ship-select"
                  style={{ width: '100%', fontSize: 12 }}
                  value={editSkuForm.parentSkuId}
                  onChange={(event) => {
                    const value = event.target.value
                    if (value === '__create__') {
                      setParentModal({
                        clientId: editSkuForm.clientId,
                        name: '',
                        sku: '',
                        baseUnitQty: '1',
                      })
                      return
                    }
                    setEditSkuForm((current) => current ? { ...current, parentSkuId: value } : current)
                  }}
                >
                  <option value="">— No Parent —</option>
                  {(parentSkuOptions[editSkuForm.clientId] ?? []).map((option) => (
                    <option key={option.parentSkuId} value={option.parentSkuId}>{option.name}</option>
                  ))}
                  <option value="__create__">➕ Create New Parent…</option>
                </select>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase' }} title="How many base units per pack (e.g. 6 for 6-pack, 12 for 12-pack). Used to calculate total inventory across variants.">Base Unit Qty (per pack)</label>
                <input type="number" className="ship-select" style={{ width: '100%', fontSize: 12 }} min="1" step="1" value={editSkuForm.baseUnitQty} onChange={(event) => setEditSkuForm((current) => current ? { ...current, baseUnitQty: event.target.value } : current)} />
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 12 }}>
              <div><label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase' }}>📦 Pkg L</label><input type="number" className="ship-select" style={{ width: '100%', fontSize: 12 }} value={editSkuForm.packageLength} onChange={(event) => setEditSkuForm((current) => current ? { ...current, packageLength: event.target.value } : current)} /></div>
              <div><label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase' }}>📦 Pkg W</label><input type="number" className="ship-select" style={{ width: '100%', fontSize: 12 }} value={editSkuForm.packageWidth} onChange={(event) => setEditSkuForm((current) => current ? { ...current, packageWidth: event.target.value } : current)} /></div>
              <div><label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase' }}>📦 Pkg H</label><input type="number" className="ship-select" style={{ width: '100%', fontSize: 12 }} value={editSkuForm.packageHeight} onChange={(event) => setEditSkuForm((current) => current ? { ...current, packageHeight: event.target.value } : current)} /></div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 12 }}>
              <div><label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase' }} title="Product dimensions for storage fee calculations">📦 Prod L</label><input type="number" className="ship-select" style={{ width: '100%', fontSize: 12 }} value={editSkuForm.productLength} onChange={(event) => setEditSkuForm((current) => current ? { ...current, productLength: event.target.value } : current)} /></div>
              <div><label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase' }} title="Product dimensions for storage fee calculations">📦 Prod W</label><input type="number" className="ship-select" style={{ width: '100%', fontSize: 12 }} value={editSkuForm.productWidth} onChange={(event) => setEditSkuForm((current) => current ? { ...current, productWidth: event.target.value } : current)} /></div>
              <div><label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase' }} title="Product dimensions for storage fee calculations">📦 Prod H</label><input type="number" className="ship-select" style={{ width: '100%', fontSize: 12 }} value={editSkuForm.productHeight} onChange={(event) => setEditSkuForm((current) => current ? { ...current, productHeight: event.target.value } : current)} /></div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase' }}>📦 Shipping Package</label>
              <select className="ship-select" style={{ width: '100%', fontSize: 12 }} value={editSkuForm.packageId} onChange={(event) => setEditSkuForm((current) => current ? { ...current, packageId: event.target.value } : current)}>
                <option value="">— No Package —</option>
                {packages.map((pkg) => (
                  <option key={pkg.packageId} value={pkg.packageId}>{pkg.name} ({pkg.length}×{pkg.width}×{pkg.height})</option>
                ))}
              </select>
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase' }} title="Override the auto-computed cubic footage based on product dims (L×W×H÷1728). Leave 0 to compute from product dimensions automatically.">
                Cu Ft Override <span style={{ color: 'var(--text4)', fontWeight: 400, textTransform: 'none' }}>(0 = auto from product dims)</span>
              </label>
              <input type="number" className="ship-select" style={{ width: 130, fontSize: 12 }} value={editSkuForm.cuFtOverride} onChange={(event) => setEditSkuForm((current) => current ? { ...current, cuFtOverride: event.target.value } : current)} />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-outline btn-sm" type="button" onClick={() => setEditSkuForm(null)}>Cancel</button>
              <button className="btn btn-primary btn-sm" type="button" onClick={handleSaveSku}>Save</button>
            </div>
          </div>
        </div>
      ) : null}

      {parentModal ? (
        <div className="inventory-overlay" onClick={() => setParentModal(null)}>
          <div className="inventory-modal" onClick={(event) => event.stopPropagation()}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>Create Parent SKU</div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>Parent Name <span style={{ color: 'var(--red)' }}>*</span></label>
              <input type="text" className="ship-select" style={{ width: '100%', fontSize: 13 }} placeholder="e.g., Banana Drink" value={parentModal.name} onChange={(event) => setParentModal((current) => current ? { ...current, name: event.target.value } : current)} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>Parent SKU Code <span style={{ color: 'var(--text4)', fontWeight: 400 }}>(optional)</span></label>
              <input type="text" className="ship-select" style={{ width: '100%', fontSize: 13, fontFamily: 'monospace' }} placeholder="e.g., BANANA-DRINK-PARENT" value={parentModal.sku} onChange={(event) => setParentModal((current) => current ? { ...current, sku: event.target.value } : current)} />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>Base Unit Qty <span style={{ color: 'var(--text4)', fontWeight: 400 }}>(default: 1)</span></label>
              <input type="number" className="ship-select" style={{ width: '100%', fontSize: 13 }} min="1" step="1" value={parentModal.baseUnitQty} onChange={(event) => setParentModal((current) => current ? { ...current, baseUnitQty: event.target.value } : current)} />
              <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 4 }}>Units per case (e.g., 6 for 6-pack, 1 for single units)</div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-outline btn-sm" type="button" onClick={() => setParentModal(null)}>Cancel</button>
              <button className="btn btn-primary btn-sm" type="button" onClick={handleCreateParent}>Create</button>
            </div>
          </div>
        </div>
      ) : null}

      {adjustModal ? (
        <div className="inventory-overlay" onClick={() => setAdjustModal(null)}>
          <div className="inventory-modal" style={{ width: 380 }} onClick={(event) => event.stopPropagation()}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>Inventory Entry</div>
            <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 14, fontFamily: 'monospace' }}>{adjustModal.sku}</div>

            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.4px', display: 'block', marginBottom: 4 }}>Type</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {([
                  ['receive', '📦 Receive'],
                  ['return', '↩ Return'],
                  ['damage', '⚠ Damage'],
                  ['adjust', '± Adjust'],
                ] as Array<[AdjustType, string]>).map(([type, label]) => {
                  const isActive = adjustModal.type === type
                  const accent = type === 'damage' ? 'var(--red)' : type === 'return' ? '#d97706' : 'var(--ss-blue)'
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => setAdjustModal((current) => current ? { ...current, type, sign: type === 'damage' ? -1 : 1 } : current)}
                      style={{ flex: 1, padding: '6px 10px', borderRadius: 6, border: `2px solid ${isActive ? accent : 'var(--border2)'}`, background: isActive ? accent : 'var(--surface2)', color: isActive ? '#fff' : 'var(--text)', fontWeight: 700, cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' }}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>

            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.4px', display: 'block', marginBottom: 4 }}>Direction</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => setAdjustModal((current) => current ? { ...current, sign: 1 } : current)}
                  style={{ flex: 1, padding: 7, borderRadius: 6, border: `2px solid ${adjustModal.sign > 0 ? 'var(--ss-blue)' : 'var(--border2)'}`, background: adjustModal.sign > 0 ? 'var(--ss-blue)' : 'var(--surface2)', color: adjustModal.sign > 0 ? '#fff' : 'var(--text)', fontWeight: 700, cursor: 'pointer', fontSize: 13 }}
                >
                  + Add
                </button>
                <button
                  type="button"
                  onClick={() => setAdjustModal((current) => current ? { ...current, sign: -1 } : current)}
                  style={{ flex: 1, padding: 7, borderRadius: 6, border: `2px solid ${adjustModal.sign < 0 ? 'var(--red)' : 'var(--border2)'}`, background: adjustModal.sign < 0 ? 'var(--red)' : 'var(--surface2)', color: adjustModal.sign < 0 ? '#fff' : 'var(--text)', fontWeight: 700, cursor: 'pointer', fontSize: 13 }}
                >
                  − Remove
                </button>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', width: 16, textAlign: 'center' }}>{adjustModal.sign > 0 ? '+' : '−'}</span>
              <input type="number" min="1" step="1" value={adjustModal.qty} onChange={(event) => setAdjustModal((current) => current ? { ...current, qty: event.target.value } : current)} style={{ flex: 1, padding: '7px 10px', border: '1px solid var(--border2)', borderRadius: 6, background: 'var(--surface2)', color: 'var(--text)', fontSize: 14, fontWeight: 700 }} />
            </div>

            <input type="text" value={adjustModal.note} onChange={(event) => setAdjustModal((current) => current ? { ...current, note: event.target.value } : current)} placeholder="Note (e.g. PO#, reason, ref)" maxLength={120} style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: '1px solid var(--border2)', borderRadius: 6, background: 'var(--surface2)', color: 'var(--text)', fontSize: 12, marginBottom: 10 }} />

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <span style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' }}>📅 Date:</span>
              <input type="date" value={adjustModal.date} onChange={(event) => setAdjustModal((current) => current ? { ...current, date: event.target.value } : current)} style={{ flex: 1, padding: '6px 8px', border: '1px solid var(--border2)', borderRadius: 6, background: 'var(--surface2)', color: 'var(--text)', fontSize: 12 }} />
              <span style={{ fontSize: 11, color: 'var(--text3)', whiteSpace: 'nowrap' }}>{adjustModal.date === new Date().toISOString().slice(0, 10) ? '(today)' : ''}</span>
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-outline btn-sm" type="button" onClick={() => setAdjustModal(null)}>Cancel</button>
              <button className="btn btn-primary btn-sm" type="button" onClick={handleAdjustSubmit}>Save</button>
            </div>
          </div>
        </div>
      ) : null}

      {skuDrawerOpen ? (
        <div className="inventory-drawer-overlay" onClick={() => setSkuDrawerOpen(false)}>
          <div className="inventory-drawer-panel" onClick={(event) => event.stopPropagation()}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{skuDrawerTitle}</div>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2, fontFamily: 'monospace' }}>{skuDrawer?.sku ?? ''}</div>
              </div>
              <button type="button" onClick={() => setSkuDrawerOpen(false)} style={{ padding: '5px 10px', border: '1px solid var(--border2)', borderRadius: 6, background: 'var(--surface2)', color: 'var(--text)', cursor: 'pointer', fontSize: 13 }}>✕</button>
            </div>
            <div className="inventory-drawer-body">
              {skuDrawerLoading ? (
                <div className="loading"><div className="spinner" /></div>
              ) : skuDrawerError ? (
                <div style={{ color: 'var(--red)', padding: 16 }}>Failed to load: {skuDrawerError}</div>
              ) : skuDrawer ? (
                <>
                  <div style={{ display: 'flex', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
                    <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 16px', flex: 1, minWidth: 120 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text3)', marginBottom: 4 }}>30-Day Units Sold</div>
                      <div style={{ fontSize: 22, fontWeight: 800, color: '#e07a00' }}>{skuDrawer.totalUnits.toLocaleString()}</div>
                    </div>
                    <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 16px', flex: 1, minWidth: 120 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text3)', marginBottom: 4 }}>Total Orders</div>
                      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)' }}>{skuDrawer.orders.length.toLocaleString()}</div>
                    </div>
                    <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 16px', flex: 1, minWidth: 120 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text3)', marginBottom: 4 }}>Avg/Day (30d)</div>
                      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)' }}>{(skuDrawer.totalUnits / 30).toFixed(1)}</div>
                    </div>
                  </div>

                  <div className="inventory-sku-chart-card" style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: '14px 16px', marginBottom: 18 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', marginBottom: 10 }}>Units Sold — Last 30 Days</div>
                    <canvas ref={canvasRef} className="inventory-sku-chart-canvas" width={620} height={160} />
                  </div>

                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>Recent Orders ({skuDrawer.orders.length})</div>
                  {skuDrawer.orders.length === 0 ? (
                    <div style={{ color: 'var(--text3)', fontSize: 12, padding: 16, textAlign: 'center' }}>No orders found for this SKU.</div>
                  ) : (
                    <div className="inventory-sku-orders-wrap">
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead>
                          <tr style={{ background: 'var(--surface2)', borderBottom: '1px solid var(--border)' }}>
                            <SortableHeader sortKey="order" sortState={skuOrdersSort} onSort={handleSkuOrdersSort} style={{ padding: '7px 10px', textAlign: 'left', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text3)' }}>Order #</SortableHeader>
                            <SortableHeader sortKey="customer" sortState={skuOrdersSort} onSort={handleSkuOrdersSort} style={{ padding: '7px 10px', textAlign: 'left', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text3)' }}>Customer</SortableHeader>
                            <SortableHeader sortKey="qty" sortState={skuOrdersSort} onSort={handleSkuOrdersSort} align="center" style={{ padding: '7px 6px', textAlign: 'center', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text3)' }}>Qty</SortableHeader>
                            <SortableHeader sortKey="status" sortState={skuOrdersSort} onSort={handleSkuOrdersSort} style={{ padding: '7px 10px', textAlign: 'left', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text3)' }}>Status</SortableHeader>
                            <SortableHeader sortKey="date" sortState={skuOrdersSort} onSort={handleSkuOrdersSort} style={{ padding: '7px 10px', textAlign: 'left', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text3)' }}>Date</SortableHeader>
                          </tr>
                        </thead>
                        <tbody>
                          {sortedSkuOrders.map((order, index) => {
                            const statusColor = order.orderStatus === 'shipped' ? 'var(--green)' : order.orderStatus === 'awaiting_shipment' ? 'var(--ss-blue)' : 'var(--text3)'
                            return (
                              <tr key={order.orderId} style={{ borderTop: '1px solid var(--border)', background: index % 2 === 0 ? '' : 'var(--surface2)' }}>
                                <td style={{ padding: '6px 10px' }}>
                                  <button
                                    type="button"
                                    className="inventory-order-link"
                                    disabled={!Number.isFinite(Number(order.orderId)) || Number(order.orderId) <= 0}
                                    onClick={() => openSkuDrawerOrder(order)}
                                  >
                                    {order.orderNumber || String(order.orderId)}
                                  </button>
                                </td>
                                <td style={{ padding: '6px 10px', fontSize: 11.5, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{order.shipToName || '—'}</td>
                                <td style={{ padding: '6px 6px', textAlign: 'center', fontWeight: 700 }}>{order.qty || 1}</td>
                                <td style={{ padding: '6px 10px', fontSize: 11, fontWeight: 700, color: statusColor }}>{order.orderStatus || '—'}</td>
                                <td style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text3)' }}>{formatDateOnly(order.orderDate)}</td>
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

      {orderDetailModal ? (
        <Suspense fallback={null}>
          <OrderDetailDrawer
            orderId={orderDetailModal.orderId}
            displayStatus={orderDetailModal.status ?? undefined}
            presentation="modal"
            closeLabel="Close"
            closeTitle="Close order details"
            onClose={() => setOrderDetailModal(null)}
          />
        </Suspense>
      ) : null}

      {thumbnailPreview ? (
        <div
          className="inventory-thumb-preview"
          style={{
            left: `${thumbnailPreview.left}px`,
            top: `${thumbnailPreview.top}px`,
            zoom: String(thumbnailPreview.zoom),
          }}
        >
          <img src={thumbnailPreview.src} alt="" />
        </div>
      ) : null}

      {/* Confirmation modal — fires when an operator clicks the
          Active/Inactive toggle. Portal-rendered to document.body so
          it floats above the Inventory page regardless of where the
          toggle sits in the table. Cancel/ESC/backdrop drops the
          intent without mutating anything. */}
      <ConfirmActiveToggleDialog
        pending={pendingActiveToggle}
        onConfirm={() => void confirmToggleClientActive()}
        onCancel={cancelToggleClientActive}
        isPending={confirmInFlight}
      />
    </div>
  )
}
