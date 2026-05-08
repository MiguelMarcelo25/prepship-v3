// @ts-nocheck
import './OrdersView.css'
import { lazy, Suspense, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Package,
  Truck,
  Bell,
  Calendar,
  Inbox,
  AlertTriangle,
  Loader2,
  Search as SearchIcon,
  X as XIcon,
  Filter,
  CheckSquare,
  ListOrdered,
  Download,
  Printer as PrinterIcon,
  Columns3,
  Copy as CopyIcon,
  Check as CheckIcon,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  MoreHorizontal,
  ExternalLink,
  MapPin,
  Box,
  Scale,
  Ruler,
  Shield,
  BadgeCheck,
  RefreshCcw,
  Save as SaveIcon,
  Zap,
  User as UserIcon,
  Edit3,
  Send,
  ClipboardList,
  PackageCheck,
  Tag,
} from 'lucide-react'
import OrderDetailDrawer from '../OrderDetailDrawer'
import TrackingModal from '../TrackingModal'
import HoverImage from '../HoverImage'
import { apiClient } from '../../api/client'
import { TEST_CLIENT_IDS } from '../../lib/v2-apiClient'
const RateBrowserModal = lazy(() => import('../RateBrowserModal'))
import { ToastContext } from '../../contexts/ToastContext'
import { useLocations, useOrderDetail, useOrders, useShippingAccounts } from '../../hooks'
import { useMarkups } from '../../contexts/MarkupsContext'
import { useAuth } from '../../lib/auth'
import { api } from '../../lib/api'
import { applyCarrierMarkup } from '../../utils/markups'
import type {
  CarrierAccountDto,
  CreateLabelRequestDto,
  LocationDto,
  OrderFullDto,
  OrderPicklistResponseDto,
  OrderSummaryDto,
  OrdersDailyStatsDto,
  PackageDto,
  PrintQueueEntryDto,
} from '../../types/api'
import { getOrdersDateRange, type OrdersDateFilter } from './orders-view-filters'
import { groupOrdersBySku } from './orders-grouping'
import { formatQueuedOrderToast, formatQueuedOrdersToast } from './orders-queue'
import {
  buildDailyStripProgress,
  buildColumnPrefsForStatus,
  buildPicklistPrintHtml,
  buildQueueAddPayload,
  getColumnMinWidth,
  groupPrintQueueEntries,
  resolveColumnPrefs,
  type ColumnPrefs,
  type PrintQueueGroup,
} from './orders-parity'
import {
  getInitialPanelServiceCode,
  getInitialPanelShipAccountId,
  getMatchedPackageIdByDimensions,
  getPanelConfirmation,
  getPanelInsurance,
  getPanelPackageId,
  getPanelRequestedService,
  getPanelWarehouseId,
  getProductDefaultPackageId,
} from './orders-panel-state'

type OrderStatus = 'awaiting_shipment' | 'shipped' | 'cancelled'
type SortDirection = 'asc' | 'desc'
type SortKey = 'date' | 'age' | 'orderNum' | 'client' | 'customer' | 'itemname' | 'sku' | 'qty' | 'weight' | 'shipto' | 'carrier' | 'custcarrier' | 'total'
type TableColumnKey = 'select' | 'date' | 'client' | 'orderNum' | 'customer' | 'itemname' | 'sku' | 'qty' | 'weight' | 'shipto' | 'carrier' | 'custcarrier' | 'total' | 'bestrate' | 'margin' | 'tracking' | 'labelcreated' | 'age' | 'test_carrierCode' | 'test_shippingProviderID' | 'test_clientID' | 'test_serviceCode' | 'test_bestRate' | 'test_orderLocal' | 'test_shippingAccount'
type PanelSectionKey = 'shipping' | 'items' | 'recipient'

interface QueueActionProgress {
  label: string
  completed: number
  total: number
  failed: number
  startedAt: number
  tick: number
}

type PersistentQueueJobKind = 'existing-labels' | 'batch-queue'

interface PersistentQueueJob {
  id: string
  kind: PersistentQueueJobKind
  orders: OrderSummaryDto[]
  completedOrderIds: number[]
  failedOrderIds: number[]
  total: number
  label: string
  batchTestMode?: boolean
  backendJobId?: string
  createdAt: number
  updatedAt: number
}

const QUEUE_ACTION_JOB_STORAGE_KEY = 'prepship.queueActionJob.v1'
const QUEUE_ACTION_JOB_MAX_AGE_MS = 30 * 60 * 1000
const QUEUE_UI_YIELD_MS = 25
let persistentQueueJobCache: PersistentQueueJob | null | undefined

function createQueueOrderSnapshot(order: OrderSummaryDto): OrderSummaryDto {
  const raw = order.raw && typeof order.raw === 'object' ? order.raw as Record<string, unknown> : null
  return {
    orderId: order.orderId,
    orderNumber: order.orderNumber,
    orderStatus: order.orderStatus,
    clientId: order.clientId,
    clientName: order.clientName,
    storeId: order.storeId,
    items: order.items,
    label: order.label,
    bestRate: order.bestRate,
    selectedRate: order.selectedRate,
    serviceCode: order.serviceCode,
    shipping: order.shipping,
    canonicalOrder: order.canonicalOrder,
    weight: order.weight,
    rateDims: order.rateDims,
    dimensions: order.dimensions,
    raw: raw ? {
      test: raw.test,
      testing: raw.testing,
      dimensions: raw.dimensions,
    } : order.raw,
  } as OrderSummaryDto
}

function readPersistentQueueJob(): PersistentQueueJob | null {
  if (persistentQueueJobCache !== undefined) return persistentQueueJobCache
  try {
    const raw = window.localStorage.getItem(QUEUE_ACTION_JOB_STORAGE_KEY)
    if (!raw) {
      persistentQueueJobCache = null
      return null
    }
    const job = JSON.parse(raw) as PersistentQueueJob
    if (!job?.id || !Array.isArray(job.orders)) {
      persistentQueueJobCache = null
      return null
    }
    if (Date.now() - (job.updatedAt || job.createdAt || 0) > QUEUE_ACTION_JOB_MAX_AGE_MS) {
      window.localStorage.removeItem(QUEUE_ACTION_JOB_STORAGE_KEY)
      persistentQueueJobCache = null
      return null
    }
    persistentQueueJobCache = {
      ...job,
      completedOrderIds: Array.isArray(job.completedOrderIds) ? job.completedOrderIds : [],
      failedOrderIds: Array.isArray(job.failedOrderIds) ? job.failedOrderIds : [],
      total: Math.max(job.total || job.orders.length, 1),
    }
    return persistentQueueJobCache
  } catch {
    persistentQueueJobCache = null
    return null
  }
}

function writePersistentQueueJob(job: PersistentQueueJob) {
  persistentQueueJobCache = job
  try {
    window.localStorage.setItem(QUEUE_ACTION_JOB_STORAGE_KEY, JSON.stringify({ ...job, updatedAt: Date.now() }))
  } catch {
    // Progress persistence is best-effort; the queue action itself should continue.
  }
}

function clearPersistentQueueJob(jobId?: string | null) {
  try {
    if (!jobId) {
      window.localStorage.removeItem(QUEUE_ACTION_JOB_STORAGE_KEY)
      persistentQueueJobCache = null
      return
    }
    const current = readPersistentQueueJob()
    if (!current || current.id === jobId) {
      window.localStorage.removeItem(QUEUE_ACTION_JOB_STORAGE_KEY)
      persistentQueueJobCache = null
    }
  } catch {
    // Ignore storage cleanup failures.
  }
}

function createPersistentQueueJob(
  kind: PersistentQueueJobKind,
  orders: OrderSummaryDto[],
  options: { label?: string; batchTestMode?: boolean } = {},
): PersistentQueueJob {
  const now = Date.now()
  const job: PersistentQueueJob = {
    id: `${now}:${Math.random().toString(36).slice(2)}`,
    kind,
    orders: orders.map(createQueueOrderSnapshot),
    completedOrderIds: [],
    failedOrderIds: [],
    total: Math.max(orders.length, 1),
    label: options.label ?? 'Sending to queue',
    batchTestMode: options.batchTestMode,
    createdAt: now,
    updatedAt: now,
  }
  writePersistentQueueJob(job)
  return job
}

function yieldToBrowser(delay = QUEUE_UI_YIELD_MS) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, delay))
}

function markPersistentQueueJobOrder(jobId: string | null | undefined, orderId: number, failed: boolean) {
  if (!jobId) return
  const job = readPersistentQueueJob()
  if (!job || job.id !== jobId) return

  const completed = new Set(job.completedOrderIds)
  const failedSet = new Set(job.failedOrderIds)
  completed.delete(orderId)
  failedSet.delete(orderId)
  if (failed) failedSet.add(orderId)
  else completed.add(orderId)

  writePersistentQueueJob({
    ...job,
    completedOrderIds: [...completed],
    failedOrderIds: [...failedSet],
  })
}

function attachPersistentQueueBackendJob(jobId: string | null | undefined, backendJobId: string | null | undefined) {
  if (!jobId || !backendJobId) return
  const job = readPersistentQueueJob()
  if (!job || job.id !== jobId) return
  writePersistentQueueJob({
    ...job,
    backendJobId,
  })
}

function getPersistentQueueJobProgress(job: PersistentQueueJob) {
  const completed = (job.completedOrderIds?.length ?? 0) + (job.failedOrderIds?.length ?? 0)
  return {
    label: job.label || 'Sending to queue',
    completed: Math.min(job.total, completed),
    failed: job.failedOrderIds?.length ?? 0,
    total: Math.max(job.total || job.orders.length, 1),
  }
}

interface PanelFormState {
  locationId: string
  shipAccountId: string
  serviceCode: string
  weightLb: string
  weightOz: string
  length: string
  width: string
  height: string
  packageId: string
  confirmation: string
  insurance: string
  insuranceValue: string
}

type ShipmentDims = { length: number; width: number; height: number }

interface OrdersViewProps {
  currentStatus: OrderStatus
  searchQuery?: string
  onSearchQueryChange?: (value: string) => void
  activeStore?: number | null
  dateFilter?: OrdersDateFilter
  onDateFilterChange?: (filter: OrdersDateFilter) => void
  onResolvedDateRangeChange?: (range: { start?: string; end?: string }) => void
  selectedOrderIds?: number[]
  onSelectedOrderIdsChange?: (ids: number[]) => void
  activeOrderId?: number | null
  onActiveOrderIdChange?: (id: number | null) => void
  onNavigateView?: (view: 'locations' | 'packages') => void
  columnMenuRequestId?: number
  labelsActionRequestId?: number
  queueToggleRequestId?: number
  onQueueStateChange?: (state: { count: number; isOpen: boolean }) => void
  refreshVersion?: number
  /**
   * Counter from Home — increments every time the user clicks a
   * sidebar entry (status or store). When it changes, OrdersView
   * clears its locally-owned filters (skuFilter + customDateFrom +
   * customDateTo). search + dateFilter are reset by Home directly
   * since they live in Home state.
   *
   * Counter (not boolean) so rapid clicks each produce a distinct
   * value — the watching useEffect can't miss an event due to
   * batching or a same-value setState skipping the dep change.
   */
  filterResetVersion?: number
  showTestOrders?: boolean
  // User preference (from localStorage in Home.tsx) — when true, the
  // right-side order detail panel is hidden when no order is selected.
  // The panel still appears the moment a row is clicked (showing details).
  // Default false (panel always visible) for back-compat.
  hideEmptyPanel?: boolean
  // Callback fired when the user toggles hideEmptyPanel from inside the
  // panel itself (the × close button) or from the vertical edge tab
  // ("Show panel"). Updates the same localStorage-backed pref in Home.tsx.
  onHideEmptyPanelChange?: (hide: boolean) => void
  stores?: Array<{ storeId?: number | null; clientId?: number | null }>
}

interface TableColumn {
  key: TableColumnKey
  label: string
  width: number
  sort: SortKey | null
}

interface OrderLineItem {
  sku: string | null
  name: string | null
  quantity: number
  imageUrl: string | null
  unitPrice: number | null
  adjustment: boolean
}

interface ClientPalette {
  bg: string
  color: string
  border: string
}

const TABLE_COLUMNS: TableColumn[] = [
  { key: 'select', label: '', width: 34, sort: null },
  { key: 'date', label: 'Order Date', width: 90, sort: 'date' },
  { key: 'client', label: 'Client', width: 100, sort: 'client' },
  { key: 'orderNum', label: 'Order #', width: 85, sort: 'orderNum' },
  { key: 'customer', label: 'Recipient', width: 175, sort: 'customer' },
  { key: 'itemname', label: 'Item Name', width: 170, sort: 'itemname' },
  { key: 'sku', label: 'SKU', width: 150, sort: 'sku' },
  { key: 'qty', label: 'Qty', width: 44, sort: 'qty' },
  { key: 'weight', label: 'Weight', width: 80, sort: 'weight' },
  { key: 'shipto', label: 'Ship To', width: 135, sort: 'shipto' },
  { key: 'carrier', label: 'Carrier', width: 145, sort: 'carrier' },
  { key: 'custcarrier', label: 'Shipping Account', width: 140, sort: 'custcarrier' },
  { key: 'total', label: 'Order Total', width: 85, sort: 'total' },
  { key: 'bestrate', label: 'Best Rate', width: 175, sort: null },
  { key: 'test_carrierCode', label: 'Carrier Code', width: 120, sort: null },
  { key: 'test_shippingProviderID', label: 'Provider ID', width: 110, sort: null },
  { key: 'test_clientID', label: 'Client ID', width: 90, sort: null },
  { key: 'test_shippingAccount', label: 'Acct Nickname', width: 120, sort: null },
  { key: 'test_serviceCode', label: 'Service Code', width: 130, sort: null },
  { key: 'test_bestRate', label: 'Best Rate (awaiting)', width: 200, sort: null },
  { key: 'test_orderLocal', label: 'Order Local', width: 140, sort: null },
  { key: 'labelcreated', label: 'Label Created', width: 115, sort: null },
  { key: 'margin', label: 'Ship Margin', width: 90, sort: null },
  { key: 'tracking', label: 'Tracking #', width: 160, sort: null },
  { key: 'age', label: 'Age', width: 50, sort: 'age' },
]

const COLUMN_PREFS_LOCAL_STORAGE_KEY = 'prepship.orders.columnPrefs'
const DAILY_STATS_ROLLOVER_TIME_ZONE = 'America/Los_Angeles'
const DAILY_STATS_ROLLOVER_HOUR = 18

function readLocalColumnPrefs() {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(COLUMN_PREFS_LOCAL_STORAGE_KEY)
    return raw ? JSON.parse(raw) as ColumnPrefs : null
  } catch {
    return null
  }
}

function writeLocalColumnPrefs(prefs: ColumnPrefs) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(COLUMN_PREFS_LOCAL_STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // Server persistence is still the source of truth when localStorage is unavailable.
  }
}

function getDailyStatsRolloverParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: DAILY_STATS_ROLLOVER_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
  }
}

function addCalendarDays(year: number, month: number, day: number, days: number) {
  const date = new Date(Date.UTC(year, month - 1, day + days, 0, 0, 0))
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  }
}

function getTimeZoneOffsetMs(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '0'
  const zonedAsUtc = Date.UTC(
    Number(get('year')),
    Number(get('month')) - 1,
    Number(get('day')),
    Number(get('hour')),
    Number(get('minute')),
    Number(get('second'))
  )

  return zonedAsUtc - date.getTime()
}

function zonedDateToUtcDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string
) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second)
  const firstPass = new Date(utcGuess - getTimeZoneOffsetMs(new Date(utcGuess), timeZone))
  return new Date(utcGuess - getTimeZoneOffsetMs(firstPass, timeZone))
}

function getMsUntilNextDailyStatsRollover(now = new Date()) {
  const today = getDailyStatsRolloverParts(now)
  let target = zonedDateToUtcDate(
    today.year,
    today.month,
    today.day,
    DAILY_STATS_ROLLOVER_HOUR,
    0,
    0,
    DAILY_STATS_ROLLOVER_TIME_ZONE
  )

  if (target.getTime() <= now.getTime()) {
    const tomorrow = addCalendarDays(today.year, today.month, today.day, 1)
    target = zonedDateToUtcDate(
      tomorrow.year,
      tomorrow.month,
      tomorrow.day,
      DAILY_STATS_ROLLOVER_HOUR,
      0,
      0,
      DAILY_STATS_ROLLOVER_TIME_ZONE
    )
  }

  return Math.max(1000, target.getTime() - now.getTime() + 1000)
}

const CLIENT_PALETTES: ClientPalette[] = [
  { bg: '#dbeafe', color: '#1e40af', border: '#93c5fd' },
  { bg: '#dcfce7', color: '#166534', border: '#86efac' },
  { bg: '#fce7f3', color: '#9d174d', border: '#f9a8d4' },
  { bg: '#fef9c3', color: '#854d0e', border: '#fde047' },
  { bg: '#f3e8ff', color: '#6b21a8', border: '#c4b5fd' },
  { bg: '#ffe4e6', color: '#9f1239', border: '#fda4af' },
  { bg: '#e0f2fe', color: '#075985', border: '#7dd3fc' },
  { bg: '#f0fdf4', color: '#14532d', border: '#4ade80' },
  { bg: '#fff7ed', color: '#9a3412', border: '#fdba74' },
  { bg: '#f1f5f9', color: '#334155', border: '#94a3b8' },
]

const CARRIER_NAMES: Record<string, string> = {
  stamps_com: 'USPS',
  ups: 'UPS',
  ups_walleted: 'UPS',
  fedex: 'FedEx',
  fedex_walleted: 'FedEx',
  dhl_express: 'DHL',
  asendia_us: 'Asendia',
  ontrac: 'OnTrac',
  lasership: 'LaserShip',
  amazon_swa: 'Amazon',
  globegistics: 'Globegistics',
}

const SERVICE_NAMES: Record<string, string> = {
  usps_priority_mail: 'Priority Mail',
  usps_priority_mail_express: 'Priority Express',
  usps_first_class_mail: 'First Class',
  usps_ground_advantage: 'Ground Advantage',
  usps_media_mail: 'Media Mail',
  usps_library_mail: 'Library Mail',
  usps_parcel_select: 'Parcel Select',
  ups_ground: 'UPS Ground',
  ups_ground_saver: 'UPS Ground Saver',
  ups_surepost: 'UPS Ground Saver',
  ups_surepost_1_lb_or_greater: 'UPS Ground Saver (1 lb+)',
  ups_surepost_less_than_1_lb: 'UPS Ground Saver (<1 lb)',
  ups_3_day_select: 'UPS 3 Day Select',
  ups_2nd_day_air: 'UPS 2nd Day Air',
  ups_2nd_day_air_am: 'UPS 2nd Day Air AM',
  ups_next_day_air_saver: 'UPS Next Day Air Saver',
  ups_next_day_air: 'UPS Next Day Air',
  ups_next_day_air_early_am: 'UPS Next Day Air Early AM',
  fedex_ground: 'FedEx Ground',
  fedex_home_delivery: 'FedEx Home Delivery',
  fedex_2day: 'FedEx 2Day',
  fedex_2_day: 'FedEx 2Day',
  fedex_2day_am: 'FedEx 2Day AM',
  fedex_express_saver: 'FedEx Express Saver',
  fedex_priority_overnight: 'FedEx Priority Overnight',
  fedex_standard_overnight: 'FedEx Standard Overnight',
  fedex_first_overnight: 'FedEx First Overnight',
}

const CARRIER_SERVICES: Record<string, Array<{ code: string; label: string }>> = {
  stamps_com: [
    { code: 'usps_media_mail', label: 'USPS Media Mail' },
    { code: 'usps_first_class_mail', label: 'USPS First Class Mail' },
    { code: 'usps_ground_advantage', label: 'USPS Ground Advantage' },
    { code: 'usps_priority_mail', label: 'USPS Priority Mail' },
    { code: 'usps_priority_mail_express', label: 'USPS Priority Express' },
    { code: 'usps_parcel_select', label: 'USPS Parcel Select' },
  ],
  ups: [
    { code: 'ups_ground', label: 'UPS Ground' },
    { code: 'ups_ground_saver', label: 'UPS Ground Saver' },
    { code: 'ups_surepost_less_than_1_lb', label: 'UPS Ground Saver (<1 lb)' },
    { code: 'ups_surepost_1_lb_or_greater', label: 'UPS Ground Saver (1 lb+)' },
    { code: 'ups_3_day_select', label: 'UPS 3 Day Select' },
    { code: 'ups_2nd_day_air', label: 'UPS 2nd Day Air' },
    { code: 'ups_2nd_day_air_am', label: 'UPS 2nd Day Air AM' },
    { code: 'ups_next_day_air_saver', label: 'UPS Next Day Air Saver' },
    { code: 'ups_next_day_air', label: 'UPS Next Day Air' },
  ],
  ups_walleted: [
    { code: 'ups_ground', label: 'UPS Ground' },
    { code: 'ups_ground_saver', label: 'UPS Ground Saver' },
    { code: 'ups_surepost_less_than_1_lb', label: 'UPS Ground Saver (<1 lb)' },
    { code: 'ups_surepost_1_lb_or_greater', label: 'UPS Ground Saver (1 lb+)' },
    { code: 'ups_3_day_select', label: 'UPS 3 Day Select' },
    { code: 'ups_2nd_day_air', label: 'UPS 2nd Day Air' },
    { code: 'ups_next_day_air_saver', label: 'UPS Next Day Air Saver' },
    { code: 'ups_next_day_air', label: 'UPS Next Day Air' },
  ],
  fedex: [
    { code: 'fedex_ground', label: 'FedEx Ground' },
    { code: 'fedex_home_delivery', label: 'FedEx Home Delivery' },
    { code: 'fedex_2day', label: 'FedEx 2Day' },
    { code: 'fedex_express_saver', label: 'FedEx Express Saver' },
    { code: 'fedex_priority_overnight', label: 'FedEx Priority Overnight' },
    { code: 'fedex_standard_overnight', label: 'FedEx Standard Overnight' },
  ],
  fedex_walleted: [
    { code: 'fedex_ground', label: 'FedEx Ground' },
    { code: 'fedex_home_delivery', label: 'FedEx Home Delivery' },
    { code: 'fedex_2day', label: 'FedEx 2Day' },
    { code: 'fedex_express_saver', label: 'FedEx Express Saver' },
    { code: 'fedex_priority_overnight', label: 'FedEx Priority Overnight' },
    { code: 'fedex_standard_overnight', label: 'FedEx Standard Overnight' },
  ],
}

const clientPaletteCache = new Map<string, ClientPalette>()

const LEGACY_CLIENT_ID_BY_DISPLAY_NAME = new Map<string, number>([
  ['techtok', 7],
  ['tran agency', 8],
  ['walmart - djc', 9],
  ['kf goods', 10],
  ['test orders', 11],
])

const LEGACY_CLIENT_ID_BY_DISPLAY_STORE_ID = new Map<number, number>([
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

const TEST_PACK_SKU = 'TEST-PACK'
const TEST_PACK_WEIGHT_OZ = 4
const TEST_PACK_DIMS = { length: 5, width: 3, height: 1, units: 'inches' }
const TEST_SHIPPING_ACCOUNT_LABEL = 'PrepShip Test'
const TEST_CARRIER_CODE = 'prepship_test'
const TEST_SERVICE_CODE = 'prepship_test_standard'
const TEST_RATE_BROWSER_ACCOUNTS = [
  { shippingProviderId: 900001, carrierId: 'se-prepship-test-a', code: TEST_CARRIER_CODE, nickname: 'PrepShip Test Standard', accountNumber: 'MOCK-PT-A', name: 'PrepShip Test Standard', _label: 'PrepShip Test Standard' },
  { shippingProviderId: 900002, carrierId: 'se-prepship-test-b', code: TEST_CARRIER_CODE, nickname: 'PrepShip Test Saver', accountNumber: 'MOCK-PT-B', name: 'PrepShip Test Saver', _label: 'PrepShip Test Saver' },
  { shippingProviderId: 900003, carrierId: 'se-prepship-test-c', code: TEST_CARRIER_CODE, nickname: 'PrepShip Test Priority', accountNumber: 'MOCK-PT-C', name: 'PrepShip Test Priority', _label: 'PrepShip Test Priority' },
  { shippingProviderId: 900004, carrierId: 'se-prepship-test-d', code: TEST_CARRIER_CODE, nickname: 'PrepShip Test Express', accountNumber: 'MOCK-PT-D', name: 'PrepShip Test Express', _label: 'PrepShip Test Express' },
  { shippingProviderId: 900005, carrierId: 'se-prepship-test-e', code: TEST_CARRIER_CODE, nickname: 'PrepShip Test Local', accountNumber: 'MOCK-PT-E', name: 'PrepShip Test Local', _label: 'PrepShip Test Local' },
]
const TEST_RATE_SERVICE_TEMPLATES = [
  { code: 'prepship_test_economy', name: 'PrepShip Test Economy', base: 4.65, spread: 2.75, perLb: 0.72, days: '3-6 days' },
  { code: TEST_SERVICE_CODE, name: 'PrepShip Test Standard', base: 7.25, spread: 3.8, perLb: 0.96, days: '2-4 days' },
  { code: 'prepship_test_priority', name: 'PrepShip Test Priority', base: 13.9, spread: 6.75, perLb: 1.28, days: '1-3 days' },
]
const BATCH_QUEUE_CONCURRENCY = 2
const BACKEND_QUEUE_SEND_CONCURRENCY = 5
const BACKEND_TEST_QUEUE_SEND_CONCURRENCY = 8
const BACKEND_QUEUE_SEND_POLL_MS = 750

function seededTestUnit(seed: string) {
  let hash = 2166136261
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) / 4294967295
}

function roundTestMoney(value: number) {
  return Math.round(Math.max(0, value) * 100) / 100
}

function buildTestRatesForShipment(orderId: number, dims: { length: number; width: number; height: number }, weightOz: number) {
  const weightLb = Math.max(0.25, weightOz / 16)
  const cubicInches = Math.max(0, dims.length * dims.width * dims.height)
  const dimFactor = Math.min(18, cubicInches / 1728) * 1.15
  const seedBase = `${orderId}:${weightOz}:${dims.length}x${dims.width}x${dims.height}`

  return TEST_RATE_BROWSER_ACCOUNTS.flatMap((account) => (
    TEST_RATE_SERVICE_TEMPLATES.map((template, templateIndex) => {
      const jitter = seededTestUnit(`${seedBase}:${account.shippingProviderId}:${template.code}`)
      const surchargeSeed = seededTestUnit(`${seedBase}:fuel:${account.shippingProviderId}:${templateIndex}`)
      const shipmentCost = roundTestMoney(template.base + template.spread * jitter + weightLb * template.perLb + dimFactor)
      const otherCost = roundTestMoney(surchargeSeed > 0.72 ? 0.55 + surchargeSeed * 1.45 : 0)
      return {
        carrierCode: TEST_CARRIER_CODE,
        serviceCode: template.code,
        serviceName: template.name,
        carrierNickname: account._label,
        shippingProviderId: account.shippingProviderId,
        amount: shipmentCost + otherCost,
        shipmentCost,
        otherCost,
        raw: {
          testRate: true,
          mocked: true,
          carrierCode: TEST_CARRIER_CODE,
          serviceCode: template.code,
          serviceName: template.name,
          carrierNickname: account._label,
          deliveryDays: template.days,
          delivery_days: Number.parseInt(template.days, 10) || null,
          rate_details: otherCost > 0
            ? [{ rate_detail_type: 'fuel_surcharge', carrier_description: 'Mock fuel surcharge', amount: { amount: otherCost } }]
            : [],
        },
      }
    })
  ))
}

function buildBestTestRateForShipment(orderId: number, dims: { length: number; width: number; height: number }, weightOz: number) {
  return buildTestRatesForShipment(orderId, dims, weightOz)
    .sort((left, right) => (left.shipmentCost + left.otherCost) - (right.shipmentCost + right.otherCost))[0] ?? null
}

function buildTestMockRate(source?: Record<string, unknown>) {
  const readString = (value: unknown) => typeof value === 'string' && value.trim() ? value : null
  const readNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null
  const raw = source && typeof source.raw === 'object' && source.raw !== null ? source.raw as Record<string, unknown> : {}
  const shipmentCost = Math.max(0, readNumber(source?.shipmentCost) ?? readNumber(source?.amount) ?? 0)
  const otherCost = Math.max(0, readNumber(source?.otherCost) ?? 0)
  const amount = shipmentCost + otherCost
  const carrierCode = readString(source?.carrierCode) ?? TEST_CARRIER_CODE
  const serviceCode = readString(source?.serviceCode) ?? TEST_SERVICE_CODE
  const serviceName = readString(source?.serviceName) ?? readString(raw.serviceName) ?? 'PrepShip Test Standard'
  const carrierNickname = readString(source?.carrierNickname) ?? readString(raw.carrierNickname) ?? TEST_SHIPPING_ACCOUNT_LABEL
  return {
    carrierCode,
    serviceCode,
    serviceName,
    carrierNickname,
    providerAccountNickname: carrierNickname,
    shippingProviderId: null,
    providerAccountId: null,
    amount,
    cost: amount,
    shipmentCost,
    otherCost,
    raw: {
      ...raw,
      testRate: true,
      simulatedProviderId: source?.shippingProviderId ?? null,
      carrierCode,
      serviceCode,
      serviceName,
      carrierNickname,
      shipmentCost,
      otherCost,
    },
  }
}

function buildTestRateBrowserAccounts() {
  return TEST_RATE_BROWSER_ACCOUNTS
}

type V2CarrierAccountRef = {
  carrierCode: string
  shippingProviderId: number
  nickname: string
  clientId: number | null
  accountNumber: string | null
}

const V2_CARRIER_ACCOUNT_REFS: V2CarrierAccountRef[] = [
  { carrierCode: 'stamps_com', shippingProviderId: 433542, nickname: 'USPS Chase x7439', clientId: null, accountNumber: 'djeon-952w77' },
  { carrierCode: 'ups_walleted', shippingProviderId: 433543, nickname: 'UPS by SS - Chase x7439', clientId: null, accountNumber: 'ups_433543' },
  { carrierCode: 'ups', shippingProviderId: 565326, nickname: 'GG6381', clientId: null, accountNumber: 'GG6381' },
  { carrierCode: 'ups', shippingProviderId: 565377, nickname: 'G19Y32', clientId: null, accountNumber: 'G19Y32' },
  { carrierCode: 'ups', shippingProviderId: 596001, nickname: 'ORION', clientId: null, accountNumber: 'R05H19' },
  { carrierCode: 'ups', shippingProviderId: 604209, nickname: 'ROCEL', clientId: null, accountNumber: null },
  { carrierCode: 'ups', shippingProviderId: 607855, nickname: 'ROCEL C81F70', clientId: null, accountNumber: 'C81F70' },
  { carrierCode: 'fedex', shippingProviderId: 598840, nickname: 'FedEx', clientId: null, accountNumber: '208481048' },
  { carrierCode: 'fedex_walleted', shippingProviderId: 585004, nickname: 'FedEx One Balance', clientId: null, accountNumber: null },
  { carrierCode: 'stamps_com', shippingProviderId: 442006, nickname: 'GREG PAYABILITY 6/17', clientId: 10, accountNumber: null },
  { carrierCode: 'ups', shippingProviderId: 461890, nickname: 'ROCEL C81F70', clientId: 10, accountNumber: 'C81F70' },
  { carrierCode: 'ups', shippingProviderId: 565317, nickname: 'GG6381', clientId: 10, accountNumber: 'GG6381' },
  { carrierCode: 'ups', shippingProviderId: 595995, nickname: 'ORI Account', clientId: 10, accountNumber: 'R05H19' },
  { carrierCode: 'ups', shippingProviderId: 442007, nickname: 'GREG PAYABILITY 6/17', clientId: 10, accountNumber: null },
  { carrierCode: 'fedex', shippingProviderId: 442013, nickname: 'FedEx', clientId: 10, accountNumber: '208481048' },
  { carrierCode: 'fedex_walleted', shippingProviderId: 585334, nickname: 'FedEx One Balance', clientId: 10, accountNumber: null },
]

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function toStringValue(value: unknown) {
  return typeof value === 'string' ? value : null
}

function toNumberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function toNumericValue(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function toProviderAccountId(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const match = value.match(/^se-(\d+)$/i)
  const parsed = Number.parseInt(match?.[1] ?? value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

function truncate(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value
}

// ───────────────────────────────────────────────────────────────────
// Date/time formatters — DELEGATE to the canonical CA-time module.
//
// These exports preserve the legacy function signatures so the rest
// of OrdersView doesn't have to change. Under the hood they use
// formatNaivePt* helpers from web/src/lib/ca-time.ts because the
// orderDate / shipDate / labelShipDate fields are "naive PT stamped
// Z" (see ca-time.ts module docstring for the full backstory).
//
// Boss directive (2026-05-07): "I want all CA TIME, no PST". So
// every operator-facing time renders in California time and labels
// say "CA" where a TZ disambiguator is meaningful.
// ───────────────────────────────────────────────────────────────────
import {
  formatNaivePtDateTime,
  formatNaivePtLabelCreated,
  formatNaivePtDateLong,
  formatNaivePtWeekday,
} from '../../lib/ca-time'

function formatDateTime(value: string | null | undefined) {
  return formatNaivePtDateTime(value)
}

function formatLabelCreated(value: string | null | undefined) {
  return formatNaivePtLabelCreated(value)
}

function formatDateOnly(value: string | null | undefined, options?: Intl.DateTimeFormatOptions) {
  if (!value) return '—'
  // Two specific shapes used in OrdersView are mapped to the canonical
  // helpers; everything else falls back to a custom Intl call (still
  // forced to CA timezone for consistency).
  if (!options || (options.month === 'short' && options.day === 'numeric' && options.year === 'numeric' && !options.weekday)) {
    return formatNaivePtDateLong(value)
  }
  if (options.weekday === 'short') {
    return formatNaivePtWeekday(value)
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return '—'
  // Caller provided custom Intl options; render in CA TZ regardless.
  return parsed.toLocaleDateString('en-US', { ...options, timeZone: 'UTC' })
}

function formatMoney(amount: number | null | undefined) {
  if (typeof amount !== 'number' || Number.isNaN(amount)) return '—'
  return `$${amount.toFixed(2)}`
}

function formatWeight(ounces: number | null | undefined) {
  if (!ounces) return '—'
  const pounds = Math.floor(ounces / 16)
  const remaining = Math.round((ounces % 16) * 10) / 10
  if (pounds === 0) return `${remaining} oz`
  if (remaining === 0) return `${pounds} lb`
  return `${pounds} lb ${remaining} oz`
}

function ageHours(value: string | null | undefined) {
  if (!value) return 0
  return (Date.now() - new Date(value).getTime()) / (1000 * 60 * 60)
}

function ageLabel(value: string | null | undefined) {
  const hours = ageHours(value)
  if (hours < 1) return `${Math.floor(hours * 60)}m`
  if (hours < 24) return `${Math.floor(hours)}h`
  return `${Math.floor(hours / 24)}d`
}

function getAgeColor(value: string | null | undefined) {
  const hours = ageHours(value)
  if (hours > 48) return 'var(--red)'
  if (hours > 24) return '#d97706'
  return 'var(--green)'
}

function getClientPalette(name: string) {
  const cached = clientPaletteCache.get(name)
  if (cached) return cached

  let hash = 0
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) & 0xffff
  }
  const palette = CLIENT_PALETTES[hash % CLIENT_PALETTES.length]
  clientPaletteCache.set(name, palette)
  return palette
}

function formatServiceCode(value: string | null | undefined) {
  if (!value) return '—'
  return SERVICE_NAMES[value] ?? value.replace(/_/g, ' ')
}

function formatCarrierCode(value: string | null | undefined) {
  if (!value) return '—'
  return CARRIER_NAMES[value] ?? value.replace(/^custom_?/i, '').replace(/_/g, ' ').toUpperCase()
}

function getCarrierClass(carrierCode: string | null | undefined) {
  if (!carrierCode) return 'carrier-other'
  if (carrierCode.includes('ups')) return 'carrier-ups'
  if (carrierCode.includes('fedex')) return 'carrier-fedex'
  if (carrierCode.includes('stamps') || carrierCode.includes('usps')) return 'carrier-usps'
  return 'carrier-other'
}

function normalizeItems(source: unknown): OrderLineItem[] {
  if (!Array.isArray(source)) return []

  return source
    .map((item) => toRecord(item))
    .filter((item): item is Record<string, unknown> => item != null)
    .map((item) => ({
      sku: toStringValue(item.sku),
      name: toStringValue(item.name),
      quantity: toNumberValue(item.quantity) ?? 1,
      imageUrl: toStringValue(item.imageUrl),
      unitPrice: toNumberValue(item.unitPrice) ?? toNumberValue(item.price),
      adjustment: Boolean(item.adjustment),
    }))
}

function getActiveItems(order: OrderSummaryDto, detail: OrderFullDto | null) {
  const rawOrder = toRecord(detail?.raw)
  const detailItems = normalizeItems(rawOrder?.items)
  const sourceItems = detailItems.length > 0 ? detailItems : normalizeItems(order.items)
  return sourceItems.filter((item) => !item.adjustment)
}

function getPrimaryItem(order: OrderSummaryDto, detail: OrderFullDto | null) {
  return getActiveItems(order, detail)[0] ?? null
}

function getMergedItems(order: OrderSummaryDto, detail: OrderFullDto | null) {
  const grouped = new Map<string, OrderLineItem>()
  for (const item of getActiveItems(order, detail)) {
    const key = `${item.sku ?? ''}|${item.name ?? ''}`
    const existing = grouped.get(key)
    if (existing) {
      existing.quantity += item.quantity
      continue
    }
    grouped.set(key, { ...item })
  }
  return [...grouped.values()]
}

function getTotalQuantity(order: OrderSummaryDto, detail: OrderFullDto | null) {
  return getActiveItems(order, detail).reduce((sum, item) => sum + (item.quantity || 1), 0)
}

function hasTestPackItem(order: OrderSummaryDto, detail: OrderFullDto | null) {
  return getActiveItems(order, detail).some((item) => (item.sku ?? '').trim().toUpperCase() === TEST_PACK_SKU)
}

function isTestOrder(order: OrderSummaryDto, detail: OrderFullDto | null = null) {
  const clientId = toNumericValue(order.clientId)
  const legacyClientId = getLegacyClientIdForDisplay(order)
  const clientName = (toStringValue(order.clientName) ?? '').trim().toLowerCase()
  const orderNumber = (toStringValue(order.orderNumber) ?? '').trim().toUpperCase()
  const raw = toRecord(order.raw)
  return (
    (clientId != null && TEST_CLIENT_IDS.has(clientId)) ||
    legacyClientId === 11 ||
    clientName === 'test orders' ||
    orderNumber.startsWith('TESTING-') ||
    raw?.test === true ||
    raw?.testing === true ||
    hasTestPackItem(order, detail)
  )
}

function getOrderWeightOz(order: OrderSummaryDto, detail: OrderFullDto | null) {
  const savedWeightOz = order.weight?.value ?? 0
  if (savedWeightOz > 0) return savedWeightOz

  if (isTestOrder(order, detail) && hasTestPackItem(order, detail)) {
    return getActiveItems(order, detail).reduce((sum, item) => {
      const sku = (item.sku ?? '').trim().toUpperCase()
      return sum + (sku === TEST_PACK_SKU ? (item.quantity || 1) * TEST_PACK_WEIGHT_OZ : 0)
    }, 0)
  }
  return 0
}

function getPrimarySku(order: OrderSummaryDto, detail: OrderFullDto | null) {
  const primary = getPrimaryItem(order, detail)
  return (primary?.sku ?? primary?.name ?? '').toLowerCase().trim()
}

function getPrimarySkuLabel(order: OrderSummaryDto, detail: OrderFullDto | null) {
  const primary = getPrimaryItem(order, detail)
  return (primary?.sku ?? primary?.name ?? '').trim() || 'Unknown SKU'
}

function buildSearchText(order: OrderSummaryDto, detail: OrderFullDto | null) {
  const rawOrder = toRecord(detail?.raw)
  const shipTo = getShipTo(order, detail)
  const label = toRecord(order.label) ?? toRecord(detail?.label)
  const shipping = toRecord(order.shipping) ?? toRecord(detail?.shipping)
  return [
    order.orderId != null ? String(order.orderId) : null,
    order.orderNumber,
    order.externalOrderId,
    detail?.externalOrderId,
    order.clientName,
    order.customerEmail,
    shipTo.name,
    shipTo.company,
    shipTo.street1,
    shipTo.street2,
    shipTo.city,
    shipTo.state,
    shipTo.postalCode,
    toStringValue(label?.trackingNumber),
    toStringValue(label?.labelTracking),
    toStringValue(shipping?.trackingNumber),
    toStringValue(shipping?.labelTracking),
    ...getActiveItems(order, detail).flatMap((item) => [item.sku, item.name]),
    toStringValue(rawOrder?.customerUsername),
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ')
    .toLowerCase()
}

function getShipTo(order: OrderSummaryDto, detail: OrderFullDto | null) {
  const canonicalRecipient = getCanonicalRecord(order, 'recipient')
  const rawOrder = toRecord(detail?.raw)
  const rawShipTo = toRecord(rawOrder?.shipTo)

  return {
    name: toStringValue(canonicalRecipient?.name) ?? order.shipTo?.name ?? toStringValue(rawShipTo?.name) ?? null,
    company: toStringValue(canonicalRecipient?.company) ?? order.shipTo?.company ?? toStringValue(rawShipTo?.company) ?? null,
    street1: toStringValue(canonicalRecipient?.street1) ?? order.shipTo?.street1 ?? toStringValue(rawShipTo?.street1) ?? null,
    street2: toStringValue(canonicalRecipient?.street2) ?? order.shipTo?.street2 ?? toStringValue(rawShipTo?.street2) ?? null,
    city: toStringValue(canonicalRecipient?.city) ?? order.shipTo?.city ?? toStringValue(rawShipTo?.city) ?? null,
    state: toStringValue(canonicalRecipient?.state) ?? order.shipTo?.state ?? toStringValue(rawShipTo?.state) ?? null,
    postalCode: toStringValue(canonicalRecipient?.postalCode) ?? order.shipTo?.postalCode ?? toStringValue(rawShipTo?.postalCode) ?? null,
    country: toStringValue(canonicalRecipient?.country) ?? order.shipTo?.country ?? toStringValue(rawShipTo?.country) ?? 'US',
    phone: toStringValue(canonicalRecipient?.phone) ?? order.shipTo?.phone ?? toStringValue(rawShipTo?.phone) ?? null,
    addressVerified: toStringValue(canonicalRecipient?.addressVerified) ?? order.shipTo?.addressVerified ?? toStringValue(rawShipTo?.addressVerified) ?? null,
  }
}

function getShipToLine(order: OrderSummaryDto, detail: OrderFullDto | null) {
  const shipTo = getShipTo(order, detail)
  const line = [shipTo.city, shipTo.state, shipTo.postalCode].filter(Boolean).join(', ')
  return line || '—'
}

function getAddressBlock(order: OrderSummaryDto, detail: OrderFullDto | null) {
  const shipTo = getShipTo(order, detail)
  return [
    shipTo.name,
    shipTo.company,
    shipTo.street1,
    shipTo.street2,
    [shipTo.city, shipTo.state, shipTo.postalCode].filter(Boolean).join(', '),
    shipTo.country && shipTo.country !== 'US' ? shipTo.country : null,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n')
}

function getDimensions(order: OrderSummaryDto, detail: OrderFullDto | null) {
  const canonicalDimensions = getCanonicalRecord(order, 'dimensions')
  const rawOrder = toRecord(detail?.raw) ?? toRecord(order.raw)
  const rawDims = toRecord(rawOrder?.dimensions)

  const length = toNumberValue(canonicalDimensions?.length) ?? order.rateDims?.length ?? toNumberValue(rawDims?.length) ?? 0
  const width = toNumberValue(canonicalDimensions?.width) ?? order.rateDims?.width ?? toNumberValue(rawDims?.width) ?? 0
  const height = toNumberValue(canonicalDimensions?.height) ?? order.rateDims?.height ?? toNumberValue(rawDims?.height) ?? 0

  if (!length || !width || !height) {
    if (isTestOrder(order, detail) && hasTestPackItem(order, detail)) {
      return TEST_PACK_DIMS
    }
    return null
  }

  return {
    length,
    width,
    height,
    units: toStringValue(canonicalDimensions?.units) ?? order.rateDims?.units ?? toStringValue(rawDims?.units) ?? 'inches',
  }
}

function getRequestedService(order: OrderSummaryDto, detail: OrderFullDto | null) {
  return getPanelRequestedService(order, detail)
}

function normalizeShippingAccountName(value: unknown) {
  const label = toStringValue(value)
  if (!label) return null
  return label
}

function getCanonicalOrderModel(order: OrderSummaryDto) {
  return toRecord(order.canonicalOrder)
}

function getCanonicalRecord(order: OrderSummaryDto, key: string) {
  return toRecord(getCanonicalOrderModel(order)?.[key])
}

function getShippingModel(order: OrderSummaryDto) {
  return getCanonicalRecord(order, 'shipping') ?? toRecord(order.shipping)
}

function getShippingString(order: OrderSummaryDto, key: string) {
  return toStringValue(getShippingModel(order)?.[key])
}

function getShippingNumber(order: OrderSummaryDto, key: string) {
  return toNumberValue(getShippingModel(order)?.[key])
}

function getShippingProviderAccountId(order: OrderSummaryDto) {
  return toProviderAccountId(getShippingModel(order)?.providerAccountId)
}

function getCanonicalSource(order: OrderSummaryDto, key: string) {
  const canonicalSourceMap = toRecord(getCanonicalOrderModel(order)?.sourceMap)
  const shippingSourceMap = toRecord(getShippingModel(order)?.sourceMap)
  return toRecord(canonicalSourceMap?.[key]) ?? toRecord(shippingSourceMap?.[key])
}

function getCanonicalSourceVersion(order: OrderSummaryDto, key: string) {
  return toStringValue(getCanonicalSource(order, key)?.version)
}

function getCanonicalSourceName(order: OrderSummaryDto, key: string) {
  return toStringValue(getCanonicalSource(order, key)?.source)
}

function getLegacyClientIdForDisplay(order: OrderSummaryDto) {
  const storeId = toNumericValue(order.storeId)
  if (storeId != null) {
    const byStore = LEGACY_CLIENT_ID_BY_DISPLAY_STORE_ID.get(storeId)
    if (byStore != null) return byStore
  }

  const byName = LEGACY_CLIENT_ID_BY_DISPLAY_NAME.get((toStringValue(order.clientName) ?? '').trim().toLowerCase())
  if (byName != null) return byName

  const clientId = toNumericValue(order.clientId)
  if (clientId != null) {
    const byCurrentId = LEGACY_CLIENT_ID_BY_CURRENT_ID.get(clientId)
    if (byCurrentId != null) return byCurrentId
  }

  return toNumericValue(order.legacyClientId) ?? clientId
}

function getCarrierAccountDisplay(account: CarrierAccountDto | null | undefined) {
  if (!account) return null
  return (
    normalizeShippingAccountName(account.nickname) ??
    normalizeShippingAccountName(account._label) ??
    normalizeShippingAccountName(account.code)
  )
}

function resolveV2CarrierAccount(
  providerAccountId: number | null,
  carrierCode: string | null,
  trackingNumber: string | null,
  clientId: number | null,
) {
  if (providerAccountId != null) {
    const exact = V2_CARRIER_ACCOUNT_REFS.find((account) => account.shippingProviderId === providerAccountId)
    if (exact) return exact
  }

  if ((carrierCode === 'ups' || carrierCode === 'ups_walleted') && trackingNumber) {
    const tracking = trackingNumber.replace(/\s/g, '').toUpperCase()
    if (tracking.startsWith('1Z') && tracking.length >= 8) {
      const accountNumber = tracking.slice(2, 8)
      const matches = V2_CARRIER_ACCOUNT_REFS.filter(
        (account) =>
          (account.carrierCode === 'ups' || account.carrierCode === 'ups_walleted') &&
          account.accountNumber?.toUpperCase() === accountNumber,
      )
      const clientMatch = clientId != null ? matches.find((account) => account.clientId === clientId) : null
      const sharedMatch = matches.find((account) => account.clientId === null)
      return clientMatch ?? sharedMatch ?? matches[0] ?? null
    }
  }

  const matching = V2_CARRIER_ACCOUNT_REFS.filter((account) => account.carrierCode === carrierCode)
  if (matching.length === 1) return matching[0]
  if (matching.length > 1) {
    const clientMatch = clientId != null ? matching.find((account) => account.clientId === clientId) : null
    const sharedMatch = matching.find((account) => account.clientId === null)
    return clientMatch ?? sharedMatch ?? null
  }

  return null
}

function getV2CarrierAccountForOrder(order: OrderSummaryDto) {
  const providerAccountId =
    getShippingProviderAccountId(order) ??
    toProviderAccountId(order.selectedRate?.shippingProviderId) ??
    toProviderAccountId(order.selectedRate?.providerAccountId) ??
    toProviderAccountId(order.label?.shippingProviderId) ??
    toProviderAccountId(order.bestRate?.shippingProviderId)
  const carrierCode =
    getShippingString(order, 'carrierCode') ??
    toStringValue(order.selectedRate?.carrierCode) ??
    toStringValue(order.bestRate?.carrierCode)
  const trackingNumber = getShippingString(order, 'trackingNumber') ?? toStringValue(order.label?.trackingNumber)
  const clientId = getLegacyClientIdForDisplay(order)

  return resolveV2CarrierAccount(providerAccountId, carrierCode, trackingNumber, clientId)
}

function isStrictShippedOrder(order: OrderSummaryDto) {
  return order.orderStatus === 'shipped'
}

function getCarrierCodeForDisplay(order: OrderSummaryDto) {
  if (isTestOrder(order)) return TEST_CARRIER_CODE

  const canonicalCarrierCode = getShippingString(order, 'carrierCode')
  if (canonicalCarrierCode) return canonicalCarrierCode

  if (order.orderStatus === 'awaiting_shipment') {
    return (
      toStringValue(order.bestRate?.carrierCode) ??
      toStringValue(order.selectedRate?.carrierCode)
    )
  }

  return toStringValue(order.selectedRate?.carrierCode) ?? toStringValue(order.bestRate?.carrierCode)
}

function getShipAccountDisplay(order: OrderSummaryDto, accounts: CarrierAccountDto[]) {
  if (isTestOrder(order)) return TEST_SHIPPING_ACCOUNT_LABEL

  const canonicalNickname = normalizeShippingAccountName(getShippingString(order, 'accountNickname'))
  if (canonicalNickname) return canonicalNickname

  const selectedNickname = normalizeShippingAccountName(order.selectedRate?.providerAccountNickname)
  if (selectedNickname) return selectedNickname

  const v2Account = getV2CarrierAccountForOrder(order)
  if (v2Account) return v2Account.nickname

  if (order.selectedRate) return 'External'

  if (order.label?.shippingProviderId != null) {
    const account = accounts.find((candidate) => candidate.shippingProviderId === order.label.shippingProviderId)
    const accountLabel = getCarrierAccountDisplay(account)
    if (accountLabel) return accountLabel
  }
  if (order.bestRate) {
    const nickname = normalizeShippingAccountName(order.bestRate.carrierNickname)
    if (nickname) return nickname
  }
  return formatCarrierCode(order.selectedRate?.carrierCode ?? order.bestRate?.carrierCode)
}

function getShipAccountLabelById(accounts: CarrierAccountDto[], accountId: string) {
  if (!accountId) return null
  const account = accounts.find((candidate) => String(candidate.shippingProviderId) === accountId)
  return getCarrierAccountDisplay(account)
}

function getBestRateBaseCost(order: OrderSummaryDto) {
  const canonicalAmount = getShippingNumber(order, 'bestRateAmount')
  if (canonicalAmount && canonicalAmount > 0) return canonicalAmount

  const hasShipmentCost = typeof order.bestRate?.shipmentCost === 'number'
  const hasOtherCost = typeof order.bestRate?.otherCost === 'number'
  const hasAmount = typeof order.bestRate?.amount === 'number'
  const shipmentCost = hasShipmentCost ? order.bestRate!.shipmentCost as number : 0
  const otherCost = hasOtherCost ? order.bestRate!.otherCost as number : 0
  const amount = hasAmount ? order.bestRate!.amount as number : 0
  const total = shipmentCost + otherCost
  if (total > 0) return total
  if (hasAmount) return amount
  if (hasShipmentCost || hasOtherCost) return total
  return null
}

function getBestRateShippingProviderId(order: OrderSummaryDto) {
  return getShippingProviderAccountId(order) ?? (order.bestRate ? toProviderAccountId(order.bestRate.shippingProviderId) ?? undefined : undefined)
}

function getBestRateServiceCode(order: OrderSummaryDto) {
  return getShippingString(order, 'serviceCode') ?? (order.bestRate ? toStringValue(order.bestRate.serviceCode) : null)
}

function getBestRateCarrierNickname(order: OrderSummaryDto) {
  return getShippingString(order, 'accountNickname') ?? (order.bestRate ? toStringValue(order.bestRate.carrierNickname) : null)
}

function getSelectedRateBaseCost(order: OrderSummaryDto) {
  const shipmentCost = typeof order.selectedRate?.shipmentCost === 'number' ? order.selectedRate.shipmentCost : 0
  const otherCost = typeof order.selectedRate?.otherCost === 'number' ? order.selectedRate.otherCost : 0
  if (shipmentCost > 0) return shipmentCost

  const rawLabelCost = toNumberValue(order.label?.rawCost)
  if (rawLabelCost != null && rawLabelCost > 0) return rawLabelCost

  const canonicalAmount = getShippingNumber(order, 'selectedRateAmount')
  if (canonicalAmount && canonicalAmount > 0) return canonicalAmount

  const cost = typeof order.selectedRate?.cost === 'number' ? order.selectedRate.cost : 0
  const labelCost = typeof order.label?.cost === 'number' ? order.label.cost : 0
  const total = shipmentCost + otherCost
  return total > 0 ? total : cost || labelCost || null
}

function getSelectedRateFinalCost(order: OrderSummaryDto) {
  return (
    getShippingNumber(order, 'labelCost') ??
    toNumberValue(order.label?.cost) ??
    toNumberValue(order.selectedRate?.cost) ??
    getShippingNumber(order, 'selectedRateAmount') ??
    null
  )
}

function getSelectedRateCarrierCode(order: OrderSummaryDto) {
  return (
    getShippingString(order, 'carrierCode') ??
    toStringValue(order.selectedRate?.carrierCode) ??
    toStringValue(order.bestRate?.carrierCode)
  )
}

function getSelectedRateServiceCode(order: OrderSummaryDto) {
  return (
    getShippingString(order, 'serviceCode') ??
    toStringValue(order.selectedRate?.serviceCode) ??
    toStringValue(order.bestRate?.serviceCode)
  )
}

function getSelectedRateCarrierNickname(order: OrderSummaryDto) {
  return (
    getShippingString(order, 'accountNickname') ??
    toStringValue(order.selectedRate?.providerAccountNickname) ??
    toStringValue(order.selectedRate?.carrierNickname) ??
    toStringValue(order.label?.carrierNickname) ??
    getV2CarrierAccountForOrder(order)?.nickname
  )
}

function getAwaitingDisplayAccountNickname(order: OrderSummaryDto) {
  return (
    getShippingString(order, 'accountNickname') ??
    toStringValue(order.selectedRate?.providerAccountNickname) ??
    toStringValue(order.selectedRate?.carrierNickname) ??
    normalizeShippingAccountName(getBestRateCarrierNickname(order)) ??
    getV2CarrierAccountForOrder(order)?.nickname ??
    null
  )
}

function getSelectedRateShippingProviderId(order: OrderSummaryDto) {
  return (
    getShippingProviderAccountId(order) ??
    toProviderAccountId(order.selectedRate?.shippingProviderId) ??
    toProviderAccountId(order.selectedRate?.providerAccountId) ??
    toProviderAccountId(order.label?.shippingProviderId) ??
    undefined
  )
}

function getMarkupAmount(baseAmount: number, markedAmount: number) {
  return markedAmount - baseAmount
}

function renderRateAmountWithMarkup(baseAmount: number | null, markedAmount: number | null) {
  const displayAmount = markedAmount ?? baseAmount
  if (displayAmount == null) return <span style={{ color: 'var(--text3)', fontSize: 11 }}>{'\u2014'}</span>

  const markupAmount = baseAmount != null && markedAmount != null ? Math.max(0, markedAmount - baseAmount) : null
  const hasMarkup = markupAmount != null && markupAmount >= 0.005
  const breakdownTitle =
    baseAmount != null && markupAmount != null && hasMarkup
      ? `Label Cost ${formatMoney(displayAmount)} | Base ${formatMoney(baseAmount)} + Markup ${formatMoney(markupAmount)}`
      : undefined
  return (
    <div style={{ lineHeight: 1.15 }} title={breakdownTitle}>
      <strong style={{ color: 'var(--green)', fontSize: 12 }}>{formatMoney(displayAmount)}</strong>
      {baseAmount != null && markupAmount != null && hasMarkup ? (
        <div style={{ fontSize: 10, color: '#111827', fontWeight: 600, whiteSpace: 'nowrap' }}>
          {formatMoney(baseAmount)}
        </div>
      ) : null}
    </div>
  )
}

function renderExtLabelBadge() {
  return (
    <span
      style={{
        display: 'inline-block',
        background: '#f0f0f0',
        color: '#666',
        padding: '2px 6px',
        borderRadius: 3,
        fontSize: 11,
        fontWeight: 600,
        cursor: 'help',
      }}
      title="Shipped via external carrier (Amazon/marketplace/eBay)"
    >
      Ext. Label
    </span>
  )
}

function hasAuthoritativeProviderId(order: OrderSummaryDto) {
  const providerId = getShippingProviderAccountId(order) ?? toProviderAccountId(order.label?.shippingProviderId)
  if (providerId == null) return false
  const sourceVersion = getCanonicalSourceVersion(order, 'shipping.providerAccountId')
  const sourceName = getCanonicalSourceName(order, 'shipping.providerAccountId')
  return sourceVersion === 'v2' && sourceName !== 'shipments.provider_account_id'
}

function hasV2SelectedRatePayload(order: OrderSummaryDto) {
  return getCanonicalSourceVersion(order, 'shipping.selectedRate') === 'v2'
}

function getIsExternallyFulfilled(order: OrderSummaryDto) {
  if (order.externalShipped) return true
  if (order.orderStatus === 'awaiting_shipment') return false
  const hasRealSelectedRate = hasV2SelectedRatePayload(order)
  return !order.label?.cost && !order.label?.trackingNumber && !hasAuthoritativeProviderId(order) && !hasRealSelectedRate
}

function getShippedDisplayCarrierCode(order: OrderSummaryDto) {
  if (getIsExternallyFulfilled(order)) {
    return toStringValue(order.carrierCode) ?? toStringValue(order.label?.carrierCode) ?? getShippingString(order, 'carrierCode')
  }
  return (
    toStringValue(order.label?.carrierCode) ??
    toStringValue(order.selectedRate?.carrierCode) ??
    toStringValue(order.carrierCode) ??
    getShippingString(order, 'carrierCode')
  )
}

function getShippedDisplayServiceCode(order: OrderSummaryDto) {
  if (getIsExternallyFulfilled(order)) {
    return toStringValue(order.serviceCode) ?? toStringValue(order.label?.serviceCode) ?? getShippingString(order, 'serviceCode')
  }
  return (
    toStringValue(order.selectedRate?.serviceCode) ??
    toStringValue(order.label?.serviceCode) ??
    toStringValue(order.serviceCode) ??
    getShippingString(order, 'serviceCode')
  )
}

function getShippedDisplayProviderId(order: OrderSummaryDto) {
  return (
    getShippingProviderAccountId(order) ??
    toProviderAccountId(order.selectedRate?.shippingProviderId) ??
    toProviderAccountId(order.selectedRate?.providerAccountId) ??
    toProviderAccountId(order.label?.shippingProviderId) ??
    toProviderAccountId(order.bestRate?.shippingProviderId) ??
    getV2CarrierAccountForOrder(order)?.shippingProviderId ??
    null
  )
}

function getShippedDisplayAccountNickname(order: OrderSummaryDto) {
  if (getIsExternallyFulfilled(order)) return null
  if (hasV2SelectedRatePayload(order)) {
    const selectedNickname = toStringValue(order.selectedRate?.providerAccountNickname)
    if (selectedNickname) return selectedNickname
  }
  return toStringValue(order.label?.carrierCode)
}

function getCancelledDisplayCarrierCode(order: OrderSummaryDto) {
  return (
    getShippingString(order, 'carrierCode') ??
    toStringValue(order.selectedRate?.carrierCode) ??
    toStringValue(order.label?.carrierCode) ??
    toStringValue(order.carrierCode) ??
    toStringValue(order.bestRate?.carrierCode)
  )
}

function getCancelledDisplayProviderId(order: OrderSummaryDto) {
  return (
    getSelectedRateShippingProviderId(order) ??
    toProviderAccountId(order.bestRate?.shippingProviderId) ??
    getV2CarrierAccountForOrder(order)?.shippingProviderId ??
    null
  )
}

function getCancelledDisplayServiceCode(order: OrderSummaryDto) {
  return (
    getShippingString(order, 'serviceCode') ??
    toStringValue(order.selectedRate?.serviceCode) ??
    toStringValue(order.label?.serviceCode) ??
    toStringValue(order.serviceCode) ??
    toStringValue(order.bestRate?.serviceCode)
  )
}

function getCancelledDisplayAccountNickname(order: OrderSummaryDto) {
  return (
    getSelectedRateCarrierNickname(order) ??
    normalizeShippingAccountName(getBestRateCarrierNickname(order)) ??
    getV2CarrierAccountForOrder(order)?.nickname ??
    normalizeShippingAccountName(order.label?.carrierCode) ??
    formatCarrierCode(getCancelledDisplayCarrierCode(order))
  )
}

function shouldShowCarrierExtLabel(order: OrderSummaryDto) {
  if (order.externalShipped) return true
  return order.orderStatus === 'shipped' && getIsExternallyFulfilled(order)
}

function getIsException(order: OrderSummaryDto) {
  if (order.orderStatus !== 'awaiting_shipment') return false
  return ageHours(order.orderDate) > 48 || !(order.weight?.value && order.weight.value > 0)
}

function getExpeditedBadge(order: OrderSummaryDto, detail: OrderFullDto | null) {
  const code = getRequestedService(order, detail)
  if (!code) return null
  if (/1[\s-]?day/i.test(code)) return { label: '🔴 1-day', color: '#dc2626' }
  if (/2[\s-]?day/i.test(code)) return { label: '🟠 2-day', color: '#d97706' }
  return null
}

function copyText(value: string) {
  if (!value || typeof navigator === 'undefined' || !navigator.clipboard) return
  void navigator.clipboard.writeText(value)
}

function getVisibleColumns(currentStatus: OrderStatus) {
  const hidden = new Set<TableColumnKey>()
  if (currentStatus !== 'awaiting_shipment') hidden.add('age')

  return TABLE_COLUMNS.filter((column) => !hidden.has(column.key)).map((column) => (
    column.key === 'bestrate' && currentStatus !== 'awaiting_shipment'
      ? { ...column, label: 'Selected Rate' }
      : column
  ))
}

function getSortValue(order: OrderSummaryDto, detail: OrderFullDto | null, key: SortKey, accounts: CarrierAccountDto[]) {
  switch (key) {
    case 'date':
    case 'age':
      return order.orderDate ?? ''
    case 'orderNum':
      return order.orderNumber ?? ''
    case 'client':
      return (order.clientName ?? '').toLowerCase()
    case 'customer':
      return (getShipTo(order, detail).name ?? '').toLowerCase()
    case 'itemname':
      return (getPrimaryItem(order, detail)?.name ?? '').toLowerCase()
    case 'sku':
      return (getPrimaryItem(order, detail)?.sku ?? '').toLowerCase()
    case 'qty':
      return getTotalQuantity(order, detail)
    case 'weight':
      return getOrderWeightOz(order, detail)
    case 'shipto': {
      const shipTo = getShipTo(order, detail)
      return `${shipTo.state ?? ''}${shipTo.city ?? ''}`.toLowerCase()
    }
    case 'carrier':
      if (isStrictShippedOrder(order)) {
        return `${getShippingString(order, 'carrierCode') ?? ''}${getShippingString(order, 'serviceCode') ?? ''}`.toLowerCase()
      }
      return `${getShippingString(order, 'carrierCode') ?? order.selectedRate?.carrierCode ?? order.bestRate?.carrierCode ?? ''}${getShippingString(order, 'serviceCode') ?? order.selectedRate?.serviceCode ?? getBestRateServiceCode(order) ?? ''}`.toLowerCase()
    case 'custcarrier':
      return String(getShipAccountDisplay(order, accounts)).toLowerCase()
    case 'total':
      return order.orderTotal ?? 0
  }
}

function buildEmptyPanel(onHide?: () => void) {
  const kbdCls =
    'inline-block bg-surface-3 px-1.5 py-px rounded text-[10px] border border-line-2 font-mono tabular-nums'
  return (
    <div className="relative flex flex-col items-center justify-center h-full px-5 py-10 text-center text-ink-3 animate-[fadeIn_0.3s_ease-out]">
      {/* Drawer-style close button — top-right of the empty panel. */}
      {onHide ? (
        <button
          type="button"
          onClick={onHide}
          aria-label="Hide this panel when no order is selected"
          title="Hide this panel when no order is selected"
          className="absolute top-2 right-2 inline-flex items-center justify-center w-7 h-7 rounded-md text-ink-3 hover:text-ink hover:bg-surface-2 ring-1 ring-transparent hover:ring-line transition"
        >
          <XIcon size={14} strokeWidth={2.5} aria-hidden />
        </button>
      ) : null}

      {/* Subtle iconographic mark — quiet, framed, refined.
          Linear / Mercury idiom: small icon inside a soft tinted ring,
          rather than a giant emoji. Reads as a state indicator, not a
          mascot. */}
      <div className="mb-4 inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-surface-2 ring-1 ring-line text-ink-3 animate-[bounceIn_0.5s_cubic-bezier(0.34,1.56,0.64,1)]">
        <Inbox size={20} strokeWidth={1.75} aria-hidden />
      </div>

      <div className="text-[14px] font-semibold mb-1 text-ink-2 font-display tracking-tight">
        No order selected
      </div>
      <div className="text-[11.5px] leading-relaxed mb-5 text-ink-3">
        Click any row to view details
      </div>
      <div className="text-left text-[11px] leading-loose text-ink-4 border-t border-line pt-3.5 w-full max-w-[180px] space-y-0.5">
        <div><kbd className={kbdCls}>↑↓</kbd> <span className="ml-1">Navigate rows</span></div>
        <div><kbd className={kbdCls}>Enter</kbd> <span className="ml-1">Select / deselect</span></div>
        <div><kbd className={kbdCls}>Esc</kbd> <span className="ml-1">Deselect &amp; close</span></div>
        <div><kbd className={kbdCls}>⌘C</kbd> <span className="ml-1">Copy order #</span></div>
      </div>
    </div>
  )
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
) {
  let nextIndex = 0
  const workerCount = Math.min(Math.max(1, limit), items.length)

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      await worker(items[index], index)
      await yieldToBrowser()
    }
  }))
}

export default function OrdersView({
  currentStatus,
  searchQuery = '',
  onSearchQueryChange,
  activeStore,
  dateFilter = '',
  onDateFilterChange,
  onResolvedDateRangeChange,
  selectedOrderIds = [],
  onSelectedOrderIdsChange,
  activeOrderId = null,
  onActiveOrderIdChange,
  onNavigateView,
  columnMenuRequestId = 0,
  labelsActionRequestId = 0,
  queueToggleRequestId = 0,
  onQueueStateChange,
  refreshVersion = 0,
  filterResetVersion = 0,
  showTestOrders = true,
  hideEmptyPanel = false,
  onHideEmptyPanelChange,
  stores = [],
}: OrdersViewProps) {
  const toastContext = useContext(ToastContext)
  const { user: authUser } = useAuth()
  // Order assignment: only admins can assign orders to other users. Workers
  // see only their own assigned rows (server-side filter; this flag just
  // controls visibility of the admin-only UI).
  const ADMIN_EMAILS = useMemo(() => new Set(['admin@drprepper.com']), [])
  const callerIsAdmin = Boolean(authUser?.email && ADMIN_EMAILS.has(authUser.email.toLowerCase()))
  type AssignableUser = { id: string; email: string; isAdmin: boolean }
  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[]>([])
  const [assignTo, setAssignTo] = useState<string>('')  // userId or '' (none) or 'unassign'
  const [assignBusy, setAssignBusy] = useState(false)
  useEffect(() => {
    if (!callerIsAdmin) return
    let cancelled = false
    void api.get<{ users: AssignableUser[] }>('/users')
      .then((res) => {
        if (cancelled) return
        setAssignableUsers(res.users ?? [])
      })
      .catch((err) => console.warn('[orders] failed to load assignable users:', err))
    return () => { cancelled = true }
  }, [callerIsAdmin])
  const [page, setPage] = useState(1)
  // Page-size selector — operator picks how many rows per page from a
  // small set. Persisted to localStorage so it survives reloads. The
  // value is read once on first render and clamped to the allowed
  // options (defends against a stale localStorage value if we ever
  // change the option set). 50 is the default, matching the prior
  // hardcoded behavior so no operator sees a sudden density change.
  // Page-size options. Higher values let operators see more orders
  // per page when they want to scan a lot at once (the user reported
  // 'i only see few even i have a thousand'). 200 was the previous
  // cap and felt restrictive when the Shipped tab has 30k+ rows.
  // 500/1000/2000 are reasonable upper limits — beyond ~2000 the
  // browser starts struggling with DOM size, and the right answer
  // becomes virtualized scrolling, not a bigger page. Backend cap is
  // also raised to 2000 (src/lib/pagination.ts) so the request doesn't
  // get clamped silently.
  const ALLOWED_PAGE_SIZES = [25, 50, 100, 200, 500, 1000, 2000] as const
  const PAGE_SIZE_STORAGE_KEY = 'prepship_orders_page_size'
  const [pageSize, setPageSize] = useState<number>(() => {
    if (typeof window === 'undefined') return 50
    const raw = window.localStorage.getItem(PAGE_SIZE_STORAGE_KEY)
    const parsed = Number(raw)
    return ALLOWED_PAGE_SIZES.includes(parsed as (typeof ALLOWED_PAGE_SIZES)[number])
      ? parsed
      : 50
  })
  // When operator changes page size, reset to page 1. Without this they
  // could pick "200" while sitting on page 4 of a 50-per-page list and
  // end up out-of-bounds (page 4 of a 1-page result = empty list).
  const updatePageSize = (size: number) => {
    setPageSize(size)
    setPage(1)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(size))
    }
  }
  const [skuFilter, setSkuFilter] = useState('')
  const [customDateFrom, setCustomDateFrom] = useState('')
  const [customDateTo, setCustomDateTo] = useState('')
  const [sortState, setSortState] = useState<{ key: SortKey; dir: SortDirection }>({ key: 'date', dir: 'desc' })
  const [skuSortActive, setSkuSortActive] = useState(false)
  const [preSkuSortSnapshot, setPreSkuSortSnapshot] = useState<number[] | null>(null)
  const [kbRowId, setKbRowId] = useState<number | null>(null)
  const [collapsedSections, setCollapsedSections] = useState<Record<PanelSectionKey, boolean>>({
    shipping: false,
    items: false,
    recipient: false,
  })
  const [packages, setPackages] = useState<PackageDto[]>([])
  const [packagesLoaded, setPackagesLoaded] = useState(false)
  const [dailyStats, setDailyStats] = useState<OrdersDailyStatsDto | null>(null)
  const [columnPrefs, setColumnPrefs] = useState<ColumnPrefs | null>(null)
  const [columnMenuOpen, setColumnMenuOpen] = useState(false)
  const [columnMenuPos, setColumnMenuPos] = useState<{ top: number; right: number } | null>(null)
  const [dragColumnKey, setDragColumnKey] = useState<TableColumnKey | null>(null)
  const [dragOverColumnKey, setDragOverColumnKey] = useState<TableColumnKey | null>(null)
  const [dropdownDragColumnKey, setDropdownDragColumnKey] = useState<TableColumnKey | null>(null)
  const [dropdownDragOverColumnKey, setDropdownDragOverColumnKey] = useState<TableColumnKey | null>(null)
  const [resizingColumnKey, setResizingColumnKey] = useState<TableColumnKey | null>(null)
  const [queueOpen, setQueueOpen] = useState(false)
  const [queueHistoryVisible, setQueueHistoryVisible] = useState(false)
  // Print Queue panel: free-text filter for both active queue + history list,
  // plus sort direction for the printed-history list (newest first by default).
  const [pqSearch, setPqSearch] = useState('')
  const [pqHistoryAsc, setPqHistoryAsc] = useState(false)
  const [queueEntries, setQueueEntries] = useState<PrintQueueEntryDto[]>([])
  const [queueEntriesClientId, setQueueEntriesClientId] = useState<number | null>(null)
  const [queueLoading, setQueueLoading] = useState(false)
  const [queueActionProgress, setQueueActionProgress] = useState<QueueActionProgress | null>(null)
  const [queuePrintMessage, setQueuePrintMessage] = useState<string | null>(null)
  const [queuePrintProgress, setQueuePrintProgress] = useState<number | null>(null)
  const [queuePrintInFlight, setQueuePrintInFlight] = useState(false)
  const [rateBrowserOpen, setRateBrowserOpen] = useState(false)
  const [detailDrawerOrderId, setDetailDrawerOrderId] = useState<number | null>(null)
  const [detailDrawerFromQueue, setDetailDrawerFromQueue] = useState(false)
  const [trackingModal, setTrackingModal] = useState<{
    tracking: string
    carrierCode: string | null
  } | null>(null)
  const [rateBrowserLoading, setRateBrowserLoading] = useState(false)
  const [rateBrowserRates, setRateBrowserRates] = useState<Array<Record<string, unknown>>>([])
  const [rateBrowserCarrierFilter, setRateBrowserCarrierFilter] = useState<number | null>(null)
  const [printMenuOpen, setPrintMenuOpen] = useState(false)
  const [batchMenuOpen, setBatchMenuOpen] = useState(false)
  const [extShipMenuOpen, setExtShipMenuOpen] = useState(false)
  // Separate open-state for the BATCH Mark-as-Shipped popover (in the
  // batch panel that appears when 2+ orders are selected). Reuses the
  // same notify toggles + tracking state below as the single-order
  // popover, but its visibility is independent so opening one doesn't
  // close the other.
  const [batchExtShipMenuOpen, setBatchExtShipMenuOpen] = useState(false)
  // External-shipped popover form state. The popover is a small inline
  // form (toggles + tracking) instead of the previous bare list of
  // marketplaces, so the user can opt into Notify Customer / Notify
  // Marketplace at the same moment they pick the marketplace.
  //
  // Defaults match what most operators want: notify the marketplace
  // (so Amazon/eBay close the loop) but DON'T email the customer
  // (the marketplace's own status email gets there first and an
  // extra one looks redundant).
  const [extShipNotifyCustomer, setExtShipNotifyCustomer] = useState(false)
  const [extShipNotifyMarketplace, setExtShipNotifyMarketplace] = useState(true)
  const [extShipTracking, setExtShipTracking] = useState('')
  const [extShipBusy, setExtShipBusy] = useState(false)
  const [batchBusy, setBatchBusy] = useState(false)
  const [batchTestMode, setBatchTestMode] = useState(false)
  // Set of orderIds that just successfully shipped — they render with
  // Per-order print-label transition (boss directive 2026-05-07):
  // Continuous 30-second fade animation on the row (CSS keyframe
  // `ps-shipping-fade` in app-shell.css). The fade runs for the FULL
  // 30 seconds — not just at the end — so the operator visibly sees
  // the order leaving the awaiting list and "going to shipped". A
  // green "Shipping…" pill animates inline next to the order number
  // throughout to signal the action is in progress.
  //
  // At t=30 s the timer fires `refetchOrders()`. Backend already has
  // the order as 'shipped' (per order-sync race fix in 1afe757) so
  // the refresh drops the row from the awaiting list naturally.
  const [transitionalShippedIds, setTransitionalShippedIds] = useState<Set<number>>(new Set())
  const transitionalTimeoutsRef = useRef<Map<number, number>>(new Map())
  // Tracks which order# pill in the batch panel was just copied. Set on
  // click, cleared after ~1.2s so the pill flashes a "Copied!" check
  // and reverts. Single string at a time — clicking another pill
  // immediately replaces the previous flash.
  const [copiedOrderNum, setCopiedOrderNum] = useState<string | null>(null)
  const [copiedAll, setCopiedAll] = useState(false)
  // Row-density preference for the orders table. Persists per-browser so a
  // user who picks Narrow stays Narrow across reloads. Three steps:
  //   - narrow:  ~24 px row, 11 px font (max rows visible)
  //   - cozy:    ~34 px row, 12.5 px font (default, what the table had before)
  //   - wide:    ~48 px row, 13 px font (more breathing room, easier to scan)
  type TableDensity = 'narrow' | 'cozy' | 'wide'
  const [tableDensity, setTableDensity] = useState<TableDensity>(() => {
    if (typeof window === 'undefined') return 'cozy'
    const saved = window.localStorage.getItem('orders_table_density')
    return saved === 'narrow' || saved === 'cozy' || saved === 'wide' ? saved : 'cozy'
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem('orders_table_density', tableDensity)
  }, [tableDensity])

  const [singleActionBusy, setSingleActionBusy] = useState(false)
  const [shipmentDetailsSaving, setShipmentDetailsSaving] = useState(false)
  const queueActionProgressTimerRef = useRef<number | null>(null)
  const queueActionHeartbeatTimerRef = useRef<number | null>(null)
  const activePersistentQueueJobIdRef = useRef<string | null>(null)
  const resumePersistentQueueJobIdRef = useRef<string | null>(null)
  const lastSelectionAnchorRef = useRef<number | null>(null)
  const shiftHeldOnMouseDownRef = useRef(false)
  const [panelForm, setPanelForm] = useState<PanelFormState>({
    locationId: '',
    shipAccountId: '',
    serviceCode: '',
    weightLb: '',
    weightOz: '',
    length: '',
    width: '',
    height: '',
    packageId: '',
    confirmation: 'delivery',
    insurance: 'none',
    insuranceValue: '',
  })
  const [panelRatePreview, setPanelRatePreview] = useState<Array<Record<string, unknown>>>([])
  const [panelRateLoading, setPanelRateLoading] = useState(false)
  const columnMenuRef = useRef<HTMLDivElement | null>(null)
  const resolvedColumnPrefsRef = useRef(null)
  const columnPrefsRef = useRef<ColumnPrefs | null>(null)
  const currentStatusRef = useRef(currentStatus)

  // ─── SHIPPED / CANCELLED LOCKDOWN — DISABLED ──────────────────────
  // Per user override `unlock shipped data` on 2026-05-06: the
  // Shipped / Cancelled UI lockdown has been disabled. Checkboxes,
  // Select All, SKU-group select, and the batch actions panel are
  // re-enabled in those views.
  //
  // Defense-in-depth still applies at the BACKEND:
  //   • src/routes/orders.ts — every modification endpoint guards
  //     with assertOrderEditable() which rejects shipped/cancelled
  //     orders with HTTP 409 unless ?force=1&admin=true is passed.
  //   • src/services/fulfillment-deductions.ts — both deduction
  //     paths gated by isInventoryAutoDeductEnabled() kill switch.
  // So even if the user batch-clicks Print Labels on shipped orders,
  // the API will reject the call. The UI just no longer hides the
  // entry point.
  //
  // To re-enable the UI lockdown, change the right-hand side back to
  //   currentStatus === 'shipped' || currentStatus === 'cancelled'
  // and the five consumer sites (search isReadOnly) will gate again.
  const isReadOnly = false
  const resizeStateRef = useRef<{ key: TableColumnKey; startX: number; startWidth: number } | null>(null)
  const pendingResizeWidthsRef = useRef<Record<TableColumnKey, number> | null>(null)
  const resizeFrameRef = useRef<number | null>(null)
  const suppressHeaderClickRef = useRef(false)
  const selectAllCheckboxRef = useRef<HTMLInputElement | null>(null)
  const autoPackageDimsKeyRef = useRef<string | null>(null)
  const panelFormInitKeyRef = useRef<string | null>(null)
  const shipmentAutoSaveTimerRef = useRef<number | null>(null)
  const shipmentLastSavedKeyRef = useRef<string | null>(null)
  const bestRateRefreshSeqRef = useRef(0)
  // Tracks whether the user has *manually* edited weight or any dim in the
  // panel since the current order was loaded. The auto-rate-refresh effect
  // only fires when this is true. Reset to false whenever panelOrderId
  // changes, set to true inside the panel input onChange handlers.
  // Without this, simply clicking an order seeds weight/dims into the form
  // (in a render cycle separate from the orderId change), trips the effect's
  // deps, and fires an unwanted /rates fetch.
  const dimsUserEditedRef = useRef(false)

  const clearQueueActionProgressTimer = () => {
    if (queueActionProgressTimerRef.current == null) return
    window.clearTimeout(queueActionProgressTimerRef.current)
    queueActionProgressTimerRef.current = null
  }

  const clearQueueActionHeartbeatTimer = () => {
    if (queueActionHeartbeatTimerRef.current == null) return
    window.clearInterval(queueActionHeartbeatTimerRef.current)
    queueActionHeartbeatTimerRef.current = null
  }

  const startQueueActionHeartbeat = () => {
    clearQueueActionHeartbeatTimer()
    queueActionHeartbeatTimerRef.current = window.setInterval(() => {
      setQueueActionProgress((current) => current ? { ...current, tick: current.tick + 1 } : current)
    }, 1000)
  }

  const startQueueActionProgress = (total: number, label = 'Sending to queue', completed = 0, failed = 0) => {
    clearQueueActionProgressTimer()
    startQueueActionHeartbeat()
    setQueueActionProgress({
      label,
      completed: Math.min(Math.max(total, 1), Math.max(completed, 0)),
      total: Math.max(total, 1),
      failed: Math.max(failed, 0),
      startedAt: Date.now(),
      tick: 0,
    })
  }

  const setQueueActionProgressLabel = (label: string) => {
    setQueueActionProgress((current) => current ? { ...current, label } : current)
  }

  const advanceQueueActionProgress = (failedDelta = 0, completedDelta = 1) => {
    setQueueActionProgress((current) => current
      ? {
          ...current,
          completed: Math.min(current.total, current.completed + completedDelta),
          failed: current.failed + failedDelta,
          tick: current.tick + 1,
        }
      : current
    )
  }

  const finishQueueActionProgress = (label: string) => {
    setQueueActionProgress((current) => current
      ? { ...current, label, completed: current.total }
      : current
    )
    clearQueueActionProgressTimer()
    clearQueueActionHeartbeatTimer()
    queueActionProgressTimerRef.current = window.setTimeout(() => {
      setQueueActionProgress(null)
      queueActionProgressTimerRef.current = null
    }, 2200)
  }

  useEffect(() => {
    return () => {
      clearQueueActionProgressTimer()
      clearQueueActionHeartbeatTimer()
      // Clean up any in-flight transitional-shipped timers so they
      // don't fire after unmount (would update state on a dead
      // component). Single 30s timer per order in the new design.
      for (const t of transitionalTimeoutsRef.current.values()) {
        window.clearTimeout(t)
      }
      transitionalTimeoutsRef.current.clear()
    }
  }, [])

  function beginPersistentQueueJob(
    kind: PersistentQueueJobKind,
    jobOrders: OrderSummaryDto[],
    options: { label?: string; batchTestMode?: boolean } = {},
  ) {
    const job = createPersistentQueueJob(kind, jobOrders, options)
    activePersistentQueueJobIdRef.current = job.id
    startQueueActionProgress(job.total, job.label)
    return job.id
  }

  function finishPersistentQueueJob(jobId: string | null | undefined) {
    if (jobId) clearPersistentQueueJob(jobId)
    if (activePersistentQueueJobIdRef.current === jobId) {
      activePersistentQueueJobIdRef.current = null
    }
  }

  const dateRange = dateFilter === 'custom'
    ? {
        start: customDateFrom || undefined,
        end: customDateTo || undefined,
      }
    : (() => {
        const range = getOrdersDateRange(dateFilter)
        if (!range) return { start: undefined, end: undefined }

        return {
          start: range.start.toISOString().split('T')[0],
          end: range.end.toISOString().split('T')[0],
        }
      })()

  // Hide Test Orders client across every status tab (Awaiting / Shipped /
  // Cancelled), not just Awaiting. Toggle in the sidebar still controls the
  // override. Only suppressed when no specific store is selected — viewing
  // the Test Orders client directly always shows its rows.
  const hideTestOrdersInAllAwaiting =
    activeStore == null && !showTestOrders

  const { orders, total, pages, currentPage, loading, error, refetch: refetchOrders } = useOrders(currentStatus, {
    page,
    pageSize,
    storeId: activeStore ?? undefined,
    dateStart: dateRange.start,
    dateEnd: dateRange.end,
    hideTestOrders: hideTestOrdersInAllAwaiting,
    search: searchQuery,
    // Forwarded so the backend filters by SKU exactly. Replaces the
    // old client-side filter (now removed below) which only ran over
    // the current paginated page and missed matches on later pages.
    sku: skuFilter,
  })

  useEffect(() => {
    onResolvedDateRangeChange?.(dateRange)
  }, [dateRange.start, dateRange.end, onResolvedDateRangeChange])

  const { order: activeOrderDetail, isLoading: activeOrderLoading, error: activeOrderError } = useOrderDetail(
    activeOrderId != null ? String(activeOrderId) : '',
  )
  const { locations } = useLocations()
  const { accounts: shippingAccounts } = useShippingAccounts()
  const { markups } = useMarkups()

  const orderDetailsById = useMemo(() => (
    activeOrderId != null && activeOrderDetail != null
      ? new Map<number, OrderFullDto>([[activeOrderId, activeOrderDetail]])
      : new Map<number, OrderFullDto>()
  ), [activeOrderId, activeOrderDetail])

  const selectedIdSet = useMemo(() => new Set(selectedOrderIds), [selectedOrderIds])
  const resolvedColumnPrefs = useMemo(
    () => resolveColumnPrefs(TABLE_COLUMNS.map((column) => ({ key: column.key, label: column.label, width: column.width })), currentStatus, columnPrefs),
    [currentStatus, columnPrefs],
  )
  const visibleColumns = useMemo(
    () => resolvedColumnPrefs.orderedColumns
      .filter((column) => !resolvedColumnPrefs.hiddenColumns.has(column.key))
      .map((column) => (
        column.key === 'bestrate' && currentStatus !== 'awaiting_shipment'
          ? { ...TABLE_COLUMNS.find((candidate) => candidate.key === column.key)!, label: 'Selected Rate', width: resolvedColumnPrefs.widths[column.key] }
          : { ...TABLE_COLUMNS.find((candidate) => candidate.key === column.key)!, width: resolvedColumnPrefs.widths[column.key] }
      )),
    [currentStatus, resolvedColumnPrefs],
  )
  const tableWidth = useMemo(
    () => Math.max(800, visibleColumns.reduce((totalWidth, column) => totalWidth + column.width, 0)),
    [visibleColumns],
  )
  resolvedColumnPrefsRef.current = resolvedColumnPrefs
  columnPrefsRef.current = columnPrefs
  currentStatusRef.current = currentStatus

  // GLOBAL SKU dropdown — was previously derived from the in-memory
  // `orders` array, so it only ever showed SKUs from the ~50 orders on
  // the current page. Now backed by a /orders/distinct-skus call that
  // returns every SKU across the entire orders table (filtered by the
  // currently-visible status + store so the dropdown still feels
  // contextual when no search is active).
  //
  // The fetch fires once per status+store change (and once on mount).
  // Returning to a previous status re-uses the in-flight cache via the
  // useEffect dep change cycle — perfectly fine for this dropdown
  // because it's hidden until the user clicks it.
  const [globalSkus, setGlobalSkus] = useState<string[]>([])
  useEffect(() => {
    let cancelled = false
    void apiClient
      .fetchDistinctSkus({
        // When no specific store is selected, leave clientId/storeId
        // unset so the dropdown shows EVERY SKU. When a store is
        // active, narrow to that store so the list isn't visually
        // overwhelming with SKUs that don't apply.
        status: currentStatus,
        storeId: activeStore ?? undefined,
        dateFrom: dateRange.start,
        dateTo: dateRange.end,
      })
      .then((skus) => {
        if (cancelled) return
        setGlobalSkus(skus)
      })
    return () => {
      cancelled = true
    }
  }, [currentStatus, activeStore, dateRange.start, dateRange.end])

  // Fall back to the in-memory derivation if the global fetch is empty
  // or hasn't returned yet — keeps the dropdown populated on first
  // render instead of going blank for the network round-trip.
  const skuOptions = useMemo(() => {
    if (globalSkus.length > 0) {
      // Trust the backend list (already sorted ASC, already filtered
      // for adjustments + excluded stores).
      return globalSkus
    }
    const skus = new Set<string>()
    for (const order of orders) {
      for (const item of normalizeItems(order.items)) {
        if (item.adjustment || !item.sku) continue
        skus.add(item.sku)
      }
    }
    return [...skus].sort((left, right) => left.localeCompare(right))
  }, [globalSkus, orders])

  const searchedOrders = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    const skuNeedle = skuFilter.trim().toLowerCase()
    return orders.filter((order) => {
      const detail = orderDetailsById.get(order.orderId) ?? null
      if (hideTestOrdersInAllAwaiting && isTestOrder(order, detail)) return false
      if (query && !buildSearchText(order, detail).includes(query)) return false
      // SKU filter — primary work happens SERVER-SIDE via useOrders.
      // The client-side check was previously REJECTING server-confirmed
      // matches because of subtle string differences between what the
      // dropdown captured (from /distinct-skus) and what's in
      // order.items[].sku in the list payload (different jsonb
      // serialization paths). User saw '1,653 total' in pagination
      // but 'No orders match' in the table.
      //
      // Two-rail safer behavior:
      //   1. Trust the backend by default — if the order is in the
      //      response, assume it matches. (Previously this filter was
      //      a strict gate; now it's a soft cross-check.)
      //   2. ONLY reject if we have non-empty local items AND we're
      //      certain none match (normalized compare). Empty / missing
      //      items array → keep the order (the backend already
      //      verified the SKU server-side via SQL).
      if (skuNeedle) {
        const items = getActiveItems(order, detail)
        if (items.length > 0) {
          const hit = items.some((item) =>
            (item.sku ?? '').trim().toLowerCase() === skuNeedle
          )
          if (!hit) return false
        }
        // items missing/empty → trust backend, don't reject
      }
      return true
    })
  }, [orders, orderDetailsById, hideTestOrdersInAllAwaiting, searchQuery, skuFilter])

  const orderedFilteredOrders = useMemo(() => {
    const next = [...searchedOrders]

    if (skuSortActive) {
      next.sort((left, right) => {
        const leftDetail = orderDetailsById.get(left.orderId) ?? null
        const rightDetail = orderDetailsById.get(right.orderId) ?? null
        const leftSku = getPrimarySku(left, leftDetail)
        const rightSku = getPrimarySku(right, rightDetail)
        if (leftSku < rightSku) return -1
        if (leftSku > rightSku) return 1
        return getTotalQuantity(left, leftDetail) - getTotalQuantity(right, rightDetail)
      })
      return next
    }

    if (preSkuSortSnapshot) {
      const rank = new Map(preSkuSortSnapshot.map((orderId, index) => [orderId, index]))
      next.sort((left, right) => {
        return (rank.get(left.orderId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.orderId) ?? Number.MAX_SAFE_INTEGER)
      })
      return next
    }

    next.sort((left, right) => {
      const leftDetail = orderDetailsById.get(left.orderId) ?? null
      const rightDetail = orderDetailsById.get(right.orderId) ?? null
      const leftValue = getSortValue(left, leftDetail, sortState.key, shippingAccounts)
      const rightValue = getSortValue(right, rightDetail, sortState.key, shippingAccounts)
      const direction = sortState.dir === 'asc' ? 1 : -1
      if (leftValue < rightValue) return -direction
      if (leftValue > rightValue) return direction
      return 0
    })

    return next
  }, [searchedOrders, skuSortActive, preSkuSortSnapshot, sortState, orderDetailsById, shippingAccounts])
  const skuOrderGroups = useMemo(
    () => (
      skuSortActive
        ? groupOrdersBySku(
            orderedFilteredOrders,
            (order) => getPrimarySkuLabel(order, orderDetailsById.get(order.orderId) ?? null),
            (order) => getTotalQuantity(order, orderDetailsById.get(order.orderId) ?? null),
          )
        : []
    ),
    [orderedFilteredOrders, orderDetailsById, skuSortActive],
  )
  const visibleOrderIds = useMemo(
    () => orderedFilteredOrders.map((order) => order.orderId),
    [orderedFilteredOrders],
  )
  const visibleSelectedCount = useMemo(
    () => visibleOrderIds.filter((orderId) => selectedIdSet.has(orderId)).length,
    [visibleOrderIds, selectedIdSet],
  )
  const allVisibleSelected = visibleOrderIds.length > 0 && visibleSelectedCount === visibleOrderIds.length
  const someVisibleSelected = visibleSelectedCount > 0 && !allVisibleSelected

  const panelOrderId = activeOrderId ?? (selectedOrderIds.length === 1 ? selectedOrderIds[0] : null)
  const panelOrder = orderedFilteredOrders.find((order) => order.orderId === panelOrderId)
    ?? orders.find((order) => order.orderId === panelOrderId)
    ?? null
  const dailyStripProgress = dailyStats ? buildDailyStripProgress(dailyStats) : null
  // Replace any "PT" / "PST" / "PDT" suffix in the server-formatted
  // labels with "CA" so the daily strip's date range matches the rest
  // of the app's labeling convention (boss directive 2026-05-07).
  const normalizeTzLabel = (s: string) =>
    s.replace(/\b(?:PST|PDT|PT)\b/g, 'CA')
  const dailyStatsFromLabel = normalizeTzLabel(
    dailyStats?.window.fromLabel || dailyStats?.window.from || ''
  )
  const dailyStatsToLabel = normalizeTzLabel(
    dailyStats?.window.toLabel || dailyStats?.window.to || ''
  )
  const panelDetail = panelOrderId != null ? orderDetailsById.get(panelOrderId) ?? null : null
  const activeStoreClientId = useMemo(() => {
    if (activeStore == null) return null
    if (activeStore < 0) return Math.abs(activeStore)
    const store = stores.find((row) => row.storeId === activeStore)
    return typeof store?.clientId === 'number' ? store.clientId : null
  }, [activeStore, stores])
  const queueClientId = useMemo(() => {
    const selected = orders.find((order) => selectedIdSet.has(order.orderId) && order.clientId != null)
    if (selected?.clientId != null) return selected.clientId
    if (panelOrder?.clientId != null) return panelOrder.clientId
    if (activeStoreClientId != null) return activeStoreClientId
    return orders.find((order) => order.clientId != null)?.clientId ?? null
  }, [activeStoreClientId, orders, panelOrder, selectedIdSet])

  useEffect(() => {
    setPage(1)
  }, [currentStatus, activeStore, dateFilter, customDateFrom, customDateTo, hideTestOrdersInAllAwaiting, searchQuery])

  useEffect(() => {
    setPreSkuSortSnapshot(null)
    setSkuSortActive(false)
  }, [currentStatus, activeStore, dateFilter, customDateFrom, customDateTo, skuFilter, searchQuery])

  useEffect(() => {
    const visibleIds = new Set(orders.map((order) => order.orderId))
    const nextSelected = selectedOrderIds.filter((id) => visibleIds.has(id))
    if (nextSelected.length !== selectedOrderIds.length) {
      onSelectedOrderIdsChange?.(nextSelected)
    }
    if (activeOrderId != null && !visibleIds.has(activeOrderId)) {
      onActiveOrderIdChange?.(null)
    }
  }, [orders, selectedOrderIds, activeOrderId, onSelectedOrderIdsChange, onActiveOrderIdChange])

  useEffect(() => {
    if (!selectAllCheckboxRef.current) return
    selectAllCheckboxRef.current.indeterminate = someVisibleSelected
  }, [someVisibleSelected])

  useEffect(() => {
    let cancelled = false

    setPackagesLoaded(false)
    void apiClient.fetchPackages()
      .then((payload) => {
        if (!cancelled) {
          setPackages(payload)
          setPackagesLoaded(true)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPackages([])
          setPackagesLoaded(true)
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const localPrefs = readLocalColumnPrefs()
    if (localPrefs) {
      columnPrefsRef.current = localPrefs
      setColumnPrefs(localPrefs)
    }

    void apiClient.fetchColumnPrefs()
      .then((payload) => {
        if (!cancelled) {
          const nextPrefs = payload ?? localPrefs
          if (nextPrefs) writeLocalColumnPrefs(nextPrefs)
          columnPrefsRef.current = nextPrefs
          setColumnPrefs(nextPrefs)
        }
      })
      .catch(() => {
        if (!cancelled) {
          columnPrefsRef.current = localPrefs
          setColumnPrefs(localPrefs)
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (currentStatus !== 'awaiting_shipment' && currentStatus !== 'shipped') {
      setDailyStats(null)
      return
    }

    let cancelled = false
    let rolloverTimer: number | null = null

    const loadDailyStats = async () => {
      try {
        const payload = await apiClient.fetchDailyStats()
        if (!cancelled) setDailyStats(payload)
      } catch {
        if (!cancelled) setDailyStats(null)
      }
    }

    const scheduleRolloverRefresh = () => {
      if (rolloverTimer !== null) window.clearTimeout(rolloverTimer)
      rolloverTimer = window.setTimeout(() => {
        void loadDailyStats()
        scheduleRolloverRefresh()
      }, getMsUntilNextDailyStatsRollover())
    }

    void loadDailyStats()
    scheduleRolloverRefresh()
    const timer = window.setInterval(() => {
      void loadDailyStats()
    }, 5 * 60 * 1000)

    return () => {
      cancelled = true
      window.clearInterval(timer)
      if (rolloverTimer !== null) window.clearTimeout(rolloverTimer)
    }
  }, [currentStatus])

  useEffect(() => {
    if (refreshVersion === 0) return
    void refetchOrders()
  }, [refreshVersion, refetchOrders])

  // Sidebar nav resets — Home bumps `filterResetVersion` whenever the
  // user clicks a sidebar entry. We clear all OrdersView-local filters
  // (sku + custom date inputs) so the new view starts with a clean
  // slate. Search + dateFilter live in Home and are reset there
  // directly. Skip on initial mount (filterResetVersion=0) so a
  // bookmarked /orders/awaiting_shipment URL doesn't lose pre-filled
  // filter state on first render.
  useEffect(() => {
    if (filterResetVersion === 0) return
    setSkuFilter('')
    setCustomDateFrom('')
    setCustomDateTo('')
    setPage(1)
  }, [filterResetVersion])

  useEffect(() => {
    if (columnMenuRequestId === 0) return
    setColumnMenuOpen((open) => !open)
  }, [columnMenuRequestId])

  useEffect(() => {
    if (queueToggleRequestId === 0) return
    setQueueOpen((open) => !open)
  }, [queueToggleRequestId])

  useEffect(() => {
    if (labelsActionRequestId === 0) return
    void handleTopbarLabels()
  }, [labelsActionRequestId])

  useEffect(() => {
    if (!columnMenuOpen) return

    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('.react-column-menu')) return
      // The topbar anchor toggles the menu via columnMenuRequestId — let that
      // handler run instead of double-firing a close here.
      if (target?.closest('[data-columns-anchor]')) return
      setColumnMenuOpen(false)
    }

    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [columnMenuOpen])

  // Anchor the column menu to the actual topbar button via fixed positioning.
  useEffect(() => {
    if (!columnMenuOpen) {
      setColumnMenuPos(null)
      return
    }
    const measure = () => {
      const anchor = document.querySelector<HTMLElement>('[data-columns-anchor]')
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      setColumnMenuPos({
        top: rect.bottom + 6,
        right: Math.max(8, window.innerWidth - rect.right),
      })
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [columnMenuOpen])

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      const resizeState = resizeStateRef.current
      if (!resizeState) return

      const prefs = getLatestColumnPrefs()
      const nextWidth = Math.max(getColumnMinWidth(resizeState.key), resizeState.startWidth + (event.clientX - resizeState.startX))
      const nextWidths = {
        ...prefs.widths,
        [resizeState.key]: nextWidth,
      }
      pendingResizeWidthsRef.current = nextWidths
      if (resizeFrameRef.current == null) {
        resizeFrameRef.current = window.requestAnimationFrame(() => {
          resizeFrameRef.current = null
          const activeResizeState = resizeStateRef.current
          const pendingWidths = pendingResizeWidthsRef.current
          if (!activeResizeState || !pendingWidths) return

          const latestPrefs = getLatestColumnPrefs()
          const nextPrefs = buildSavedColumnPrefs(latestPrefs.orderedColumns, latestPrefs.hiddenColumns, pendingWidths)
          columnPrefsRef.current = nextPrefs
          setColumnPrefs(nextPrefs)
        })
      }
    }

    const onMouseUp = () => {
      const resizeState = resizeStateRef.current
      if (!resizeState) return

      const prefs = getLatestColumnPrefs()
      const nextWidths = pendingResizeWidthsRef.current ?? prefs.widths
      if (resizeFrameRef.current != null) {
        window.cancelAnimationFrame(resizeFrameRef.current)
        resizeFrameRef.current = null
      }
      resizeStateRef.current = null
      pendingResizeWidthsRef.current = null
      setResizingColumnKey(null)
      document.body.classList.remove('resizing-active')

      void saveColumnPrefsToServer(buildSavedColumnPrefs(prefs.orderedColumns, prefs.hiddenColumns, nextWidths))
      window.setTimeout(() => {
        suppressHeaderClickRef.current = false
      }, 150)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      if (resizeFrameRef.current != null) {
        window.cancelAnimationFrame(resizeFrameRef.current)
        resizeFrameRef.current = null
      }
      document.body.classList.remove('resizing-active')
    }
  }, [])

  useEffect(() => {
    onQueueStateChange?.({
      count: queueEntries.filter((entry) => entry.status === 'queued').length,
      isOpen: queueOpen,
    })
  }, [queueEntries, queueOpen, onQueueStateChange])

  useEffect(() => {
    if (!queueOpen) return
    if (queueClientId == null) {
      setQueueLoading(false)
      return
    }

    let cancelled = false

    const hydrateQueue = async () => {
      setQueueLoading(true)
      try {
        const payload = await apiClient.fetchQueue(queueClientId, queueHistoryVisible)
        if (!cancelled) {
          setQueueEntries(payload.queuedOrders)
          setQueueEntriesClientId(queueClientId)
        }
      } catch (error) {
        if (!cancelled) {
          toastContext?.addToast(error instanceof Error ? error.message : 'Failed to load print queue', 'error')
        }
      } finally {
        if (!cancelled) setQueueLoading(false)
      }
    }

    void hydrateQueue()
    const interval = window.setInterval(() => {
      void hydrateQueue()
    }, 30000)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [queueOpen, queueClientId, queueHistoryVisible, toastContext])

  useEffect(() => {
    if (!queueOpen) return

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (detailDrawerFromQueue && detailDrawerOrderId != null) return
      const panel = document.getElementById('print-queue-panel')
      const trigger = document.getElementById('pq-toggle-btn')
      if (panel && panel.contains(target)) return
      if (trigger && trigger.contains(target)) return
      setQueueOpen(false)
    }

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setQueueOpen(false)
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKey)
    }
  }, [queueOpen, detailDrawerFromQueue, detailDrawerOrderId])

  useEffect(() => {
    if (!panelOrder) {
      panelFormInitKeyRef.current = null
      shipmentLastSavedKeyRef.current = null
      bestRateRefreshSeqRef.current += 1
      setPanelRateLoading(false)
      return
    }

    const initKey = `${panelOrder.orderId}:${panelDetail ? 'detail' : 'summary'}`
    const dimensions = getDimensions(panelOrder, panelDetail)
    const locationId = getPanelWarehouseId(panelOrder, panelDetail) ?? locations.find((location) => location.isDefault)?.locationId ?? locations[0]?.locationId ?? null
    const matchedPackageId = getMatchedPackageIdByDimensions(dimensions, packages)
    const selectedAccountValue = getInitialPanelShipAccountId(panelOrder, panelDetail)
    const currentWeight = getOrderWeightOz(panelOrder, panelDetail)
    const insurance = getPanelInsurance(panelOrder, panelDetail)
    const panelIsTestOrder = isTestOrder(panelOrder, panelDetail)

    if (panelFormInitKeyRef.current === initKey) {
      setPanelForm((current) => {
        if (current.packageId) return current
        const currentDims = {
          length: Number.parseFloat(current.length) || 0,
          width: Number.parseFloat(current.width) || 0,
          height: Number.parseFloat(current.height) || 0,
        }
        const nextPackageId = getPanelPackageId(panelOrder, panelDetail, packages)
          || getMatchedPackageIdByDimensions(hasCompleteDims(currentDims) ? currentDims : dimensions, packages)
        if (!nextPackageId) return current
        const next = { ...current, packageId: nextPackageId }
        shipmentLastSavedKeyRef.current = getShipmentDetailsKey(panelOrder.orderId, next)
        return next
      })
      return
    }

    panelFormInitKeyRef.current = initKey
    bestRateRefreshSeqRef.current += 1
    const initialPanelForm: PanelFormState = {
      locationId: locationId != null ? String(locationId) : '',
      shipAccountId: panelIsTestOrder ? TEST_CARRIER_CODE : selectedAccountValue != null ? String(selectedAccountValue) : '',
      serviceCode: panelIsTestOrder ? TEST_SERVICE_CODE : getInitialPanelServiceCode(panelOrder, panelDetail),
      weightLb: currentWeight ? String(Math.floor(currentWeight / 16)) : '',
      weightOz: currentWeight ? String(Math.round(currentWeight % 16)) : '',
      length: dimensions?.length ? String(dimensions.length) : '',
      width: dimensions?.width ? String(dimensions.width) : '',
      height: dimensions?.height ? String(dimensions.height) : '',
      packageId: getPanelPackageId(panelOrder, panelDetail, packages) || matchedPackageId,
      confirmation: getPanelConfirmation(panelOrder, panelDetail),
      insurance: insurance.type,
      insuranceValue: insurance.value != null ? String(insurance.value) : '',
    }
    shipmentLastSavedKeyRef.current = getShipmentDetailsKey(panelOrder.orderId, initialPanelForm)
    setPanelForm(initialPanelForm)
    setPanelRatePreview([])

    const activeItems = getActiveItems(panelOrder, panelDetail).filter((item) => item.sku)
    const uniqueSkus = [...new Set(activeItems.map((item) => item.sku).filter(Boolean))]
    if (uniqueSkus.length !== 1) {
      return
    }

    void apiClient.fetchProductsBySku(uniqueSkus[0]!)
      .then((payload) => {
        if (!payload) return
        setPanelForm((current) => {
          const nextWeightLb = current.weightLb || current.weightOz
            ? current.weightLb
            : payload.weightOz > 0
              ? String(Math.floor(payload.weightOz / 16))
              : ''
          const nextWeightOz = current.weightLb || current.weightOz
            ? current.weightOz
            : payload.weightOz > 0
              ? String(Math.round(payload.weightOz % 16))
              : ''
          const nextLength = current.length || payload.length <= 0 ? current.length : String(payload.length)
          const nextWidth = current.width || payload.width <= 0 ? current.width : String(payload.width)
          const nextHeight = current.height || payload.height <= 0 ? current.height : String(payload.height)
          const nextPackageId = current.packageId
            || getProductDefaultPackageId(payload, packages)
            || getMatchedPackageIdByDimensions(
              nextLength && nextWidth && nextHeight
                ? {
                    length: Number.parseFloat(nextLength) || 0,
                    width: Number.parseFloat(nextWidth) || 0,
                    height: Number.parseFloat(nextHeight) || 0,
                  }
                : null,
              packages,
            )

          return {
            ...current,
            weightLb: nextWeightLb,
            weightOz: nextWeightOz,
            length: nextLength,
            width: nextWidth,
            height: nextHeight,
            packageId: nextPackageId,
          }
        })
      })
      .catch(() => {})
  }, [panelOrderId, panelOrder, panelDetail, locations, packages])

  useEffect(() => {
    if (!panelOrder || panelOrder.orderStatus !== 'awaiting_shipment' || !packagesLoaded) return

    const dims = getPanelDims()
    if (!hasCompleteDims(dims)) return

    const key = `${panelOrder.orderId}:${getDimsKey(dims)}`
    if (autoPackageDimsKeyRef.current === key) return

    const timeout = window.setTimeout(() => {
      if (autoPackageDimsKeyRef.current === key) return
      autoPackageDimsKeyRef.current = key
      void ensurePanelPackageForDims({ saveSku: true, silent: true })
        .catch(() => {
          autoPackageDimsKeyRef.current = null
        })
    }, 450)

    return () => window.clearTimeout(timeout)
  }, [panelOrderId, panelOrder?.orderStatus, panelForm.length, panelForm.width, panelForm.height, packages, packagesLoaded])

  // Reset the "user has edited dims" flag whenever the active order changes.
  // Without this, switching from order A (where the user typed) to order B
  // would leave the flag set and immediately auto-refresh B's rate just by
  // clicking — defeating the whole guard.
  useEffect(() => {
    dimsUserEditedRef.current = false
  }, [panelOrderId])

  // Auto-refresh the panel's best rate whenever weight or any dimension
  // changes. Debounced so a user typing "1 → 12 → 125" doesn't fire three
  // separate /rates calls. refreshPanelBestRate already toggles
  // panelRateLoading and uses bestRateRefreshSeqRef to ignore stale results
  // when the inputs change again before a fetch completes.
  //
  // Only fire when the user has *manually* edited weight or dims. Clicking an
  // order seeds the form values in a separate render cycle, which would also
  // trip this effect — we ignore those programmatic fills via the user-edit
  // flag set in the input onChange handlers.
  useEffect(() => {
    if (!panelOrder || panelOrder.orderStatus !== 'awaiting_shipment') return
    if (!dimsUserEditedRef.current) return
    const dims = getPanelDims()
    const weightOz = getPanelWeightOz()
    if (!hasCompleteDims(dims) || weightOz <= 0) return

    const handle = window.setTimeout(() => {
      void refreshPanelBestRate({ order: panelOrder, dims, weightOz, silent: true })
    }, 700)

    return () => window.clearTimeout(handle)
    // panelOrder identity intentionally re-checked via id; eslint disable for
    // the inline calls (refreshPanelBestRate / getPanelDims / getPanelWeightOz
    // are stable closures that read latest state).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    panelOrderId,
    panelOrder?.orderStatus,
    panelForm.weightLb,
    panelForm.weightOz,
    panelForm.length,
    panelForm.width,
    panelForm.height,
  ])

  useEffect(() => {
    if (!panelOrder || panelOrder.orderStatus !== 'awaiting_shipment') return

    const currentKey = getShipmentDetailsKey(panelOrder.orderId, panelForm)
    if (!currentKey || currentKey === shipmentLastSavedKeyRef.current) return

    const dims = getPanelDims()
    const weightOz = getPanelWeightOz()
    const hasWeightToSave = (panelForm.weightLb.trim() !== '' || panelForm.weightOz.trim() !== '') && weightOz > 0
    const hasSomethingToSave = hasWeightToSave || hasCompleteDims(dims) || Boolean(panelForm.packageId)
    if (!hasSomethingToSave) return

    if (shipmentAutoSaveTimerRef.current != null) {
      window.clearTimeout(shipmentAutoSaveTimerRef.current)
    }

    shipmentAutoSaveTimerRef.current = window.setTimeout(() => {
      shipmentAutoSaveTimerRef.current = null
      void persistShipmentDetails({
        silent: true,
        refreshBestRate: true,
        skipIfUnchanged: true,
      })
    }, 750)

    return () => {
      if (shipmentAutoSaveTimerRef.current != null) {
        window.clearTimeout(shipmentAutoSaveTimerRef.current)
        shipmentAutoSaveTimerRef.current = null
      }
    }
  }, [
    panelOrderId,
    panelOrder?.orderStatus,
    panelForm.weightLb,
    panelForm.weightOz,
    panelForm.length,
    panelForm.width,
    panelForm.height,
    panelForm.packageId,
    panelDetail,
    packages,
  ])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return

      if (event.key === 'Escape') {
        if (rateBrowserOpen) {
          setRateBrowserOpen(false)
          return
        }
        clearSelection()
        return
      }

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const currentIndex = kbRowId != null ? orderedFilteredOrders.findIndex((order) => order.orderId === kbRowId) : -1
        const nextIndex = Math.max(0, Math.min(orderedFilteredOrders.length - 1, currentIndex + (event.key === 'ArrowDown' ? 1 : -1)))
        const nextOrder = orderedFilteredOrders[nextIndex]
        if (!nextOrder) return
        setKbRowId(nextOrder.orderId)
        document.getElementById(`row-${nextOrder.orderId}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        return
      }

      if (event.key === 'Enter' && kbRowId != null) {
        updateSelection([kbRowId])
        return
      }

      if (event.key.toLowerCase() === 'c' && (event.ctrlKey || event.metaKey) && !event.shiftKey && kbRowId != null) {
        const order = orderedFilteredOrders.find((candidate) => candidate.orderId === kbRowId)
        if (order?.orderNumber) {
          copyText(order.orderNumber)
          showToast(`📋 Copied: ${order.orderNumber}`)
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [rateBrowserOpen, kbRowId, orderedFilteredOrders])


  const updateSelection = (ids: number[]) => {
    const nextIds = [...new Set(ids)]
    onSelectedOrderIdsChange?.(nextIds)
    onActiveOrderIdChange?.(nextIds.length === 1 ? nextIds[0] : null)
  }

  const openOrderDetails = (orderId: number) => {
    onActiveOrderIdChange?.(orderId)
  }

  const openDetailDrawer = (orderId: number | null, fromQueue = false) => {
    setDetailDrawerFromQueue(fromQueue)
    setDetailDrawerOrderId(orderId)
  }

  const closeDetailDrawer = () => {
    if (detailDrawerFromQueue) setQueueOpen(true)
    setDetailDrawerOrderId(null)
    setDetailDrawerFromQueue(false)
  }

  const toggleOrderSelection = (orderId: number, checked?: boolean) => {
    const isChecked = selectedIdSet.has(orderId)
    const shouldSelect = checked ?? !isChecked
    if (shouldSelect) {
      updateSelection([...selectedOrderIds, orderId])
      return
    }

    updateSelection(selectedOrderIds.filter((id) => id !== orderId))
  }

  const selectOrderRange = (anchorOrderId: number, targetOrderId: number) => {
    const anchorIndex = visibleOrderIds.indexOf(anchorOrderId)
    const targetIndex = visibleOrderIds.indexOf(targetOrderId)
    if (anchorIndex < 0 || targetIndex < 0) {
      toggleOrderSelection(targetOrderId, true)
      return
    }
    const start = Math.min(anchorIndex, targetIndex)
    const end = Math.max(anchorIndex, targetIndex)
    const rangeIds = visibleOrderIds.slice(start, end + 1)
    updateSelection([...selectedOrderIds, ...rangeIds])
  }

  const toggleSkuGroupSelection = (orderIds: number[], checked?: boolean) => {
    const orderIdSet = new Set(orderIds)
    const allSelected = orderIds.length > 0 && orderIds.every((orderId) => selectedIdSet.has(orderId))
    const shouldSelect = checked ?? !allSelected
    if (shouldSelect) {
      updateSelection([...selectedOrderIds, ...orderIds])
      return
    }

    updateSelection(selectedOrderIds.filter((id) => !orderIdSet.has(id)))
  }

  const toggleVisibleSelection = (checked?: boolean) => {
    const visibleOrderIdSet = new Set(visibleOrderIds)
    const shouldSelect = checked ?? !allVisibleSelected
    if (shouldSelect) {
      updateSelection([...selectedOrderIds, ...visibleOrderIds])
      return
    }

    updateSelection(selectedOrderIds.filter((id) => !visibleOrderIdSet.has(id)))
  }

  const clearSelection = () => {
    onSelectedOrderIdsChange?.([])
    onActiveOrderIdChange?.(null)
  }

  const closeSinglePanel = () => {
    const activeIsOnlySelection =
      activeOrderId != null &&
      selectedOrderIds.length === 1 &&
      selectedOrderIds[0] === activeOrderId

    if (activeOrderId != null && !activeIsOnlySelection) {
      onActiveOrderIdChange?.(null)
      return
    }

    clearSelection()
  }

  function showToast(message: string, type: 'success' | 'error' | 'info' = 'info') {
    toastContext?.addToast(message, type)
  }

  function getPanelWeightOzFromForm(form: PanelFormState) {
    const lb = Number.parseFloat(form.weightLb) || 0
    const oz = Number.parseFloat(form.weightOz) || 0
    return (lb * 16) + oz
  }

  function getPanelDimsFromForm(form: PanelFormState) {
    const length = Number.parseFloat(form.length) || 0
    const width = Number.parseFloat(form.width) || 0
    const height = Number.parseFloat(form.height) || 0
    return { length, width, height }
  }

  function getPanelWeightOz() {
    return getPanelWeightOzFromForm(panelForm)
  }

  function getPanelDims() {
    return getPanelDimsFromForm(panelForm)
  }

  function getShipmentDetailsKey(orderId: number | null | undefined, form: PanelFormState) {
    if (orderId == null) return ''
    const dims = getPanelDimsFromForm(form)
    return [
      orderId,
      getPanelWeightOzFromForm(form).toFixed(3),
      dims.length.toFixed(3),
      dims.width.toFixed(3),
      dims.height.toFixed(3),
      form.packageId || '',
    ].join(':')
  }

  function hasCompleteDims(dims: ShipmentDims | null | undefined): dims is ShipmentDims {
    if (!dims) return false
    return dims.length > 0 && dims.width > 0 && dims.height > 0
  }

  function getDimsKey(dims: ShipmentDims) {
    return [dims.length, dims.width, dims.height]
      .map((value) => Number(value).toFixed(3))
      .join('x')
  }

  function getPackageIdentifier(pkg: PackageDto | null | undefined) {
    const raw = pkg?.packageId ?? (pkg as any)?.id
    const numeric = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10)
    return Number.isFinite(numeric) ? String(numeric) : ''
  }

  function getPackageDims(pkg: PackageDto | null | undefined) {
    if (!pkg) return null
    const dims = {
      length: Number.parseFloat(String(pkg.length ?? '')) || 0,
      width: Number.parseFloat(String(pkg.width ?? '')) || 0,
      height: Number.parseFloat(String(pkg.height ?? '')) || 0,
    }
    return hasCompleteDims(dims) ? dims : null
  }

  function getPanelSkuDefaultDims(packageId: string | null) {
    const panelDims = getPanelDims()
    if (hasCompleteDims(panelDims)) return panelDims

    const selectedPackageId = packageId || panelForm.packageId
    const selectedPackage = selectedPackageId
      ? packages.find((candidate) => getPackageIdentifier(candidate) === selectedPackageId)
      : null
    return getPackageDims(selectedPackage) ?? panelDims
  }

  function assertSavedProductDefaults(
    product: unknown,
    expected: {
      sku: string
      weightOz: number
      length: number
      width: number
      height: number
      defaultPackageCode: string | null
    },
  ) {
    const row = toRecord(product)
    if (!row || toStringValue(row.sku) !== expected.sku) {
      throw new Error('SKU defaults were not saved')
    }

    const readNumber = (value: unknown) => {
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (typeof value === 'string' && value.trim()) {
        const parsed = Number.parseFloat(value)
        return Number.isFinite(parsed) ? parsed : null
      }
      return null
    }
    const matches = (field: 'weightOz' | 'length' | 'width' | 'height', expectedValue: number) => {
      if (expectedValue <= 0) return true
      const savedValue = readNumber(row[field])
      return savedValue != null && Math.abs(savedValue - expectedValue) <= 0.01
    }

    if (
      !matches('weightOz', expected.weightOz)
      || !matches('length', expected.length)
      || !matches('width', expected.width)
      || !matches('height', expected.height)
    ) {
      throw new Error('SKU defaults did not match the saved weight and dimensions')
    }

    if (expected.defaultPackageCode) {
      const savedPackageCode = row.defaultPackageCode == null ? null : String(row.defaultPackageCode)
      if (savedPackageCode !== expected.defaultPackageCode) {
        throw new Error('SKU default package was not saved')
      }
    }
  }

  function normalizePanelPackage(pkg: PackageDto | null | undefined) {
    if (!pkg) return null
    const packageId = getPackageIdentifier(pkg)
    return packageId ? { ...pkg, packageId: Number.parseInt(packageId, 10) } : pkg
  }

  function mergePackageIntoState(pkg: PackageDto | null | undefined) {
    const normalized = normalizePanelPackage(pkg)
    const packageId = getPackageIdentifier(normalized)
    if (!normalized || !packageId) return

    setPackages((current) => {
      const index = current.findIndex((candidate) => getPackageIdentifier(candidate) === packageId)
      if (index >= 0) {
        const next = [...current]
        next[index] = { ...current[index], ...normalized }
        return next
      }
      return [...current, normalized]
    })
  }

  function getSingleSkuDefaultTarget(order: OrderSummaryDto, detail: OrderFullDto | null) {
    const items = getActiveItems(order, detail).filter((item) => item.sku)
    const uniqueSkus = [...new Set(items.map((item) => item.sku).filter(Boolean))]
    if (uniqueSkus.length !== 1) return null

    const sku = uniqueSkus[0]!
    const matchingItems = items.filter((item) => item.sku === sku)
    return {
      sku,
      name: matchingItems[0]?.name ?? null,
      qty: matchingItems.reduce((sum, item) => sum + item.quantity, 0) || 1,
    }
  }

  async function savePanelSkuDefaults(
    packageId: string | null,
    options: {
      silent?: boolean
      order?: OrderSummaryDto | null
      detail?: OrderFullDto | null
      weightOz?: number
      dims?: ShipmentDims | null
    } = {},
  ) {
    const sourceOrder = options.order ?? panelOrder
    if (!sourceOrder) return null

    const sourceDetail = options.detail ?? (
      sourceOrder.orderId === panelOrder?.orderId
        ? panelDetail
        : orderDetailsById.get(sourceOrder.orderId) ?? null
    )
    const target = getSingleSkuDefaultTarget(sourceOrder, sourceDetail)
    if (!target) {
      // Multi-SKU fallback: weight/dims can't be allocated across lines, but
      // the chosen package IS the right default for every SKU on the order.
      // Stamp inventory.package_id for each line so future orders containing
      // any of these SKUs default to the same box. Silent on failure — this
      // runs from the auto-detect debouncer and shouldn't block the user.
      if (packageId) {
        try {
          const items = getActiveItems(sourceOrder, sourceDetail)
          const skus = Array.from(
            new Set(
              items
                .map((item) => (typeof item.sku === 'string' ? item.sku.trim() : ''))
                .filter((sku) => sku.length > 0)
            )
          )
          const pid = Number.parseInt(packageId, 10)
          const fallbackClientId = typeof sourceOrder.clientId === 'number' && sourceOrder.clientId > 0
            ? sourceOrder.clientId
            : null
          if (skus.length > 0 && Number.isFinite(pid) && pid > 0) {
            await apiClient.bulkSetInventoryPackageDefault({
              clientId: fallbackClientId,
              packageId: pid,
              skus,
            })
          }
        } catch (err) {
          console.warn('[orders] multi-SKU package default save failed:', err)
        }
      }
      if (!options.silent) showToast("Multi-SKU order - edit each product's defaults in the Products tab", 'error')
      return null
    }

    const weightOz = options.weightOz ?? getPanelWeightOz()
    const dims = hasCompleteDims(options.dims) ? options.dims! : getPanelSkuDefaultDims(packageId)
    if (!weightOz && !hasCompleteDims(dims)) {
      if (!options.silent) showToast('Enter weight or complete dims first', 'error')
      return null
    }

    const clientId = typeof sourceOrder.clientId === 'number' && sourceOrder.clientId > 0
      ? sourceOrder.clientId
      : null
    const skuWeightOz = target.qty > 1 && weightOz ? Number((weightOz / target.qty).toFixed(2)) : weightOz
    const packageCode = packageId || null
    const payload: Record<string, unknown> = {
      sku: target.sku,
      name: target.name,
      clientId,
      defaultPackageCode: packageCode,
    }
    if (skuWeightOz > 0) payload.weightOz = skuWeightOz
    if (hasCompleteDims(dims)) {
      payload.length = dims.length
      payload.width = dims.width
      payload.height = dims.height
    }
    const saved = await apiClient.saveProductDefaultsV2(payload)
    const savedRow = toRecord(saved)
    if (!savedRow || toStringValue(savedRow.sku) !== target.sku) {
      throw new Error('SKU defaults were not saved')
    }
    const confirmed = await apiClient.fetchProductsBySku(target.sku)
    assertSavedProductDefaults(confirmed, {
      sku: target.sku,
      weightOz: skuWeightOz,
      length: hasCompleteDims(dims) ? dims.length : 0,
      width: hasCompleteDims(dims) ? dims.width : 0,
      height: hasCompleteDims(dims) ? dims.height : 0,
      defaultPackageCode: packageCode,
    })

    return target.sku
  }

  async function autoSavePanelSkuDefaults(
    packageId: string | null,
    options: Parameters<typeof savePanelSkuDefaults>[1] = {},
  ) {
    try {
      return await savePanelSkuDefaults(packageId, { ...options, silent: true })
    } catch (error) {
      console.warn('[orders] automatic SKU defaults save failed:', error)
      return null
    }
  }

  async function ensurePanelPackageForDims(options: { saveSku?: boolean; silent?: boolean } = {}) {
    if (!panelOrder || panelOrder.orderStatus !== 'awaiting_shipment') return panelForm.packageId

    const dims = getPanelDims()
    if (!hasCompleteDims(dims)) return panelForm.packageId

    let packageId = getMatchedPackageIdByDimensions(dims, packages)

    if (!packageId) {
      const response = await apiClient.autoCreatePackageByDimensions({
        length: dims.length,
        width: dims.width,
        height: dims.height,
      })
      const pkg = response?.data ?? response?.package ?? response
      packageId = getPackageIdentifier(pkg)

      if (!packageId) {
        if (!options.silent) showToast('Could not create package for those dimensions', 'error')
        return panelForm.packageId
      }

      mergePackageIntoState(pkg)
    }

    setPanelForm((current) => (
      current.packageId === packageId ? current : { ...current, packageId }
    ))

    await apiClient.setOrderSelectedPackageId(panelOrder.orderId, Number.parseInt(packageId, 10))

    if (options.saveSku) {
      await savePanelSkuDefaults(packageId, { silent: true })
    }

    return packageId
  }

  function getServiceOptionsForAccount(accountId: string) {
    const account = shippingAccounts.find((candidate) => String(candidate.shippingProviderId) === accountId)
    if (!account) return []
    return CARRIER_SERVICES[account.code] ?? []
  }

  async function saveColumnPrefsToServer(nextPrefs: ColumnPrefs) {
    columnPrefsRef.current = nextPrefs
    setColumnPrefs(nextPrefs)
    writeLocalColumnPrefs(nextPrefs)
    try {
      await apiClient.saveColumnPrefs(nextPrefs)
    } catch {
      showToast('Failed to save column preferences', 'error')
    }
  }

  function getLatestColumnPrefs() {
    return resolvedColumnPrefsRef.current ?? resolvedColumnPrefs
  }

  function getPersistableHiddenColumns(hiddenColumns: Set<TableColumnKey>) {
    const nextHidden = new Set(hiddenColumns)
    if (currentStatusRef.current !== 'awaiting_shipment') nextHidden.delete('age')
    return nextHidden
  }

  function buildSavedColumnPrefs(
    columns: Array<{ key: TableColumnKey; label: string; width: number }>,
    hiddenColumns: Set<TableColumnKey>,
    widths: Record<TableColumnKey, number>,
  ) {
    return buildColumnPrefsForStatus(
      columnPrefsRef.current,
      currentStatusRef.current,
      columns,
      getPersistableHiddenColumns(hiddenColumns),
      widths,
    )
  }

  function buildMovedColumnPrefs(sourceKey: TableColumnKey, targetKey: TableColumnKey) {
    if (!sourceKey || !targetKey || sourceKey === targetKey || sourceKey === 'select' || targetKey === 'select') return null

    const prefs = getLatestColumnPrefs()
    const nextOrdered = [...prefs.orderedColumns]
    const sourceIndex = nextOrdered.findIndex((column) => column.key === sourceKey)
    const targetIndex = nextOrdered.findIndex((column) => column.key === targetKey)
    if (sourceIndex < 0 || targetIndex < 0) return null

    const [column] = nextOrdered.splice(sourceIndex, 1)
    nextOrdered.splice(targetIndex, 0, column)
    return buildSavedColumnPrefs(nextOrdered, prefs.hiddenColumns, prefs.widths)
  }

  function moveColumn(sourceKey: TableColumnKey, targetKey: TableColumnKey) {
    const nextPrefs = buildMovedColumnPrefs(sourceKey, targetKey)
    if (!nextPrefs) return
    void saveColumnPrefsToServer(nextPrefs)
  }

  function finishHeaderDrag() {
    setDragColumnKey(null)
    setDragOverColumnKey(null)
    suppressHeaderClickRef.current = true
    window.setTimeout(() => {
      suppressHeaderClickRef.current = false
    }, 150)
  }

  function handleHeaderDragStart(event: React.DragEvent<HTMLTableCellElement>, key: TableColumnKey) {
    if (resizeStateRef.current || key === 'select') {
      event.preventDefault()
      return
    }

    suppressHeaderClickRef.current = true
    setDragColumnKey(key)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', key)
  }

  function handleHeaderDragOver(event: React.DragEvent<HTMLTableCellElement>, key: TableColumnKey) {
    if (!dragColumnKey || key === dragColumnKey || key === 'select') return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDragOverColumnKey(key)
  }

  function handleHeaderDrop(event: React.DragEvent<HTMLTableCellElement>, key: TableColumnKey) {
    const sourceKey = (event.dataTransfer.getData('text/plain') || dragColumnKey) as TableColumnKey
    if (!sourceKey || sourceKey === key || key === 'select') return

    event.preventDefault()
    moveColumn(sourceKey, key)
    finishHeaderDrag()
  }

  function handleHeaderClick(column: TableColumn) {
    if (suppressHeaderClickRef.current) {
      suppressHeaderClickRef.current = false
      return
    }
    if (column.sort == null) return
    toggleSort(column.sort as SortKey)
  }

  function resizeColumnByKeyboard(column: TableColumn, delta: number) {
    if (column.key === 'select') return

    const prefs = getLatestColumnPrefs()
    const currentWidth = prefs.widths[column.key] ?? column.width
    const nextWidths = {
      ...prefs.widths,
      [column.key]: Math.max(getColumnMinWidth(column.key), currentWidth + delta),
    }
    void saveColumnPrefsToServer(buildSavedColumnPrefs(prefs.orderedColumns, prefs.hiddenColumns, nextWidths))
  }

  function handleHeaderKeyDown(event: React.KeyboardEvent<HTMLTableCellElement>, column: TableColumn) {
    if (column.key === 'select') return

    if (event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault()
      resizeColumnByKeyboard(column, event.key === 'ArrowRight' ? 10 : -10)
      return
    }

    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault()
      const currentIndex = visibleColumns.findIndex((candidate) => candidate.key === column.key)
      const targetIndex = event.key === 'ArrowRight' ? currentIndex + 1 : currentIndex - 1
      const targetColumn = visibleColumns[targetIndex]
      if (targetColumn && targetColumn.key !== 'select') moveColumn(column.key, targetColumn.key)
      return
    }

    if ((event.key === 'Enter' || event.key === ' ') && column.sort != null) {
      event.preventDefault()
      handleHeaderClick(column)
    }
  }

  function handleDropdownDragStart(event: React.DragEvent<HTMLDivElement>, key: TableColumnKey) {
    setDropdownDragColumnKey(key)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', key)
  }

  function handleDropdownDragOver(event: React.DragEvent<HTMLDivElement>, key: TableColumnKey) {
    if (!dropdownDragColumnKey || key === dropdownDragColumnKey) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDropdownDragOverColumnKey(key)
  }

  function handleDropdownDrop(event: React.DragEvent<HTMLDivElement>, key: TableColumnKey) {
    const sourceKey = (event.dataTransfer.getData('text/plain') || dropdownDragColumnKey) as TableColumnKey
    if (!sourceKey || sourceKey === key) return

    event.preventDefault()
    moveColumn(sourceKey, key)
    setDropdownDragColumnKey(null)
    setDropdownDragOverColumnKey(null)
  }

  function finishDropdownDrag() {
    setDropdownDragColumnKey(null)
    setDropdownDragOverColumnKey(null)
  }

  function startColumnResize(event: React.MouseEvent<HTMLDivElement>, column: TableColumn) {
    event.preventDefault()
    event.stopPropagation()

    const prefs = getLatestColumnPrefs()
    resizeStateRef.current = {
      key: column.key,
      startX: event.clientX,
      startWidth: prefs.widths[column.key] ?? column.width,
    }
    pendingResizeWidthsRef.current = null
    suppressHeaderClickRef.current = true
    setResizingColumnKey(column.key)
    document.body.classList.add('resizing-active')
  }

  async function hydrateQueue(forceOpen = false) {
    if (queueClientId == null) {
      if (forceOpen) showToast('No client selected for print queue', 'error')
      return
    }

    setQueueLoading(true)
    try {
      const payload = await apiClient.fetchQueue(queueClientId, queueHistoryVisible)
      setQueueEntries(payload.queuedOrders)
      setQueueEntriesClientId(queueClientId)
      if (forceOpen) setQueueOpen(true)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to load print queue', 'error')
    } finally {
      setQueueLoading(false)
    }
  }

  function buildQueueSendOrderPayload(order: OrderSummaryDto, options: { existingLabelOnly?: boolean; batchTestMode?: boolean } = {}) {
    if (order.clientId == null) {
      return { payload: null, items: [], error: 'Missing client id', order }
    }

    const labelUrl = toStringValue(order.label?.labelUrl)
    const queuePayload = buildQueueAddPayload(order, labelUrl ?? '')
    const multiSkuData = Array.isArray(queuePayload.multi_sku_data)
      ? queuePayload.multi_sku_data
          .map((item) => ({
            sku: toStringValue(item?.sku) ?? '',
            qty: toNumberValue(item?.qty) ?? 1,
          }))
          .filter((item) => item.sku)
      : null
    const payload: Record<string, unknown> = {
      order_id: order.orderId,
      client_id: order.clientId,
      order_number: queuePayload.order_number,
      sku_group_id: queuePayload.sku_group_id,
      primary_sku: queuePayload.primary_sku,
      item_description: queuePayload.item_description,
      order_qty: queuePayload.order_qty,
      multi_sku_data: multiSkuData,
    }

    if (labelUrl) {
      payload.label_url = labelUrl
    } else {
      if (options.existingLabelOnly) {
        return { payload: null, items: [], error: 'No existing label URL', order }
      }

      const bestRate = order.bestRate
      const selectedRate = order.selectedRate
      const shippingProviderId = toNumberValue(bestRate?.shippingProviderId) ?? selectedRate?.shippingProviderId ?? order.label?.shippingProviderId ?? null
      const serviceCode = getShippingString(order, 'serviceCode') ?? toStringValue(bestRate?.serviceCode) ?? selectedRate?.serviceCode
      const carrierCode = getShippingString(order, 'carrierCode') ?? toStringValue(bestRate?.carrierCode) ?? selectedRate?.carrierCode
      const dims = getDimensions(order, null)
      const weightOz = order.weight?.value ?? 0
      const orderIsTest = isTestOrder(order, orderDetailsById.get(order.orderId) ?? null)
      const effectiveServiceCode = serviceCode ?? (orderIsTest ? TEST_SERVICE_CODE : undefined)
      const effectiveCarrierCode = carrierCode ?? (orderIsTest ? TEST_CARRIER_CODE : undefined)

      payload.label = {
        serviceCode: effectiveServiceCode,
        carrierCode: effectiveCarrierCode,
        packageCode: 'package',
        shippingProviderId: shippingProviderId ?? undefined,
        weightOz: weightOz > 0 ? weightOz : undefined,
        length: dims?.length,
        width: dims?.width,
        height: dims?.height,
        confirmation: 'delivery',
        testLabel: Boolean(options.batchTestMode) || orderIsTest,
      }
    }

    return {
      payload,
      items: getActiveItems(order, orderDetailsById.get(order.orderId) ?? null),
      error: null,
      order,
    }
  }

  async function pollBackendQueueSendJob(
    backendJobId: string,
    progressTotal: number,
    offsets: { completed?: number; failed?: number } = {},
  ) {
    let status: any = null
    while (true) {
      status = await apiClient.fetchQueueSendJobStatus(backendJobId)
      const current = toNumberValue(status.current) ?? 0
      const failed = toNumberValue(status.failed) ?? 0
      const completedOffset = offsets.completed ?? 0
      const failedOffset = offsets.failed ?? 0
      setQueueActionProgress((active) => active
        ? {
            ...active,
            label: status.status === 'done' ? 'Refreshing queue' : 'Sending to queue',
            total: progressTotal,
            completed: Math.min(progressTotal, completedOffset + current),
            failed: failedOffset + failed,
          }
        : active
      )

      if (status.status === 'done') return status
      if (status.status === 'error') {
        throw new Error(status.error || status.message || 'Queue send failed')
      }
      await yieldToBrowser(BACKEND_QUEUE_SEND_POLL_MS)
    }
  }

  async function refreshQueueAfterBackendStatus(status: any, fallbackClientId: number | null) {
    const queued = toNumberValue(status?.queued) ?? 0
    const clientId = toNumberValue(status?.client_id) ?? fallbackClientId
    if (queued <= 0 || clientId == null) return

    setQueueActionProgressLabel('Refreshing queue')
    setQueueLoading(true)
    try {
      const payload = await apiClient.fetchQueue(clientId, queueHistoryVisible)
      setQueueEntries(payload.queuedOrders)
      setQueueEntriesClientId(clientId)
      setQueueOpen(true)
    } finally {
      setQueueLoading(false)
    }
  }

  async function sendOrdersToQueueBackend(
    jobOrders: OrderSummaryDto[],
    options: {
      kind: PersistentQueueJobKind
      label?: string
      batchTestMode?: boolean
      existingLabelOnly?: boolean
    },
  ) {
    const queueJobId = beginPersistentQueueJob(options.kind, jobOrders, {
      label: options.label ?? 'Sending to queue',
      batchTestMode: options.batchTestMode,
    })
    const prepared = jobOrders.map((order) => buildQueueSendOrderPayload(order, options))
    const skipped = prepared.filter((entry) => !entry.payload)
    const queueOrders = prepared.filter((entry) => entry.payload).map((entry) => entry.payload as Record<string, unknown>)
    const skippedFailed = skipped.length
    const fallbackClientId = toNumberValue(queueOrders[0]?.client_id) ?? null
    let finalStatus: any = null

    for (const entry of skipped) {
      markPersistentQueueJobOrder(queueJobId, entry.order.orderId, true)
    }
    if (skippedFailed > 0) {
      setQueueActionProgress((active) => active
        ? {
            ...active,
            completed: Math.min(active.total, skippedFailed),
            failed: active.failed + skippedFailed,
          }
        : active
      )
    }

    try {
      if (queueOrders.length > 0) {
        const started = await apiClient.startQueueSendJob({
          orders: queueOrders,
          concurrency: options.batchTestMode ? BACKEND_TEST_QUEUE_SEND_CONCURRENCY : BACKEND_QUEUE_SEND_CONCURRENCY,
        })
        attachPersistentQueueBackendJob(queueJobId, started.job_id)
        finalStatus = await pollBackendQueueSendJob(started.job_id, Math.max(jobOrders.length, 1), {
          completed: skippedFailed,
          failed: skippedFailed,
        })
        await refreshQueueAfterBackendStatus(finalStatus, fallbackClientId)
      }

      await refetchOrders()
    } finally {
      setQueueLoading(false)
      finishPersistentQueueJob(queueJobId)
      const queued = toNumberValue(finalStatus?.queued) ?? 0
      finishQueueActionProgress(queued > 0 ? 'Queue updated' : 'Queue checked')
    }

    const successOrderIds = new Set(
      ((finalStatus?.results ?? []) as Array<Record<string, unknown>>)
        .filter((result) => result.success === true)
        .map((result) => toNumberValue(result.orderId ?? result.order_id))
        .filter((orderId): orderId is number => orderId != null),
    )
    const queuedItems = prepared
      .filter((entry) => successOrderIds.has(entry.order.orderId))
      .flatMap((entry) => entry.items)

    return {
      queued: toNumberValue(finalStatus?.queued) ?? 0,
      failed: skippedFailed + (toNumberValue(finalStatus?.failed) ?? 0),
      queuedItems,
    }
  }

  async function queueExistingLabels(orderIds: number[]) {
    if (orderIds.length === 0) {
      await hydrateQueue(true)
      return
    }

    // O(1) lookups instead of N×O(N) `orders.find` inside the loop.
    const orderById = new Map(orders.map((order) => [order.orderId, order]))
    const jobOrders = orderIds
      .map((orderId) => orderById.get(orderId))
      .filter(Boolean) as OrderSummaryDto[]

    try {
      const result = await sendOrdersToQueueBackend(jobOrders, {
        kind: 'existing-labels',
        label: 'Sending to queue',
        existingLabelOnly: true,
      })
      if (result.queued > 0) {
        showToast(formatQueuedOrdersToast(result.queued, result.queuedItems, result.failed), 'success')
      } else {
        showToast('No orders added - create labels first')
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to send to queue', 'error')
    }
  }

  async function handleTopbarLabels() {
    if (selectedOrderIds.length === 0) {
      await hydrateQueue(true)
      return
    }
    await queueExistingLabels(selectedOrderIds)
  }

  async function createOrQueueLabel(mode: 'print' | 'queue' | 'test', order = panelOrder) {
    if (!order) {
      showToast('No order selected', 'error')
      return null
    }

    const orderDetail = orderDetailsById.get(order.orderId) ?? panelDetail
    const isTest = isTestOrder(order, orderDetail)
    const shippingProviderId = Number.parseInt(panelForm.shipAccountId, 10)
    const weightOz = getPanelWeightOz() || getOrderWeightOz(order, orderDetail)
    const panelDims = getPanelDims()
    const savedDims = getDimensions(order, orderDetail)
    const length = panelDims.length || savedDims?.length || 0
    const width = panelDims.width || savedDims?.width || 0
    const height = panelDims.height || savedDims?.height || 0
    const labelDims = { length, width, height }
    const account = shippingAccounts.find((candidate) => candidate.shippingProviderId === shippingProviderId)
    if (!isTest && (!shippingProviderId || !account)) {
      showToast('Select a carrier account', 'error')
      return null
    }
    if (!isTest && !panelForm.serviceCode) {
      showToast('Select a shipping service', 'error')
      return null
    }
    if (!weightOz) {
      showToast('Enter shipment weight', 'error')
      return null
    }

    const location = locations.find((candidate) => String(candidate.locationId) === panelForm.locationId) ?? null
    const shipTo = getShipTo(order, orderDetail)
    const selectedPackage = packages.find((candidate) => String(candidate.packageId) === panelForm.packageId)
    const testSelectedRate = isTest ? (panelRatePreview[0] ?? order.bestRate ?? null) : null
    const testCarrierCode = toStringValue(testSelectedRate?.carrierCode) ?? TEST_CARRIER_CODE
    const testServiceCode = panelForm.serviceCode || toStringValue(testSelectedRate?.serviceCode) || TEST_SERVICE_CODE

    const payload: CreateLabelRequestDto = {
      orderId: order.orderId,
      orderNumber: order.orderNumber ?? undefined,
      carrierCode: isTest ? testCarrierCode : account.code,
      serviceCode: isTest ? testServiceCode : panelForm.serviceCode,
      shippingProviderId: isTest ? null : shippingProviderId,
      packageCode: 'package',
      customPackageId: selectedPackage && selectedPackage.source !== 'ss_carrier' ? selectedPackage.packageId : null,
      weightOz,
      length,
      width,
      height,
      confirmation: panelForm.confirmation === 'none' ? 'delivery' : panelForm.confirmation,
      testLabel: isTest || mode === 'test',
      shipTo: {
        name: shipTo.name ?? '',
        company: shipTo.company ?? '',
        street1: shipTo.street1 ?? '',
        street2: shipTo.street2 ?? '',
        city: shipTo.city ?? '',
        state: shipTo.state ?? '',
        postalCode: shipTo.postalCode ?? '',
        country: shipTo.country ?? 'US',
        phone: shipTo.phone ?? '',
      },
      shipFrom: location ? {
        name: location.name,
        company: location.company,
        street1: location.street1,
        street2: location.street2,
        city: location.city,
        state: location.state,
        postalCode: location.postalCode,
        country: location.country,
        phone: location.phone,
      } : undefined,
    }

    setSingleActionBusy(true)
    try {
      const response = await apiClient.createLabel(payload)
      if (mode === 'queue' && response.labelUrl && order.clientId != null) {
        await apiClient.addToQueue(buildQueueAddPayload(order, response.labelUrl))
        await hydrateQueue(true)
        showToast(
          formatQueuedOrderToast(
            order.orderNumber ?? order.orderId,
            getActiveItems(order, orderDetailsById.get(order.orderId) ?? null),
          ),
          'success',
        )
      } else if (response.labelUrl) {
        window.open(response.labelUrl, '_blank', 'noopener,noreferrer')
        showToast(mode === 'test' ? `🧪 Test label created${response.trackingNumber ? `: ${response.trackingNumber}` : ''}` : `✅ Label created${response.trackingNumber ? `: ${response.trackingNumber}` : ''}`, 'success')
      } else {
        showToast('Label created but no PDF returned', 'info')
      }

      await autoSavePanelSkuDefaults(panelForm.packageId || null, {
        order,
        detail: orderDetail,
        weightOz,
        dims: hasCompleteDims(labelDims) ? labelDims : null,
      })

      await refetchOrders()
      return response
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Label creation failed', 'error')
      return null
    } finally {
      setSingleActionBusy(false)
    }
  }

  async function saveSkuDefaults() {
    if (!panelOrder) return

    const target = getSingleSkuDefaultTarget(panelOrder, panelDetail)
    if (!target) {
      const hasAnySku = getActiveItems(panelOrder, panelDetail).some((item) => item.sku)
      showToast(
        hasAnySku
          ? "Multi-SKU order - edit each product's defaults in the Products tab"
          : 'No products found on this order',
        'error',
      )
      return
    }

    const weightOz = getPanelWeightOz()
    const dims = getPanelDims()

    if (!weightOz && !hasCompleteDims(dims)) {
      showToast('Enter weight or complete dims first', 'error')
      return
    }

    try {
      const ensuredPackageId = hasCompleteDims(dims)
        ? await ensurePanelPackageForDims({ saveSku: false, silent: false })
        : panelForm.packageId
      const savedSku = await savePanelSkuDefaults(ensuredPackageId || panelForm.packageId || null)
      if (savedSku) showToast(`Saved dims & weight for ${savedSku}`, 'success')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Save failed', 'error')
    }
  }

  function getRateTotalForSort(rate: Record<string, unknown>) {
    const shipmentCost = toNumberValue(rate.shipmentCost) ?? toNumberValue(rate.amount) ?? 0
    const otherCost = toNumberValue(rate.otherCost) ?? 0
    return applyCarrierMarkup({
      shippingProviderId: toNumberValue(rate.shippingProviderId) ?? undefined,
      carrierCode: toStringValue(rate.carrierCode) ?? '',
      serviceCode: toStringValue(rate.serviceCode) ?? '',
      serviceName: toStringValue(rate.serviceName) ?? '',
      amount: shipmentCost + otherCost,
      shipmentCost,
      otherCost,
      carrierNickname: toStringValue(rate.carrierNickname) ?? undefined,
    }, markups)
  }

  function pickBestPanelRate(rates: Array<Record<string, unknown>>) {
    return [...rates]
      .filter((rate) => {
        const serviceCode = toStringValue(rate.serviceCode)
        const carrierCode = toStringValue(rate.carrierCode)
        const hasAmount = toNumberValue(rate.shipmentCost) != null || toNumberValue(rate.amount) != null
        return Boolean(serviceCode && carrierCode && hasAmount)
      })
      .sort((left, right) => getRateTotalForSort(left) - getRateTotalForSort(right))[0] ?? null
  }

  async function refreshPanelBestRate(options: {
    order: OrderSummaryDto
    dims: { length: number; width: number; height: number }
    weightOz: number
    silent?: boolean
  }) {
    const { order, dims, weightOz, silent = false } = options
    if (!hasCompleteDims(dims) || weightOz <= 0) return null
    const orderDetail = orderDetailsById.get(order.orderId) ?? panelDetail

    if (isTestOrder(order, orderDetail)) {
      const testRate = buildTestMockRate(buildBestTestRateForShipment(order.orderId, dims, weightOz) ?? undefined)
      setPanelRatePreview([testRate])
      setPanelForm((current) => ({
        ...current,
        shipAccountId: TEST_CARRIER_CODE,
        serviceCode: testRate.serviceCode,
      }))
      await apiClient.saveOrderBestRate(order.orderId, testRate, `${dims.length || 0}x${dims.width || 0}x${dims.height || 0}`)
      return testRate
    }

    const shipTo = getShipTo(order, orderDetail)
    if (!shipTo.postalCode) return null

    const runId = bestRateRefreshSeqRef.current + 1
    bestRateRefreshSeqRef.current = runId
    setPanelRateLoading(true)
    setPanelRatePreview([])

    try {
      const rates = await apiClient.fetchRates({
        weightOz,
        toZip: shipTo.postalCode,
        toCountry: shipTo.country ?? 'US',
        toState: shipTo.state ?? undefined,
        toCity: shipTo.city ?? undefined,
        dimsL: dims.length,
        dimsW: dims.width,
        dimsH: dims.height,
        residential: Boolean(order.residential ?? order.sourceResidential),
        storeId: order.storeId,
        clientId: order.clientId,
        forceRefresh: true,
      }) as Array<Record<string, unknown>>

      if (bestRateRefreshSeqRef.current !== runId) return null

      const bestRate = pickBestPanelRate(rates)
      const dimsLabel = `${dims.length || 0}x${dims.width || 0}x${dims.height || 0}`

      if (bestRate) {
        setPanelRatePreview([bestRate])
        const shippingProviderId = toProviderAccountId(bestRate.shippingProviderId)
        const serviceCode = toStringValue(bestRate.serviceCode)
        if (shippingProviderId != null && serviceCode) {
          setPanelForm((current) => ({
            ...current,
            shipAccountId: String(shippingProviderId),
            serviceCode,
          }))
          void apiClient.setOrderSelectedPid(order.orderId, shippingProviderId)
        }
        await apiClient.saveOrderBestRate(order.orderId, bestRate, dimsLabel)
        return bestRate
      }

      await apiClient.saveOrderBestRate(order.orderId, null, dimsLabel)
      setPanelRatePreview([])
      return null
    } catch (error) {
      if (!silent) showToast(error instanceof Error ? error.message : 'Failed to refresh best rate', 'error')
      return null
    } finally {
      if (bestRateRefreshSeqRef.current === runId) setPanelRateLoading(false)
    }
  }

  async function persistShipmentDetails(options: {
    silent?: boolean
    refreshBestRate?: boolean
    skipIfUnchanged?: boolean
  } = {}) {
    if (!panelOrder) return false

    const { silent = false, refreshBestRate = true, skipIfUnchanged = false } = options
    const currentKey = getShipmentDetailsKey(panelOrder.orderId, panelForm)
    if (skipIfUnchanged && currentKey === shipmentLastSavedKeyRef.current) return false

    const weightOz = getPanelWeightOz()
    const dims = getPanelDims()
    const selectedPackage = packages.find((candidate) => getPackageIdentifier(candidate) === panelForm.packageId)
    const dimsToSave = hasCompleteDims(dims) ? dims : getPackageDims(selectedPackage)
    const hasWeightInput = panelForm.weightLb.trim() !== '' || panelForm.weightOz.trim() !== ''
    const hasWeightToSave = hasWeightInput && weightOz > 0

    if (!hasWeightToSave && !dimsToSave && !panelForm.packageId) {
      if (!silent) showToast('Enter weight, size, or package first', 'error')
      return false
    }

    setShipmentDetailsSaving(true)
    try {
      let savedPackageId = panelForm.packageId
      if (hasCompleteDims(dims)) {
        savedPackageId = await ensurePanelPackageForDims({ saveSku: false, silent: true }) || panelForm.packageId
      } else {
        await apiClient.setOrderSelectedPackageId(
          panelOrder.orderId,
          panelForm.packageId ? Number.parseInt(panelForm.packageId, 10) : null,
        )
      }

      const payload: Record<string, number> = {}
      if (dimsToSave) {
        payload.length = dimsToSave.length
        payload.width = dimsToSave.width
        payload.height = dimsToSave.height
      }
      if (hasWeightToSave) payload.weightOz = weightOz

      if (Object.keys(payload).length > 0) {
        await apiClient.saveOrderDims(panelOrder.orderId, payload)
      }

      await autoSavePanelSkuDefaults(savedPackageId || panelForm.packageId || null, {
        order: panelOrder,
        detail: panelDetail,
        weightOz: hasWeightToSave ? weightOz : undefined,
        dims: dimsToSave,
      })

      if (savedPackageId && savedPackageId !== panelForm.packageId) {
        setPanelForm((current) => ({ ...current, packageId: savedPackageId }))
      }

      shipmentLastSavedKeyRef.current = getShipmentDetailsKey(panelOrder.orderId, {
        ...panelForm,
        packageId: savedPackageId || panelForm.packageId,
      })

      if (refreshBestRate && dimsToSave && hasWeightToSave) {
        await refreshPanelBestRate({ order: panelOrder, dims: dimsToSave, weightOz, silent })
      }

      await refetchOrders()
      if (!silent) showToast('Shipment details saved', 'success')
      return true
    } catch (error) {
      if (!silent) showToast(error instanceof Error ? error.message : 'Failed to save shipment details', 'error')
      return false
    } finally {
      setShipmentDetailsSaving(false)
    }
  }

  async function saveShipmentDetails() {
    await persistShipmentDetails({ silent: false, refreshBestRate: true })
  }

  async function toggleResidential() {
    if (!panelOrder) return
    const next = panelOrder.residential == null ? true : panelOrder.residential ? false : null

    try {
      await apiClient.setOrderResidential(panelOrder.orderId, next)
      await refetchOrders()
      showToast('Address type updated', 'success')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to update address type', 'error')
    }
  }

  async function markOrderShippedExternal(source: string) {
    if (!panelOrder || extShipBusy) return

    setExtShipBusy(true)
    const trimmedTracking = extShipTracking.trim()
    const wantNotify = extShipNotifyCustomer || extShipNotifyMarketplace
    const channels: string[] = []
    if (extShipNotifyCustomer) channels.push('customer')
    if (extShipNotifyMarketplace) channels.push('marketplace')

    // apiClient.markOrderShippedExternal is wrapped by safe() — it
    // CATCHES errors and returns { ok: false } instead of re-throwing.
    // So a try/catch here cannot detect failure; we must inspect the
    // result shape: success → { data, notify }, failure → { ok: false }.
    // The previous version showed a green '✅ Marked shipped' toast
    // even when the API call failed because the catch block never fired.
    const result = (await apiClient.markOrderShippedExternal(panelOrder.orderId, source, {
      trackingNumber: trimmedTracking || null,
      carrierCode: null, // future: dropdown for carrier when notify is on
      notifyCustomer: extShipNotifyCustomer,
      notifyMarketplace: extShipNotifyMarketplace,
    })) as
      | { data: unknown; notify?: { ok: boolean; reason?: string } }
      | { ok: false }

    setExtShipBusy(false)

    // Detect API-level failure first — if the local DB flip didn't
    // happen, no point continuing to talk about notify status.
    const apiCallFailed = (result as { ok?: unknown })?.ok === false
    if (apiCallFailed) {
      showToast(`❌ Failed to mark shipped via ${source} — check Render logs`, 'error')
      return
    }

    // Local flip succeeded. Now inspect notify status to compose the
    // toast. Three outcomes:
    //   1. Didn't request notify → simple success toast
    //   2. Requested notify, succeeded → success with channel list
    //   3. Requested notify, failed → warning with reason (local DB
    //      already flipped — operator can retry the notify side
    //      separately if needed)
    let summary = `✅ Marked shipped via ${source}`
    let tone: 'success' | 'error' = 'success'
    if (wantNotify) {
      const notify = (result as { notify?: { ok: boolean; reason?: string } }).notify
      if (notify?.ok === true) {
        summary += ` · notified ${channels.join(' + ')}`
      } else {
        summary += ` · ⚠ notify ${channels.join(' + ')} failed: ${notify?.reason ?? 'unknown'}`
        tone = 'error'
      }
    }
    showToast(summary, tone)

    // Reset the popover form so the next open starts fresh — except
    // the marketplace toggle which we keep at "on" for next time.
    setExtShipTracking('')
    setExtShipNotifyCustomer(false)
    setExtShipNotifyMarketplace(true)
    clearSelection()
    await refetchOrders()
  }

  async function reprintLabel() {
    if (!panelOrder) return

    try {
      const data = await apiClient.retrieveLabel(panelOrder.orderId)
      window.open(data.labelUrl, '_blank', 'noopener,noreferrer')
      showToast(`📄 Label opened for ${data.trackingNumber || panelOrder.orderNumber || panelOrder.orderId}`)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to retrieve label', 'error')
    }
  }

  async function openRateBrowser() {
    if (!panelOrder) return
    if (isTestOrder(panelOrder, panelDetail)) {
      const weightOz = getPanelWeightOz() || getOrderWeightOz(panelOrder, panelDetail)
      const panelDims = getPanelDims()
      const selectedPackage = packages.find((candidate) => getPackageIdentifier(candidate) === panelForm.packageId)
      const dims = hasCompleteDims(panelDims)
        ? panelDims
        : getPackageDims(selectedPackage) ?? getDimensions(panelOrder, panelDetail)

      if (!weightOz) {
        showToast('Enter shipment weight', 'error')
        return
      }
      if (!dims || !hasCompleteDims(dims)) {
        showToast('Enter shipment size', 'error')
        return
      }

      setRateBrowserRates([buildTestMockRate(buildBestTestRateForShipment(panelOrder.orderId, dims, weightOz) ?? undefined)])
      setRateBrowserLoading(false)
      setRateBrowserOpen(true)
      return
    }

    setRateBrowserOpen(true)
    setRateBrowserLoading(true)
    try {
      const weightOz = getPanelWeightOz() || (panelOrder.weight?.value ?? 0)
      const dims = getPanelDims()
      const payload = await apiClient.fetchOrderDims(panelOrder.orderId)
      const length = dims.length || payload.dims?.length || getDimensions(panelOrder, panelDetail)?.length || 0
      const width = dims.width || payload.dims?.width || getDimensions(panelOrder, panelDetail)?.width || 0
      const height = dims.height || payload.dims?.height || getDimensions(panelOrder, panelDetail)?.height || 0
      const shipTo = getShipTo(panelOrder, panelDetail)
      const rawRates = await apiClient.fetchRates({
        weightOz,
        toZip: shipTo.postalCode ?? '',
        toCountry: shipTo.country ?? 'US',
        toState: shipTo.state ?? undefined,
        toCity: shipTo.city ?? undefined,
        dimsL: length, dimsW: width, dimsH: height,
        residential: Boolean(panelOrder.residential ?? panelOrder.sourceResidential),
        storeId: panelOrder.storeId,
        clientId: panelOrder.clientId,
        forceRefresh: true,
      })
      // Remap ShipStation v2 rate shape → v2-legacy shape the panel expects.
      const rates = (rawRates ?? []).map((r: any) => {
        const shipmentCost = r.shipmentCost ?? r.shipping_amount?.amount ?? 0
        const otherCost = r.otherCost ?? r.other_amount?.amount ?? 0
        return {
          carrierCode: r.carrierCode ?? r.carrier_code ?? null,
          serviceCode: r.serviceCode ?? r.service_code ?? null,
          serviceName: r.serviceName ?? r.service_type ?? null,
          carrierNickname: r.carrierNickname ?? r.carrier_nickname ?? null,
          shippingProviderId: toProviderAccountId(r.shippingProviderId ?? r.carrier_id),
          amount: shipmentCost + otherCost,
          shipmentCost,
          otherCost,
          raw: r,
        }
      })
      setRateBrowserRates(rates)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to browse rates', 'error')
      setRateBrowserRates([])
    } finally {
      setRateBrowserLoading(false)
    }
  }

  function applyRateSelection(rate: Record<string, unknown>) {
    if (panelOrder && isTestOrder(panelOrder, panelDetail)) {
      const testRate = buildTestMockRate(rate)
      const dims = rate?.dims && typeof rate.dims === 'object' ? rate.dims as Record<string, unknown> : null
      const dimsLabel = dims
        ? `${Number(dims.length) || 0}x${Number(dims.width) || 0}x${Number(dims.height) || 0}`
        : `${panelForm.length || 0}x${panelForm.width || 0}x${panelForm.height || 0}`

      setPanelForm((current) => ({
        ...current,
        shipAccountId: TEST_CARRIER_CODE,
        serviceCode: testRate.serviceCode,
      }))
      setPanelRatePreview([testRate])
      setRateBrowserOpen(false)
      void apiClient
        .saveOrderBestRate(panelOrder.orderId, testRate, dimsLabel)
        .then(() => refetchOrders())
        .catch((error) => {
          showToast(error instanceof Error ? error.message : 'Failed to save test mock rate', 'error')
        })
      return
    }

    const shippingProviderId = toNumberValue(rate.shippingProviderId)
    const serviceCode = toStringValue(rate.serviceCode)
    if (shippingProviderId == null || !serviceCode) return

    setPanelForm((current) => ({
      ...current,
      shipAccountId: String(shippingProviderId),
      serviceCode,
    }))
    setPanelRatePreview([rate])
    setRateBrowserOpen(false)
    void apiClient.saveOrderBestRate(panelOrderId ?? 0, rate, `${panelForm.length || 0}x${panelForm.width || 0}x${panelForm.height || 0}`)
  }

  async function printPicklist() {
    try {
      const data: OrderPicklistResponseDto = await apiClient.fetchPicklist({
        orderStatus: currentStatus,
        storeId: activeStore ?? undefined,
        dateStart: dateRange.start,
        dateEnd: dateRange.end,
      })
      if (!data.skus.length) {
        showToast('No items found for current filter')
        return
      }

      const dateLabel = dateFilter === 'custom' && dateRange.start
        ? `${dateRange.start}${dateRange.end ? ` – ${dateRange.end}` : ''}`
        : dateFilter || 'all dates'
      const html = buildPicklistPrintHtml(data.skus, {
        generatedAt: new Date().toLocaleString(),
        dateLabel,
        statusLabel: currentStatus.replace(/_/g, ' '),
      })
      const printWindow = window.open('', '_blank')
      if (!printWindow) {
        showToast('Allow popups to print pick list', 'error')
        return
      }
      printWindow.document.write(html)
      printWindow.document.close()
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Picklist error', 'error')
    }
  }

  function escapePrintWindowText(message: string) {
    return message.replace(/[<>&"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[char] ?? char))
  }

  function openQueuePrintWindow() {
    const printWindow = window.open('', '_blank')
    if (!printWindow) return null
    printWindow.document.write(`<!doctype html>
<html>
  <head>
    <title>PrepShip Print Queue</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f8fb; color: #172033; }
      main { text-align: center; max-width: 360px; padding: 32px; }
      .spinner { width: 30px; height: 30px; border: 3px solid #d8e0ef; border-top-color: #2563eb; border-radius: 50%; margin: 0 auto 16px; animation: spin 1s linear infinite; }
      h1 { font-size: 18px; margin: 0 0 8px; }
      p { font-size: 13px; color: #5b667a; margin: 0; line-height: 1.45; }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style>
  </head>
  <body>
    <main>
      <div class="spinner"></div>
      <h1>Preparing PDF</h1>
      <p>Your labels are being merged. This tab will show the PDF when it is ready.</p>
    </main>
  </body>
</html>`)
    printWindow.document.close()
    return printWindow
  }

  function showQueuePrintWindowError(printWindow: Window | null, message: string) {
    if (!printWindow || printWindow.closed) return
    printWindow.document.open()
    printWindow.document.write(`<!doctype html>
<html>
  <head><title>PrepShip Print Queue</title></head>
  <body style="font-family: Arial, sans-serif; padding: 32px; color: #172033;">
    <h1 style="font-size: 18px;">PDF failed</h1>
    <p style="font-size: 13px; color: #5b667a;">${escapePrintWindowText(message)}</p>
  </body>
</html>`)
    printWindow.document.close()
  }

  async function printQueueEntries(entryIds: string[]) {
    if (queueClientId == null || entryIds.length === 0) return

    const printWindow = openQueuePrintWindow()
    let pdfOpened = false
    setQueuePrintInFlight(true)
    setQueuePrintProgress(0)
    setQueuePrintMessage('Starting merge…')
    try {
      const job = await apiClient.startQueuePrintJob(queueClientId, entryIds, true)
      if (!job?.job_id) {
        throw new Error('Print job did not start')
      }

      let done = false
      while (!done) {
        await new Promise((resolve) => window.setTimeout(resolve, 600))
        const status = await apiClient.fetchQueuePrintJobStatus(job.job_id)
        if (!status || status.status === 'unknown') {
          throw new Error('Print job status unavailable')
        }
        setQueuePrintMessage(status.message)
        setQueuePrintProgress(typeof status.progress === 'number' ? status.progress : null)

        if (status.status === 'done') {
          // The download endpoint requires a Bearer token, so a plain
          // window.open won't work — fetch the PDF as a blob with auth and
          // open the resulting object URL. Path is /print-queue/print/...
          // (matches PrintQueueDrawer.downloadAuthedPdf — the legacy
          // /api/queue/print/... path that some early builds used was
          // never wired up on the API).
          try {
            const blobUrl = await apiClient.fetchQueuePrintJobPdfUrl(job.job_id)
            if (blobUrl) {
              if (printWindow && !printWindow.closed) {
                printWindow.location.href = blobUrl
                pdfOpened = true
              } else {
                const opened = window.open(blobUrl, '_blank', 'noopener,noreferrer')
                pdfOpened = Boolean(opened)
                if (!opened) {
                  const link = document.createElement('a')
                  link.href = blobUrl
                  link.download = `prepship-labels-${job.job_id}.pdf`
                  document.body.appendChild(link)
                  link.click()
                  document.body.removeChild(link)
                  pdfOpened = true
                }
              }
            }
          } catch (err) {
            console.error('[print-queue] download failed', err)
          }
          done = true
          setQueuePrintProgress(100)
        }
        if (status.status === 'error') {
          throw new Error(status.error || status.errorMessage || 'PDF merge failed')
        }
      }

      await hydrateQueue()
      showToast(
        pdfOpened
          ? `✅ ${entryIds.length} label${entryIds.length === 1 ? '' : 's'} — opened in new tab`
          : `✅ ${entryIds.length} label${entryIds.length === 1 ? '' : 's'} — PDF ready, but popup was blocked`,
        pdfOpened ? 'success' : 'error'
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Print failed'
      showQueuePrintWindowError(printWindow, message)
      showToast(message, 'error')
    } finally {
      setQueuePrintInFlight(false)
      setQueuePrintMessage(null)
      setQueuePrintProgress(null)
    }
  }

  async function handleAssignSelectedOrders() {
    if (!callerIsAdmin) {
      showToast('Only admins can assign orders', 'error')
      return
    }
    const ids = [...selectedIdSet]
    if (ids.length === 0) {
      showToast('No orders selected', 'error')
      return
    }
    if (!assignTo) {
      showToast('Pick a user (or "Unassign") first', 'error')
      return
    }

    const target = assignTo === 'unassign'
      ? { userId: null, email: null, label: 'Unassigned' }
      : (() => {
          const u = assignableUsers.find((cand) => cand.id === assignTo)
          return u ? { userId: u.id, email: u.email, label: u.email } : null
        })()
    if (!target) {
      showToast('User not found in list — refresh the page', 'error')
      return
    }

    setAssignBusy(true)
    try {
      const res = await api.post<{ updated: number; requested: number }>(
        '/orders/bulk-assign',
        { orderIds: ids, userId: target.userId, email: target.email },
      )
      showToast(`Assigned ${res.updated}/${res.requested} order(s) to ${target.label}`, 'success')
      clearSelection()
      await refetchOrders()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to assign orders', 'error')
    } finally {
      setAssignBusy(false)
    }
  }

  async function handleBatchAction(mode: 'print' | 'queue') {
    const batchOrders = orders.filter((order) => selectedIdSet.has(order.orderId))
    if (batchOrders.length === 0) {
      showToast('No orders selected', 'error')
      return
    }

    if (mode === 'queue') {
      setBatchBusy(true)
      try {
        const result = await sendOrdersToQueueBackend(batchOrders, {
          kind: 'batch-queue',
          label: 'Sending to queue',
          batchTestMode,
        })
        if (result.queued > 0) {
          showToast(formatQueuedOrdersToast(result.queued, result.queuedItems, result.failed), 'success')
        } else {
          showToast('No orders added to queue', 'error')
        }
      } catch (error) {
        showToast(error instanceof Error ? error.message : 'Failed to send to queue', 'error')
      } finally {
        setBatchBusy(false)
      }
      return
    }

    setBatchBusy(true)
    const queueJobId = mode === 'queue'
      ? beginPersistentQueueJob('batch-queue', batchOrders, { label: 'Sending to queue', batchTestMode })
      : null
    let created = 0
    let failed = 0
    const queuedItems: Array<{ sku?: string | null; name?: string | null; quantity?: number | null }> = []

    const processOrder = async (order: OrderSummaryDto) => {
      const bestRate = order.bestRate
      const selectedRate = order.selectedRate
      const shippingProviderId = toNumberValue(bestRate?.shippingProviderId) ?? selectedRate?.shippingProviderId ?? order.label?.shippingProviderId ?? null
      const serviceCode = getShippingString(order, 'serviceCode') ?? toStringValue(bestRate?.serviceCode) ?? selectedRate?.serviceCode
      const carrierCode = getShippingString(order, 'carrierCode') ?? toStringValue(bestRate?.carrierCode) ?? selectedRate?.carrierCode
      const weightOz = order.weight?.value ?? 0
      const dims = getDimensions(order, null)

      // Test-client orders bypass the rate-fetch requirement — the backend
      // forces a VOID mock label regardless, so we just need to reach the
      // endpoint with a serviceCode + carrierCode. Use the order's stored
      // defaults when no rate has been shopped.
      const orderIsTest = isTestOrder(order, orderDetailsById.get(order.orderId) ?? null)
      const effectiveServiceCode = serviceCode ?? (orderIsTest ? TEST_SERVICE_CODE : null)
      const effectiveCarrierCode = carrierCode ?? (orderIsTest ? TEST_CARRIER_CODE : null)

      // Real-postage path still requires shippingProviderId. For test orders
      // the backend never makes that call, so we omit the field entirely
      // rather than try to sneak a 0 past Zod's .positive() validator.
      if (!orderIsTest && shippingProviderId == null) {
        failed += 1
        if (mode === 'queue') markPersistentQueueJobOrder(queueJobId, order.orderId, true)
        if (mode === 'queue') advanceQueueActionProgress(1)
        return
      }
      if (!effectiveServiceCode || !effectiveCarrierCode) {
        failed += 1
        if (mode === 'queue') markPersistentQueueJobOrder(queueJobId, order.orderId, true)
        if (mode === 'queue') advanceQueueActionProgress(1)
        return
      }

      try {
        const payload: Record<string, unknown> = {
          orderId: order.orderId,
          // v2-parity: pass orderNumber so ShipStation's external_order_id
          // field is populated (helps reconciliation reports). Server-side
          // fallback exists but passing it explicitly matches v2.
          orderNumber: order.orderNumber ?? undefined,
          serviceCode: effectiveServiceCode,
          carrierCode: effectiveCarrierCode,
          packageCode: 'package',
          weightOz,
          length: dims?.length,
          width: dims?.width,
          height: dims?.height,
          // v2-parity: batch labels default to 'delivery' confirmation (signed
          // on delivery, cheapest level that's still tracked). Without this,
          // v4 falls through to 'none' at src/lib/shipstation/labels.ts:152 →
          // no signature tracking and different carrier billing vs v2.
          // Single-order path at line ~1309 already does this conversion.
          confirmation: 'delivery',
          testLabel: batchTestMode || orderIsTest,
        }
        if (shippingProviderId != null) {
          payload.shippingProviderId = shippingProviderId
        }
        const response = await apiClient.createLabel(payload)

        if (mode === 'queue' && response.labelUrl && order.clientId != null) {
          await apiClient.addToQueue(buildQueueAddPayload(order, response.labelUrl))
          queuedItems.push(...getActiveItems(order, orderDetailsById.get(order.orderId) ?? null))
        } else if (response.labelUrl) {
          window.open(response.labelUrl, '_blank', 'noopener,noreferrer')
        }
        created += 1
        // Mark this row for the 5s strikethrough transition. It'll
        // visually fade + line-through, then refetchOrders below removes
        // it from the awaiting list once the backend confirms 'shipped'.
        if (mode === 'print') {
          // ─── 30-second continuous fade transition ────────────────
          // Boss directive 2026-05-07: the operator must SEE the
          // order fading throughout, not just at the end. The fade
          // is a CSS keyframe animation (ps-shipping-fade in
          // app-shell.css) that runs for 30 s and ends at opacity-0
          // / scaled / shifted-right. A "Shipping…" pill renders
          // inline next to the order number during the transition
          // for an explicit signal.
          //
          // At t=30 s we refetch. Backend already has the order as
          // 'shipped' (order-sync race fix in 1afe757) so the row
          // drops naturally from the awaiting list.
          const TRANSITION_MS = 30_000

          setTransitionalShippedIds((prev) => {
            const next = new Set(prev)
            next.add(order.orderId)
            return next
          })

          // Cancel any prior timer for this orderId (operator clicked
          // print again before the previous animation finished — rare
          // but possible).
          const existing = transitionalTimeoutsRef.current.get(order.orderId)
          if (existing) window.clearTimeout(existing)

          const timer = window.setTimeout(() => {
            setTransitionalShippedIds((prev) => {
              const next = new Set(prev)
              next.delete(order.orderId)
              return next
            })
            transitionalTimeoutsRef.current.delete(order.orderId)
            void refetchOrders()
          }, TRANSITION_MS)

          transitionalTimeoutsRef.current.set(order.orderId, timer)
        }
        if (mode === 'queue') markPersistentQueueJobOrder(queueJobId, order.orderId, false)
        if (mode === 'queue') advanceQueueActionProgress()
      } catch {
        failed += 1
        if (mode === 'queue') markPersistentQueueJobOrder(queueJobId, order.orderId, true)
        if (mode === 'queue') advanceQueueActionProgress(1)
      }
    }

    if (mode === 'queue') {
      await runWithConcurrency(batchOrders, BATCH_QUEUE_CONCURRENCY, async (order) => {
        await processOrder(order)
      })
    } else {
      for (const order of batchOrders) {
        await processOrder(order)
      }
    }

    setBatchBusy(false)
    if (mode === 'queue' && created > 0) {
      setQueueActionProgressLabel('Refreshing queue')
      await hydrateQueue(true)
    }
    // Print mode skips the immediate refetch — the per-row 5s timer
    // handles refetching AFTER the strikethrough transition completes.
    // If we refetch here, the awaiting list updates instantly and the
    // row disappears before the visual cue plays.
    if (mode !== 'print' || created === 0) {
      await refetchOrders()
    }
    if (mode === 'queue') {
      finishPersistentQueueJob(queueJobId)
      finishQueueActionProgress(created > 0 ? 'Queue updated' : 'Queue checked')
    }
    if (mode === 'queue' && created > 0) {
      showToast(formatQueuedOrdersToast(created, queuedItems, failed), 'success')
    } else if (failed === 0) {
      showToast(`✅ ${mode === 'queue' ? 'Queued' : 'Created'} ${created} orders`, 'success')
    } else {
      showToast(`⚠ ${created} ${mode === 'queue' ? 'queued' : 'created'}, ${failed} failed`)
    }
  }

  // Batch Mark-as-Shipped — flips externallyShipped=true on every
  // selected order in one go, optionally pushing notify-customer +
  // notify-marketplace through to ShipStation v1 markasshipped for
  // each. Mirrors the single-order popover (state lives in a parallel
  // set of useState hooks below) so behavior is consistent: same
  // toggles, same source picker, same per-order failure handling.
  //
  // We process orders sequentially (not Promise.all) for two reasons:
  //   1. The /shipped-external endpoint runs ssMarkOrderShippedV1
  //      under the hood, which hits ShipStation's rate-limited v1 API.
  //      Parallel calls trigger 429s.
  //   2. Surfacing partial-failure stats ('5 ok, 2 failed') is much
  //      cleaner with a sequential loop + ok/failed counters.
  //
  // CRITICAL detail on error detection:
  //   apiClient.markOrderShippedExternal is wrapped by safe() which
  //   catches any thrown error and returns the fallback { ok: false }
  //   instead of re-throwing. That means a try/catch around the call
  //   would NEVER fire — every iteration would land in the success
  //   branch even when the backend 500'd. We instead inspect the
  //   returned shape: success → { data, notify }; failure → { ok: false }.
  //   Detecting result?.ok === false is the only reliable way to count
  //   failures correctly.
  async function handleBatchMarkAsShipped(source: string) {
    const batchOrders = orders.filter((order) => selectedIdSet.has(order.orderId))
    if (batchOrders.length === 0) {
      showToast('No orders selected', 'error')
      return
    }
    if (extShipBusy) return
    setExtShipBusy(true)
    showToast(`📦 Marking ${batchOrders.length} order${batchOrders.length === 1 ? '' : 's'} shipped via ${source}…`)

    let ok = 0
    let failed = 0
    let notifyOk = 0
    let notifyFailed = 0
    const failureReasons: string[] = []
    const notifyChannels: string[] = []
    if (extShipNotifyCustomer) notifyChannels.push('customer')
    if (extShipNotifyMarketplace) notifyChannels.push('marketplace')
    const wantNotify = notifyChannels.length > 0

    for (const order of batchOrders) {
      // Note the explicit unknown-cast: the apiClient method returns
      // any (legacy v2-compat type), which would let bugs through
      // without typecheck noticing. Forcing inspection through a
      // narrowed local removes the any-blob.
      const result = (await apiClient.markOrderShippedExternal(order.orderId, source, {
        trackingNumber: null,
        carrierCode: null,
        notifyCustomer: extShipNotifyCustomer,
        notifyMarketplace: extShipNotifyMarketplace,
      })) as
        | { data: unknown; notify?: { ok: boolean; reason?: string } }
        | { ok: false }

      // safe() returns { ok: false } on any thrown error. The successful
      // backend response is shaped { data: row, notify: {...} } and
      // never has an `ok` field at the top level. So an `ok === false`
      // means the API call itself failed (network, 5xx, validation).
      const apiCallFailed = (result as { ok?: unknown })?.ok === false
      if (apiCallFailed) {
        failed += 1
        failureReasons.push(`#${order.orderNumber ?? order.orderId}`)
        console.warn(`[batch mark-shipped] order ${order.orderId} api call failed`)
        continue
      }

      ok += 1

      // Notify result is per-order. The local DB flip already succeeded
      // (because we got `data` back). The optional ShipStation v1 call
      // may have failed independently — track that separately so a
      // 'marked locally but not notified' partial state surfaces in
      // the toast instead of being silently swallowed.
      if (wantNotify) {
        const notify = (result as { notify?: { ok: boolean; reason?: string } }).notify
        if (notify?.ok === true) {
          notifyOk += 1
        } else {
          notifyFailed += 1
          if (notify?.reason) {
            console.warn(`[batch mark-shipped] order ${order.orderId} notify failed: ${notify.reason}`)
          }
        }
      }
    }

    setExtShipBusy(false)
    clearSelection()
    await refetchOrders()

    // Compose summary toast — explicit about THREE outcomes:
    //   1. Local DB flip count (ok/total)
    //   2. Notify success count (when notify was requested)
    //   3. Failure breakdown (with order numbers if 1-3 failed)
    const tone: 'success' | 'error' = failed > 0 ? 'error' : 'success'
    let summary = `${failed === 0 ? '✅' : '⚠'} Marked ${ok}/${batchOrders.length} shipped via ${source}`
    if (wantNotify) {
      if (notifyFailed === 0) {
        summary += ` · notified ${notifyChannels.join(' + ')}`
      } else {
        summary += ` · notified ${notifyOk}/${ok} (${notifyFailed} notify failed)`
      }
    }
    if (failed > 0) {
      const sample = failureReasons.slice(0, 3).join(', ')
      const more = failureReasons.length > 3 ? ` +${failureReasons.length - 3} more` : ''
      summary += ` · failures: ${sample}${more}`
    }
    showToast(summary, tone)

    // Reset popover form for the next batch.
    setExtShipNotifyCustomer(false)
    setExtShipNotifyMarketplace(true)
    setBatchExtShipMenuOpen(false)
  }

  async function resumePersistentQueueJob(job: PersistentQueueJob) {
    if (resumePersistentQueueJobIdRef.current === job.id) return

    const completedOrFailed = new Set([...(job.completedOrderIds ?? []), ...(job.failedOrderIds ?? [])])
    const pendingOrders = (job.orders ?? []).filter((order) => order?.orderId != null && !completedOrFailed.has(order.orderId))
    const progress = getPersistentQueueJobProgress(job)

    if (job.backendJobId) {
      resumePersistentQueueJobIdRef.current = job.id
      activePersistentQueueJobIdRef.current = job.id
      startQueueActionProgress(progress.total, 'Resuming queue', progress.completed, progress.failed)
      showToast(`Resuming queue send (${progress.completed}/${progress.total})`)
      try {
        const status = await pollBackendQueueSendJob(job.backendJobId, progress.total)
        await refreshQueueAfterBackendStatus(status, null)
        await refetchOrders()
        const queued = toNumberValue(status?.queued) ?? 0
        const failed = toNumberValue(status?.failed) ?? 0
        showToast(queued > 0 ? `Queue updated: ${queued} queued${failed ? `, ${failed} failed` : ''}` : 'Queue checked', queued > 0 ? 'success' : 'info')
        finishQueueActionProgress(queued > 0 ? 'Queue updated' : 'Queue checked')
      } catch (error) {
        showToast(error instanceof Error ? error.message : 'Failed to resume queue send', 'error')
        finishQueueActionProgress('Queue resume failed')
      } finally {
        clearPersistentQueueJob(job.id)
        activePersistentQueueJobIdRef.current = null
        resumePersistentQueueJobIdRef.current = null
      }
      return
    }

    if (pendingOrders.length === 0) {
      clearPersistentQueueJob(job.id)
      return
    }

    resumePersistentQueueJobIdRef.current = job.id
    activePersistentQueueJobIdRef.current = job.id
    startQueueActionProgress(progress.total, 'Resuming queue', progress.completed, progress.failed)
    showToast(`Resuming queue send (${progress.completed}/${progress.total})`)

    let sent = 0
    let failed = 0
    let queueClient: number | null = null
    const queuedItems: Array<{ sku?: string | null; name?: string | null; quantity?: number | null }> = []

    const markAndAdvance = (order: OrderSummaryDto, orderFailed: boolean) => {
      markPersistentQueueJobOrder(job.id, order.orderId, orderFailed)
      advanceQueueActionProgress(orderFailed ? 1 : 0)
    }

    const processExistingLabelOrder = async (order: OrderSummaryDto) => {
      if (!order?.label?.labelUrl || order.clientId == null) {
        failed += 1
        markAndAdvance(order, true)
        return
      }

      try {
        await apiClient.addToQueue(buildQueueAddPayload(order, order.label.labelUrl))
        sent += 1
        queueClient = queueClient ?? order.clientId
        queuedItems.push(...getActiveItems(order, orderDetailsById.get(order.orderId) ?? null))
        markAndAdvance(order, false)
      } catch {
        failed += 1
        markAndAdvance(order, true)
      }
    }

    const processBatchQueueOrder = async (order: OrderSummaryDto) => {
      const bestRate = order.bestRate
      const selectedRate = order.selectedRate
      const shippingProviderId = toNumberValue(bestRate?.shippingProviderId) ?? selectedRate?.shippingProviderId ?? order.label?.shippingProviderId ?? null
      const serviceCode = getShippingString(order, 'serviceCode') ?? toStringValue(bestRate?.serviceCode) ?? selectedRate?.serviceCode
      const carrierCode = getShippingString(order, 'carrierCode') ?? toStringValue(bestRate?.carrierCode) ?? selectedRate?.carrierCode
      const weightOz = order.weight?.value ?? 0
      const dims = getDimensions(order, null)
      const orderIsTest = isTestOrder(order, orderDetailsById.get(order.orderId) ?? null)
      const effectiveServiceCode = serviceCode ?? (orderIsTest ? TEST_SERVICE_CODE : null)
      const effectiveCarrierCode = carrierCode ?? (orderIsTest ? TEST_CARRIER_CODE : null)

      if (!orderIsTest && shippingProviderId == null) {
        failed += 1
        markAndAdvance(order, true)
        return
      }
      if (!effectiveServiceCode || !effectiveCarrierCode) {
        failed += 1
        markAndAdvance(order, true)
        return
      }

      try {
        const payload: Record<string, unknown> = {
          orderId: order.orderId,
          orderNumber: order.orderNumber ?? undefined,
          serviceCode: effectiveServiceCode,
          carrierCode: effectiveCarrierCode,
          packageCode: 'package',
          weightOz,
          length: dims?.length,
          width: dims?.width,
          height: dims?.height,
          confirmation: 'delivery',
          testLabel: Boolean(job.batchTestMode) || orderIsTest,
        }
        if (shippingProviderId != null) {
          payload.shippingProviderId = shippingProviderId
        }

        const response = await apiClient.createLabel(payload)
        if (!response.labelUrl || order.clientId == null) {
          throw new Error('Label was created without a queueable URL')
        }

        await apiClient.addToQueue(buildQueueAddPayload(order, response.labelUrl))
        sent += 1
        queueClient = queueClient ?? order.clientId
        queuedItems.push(...getActiveItems(order, orderDetailsById.get(order.orderId) ?? null))
        markAndAdvance(order, false)
      } catch {
        failed += 1
        markAndAdvance(order, true)
      }
    }

    try {
      setBatchBusy(job.kind === 'batch-queue')
      setQueueLoading(true)
      await runWithConcurrency(pendingOrders, BATCH_QUEUE_CONCURRENCY, async (order) => {
        if (job.kind === 'existing-labels') {
          await processExistingLabelOrder(order)
          return
        }
        await processBatchQueueOrder(order)
      })
      setQueueLoading(false)

      if (sent > 0 && queueClient != null) {
        setQueueActionProgressLabel('Refreshing queue')
        setQueueLoading(true)
        try {
          const payload = await apiClient.fetchQueue(queueClient, queueHistoryVisible)
          setQueueEntries(payload.queuedOrders)
          setQueueEntriesClientId(queueClient)
          setQueueOpen(true)
        } finally {
          setQueueLoading(false)
        }
      }

      await refetchOrders()
      if (sent > 0) {
        showToast(formatQueuedOrdersToast(sent, queuedItems, failed), 'success')
      } else {
        showToast('⚠ Queue resume finished with no new orders added')
      }
    } finally {
      setQueueLoading(false)
      setBatchBusy(false)
      finishPersistentQueueJob(job.id)
      resumePersistentQueueJobIdRef.current = null
      finishQueueActionProgress(sent > 0 ? 'Queue updated' : 'Queue checked')
    }
  }

  useEffect(() => {
    if (loading) return
    const job = readPersistentQueueJob()
    if (!job) return
    if (resumePersistentQueueJobIdRef.current === job.id || activePersistentQueueJobIdRef.current === job.id) return

    void resumePersistentQueueJob(job)
  }, [loading])

  const toggleSort = (key: SortKey) => {
    setPreSkuSortSnapshot(null)
    setSkuSortActive(false)
    setSortState((current) => {
      if (current.key === key) {
        return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
      }

      return {
        key,
        dir: key === 'date' || key === 'age' ? 'desc' : 'asc',
      }
    })
  }

  const toggleSkuSort = () => {
    if (!skuSortActive) {
      setPreSkuSortSnapshot(orderedFilteredOrders.map((order) => order.orderId))
      setSkuSortActive(true)
      return
    }

    setSkuSortActive(false)
  }

  const toggleSection = (key: PanelSectionKey) => {
    setCollapsedSections((current) => ({ ...current, [key]: !current[key] }))
  }

  const openShipStationOrder = (orderId: number) => {
    window.open(`https://ship.shipstation.com/orders/${orderId}`, '_blank', 'noopener,noreferrer')
  }

  const activeQueueEntries = queueEntriesClientId === queueClientId ? queueEntries : []
  const queuedEntries = useMemo(
    () => activeQueueEntries.filter((entry) => entry.status === 'queued'),
    [activeQueueEntries],
  )
  const printedEntries = useMemo(
    () => queueHistoryVisible ? activeQueueEntries.filter((entry) => entry.status === 'printed') : [],
    [activeQueueEntries, queueHistoryVisible],
  )
  const queueGroups = useMemo<PrintQueueGroup[]>(
    () => groupPrintQueueEntries(activeQueueEntries),
    [activeQueueEntries],
  )
  const queueCount = queuedEntries.length
  // Search & sort applied to the queue and history lists. Search matches the
  // order number OR the order_id (cast to string) — covers both how users
  // type queries (full order #, partial digits, etc.).
  const pqSearchLower = pqSearch.trim().toLowerCase()
  const matchesPqSearch = (entry: { order_number?: string | null; order_id?: number | string | null }) => {
    if (!pqSearchLower) return true
    const num = String(entry.order_number ?? '').toLowerCase()
    const id = String(entry.order_id ?? '').toLowerCase()
    return num.includes(pqSearchLower) || id.includes(pqSearchLower)
  }
  const visibleQueueGroups = useMemo<PrintQueueGroup[]>(() => {
    if (!pqSearchLower) return queueGroups
    return queueGroups
      .map((group) => ({ ...group, orders: group.orders.filter(matchesPqSearch) }))
      .filter((group) => group.orders.length > 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueGroups, pqSearchLower])
  const visiblePrintedEntries = useMemo(() => {
    const filtered = pqSearchLower ? printedEntries.filter(matchesPqSearch) : printedEntries
    const sorted = [...filtered].sort((a, b) => {
      const aT = a.last_printed_at ? Date.parse(a.last_printed_at) : 0
      const bT = b.last_printed_at ? Date.parse(b.last_printed_at) : 0
      return pqHistoryAsc ? aT - bT : bT - aT
    })
    return sorted
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printedEntries, pqSearchLower, pqHistoryAsc])
  const queueHasVisibleEntries = visibleQueueGroups.length > 0 || visiblePrintedEntries.length > 0
  const queueActionProgressPct = queueActionProgress
    ? Math.round((queueActionProgress.completed / Math.max(queueActionProgress.total, 1)) * 100)
    : 0
  const queueActionElapsedSeconds = queueActionProgress
    ? Math.max(0, Math.floor((Date.now() - queueActionProgress.startedAt) / 1000))
    : 0
  const queueToolbarProgress = queueActionProgress
    ? {
        label: queueActionProgress.label,
        detail: `${queueActionProgress.completed}/${queueActionProgress.total}${queueActionProgress.completed < queueActionProgress.total ? ` - working ${queueActionElapsedSeconds}s` : ''}${queueActionProgress.failed > 0 ? ` - ${queueActionProgress.failed} failed` : ''}`,
        pct: queueActionProgressPct,
        tone: queueActionProgress.failed > 0 ? '#f59e0b' : 'var(--ss-blue)',
      }
    : queuePrintInFlight && queuePrintMessage
      ? {
          label: 'Print queue',
          detail: queuePrintMessage,
          pct: queuePrintProgress ?? 0,
          tone: 'var(--ss-blue)',
        }
      : null

  const renderBestRatePrice = (order: OrderSummaryDto) => {
    // If the user is actively saving shipment details OR re-fetching rates
    // for this exact order, the saved bestRate on the row is stale until the
    // debounced /rates fetch lands. Show the spinner so the row visibly
    // reflects the recalculation in progress instead of flashing the old
    // number. Covers both phases of an edit:
    //   1. shipmentDetailsSaving — POSTing weight/dims to the server
    //   2. panelRateLoading — fetching new rates after save
    if ((panelRateLoading || shipmentDetailsSaving) && panelOrder?.orderId === order.orderId) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--ss-blue)', fontSize: 11, fontWeight: 600 }}>
          <span className="ship-rate-spinner" aria-hidden="true" />
          <span>Calculating…</span>
        </div>
      )
    }

    if (isTestOrder(order)) {
      const testAmount = order.bestRate
        ? (toNumberValue(order.bestRate.shipmentCost) ?? 0) + (toNumberValue(order.bestRate.otherCost) ?? 0)
        : 0
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="carrier-badge" style={{ fontSize: 9.5, padding: '1px 5px', background: '#f59e0b', color: '#fff' }}>
            TEST
          </span>
          <strong style={{ color: 'var(--green)', fontSize: 12 }}>{formatMoney(testAmount)}</strong>
        </div>
      )
    }

    const bestRateBaseCost = getBestRateBaseCost(order)
    if (order.orderStatus !== 'awaiting_shipment') {
      if (getIsExternallyFulfilled(order)) {
        return renderExtLabelBadge()
      }

      const selectedRateBase = getSelectedRateBaseCost(order)
      const labelCost = getSelectedRateFinalCost(order)
      if (selectedRateBase == null && labelCost == null) {
        return <span style={{ color: 'var(--text3)', fontSize: 11 }}>—</span>
      }

      const selectedRateCarrierCode = getSelectedRateCarrierCode(order)
      // Apply the same markup the awaiting-shipment column uses, so shipped
      // rows show what the customer was charged (base + markup) — not just
      // the raw carrier label cost. Falls back to labelCost / selectedRateBase
      // when carrier metadata isn't enough to look up a markup rule.
      const baseForMarkup = selectedRateBase ?? labelCost ?? 0
      const selectedMarkedAmount = applyCarrierMarkup(
        {
          shippingProviderId: getSelectedRateShippingProviderId(order),
          carrierCode: selectedRateCarrierCode ?? '',
          serviceCode: getSelectedRateServiceCode(order) ?? '',
          serviceName: order.selectedRate?.serviceName ?? '',
          amount: baseForMarkup,
          shipmentCost: baseForMarkup,
          otherCost: 0,
          carrierNickname: getSelectedRateCarrierNickname(order),
        },
        markups,
      )
      const displayMarked =
        selectedMarkedAmount != null
          ? selectedMarkedAmount
          : labelCost ?? selectedRateBase
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {selectedRateCarrierCode ? (
            <span className={`carrier-badge ${getCarrierClass(selectedRateCarrierCode)}`} style={{ fontSize: 9.5, padding: '1px 5px' }}>
              {formatCarrierCode(selectedRateCarrierCode)}
            </span>
          ) : null}
          {renderRateAmountWithMarkup(selectedRateBase, displayMarked)}
        </div>
      )
    }

    const hasDims = getDimensions(order, null) != null
    if (!(order.weight?.value && order.weight.value > 0) || !hasDims) {
      return <span style={{ fontSize: 10.5, color: 'var(--text3)' }}>— add dims</span>
    }
    if (!order.bestRate) {
      return <div className="spin-center"><span className="spin-sm" /></div>
    }
    if (bestRateBaseCost == null) {
      return <span style={{ color: 'var(--text3)', fontSize: 11 }}>—</span>
    }

    const markedAmount = applyCarrierMarkup({
      shippingProviderId: getBestRateShippingProviderId(order),
      carrierCode: order.bestRate.carrierCode ?? '',
      serviceCode: getBestRateServiceCode(order) ?? '',
      serviceName: order.bestRate.serviceName ?? '',
      amount: bestRateBaseCost ?? 0,
      shipmentCost: bestRateBaseCost ?? undefined,
      otherCost: 0,
      carrierNickname: getBestRateCarrierNickname(order),
    }, markups)

    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className={`carrier-badge ${getCarrierClass(order.bestRate.carrierCode)}`} style={{ fontSize: 9.5, padding: '1px 5px' }}>
          {formatCarrierCode(order.bestRate.carrierCode)}
        </span>
        {renderRateAmountWithMarkup(bestRateBaseCost, markedAmount)}
      </div>
    )
  }

  const renderMargin = (order: OrderSummaryDto) => {
    if (isTestOrder(order)) {
      return <span style={{ color: 'var(--text4)', fontSize: 11 }}>{'\u2014'}</span>
    }

    if (order.orderStatus !== 'awaiting_shipment') {
      return <span style={{ color: 'var(--text4)', fontSize: 11 }}>{'\u2014'}</span>
    }

    const bestRateBaseCost = getBestRateBaseCost(order)
    if (!order.bestRate || bestRateBaseCost == null) {
      return order.weight?.value && getDimensions(order, null) ? (
        <div className="spin-center"><span className="spin-sm" /></div>
      ) : (
        <span style={{ color: 'var(--text4)', fontSize: 11 }}>—</span>
      )
    }

    const markedAmount = applyCarrierMarkup({
      shippingProviderId: getBestRateShippingProviderId(order),
      carrierCode: order.bestRate.carrierCode ?? '',
      serviceCode: getBestRateServiceCode(order) ?? '',
      serviceName: order.bestRate.serviceName ?? '',
      amount: bestRateBaseCost,
      shipmentCost: bestRateBaseCost,
      otherCost: 0,
      carrierNickname: getBestRateCarrierNickname(order),
    }, markups)
    const diff = getMarkupAmount(bestRateBaseCost, markedAmount)
    if (diff <= 0.005) return <span style={{ color: 'var(--text4)', fontSize: 11 }}>—</span>

    const percent = bestRateBaseCost > 0 ? Math.round((diff / bestRateBaseCost) * 100) : 0

    return (
      <div style={{ lineHeight: 1.3, textAlign: 'left' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#16a34a' }}>+{formatMoney(diff)}</div>
        <div style={{ fontSize: 10, color: 'var(--text3)' }}>{percent}%</div>
      </div>
    )
  }

  const renderCarrierCell = (order: OrderSummaryDto) => {
    if (isTestOrder(order)) {
      return (
        <span
          className="carrier-badge"
          style={{ background: '#f59e0b', color: '#fff' }}
          title="Test order: mock carrier only, no real postage"
        >
          TEST
        </span>
      )
    }

    const shipped = order.orderStatus !== 'awaiting_shipment'
    if (shipped) {
      if (shouldShowCarrierExtLabel(order)) {
        return renderExtLabelBadge()
      }

      const carrierCode = getShippedDisplayCarrierCode(order)
      if (!carrierCode) {
        return <span style={{ color: 'var(--text4)', fontSize: 11 }}>{'\u2014'}</span>
      }

      return (
        <div style={{ display: 'flex', alignItems: 'center', lineHeight: 1.3 }}>
          <span className={`carrier-badge ${getCarrierClass(carrierCode)}`}>{formatCarrierCode(carrierCode)}</span>
        </div>
      )
    }

    const hasDims = getDimensions(order, null) != null
    if (!(order.weight?.value && order.weight.value > 0) || !hasDims) {
      return <span style={{ fontSize: 10.5, color: 'var(--text3)' }}>— add dims</span>
    }
    if (!order.bestRate) {
      return <div className="spin-center"><span className="spin-sm" /></div>
    }

    return (
      <div style={{ display: 'flex', alignItems: 'center', lineHeight: 1.3 }}>
        <span className={`carrier-badge ${getCarrierClass(getCarrierCodeForDisplay(order))}`}>{formatCarrierCode(getCarrierCodeForDisplay(order))}</span>
      </div>
    )
  }

  const renderShippingAccountCell = (order: OrderSummaryDto) => {
    if (isTestOrder(order)) {
      const testAccount = normalizeShippingAccountName(order.bestRate?.carrierNickname) ?? TEST_SHIPPING_ACCOUNT_LABEL
      return (
        <div style={{ lineHeight: 1.4, whiteSpace: 'nowrap' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#b45309' }}>{testAccount}</div>
          <div style={{ fontSize: 10, color: 'var(--text3)' }} className="svc-label">
            test mock - no real postage
          </div>
        </div>
      )
    }

    const shipped = order.orderStatus !== 'awaiting_shipment'
    if (shipped) {
      if (getIsExternallyFulfilled(order)) {
        return renderExtLabelBadge()
      }

      const accountDisplay = getShipAccountDisplay(order, shippingAccounts)
      if (!accountDisplay) {
        return <span style={{ color: 'var(--text4)', fontSize: 11 }}>{'\u2014'}</span>
      }

      return (
        <div style={{ lineHeight: 1.4, whiteSpace: 'nowrap' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text2)' }}>{accountDisplay}</div>
          <div style={{ fontSize: 10, color: 'var(--text3)' }} className="svc-label">
            {truncate(formatServiceCode(getShippedDisplayServiceCode(order)), 22)}
          </div>
        </div>
      )
    }

    const hasDims = getDimensions(order, null) != null
    if (!(order.weight?.value && order.weight.value > 0) || !hasDims) {
      return <span style={{ fontSize: 10.5, color: 'var(--text3)' }}>— add dims</span>
    }
    if (!order.bestRate) {
      return <div className="spin-center"><span className="spin-sm" /></div>
    }

    return (
        <div style={{ lineHeight: 1.4, whiteSpace: 'nowrap' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text2)' }}>{getShipAccountDisplay(order, shippingAccounts)}</div>
          <div style={{ fontSize: 10, color: 'var(--text3)' }} className="svc-label">
            {truncate(formatServiceCode(getBestRateServiceCode(order)), 22)}
          </div>
        </div>
      )
  }

  const renderOrderCell = (order: OrderSummaryDto) => {
    const testOrder = isTestOrder(order, orderDetailsById.get(order.orderId) ?? null)
    const isShipping = transitionalShippedIds.has(order.orderId)
    return (
    <div className="order-num" style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, minWidth: 0 }}>
      {testOrder && (
        <span
          title="Sandbox / test order — no real postage, billing, or inventory impact"
          style={{
            display: 'inline-block',
            padding: '1px 6px',
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: 0.5,
            color: '#fff',
            background: '#d97706',
            borderRadius: 3,
            flexShrink: 0,
          }}
        >
          TEST
        </span>
      )}
      {/* Shipping-in-progress pill — only renders during the 30 s
          fade transition (Create + Print Label flow). Animated truck
          icon + pulsing background give the operator a clear,
          persistent signal that the order is in flight to Shipped.
          See .ps-shipping-pill in app-shell.css for the styles. */}
      {isShipping && (
        <span className="ps-shipping-pill" title="Order is being shipped — will move to Shipped in 30 seconds">
          <Truck size={9} strokeWidth={2.5} />
          Shipping…
        </span>
      )}
      <span
        className="od-order-link"
        title="Open order detail"
        style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: 'pointer', color: 'var(--ss-blue)' }}
        onClick={(event) => {
          event.stopPropagation()
          openDetailDrawer(order.orderId ?? null)
        }}
      >
        {order.orderNumber ?? `#${order.orderId}`}
      </span>
      <span
        title="Copy"
        style={{ cursor: 'pointer', color: 'var(--text4)', fontSize: 9, opacity: 0.6, transition: 'opacity .1s', flexShrink: 0 }}
        onClick={(event) => {
          event.stopPropagation()
          copyText(order.orderNumber ?? String(order.orderId))
        }}
        onMouseEnter={(event) => {
          event.currentTarget.style.opacity = '1'
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.opacity = '0.6'
        }}
      >
        ⎘
      </span>
    </div>
    )
  }

  const renderDiagnosticCell = (
    value: unknown,
    options: {
      fontSize?: number
      maxWidth?: number
      title?: string
      align?: 'left' | 'center'
      monospace?: boolean
      muted?: boolean
      surface?: boolean
    } = {},
  ) => {
    const display = value == null || value === '' ? '—' : String(value)
    const surface = options.surface ?? !options.muted

    return (
      <span
        style={{
          display: 'block',
          fontSize: options.fontSize ?? 14,
          textAlign: options.align ?? 'left',
          fontFamily: options.monospace ? 'monospace' : undefined,
          color: options.muted ? 'var(--text3)' : 'var(--text2)',
          background: surface ? 'var(--surface2)' : undefined,
          padding: surface ? '4px 6px' : undefined,
          borderRadius: surface ? 3 : undefined,
          maxWidth: options.maxWidth,
          overflow: options.maxWidth ? 'hidden' : undefined,
          textOverflow: options.maxWidth ? 'ellipsis' : undefined,
          whiteSpace: options.maxWidth ? 'nowrap' : undefined,
        }}
        title={options.title ?? display}
      >
        {display}
      </span>
    )
  }

  const renderTableCell = (order: OrderSummaryDto, column: TableColumn) => {
    const detail = orderDetailsById.get(order.orderId) ?? null
    const items = getActiveItems(order, detail)
    const mergedItems = getMergedItems(order, detail)
    // When the SKU filter is active, the row's "primary" displayed
    // item should be the one matching the filter — not just whatever
    // happens to be first in the array. Without this swap, an order
    // matching the filter via a non-first item would display the
    // unrelated first item, making the filter LOOK broken even when
    // it correctly narrowed the result set.
    //
    // Normalized (trim + lowercase) compare matches the searchedOrders
    // memo above, so the row display is consistent with the filter
    // gate — both treat 'B-6' / 'b-6 ' / ' B-6' as the same SKU.
    const skuNeedleForRow = skuFilter.trim().toLowerCase()
    const primaryItem = (skuNeedleForRow
      ? items.find((item) => (item.sku ?? '').trim().toLowerCase() === skuNeedleForRow)
      : items[0]) ?? items[0] ?? null
    const multiSku = new Set(items.map((item) => item.sku).filter(Boolean)).size > 1
    const expedited = getExpeditedBadge(order, detail)
    const shipTo = getShipTo(order, detail)
    const clientName = order.clientName ?? 'Untagged'
    const clientPalette = getClientPalette(clientName)
    const diagnosticIsShipped = order.orderStatus !== 'awaiting_shipment'
    const diagnosticIsCancelled = order.orderStatus === 'cancelled'
    const diagnosticIsExternalLabel = shouldShowCarrierExtLabel(order)

    switch (column.key) {
      case 'select':
        // Lockdown — no row selection on Shipped / Cancelled. Cell
        // renders empty so the column still reserves its width but no
        // checkbox is interactive.
        if (isReadOnly) return null
        return (
          <input
            type="checkbox"
            checked={selectedIdSet.has(order.orderId)}
            onMouseDown={(event) => {
              shiftHeldOnMouseDownRef.current = event.shiftKey
            }}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => {
              event.stopPropagation()
              const wasShift = shiftHeldOnMouseDownRef.current
              shiftHeldOnMouseDownRef.current = false
              const anchor = lastSelectionAnchorRef.current
              if (wasShift && anchor != null && anchor !== order.orderId) {
                selectOrderRange(anchor, order.orderId)
                return
              }
              lastSelectionAnchorRef.current = order.orderId
              toggleOrderSelection(order.orderId, event.target.checked)
            }}
            aria-label={`Select ${order.orderNumber ?? order.orderId}. Shift+click to select a range.`}
            title="Tip: Shift+click another checkbox to select a range"
          />
        )
      case 'date':
        return (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {expedited ? <div style={{ fontSize: 9.5, fontWeight: 700, color: expedited.color, marginBottom: 2 }}>{expedited.label}</div> : null}
            <div style={{ fontSize: 11.5, color: 'var(--text2)', whiteSpace: 'nowrap' }}>{formatDateTime(order.orderDate)}</div>
          </div>
        )
      case 'client':
        return (
          <span
            className="client-badge"
            style={{ background: clientPalette.bg, color: clientPalette.color, borderColor: clientPalette.border }}
          >
            {truncate(clientName, 14)}
          </span>
        )
      case 'orderNum':
        return renderOrderCell(order)
      case 'customer': {
        // Tiny "Assigned to" badge under the customer name. Only renders when
        // the order has an assignee — keeps the cell quiet for unassigned
        // rows. Uses the email's local-part (before @) so it stays narrow.
        const assignedEmail = toStringValue(order.assignedToEmail)
        const assignedLocal = assignedEmail ? assignedEmail.split('@')[0] : null
        return (
          <div>
            <div className="customer-name">{shipTo.name ?? '—'}</div>
            {assignedLocal ? (
              <div
                title={`Assigned to ${assignedEmail}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 3,
                  marginTop: 2,
                  fontSize: 9.5,
                  fontWeight: 700,
                  color: '#6d28d9',
                  background: 'rgba(124, 58, 237, .12)',
                  padding: '1px 6px',
                  borderRadius: 999,
                  lineHeight: 1.4,
                  maxWidth: '100%',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                <span aria-hidden="true">👤</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{assignedLocal}</span>
              </div>
            ) : null}
          </div>
        )
      }
      case 'itemname':
        if (multiSku) {
          const visibleItems = mergedItems.slice(0, 5)
          const overflow = mergedItems.length - visibleItems.length
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '3px 0', maxWidth: column.width + 90, overflow: 'hidden' }}>
              {visibleItems.map((item) => (
                <div key={`${item.sku ?? 'unknown'}-${item.name ?? 'item'}`} style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                  <HoverImage
                    src={item.imageUrl}
                    alt={item.name ?? ''}
                    size={22}
                    radius={3}
                    title={item.name ?? ''}
                    fallback={
                      <span style={{ width: 22, height: 22, flexShrink: 0, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 3, display: 'inline-block' }} />
                    }
                  />
                  <span style={{ display: 'flex', alignItems: 'center', gap: 3, flex: 1, minWidth: 0, overflow: 'hidden' }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5, minWidth: 0 }}>
                      {item.name ?? item.sku ?? '—'}
                    </span>
                    {item.quantity > 1 ? (
                      <span style={{ background: 'var(--ss-blue-bg)', color: 'var(--ss-blue)', fontSize: 9.5, fontWeight: 700, padding: '0 4px', borderRadius: 3, flexShrink: 0 }}>
                        ×{item.quantity}
                      </span>
                    ) : null}
                  </span>
                </div>
              ))}
              {overflow > 0 ? <div style={{ fontSize: 10.5, color: 'var(--text3)', paddingLeft: 27 }}>+{overflow} more</div> : null}
            </div>
          )
        }
        return (
          <div className="cell-itemname" title={primaryItem?.name ?? '—'} style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden', whiteSpace: 'nowrap', maxWidth: column.width + 90 }}>
            <HoverImage
              src={primaryItem?.imageUrl ?? null}
              alt={primaryItem?.name ?? ''}
              size={28}
              radius={4}
              title={primaryItem?.name ?? ''}
            />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {primaryItem?.name ?? '—'}
              {items.length > 1 && !multiSku ? <span style={{ color: 'var(--text3)', fontSize: 10.5 }}> ×{getTotalQuantity(order, detail)}</span> : null}
            </span>
          </div>
        )
      case 'sku':
        if (multiSku) {
          const visibleItems = mergedItems.slice(0, 5)
          const overflow = mergedItems.length - visibleItems.length
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '3px 0' }}>
              {visibleItems.map((item) => (
                <div key={`${item.sku ?? 'unknown'}-${item.name ?? 'item'}`} style={{ display: 'flex', alignItems: 'center', height: 22, gap: 3, minWidth: 0 }}>
                  {item.sku ? <span className="sku-link" style={{ fontSize: 11 }} title={item.sku}>{item.sku}</span> : <span style={{ color: 'var(--text4)', fontSize: 11 }}>—</span>}
                </div>
              ))}
              {overflow > 0 ? <div style={{ height: 14 }} /> : null}
            </div>
          )
        }
        return primaryItem?.sku ? <span className="sku-link" title={primaryItem.sku}>{primaryItem.sku}</span> : '—'
      case 'qty': {
        const totalQuantity = getTotalQuantity(order, detail)
        return (
          <div style={{ textAlign: 'left', fontWeight: 700, color: 'var(--text2)' }}>
            {totalQuantity > 1 ? (
              <span style={{ display: 'inline-block', padding: '1px 6px', border: '2px solid var(--red)', borderRadius: 4, color: 'var(--red)' }}>{totalQuantity}</span>
            ) : (
              totalQuantity || '—'
            )}
          </div>
        )
      }
      case 'weight':
        if (isTestOrder(order, detail)) {
          const weightOz = getOrderWeightOz(order, detail)
          return weightOz ? <span style={{ fontSize: 12, color: 'var(--text2)' }}>{formatWeight(weightOz)}</span> : <span style={{ color: 'var(--text3)', fontSize: 12 }}>—</span>
        }
        return order.weight?.value ? <span style={{ fontSize: 12, color: 'var(--text2)' }}>{formatWeight(order.weight.value)}</span> : <span style={{ color: 'var(--text3)', fontSize: 12 }}>—</span>
      case 'shipto':
        return <span style={{ fontSize: 11.5, color: 'var(--text2)' }}>{getShipToLine(order, detail)}</span>
      case 'carrier':
        return renderCarrierCell(order)
      case 'custcarrier':
        return renderShippingAccountCell(order)
      case 'total':
        return <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{formatMoney(order.orderTotal ?? 0)}</span>
      case 'bestrate':
        return renderBestRatePrice(order)
      case 'margin':
        return renderMargin(order)
      case 'tracking':
        {
        const trackingNumber = toStringValue(order.label?.trackingNumber)
        if (!trackingNumber) {
          return <span style={{ color: 'var(--text4)', fontFamily: 'monospace', fontSize: 11 }}>—</span>
        }
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontFamily: 'monospace' }}>
            <span
              style={{ color: 'var(--ss-blue)', cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted' }}
              onClick={(event) => {
                event.stopPropagation()
                setTrackingModal({
                  tracking: trackingNumber,
                  carrierCode: toStringValue(order.label?.carrierCode) ?? toStringValue(order.bestRate?.carrierCode) ?? toStringValue(order.carrierCode),
                })
              }}
              title="Track package"
            >
              {trackingNumber}
            </span>
            <span
              onClick={(event) => {
                event.stopPropagation()
                copyText(trackingNumber)
              }}
              style={{ cursor: 'pointer', color: 'var(--text4)', fontSize: 9, opacity: 0.6 }}
              title="Copy tracking number"
              onMouseEnter={(event) => { event.currentTarget.style.opacity = '1' }}
              onMouseLeave={(event) => { event.currentTarget.style.opacity = '0.6' }}
            >
              ⎘
            </span>
          </span>
        )
        }
      case 'labelcreated':
        return (
          <span style={{ fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap' }}>
            {formatLabelCreated(order.label?.createdAt ?? null)}
          </span>
        )
      case 'age': {
        const ageColor = getAgeColor(order.orderDate)
        return (
          <div className="age-wrap">
            <span className="age-dot" style={{ background: ageColor }} />
            <span style={{ fontSize: 11, color: ageColor === 'var(--green)' ? 'var(--text3)' : ageColor }}>{ageLabel(order.orderDate)}</span>
          </div>
        )
      }
      case 'test_carrierCode': {
        if (diagnosticIsExternalLabel && !diagnosticIsCancelled) return renderDiagnosticCell(null, { monospace: true })
        const value = diagnosticIsShipped
          ? diagnosticIsCancelled
            ? getCancelledDisplayCarrierCode(order)
            : getShippedDisplayCarrierCode(order)
          : order.bestRate
            ? toStringValue(order.bestRate?.carrierCode)
            : null
        return renderDiagnosticCell(value, { monospace: true })
      }
      case 'test_shippingProviderID': {
        if (diagnosticIsExternalLabel && !diagnosticIsCancelled) return renderDiagnosticCell(null, { monospace: true })
        const value = diagnosticIsShipped
          ? diagnosticIsCancelled
            ? getCancelledDisplayProviderId(order)
            : getShippedDisplayProviderId(order)
          : toProviderAccountId(order.bestRate?.shippingProviderId)
        return renderDiagnosticCell(value, { monospace: true })
      }
      case 'test_clientID':
        return renderDiagnosticCell(getLegacyClientIdForDisplay(order), { monospace: true })
      case 'test_serviceCode': {
        if (diagnosticIsExternalLabel && !diagnosticIsCancelled) {
          return renderDiagnosticCell(null, {
            fontSize: 10,
            maxWidth: column.width,
            monospace: true,
          })
        }
        const value = diagnosticIsShipped
          ? diagnosticIsCancelled
            ? getCancelledDisplayServiceCode(order)
            : getShippedDisplayServiceCode(order)
          : toStringValue(order.bestRate?.serviceCode)
        return renderDiagnosticCell(value, {
          fontSize: 10,
          maxWidth: column.width,
          monospace: true,
        })
      }
      case 'test_bestRate': {
        if (diagnosticIsExternalLabel) return renderDiagnosticCell(null, { fontSize: 10, muted: true, surface: false })
        const bestRate = order.bestRate
        if (!bestRate) return renderDiagnosticCell(null, { fontSize: 10, muted: true, surface: false })

        const rateRecord = toRecord(bestRate) ?? {}
        const shipmentCost = typeof rateRecord.shipmentCost === 'number' ? rateRecord.shipmentCost : 0
        const otherCost = typeof rateRecord.otherCost === 'number' ? rateRecord.otherCost : 0
        const amount = shipmentCost + otherCost
        const carrierCode = toStringValue(rateRecord.carrierCode) ?? '?'
        const serviceCode = toStringValue(rateRecord.serviceCode) ?? '?'
        const display = `${carrierCode}|${serviceCode}|$${amount.toFixed(2)}`

        return renderDiagnosticCell(display, {
          fontSize: 9,
          maxWidth: column.width,
          monospace: true,
          title: JSON.stringify(bestRate),
        })
      }
      case 'test_orderLocal': {
        if (diagnosticIsExternalLabel) {
          return renderDiagnosticCell(null, {
            fontSize: 9,
            maxWidth: column.width,
          })
        }
        const parts: string[] = []
        if (order.weight?.value && order.weight.value > 0) {
          parts.push(`w:${order.weight.value}${order.weight.units?.[0] || 'oz'}`)
        }
        if (order.label?.trackingNumber) parts.push('track:yes')
        if (order.bestRate) parts.push('best:yes')

        const display = parts.length ? parts.join(' ') : null
        return renderDiagnosticCell(display, {
          fontSize: 9,
          maxWidth: column.width,
          title: display ?? '—',
        })
      }
      case 'test_shippingAccount': {
        if (diagnosticIsExternalLabel && !diagnosticIsCancelled) return renderDiagnosticCell(null)
        const value = diagnosticIsShipped
          ? diagnosticIsCancelled
            ? getCancelledDisplayAccountNickname(order)
            : getShippedDisplayAccountNickname(order)
          : getAwaitingDisplayAccountNickname(order)
        return renderDiagnosticCell(value)
      }
    }
  }

  const renderBatchPanel = () => {
    // Lockdown — Shipped / Cancelled views never show the batch panel
    // since selection itself is disabled (no orderIds can be in
    // selectedOrderIds). Returning null here is a belt-and-suspenders
    // safeguard against any future bug that re-enables selection.
    if (isReadOnly) return null

    const selectedOrders = orders.filter((order) => selectedIdSet.has(order.orderId))
    const firstOrder = selectedOrders[0] ?? null
    const firstDims = firstOrder ? getDimensions(firstOrder, null) : null
    const firstWeight = firstOrder?.weight?.value ?? 0
    const firstWeightLb = Math.floor(firstWeight / 16)
    const firstWeightOz = Math.round(firstWeight % 16)

    return (
      <>
        <div className="panel-topbar">
          <button className="panel-topbar-btn" type="button" onClick={clearSelection}>Clear Selection</button>
          <div className="panel-ordnum">📦 {selectedOrderIds.length} order{selectedOrderIds.length === 1 ? '' : 's'} selected</div>
          {/* Batch Mark-as-Shipped — placed in the topbar to mirror the
              single-order panel (which has the same affordance in the
              same spot under the AWAITING / TEST badges). Operators
              learn one place to find this action regardless of
              single-vs-multi mode. Only shown on awaiting view since
              shipped/cancelled orders aren't editable. */}
          {currentStatus === 'awaiting_shipment' ? (
            <div className="ml-auto relative mr-2">
              <button
                type="button"
                onClick={() => setBatchExtShipMenuOpen((open) => !open)}
                disabled={extShipBusy || selectedOrderIds.length === 0}
                title="Mark every selected order as shipped externally (no label purchase)"
                className="inline-flex items-center gap-1 h-6 px-2 rounded-md text-[10.5px] font-semibold text-amber-800 bg-amber-50/80 ring-1 ring-amber-200 hover:bg-amber-100 hover:ring-amber-300 transition disabled:opacity-50 disabled:cursor-wait"
              >
                <BadgeCheck size={10} strokeWidth={2.5} />
                {extShipBusy
                  ? `Marking ${selectedOrderIds.length}…`
                  : `Mark ${selectedOrderIds.length} as Shipped`}
                <ChevronDown size={8} strokeWidth={2.5} className="opacity-60" />
              </button>
              {batchExtShipMenuOpen ? (
                <div className="absolute top-[calc(100%+4px)] right-0 z-30 w-[260px] rounded-lg bg-surface ring-1 ring-line shadow-lg overflow-hidden text-[12px]">
                  <div className="px-3 py-2 bg-surface-2 border-b border-line">
                    <div className="font-semibold text-ink text-[12px]">
                      Mark {selectedOrderIds.length} order{selectedOrderIds.length === 1 ? '' : 's'} as Shipped
                    </div>
                    <div className="text-ink-3 text-[10.5px] mt-0.5">
                      Closes the orders locally. Optional notify:
                    </div>
                  </div>

                  {/* Notify Customer toggle — shared state with single popover */}
                  <label className="flex items-center justify-between gap-2 px-3 py-2 hover:bg-surface-2 cursor-pointer">
                    <div className="flex flex-col">
                      <span className="font-medium text-ink-2 text-[11.5px]">Notify customer</span>
                      <span className="text-ink-3 text-[10px]">Email shipping confirmation via ShipStation</span>
                    </div>
                    <span
                      className={`relative inline-flex w-8 h-4 rounded-full transition-colors duration-150 flex-shrink-0 ${extShipNotifyCustomer ? 'bg-emerald-500' : 'bg-line'}`}
                      aria-hidden
                    >
                      <span
                        className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-transform duration-150 ${extShipNotifyCustomer ? 'translate-x-[18px]' : 'translate-x-0.5'}`}
                        aria-hidden
                      />
                    </span>
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={extShipNotifyCustomer}
                      onChange={(e) => setExtShipNotifyCustomer(e.target.checked)}
                    />
                  </label>

                  <label className="flex items-center justify-between gap-2 px-3 py-2 hover:bg-surface-2 cursor-pointer border-b border-line">
                    <div className="flex flex-col">
                      <span className="font-medium text-ink-2 text-[11.5px]">Notify marketplace</span>
                      <span className="text-ink-3 text-[10px]">Push shipped status to Amazon/eBay/etc.</span>
                    </div>
                    <span
                      className={`relative inline-flex w-8 h-4 rounded-full transition-colors duration-150 flex-shrink-0 ${extShipNotifyMarketplace ? 'bg-emerald-500' : 'bg-line'}`}
                      aria-hidden
                    >
                      <span
                        className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-transform duration-150 ${extShipNotifyMarketplace ? 'translate-x-[18px]' : 'translate-x-0.5'}`}
                        aria-hidden
                      />
                    </span>
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={extShipNotifyMarketplace}
                      onChange={(e) => setExtShipNotifyMarketplace(e.target.checked)}
                    />
                  </label>

                  {(extShipNotifyCustomer || extShipNotifyMarketplace) ? (
                    <div className="px-3 py-1.5 bg-amber-50 border-b border-line text-[10px] text-amber-700 flex items-start gap-1">
                      <span aria-hidden>⚠</span>
                      <span>Batch mode sends notifications without tracking numbers (use single-order popover if you have tracking).</span>
                    </div>
                  ) : null}

                  <div className="px-2 py-1.5">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-3 px-1 pb-1">
                      Source marketplace
                    </div>
                    {['Shopify', 'Amazon', 'Walmart', 'eBay', 'Etsy', 'Other'].map((source) => (
                      <button
                        key={source}
                        type="button"
                        disabled={extShipBusy}
                        className="w-full text-left px-2 py-1.5 rounded text-ink-2 hover:text-ink hover:bg-surface-2 transition disabled:opacity-50 disabled:cursor-wait text-[11.5px]"
                        onClick={() => void handleBatchMarkAsShipped(source)}
                      >
                        {extShipBusy ? `Working… (${source})` : source}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          <button className="panel-close" type="button" onClick={clearSelection}>✕</button>
        </div>

        <div className="panel-body">
          <div className="panel-section">
            <div className="panel-section-header">
              <span className="panel-section-title">Batch Actions</span>
            </div>
            <div className="panel-section-body">
              {/* Selected-orders pill list. Replaces the previous wordBreak:
                  break-all comma-soup which was illegible at >5 orders. Each
                  order# is its own monospace pill in a scrollable tray; click
                  to copy that ID, or use "Copy all" in the header for the
                  whole list joined by newlines (paste-friendly for tickets). */}
              <div className="px-3 pt-3 pb-3 -mx-3 mb-3 border-b border-line">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">
                      Selected
                    </span>
                    <span className="inline-flex items-center justify-center min-w-[20px] h-[18px] px-1.5 rounded-full bg-brand/10 text-brand text-[10.5px] font-bold tabular-nums ring-1 ring-brand/20">
                      {selectedOrders.length}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const all = selectedOrders
                        .map((o) => o.orderNumber ?? `#${o.orderId}`)
                        .sort()
                        .join('\n')
                      void navigator.clipboard.writeText(all).then(() => {
                        setCopiedAll(true)
                        window.setTimeout(() => setCopiedAll(false), 1200)
                      })
                    }}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10.5px] font-semibold text-ink-2 hover:text-brand bg-surface-2 hover:bg-brand/5 ring-1 ring-line hover:ring-brand/30 transition"
                    title="Copy all order numbers to clipboard (newline-separated)"
                  >
                    <AnimatePresence mode="wait" initial={false}>
                      {copiedAll ? (
                        <motion.span
                          key="copied"
                          initial={{ scale: 0.6, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          exit={{ scale: 0.6, opacity: 0 }}
                          transition={{ duration: 0.18 }}
                          className="inline-flex items-center gap-1 text-emerald-600"
                        >
                          <CheckIcon size={11} strokeWidth={3} />
                          Copied
                        </motion.span>
                      ) : (
                        <motion.span
                          key="copy"
                          initial={{ scale: 0.6, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          exit={{ scale: 0.6, opacity: 0 }}
                          transition={{ duration: 0.18 }}
                          className="inline-flex items-center gap-1"
                        >
                          <CopyIcon size={11} strokeWidth={2.5} />
                          Copy all
                        </motion.span>
                      )}
                    </AnimatePresence>
                  </button>
                </div>
                {/* Scrollable pill tray. max-height fits ~4-5 rows of pills
                    before scroll kicks in; far fewer cognitive bumps than
                    word-broken IDs spilling across full width. Empty-state
                    safety net even though parent only renders this section
                    when selection > 0. */}
                <div
                  className="flex flex-wrap gap-1.5 max-h-[148px] overflow-y-auto pr-0.5"
                  role="list"
                  aria-label={`${selectedOrders.length} selected orders`}
                >
                  {selectedOrders.length === 0 ? (
                    <span className="text-[11px] italic text-ink-3 py-1">No orders selected</span>
                  ) : (
                    selectedOrders
                      .map((o) => o.orderNumber ?? `#${o.orderId}`)
                      .sort()
                      .map((orderNum) => {
                        const wasCopied = copiedOrderNum === orderNum
                        return (
                          <button
                            key={orderNum}
                            type="button"
                            role="listitem"
                            onClick={() => {
                              void navigator.clipboard.writeText(orderNum).then(() => {
                                setCopiedOrderNum(orderNum)
                                window.setTimeout(() => {
                                  setCopiedOrderNum((current) => (current === orderNum ? null : current))
                                }, 1100)
                              })
                            }}
                            title={`Click to copy ${orderNum}`}
                            className={`group/pill inline-flex items-center gap-1 px-2 py-1 rounded-md font-mono text-[10.5px] font-semibold tabular-nums ring-1 transition ${
                              wasCopied
                                ? 'bg-emerald-50 text-emerald-700 ring-emerald-300 shadow-sm'
                                : 'bg-surface-2 text-ink-2 ring-line hover:ring-brand/40 hover:bg-brand/5 hover:text-brand'
                            }`}
                          >
                            <span className="truncate max-w-[180px]">{orderNum}</span>
                            <AnimatePresence mode="wait" initial={false}>
                              {wasCopied ? (
                                <motion.span
                                  key="check"
                                  initial={{ scale: 0, rotate: -90 }}
                                  animate={{ scale: 1, rotate: 0 }}
                                  exit={{ scale: 0, rotate: 90 }}
                                  transition={{ duration: 0.18 }}
                                  className="inline-flex"
                                >
                                  <CheckIcon size={10} strokeWidth={3} />
                                </motion.span>
                              ) : (
                                <motion.span
                                  key="copy"
                                  initial={{ scale: 0, opacity: 0 }}
                                  animate={{ scale: 1, opacity: 1 }}
                                  exit={{ scale: 0, opacity: 0 }}
                                  transition={{ duration: 0.18 }}
                                  className="inline-flex opacity-0 group-hover/pill:opacity-100 transition-opacity"
                                >
                                  <CopyIcon size={10} strokeWidth={2.5} />
                                </motion.span>
                              )}
                            </AnimatePresence>
                          </button>
                        )
                      })
                  )}
                </div>
              </div>

              {/* Label-creation actions only on awaiting_shipment view.
                  Shipped/Cancelled views show a read-only banner instead —
                  these orders already have labels or were cancelled, and
                  the backend would reject any modify call via
                  assertOrderEditable() anyway. Showing the buttons disabled
                  trains operators to feel locked-out when the action is
                  genuinely inapplicable; hiding them with an explanatory
                  banner is clearer. The selected-orders pill tray + Copy
                  All actions above remain available — those are read-only
                  and useful for any view (audit, export, ticket triage).
              */}
              {currentStatus === 'awaiting_shipment' ? (
                <>
                  {/* Both buttons share the SAME brand-blue style. The
                      previous green Send-to-Queue created a visual
                      hierarchy that wasn't real — both actions are
                      equally important. The Mark-as-Shipped action
                      lives in the panel topbar (matching single-order
                      placement), not down here. */}
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <button
                      className="create-label-btn"
                      type="button"
                      style={{ flex: 1 }}
                      onClick={() => void handleBatchAction('print')}
                      disabled={batchBusy}
                    >
                      🖨️ Create + Print Label
                    </button>
                    <button
                      className="create-label-btn"
                      type="button"
                      style={{ flex: 1 }}
                      onClick={() => void handleBatchAction('queue')}
                      disabled={batchBusy}
                    >
                      📥 Send to Queue
                    </button>
                  </div>

                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 12, fontWeight: 600 }}>
                    <input type="checkbox" checked={batchTestMode} onChange={(event) => setBatchTestMode(event.target.checked)} />
                    🧪 Test mode (no charges)
                  </label>
                </>
              ) : (
                <div className="rounded-lg bg-surface-2 ring-1 ring-line p-3 text-[11.5px] text-ink-2 leading-relaxed">
                  <div className="flex items-center gap-1.5 mb-1 font-semibold text-ink">
                    <CheckIcon size={12} strokeWidth={2.5} className="text-ok" />
                    {currentStatus === 'shipped' ? 'Shipped orders' : 'Cancelled orders'} — read only
                  </div>
                  <p className="text-ink-3">
                    {currentStatus === 'shipped'
                      ? 'These orders already have labels. To reprint, open an individual order and use the Print menu in the side panel.'
                      : 'These orders were cancelled and cannot have labels created.'}
                    {' '}Selection is enabled for copy/export only.
                  </p>
                </div>
              )}

              {callerIsAdmin ? (
                <div style={{ marginTop: 16, padding: 12, background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6 }}>
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 8, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    👤 Assign Orders
                  </div>
                  <select
                    style={{
                      width: '100%',
                      fontSize: 13,
                      padding: '8px 10px',
                      border: '1px solid var(--border2)',
                      borderRadius: 4,
                      background: 'var(--surface)',
                      color: 'var(--text)',
                      cursor: assignBusy ? 'not-allowed' : 'pointer',
                      marginBottom: 8,
                    }}
                    value={assignTo}
                    onChange={(e) => setAssignTo(e.target.value)}
                    disabled={assignBusy}
                  >
                    <option value="">— Pick a user —</option>
                    {assignableUsers.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.email}{u.isAdmin ? ' (admin)' : ''}
                      </option>
                    ))}
                    <option value="unassign">— Unassign (clear) —</option>
                  </select>
                  <button
                    type="button"
                    style={{
                      width: '100%',
                      padding: '9px 12px',
                      fontSize: 13,
                      fontWeight: 700,
                      color: '#fff',
                      background: assignBusy || !assignTo || selectedOrderIds.length === 0 ? 'var(--text4)' : 'var(--ss-blue)',
                      border: 'none',
                      borderRadius: 5,
                      cursor: assignBusy || !assignTo || selectedOrderIds.length === 0 ? 'not-allowed' : 'pointer',
                      opacity: assignBusy || !assignTo || selectedOrderIds.length === 0 ? 0.7 : 1,
                    }}
                    onClick={() => void handleAssignSelectedOrders()}
                    disabled={assignBusy || !assignTo || selectedOrderIds.length === 0}
                  >
                    {assignBusy ? 'Assigning…' : `Assign ${selectedOrderIds.length} order${selectedOrderIds.length === 1 ? '' : 's'}`}
                  </button>
                  <div style={{ fontSize: 10.5, color: 'var(--text3)', marginTop: 6, lineHeight: 1.4 }}>
                    Workers see only orders assigned to them. Pick "Unassign" to clear.
                  </div>
                </div>
              ) : null}

              <div style={{ marginTop: 16, padding: 12, background: 'var(--surface2)', borderRadius: 4, marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 8, fontWeight: 600 }}>Shipping Parameters (from 1st order):</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8, fontSize: 12 }}>
                  <div>
                    <div style={{ color: 'var(--text3)', fontSize: 10, marginBottom: 2 }}>Weight</div>
                    <div style={{ color: 'var(--text2)', fontWeight: 600 }}>{firstOrder ? `${firstWeightLb} lb ${firstWeightOz} oz` : '—'}</div>
                  </div>
                  <div>
                    <div style={{ color: 'var(--text3)', fontSize: 10, marginBottom: 2 }}>Dimensions</div>
                    <div style={{ color: 'var(--text2)', fontWeight: 600 }}>
                      {firstDims ? `${firstDims.length} × ${firstDims.width} × ${firstDims.height} in` : '—'}
                    </div>
                  </div>
                </div>
              </div>

              <div style={{ fontSize: 10, color: 'var(--text4)', lineHeight: 1.5 }}>
                Print creates labels and opens PDFs. Queue creates labels and adds them to the print queue without opening PDFs.
              </div>
            </div>
          </div>
        </div>
      </>
    )
  }

  const renderSinglePanel = () => {
    if (!panelOrder) return buildEmptyPanel(onHideEmptyPanelChange ? () => onHideEmptyPanelChange(true) : undefined)

    const items = getActiveItems(panelOrder, panelDetail)
    const mergedItems = getMergedItems(panelOrder, panelDetail)
    const shipTo = getShipTo(panelOrder, panelDetail)
    const panelFormDims = getPanelDims()
    const selectedPanelPackage = packages.find((candidate) => getPackageIdentifier(candidate) === panelForm.packageId)
    const dims = hasCompleteDims(panelFormDims)
      ? panelFormDims
      : getPackageDims(selectedPanelPackage) ?? getDimensions(panelOrder, panelDetail)
    const requestedService = getRequestedService(panelOrder, panelDetail)
    const panelIndex = orderedFilteredOrders.findIndex((order) => order.orderId === panelOrder.orderId)
    const prevOrderId = panelIndex > 0 ? orderedFilteredOrders[panelIndex - 1]?.orderId ?? null : null
    const nextOrderId = panelIndex >= 0 && panelIndex < orderedFilteredOrders.length - 1 ? orderedFilteredOrders[panelIndex + 1]?.orderId ?? null : null
    const currentWeight = panelOrder.weight?.value ?? 0
    const serviceOptions = getServiceOptionsForAccount(panelForm.shipAccountId)
    const panelIsTestOrder = isTestOrder(panelOrder, panelDetail)
    const selectedPanelAccountLabel = panelIsTestOrder
      ? TEST_SHIPPING_ACCOUNT_LABEL
      : getShipAccountLabelById(shippingAccounts, panelForm.shipAccountId) ?? getShipAccountDisplay(panelOrder, shippingAccounts)
    const panelTestRate = panelIsTestOrder ? (panelRatePreview[0] ?? panelOrder.bestRate ?? buildTestMockRate()) : null
    const panelTestRateAmount = panelTestRate
      ? (toNumberValue(panelTestRate.shipmentCost) ?? 0) + (toNumberValue(panelTestRate.otherCost) ?? 0)
      : 0
    const panelTestRateDetail = panelTestRate
      ? `${toStringValue(panelTestRate.carrierNickname) ?? formatCarrierCode(toStringValue(panelTestRate.carrierCode))} · ${toStringValue(panelTestRate.serviceName) ?? formatServiceCode(toStringValue(panelTestRate.serviceCode))}`
      : `${TEST_SHIPPING_ACCOUNT_LABEL} · PrepShip Test Standard`
    const shipped = panelOrder.orderStatus !== 'awaiting_shipment'
    const trackingNumber = panelOrder.label?.trackingNumber ?? null
    const deliveryLine = panelOrder.label?.shipDate
      ? `Shipped: ${formatDateOnly(panelOrder.label.shipDate, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}`
      : 'Delivery: —'
    const addressBlock = getAddressBlock(panelOrder, panelDetail)

    return (
      <>
        {/* ─────────────────────────────────────────────────────────
            REFINED OPERATOR CONSOLE — Side panel header (sticky)

            Three-row architecture:
              1. Order # + nav arrows + utility icons (compact, sticky)
              2. Status strip (status pill + source + test marker)
              3. (sections begin)

            Design moves:
              • Order # in monospaced, prominent, ellipsis-truncated
              • Nav arrows are square ghost-icon buttons (ChevronLeft/Right)
              • Secondary actions (Batch, Print, External Ship) collapse
                into a single MoreHorizontal kebab dropdown to reduce
                visual noise — keeps power-user shortcuts available
                without crowding the header
              • Open-in-ShipStation = minimal ExternalLink icon button
              • Close X = standard ghost icon button on far right
            ───────────────────────────────────────────────────────── */}
        <div className="sticky top-0 z-10 bg-surface/95 backdrop-blur-sm border-b border-line">
          {/* Row 1 — Identity + navigation + actions */}
          <div className="flex items-center gap-1 px-3 py-2">
            {/* Nav arrow group */}
            <div className="flex items-center gap-0.5 mr-1">
              <button
                type="button"
                onClick={() => prevOrderId != null && openOrderDetails(prevOrderId)}
                disabled={prevOrderId == null}
                title="Previous order"
                aria-label="Previous order"
                className="inline-flex items-center justify-center w-6 h-6 rounded text-ink-3 hover:text-ink hover:bg-surface-2 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink-3 transition"
              >
                <ChevronLeft size={14} strokeWidth={2.5} />
              </button>
              <button
                type="button"
                onClick={() => nextOrderId != null && openOrderDetails(nextOrderId)}
                disabled={nextOrderId == null}
                title="Next order"
                aria-label="Next order"
                className="inline-flex items-center justify-center w-6 h-6 rounded text-ink-3 hover:text-ink hover:bg-surface-2 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink-3 transition"
              >
                <ChevronRight size={14} strokeWidth={2.5} />
              </button>
            </div>

            {/* Order number — primary identity, monospaced, truncated */}
            <div className="flex-1 min-w-0 flex items-baseline gap-2">
              <span
                className="font-mono text-[13px] font-semibold text-ink truncate tracking-tight"
                title={panelOrder.orderNumber ?? `#${panelOrder.orderId}`}
              >
                {panelOrder.orderNumber ?? `#${panelOrder.orderId}`}
              </span>
              {panelIndex >= 0 ? (
                <span className="text-[10px] font-medium text-ink-4 tabular-nums shrink-0">
                  {panelIndex + 1}/{orderedFilteredOrders.length}
                </span>
              ) : null}
            </div>

            {/* Utility icon buttons — Batch menu */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setBatchMenuOpen((open) => !open)}
                title="Batch actions"
                aria-label="Batch actions"
                className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-[11px] font-medium text-ink-2 hover:text-ink hover:bg-surface-2 ring-1 ring-line hover:ring-line-2 transition"
              >
                <ClipboardList size={11} strokeWidth={2.25} />
                <span>Batch</span>
                <ChevronDown size={9} strokeWidth={2.5} className="text-ink-3" />
              </button>
              {batchMenuOpen ? (
                <div className="absolute top-[calc(100%+4px)] left-0 z-30 min-w-[200px] rounded-lg bg-surface ring-1 ring-line shadow-lg py-1 text-[12px]">
                  <button
                    type="button"
                    className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-ink-2 hover:text-ink hover:bg-surface-2 transition"
                    onClick={() => { setBatchMenuOpen(false); updateSelection([panelOrder.orderId, ...selectedOrderIds.filter((id) => id !== panelOrder.orderId)]) }}
                  >
                    <Inbox size={12} strokeWidth={2.25} className="text-ink-3" />
                    Add to Batch Queue
                  </button>
                  <button
                    type="button"
                    className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-ink-2 hover:text-ink hover:bg-surface-2 transition"
                    onClick={() => { setBatchMenuOpen(false); void queueExistingLabels([panelOrder.orderId]) }}
                  >
                    <RefreshCcw size={12} strokeWidth={2.25} className="text-ink-3" />
                    Quick Reprint (Batch)
                  </button>
                </div>
              ) : null}
            </div>

            {/* Print menu */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setPrintMenuOpen((open) => !open)}
                title="Print options"
                aria-label="Print options"
                className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-[11px] font-medium text-ink-2 hover:text-ink hover:bg-surface-2 ring-1 ring-line hover:ring-line-2 transition"
              >
                <PrinterIcon size={11} strokeWidth={2.25} />
                <ChevronDown size={9} strokeWidth={2.5} className="text-ink-3" />
              </button>
              {printMenuOpen ? (
                <div className="absolute top-[calc(100%+4px)] right-0 z-30 min-w-[180px] rounded-lg bg-surface ring-1 ring-line shadow-lg py-1 text-[12px]">
                  {shipped && trackingNumber ? (
                    <button
                      type="button"
                      className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-ink-2 hover:text-ink hover:bg-surface-2 transition"
                      onClick={() => { setPrintMenuOpen(false); void reprintLabel() }}
                    >
                      <PrinterIcon size={12} strokeWidth={2.25} className="text-ink-3" />
                      Reprint Label
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-ink-2 hover:text-ink hover:bg-surface-2 transition"
                      onClick={() => { setPrintMenuOpen(false); void createOrQueueLabel('test') }}
                    >
                      <Tag size={12} strokeWidth={2.25} className="text-ink-3" />
                      Create Test Label
                    </button>
                  )}
                </div>
              ) : null}
            </div>

            {/* Open in ShipStation */}
            <a
              href={`https://ship.shipstation.com/orders/${panelOrder.orderId}`}
              target="_blank"
              rel="noreferrer"
              title="Open in ShipStation"
              aria-label="Open in ShipStation"
              className="inline-flex items-center justify-center w-7 h-7 rounded-md text-ink-3 hover:text-ink hover:bg-surface-2 transition"
            >
              <ExternalLink size={12} strokeWidth={2.25} />
            </a>

            {/* Close panel */}
            <button
              type="button"
              onClick={closeSinglePanel}
              title="Close panel"
              aria-label="Close panel"
              className="inline-flex items-center justify-center w-7 h-7 rounded-md text-ink-3 hover:text-ink hover:bg-surface-2 transition"
            >
              <XIcon size={13} strokeWidth={2.5} />
            </button>
          </div>

          {/* Row 2 — Status strip (only when meaningful) */}
          {!shipped || panelIsTestOrder ? (
            <div className="flex items-center gap-1.5 px-3 pb-2 -mt-0.5">
              {/* Order status pill */}
              {shipped ? (
                <span className="inline-flex items-center gap-1 h-5 px-1.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-ok-bg text-ok-dark ring-1 ring-ok-border">
                  <PackageCheck size={9} strokeWidth={2.5} />
                  Shipped
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 h-5 px-1.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-amber-50 text-amber-700 ring-1 ring-amber-200">
                  <Send size={9} strokeWidth={2.5} />
                  Awaiting
                </span>
              )}

              {/* Test order indicator */}
              {panelIsTestOrder ? (
                <span className="inline-flex items-center gap-1 h-5 px-1.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-brand-bg text-brand ring-1 ring-brand-border">
                  <Zap size={9} strokeWidth={2.5} />
                  Test
                </span>
              ) : null}

              {/* External-shipped action — quiet outline button on the right */}
              {!shipped ? (
                <div className="ml-auto relative">
                  <button
                    type="button"
                    onClick={() => setExtShipMenuOpen((open) => !open)}
                    title="Mark this order as shipped externally (no label purchase)"
                    className="inline-flex items-center gap-1 h-6 px-2 rounded-md text-[10.5px] font-semibold text-amber-800 bg-amber-50/80 ring-1 ring-amber-200 hover:bg-amber-100 hover:ring-amber-300 transition"
                  >
                    <BadgeCheck size={10} strokeWidth={2.5} />
                    Mark as Shipped
                    <ChevronDown size={8} strokeWidth={2.5} className="opacity-60" />
                  </button>
                  {extShipMenuOpen ? (
                    <div className="absolute top-[calc(100%+4px)] right-0 z-30 w-[260px] rounded-lg bg-surface ring-1 ring-line shadow-lg overflow-hidden text-[12px]">
                      {/* Header */}
                      <div className="px-3 py-2 bg-surface-2 border-b border-line">
                        <div className="font-semibold text-ink text-[12px]">Mark as Shipped</div>
                        <div className="text-ink-3 text-[10.5px] mt-0.5">
                          Closes the order locally. Optional notify:
                        </div>
                      </div>

                      {/* Notify Customer toggle */}
                      <label className="flex items-center justify-between gap-2 px-3 py-2 hover:bg-surface-2 cursor-pointer">
                        <div className="flex flex-col">
                          <span className="font-medium text-ink-2 text-[11.5px]">Notify customer</span>
                          <span className="text-ink-3 text-[10px]">Email shipping confirmation via ShipStation</span>
                        </div>
                        {/* Compact iOS-style toggle — visible on/off state without a checkbox icon */}
                        <span
                          className={`relative inline-flex w-8 h-4 rounded-full transition-colors duration-150 flex-shrink-0 ${extShipNotifyCustomer ? 'bg-emerald-500' : 'bg-line'}`}
                          aria-hidden
                        >
                          <span
                            className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-transform duration-150 ${extShipNotifyCustomer ? 'translate-x-[18px]' : 'translate-x-0.5'}`}
                            aria-hidden
                          />
                        </span>
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={extShipNotifyCustomer}
                          onChange={(e) => setExtShipNotifyCustomer(e.target.checked)}
                        />
                      </label>

                      {/* Notify Marketplace toggle */}
                      <label className="flex items-center justify-between gap-2 px-3 py-2 hover:bg-surface-2 cursor-pointer border-b border-line">
                        <div className="flex flex-col">
                          <span className="font-medium text-ink-2 text-[11.5px]">Notify marketplace</span>
                          <span className="text-ink-3 text-[10px]">Push shipped status to Amazon/eBay/etc.</span>
                        </div>
                        <span
                          className={`relative inline-flex w-8 h-4 rounded-full transition-colors duration-150 flex-shrink-0 ${extShipNotifyMarketplace ? 'bg-emerald-500' : 'bg-line'}`}
                          aria-hidden
                        >
                          <span
                            className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-transform duration-150 ${extShipNotifyMarketplace ? 'translate-x-[18px]' : 'translate-x-0.5'}`}
                            aria-hidden
                          />
                        </span>
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={extShipNotifyMarketplace}
                          onChange={(e) => setExtShipNotifyMarketplace(e.target.checked)}
                        />
                      </label>

                      {/* Tracking number input — only really useful when
                          a notify toggle is on (the notification email
                          embeds the tracking link). We render it always
                          so power-users can record tracking even without
                          notification, but show a hint below it. */}
                      <div className="px-3 py-2 border-b border-line">
                        <label className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-3 block mb-1">
                          Tracking # <span className="font-normal lowercase tracking-normal text-ink-4">(optional)</span>
                        </label>
                        <input
                          type="text"
                          value={extShipTracking}
                          onChange={(e) => setExtShipTracking(e.target.value)}
                          placeholder="e.g. 1Z999AA10123456784"
                          className="w-full h-7 px-2 rounded ring-1 ring-line bg-surface text-[11.5px] text-ink-2 placeholder:text-ink-4 focus:ring-brand outline-none transition"
                        />
                        {(extShipNotifyCustomer || extShipNotifyMarketplace) && !extShipTracking.trim() ? (
                          <div className="text-[10px] text-amber-700 mt-1 flex items-center gap-1">
                            <span aria-hidden>⚠</span>
                            <span>Notify will send empty tracking — recipient sees "tracking pending"</span>
                          </div>
                        ) : null}
                      </div>

                      {/* Marketplace picker — clicking submits the action.
                          The picked marketplace is stored as the
                          externallyShippedSource override (existing
                          behavior). Disabled while a request is in flight
                          so a double-click doesn't double-fire. */}
                      <div className="px-2 py-1.5">
                        <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-3 px-1 pb-1">
                          Source marketplace
                        </div>
                        {['Shopify', 'Amazon', 'Walmart', 'eBay', 'Etsy', 'Other'].map((source) => (
                          <button
                            key={source}
                            type="button"
                            disabled={extShipBusy}
                            className="w-full text-left px-2 py-1.5 rounded text-ink-2 hover:text-ink hover:bg-surface-2 transition disabled:opacity-50 disabled:cursor-wait text-[11.5px]"
                            onClick={() => {
                              setExtShipMenuOpen(false)
                              void markOrderShippedExternal(source)
                            }}
                          >
                            {extShipBusy ? `Working… (${source})` : source}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="panel-body">
          {/* ─────────────────────────────────────────────────────────
              SHIPPING SECTION
              Header: Truck icon + title + chevron toggle
              Sub-strip: "Requested service" — quiet info chip with
              a clickable link styling the carrier-suggested service
              ───────────────────────────────────────────────────────── */}
          <div className={`panel-section${collapsedSections.shipping ? ' collapsed' : ''}`} id="sec-shipping">
            <button
              type="button"
              onClick={() => toggleSection('shipping')}
              className="w-full flex items-center gap-2 px-3 py-2.5 bg-surface hover:bg-surface-2 transition group"
            >
              <Truck size={13} strokeWidth={2.25} className="text-ink-3 group-hover:text-ink-2 transition" />
              <span className="flex-1 text-left text-[12px] font-semibold text-ink-2 tracking-tight uppercase letter-spacing-wider">
                Shipping
              </span>
              <ChevronDown
                size={13}
                strokeWidth={2.5}
                className={`text-ink-3 transition-transform ${collapsedSections.shipping ? '-rotate-90' : ''}`}
              />
            </button>

            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-2/60 border-y border-line text-[11px]">
              <span className="text-ink-3 font-medium">Requested</span>
              <span className="text-ink-2">·</span>
              <span className="text-brand font-semibold cursor-pointer hover:underline">
                {(requestedService ?? 'Standard').replace(/_/g, ' ')}
              </span>
              {!panelOrder.carrierCode ? (
                <span className="text-ink-4 font-medium">(unmapped)</span>
              ) : null}
            </div>

            <div className="panel-section-body">
              <div className="ship-field-row">
                <span className="ship-field-label">Ship From</span>
                <div className="ship-field-value">
                  <select className="ship-select" style={{ flex: 1 }} value={panelForm.locationId} onChange={(event) => setPanelForm((current) => ({ ...current, locationId: event.target.value }))} disabled={shipped}>
                    {locations.length === 0 ? <option value="">Loading…</option> : null}
                    {locations.map((location: LocationDto, i: number) => {
                      const id = location.locationId ?? (location as any).id ?? i
                      return (
                        <option key={id} value={id}>
                          {location.name}
                        </option>
                      )
                    })}
                  </select>
                  <button className="ship-icon-btn" type="button" title="Manage locations" onClick={() => onNavigateView?.('locations')}>📍</button>
                </div>
              </div>

              <div className="ship-field-row">
                <span className="ship-field-label">Ship Acct</span>
                <div className="ship-field-value">
                  <select
                    className="ship-select"
                    style={{ flex: 1 }}
                    value={panelForm.shipAccountId}
                    disabled={shipped || panelIsTestOrder}
                    onChange={(event) => {
                      const nextValue = event.target.value
                      setPanelForm((current) => ({
                        ...current,
                        shipAccountId: nextValue,
                        serviceCode: getServiceOptionsForAccount(nextValue)[0]?.code ?? current.serviceCode,
                      }))
                      void apiClient.setOrderSelectedPid(panelOrder.orderId, nextValue ? Number.parseInt(nextValue, 10) : null)
                    }}
                  >
                    <option value="">— Select Account —</option>
                    {panelIsTestOrder ? <option value={TEST_CARRIER_CODE}>{TEST_SHIPPING_ACCOUNT_LABEL}</option> : null}
                    {shippingAccounts.map((account, i) => {
                      const key = account.shippingProviderId || account.carrierId || account.code || i
                      return (
                        <option key={key} value={account.shippingProviderId || key}>
                          {getCarrierAccountDisplay(account) ?? account.code}
                        </option>
                      )
                    })}
                  </select>
                </div>
              </div>

              <div className="ship-field-row">
                <span className="ship-field-label">Service</span>
                <div className="ship-field-value">
                  <select className="ship-select" style={{ flex: 1 }} value={panelForm.serviceCode} disabled={shipped || panelIsTestOrder} onChange={(event) => setPanelForm((current) => ({ ...current, serviceCode: event.target.value }))}>
                    {panelIsTestOrder && panelForm.serviceCode && panelForm.serviceCode !== TEST_SERVICE_CODE ? (
                      <option value={panelForm.serviceCode}>{formatServiceCode(panelForm.serviceCode)}</option>
                    ) : null}
                    {panelIsTestOrder ? <option value={TEST_SERVICE_CODE}>PrepShip Test Standard</option> : null}
                    <option value="">{panelForm.serviceCode ? formatServiceCode(panelForm.serviceCode) : 'Select Service'}</option>
                    {serviceOptions.map((option) => (
                      <option key={option.code} value={option.code}>{option.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="ship-field-row">
                <span className="ship-field-label">Weight</span>
                <div className="ship-field-value">
                  <input type="number" className="ship-input ship-input-sm" value={panelForm.weightLb} readOnly={shipped} onChange={(event) => { dimsUserEditedRef.current = true; setPanelForm((current) => ({ ...current, weightLb: event.target.value })) }} />
                  <span className="ship-input-unit">lb</span>
                  <input type="number" className="ship-input ship-input-sm" value={panelForm.weightOz} readOnly={shipped} onChange={(event) => { dimsUserEditedRef.current = true; setPanelForm((current) => ({ ...current, weightOz: event.target.value })) }} />
                  <span className="ship-input-unit">oz</span>
                </div>
              </div>

              <div className="ship-field-row">
                <span className="ship-field-label">Size</span>
                <div className="ship-field-value" style={{ gap: 3, flexWrap: 'wrap' }}>
                  <input type="number" className="ship-input ship-input-sm" value={panelForm.length} readOnly={shipped} onChange={(event) => { dimsUserEditedRef.current = true; setPanelForm((current) => ({ ...current, length: event.target.value })) }} />
                  <span className="ship-input-unit">L</span>
                  <input type="number" className="ship-input ship-input-sm" value={panelForm.width} readOnly={shipped} onChange={(event) => { dimsUserEditedRef.current = true; setPanelForm((current) => ({ ...current, width: event.target.value })) }} />
                  <span className="ship-input-unit">W</span>
                  <input type="number" className="ship-input ship-input-sm" value={panelForm.height} readOnly={shipped} onChange={(event) => { dimsUserEditedRef.current = true; setPanelForm((current) => ({ ...current, height: event.target.value })) }} />
                  <span className="ship-input-unit">H (in)</span>
                </div>
              </div>

              <div className="ship-field-row" style={{ borderBottom: 'none', paddingBottom: 2 }}>
                <span className="ship-field-label">Package</span>
                <div className="ship-field-value">
                  <select
                    className="ship-select"
                    style={{ flex: 1 }}
                    value={panelForm.packageId}
                    disabled={shipped}
                    onChange={(event) => {
                      const packageId = event.target.value
                      const selectedPackage = packages.find((candidate) => getPackageIdentifier(candidate) === packageId)
                      const selectedDims = getPackageDims(selectedPackage)
                      // User-driven package change should trigger an
                      // auto-rate-refresh — flag it as a real edit.
                      dimsUserEditedRef.current = true
                      setPanelForm((current) => ({
                        ...current,
                        packageId,
                        ...(selectedDims
                          ? {
                              length: String(selectedDims.length),
                              width: String(selectedDims.width),
                              height: String(selectedDims.height),
                            }
                          : {}),
                      }))
                      void apiClient.setOrderSelectedPackageId(panelOrder.orderId, packageId ? Number.parseInt(packageId, 10) : null)
                    }}
                  >
                    <option value="">— Select Package —</option>
                    {packages.map((pkg) => (
                      <option key={pkg.packageId ?? (pkg as any).id ?? pkg.name} value={pkg.packageId ?? (pkg as any).id ?? ''}>{pkg.name}</option>
                    ))}
                  </select>
                  <button className="ship-icon-btn" type="button" title="Manage packages" onClick={() => onNavigateView?.('packages')}>📐</button>
                </div>
              </div>

              <div id="p-package-dims" style={{ padding: '0 0 6px 98px', fontSize: 10, fontWeight: 600, color: 'var(--green,#16a34a)', borderBottom: '1px solid var(--border)', display: dims ? 'block' : 'none' }}>
                {dims ? `${dims.length} × ${dims.width} × ${dims.height} in` : ''}
              </div>

              {shipped ? null : (
                <div style={{ padding: '4px 0', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <button className="btn btn-primary btn-sm" type="button" style={{ fontSize: 11.5, gap: 4 }} onClick={() => void openRateBrowser()}>🔍 Browse Rates</button>
                  <button
                    className="btn btn-ghost btn-sm"
                    type="button"
                    style={{
                      fontSize: 11.5,
                      gap: 4,
                      borderColor: 'var(--green-border)',
                      color: 'var(--green-dark)',
                    }}
                    onClick={() => void saveShipmentDetails()}
                    disabled={shipmentDetailsSaving}
                  >
                    {shipmentDetailsSaving ? 'Saving...' : 'Save'}
                  </button>
                </div>
              )}

              <div className="ship-field-row">
                <span className="ship-field-label">Confirmation</span>
                <div className="ship-field-value">
                  <select className="ship-select" value={panelForm.confirmation} disabled={shipped} onChange={(event) => setPanelForm((current) => ({ ...current, confirmation: event.target.value }))}>
                    {['none', 'delivery', 'signature', 'adult_signature', 'direct_signature'].map((option) => (
                      <option key={option} value={option}>{option.replace(/_/g, ' ')}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="ship-field-row">
                <span className="ship-field-label">Insurance</span>
                <div className="ship-field-value" style={{ gap: 5, flexWrap: 'wrap' }}>
                  <select className="ship-select" value={panelForm.insurance} style={{ flex: 1 }} disabled={shipped} onChange={(event) => setPanelForm((current) => ({ ...current, insurance: event.target.value }))}>
                    <option value="none">None</option>
                    <option value="carrier">Carrier (up to $100)</option>
                    <option value="shipsurance">Shipsurance</option>
                  </select>
                  <input
                    type="number"
                    className="ship-input ship-input-sm"
                    value={panelForm.insuranceValue}
                    placeholder="$0.00"
                    style={{ width: 68, display: panelForm.insurance !== 'none' ? 'block' : 'none' }}
                    readOnly={shipped}
                    onChange={(event) => setPanelForm((current) => ({ ...current, insuranceValue: event.target.value }))}
                  />
                </div>
              </div>

              {/* Save weights/dims link — quiet text-link inside the
                  shipping form. Demoted from a green pill to a subtle
                  inline action so the visual weight goes to the
                  Decision Card below. */}
              {shipped ? null : (
                <button
                  type="button"
                  onClick={() => void saveSkuDefaults()}
                  className="mt-1 inline-flex items-center gap-1.5 text-[10.5px] font-medium text-ink-3 hover:text-brand transition group"
                  title="Apply current weights and dims as defaults for this SKU"
                >
                  <SaveIcon size={10} strokeWidth={2.25} className="text-ink-4 group-hover:text-brand transition" />
                  Save weights & dims as SKU defaults
                </button>
              )}
            </div>
          </div>

          {/* ─────────────────────────────────────────────────────────
              DECISION CARD — Rate display + action buttons grouped
              together into a single visually-bounded surface. The
              operator's eyes land here to make the shipping call:

                ┌───────────────────────────────┐
                │ RATE       $6.62              │
                │ Carrier · Service             │
                ├───────────────────────────────┤
                │ [Create + Print] [Queue] Test │
                └───────────────────────────────┘

              For shipped orders, just shows the locked rate.
              For test orders, shows the mock rate.
              For awaiting orders, shows live rate calc + scout link.
              ───────────────────────────────────────────────────────── */}
          <div className="px-3 py-3">
            <div className="rounded-xl bg-surface ring-1 ring-line shadow-[0_1px_2px_rgba(15,23,42,0.04)] overflow-hidden">
              {/* Rate row */}
              <div className="flex items-center gap-3 px-3.5 py-3 border-b border-line">
                <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                  <span className="text-[9.5px] font-semibold uppercase tracking-[0.08em] text-ink-4">Rate</span>
                  {panelIsTestOrder ? (
                    <>
                      <span className="text-[18px] font-bold tabular-nums leading-none text-brand font-display">
                        {formatMoney(panelTestRateAmount)}
                      </span>
                      <span className="text-[11px] text-ink-3 leading-snug truncate">{panelTestRateDetail}</span>
                    </>
                  ) : shipped ? (
                    getIsExternallyFulfilled(panelOrder) ? (
                      <span className="text-[12.5px] text-ink-3 italic leading-snug">External label — purchased externally</span>
                    ) : (
                      <>
                        <span className="text-[18px] font-bold tabular-nums leading-none text-ink font-display">
                          {formatMoney(panelOrder.label?.cost ?? panelOrder.selectedRate?.cost ?? getSelectedRateBaseCost(panelOrder))}
                        </span>
                        <span className="text-[11px] text-ink-3 leading-snug truncate">
                          {selectedPanelAccountLabel} · {formatServiceCode(panelForm.serviceCode)}
                        </span>
                      </>
                    )
                  ) : panelRateLoading ? (
                    <div className="flex items-center gap-2 py-1">
                      <Loader2 size={13} strokeWidth={2.5} className="animate-spin text-brand" />
                      <span className="text-[12px] font-semibold text-brand">Calculating best rate…</span>
                    </div>
                  ) : panelRatePreview[0] ? (
                    <>
                      <span className="text-[18px] font-bold tabular-nums leading-none text-brand font-display">
                        {formatMoney((toNumberValue(panelRatePreview[0].shipmentCost) ?? 0) + (toNumberValue(panelRatePreview[0].otherCost) ?? 0))}
                      </span>
                      <span className="text-[11px] text-ink-3 leading-snug truncate">
                        {formatCarrierCode(toStringValue(panelRatePreview[0].carrierCode))} · {formatServiceCode(toStringValue(panelRatePreview[0].serviceCode))}
                      </span>
                    </>
                  ) : panelOrder.bestRate ? (
                    <>
                      <span className="text-[18px] font-bold tabular-nums leading-none text-brand font-display">
                        {formatMoney(applyCarrierMarkup({
                          shippingProviderId: getBestRateShippingProviderId(panelOrder),
                          carrierCode: panelOrder.bestRate.carrierCode ?? '',
                          serviceCode: getBestRateServiceCode(panelOrder) ?? '',
                          serviceName: panelOrder.bestRate.serviceName ?? '',
                          amount: typeof panelOrder.bestRate.amount === 'number' ? panelOrder.bestRate.amount : 0,
                          shipmentCost: typeof panelOrder.bestRate.shipmentCost === 'number' ? panelOrder.bestRate.shipmentCost : undefined,
                          otherCost: typeof panelOrder.bestRate.otherCost === 'number' ? panelOrder.bestRate.otherCost : undefined,
                          carrierNickname: getBestRateCarrierNickname(panelOrder),
                        }, markups))}
                      </span>
                      <span className="text-[11px] text-ink-3 leading-snug truncate">
                        {selectedPanelAccountLabel} · {formatServiceCode(panelForm.serviceCode || getBestRateServiceCode(panelOrder))}
                      </span>
                    </>
                  ) : (
                    <span className="text-[14px] text-ink-4">—</span>
                  )}
                </div>

                {/* Scout review — only when awaiting a label */}
                {!panelIsTestOrder && !shipped ? (
                  <button
                    type="button"
                    onClick={() => void openRateBrowser()}
                    title="Browse rates from all carriers"
                    className="shrink-0 inline-flex items-center gap-1 h-7 px-2 rounded-md text-[10.5px] font-semibold text-ink-3 hover:text-brand hover:bg-brand/5 transition"
                  >
                    <RefreshCcw size={11} strokeWidth={2.5} />
                    <span className="hidden sm:inline">Scout</span>
                  </button>
                ) : null}
              </div>

              {/* Action buttons row — only when awaiting a label */}
              {shipped ? null : (
                <div className="flex items-stretch gap-1 p-1.5 bg-surface-2/40">
                  <button
                    type="button"
                    onClick={() => void createOrQueueLabel('print')}
                    disabled={singleActionBusy}
                    aria-busy={singleActionBusy}
                    title="Buy postage and open the shipping label now"
                    className={[
                      'flex-[5] inline-flex items-center justify-center gap-2',
                      'h-9 rounded-lg',
                      'text-[12.5px] font-semibold tracking-tight text-white',
                      'bg-brand hover:bg-brand-dark',
                      'shadow-[0_1px_2px_rgba(42,91,215,0.20),inset_0_1px_0_rgba(255,255,255,0.12)]',
                      'active:scale-[0.985]',
                      'disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100',
                      'transition-all duration-150 ease-out',
                    ].join(' ')}
                  >
                    {singleActionBusy ? (
                      <Loader2 size={13} strokeWidth={2.5} className="animate-spin" aria-hidden />
                    ) : (
                      <PrinterIcon size={13} strokeWidth={2.5} aria-hidden />
                    )}
                    <span>{singleActionBusy ? 'Working…' : 'Create + Print Label'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => void createOrQueueLabel('queue')}
                    disabled={singleActionBusy}
                    aria-busy={singleActionBusy}
                    title="Buy postage but don't open the label — adds it to the print queue for batch printing"
                    className={[
                      'flex-[3] inline-flex items-center justify-center gap-1.5',
                      'h-9 px-2 rounded-lg',
                      'text-[12.5px] font-semibold text-ink-2',
                      'bg-surface ring-1 ring-line',
                      'hover:text-ink hover:ring-line-2 hover:bg-surface',
                      'active:scale-[0.98]',
                      'disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100',
                      'transition-all duration-150 ease-out',
                    ].join(' ')}
                  >
                    <Inbox size={12.5} strokeWidth={2.25} aria-hidden />
                    <span>Print to Queue</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => void createOrQueueLabel('test')}
                    disabled={singleActionBusy}
                    aria-busy={singleActionBusy}
                    title="Create a VOID mock label for testing — no postage charged, label is watermarked 'VOID — DO NOT SHIP'"
                    className={[
                      'inline-flex items-center justify-center',
                      'h-9 px-3 rounded-lg',
                      'text-[11.5px] font-semibold text-ink-3',
                      'bg-transparent',
                      'hover:text-ink hover:bg-surface',
                      'active:scale-95',
                      'disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100',
                      'transition-all duration-150 ease-out',
                    ].join(' ')}
                  >
                    Test
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* ─────────────────────────────────────────────────────────
              TRACKING + DELIVERY STRIP
              When shipped: tracking number (mono, copyable) + Reprint
              Always: delivery line (compact info row)
              ───────────────────────────────────────────────────────── */}
          {shipped && trackingNumber ? (
            <div className="flex items-center gap-2 px-3 py-2 bg-ok-bg/40 border-y border-ok-border/40">
              <PackageCheck size={12} strokeWidth={2.25} className="text-ok-dark shrink-0" />
              <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ok-dark">Tracking</span>
              <button
                type="button"
                onClick={() => copyText(trackingNumber)}
                title="Click to copy tracking number"
                className="font-mono text-[11px] font-semibold text-ink hover:text-brand transition truncate"
              >
                {trackingNumber}
              </button>
              <button
                type="button"
                onClick={() => void reprintLabel()}
                className="ml-auto inline-flex items-center gap-1 h-6 px-2 rounded text-[10.5px] font-semibold text-ink-2 hover:text-ink hover:bg-surface-2 transition"
                title="Reprint label"
              >
                <PrinterIcon size={10} strokeWidth={2.5} />
                Reprint
              </button>
            </div>
          ) : null}

          {/* Delivery line — quiet info row */}
          <div className="px-3 py-1.5 text-[10.5px] text-ink-3 border-b border-line">
            {deliveryLine}
          </div>

          {/* ─────────────────────────────────────────────────────────
              ITEMS SECTION
              Header: Box icon + title + chevron
              Body: stacked rows with thumbnail · name/sku/price · qty
              ───────────────────────────────────────────────────────── */}
          <div className={`panel-section${collapsedSections.items ? ' collapsed' : ''}`} id="sec-items">
            <button
              type="button"
              onClick={() => toggleSection('items')}
              className="w-full flex items-center gap-2 px-3 py-2.5 bg-surface hover:bg-surface-2 transition group"
            >
              <Package size={13} strokeWidth={2.25} className="text-ink-3 group-hover:text-ink-2 transition" />
              <span className="flex-1 text-left text-[12px] font-semibold text-ink-2 tracking-tight uppercase">Items</span>
              <span className="text-[10px] font-medium text-ink-4 tabular-nums">
                {mergedItems.length === 0 ? '0' : mergedItems.length}
              </span>
              <ChevronDown
                size={13}
                strokeWidth={2.5}
                className={`text-ink-3 transition-transform ${collapsedSections.items ? '-rotate-90' : ''}`}
              />
            </button>
            <div className="px-3 pb-3">
              {items.length === 0 ? (
                <div className="pt-3 text-[11.5px] text-ink-3">No items found for this order.</div>
              ) : null}
              <div className="divide-y divide-line">
                {mergedItems.map((item) => (
                  <div
                    key={`${item.sku ?? 'unknown'}-${item.name ?? 'item'}`}
                    className="flex items-start gap-2.5 py-2.5"
                  >
                    <div className="w-[42px] h-[42px] rounded-md bg-surface-2 ring-1 ring-line flex items-center justify-center overflow-hidden shrink-0">
                      <HoverImage
                        src={item.imageUrl}
                        alt={item.name ?? ''}
                        size={42}
                        radius={5}
                        title={item.name ?? ''}
                        fallback={<Package size={18} strokeWidth={1.75} className="text-ink-4" />}
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[12px] font-semibold text-ink leading-snug truncate" title={item.name ?? ''}>
                        {item.name ?? 'Unknown Item'}
                      </div>
                      <div className="text-[10.5px] text-ink-3 font-mono tabular-nums truncate">
                        SKU: {item.sku ?? '—'}
                      </div>
                      <div className="text-[10.5px] text-ink-2 mt-0.5 tabular-nums">
                        {formatMoney(item.unitPrice)} × {item.quantity} = <strong className="text-ink">{formatMoney((item.unitPrice ?? 0) * item.quantity)}</strong>
                      </div>
                    </div>
                    <div className="w-[26px] h-[26px] rounded-full bg-brand text-white flex items-center justify-center text-[12.5px] font-bold tabular-nums shrink-0 shadow-sm">
                      {item.quantity}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* ─────────────────────────────────────────────────────────
              RECIPIENT SECTION
              Header: MapPin icon + title + chevron
              Body: ship-to address card + sold-to + validation status
              ───────────────────────────────────────────────────────── */}
          <div className={`panel-section${collapsedSections.recipient ? ' collapsed' : ''}`} id="sec-recipient">
            <button
              type="button"
              onClick={() => toggleSection('recipient')}
              className="w-full flex items-center gap-2 px-3 py-2.5 bg-surface hover:bg-surface-2 transition group"
            >
              <MapPin size={13} strokeWidth={2.25} className="text-ink-3 group-hover:text-ink-2 transition" />
              <span className="flex-1 text-left text-[12px] font-semibold text-ink-2 tracking-tight uppercase">Recipient</span>
              <ChevronDown
                size={13}
                strokeWidth={2.5}
                className={`text-ink-3 transition-transform ${collapsedSections.recipient ? '-rotate-90' : ''}`}
              />
            </button>
            <div className="px-3 pb-3">
              {/* Ship To header row */}
              <div className="flex items-center gap-2 mt-2 mb-2">
                <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-4">Ship To</span>
                <div className="flex-1 h-px bg-line" />
                <button
                  type="button"
                  onClick={() => copyText(addressBlock)}
                  title="Copy address"
                  className="inline-flex items-center justify-center w-6 h-6 rounded text-ink-3 hover:text-ink hover:bg-surface-2 transition"
                >
                  <CopyIcon size={11} strokeWidth={2.25} />
                </button>
                <button
                  type="button"
                  onClick={() => showToast('Edit recipient — Phase 3')}
                  title="Edit recipient"
                  className="inline-flex items-center gap-1 h-6 px-1.5 rounded text-[10.5px] font-semibold text-brand hover:bg-brand/5 transition"
                >
                  <Edit3 size={10} strokeWidth={2.5} />
                  Edit
                </button>
              </div>

              {/* Address card */}
              <div className="text-[13px] font-semibold text-ink leading-snug">{shipTo.name ?? '—'}</div>
              <div className="text-[12px] text-ink-2 leading-relaxed whitespace-pre-line">
                {addressBlock || '—'}
              </div>
              {shipTo.phone ? (
                <div className="text-[12px] text-ink-2 mt-1 font-mono tabular-nums">{shipTo.phone}</div>
              ) : null}

              {/* Address type pill */}
              <div className="flex items-center gap-1.5 mt-2 text-[10.5px]">
                {panelOrder.residential ?? panelOrder.sourceResidential ? (
                  <span className="inline-flex items-center gap-1 h-5 px-1.5 rounded bg-surface-2 text-ink-2 ring-1 ring-line font-medium">
                    <MapPin size={9} strokeWidth={2.5} className="text-ink-3" />
                    Residential
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 h-5 px-1.5 rounded bg-surface-2 text-ink-2 ring-1 ring-line font-medium">
                    <Box size={9} strokeWidth={2.5} className="text-ink-3" />
                    Commercial
                  </span>
                )}
                <span className="text-ink-4">
                  {panelOrder.residential != null ? '(manual)' : '(auto)'}
                </span>
                <button
                  type="button"
                  onClick={(event) => { event.preventDefault(); void toggleResidential() }}
                  className="ml-1 text-brand font-medium hover:underline"
                >
                  change
                </button>
              </div>

              {/* Validation status row */}
              <div className="flex items-center gap-1.5 mt-2 text-[10.5px]">
                {shipTo.addressVerified && shipTo.addressVerified !== 'Not Validated' ? (
                  <>
                    <BadgeCheck size={11} strokeWidth={2.5} className="text-ok" />
                    <span className="text-ok-dark font-semibold">Address Validated</span>
                  </>
                ) : (
                  <>
                    <AlertTriangle size={11} strokeWidth={2.5} className="text-warn" />
                    <span className="text-warn font-semibold">Address Not Validated</span>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => showToast('Address reverted')}
                  className="ml-1 text-brand font-medium hover:underline"
                >
                  Revert
                </button>
              </div>

              {/* Tax IDs */}
              <div className="flex items-center gap-1.5 mt-2 pt-2 border-t border-line text-[11px]">
                <Tag size={10} strokeWidth={2.5} className="text-ink-4" />
                <span className="text-ink-2">Tax Information:</span>
                <span className="text-ink-3">0 Tax IDs added</span>
                <button
                  type="button"
                  onClick={() => showToast('Add tax ID — Phase 3')}
                  className="ml-auto text-brand font-medium hover:underline"
                >
                  Add
                </button>
              </div>

              {/* Sold To section */}
              <div className="mt-3 pt-3 border-t border-line">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <UserIcon size={10} strokeWidth={2.5} className="text-ink-4" />
                  <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-4">Sold To</span>
                </div>
                <div className="text-[12.5px] font-semibold text-ink">
                  {toStringValue(toRecord(panelDetail?.raw)?.customerUsername) ?? shipTo.name ?? '—'}
                </div>
                {panelOrder.customerEmail ? (
                  <div className="text-[11.5px] text-ink-2 truncate">{panelOrder.customerEmail}</div>
                ) : null}
              </div>

              {activeOrderLoading ? (
                <div className="mt-2.5 flex items-center gap-1.5 text-[10.5px] text-ink-3">
                  <Loader2 size={10} strokeWidth={2.25} className="animate-spin" />
                  Loading full order detail…
                </div>
              ) : null}
              {activeOrderError ? (
                <div className="mt-2.5 flex items-center gap-1.5 text-[10.5px] text-danger">
                  <AlertTriangle size={10} strokeWidth={2.5} />
                  Failed to load full order detail.
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <div id="view-orders">
        {/* ─────────────── FILTER BAR (reworked) ─────────────── */}
        <div
          id="filterbar"
          className="
            flex items-center gap-2 flex-wrap
            px-4 sm:px-5 py-2.5
            bg-surface border-b border-line
            text-ink
          "
        >
          {/* Search input with icon + clear */}
          <div className="relative flex-1 min-w-[200px] max-w-[340px]">
            <SearchIcon
              size={13}
              strokeWidth={2.25}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none"
              aria-hidden
            />
            <input
              type="text"
              id="searchInput"
              placeholder="Search orders, SKUs, names…"
              value={searchQuery}
              onChange={(event) => onSearchQueryChange?.(event.target.value)}
              className={`
                w-full h-8 pl-8 pr-7
                rounded-lg
                bg-surface-2 ring-1 ring-line
                text-[12.5px] text-ink placeholder:text-ink-3
                focus:bg-surface focus:ring-2 focus:ring-brand/40
                focus:outline-none
                transition-all duration-150
                ${searchQuery.trim() ? 'ring-brand/60 bg-brand-bg/40' : ''}
              `}
              title={searchQuery.trim() ? 'Global search — looking across all statuses & stores' : undefined}
            />
            {searchQuery ? (
              <button
                id="searchClear"
                type="button"
                onClick={() => onSearchQueryChange?.('')}
                aria-label="Clear search"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded-md flex items-center justify-center text-ink-3 hover:text-ink hover:bg-line/40 active:scale-90 transition-all duration-150"
              >
                <XIcon size={11} strokeWidth={2.5} />
              </button>
            ) : null}
          </div>

          {/* Global-search hint pill — only appears while a search is
              active. Tells the operator the search is scanning every
              status + store, not just the currently-active tab, so a
              hit in 'Shipped' isn't a surprise when they're on
              'Awaiting'. The pill is muted enough to not steal focus
              but explicit enough to set the right mental model. */}
          {searchQuery.trim() ? (
            <div className="inline-flex items-center gap-1 h-7 px-2 rounded-full bg-brand-bg ring-1 ring-brand/40 text-brand text-[10.5px] font-semibold whitespace-nowrap">
              <span aria-hidden>🌐</span>
              <span>Searching all orders</span>
            </div>
          ) : null}

          {/* SKU filter dropdown */}
          <div className="relative inline-flex items-center">
            <Filter size={11} strokeWidth={2.25} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" aria-hidden />
            <select
              id="skuFilter"
              value={skuFilter}
              onChange={(event) => setSkuFilter(event.target.value)}
              aria-label="Filter by SKU"
              className="
                appearance-none cursor-pointer
                h-8 pl-7 pr-7
                rounded-lg
                bg-surface ring-1 ring-line
                text-[12px] font-medium text-ink-2
                hover:text-ink hover:ring-line-2
                focus:bg-surface focus:ring-2 focus:ring-brand/40
                focus:outline-none
                transition-all duration-150
              "
            >
              <option value="">All SKUs</option>
              {skuOptions.map((sku) => (
                <option key={sku} value={sku}>{sku}</option>
              ))}
            </select>
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-3 text-[8px] pointer-events-none" aria-hidden>▼</span>
          </div>

          {/* Date filter dropdown */}
          <div className="relative inline-flex items-center">
            <Calendar size={11} strokeWidth={2.25} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" aria-hidden />
            <select
              id="dateFilter"
              value={dateFilter}
              onChange={(event) => onDateFilterChange?.(event.target.value as OrdersDateFilter)}
              aria-label="Filter by date"
              className="
                appearance-none cursor-pointer
                h-8 pl-7 pr-7
                rounded-lg
                bg-surface ring-1 ring-line
                text-[12px] font-medium text-ink-2
                hover:text-ink hover:ring-line-2
                focus:bg-surface focus:ring-2 focus:ring-brand/40
                focus:outline-none
                transition-all duration-150
              "
            >
              <option value="">All Dates</option>
              <option value="this-month">This Month</option>
              <option value="last-month">Last Month</option>
              <option value="last-30">Last 30 Days</option>
              <option value="last-90">Last 90 Days</option>
              <option value="custom">Custom…</option>
            </select>
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-3 text-[8px] pointer-events-none" aria-hidden>▼</span>
          </div>

          {/* Custom date range — only shown when dateFilter is 'custom' */}
          {dateFilter === 'custom' ? (
            <div id="customDateWrap" className="inline-flex items-center gap-1.5 h-8 px-2 rounded-lg bg-surface-2 ring-1 ring-line">
              <input
                type="date"
                id="dateFrom"
                value={customDateFrom}
                onChange={(event) => setCustomDateFrom(event.target.value)}
                className="bg-transparent border-0 text-[11.5px] text-ink-2 font-mono tabular-nums focus:outline-none focus:text-ink"
              />
              <span className="text-ink-3 text-[11px]">→</span>
              <input
                type="date"
                id="dateTo"
                value={customDateTo}
                onChange={(event) => setCustomDateTo(event.target.value)}
                className="bg-transparent border-0 text-[11.5px] text-ink-2 font-mono tabular-nums focus:outline-none focus:text-ink"
              />
            </div>
          ) : null}

          <div className="col-toggle-wrap">
            <button className="btn btn-outline btn-sm" type="button" id="colBtnFilter" style={{ display: 'none' }} onClick={() => setColumnMenuOpen((open) => !open)}>⊞ Columns</button>
            {columnMenuOpen && columnMenuPos ? (
              <div ref={columnMenuRef} className="react-column-menu" style={{ position: 'fixed', top: columnMenuPos.top, right: columnMenuPos.right, background: 'var(--surface)', border: '1px solid var(--border2)', borderRadius: 8, boxShadow: 'var(--shadow-lg)', padding: '8px 0', zIndex: 1000, minWidth: 220 }}>
                <div style={{ padding: '0 12px 6px', fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.5px' }}>Toggle &amp; Reorder Columns</div>
                {resolvedColumnPrefs.orderedColumns.filter((column) => column.key !== 'select' && column.key !== 'orderNum').map((column) => {
                  const checked = !resolvedColumnPrefs.hiddenColumns.has(column.key)
                  return (
                    <div
                      key={column.key}
                      className={[
                        'col-dd-item',
                        dropdownDragColumnKey === column.key ? 'dragging' : '',
                        dropdownDragOverColumnKey === column.key ? 'drag-over' : '',
                      ].filter(Boolean).join(' ')}
                      draggable
                      onDragStart={(event) => handleDropdownDragStart(event, column.key)}
                      onDragOver={(event) => handleDropdownDragOver(event, column.key)}
                      onDrop={(event) => handleDropdownDrop(event, column.key)}
                      onDragEnd={finishDropdownDrag}
                    >
                      <span className="col-dd-handle" aria-hidden="true">::</span>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) => {
                            const nextHidden = new Set(resolvedColumnPrefs.hiddenColumns)
                            if (event.target.checked) nextHidden.delete(column.key)
                            else nextHidden.add(column.key)
                            void saveColumnPrefsToServer(buildSavedColumnPrefs(resolvedColumnPrefs.orderedColumns, nextHidden, resolvedColumnPrefs.widths))
                          }}
                        />
                        {column.label}
                      </label>
                    </div>
                  )
                })}
              </div>
            ) : null}
          </div>
          {/* Lockdown — Select All hidden in Shipped/Cancelled views.
              Without this, the user could check Select All which would
              ignore the row-level checkbox lockdown (rows hide their
              checkboxes, but Select All operates on visibleOrderIds
              regardless of cell visibility). */}
          {isReadOnly ? null : (
          <label
            id="btnSelectAll"
            title={
              visibleOrderIds.length === 0
                ? 'No visible orders to select'
                : allVisibleSelected
                  ? 'Clear all visible selected orders'
                  : 'Select all visible orders'
            }
            className={`
              inline-flex items-center gap-1.5
              h-8 px-2.5 rounded-lg ring-1 select-none
              text-[12px] font-medium
              transition-all duration-150
              ${visibleOrderIds.length > 0 ? 'cursor-pointer' : 'cursor-default opacity-50'}
              ${allVisibleSelected || someVisibleSelected
                ? 'bg-brand-bg ring-brand text-brand'
                : 'bg-surface ring-line text-ink-2 hover:text-ink hover:ring-line-2'}
            `}
          >
            <input
              ref={selectAllCheckboxRef}
              type="checkbox"
              checked={allVisibleSelected}
              disabled={visibleOrderIds.length === 0}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => {
                event.stopPropagation()
                toggleVisibleSelection(event.target.checked)
              }}
              style={{ accentColor: 'var(--ss-blue)' }}
              className="w-3.5 h-3.5 cursor-pointer"
              aria-label="Select all visible orders"
            />
            <span className="font-mono tabular-nums">
              {visibleSelectedCount > 0
                ? `${visibleSelectedCount}/${visibleOrderIds.length}`
                : 'Select All'}
            </span>
          </label>
          )}

          <button
            id="btnSkuSort"
            type="button"
            onClick={toggleSkuSort}
            aria-pressed={skuSortActive}
            title="Sort orders by SKU groups"
            className={`
              inline-flex items-center gap-1.5
              h-8 px-2.5 rounded-lg ring-1
              text-[12px] font-medium
              transition-all duration-150
              ${skuSortActive
                ? 'bg-brand-bg ring-brand text-brand'
                : 'bg-surface ring-line text-ink-2 hover:text-ink hover:ring-line-2'}
            `}
          >
            <ListOrdered size={12.5} strokeWidth={2.25} />
            SKU Sort
            {skuSortActive ? <span className="text-brand">✓</span> : null}
          </button>

          <button
            id="exportBtn"
            type="button"
            title="Export visible orders as CSV"
            className="
              inline-flex items-center gap-1.5
              h-8 px-2.5 rounded-lg ring-1 ring-line bg-surface
              text-[12px] font-medium text-ink-2
              hover:text-ink hover:ring-line-2 active:scale-95
              transition-all duration-150
            "
            onClick={async () => {
              try {
                const { blob, filename } = await apiClient.downloadOrdersExport({
                  orderStatus: currentStatus,
                  pageSize: 5000,
                  dateFrom: dateRange.start || undefined,
                  dateTo: dateRange.end || undefined,
                })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = filename || `orders-${currentStatus}-${new Date().toISOString().slice(0, 10)}.csv`
                document.body.appendChild(a)
                a.click()
                document.body.removeChild(a)
                setTimeout(() => URL.revokeObjectURL(url), 1000)
              } catch (err) {
                console.error('[Export CSV] failed', err)
                alert('Export failed: ' + (err instanceof Error ? err.message : 'unknown error'))
              }
            }}
          >
            <Download size={12.5} strokeWidth={2.25} />
            <span className="hidden sm:inline">Export CSV</span>
          </button>

          {/* Density toggle — segmented control */}
          <div
            role="group"
            aria-label="Row density"
            title="Row density"
            className="inline-flex h-8 overflow-hidden rounded-lg ring-1 ring-line bg-surface"
          >
            {([
              { key: 'narrow', label: '≡', tip: 'Narrow rows' },
              { key: 'cozy', label: '☰', tip: 'Cozy rows (default)' },
              { key: 'wide', label: '⫿', tip: 'Wide rows' },
            ] as const).map((opt, idx, arr) => {
              const isActive = tableDensity === opt.key
              const isLast = idx === arr.length - 1
              return (
                <button
                  key={opt.key}
                  type="button"
                  title={opt.tip}
                  aria-pressed={isActive}
                  onClick={() => setTableDensity(opt.key)}
                  className={`px-2.5 text-[13px] font-bold cursor-pointer transition-colors ${isLast ? '' : 'border-r border-line'} ${isActive ? 'bg-brand text-white' : 'text-ink-3 hover:bg-surface-2 hover:text-ink'}`}
                >
                  {opt.label}
                </button>
              )
            })}
          </div>
          {currentStatus === 'awaiting_shipment' && queueToolbarProgress ? (
            <div
              id="queue-progress-indicator"
              role="status"
              aria-live="polite"
              style={{
                marginLeft: 8,
                width: 240,
                maxWidth: '34vw',
                minWidth: 170,
                padding: '5px 8px',
                border: '1px solid var(--border2)',
                borderRadius: 6,
                background: 'var(--surface)',
                boxShadow: '0 1px 2px rgba(15,23,42,.06)',
                flexShrink: 1,
                // Print Queue panel overlays at z-index 1200; lift this above
                // it so the in-progress label stays visible while a Print All
                // job is running with the panel still open.
                position: 'relative',
                zIndex: 1300,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, lineHeight: 1.2, color: 'var(--text2)', minWidth: 0 }}>
                <span style={{ fontWeight: 800, whiteSpace: 'nowrap' }}>{queueToolbarProgress.label}</span>
                <span style={{ marginLeft: 'auto', fontFamily: 'monospace', color: queueToolbarProgress.tone, whiteSpace: 'nowrap' }}>{queueToolbarProgress.pct}%</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
                <div
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={queueToolbarProgress.pct}
                  style={{ height: 5, flex: 1, minWidth: 0, background: 'var(--surface3)', borderRadius: 999, overflow: 'hidden' }}
                >
                  <div style={{ height: '100%', width: `${Math.min(100, Math.max(0, queueToolbarProgress.pct))}%`, background: queueToolbarProgress.tone, borderRadius: 999, transition: 'width .25s ease' }} />
                </div>
                <span style={{ fontSize: 10, color: 'var(--text3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 112 }}>
                  {queueToolbarProgress.detail}
                </span>
              </div>
            </div>
          ) : null}
          {currentStatus === 'awaiting_shipment' ? (
            <button
              id="picklistBtn"
              type="button"
              onClick={() => void printPicklist()}
              title="Print picklist for visible orders"
              className="
                ml-auto
                inline-flex items-center gap-1.5
                h-8 px-3 rounded-lg
                ring-1 ring-line bg-surface
                text-[12px] font-semibold text-ink-2
                hover:text-ink hover:ring-line-2 hover:bg-surface-2
                active:scale-95
                transition-all duration-150
              "
            >
              <PrinterIcon size={12.5} strokeWidth={2.25} />
              Picklist
            </button>
          ) : null}
        </div>

        <AnimatePresence>
          {dailyStats ? (
            // ─────────────────────────────────────────────────────────
            // V2-STYLE COMPACT DAILY STRIP
            //
            // Single-row horizontal layout, matching the v2original
            // boss-approved aesthetic. Replaces the previous 4-card
            // grid (Total / Need to Ship / Upcoming / Progress) which
            // took ~80px of vertical space; this version is ~36px.
            //
            // Information density preserved end-to-end:
            //   [📅 date range]  [📦 X Total Orders]  [🚚 X Need to Ship]
            //   [🔔 X Upcoming]  [X of Y shipped ████ XX%]
            //
            // Color semantics carried over from the prior grid:
            //   • Need to Ship → dailyStripProgress.needToShipColor
            //     (orange when behind, green when caught up)
            //   • Upcoming → dailyStripProgress.upcomingColor
            //   • Progress bar → dailyStripProgress.barColor
            // ─────────────────────────────────────────────────────────
            <motion.div
              id="daily-strip"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              className="bg-surface border-b border-line px-5 py-2.5 font-sans"
            >
              {/* V2-original daily strip: one tight horizontal row with
                  emoji marker, compact number/label stacks, and a small
                  progress bar. */}
              <div className="flex min-h-[50px] items-center gap-8 overflow-x-auto whitespace-nowrap text-[12px]">
                {/* Date range */}
                <div className="flex items-center gap-2 shrink-0 text-[12px]">
                  <span className="text-[15px] leading-none" aria-hidden="true">📅</span>
                  <span className="text-ink-2 font-semibold">{dailyStatsFromLabel}</span>
                  <span className="text-ink-4">→</span>
                  <span className="text-ink-2 font-semibold">{dailyStatsToLabel}</span>
                  <span className="text-ink-4 italic text-[11px]">(shifts at 6 PM CA)</span>
                </div>

                <div className="h-7 w-px shrink-0 bg-line" aria-hidden="true" />

                {/* Total Orders */}
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[19px] leading-none" aria-hidden="true">📦</span>
                  <div className="flex flex-col items-start leading-none">
                    <motion.span
                      key={dailyStats.totalOrders}
                      initial={{ opacity: 0, y: 3 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="font-bold text-ink tabular-nums text-[26px] leading-[22px] font-mono"
                    >
                      {dailyStats.totalOrders}
                    </motion.span>
                    <span className="text-[10px] leading-[11px] text-ink-3 font-medium">Total Orders</span>
                  </div>
                </div>

                {/* Need to Ship */}
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[19px] leading-none" aria-hidden="true">🚚</span>
                  <div className="flex flex-col items-start leading-none">
                    <motion.span
                      key={dailyStats.needToShip}
                      initial={{ opacity: 0, y: 3 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="font-bold tabular-nums text-[26px] leading-[22px] font-mono"
                      style={{ color: dailyStripProgress?.needToShipColor }}
                    >
                      {dailyStats.needToShip}
                    </motion.span>
                    <span className="text-[10px] leading-[11px] text-ink-3 font-medium">Need to Ship</span>
                  </div>
                </div>

                {/* Upcoming */}
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[19px] leading-none" aria-hidden="true">🔔</span>
                  <div className="flex flex-col items-start leading-none">
                    <motion.span
                      key={dailyStats.upcomingOrders}
                      initial={{ opacity: 0, y: 3 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="font-bold tabular-nums text-[26px] leading-[22px] font-mono"
                      style={{ color: dailyStripProgress?.upcomingColor }}
                    >
                      {dailyStats.upcomingOrders}
                    </motion.span>
                    <span className="text-[10px] leading-[11px] text-ink-3 font-medium">Upcoming</span>
                  </div>
                </div>

                {/* Progress — text on top, bar+% on the row below.
                    Vertical layout per boss directive 2026-05-08:
                    "58 of 63 shipped" sits on top, bar + percentage
                    on the bottom row. */}
                <div className="flex flex-col shrink-0 min-w-[285px]">
                  <span className="text-ink-3 text-[13px] tabular-nums font-medium">
                    {dailyStripProgress?.shipped} of {dailyStats.totalOrders} shipped
                  </span>
                  <div className="flex items-center gap-2.5">
                    <div className="w-[210px] h-[9px] bg-line/70 rounded-sm overflow-hidden">
                      <motion.div
                        className="h-full rounded-sm"
                        initial={{ width: 0 }}
                        animate={{ width: `${dailyStripProgress?.barFill ?? 0}%` }}
                        transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
                        style={{
                          background: `linear-gradient(90deg, ${dailyStripProgress?.barColor}, ${dailyStripProgress?.barColor}dd)`,
                          boxShadow: `0 0 6px ${dailyStripProgress?.barColor}40`,
                        }}
                      />
                    </div>
                    <motion.span
                      key={dailyStripProgress?.pct}
                      initial={{ scale: 0.85, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ type: 'spring', stiffness: 380, damping: 22 }}
                      className="font-bold tabular-nums text-[13px] shrink-0 font-mono"
                      style={{ color: dailyStripProgress?.barColor }}
                    >
                      {dailyStripProgress?.pct}%
                    </motion.span>
                  </div>
                </div>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <div className="content-split relative">
          <div className="orders-section" id="ordersSection">
            <div className="orders-wrap">
              {loading ? (
                <motion.div
                  id="loadingState"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.2 }}
                  className="p-4"
                >
                  <motion.div
                    className="space-y-2"
                    variants={{
                      hidden: {},
                      show: { transition: { staggerChildren: 0.04 } },
                    }}
                    initial="hidden"
                    animate="show"
                  >
                    {Array.from({ length: 8 }).map((_, idx) => (
                      <motion.div
                        key={idx}
                        variants={{
                          hidden: { opacity: 0, y: 6 },
                          show: { opacity: 1, y: 0 },
                        }}
                        className="flex items-center gap-3 px-3 py-2 rounded-md bg-white border border-line"
                      >
                        <div className="w-4 h-4 rounded bg-line/60 animate-pulse" />
                        <div className="w-20 h-3 rounded bg-line/60 animate-pulse" />
                        <div className="w-32 h-3 rounded bg-line/60 animate-pulse" />
                        <div className="flex-1 h-3 rounded bg-line/60 animate-pulse" />
                        <div className="w-16 h-3 rounded bg-line/60 animate-pulse" />
                        <div className="w-12 h-3 rounded bg-line/60 animate-pulse" />
                      </motion.div>
                    ))}
                  </motion.div>
                  <div className="flex items-center justify-center gap-2 text-tiny text-ink-3 mt-4 font-sans tracking-wide uppercase">
                    <Loader2 size={12} strokeWidth={2.5} className="animate-spinSlow" />
                    Loading orders
                  </div>
                </motion.div>
              ) : null}

              {!loading && error ? (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25 }}
                  className="p-8 flex flex-col items-center justify-center gap-3"
                >
                  <motion.div
                    initial={{ scale: 0.6, rotate: -8 }}
                    animate={{ scale: 1, rotate: 0 }}
                    transition={{ type: 'spring', stiffness: 320, damping: 18 }}
                    className="w-14 h-14 rounded-full bg-danger-bg ring-2 ring-danger/15 flex items-center justify-center"
                  >
                    <AlertTriangle size={26} strokeWidth={2.25} className="text-danger" />
                  </motion.div>
                  <div className="text-sm2 font-semibold text-danger font-display tracking-tight">Failed to load orders</div>
                  <div className="text-xs2 text-ink-3 max-w-md text-center leading-relaxed">{error.message}</div>
                </motion.div>
              ) : null}

              {!loading && !error && orderedFilteredOrders.length > 0 ? (
                <table
                  className={`orders-table density-${tableDensity}`}
                  id="ordersTable"
                  style={{ minWidth: tableWidth, width: tableWidth, tableLayout: 'fixed' }}
                >
                  <colgroup>
                    {visibleColumns.map((column) => (
                      <col key={column.key} style={{ width: column.width }} />
                    ))}
                  </colgroup>
                  <thead id="tableHead">
                    <tr>
                      {visibleColumns.map((column) => {
                        const sortable = column.sort != null
                        const sorted = sortable && sortState.key === column.sort
                        const headerClasses = [
                          sortable ? (sorted ? `sortable sort-${sortState.dir}` : 'sortable') : '',
                          dragColumnKey === column.key ? 'col-dragging' : '',
                          dragOverColumnKey === column.key ? 'col-drag-over' : '',
                          resizingColumnKey === column.key ? 'col-resizing' : '',
                        ].filter(Boolean).join(' ')
                        return (
                          <th
                            key={column.key}
                            data-col={column.key}
                            style={{ width: column.width, position: 'relative' }}
                            className={headerClasses || undefined}
                            draggable={column.key !== 'select'}
                            tabIndex={column.key !== 'select' ? 0 : undefined}
                            aria-sort={sortable ? (sorted ? (sortState.dir === 'asc' ? 'ascending' : 'descending') : 'none') : undefined}
                            aria-label={column.key !== 'select' ? `${column.label}. Drag to reorder. Use Alt+Arrow to move and Shift+Arrow to resize.` : undefined}
                            title={column.key !== 'select' ? 'Drag to reorder. Drag the right edge to resize. Alt+Arrow moves; Shift+Arrow resizes.' : undefined}
                            onClick={sortable ? () => handleHeaderClick(column) : undefined}
                            onKeyDown={(event) => handleHeaderKeyDown(event, column)}
                            onDragStart={(event) => handleHeaderDragStart(event, column.key)}
                            onDragOver={(event) => handleHeaderDragOver(event, column.key)}
                            onDrop={(event) => handleHeaderDrop(event, column.key)}
                            onDragEnd={finishHeaderDrag}
                          >
                            {column.label}
                            {sortable ? <span className="sort-arrow" /> : null}
                            {column.key !== 'select' ? (
                              <div
                                className={`col-resizer${resizingColumnKey === column.key ? ' active' : ''}`}
                                role="separator"
                                aria-orientation="vertical"
                                aria-label={`Resize ${column.label} column`}
                                onMouseDown={(event) => startColumnResize(event, column)}
                                onClick={(event) => event.stopPropagation()}
                                onDragStart={(event) => event.stopPropagation()}
                              />
                            ) : null}
                          </th>
                        )
                      })}
                    </tr>
                  </thead>
                  <tbody id="ordersBody">
                    {(skuSortActive ? skuOrderGroups.flatMap((group) => {
                      const groupOrderIds = group.orders.map((order) => order.orderId)
                      const allGroupSelected = groupOrderIds.length > 0 && groupOrderIds.every((orderId) => selectedIdSet.has(orderId))
                      const someGroupSelected = !allGroupSelected && groupOrderIds.some((orderId) => selectedIdSet.has(orderId))
                      const header = (
                        <tr key={`sku-group-${group.key}`} className="sku-group-header">
                          <td
                            colSpan={visibleColumns.length}
                            style={{
                              padding: '6px 12px',
                              background: 'var(--ss-blue-bg)',
                              borderTop: '2px solid var(--ss-blue)',
                              borderBottom: '1px solid var(--border)',
                              fontSize: 11.5,
                              fontWeight: 700,
                              color: 'var(--ss-blue)',
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                              {/* Lockdown — SKU group select-all also hidden
                                  on Shipped/Cancelled. Same reason as the
                                  per-row checkbox: no bulk-modify pathway. */}
                              {isReadOnly ? null : (
                              <input
                                type="checkbox"
                                checked={allGroupSelected}
                                aria-label={`Select all ${group.count} orders for ${group.sku} quantity ${group.quantity ?? 'unknown'}`}
                                ref={(node) => {
                                  if (node) node.indeterminate = someGroupSelected
                                }}
                                style={{ width: 16, height: 16, accentColor: 'var(--ss-blue)', cursor: 'pointer', flexShrink: 0 }}
                                onClick={(event) => event.stopPropagation()}
                                onChange={(event) => {
                                  event.stopPropagation()
                                  toggleSkuGroupSelection(groupOrderIds, event.target.checked)
                                }}
                              />
                              )}
                              <span style={{ fontSize: 13 }}>📦</span>
                              <span className="sku-link" style={{ fontSize: 11.5 }} title={group.sku}>{group.sku}</span>
                              <span style={{ fontWeight: 700, color: 'var(--text)' }}>
                                Qty {group.quantity ?? '-'}
                              </span>
                              <span style={{ fontWeight: 400, color: 'var(--text2)' }}>
                                {group.count.toLocaleString()} order{group.count === 1 ? '' : 's'}
                              </span>
                            </div>
                          </td>
                        </tr>
                      )

                      const rows = group.orders.map((order) => {
                        const detail = orderDetailsById.get(order.orderId) ?? null
                        const items = getActiveItems(order, detail)
                        const uniqueSkus = new Set(items.map((item) => item.sku).filter(Boolean))
                        const multiSku = uniqueSkus.size > 1
                        const isTransitioningShipped = transitionalShippedIds.has(order.orderId)
                        const rowClasses = [
                          'order-row',
                          selectedIdSet.has(order.orderId) ? 'row-selected' : '',
                          panelOrderId === order.orderId ? 'row-panel-open' : '',
                          kbRowId === order.orderId ? 'row-kb-focus' : '',
                          multiSku ? 'multi-sku-row' : '',
                          getIsException(order) ? 'row-exception' : '',
                          // 30-second continuous fade animation triggered
                          // by Print Label success. CSS keyframe is
                          // `ps-shipping-fade` in app-shell.css (visible
                          // throughout the 30s — opacity goes 1 → 0 with
                          // a 4-stop curve so the change is perceivable
                          // every few seconds, plus a slight rightward
                          // slide so the row looks like it's "leaving"
                          // toward the Shipped tab).
                          isTransitioningShipped ? 'ps-shipping-row' : '',
                        ].filter(Boolean).join(' ')
                        const clientColor = getClientPalette(order.clientName ?? 'Untagged').border
                        const expedited = getExpeditedBadge(order, detail)

                        return (
                          <tr
                            key={order.orderId}
                            id={`row-${order.orderId}`}
                            className={rowClasses}
                            style={{ borderLeft: `3px solid ${clientColor}`, background: expedited ? 'rgba(34,197,94,.08)' : undefined }}
                            onClick={() => updateSelection([order.orderId])}
                            onDoubleClick={() => openShipStationOrder(order.orderId)}
                            onMouseEnter={() => setKbRowId(order.orderId)}
                          >
                            {visibleColumns.map((column) => (
                              <td
                                key={column.key}
                                data-col={column.key}
                                title={column.key === 'select' ? 'Use checkbox for multi-select' : 'Select only this order and view details'}
                              >
                                {renderTableCell(order, column)}
                              </td>
                            ))}
                          </tr>
                        )
                      })

                      return [header, ...rows]
                    }) : orderedFilteredOrders.map((order) => {
                      const detail = orderDetailsById.get(order.orderId) ?? null
                      const items = getActiveItems(order, detail)
                      const uniqueSkus = new Set(items.map((item) => item.sku).filter(Boolean))
                      const multiSku = uniqueSkus.size > 1
                      const rowClasses = [
                        'order-row',
                        selectedIdSet.has(order.orderId) ? 'row-selected' : '',
                        panelOrderId === order.orderId ? 'row-panel-open' : '',
                        kbRowId === order.orderId ? 'row-kb-focus' : '',
                        multiSku ? 'multi-sku-row' : '',
                        getIsException(order) ? 'row-exception' : '',
                      ].filter(Boolean).join(' ')
                      const clientColor = getClientPalette(order.clientName ?? 'Untagged').border
                      const expedited = getExpeditedBadge(order, detail)

                      return (
                        <tr
                          key={order.orderId}
                          id={`row-${order.orderId}`}
                          className={rowClasses}
                          style={{ borderLeft: `3px solid ${clientColor}`, background: expedited ? 'rgba(34,197,94,.08)' : undefined }}
                          onClick={() => updateSelection([order.orderId])}
                          onDoubleClick={() => openShipStationOrder(order.orderId)}
                          onMouseEnter={() => setKbRowId(order.orderId)}
                        >
                          {visibleColumns.map((column) => (
                            <td
                              key={column.key}
                              data-col={column.key}
                              title={column.key === 'select' ? 'Use checkbox for multi-select' : 'Select only this order and view details'}
                            >
                              {renderTableCell(order, column)}
                            </td>
                          ))}
                        </tr>
                      )
                    }))}
                  </tbody>
                </table>
              ) : null}

              {!loading && !error && orderedFilteredOrders.length === 0 ? (
                <motion.div
                  id="emptyState"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                  className="flex flex-col items-center justify-center gap-3 py-16 px-6"
                >
                  <motion.div
                    initial={{ scale: 0.5, rotate: -10 }}
                    animate={{ scale: 1, rotate: 0 }}
                    transition={{ type: 'spring', stiffness: 280, damping: 14, delay: 0.05 }}
                    className="w-16 h-16 rounded-2xl bg-gradient-to-br from-slate-100 to-slate-200 ring-1 ring-line flex items-center justify-center"
                  >
                    <Inbox size={30} strokeWidth={2} className="text-ink-3" />
                  </motion.div>
                  <div className="text-sm font-semibold text-ink font-display tracking-tight mt-1">No orders match</div>
                  <div className="text-xs2 text-ink-3 max-w-sm text-center leading-relaxed">
                    Try clearing the search, broadening your date range, or selecting a different status.
                  </div>
                </motion.div>
              ) : null}
            </div>
          </div>

          {/* Right-side detail panel — drawer-style hide/show.
              Hidden when: pref is true AND nothing is selected.
              Reappears: when row clicked OR batch selection grows ≥ 2.
              When hidden, a vertical "Show panel" tab on the right edge
              lets the user reopen it without going to the topbar toggle. */}
          {hideEmptyPanel && panelOrderId == null && selectedOrderIds.length < 2 ? (
            // Vertical edge tab — small persistent reopen control on the
            // right edge of the orders area. Tailwind-only; the rotated
            // text reads bottom-to-top, click to flip the pref back to
            // "show". Mirrors the close-button in the panel header so
            // users have a visible way to undo their hide action.
            onHideEmptyPanelChange ? (
              <button
                type="button"
                onClick={() => onHideEmptyPanelChange(false)}
                aria-label="Show order detail panel"
                title="Show order detail panel"
                className="absolute top-1/2 right-0 -translate-y-1/2 z-10 inline-flex items-center justify-center px-1.5 py-3 rounded-l-lg bg-surface ring-1 ring-line border-r-0 text-ink-3 hover:text-brand hover:bg-brand/5 hover:ring-brand/30 transition-all duration-150 shadow-sm group"
              >
                <span className="flex flex-col items-center gap-1 [writing-mode:vertical-rl] rotate-180 text-[10.5px] font-semibold uppercase tracking-[0.08em] select-none">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="rotate-90 group-hover:-translate-x-0.5 transition-transform" aria-hidden="true">
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                  Show panel
                </span>
              </button>
            ) : null
          ) : (
            <div className="order-panel" id="orderPanel">
              <div className="panel-inner" id="panelInner">
                {activeOrderId == null && selectedOrderIds.length >= 2 ? renderBatchPanel() : renderSinglePanel()}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="pagination-bar !flex !items-center !gap-2 !px-4 !py-2 !bg-white !border-t !border-line" id="paginationBar">
        <button
          className="btn btn-outline btn-sm !transition-all !duration-150 hover:!shadow-sm hover:!-translate-y-px active:!translate-y-0 active:!scale-95 disabled:!opacity-40 disabled:hover:!translate-y-0 disabled:hover:!shadow-none disabled:!cursor-not-allowed"
          type="button"
          id="prevBtn"
          disabled={currentPage <= 1}
          aria-label="Previous page"
          onClick={() => setPage((current) => Math.max(1, current - 1))}
        >
          ← Prev
        </button>
        <span id="pageInfo" className="text-tiny text-ink-2 font-mono tabular-nums">
          Page <span className="font-bold text-ink">{pages === 0 ? 0 : currentPage}</span> <span className="text-ink-3">of</span> <span className="font-bold text-ink">{pages || 0}</span>
        </span>
        <span className="w-px h-4 bg-line-2" aria-hidden />
        <span id="totalInfo" className="text-tiny text-ink-3 font-mono tabular-nums">
          <span className="font-semibold text-ink-2">{total.toLocaleString()}</span> total
        </span>

        {/* Page-size selector — operator picks 25/50/100/200 rows per
            page. Choice persists to localStorage. Sits in the
            pagination bar between "total" and "Next →" so it's visible
            without being in the way of the primary nav controls. */}
        <span className="w-px h-4 bg-line-2 ml-2" aria-hidden />
        <label className="inline-flex items-center gap-1.5 text-tiny text-ink-3 font-medium">
          <span className="hidden sm:inline">Per page:</span>
          <span className="relative inline-flex items-center">
            <select
              value={pageSize}
              onChange={(event) => updatePageSize(Number(event.target.value))}
              aria-label="Rows per page"
              className="
                appearance-none cursor-pointer
                h-7 pl-2.5 pr-6
                rounded-md
                bg-surface ring-1 ring-line
                text-[12px] font-semibold text-ink-2 tabular-nums
                hover:text-ink hover:ring-line-2
                focus:bg-surface focus:ring-2 focus:ring-brand/40
                focus:outline-none
                transition-all duration-150
              "
            >
              {ALLOWED_PAGE_SIZES.map((size) => (
                <option key={size} value={size}>{size}</option>
              ))}
            </select>
            <span
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-ink-3 text-[8px] pointer-events-none"
              aria-hidden
            >▼</span>
          </span>
        </label>

        <button
          className="btn btn-outline btn-sm !ml-auto !transition-all !duration-150 hover:!shadow-sm hover:!-translate-y-px active:!translate-y-0 active:!scale-95 disabled:!opacity-40 disabled:hover:!translate-y-0 disabled:hover:!shadow-none disabled:!cursor-not-allowed"
          type="button"
          id="nextBtn"
          disabled={pages === 0 || currentPage >= pages}
          aria-label="Next page"
          onClick={() => setPage((current) => Math.min(pages, current + 1))}
        >
          Next →
        </button>
      </div>

      {queueOpen ? (
        <div
          id="print-queue-panel"
          style={{
            display: 'grid',
            gridTemplateRows: queuePrintMessage ? 'auto auto auto auto 1fr auto' : 'auto auto auto 1fr auto',
            position: 'fixed',
            top: 56,
            right: 12,
            bottom: 12,
            width: 520,
            maxWidth: 'calc(100vw - 24px)',
            background: 'var(--surface)',
            border: '1px solid var(--border2)',
            borderRadius: 10,
            boxShadow: '0 8px 32px rgba(var(--shadow-color, 15 23 42), .18)',
            zIndex: 1200,
            overflow: 'hidden',
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-line">
            <strong className="text-ink text-[13px]">Print Queue</strong>
            <div className="flex gap-1.5">
              <button
                className="btn btn-ghost btn-xs"
                type="button"
                id="pq-history-btn"
                onClick={() => setQueueHistoryVisible((value) => !value)}
              >
                {queueHistoryVisible ? '🔼 Hide History' : '🕐 History'}
              </button>
              <button
                className="btn btn-ghost btn-xs"
                type="button"
                onClick={() =>
                  queueClientId != null
                    ? void apiClient
                        .clearQueue(queueClientId)
                        .then(() => hydrateQueue())
                        .catch((error) => showToast(error instanceof Error ? error.message : 'Failed to clear queue', 'error'))
                    : undefined
                }
              >
                🗑️ Clear
              </button>
              <button className="btn btn-ghost btn-xs" type="button" onClick={() => setQueueOpen(false)}>
                ✕
              </button>
            </div>
          </div>

          {/* Search + sort row */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
            <div className="relative flex-1">
              <SearchIcon
                size={12}
                strokeWidth={2.25}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none"
                aria-hidden
              />
              <input
                type="text"
                id="pq-search"
                value={pqSearch}
                onChange={(event) => setPqSearch(event.target.value)}
                placeholder="Search order # or ID…"
                aria-label="Search Print Queue"
                className="
                  w-full h-8 pl-8 pr-7 rounded-lg
                  bg-surface-2 ring-1 ring-line
                  text-[12px] text-ink placeholder:text-ink-3
                  focus:bg-surface focus:ring-2 focus:ring-brand/40
                  focus:outline-none transition-all duration-150
                "
              />
              {pqSearch ? (
                <button
                  type="button"
                  onClick={() => setPqSearch('')}
                  aria-label="Clear search"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded-md flex items-center justify-center text-ink-3 hover:text-ink hover:bg-line/40 active:scale-90 transition-all duration-150"
                >
                  <XIcon size={11} strokeWidth={2.5} />
                </button>
              ) : null}
            </div>
            {queueHistoryVisible ? (
              <button
                type="button"
                onClick={() => setPqHistoryAsc((v) => !v)}
                aria-label={pqHistoryAsc ? 'History sorted oldest first — switch to newest first' : 'History sorted newest first — switch to oldest first'}
                title={pqHistoryAsc ? 'Sort: Oldest → Newest (click for newest first)' : 'Sort: Newest → Oldest (click for oldest first)'}
                className="
                  inline-flex items-center gap-1 h-8 px-2.5 rounded-lg
                  ring-1 ring-line bg-surface
                  text-[11.5px] font-mono text-ink-2
                  hover:text-ink hover:ring-line-2 active:scale-95
                  transition-all duration-150
                "
              >
                <span>{pqHistoryAsc ? '↑ Oldest' : '↓ Newest'}</span>
              </button>
            ) : null}
          </div>

          <div id="pq-summary" className="flex gap-3 px-3 py-2 border-b border-line text-[11px] text-ink-2">
            <div><span className="font-semibold text-ink">{queueCount}</span> Orders</div>
            <div><span className="font-semibold text-ink">{queuedEntries.reduce((sum, entry) => sum + (entry.order_qty ?? 1), 0)}</span> Total Qty</div>
            <div><span className="font-semibold text-ink">{visibleQueueGroups.length}</span> SKU Groups</div>
            {pqSearchLower ? (
              <div className="ml-auto text-ink-3 italic">filtered</div>
            ) : null}
          </div>
          {queuePrintMessage ? (
            <div id="pq-progress" style={{ padding: '8px 12px', fontSize: 11, borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: 1 }}>{queuePrintMessage}</span>
                <span style={{ fontFamily: 'monospace', color: 'var(--ss-blue)', fontWeight: 700 }}>{queuePrintProgress ?? 0}%</span>
              </div>
              <div style={{ height: 5, marginTop: 6, background: 'var(--surface3)', borderRadius: 999, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.min(100, Math.max(0, queuePrintProgress ?? 0))}%`, background: 'var(--ss-blue)', borderRadius: 999, transition: 'width .25s ease' }} />
              </div>
            </div>
          ) : null}
          <div id="pq-order-list" style={{ overflowY: 'auto', overflowX: 'hidden', padding: 12, minHeight: 0 }}>
            {queueLoading && !queueHasVisibleEntries ? <div className="empty-state">Loading queue…</div> : null}
            {!queueLoading && !queueHasVisibleEntries ? (
              <div className="pq-empty">
                {pqSearchLower
                  ? <>🔍 No matches for <strong>"{pqSearch}"</strong><br /><small>Clear the search to see all entries.</small></>
                  : <>📭 Queue is empty<br /><small>Click "Send to Queue" on any order with a label</small></>}
              </div>
            ) : null}
            {visibleQueueGroups.map((group) => (
              <div
                key={group.groupId}
                className="pq-group mb-3 overflow-hidden rounded-xl bg-surface ring-1 ring-line shadow-sm"
              >
                <div className="pq-group-header flex items-center gap-2 px-3 py-2.5 bg-surface-2 border-b border-line">
                  <span className="pq-group-label flex-1 min-w-0 truncate font-semibold text-ink text-[12.5px]">
                    {group.label}{group.description ? ` — ${group.description}` : ''}
                  </span>
                  <span className="pq-group-meta hidden sm:inline-flex items-center gap-1 text-[10.5px] font-medium text-ink-3 uppercase tracking-wide">
                    {group.orders.length} order{group.orders.length === 1 ? '' : 's'} · Qty {group.perOrderQty} ea
                  </span>
                  <button
                    className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md bg-brand text-white text-[11px] font-semibold shadow-sm hover:opacity-90 active:opacity-100 transition"
                    type="button"
                    onClick={() => void printQueueEntries(group.orders.map((entry) => entry.queue_entry_id))}
                  >
                    🖨️ Print Group
                  </button>
                </div>
                <div className="pq-group-orders flex flex-col gap-1.5 p-2 bg-page/40">
                  {group.orders.map((entry) => {
                    const numericOrderId = Number.parseInt(String(entry.order_id), 10)
                    const orderClickable = Number.isFinite(numericOrderId) && numericOrderId > 0
                    return (
                      <div
                        key={entry.queue_entry_id}
                        className="pq-order-row group/row flex items-center gap-2 px-3 py-2 rounded-lg bg-surface ring-1 ring-line hover:ring-brand/40 hover:shadow-sm transition"
                      >
                        <button
                          type="button"
                          className="pq-order-num flex-1 min-w-0 text-left font-mono text-[12px] text-brand truncate disabled:cursor-default disabled:no-underline hover:underline underline-offset-2"
                          disabled={!orderClickable}
                          title={orderClickable ? 'View order details' : undefined}
                          onClick={(event) => {
                            event.stopPropagation()
                            if (orderClickable) openDetailDrawer(numericOrderId, true)
                          }}
                        >
                          Order #{entry.order_number || entry.order_id}
                          {entry.print_count > 0 ? (
                            <span className="ml-1.5 inline-flex items-center px-1.5 py-px rounded-sm bg-amber-100 text-amber-800 text-[9.5px] font-semibold uppercase tracking-wide">
                              Reprint #{entry.print_count}
                            </span>
                          ) : null}
                        </button>
                        <span className="pq-order-qty inline-flex items-center px-1.5 py-0.5 rounded-md bg-surface-2 text-ink-2 text-[10.5px] font-semibold tabular-nums ring-1 ring-line/70">
                          Qty {entry.order_qty ?? 1}
                        </span>
                        <span className="pq-order-time text-[10.5px] text-ink-3 tabular-nums">
                          {new Date(entry.queued_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        <button
                          className="pq-remove-btn inline-flex items-center justify-center w-6 h-6 rounded-md text-ink-3 hover:text-rose-600 hover:bg-rose-50 ring-1 ring-transparent hover:ring-rose-200 transition opacity-60 group-hover/row:opacity-100"
                          type="button"
                          title="Remove from queue"
                          onClick={() => queueClientId != null
                            ? void apiClient.removeFromQueue(entry.queue_entry_id, queueClientId)
                                .then(() => hydrateQueue())
                                .catch((error) => showToast(error instanceof Error ? error.message : 'Failed to remove queue entry', 'error'))
                            : undefined}
                        >
                          ✕
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
            {visiblePrintedEntries.length > 0 ? (
              <div className="mt-3 pt-3 border-t border-line">
                <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-ink-3">
                  <span>📋 Printed History</span>
                  <span className="inline-flex items-center px-1.5 py-px rounded-sm bg-surface-2 text-ink-2 text-[10px] tabular-nums ring-1 ring-line/70">
                    {visiblePrintedEntries.length}
                    {pqSearchLower && visiblePrintedEntries.length !== printedEntries.length ? ` / ${printedEntries.length}` : ''}
                  </span>
                </div>
                <div className="flex flex-col gap-1.5">
                  {visiblePrintedEntries.map((entry) => {
                    const numericOrderId = Number.parseInt(String(entry.order_id), 10)
                    const orderClickable = Number.isFinite(numericOrderId) && numericOrderId > 0
                    return (
                      <div
                        key={entry.queue_entry_id}
                        className="pq-order-row flex items-center gap-2 px-3 py-2 rounded-lg bg-surface/80 ring-1 ring-line hover:ring-brand/30 hover:bg-surface transition"
                      >
                        <button
                          type="button"
                          className="pq-order-num flex-1 min-w-0 text-left font-mono text-[12px] text-brand truncate disabled:cursor-default disabled:no-underline hover:underline underline-offset-2"
                          disabled={!orderClickable}
                          title={orderClickable ? 'View order details' : undefined}
                          onClick={(event) => {
                            event.stopPropagation()
                            if (orderClickable) openDetailDrawer(numericOrderId, true)
                          }}
                        >
                          Order #{entry.order_number || entry.order_id}
                        </button>
                        <span className="pq-order-qty inline-flex items-center px-1.5 py-0.5 rounded-md bg-surface-2 text-ink-2 text-[10.5px] font-semibold tabular-nums ring-1 ring-line/70">
                          Qty {entry.order_qty ?? 1}
                        </span>
                        <span className="pq-order-time inline-flex items-center gap-1 text-[10.5px] text-ink-3 tabular-nums">
                          <span className="text-emerald-600">✓</span>
                          {entry.last_printed_at ? new Date(entry.last_printed_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : null}
          </div>
          <div style={{ display: 'flex', gap: 8, padding: 12, borderTop: '1px solid var(--border)' }}>
            {/* Print All hidden while History is being viewed (it would print
                from the active queue, which is irrelevant in history view). */}
            {!queueHistoryVisible ? (
              <button
                className="btn btn-primary btn-sm"
                id="pq-print-all-btn"
                type="button"
                disabled={queueCount === 0 || queuePrintInFlight}
                onClick={() => void printQueueEntries(queuedEntries.map((entry) => entry.queue_entry_id))}
              >
                🖨️ Print All
              </button>
            ) : (
              <div className="text-[11px] text-ink-3 italic px-1">
                Viewing history · {visiblePrintedEntries.length}{pqSearchLower && visiblePrintedEntries.length !== printedEntries.length ? ` of ${printedEntries.length}` : ''} record{printedEntries.length === 1 ? '' : 's'}
              </div>
            )}
          </div>
        </div>
      ) : null}

      <OrderDetailDrawer
        orderId={detailDrawerOrderId}
        displayStatus={currentStatus}
        presentation={detailDrawerFromQueue ? 'modal' : 'drawer'}
        closeLabel={detailDrawerFromQueue ? 'Back' : undefined}
        closeTitle={detailDrawerFromQueue ? 'Back to print queue' : undefined}
        onClose={closeDetailDrawer}
      />

      <TrackingModal
        open={trackingModal != null}
        trackingNumber={trackingModal?.tracking ?? null}
        carrierCode={trackingModal?.carrierCode ?? null}
        onClose={() => setTrackingModal(null)}
      />

      {rateBrowserOpen ? (
        <Suspense fallback={null}>
          <RateBrowserModal
            open={rateBrowserOpen}
            order={panelOrder}
            locations={locations}
            packages={packages}
            shippingAccounts={panelOrder && isTestOrder(panelOrder, panelDetail) ? buildTestRateBrowserAccounts() : shippingAccounts}
            testMode={Boolean(panelOrder && isTestOrder(panelOrder, panelDetail))}
            initialDims={{
              length: Number.parseFloat(panelForm.length) || 0,
              width: Number.parseFloat(panelForm.width) || 0,
              height: Number.parseFloat(panelForm.height) || 0,
            }}
            initialWeight={{
              lb: Number.parseFloat(panelForm.weightLb) || 0,
              oz: Number.parseFloat(panelForm.weightOz) || 0,
            }}
            onClose={() => setRateBrowserOpen(false)}
            onBestRateResolved={(best) => {
              if (!panelOrderId) return
              if (panelOrder && isTestOrder(panelOrder, panelDetail)) {
                const testRate = buildTestMockRate(best)
                setPanelRatePreview([testRate])
                setPanelForm((current) => ({
                  ...current,
                  shipAccountId: TEST_CARRIER_CODE,
                  serviceCode: testRate.serviceCode,
                }))
                const dims = best.dims
                const dimsLabel = dims
                  ? `${dims.length || 0}x${dims.width || 0}x${dims.height || 0}`
                  : `${panelForm.length || 0}x${panelForm.width || 0}x${panelForm.height || 0}`
                void apiClient
                  .saveOrderBestRate(panelOrderId, testRate, dimsLabel)
                  .then(() => refetchOrders())
                  .catch((error) => {
                    showToast(error instanceof Error ? error.message : 'Failed to save test mock rate', 'error')
                  })
                return
              }
              setPanelRatePreview([best])
              const shippingProviderId = toNumberValue(best.shippingProviderId)
              const serviceCode = toStringValue(best.serviceCode)
              if (shippingProviderId != null && serviceCode) {
                setPanelForm((current) => ({
                  ...current,
                  shipAccountId: String(shippingProviderId),
                  serviceCode,
                  weightLb: best.weight ? String(best.weight.lb ?? current.weightLb) : current.weightLb,
                  weightOz: best.weight ? String(best.weight.oz ?? current.weightOz) : current.weightOz,
                  length: best.dims ? String(best.dims.length ?? current.length) : current.length,
                  width: best.dims ? String(best.dims.width ?? current.width) : current.width,
                  height: best.dims ? String(best.dims.height ?? current.height) : current.height,
                }))
                void apiClient.setOrderSelectedPid(panelOrderId, shippingProviderId)
              }
              const dims = best.dims
              const dimsLabel = dims
                ? `${dims.length || 0}x${dims.width || 0}x${dims.height || 0}`
                : `${panelForm.length || 0}x${panelForm.width || 0}x${panelForm.height || 0}`
              void apiClient
                .saveOrderBestRate(panelOrderId, best, dimsLabel)
                .then(() => refetchOrders())
                .catch((error) => {
                  showToast(error instanceof Error ? error.message : 'Failed to save best rate', 'error')
                })
            }}
            onApplyRate={(applied) => {
              // Push rate back into the panel using the existing applyRateSelection
              // path. The v2-style modal also returns weight + dims; sync those to
              // the panel form so /labels/create sees the user's final numbers.
              if (applied.weight) {
                setPanelForm((current) => ({
                  ...current,
                  weightLb: String(applied.weight?.lb ?? current.weightLb),
                  weightOz: String(applied.weight?.oz ?? current.weightOz),
                }))
              }
              if (applied.dims) {
                setPanelForm((current) => ({
                  ...current,
                  length: String(applied.dims?.length ?? current.length),
                  width: String(applied.dims?.width ?? current.width),
                  height: String(applied.dims?.height ?? current.height),
                }))
              }
              applyRateSelection(applied)
            }}
          />
        </Suspense>
      ) : null}
    </>
  )
}
