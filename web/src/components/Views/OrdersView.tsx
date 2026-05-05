// @ts-nocheck
import './OrdersView.css'
import { lazy, Suspense, useContext, useEffect, useMemo, useRef, useState } from 'react'
import OrderDetailDrawer from '../OrderDetailDrawer'
import TrackingModal from '../TrackingModal'
import HoverImage from '../HoverImage'
import { apiClient } from '../../api/client'
import { TEST_CLIENT_IDS } from '../../lib/v2-apiClient'
const RateBrowserModal = lazy(() => import('../RateBrowserModal'))
import { ToastContext } from '../../contexts/ToastContext'
import { useLocations, useOrderDetail, useOrders, useShippingAccounts } from '../../hooks'
import { useMarkups } from '../../contexts/MarkupsContext'
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
  showTestOrders?: boolean
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

function formatDateTime(value: string | null | undefined) {
  if (!value) return '—'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return '—'
  // v2 parity: order_date is a naive ShipStation wall-clock string (the DR
  // Prepper SS account runs in Pacific Time). v2 stored the raw string as
  // TEXT so any browser displayed the original clock face unchanged. v4
  // stores it as timestamptz with the naive value stamped Z, so we render
  // in UTC here to reproduce that same clock face regardless of the
  // viewer's local zone. Without this, an Asia-Pacific viewer sees times
  // shifted by 7-8 hours.
  const opts = { timeZone: 'UTC' } as const
  const date = parsed.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit', ...opts })
  const time = parsed.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, ...opts })
  return `${date} ${time}`
}

function formatLabelCreated(value: string | null | undefined) {
  if (!value) return '—'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return '—'
  const month = parsed.toLocaleDateString('en-US', { month: 'short' })
  const day = parsed.getDate()
  const time = parsed.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase()
  return `${month} ${day}, ${time}`
}

function formatDateOnly(value: string | null | undefined, options?: Intl.DateTimeFormatOptions) {
  if (!value) return '—'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return '—'
  return parsed.toLocaleDateString('en-US', options)
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

function buildEmptyPanel() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        padding: '40px 20px',
        textAlign: 'center',
        color: 'var(--text3)',
      }}
    >
      <div style={{ fontSize: 36, marginBottom: 14, opacity: 0.5 }}>📋</div>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: 'var(--text2)' }}>No order selected</div>
      <div style={{ fontSize: 12, lineHeight: 1.5, marginBottom: 20 }}>Click any row to view details</div>
      <div
        style={{
          textAlign: 'left',
          fontSize: 11,
          lineHeight: 2,
          color: 'var(--text4)',
          borderTop: '1px solid var(--border)',
          paddingTop: 14,
          width: '100%',
          maxWidth: 180,
        }}
      >
        <div><kbd style={{ background: 'var(--surface3)', padding: '1px 5px', borderRadius: 3, fontSize: 10, border: '1px solid var(--border2)' }}>↑↓</kbd> Navigate rows</div>
        <div><kbd style={{ background: 'var(--surface3)', padding: '1px 5px', borderRadius: 3, fontSize: 10, border: '1px solid var(--border2)' }}>Enter</kbd> Select / deselect</div>
        <div><kbd style={{ background: 'var(--surface3)', padding: '1px 5px', borderRadius: 3, fontSize: 10, border: '1px solid var(--border2)' }}>Esc</kbd> Deselect &amp; close</div>
        <div><kbd style={{ background: 'var(--surface3)', padding: '1px 5px', borderRadius: 3, fontSize: 10, border: '1px solid var(--border2)' }}>⌘C</kbd> Copy order #</div>
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
  showTestOrders = true,
  stores = [],
}: OrdersViewProps) {
  const toastContext = useContext(ToastContext)
  const [page, setPage] = useState(1)
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
  const [batchBusy, setBatchBusy] = useState(false)
  const [batchTestMode, setBatchTestMode] = useState(false)
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

  const hideTestOrdersInAllAwaiting =
    currentStatus === 'awaiting_shipment' && activeStore == null && !showTestOrders

  const { orders, total, pages, currentPage, loading, error, refetch: refetchOrders } = useOrders(currentStatus, {
    page,
    pageSize: 50,
    storeId: activeStore ?? undefined,
    dateStart: dateRange.start,
    dateEnd: dateRange.end,
    hideTestOrders: hideTestOrdersInAllAwaiting,
    search: searchQuery,
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

  const skuOptions = useMemo(() => {
    const skus = new Set<string>()
    for (const order of orders) {
      for (const item of normalizeItems(order.items)) {
        if (item.adjustment || !item.sku) continue
        skus.add(item.sku)
      }
    }
    return [...skus].sort((left, right) => left.localeCompare(right))
  }, [orders])

  const searchedOrders = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    return orders.filter((order) => {
      const detail = orderDetailsById.get(order.orderId) ?? null
      if (hideTestOrdersInAllAwaiting && isTestOrder(order, detail)) return false
      if (query && !buildSearchText(order, detail).includes(query)) return false
      if (skuFilter) {
        const items = getActiveItems(order, detail)
        if (!items.some((item) => item.sku === skuFilter)) return false
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
  const dailyStatsFromLabel = dailyStats?.window.fromLabel || dailyStats?.window.from || ''
  const dailyStatsToLabel = dailyStats?.window.toLabel || dailyStats?.window.to || ''
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

  // Auto-refresh the panel's best rate whenever weight or any dimension
  // changes. Debounced so a user typing "1 → 12 → 125" doesn't fire three
  // separate /rates calls. refreshPanelBestRate already toggles
  // panelRateLoading and uses bestRateRefreshSeqRef to ignore stale results
  // when the inputs change again before a fetch completes.
  useEffect(() => {
    if (!panelOrder || panelOrder.orderStatus !== 'awaiting_shipment') return
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
    if (!panelOrder) return

    try {
      await apiClient.markOrderShippedExternal(panelOrder.orderId, source)
      showToast(`✅ Marked shipped via ${source}`, 'success')
      clearSelection()
      await refetchOrders()
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to mark shipped', 'error')
    }
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
    await refetchOrders()
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
  const queueHasVisibleEntries = queueGroups.length > 0 || printedEntries.length > 0
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
    // If the user is actively re-typing weight/dims in the panel for this
    // exact order, the saved bestRate on the row is stale until the debounced
    // /rates fetch lands. Show the spinner so the row visibly reflects the
    // recalculation in progress instead of flashing the old number.
    if (panelRateLoading && panelOrder?.orderId === order.orderId) {
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
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {selectedRateCarrierCode ? (
            <span className={`carrier-badge ${getCarrierClass(selectedRateCarrierCode)}`} style={{ fontSize: 9.5, padding: '1px 5px' }}>
              {formatCarrierCode(selectedRateCarrierCode)}
            </span>
          ) : null}
          {renderRateAmountWithMarkup(selectedRateBase, labelCost ?? selectedRateBase)}
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
      <div style={{ lineHeight: 1.3, textAlign: 'right' }}>
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
          textAlign: options.align ?? 'center',
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
    const primaryItem = items[0] ?? null
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
      case 'customer':
        return <div className="customer-name">{shipTo.name ?? '—'}</div>
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
          <div style={{ textAlign: 'center', fontWeight: 700, color: 'var(--text2)' }}>
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
          <button className="panel-close" type="button" onClick={clearSelection}>✕</button>
        </div>

        <div className="panel-body">
          <div className="panel-section">
            <div className="panel-section-header">
              <span className="panel-section-title">Batch Actions</span>
            </div>
            <div className="panel-section-body">
              <div style={{ padding: 12, borderBottom: '1px solid var(--border)', marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 6 }}>Selected orders:</div>
                <div style={{ fontSize: 12, fontFamily: 'monospace', color: 'var(--text2)', lineHeight: 1.4, wordBreak: 'break-all' }}>
                  {selectedOrders.map((order) => order.orderNumber ?? `#${order.orderId}`).sort().join(', ')}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button className="create-label-btn" type="button" style={{ flex: 1 }} onClick={() => void handleBatchAction('print')} disabled={batchBusy}>
                  🖨️ Create + Print Label
                </button>
                <button
                  className="create-label-btn"
                  type="button"
                  style={{ flex: 1, background: '#16a34a' }}
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
    if (!panelOrder) return buildEmptyPanel()

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
        <div className="panel-topbar">
          <button
            type="button"
            onClick={() => {
              if (prevOrderId == null) return
              openOrderDetails(prevOrderId)
            }}
            style={{
              background: 'none',
              border: 'none',
              cursor: prevOrderId != null ? 'pointer' : 'default',
              color: prevOrderId != null ? 'var(--text2)' : 'var(--text4)',
              fontSize: 14,
              padding: '2px 4px',
              borderRadius: 4,
            }}
            title="Previous order"
            disabled={prevOrderId == null}
          >
            ‹
          </button>
          <button
            type="button"
            onClick={() => {
              if (nextOrderId == null) return
              openOrderDetails(nextOrderId)
            }}
            style={{
              background: 'none',
              border: 'none',
              cursor: nextOrderId != null ? 'pointer' : 'default',
              color: nextOrderId != null ? 'var(--text2)' : 'var(--text4)',
              fontSize: 14,
              padding: '2px 4px',
              borderRadius: 4,
            }}
            title="Next order"
            disabled={nextOrderId == null}
          >
            ›
          </button>
          <div className="panel-ordnum">
            <span className="od-order-link" title="Keep order selected">{panelOrder.orderNumber ?? `#${panelOrder.orderId}`}</span>{' '}
            <span style={{ fontSize: 10, fontWeight: 500, color: 'var(--text3)' }}>
              {panelIndex >= 0 ? `${panelIndex + 1}/${orderedFilteredOrders.length}` : ''}
            </span>
          </div>
          <div style={{ position: 'relative' }}>
            <button className="panel-topbar-btn" type="button" onClick={() => setBatchMenuOpen((open) => !open)}>Batch ▾</button>
            {batchMenuOpen ? (
              <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 7, boxShadow: '0 4px 16px rgba(0,0,0,.15)', zIndex: 999, minWidth: 200, padding: '4px 0', fontSize: 12.5 }}>
                <button className="panel-topbar-btn" type="button" style={{ width: '100%', justifyContent: 'flex-start', border: 'none' }} onClick={() => { setBatchMenuOpen(false); updateSelection([panelOrder.orderId, ...selectedOrderIds.filter((id) => id !== panelOrder.orderId)]) }}>📦 Add to Batch Queue</button>
                <button className="panel-topbar-btn" type="button" style={{ width: '100%', justifyContent: 'flex-start', border: 'none' }} onClick={() => { setBatchMenuOpen(false); void queueExistingLabels([panelOrder.orderId]) }}>🔄 Quick Reprint (Batch)</button>
              </div>
            ) : null}
          </div>
          <div style={{ position: 'relative' }}>
            <button className="panel-topbar-btn" type="button" onClick={() => setPrintMenuOpen((open) => !open)}>Print ▾</button>
            {printMenuOpen ? (
              <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 7, boxShadow: '0 4px 16px rgba(0,0,0,.15)', zIndex: 999, minWidth: 180, padding: '4px 0', fontSize: 12.5 }}>
                {shipped && trackingNumber ? (
                  <button className="panel-topbar-btn" type="button" style={{ width: '100%', justifyContent: 'flex-start', border: 'none' }} onClick={() => { setPrintMenuOpen(false); void reprintLabel() }}>🖨️ Reprint Label</button>
                ) : (
                  <button className="panel-topbar-btn" type="button" style={{ width: '100%', justifyContent: 'flex-start', border: 'none' }} onClick={() => { setPrintMenuOpen(false); void createOrQueueLabel('test') }}>📄 Create Test Label</button>
                )}
              </div>
            ) : null}
          </div>
          <a
            className="panel-topbar-btn"
            href={`https://ship.shipstation.com/orders/${panelOrder.orderId}`}
            target="_blank"
            rel="noreferrer"
            style={{ textDecoration: 'none', fontSize: 10, color: 'var(--text3)' }}
            title="Open in ShipStation"
          >
            ↗ SS
          </a>
          {shipped ? null : (
            <div style={{ position: 'relative' }}>
              <button className="panel-topbar-btn" type="button" style={{ color: '#b45309', borderColor: '#fbbf24' }} onClick={() => setExtShipMenuOpen((open) => !open)}>
                ✈ Mark as Shipped
              </button>
              {extShipMenuOpen ? (
                <div style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, background: 'var(--surface)', border: '1px solid var(--border2)', borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,.15)', zIndex: 999, minWidth: 150, overflow: 'hidden', fontSize: 12.5 }}>
                  {['Shopify', 'Amazon', 'Walmart', 'eBay', 'Etsy', 'Other'].map((source) => (
                    <button key={source} type="button" style={{ display: 'block', width: '100%', padding: '8px 14px', textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer' }} onClick={() => { setExtShipMenuOpen(false); void markOrderShippedExternal(source) }}>
                      {source}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          )}
          <button className="panel-close" type="button" onClick={closeSinglePanel}>✕</button>
        </div>

        <div className="panel-body">
          <div className={`panel-section${collapsedSections.shipping ? ' collapsed' : ''}`} id="sec-shipping">
            <div className="panel-section-header" onClick={() => toggleSection('shipping')}>
              <span className="panel-section-arrow">▶</span>
              <span className="panel-section-title">Shipping</span>
              <div className="panel-section-icons">
                <span className="panel-section-icon" title="Settings">⚙</span>
                <span className="panel-section-icon" title="Grid">⊞</span>
              </div>
            </div>

            <div className="ship-req">
              Requested: <span className="ship-req-link">{(requestedService ?? 'Standard').replace(/_/g, ' ')}</span>
              {!panelOrder.carrierCode ? <span style={{ marginLeft: 4 }}>(unmapped)</span> : null}
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
                  <input type="number" className="ship-input ship-input-sm" value={panelForm.weightLb} readOnly={shipped} onChange={(event) => setPanelForm((current) => ({ ...current, weightLb: event.target.value }))} />
                  <span className="ship-input-unit">lb</span>
                  <input type="number" className="ship-input ship-input-sm" value={panelForm.weightOz} readOnly={shipped} onChange={(event) => setPanelForm((current) => ({ ...current, weightOz: event.target.value }))} />
                  <span className="ship-input-unit">oz</span>
                </div>
              </div>

              <div className="ship-field-row">
                <span className="ship-field-label">Size</span>
                <div className="ship-field-value" style={{ gap: 3, flexWrap: 'wrap' }}>
                  <input type="number" className="ship-input ship-input-sm" value={panelForm.length} readOnly={shipped} onChange={(event) => setPanelForm((current) => ({ ...current, length: event.target.value }))} />
                  <span className="ship-input-unit">L</span>
                  <input type="number" className="ship-input ship-input-sm" value={panelForm.width} readOnly={shipped} onChange={(event) => setPanelForm((current) => ({ ...current, width: event.target.value }))} />
                  <span className="ship-input-unit">W</span>
                  <input type="number" className="ship-input ship-input-sm" value={panelForm.height} readOnly={shipped} onChange={(event) => setPanelForm((current) => ({ ...current, height: event.target.value }))} />
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

              <div className="ship-rate-row">
                <span style={{ fontSize: 11.5, color: 'var(--text2)', fontWeight: 500, width: 90, flexShrink: 0 }}>Rate</span>
                {panelIsTestOrder ? (
                  <span className="ship-rate-val" id="panel-rate-val">
                    <><span className="ship-rate-price">{formatMoney(panelTestRateAmount)}</span><span className="ship-rate-detail">{panelTestRateDetail}</span></>
                  </span>
                ) : shipped ? (
                  <span className="ship-rate-val ship-rate-val-muted">
                    {getIsExternallyFulfilled(panelOrder)
                      ? '📦 Ext. label — purchased externally'
                      : (
                        <>
                          <span className="ship-rate-price">{formatMoney(panelOrder.label?.cost ?? panelOrder.selectedRate?.cost ?? getSelectedRateBaseCost(panelOrder))}</span>
                          <span className="ship-rate-detail">{selectedPanelAccountLabel} · {formatServiceCode(panelForm.serviceCode)}</span>
                        </>
                      )}
                  </span>
                ) : (
                  <>
                    <span className="ship-rate-val" id="panel-rate-val">
                      {panelRateLoading ? (
                        <span className="ship-rate-loading">
                          <span className="ship-rate-spinner" aria-hidden="true" />
                          <span>Calculating best rate…</span>
                        </span>
                      ) : panelRatePreview[0] ? (
                        <>
                          <span className="ship-rate-price">{formatMoney((toNumberValue(panelRatePreview[0].shipmentCost) ?? 0) + (toNumberValue(panelRatePreview[0].otherCost) ?? 0))}</span>
                          <span className="ship-rate-detail">{formatCarrierCode(toStringValue(panelRatePreview[0].carrierCode))} · {formatServiceCode(toStringValue(panelRatePreview[0].serviceCode))}</span>
                        </>
                      ) : panelOrder.bestRate ? (
                        <>
                          <span className="ship-rate-price">{formatMoney(applyCarrierMarkup({
                        shippingProviderId: getBestRateShippingProviderId(panelOrder),
                        carrierCode: panelOrder.bestRate.carrierCode ?? '',
                        serviceCode: getBestRateServiceCode(panelOrder) ?? '',
                        serviceName: panelOrder.bestRate.serviceName ?? '',
                        amount: typeof panelOrder.bestRate.amount === 'number' ? panelOrder.bestRate.amount : 0,
                        shipmentCost: typeof panelOrder.bestRate.shipmentCost === 'number' ? panelOrder.bestRate.shipmentCost : undefined,
                        otherCost: typeof panelOrder.bestRate.otherCost === 'number' ? panelOrder.bestRate.otherCost : undefined,
                        carrierNickname: getBestRateCarrierNickname(panelOrder),
                      }, markups))}</span>
                          <span className="ship-rate-detail">{selectedPanelAccountLabel} · {formatServiceCode(panelForm.serviceCode || getBestRateServiceCode(panelOrder))}</span>
                        </>
                      ) : '—'}
                    </span>
                    <span style={{ flex: 1 }} />
                    <span className="ship-scout" title="Refresh rates" onClick={() => void openRateBrowser()}>🔄 <span id="panel-scout-label">Scout Review</span></span>
                  </>
                )}
              </div>

              {shipped ? null : (
                <button className="save-sku-btn" id="saveSkuBtn" type="button" onClick={() => void saveSkuDefaults()}>
                  💾 Save weights and dims as SKU defaults
                </button>
              )}
            </div>
          </div>

          {shipped ? null : (
            <div className="create-label-wrap" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button className="create-label-btn" type="button" style={{ flex: 1 }} onClick={() => void createOrQueueLabel('print')} disabled={singleActionBusy}>
                🖨️ Create + Print Label <span className="create-label-caret">▾</span>
              </button>
              <button className="create-label-btn" type="button" style={{ flex: 1, background: '#16a34a' }} onClick={() => void createOrQueueLabel('queue')} disabled={singleActionBusy}>
                📥 Send to Queue
              </button>
              <button className="btn btn-ghost btn-sm" type="button" style={{ fontSize: 10.5, color: 'var(--text3)', padding: '4px 7px' }} onClick={() => void createOrQueueLabel('test')} disabled={singleActionBusy}>
                Test
              </button>
            </div>
          )}

          {shipped && trackingNumber ? (
            <div className="delivery-row" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>📦 Tracking:</span>
              <span
                style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--text)', fontWeight: 600, cursor: 'pointer' }}
                onClick={() => copyText(trackingNumber)}
                title="Click to copy"
              >
                {trackingNumber}
              </span>
              <button className="btn btn-sm btn-ghost" type="button" style={{ marginLeft: 'auto', fontSize: 10.5 }} onClick={() => void reprintLabel()}>
                🖨️ Reprint
              </button>
            </div>
          ) : null}

          <div className="delivery-row" id="panel-delivery-row">{deliveryLine}</div>

          <div className={`panel-section${collapsedSections.items ? ' collapsed' : ''}`} id="sec-items">
            <div className="panel-section-header" onClick={() => toggleSection('items')}>
              <span className="panel-section-arrow">▶</span>
              <span className="panel-section-title">Items</span>
              <div className="panel-section-icons">
                <span className="panel-section-icon">★</span>
                <span className="panel-section-icon">⊞</span>
              </div>
            </div>
            <div className="panel-section-body">
              {items.length === 0 ? <div style={{ paddingTop: 12, color: 'var(--text3)', fontSize: 11.5 }}>No items found for this order.</div> : null}
              {mergedItems.map((item) => (
                <div key={`${item.sku ?? 'unknown'}-${item.name ?? 'item'}`} className="item-row">
                  <div className="item-img">
                    <HoverImage
                      src={item.imageUrl}
                      alt={item.name ?? ''}
                      size={42}
                      radius={5}
                      title={item.name ?? ''}
                      fallback={<span>📦</span>}
                    />
                  </div>
                  <div className="item-info">
                    <div className="item-name">{item.name ?? 'Unknown Item'}</div>
                    <div className="item-sku">SKU: {item.sku ?? '—'}</div>
                    <div className="item-price-row">
                      {formatMoney(item.unitPrice)} × {item.quantity} = <strong>{formatMoney((item.unitPrice ?? 0) * item.quantity)}</strong>
                    </div>
                  </div>
                  <div className="item-qty">{item.quantity}</div>
                </div>
              ))}
            </div>
          </div>

          <div className={`panel-section${collapsedSections.recipient ? ' collapsed' : ''}`} id="sec-recipient">
            <div className="panel-section-header" onClick={() => toggleSection('recipient')}>
              <span className="panel-section-arrow">▶</span>
              <span className="panel-section-title">Recipient</span>
              <div className="panel-section-icons">
                <span className="panel-section-icon">⊞</span>
              </div>
            </div>
            <div className="panel-section-body">
              <div className="recip-header">
                <span className="recip-title">Ship To</span>
                <span className="recip-edit" onClick={() => copyText(addressBlock)} title="Copy address">📋</span>
                <span className="recip-edit" title="Web app parity: edit recipient is not migrated beyond this entry point" onClick={() => showToast('Edit recipient — Phase 3')}>Edit</span>
              </div>
              <div className="recip-name">{shipTo.name ?? '—'}</div>
              <div className="recip-addr">{addressBlock || '—'}</div>
              {shipTo.phone ? <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 3 }}>{shipTo.phone}</div> : null}
              <div id="panel-addr-type" style={{ fontSize: 11, color: 'var(--text3)', marginTop: 5, marginBottom: 2 }}>
                {panelOrder.residential ?? panelOrder.sourceResidential ? '🏠 Residential' : '🏢 Commercial'}
                {panelOrder.residential != null ? ' (manual)' : ' (auto)'}
                {' — '}
                <a href="#" onClick={(event) => { event.preventDefault(); void toggleResidential() }} style={{ color: 'var(--ss-blue)' }}>change</a>
              </div>
              <div className="recip-validated">
                {shipTo.addressVerified && shipTo.addressVerified !== 'Not Validated' ? '🏠 Address Validated' : '⚠ Address Not Validated'}
                <span className="recip-revert" onClick={() => showToast('Address reverted')}>Revert</span>
              </div>
              <div className="recip-tax">
                Tax Information: <span style={{ color: 'var(--text3)' }}>0 Tax IDs added</span>
                <span className="recip-tax-add" onClick={() => showToast('Add tax ID — Phase 3')}>Add</span>
              </div>
              <div className="recip-sold" style={{ marginTop: 7, paddingTop: 7, borderTop: '1px solid var(--border)' }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text3)', marginBottom: 4 }}>Sold To</div>
                <div className="recip-sold-name">{toStringValue(toRecord(panelDetail?.raw)?.customerUsername) ?? shipTo.name ?? '—'}</div>
                {panelOrder.customerEmail ? <div style={{ fontSize: 11.5, color: 'var(--text2)' }}>{panelOrder.customerEmail}</div> : null}
              </div>

              {activeOrderLoading ? <div style={{ marginTop: 10, fontSize: 10.5, color: 'var(--text3)' }}>Loading full order detail…</div> : null}
              {activeOrderError ? <div style={{ marginTop: 10, fontSize: 10.5, color: 'var(--red)' }}>Failed to load full order detail.</div> : null}
            </div>
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <div id="view-orders">
        <div className="filterbar">
          <div className="search-wrap" style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <input
              type="text"
              id="searchInput"
              placeholder="Search orders, SKUs, names…"
              value={searchQuery}
              onChange={(event) => onSearchQueryChange?.(event.target.value)}
              style={{ paddingRight: 26, width: '100%' }}
            />
            <button
              id="searchClear"
              type="button"
              onClick={() => onSearchQueryChange?.('')}
              style={{
                display: searchQuery ? 'flex' : 'none',
                position: 'absolute',
                right: 7,
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--text3)',
                fontSize: 13,
                padding: 2,
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          </div>

          <select className="filter-sel" id="skuFilter" value={skuFilter} onChange={(event) => setSkuFilter(event.target.value)}>
            <option value="">All SKUs</option>
            {skuOptions.map((sku) => (
              <option key={sku} value={sku}>{sku}</option>
            ))}
          </select>

          <select
            className="filter-sel"
            id="dateFilter"
            value={dateFilter}
            onChange={(event) => onDateFilterChange?.(event.target.value as OrdersDateFilter)}
          >
            <option value="">All Dates</option>
            <option value="this-month">This Month</option>
            <option value="last-month">Last Month</option>
            <option value="last-30">Last 30 Days</option>
            <option value="last-90">Last 90 Days</option>
            <option value="custom">Custom…</option>
          </select>

          <div id="customDateWrap" style={{ display: dateFilter === 'custom' ? 'flex' : 'none', alignItems: 'center', gap: 4 }}>
            <input
              type="date"
              id="dateFrom"
              className="filter-sel"
              style={{ padding: '4px 6px', fontSize: 11.5, width: 'auto' }}
              value={customDateFrom}
              onChange={(event) => setCustomDateFrom(event.target.value)}
            />
            <span style={{ color: 'var(--text3)', fontSize: 11 }}>–</span>
            <input
              type="date"
              id="dateTo"
              className="filter-sel"
              style={{ padding: '4px 6px', fontSize: 11.5, width: 'auto' }}
              value={customDateTo}
              onChange={(event) => setCustomDateTo(event.target.value)}
            />
          </div>

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
          <label
            id="btnSelectAll"
            className="btn btn-ghost btn-sm"
            style={{
              gap: 6,
              cursor: visibleOrderIds.length > 0 ? 'pointer' : 'default',
              opacity: visibleOrderIds.length > 0 ? 1 : 0.55,
              color: allVisibleSelected || someVisibleSelected ? 'var(--ss-blue)' : undefined,
              background: allVisibleSelected || someVisibleSelected ? 'var(--ss-blue-bg)' : undefined,
              borderColor: allVisibleSelected || someVisibleSelected ? 'var(--ss-blue)' : undefined,
            }}
            title={
              visibleOrderIds.length === 0
                ? 'No visible orders to select'
                : allVisibleSelected
                  ? 'Clear all visible selected orders'
                  : 'Select all visible orders'
            }
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
              style={{ width: 13, height: 13, accentColor: 'var(--ss-blue)', cursor: visibleOrderIds.length > 0 ? 'pointer' : 'default' }}
              aria-label="Select all visible orders"
            />
            <span>
              {visibleSelectedCount > 0
                ? `${visibleSelectedCount}/${visibleOrderIds.length} selected`
                : 'Select All'}
            </span>
          </label>
          <button
            id="btnSkuSort"
            className="btn btn-ghost btn-sm"
            type="button"
            style={{
              gap: 4,
              borderColor: skuSortActive ? 'var(--ss-blue)' : undefined,
              background: skuSortActive ? 'var(--ss-blue-bg)' : undefined,
              color: skuSortActive ? 'var(--ss-blue)' : undefined,
            }}
            onClick={toggleSkuSort}
          >
            {skuSortActive ? '📋 SKU Sort ✓' : '📋 SKU Sort'}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            style={{ fontSize: 11.5, gap: 4 }}
            id="exportBtn"
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
            📥 Export CSV
          </button>
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
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            style={{ fontSize: 11.5, gap: 4, marginLeft: 'auto', display: currentStatus === 'awaiting_shipment' ? '' : 'none' }}
            id="picklistBtn"
            onClick={() => void printPicklist()}
          >
            🖨️ Picklist
          </button>
        </div>

        <div id="daily-strip" style={{ display: dailyStats ? 'block' : 'none' }}>
          {dailyStats ? (
            <div style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)', padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap', fontSize: 12 }}>
              <div style={{ color: 'var(--text3)', fontSize: 11, whiteSpace: 'nowrap', flexShrink: 0 }}>
                📅 <span style={{ color: 'var(--text2)' }}>{dailyStatsFromLabel}</span>
                <span style={{ margin: '0 4px' }}>→</span>
                <span style={{ color: 'var(--text2)' }}>{dailyStatsToLabel}</span>
                <span style={{ marginLeft: 4, color: 'var(--text3)' }}>(shifts at 6 PM)</span>
              </div>
              <div style={{ width: 1, height: 28, background: 'var(--border2)', flexShrink: 0 }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <span style={{ fontSize: 16 }}>📦</span>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 800, lineHeight: 1, color: 'var(--text)' }}>{dailyStats.totalOrders}</div>
                  <div style={{ fontSize: 10, color: 'var(--text3)', lineHeight: 1.2, marginTop: 1 }}>Total Orders</div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <span style={{ fontSize: 16 }}>🚚</span>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 800, lineHeight: 1, color: dailyStripProgress?.needToShipColor }}>{dailyStats.needToShip}</div>
                  <div style={{ fontSize: 10, color: 'var(--text3)', lineHeight: 1.2, marginTop: 1 }}>Need to Ship</div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <span style={{ fontSize: 16 }}>🔔</span>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 800, lineHeight: 1, color: dailyStripProgress?.upcomingColor }}>{dailyStats.upcomingOrders}</div>
                  <div style={{ fontSize: 10, color: 'var(--text3)', lineHeight: 1.2, marginTop: 1 }}>Upcoming</div>
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 120, maxWidth: 220 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                  <span style={{ fontSize: 10, color: 'var(--text3)' }}>{dailyStripProgress?.shipped} of {dailyStats.totalOrders} shipped</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: dailyStripProgress?.barColor }}>{dailyStripProgress?.pct}%</span>
                </div>
                <div style={{ height: 6, background: 'var(--border2)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${dailyStripProgress?.barFill ?? 0}%`, background: dailyStripProgress?.barColor, borderRadius: 3, transition: 'width .4s ease' }} />
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <div className="content-split">
          <div className="orders-section" id="ordersSection">
            <div className="orders-wrap">
              {loading ? (
                <div id="loadingState" className="loading">
                  <div className="spinner" />
                  <div style={{ fontSize: 12, marginTop: 4 }}>Loading orders…</div>
                </div>
              ) : null}

              {!loading && error ? (
                <div id="loadingState" className="loading">
                  <div style={{ color: 'var(--red)', fontSize: 12.5 }}>⚠️ Error: {error.message}</div>
                </div>
              ) : null}

              {!loading && !error && orderedFilteredOrders.length > 0 ? (
                <table
                  className="orders-table"
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
                <div id="emptyState" className="empty-state">
                  <div className="empty-icon">📭</div>
                  <div>No orders match your filters</div>
                </div>
              ) : null}
            </div>
          </div>

          <div className="order-panel" id="orderPanel">
            <div className="panel-inner" id="panelInner">
              {activeOrderId == null && selectedOrderIds.length >= 2 ? renderBatchPanel() : renderSinglePanel()}
            </div>
          </div>
        </div>
      </div>

      <div className="pagination-bar" id="paginationBar">
        <button className="btn btn-outline btn-sm" type="button" id="prevBtn" disabled={currentPage <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
          ← Prev
        </button>
        <span id="pageInfo">Page {pages === 0 ? 0 : currentPage} of {pages || 0}</span>
        <span id="totalInfo">{total.toLocaleString()} total</span>
        <button className="btn btn-outline btn-sm" type="button" id="nextBtn" disabled={pages === 0 || currentPage >= pages} onClick={() => setPage((current) => Math.min(pages, current + 1))}>
          Next →
        </button>
      </div>

      {queueOpen ? (
        <div id="print-queue-panel" style={{ display: 'grid', gridTemplateRows: queuePrintMessage ? 'auto auto auto 1fr auto' : 'auto auto 1fr auto', position: 'fixed', top: 56, right: 12, bottom: 12, width: 520, maxWidth: 'calc(100vw - 24px)', background: 'var(--surface)', border: '1px solid var(--border2)', borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,.18)', zIndex: 1200, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
            <strong>Print Queue</strong>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn btn-ghost btn-xs" type="button" id="pq-history-btn" onClick={() => setQueueHistoryVisible((value) => !value)}>{queueHistoryVisible ? '🔼 Hide History' : '🕐 History'}</button>
              <button className="btn btn-ghost btn-xs" type="button" onClick={() => queueClientId != null ? void apiClient.clearQueue(queueClientId).then(() => hydrateQueue()).catch((error) => showToast(error instanceof Error ? error.message : 'Failed to clear queue', 'error')) : undefined}>🗑️ Clear</button>
              <button className="btn btn-ghost btn-xs" type="button" onClick={() => setQueueOpen(false)}>✕</button>
            </div>
          </div>
          <div id="pq-summary" style={{ display: 'flex', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--border)', fontSize: 11 }}>
            <div>{queueCount} Orders</div>
            <div>{queuedEntries.reduce((sum, entry) => sum + (entry.order_qty ?? 1), 0)} Total Qty</div>
            <div>{queueGroups.length} SKU Groups</div>
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
            {!queueLoading && !queueHasVisibleEntries ? <div className="pq-empty">📭 Queue is empty<br /><small>Click "Send to Queue" on any order with a label</small></div> : null}
            {queueGroups.map((group) => (
              <div key={group.groupId} className="pq-group" style={{ border: '1px solid var(--border)', borderRadius: 8, marginBottom: 10, overflow: 'hidden' }}>
                <div className="pq-group-header" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'var(--surface2)' }}>
                  <span className="pq-group-label" style={{ fontWeight: 700 }}>{group.label}{group.description ? ` — ${group.description}` : ''}</span>
                  <span className="pq-group-meta" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)' }}>
                    {group.orders.length} order{group.orders.length === 1 ? '' : 's'} · Qty {group.perOrderQty} each
                  </span>
                  <button className="btn btn-ghost btn-xs" type="button" onClick={() => void printQueueEntries(group.orders.map((entry) => entry.queue_entry_id))}>🖨️ Print Group</button>
                </div>
                <div className="pq-group-orders">
                  {group.orders.map((entry) => {
                    const numericOrderId = Number.parseInt(String(entry.order_id), 10)
                    const orderClickable = Number.isFinite(numericOrderId) && numericOrderId > 0
                    return (
                      <div key={entry.queue_entry_id} className="pq-order-row" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderTop: '1px solid var(--border)' }}>
                        <button
                          type="button"
                          className="pq-order-num"
                          style={{ flex: 1, textAlign: 'left', fontFamily: 'monospace', color: 'var(--ss-blue)', background: 'none', border: 'none', padding: 0, cursor: orderClickable ? 'pointer' : 'default', textDecoration: orderClickable ? 'underline' : 'none', textUnderlineOffset: 2 }}
                          disabled={!orderClickable}
                          title={orderClickable ? 'View order details' : undefined}
                          onClick={(event) => {
                            event.stopPropagation()
                            if (orderClickable) openDetailDrawer(numericOrderId, true)
                          }}
                        >
                          Order #{entry.order_number || entry.order_id}{entry.print_count > 0 ? ` · Reprint #${entry.print_count}` : ''}
                        </button>
                        <span className="pq-order-qty" style={{ fontSize: 11 }}>Qty: {entry.order_qty ?? 1}</span>
                        <span className="pq-order-time" style={{ fontSize: 11, color: 'var(--text3)' }}>{new Date(entry.queued_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        <button className="pq-remove-btn" type="button" onClick={() => queueClientId != null ? void apiClient.removeFromQueue(entry.queue_entry_id, queueClientId).then(() => hydrateQueue()).catch((error) => showToast(error instanceof Error ? error.message : 'Failed to remove queue entry', 'error')) : undefined}>✕</button>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
            {printedEntries.length > 0 ? (
              <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--text3)', marginBottom: 6, fontWeight: 600 }}>
                  📋 Printed History ({printedEntries.length})
                </div>
                {printedEntries.map((entry) => {
                  const numericOrderId = Number.parseInt(String(entry.order_id), 10)
                  const orderClickable = Number.isFinite(numericOrderId) && numericOrderId > 0
                  return (
                    <div key={entry.queue_entry_id} className="pq-order-row" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', opacity: 0.7 }}>
                      <button
                        type="button"
                        className="pq-order-num"
                        style={{ flex: 1, textAlign: 'left', color: 'var(--ss-blue)', background: 'none', border: 'none', padding: 0, cursor: orderClickable ? 'pointer' : 'default', textDecoration: orderClickable ? 'underline' : 'none', textUnderlineOffset: 2 }}
                        disabled={!orderClickable}
                        title={orderClickable ? 'View order details' : undefined}
                        onClick={(event) => {
                          event.stopPropagation()
                          if (orderClickable) openDetailDrawer(numericOrderId, true)
                        }}
                      >
                        Order #{entry.order_number || entry.order_id}
                      </button>
                      <span className="pq-order-qty">Qty: {entry.order_qty ?? 1}</span>
                      <span className="pq-order-time">✅ {entry.last_printed_at ? new Date(entry.last_printed_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</span>
                    </div>
                  )
                })}
              </div>
            ) : null}
          </div>
          <div style={{ display: 'flex', gap: 8, padding: 12, borderTop: '1px solid var(--border)' }}>
            <button className="btn btn-primary btn-sm" id="pq-print-all-btn" type="button" disabled={queueCount === 0 || queuePrintInFlight} onClick={() => void printQueueEntries(queuedEntries.map((entry) => entry.queue_entry_id))}>🖨️ Print All</button>
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
