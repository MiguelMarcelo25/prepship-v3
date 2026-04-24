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
  buildColumnPrefs,
  buildPicklistPrintHtml,
  buildQueueAddPayload,
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

interface OrdersViewProps {
  currentStatus: OrderStatus
  searchQuery?: string
  onSearchQueryChange?: (value: string) => void
  activeStore?: number | null
  dateFilter?: OrdersDateFilter
  onDateFilterChange?: (filter: OrdersDateFilter) => void
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
  { key: 'sku', label: 'SKU', width: 100, sort: 'sku' },
  { key: 'qty', label: 'Qty', width: 44, sort: 'qty' },
  { key: 'weight', label: 'Weight', width: 80, sort: 'weight' },
  { key: 'shipto', label: 'Ship To', width: 135, sort: 'shipto' },
  { key: 'carrier', label: 'Carrier', width: 145, sort: 'carrier' },
  { key: 'custcarrier', label: 'Shipping Account', width: 140, sort: 'custcarrier' },
  { key: 'total', label: 'Order Total', width: 85, sort: 'total' },
  { key: 'bestrate', label: 'Best Rate', width: 105, sort: null },
  { key: 'margin', label: 'Ship Margin', width: 90, sort: null },
  { key: 'tracking', label: 'Tracking #', width: 160, sort: null },
  { key: 'labelcreated', label: 'Label Created', width: 115, sort: null },
  { key: 'age', label: 'Age', width: 50, sort: 'age' },
  { key: 'test_carrierCode', label: 'Carrier Code', width: 120, sort: null },
  { key: 'test_shippingProviderID', label: 'Provider ID', width: 110, sort: null },
  { key: 'test_clientID', label: 'Client ID', width: 90, sort: null },
  { key: 'test_serviceCode', label: 'Service Code', width: 130, sort: null },
  { key: 'test_bestRate', label: 'Best Rate (awaiting)', width: 200, sort: null },
  { key: 'test_orderLocal', label: 'Order Local', width: 140, sort: null },
  { key: 'test_shippingAccount', label: 'Acct Nickname', width: 120, sort: null },
]

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
  ups_surepost: 'UPS SurePost',
  ups_surepost_1_lb_or_greater: 'UPS SurePost (≥1 lb)',
  ups_surepost_less_than_1_lb: 'UPS SurePost (<1 lb)',
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
    { code: 'ups_surepost_less_than_1_lb', label: 'UPS SurePost (<1 lb)' },
    { code: 'ups_surepost_1_lb_or_greater', label: 'UPS SurePost (≥1 lb)' },
    { code: 'ups_3_day_select', label: 'UPS 3 Day Select' },
    { code: 'ups_2nd_day_air', label: 'UPS 2nd Day Air' },
    { code: 'ups_2nd_day_air_am', label: 'UPS 2nd Day Air AM' },
    { code: 'ups_next_day_air_saver', label: 'UPS Next Day Air Saver' },
    { code: 'ups_next_day_air', label: 'UPS Next Day Air' },
  ],
  ups_walleted: [
    { code: 'ups_ground', label: 'UPS Ground' },
    { code: 'ups_ground_saver', label: 'UPS Ground Saver' },
    { code: 'ups_surepost_less_than_1_lb', label: 'UPS SurePost (<1 lb)' },
    { code: 'ups_surepost_1_lb_or_greater', label: 'UPS SurePost (≥1 lb)' },
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
  const date = parsed.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' })
  const time = parsed.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
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
  return [
    order.orderNumber,
    order.clientName,
    order.customerEmail,
    shipTo.name,
    shipTo.company,
    shipTo.street1,
    shipTo.street2,
    shipTo.city,
    shipTo.state,
    shipTo.postalCode,
    order.label?.trackingNumber,
    ...getActiveItems(order, detail).flatMap((item) => [item.sku, item.name]),
    toStringValue(rawOrder?.customerUsername),
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ')
    .toLowerCase()
}

function getShipTo(order: OrderSummaryDto, detail: OrderFullDto | null) {
  const rawOrder = toRecord(detail?.raw)
  const rawShipTo = toRecord(rawOrder?.shipTo)

  return {
    name: toStringValue(rawShipTo?.name) ?? order.shipTo?.name ?? null,
    company: toStringValue(rawShipTo?.company) ?? null,
    street1: toStringValue(rawShipTo?.street1) ?? null,
    street2: toStringValue(rawShipTo?.street2) ?? null,
    city: toStringValue(rawShipTo?.city) ?? order.shipTo?.city ?? null,
    state: toStringValue(rawShipTo?.state) ?? order.shipTo?.state ?? null,
    postalCode: toStringValue(rawShipTo?.postalCode) ?? order.shipTo?.postalCode ?? null,
    country: toStringValue(rawShipTo?.country) ?? 'US',
    phone: toStringValue(rawShipTo?.phone) ?? null,
    addressVerified: toStringValue(rawShipTo?.addressVerified) ?? null,
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
  const rawOrder = toRecord(detail?.raw) ?? toRecord(order.raw)
  const rawDims = toRecord(rawOrder?.dimensions)

  const length = toNumberValue(rawDims?.length) ?? order.rateDims?.length ?? 0
  const width = toNumberValue(rawDims?.width) ?? order.rateDims?.width ?? 0
  const height = toNumberValue(rawDims?.height) ?? order.rateDims?.height ?? 0

  if (!length || !width || !height) return null

  return {
    length,
    width,
    height,
    units: toStringValue(rawDims?.units) ?? 'inches',
  }
}

function getRequestedService(order: OrderSummaryDto, detail: OrderFullDto | null) {
  return getPanelRequestedService(order, detail)
}

function normalizeShippingAccountName(value: unknown) {
  const label = toStringValue(value)
  if (!label) return null
  return label
    .replace(/^UPS\s+by\s+SS\s*[-—]\s*/i, '')
    .replace(/^UPS\s+by\s+ShipStation\s*[-—]\s*/i, '')
}

function getCarrierAccountDisplay(account: CarrierAccountDto | null | undefined) {
  if (!account) return null
  return (
    normalizeShippingAccountName(account.nickname) ??
    normalizeShippingAccountName(account._label) ??
    normalizeShippingAccountName(account.code)
  )
}

function getShipAccountDisplay(order: OrderSummaryDto, accounts: CarrierAccountDto[]) {
  const selectedNickname = normalizeShippingAccountName(order.selectedRate?.providerAccountNickname)
  if (selectedNickname) return selectedNickname
  if (order.label?.shippingProviderId != null) {
    const account = accounts.find((candidate) => candidate.shippingProviderId === order.label.shippingProviderId)
    const accountLabel = getCarrierAccountDisplay(account)
    if (accountLabel) return accountLabel
  }
  if (order.bestRate) {
    const nickname = normalizeShippingAccountName(order.bestRate.carrierNickname)
    if (nickname) return nickname
  }
  return formatCarrierCode(order.label?.carrierCode ?? order.selectedRate?.carrierCode ?? order.bestRate?.carrierCode ?? order.carrierCode)
}

function getShipAccountLabelById(accounts: CarrierAccountDto[], accountId: string) {
  if (!accountId) return null
  const account = accounts.find((candidate) => String(candidate.shippingProviderId) === accountId)
  return getCarrierAccountDisplay(account)
}

function getBestRateBaseCost(order: OrderSummaryDto) {
  const shipmentCost = typeof order.bestRate?.shipmentCost === 'number' ? order.bestRate.shipmentCost : 0
  const otherCost = typeof order.bestRate?.otherCost === 'number' ? order.bestRate.otherCost : 0
  const amount = typeof order.bestRate?.amount === 'number' ? order.bestRate.amount : 0
  const total = shipmentCost + otherCost
  return total > 0 ? total : amount || null
}

function getBestRateShippingProviderId(order: OrderSummaryDto) {
  return order.bestRate ? toNumberValue(order.bestRate.shippingProviderId) ?? undefined : undefined
}

function getBestRateServiceCode(order: OrderSummaryDto) {
  return order.bestRate ? toStringValue(order.bestRate.serviceCode) : null
}

function getBestRateCarrierNickname(order: OrderSummaryDto) {
  return order.bestRate ? toStringValue(order.bestRate.carrierNickname) : null
}

function getSelectedRateBaseCost(order: OrderSummaryDto) {
  const shipmentCost = typeof order.selectedRate?.shipmentCost === 'number' ? order.selectedRate.shipmentCost : 0
  const otherCost = typeof order.selectedRate?.otherCost === 'number' ? order.selectedRate.otherCost : 0
  const cost = typeof order.selectedRate?.cost === 'number' ? order.selectedRate.cost : 0
  const total = shipmentCost + otherCost
  return total > 0 ? total : cost || null
}

function getMarkupAmount(baseAmount: number, markedAmount: number) {
  return markedAmount - baseAmount
}

function getIsExternallyFulfilled(order: OrderSummaryDto) {
  if (order.externalShipped) return true
  if (order.orderStatus === 'awaiting_shipment') return false
  return !order.label?.cost && !order.label?.trackingNumber && order.selectedRate == null
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
  if (currentStatus === 'awaiting_shipment') hidden.add('tracking')
  else hidden.add('age')

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
      return order.weight?.value ?? 0
    case 'shipto': {
      const shipTo = getShipTo(order, detail)
      return `${shipTo.state ?? ''}${shipTo.city ?? ''}`.toLowerCase()
    }
    case 'carrier':
      return `${order.label?.carrierCode ?? order.selectedRate?.carrierCode ?? order.bestRate?.carrierCode ?? order.carrierCode ?? ''}${order.label?.serviceCode ?? order.selectedRate?.serviceCode ?? getBestRateServiceCode(order) ?? order.serviceCode ?? ''}`.toLowerCase()
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

export default function OrdersView({
  currentStatus,
  searchQuery = '',
  onSearchQueryChange,
  activeStore,
  dateFilter = '',
  onDateFilterChange,
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
  const [dailyStats, setDailyStats] = useState<OrdersDailyStatsDto | null>(null)
  const [columnPrefs, setColumnPrefs] = useState<ColumnPrefs | null>(null)
  const [columnMenuOpen, setColumnMenuOpen] = useState(false)
  const [queueOpen, setQueueOpen] = useState(false)
  const [queueHistoryVisible, setQueueHistoryVisible] = useState(false)
  const [queueEntries, setQueueEntries] = useState<PrintQueueEntryDto[]>([])
  const [queueLoading, setQueueLoading] = useState(false)
  const [queuePrintMessage, setQueuePrintMessage] = useState<string | null>(null)
  const [queuePrintInFlight, setQueuePrintInFlight] = useState(false)
  const [rateBrowserOpen, setRateBrowserOpen] = useState(false)
  const [detailDrawerOrderId, setDetailDrawerOrderId] = useState<number | null>(null)
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
  const [panelForm, setPanelForm] = useState<{
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
  }>({
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

  const { orders, total, pages, currentPage, loading, error, refetch: refetchOrders } = useOrders(currentStatus, {
    page,
    pageSize: 50,
    storeId: activeStore ?? undefined,
    dateStart: dateRange.start,
    dateEnd: dateRange.end,
  })

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
      if (query && !buildSearchText(order, detail).includes(query)) return false
      if (skuFilter) {
        const items = getActiveItems(order, detail)
        if (!items.some((item) => item.sku === skuFilter)) return false
      }
      return true
    })
  }, [orders, orderDetailsById, searchQuery, skuFilter])

  const orderedFilteredOrders = useMemo(() => {
    const next = [...searchedOrders]

    if (skuSortActive) {
      next.sort((left, right) => {
        const leftSku = getPrimarySku(left, orderDetailsById.get(left.orderId) ?? null)
        const rightSku = getPrimarySku(right, orderDetailsById.get(right.orderId) ?? null)
        if (leftSku < rightSku) return -1
        if (leftSku > rightSku) return 1
        return getTotalQuantity(left, orderDetailsById.get(left.orderId) ?? null) - getTotalQuantity(right, orderDetailsById.get(right.orderId) ?? null)
      })
      return next
    }

    if (preSkuSortSnapshot) {
      const rank = new Map(preSkuSortSnapshot.map((orderId, index) => [orderId, index]))
      next.sort((left, right) => (rank.get(left.orderId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.orderId) ?? Number.MAX_SAFE_INTEGER))
      return next
    }

    next.sort((left, right) => {
      const leftValue = getSortValue(left, orderDetailsById.get(left.orderId) ?? null, sortState.key, shippingAccounts)
      const rightValue = getSortValue(right, orderDetailsById.get(right.orderId) ?? null, sortState.key, shippingAccounts)
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
          )
        : []
    ),
    [orderedFilteredOrders, orderDetailsById, skuSortActive],
  )

  const panelOrderId = activeOrderId ?? (selectedOrderIds.length === 1 ? selectedOrderIds[0] : null)
  const panelOrder = orderedFilteredOrders.find((order) => order.orderId === panelOrderId)
    ?? orders.find((order) => order.orderId === panelOrderId)
    ?? null
  const dailyStripProgress = dailyStats ? buildDailyStripProgress(dailyStats) : null
  const dailyStatsFromLabel = dailyStats?.window.fromLabel || dailyStats?.window.from || ''
  const dailyStatsToLabel = dailyStats?.window.toLabel || dailyStats?.window.to || ''
  const panelDetail = panelOrderId != null ? orderDetailsById.get(panelOrderId) ?? null : null
  const queueClientId = useMemo(() => {
    const selected = orders.find((order) => selectedIdSet.has(order.orderId) && order.clientId != null)
    if (selected?.clientId != null) return selected.clientId
    if (panelOrder?.clientId != null) return panelOrder.clientId
    return orders.find((order) => order.clientId != null)?.clientId ?? null
  }, [orders, panelOrder, selectedIdSet])

  useEffect(() => {
    setPage(1)
  }, [currentStatus, activeStore, dateFilter, customDateFrom, customDateTo])

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
    let cancelled = false

    void apiClient.fetchPackages()
      .then((payload) => {
        if (!cancelled) setPackages(payload)
      })
      .catch(() => {
        if (!cancelled) setPackages([])
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    void apiClient.fetchColumnPrefs()
      .then((payload) => {
        if (!cancelled) setColumnPrefs(payload)
      })
      .catch(() => {
        if (!cancelled) setColumnPrefs(null)
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

    const loadDailyStats = async () => {
      try {
        const payload = await apiClient.fetchDailyStats()
        if (!cancelled) setDailyStats(payload)
      } catch {
        if (!cancelled) setDailyStats(null)
      }
    }

    void loadDailyStats()
    const timer = window.setInterval(() => {
      void loadDailyStats()
    }, 5 * 60 * 1000)

    return () => {
      cancelled = true
      window.clearInterval(timer)
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
      setColumnMenuOpen(false)
    }

    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [columnMenuOpen])

  useEffect(() => {
    onQueueStateChange?.({
      count: queueEntries.filter((entry) => entry.status === 'queued').length,
      isOpen: queueOpen,
    })
  }, [queueEntries, queueOpen, onQueueStateChange])

  useEffect(() => {
    if (!queueOpen || queueClientId == null) return

    let cancelled = false

    const hydrateQueue = async () => {
      setQueueLoading(true)
      try {
        const payload = await apiClient.fetchQueue(queueClientId, queueHistoryVisible)
        if (!cancelled) setQueueEntries(payload.queuedOrders)
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
    if (!panelOrder) {
      return
    }

    const dimensions = getDimensions(panelOrder, panelDetail)
    const locationId = getPanelWarehouseId(panelOrder, panelDetail) ?? locations.find((location) => location.isDefault)?.locationId ?? locations[0]?.locationId ?? null
    const matchedPackageId = getMatchedPackageIdByDimensions(dimensions, packages)
    const selectedAccountValue = getInitialPanelShipAccountId(panelOrder, panelDetail)
    const currentWeight = panelOrder.weight?.value ?? 0
    const insurance = getPanelInsurance(panelOrder, panelDetail)

    setPanelForm({
      locationId: locationId != null ? String(locationId) : '',
      shipAccountId: selectedAccountValue != null ? String(selectedAccountValue) : '',
      serviceCode: getInitialPanelServiceCode(panelOrder, panelDetail),
      weightLb: currentWeight ? String(Math.floor(currentWeight / 16)) : '',
      weightOz: currentWeight ? String(Math.round(currentWeight % 16)) : '',
      length: dimensions?.length ? String(dimensions.length) : '',
      width: dimensions?.width ? String(dimensions.width) : '',
      height: dimensions?.height ? String(dimensions.height) : '',
      packageId: getPanelPackageId(panelOrder, panelDetail, packages) || matchedPackageId,
      confirmation: getPanelConfirmation(panelOrder, panelDetail),
      insurance: insurance.type,
      insuranceValue: insurance.value != null ? String(insurance.value) : '',
    })
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
        toggleOrderSelection(kbRowId)
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

  const toggleOrderSelection = (orderId: number, checked?: boolean) => {
    const isChecked = selectedIdSet.has(orderId)
    const shouldSelect = checked ?? !isChecked
    if (shouldSelect) {
      updateSelection([...selectedOrderIds, orderId])
      return
    }

    updateSelection(selectedOrderIds.filter((id) => id !== orderId))
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

  const selectAll = () => {
    updateSelection(orderedFilteredOrders.map((order) => order.orderId))
  }

  const clearSelection = () => {
    onSelectedOrderIdsChange?.([])
    onActiveOrderIdChange?.(null)
  }

  function showToast(message: string, type: 'success' | 'error' | 'info' = 'info') {
    toastContext?.addToast(message, type)
  }

  function getPanelWeightOz() {
    const lb = Number.parseFloat(panelForm.weightLb) || 0
    const oz = Number.parseFloat(panelForm.weightOz) || 0
    return (lb * 16) + oz
  }

  function getPanelDims() {
    const length = Number.parseFloat(panelForm.length) || 0
    const width = Number.parseFloat(panelForm.width) || 0
    const height = Number.parseFloat(panelForm.height) || 0
    return { length, width, height }
  }

  function getServiceOptionsForAccount(accountId: string) {
    const account = shippingAccounts.find((candidate) => String(candidate.shippingProviderId) === accountId)
    if (!account) return []
    return CARRIER_SERVICES[account.code] ?? []
  }

  async function saveColumnPrefsToServer(nextPrefs: ColumnPrefs) {
    setColumnPrefs(nextPrefs)
    try {
      await apiClient.saveColumnPrefs(nextPrefs)
    } catch {
      showToast('Failed to save column preferences', 'error')
    }
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
      if (forceOpen) setQueueOpen(true)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to load print queue', 'error')
    } finally {
      setQueueLoading(false)
    }
  }

  async function queueExistingLabels(orderIds: number[]) {
    if (orderIds.length === 0) {
      await hydrateQueue(true)
      return
    }

    let sent = 0
    let failed = 0
    let queueClient: number | null = null
    const queuedItems: Array<{ sku?: string | null; name?: string | null; quantity?: number | null }> = []

    for (const orderId of orderIds) {
      const order = orders.find((candidate) => candidate.orderId === orderId)
      if (!order?.label?.labelUrl || order.clientId == null) {
        failed += 1
        continue
      }

      try {
        queueClient = queueClient ?? order.clientId
        await apiClient.addToQueue(buildQueueAddPayload(order, order.label.labelUrl))
        sent += 1
        queuedItems.push(...getActiveItems(order, orderDetailsById.get(order.orderId) ?? null))
      } catch {
        failed += 1
      }
    }

    if (sent > 0 && queueClient != null) {
      const payload = await apiClient.fetchQueue(queueClient, queueHistoryVisible)
      setQueueEntries(payload.queuedOrders)
      setQueueOpen(true)
    }

    if (sent > 0) {
      showToast(formatQueuedOrdersToast(sent, queuedItems, failed), 'success')
    } else {
      showToast('⚠ No orders added — create labels first')
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

    const shippingProviderId = Number.parseInt(panelForm.shipAccountId, 10)
    const weightOz = getPanelWeightOz()
    const { length, width, height } = getPanelDims()
    const account = shippingAccounts.find((candidate) => candidate.shippingProviderId === shippingProviderId)
    if (!shippingProviderId || !account) {
      showToast('Select a carrier account', 'error')
      return null
    }
    if (!panelForm.serviceCode) {
      showToast('Select a shipping service', 'error')
      return null
    }
    if (!weightOz) {
      showToast('Enter shipment weight', 'error')
      return null
    }

    const location = locations.find((candidate) => String(candidate.locationId) === panelForm.locationId) ?? null
    const shipTo = getShipTo(order, panelDetail)
    const selectedPackage = packages.find((candidate) => String(candidate.packageId) === panelForm.packageId)

    const payload: CreateLabelRequestDto = {
      orderId: order.orderId,
      orderNumber: order.orderNumber ?? undefined,
      carrierCode: account.code,
      serviceCode: panelForm.serviceCode,
      shippingProviderId,
      packageCode: 'package',
      customPackageId: selectedPackage && selectedPackage.source !== 'ss_carrier' ? selectedPackage.packageId : null,
      weightOz,
      length,
      width,
      height,
      confirmation: panelForm.confirmation === 'none' ? 'delivery' : panelForm.confirmation,
      testLabel: mode === 'test',
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

    const items = getActiveItems(panelOrder, panelDetail).filter((item) => item.sku)
    const uniqueSkus = [...new Set(items.map((item) => item.sku).filter(Boolean))]
    if (uniqueSkus.length === 0) {
      showToast('No products found on this order', 'error')
      return
    }
    if (uniqueSkus.length > 1) {
      showToast("Multi-SKU order — edit each product's defaults in the Products tab", 'error')
      return
    }

    const sku = uniqueSkus[0]!
    const qty = items.filter((item) => item.sku === sku).reduce((sum, item) => sum + item.quantity, 0)
    const weightOz = getPanelWeightOz()
    const dims = getPanelDims()

    if (!weightOz && !dims.length) {
      showToast('Enter weight or dims first', 'error')
      return
    }

    try {
      await apiClient.saveProductDefaultsV2({
        sku,
        weightOz: qty > 1 ? Number((weightOz / qty).toFixed(2)) : weightOz,
        length: dims.length,
        width: dims.width,
        height: dims.height,
        packageId: panelForm.packageId ? Number.parseInt(panelForm.packageId, 10) : null,
      })
      showToast(`✅ Saved dims & weight for ${sku}`, 'success')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Save failed', 'error')
    }
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

  async function printQueueEntries(entryIds: string[]) {
    if (queueClientId == null || entryIds.length === 0) return

    setQueuePrintInFlight(true)
    setQueuePrintMessage('Starting merge…')
    try {
      const job = await apiClient.startQueuePrintJob(queueClientId, entryIds, true)

      let done = false
      while (!done) {
        await new Promise((resolve) => window.setTimeout(resolve, 600))
        const status = await apiClient.fetchQueuePrintJobStatus(job.job_id)
        setQueuePrintMessage(status.message)

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
              window.open(blobUrl, '_blank', 'noopener,noreferrer')
            }
          } catch (err) {
            console.error('[print-queue] download failed', err)
          }
          done = true
        }
        if (status.status === 'error') {
          throw new Error(status.errorMessage || 'PDF merge failed')
        }
      }

      await hydrateQueue()
      showToast(`✅ ${entryIds.length} label${entryIds.length === 1 ? '' : 's'} — opened in new tab`, 'success')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Print failed', 'error')
    } finally {
      setQueuePrintInFlight(false)
      setQueuePrintMessage(null)
    }
  }

  async function handleBatchAction(mode: 'print' | 'queue') {
    const batchOrders = orders.filter((order) => selectedIdSet.has(order.orderId))
    if (batchOrders.length === 0) {
      showToast('No orders selected', 'error')
      return
    }

    setBatchBusy(true)
    let created = 0
    let failed = 0
    const queuedItems: Array<{ sku?: string | null; name?: string | null; quantity?: number | null }> = []

    for (const order of batchOrders) {
      const bestRate = order.bestRate
      const selectedRate = order.selectedRate
      const shippingProviderId = toNumberValue(bestRate?.shippingProviderId) ?? selectedRate?.shippingProviderId ?? order.label?.shippingProviderId ?? null
      const serviceCode = toStringValue(bestRate?.serviceCode) ?? selectedRate?.serviceCode ?? order.serviceCode
      const carrierCode = toStringValue(bestRate?.carrierCode) ?? selectedRate?.carrierCode ?? order.label?.carrierCode
      const weightOz = order.weight?.value ?? 0
      const dims = getDimensions(order, null)

      // Test-client orders bypass the rate-fetch requirement — the backend
      // forces a VOID mock label regardless, so we just need to reach the
      // endpoint with a serviceCode + carrierCode. Use the order's stored
      // defaults when no rate has been shopped.
      const isTestOrder =
        typeof order.clientId === 'number' && TEST_CLIENT_IDS.has(order.clientId)
      const effectiveServiceCode = serviceCode ?? (isTestOrder ? 'usps_first_class_mail' : null)
      const effectiveCarrierCode = carrierCode ?? (isTestOrder ? 'stamps_com' : null)

      // Real-postage path still requires shippingProviderId. For test orders
      // the backend never makes that call, so we omit the field entirely
      // rather than try to sneak a 0 past Zod's .positive() validator.
      if (!isTestOrder && shippingProviderId == null) {
        failed += 1
        continue
      }
      if (!effectiveServiceCode || !effectiveCarrierCode) {
        failed += 1
        continue
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
          testLabel: batchTestMode || isTestOrder,
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
      } catch {
        failed += 1
      }
    }

    setBatchBusy(false)
    if (mode === 'queue' && created > 0) {
      await hydrateQueue(true)
    }
    await refetchOrders()
    if (mode === 'queue' && created > 0) {
      showToast(formatQueuedOrdersToast(created, queuedItems, failed), 'success')
    } else if (failed === 0) {
      showToast(`✅ ${mode === 'queue' ? 'Queued' : 'Created'} ${created} orders`, 'success')
    } else {
      showToast(`⚠ ${created} ${mode === 'queue' ? 'queued' : 'created'}, ${failed} failed`)
    }
  }

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

  const queuedEntries = useMemo(
    () => queueEntries.filter((entry) => entry.status === 'queued'),
    [queueEntries],
  )
  const printedEntries = useMemo(
    () => queueHistoryVisible ? queueEntries.filter((entry) => entry.status === 'printed') : [],
    [queueEntries, queueHistoryVisible],
  )
  const queueGroups = useMemo<PrintQueueGroup[]>(
    () => groupPrintQueueEntries(queueEntries),
    [queueEntries],
  )
  const queueCount = queuedEntries.length

  const renderBestRatePrice = (order: OrderSummaryDto) => {
    const bestRateBaseCost = getBestRateBaseCost(order)
    if (order.orderStatus !== 'awaiting_shipment') {
      const selectedRateBase = getSelectedRateBaseCost(order)
      const markedAmount = order.label?.cost ?? order.selectedRate?.cost ?? selectedRateBase
      if (selectedRateBase == null && markedAmount == null) {
        return <span style={{ color: 'var(--text3)', fontSize: 11 }}>—</span>
      }

      return (
        <div style={{ lineHeight: 1.3 }}>
          <strong style={{ color: 'var(--green)', fontSize: 12 }}>{formatMoney(markedAmount ?? selectedRateBase)}</strong>
          {selectedRateBase != null && markedAmount != null && Math.abs(markedAmount - selectedRateBase) > 0.005 ? (
            <div style={{ fontSize: 10, color: 'var(--text3)' }}>{formatMoney(selectedRateBase)} cost</div>
          ) : null}
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

    const markedAmount = applyCarrierMarkup({
      shippingProviderId: getBestRateShippingProviderId(order),
      carrierCode: order.bestRate.carrierCode ?? '',
      serviceCode: getBestRateServiceCode(order) ?? '',
      serviceName: order.bestRate.serviceName ?? '',
      amount: typeof order.bestRate.amount === 'number' ? order.bestRate.amount : 0,
      shipmentCost: typeof order.bestRate.shipmentCost === 'number' ? order.bestRate.shipmentCost : undefined,
      otherCost: typeof order.bestRate.otherCost === 'number' ? order.bestRate.otherCost : undefined,
      carrierNickname: getBestRateCarrierNickname(order),
    }, markups)

    return (
      <div style={{ lineHeight: 1.3 }}>
        <strong style={{ color: 'var(--green)', fontSize: 12 }}>{formatMoney(markedAmount)}</strong>
        {bestRateBaseCost != null && Math.abs(markedAmount - bestRateBaseCost) > 0.005 ? (
          <div style={{ fontSize: 10, color: 'var(--text3)' }}>{formatMoney(bestRateBaseCost)} cost</div>
        ) : null}
      </div>
    )
  }

  const renderMargin = (order: OrderSummaryDto) => {
    if (order.orderStatus !== 'awaiting_shipment') {
      const baseAmount = getSelectedRateBaseCost(order)
      const markedAmount = order.label?.cost ?? order.selectedRate?.cost ?? null
      if (baseAmount == null || markedAmount == null) {
        return <span style={{ color: 'var(--text4)', fontSize: 11 }}>—</span>
      }
      const diff = getMarkupAmount(baseAmount, markedAmount)
      if (diff <= 0.005) return <span style={{ color: 'var(--text4)', fontSize: 11 }}>—</span>
      return <span style={{ fontSize: 12, fontWeight: 700, color: '#16a34a' }}>+{formatMoney(diff)}</span>
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
      amount: typeof order.bestRate.amount === 'number' ? order.bestRate.amount : 0,
      shipmentCost: typeof order.bestRate.shipmentCost === 'number' ? order.bestRate.shipmentCost : undefined,
      otherCost: typeof order.bestRate.otherCost === 'number' ? order.bestRate.otherCost : undefined,
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
    const shipped = order.orderStatus !== 'awaiting_shipment' || Boolean(order.label?.trackingNumber && order.label?.carrierCode)
    if (shipped) {
      if (order.externalShipped) {
        return <span style={{ fontSize: 10, color: 'var(--text2)' }}>Externally Shipped</span>
      }

      const carrierCode = order.label?.carrierCode ?? order.selectedRate?.carrierCode ?? order.carrierCode
      const serviceCode = order.label?.serviceCode ?? order.selectedRate?.serviceCode ?? order.serviceCode
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, lineHeight: 1.3 }}>
          <span className={`carrier-badge ${getCarrierClass(carrierCode)}`}>{formatCarrierCode(carrierCode)}</span>
          <span style={{ fontSize: 10, color: 'var(--text2)' }}>{truncate(formatServiceCode(serviceCode), 26)}</span>
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, lineHeight: 1.3 }}>
        <span className={`carrier-badge ${getCarrierClass(order.bestRate.carrierCode)}`}>{formatCarrierCode(order.bestRate.carrierCode)}</span>
        <span style={{ fontSize: 10, color: 'var(--text2)' }}>{truncate(formatServiceCode(getBestRateServiceCode(order)), 26)}</span>
      </div>
    )
  }

  const renderShippingAccountCell = (order: OrderSummaryDto) => {
    const shipped = order.orderStatus !== 'awaiting_shipment' || Boolean(order.label?.trackingNumber && order.label?.carrierCode)
    if (shipped) {
      if (getIsExternallyFulfilled(order)) {
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
            }}
            title="Label purchased outside ShipStation (eBay/Walmart/Amazon/etc.)"
          >
            Ext. Label
          </span>
        )
      }

      return (
        <div style={{ lineHeight: 1.4, whiteSpace: 'nowrap' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text2)' }}>{getShipAccountDisplay(order, shippingAccounts)}</div>
          <div style={{ fontSize: 10, color: 'var(--text3)' }} className="svc-label">
            {truncate(formatServiceCode(order.label?.serviceCode ?? order.selectedRate?.serviceCode ?? order.serviceCode), 22)}
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
    const isTestOrder =
      typeof order.clientId === 'number' && TEST_CLIENT_IDS.has(order.clientId)
    return (
    <div className="order-num" style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, minWidth: 0 }}>
      {isTestOrder && (
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
          setDetailDrawerOrderId(order.orderId ?? null)
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
    const diagnosticIsShipped = order.orderStatus !== 'awaiting_shipment' || Boolean(order.label?.trackingNumber && order.label?.carrierCode)

    switch (column.key) {
      case 'select':
        return (
          <input
            type="checkbox"
            checked={selectedIdSet.has(order.orderId)}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => {
              event.stopPropagation()
              toggleOrderSelection(order.orderId, event.target.checked)
            }}
            aria-label={`Select ${order.orderNumber ?? order.orderId}`}
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
                  {item.sku ? <span className="sku-link" style={{ fontSize: 11 }}>{item.sku}</span> : <span style={{ color: 'var(--text4)', fontSize: 11 }}>—</span>}
                </div>
              ))}
              {overflow > 0 ? <div style={{ height: 14 }} /> : null}
            </div>
          )
        }
        return primaryItem?.sku ? <span className="sku-link">{primaryItem.sku}</span> : '—'
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
        if (!order.label?.trackingNumber) {
          return <span style={{ color: 'var(--text4)', fontFamily: 'monospace', fontSize: 11 }}>—</span>
        }
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontFamily: 'monospace' }}>
            <span
              style={{ color: 'var(--ss-blue)', cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted' }}
              onClick={(event) => {
                event.stopPropagation()
                setTrackingModal({
                  tracking: order.label?.trackingNumber ?? '',
                  carrierCode: order.label?.carrierCode ?? order.bestRate?.carrierCode ?? null,
                })
              }}
              title="Track package"
            >
              {order.label?.trackingNumber}
            </span>
            <span
              onClick={(event) => {
                event.stopPropagation()
                copyText(order.label?.trackingNumber ?? '')
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
      case 'labelcreated':
        return <span style={{ fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap' }}>{formatLabelCreated(order.label?.createdAt ?? null)}</span>
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
        const value = diagnosticIsShipped
          ? (toStringValue(order.selectedRate?.carrierCode) ?? toStringValue(order.label?.carrierCode) ?? toStringValue(order.carrierCode))
          : toStringValue(order.bestRate?.carrierCode)
        return renderDiagnosticCell(value, { monospace: true })
      }
      case 'test_shippingProviderID': {
        const value = diagnosticIsShipped
          ? (toNumberValue(order.selectedRate?.shippingProviderId) ?? toNumberValue(order.label?.shippingProviderId))
          : toNumberValue(order.bestRate?.shippingProviderId)
        return renderDiagnosticCell(value, { monospace: true })
      }
      case 'test_clientID':
        return renderDiagnosticCell(order.clientId, { monospace: true })
      case 'test_serviceCode': {
        const value = diagnosticIsShipped
          ? (toStringValue(order.selectedRate?.serviceCode) ?? toStringValue(order.label?.serviceCode) ?? toStringValue(order.serviceCode))
          : toStringValue(order.bestRate?.serviceCode)
        return renderDiagnosticCell(value, {
          fontSize: 10,
          maxWidth: column.width,
          monospace: true,
        })
      }
      case 'test_bestRate': {
        const bestRate = order.bestRate
        if (!bestRate) return renderDiagnosticCell(null, { fontSize: 10, muted: true, surface: false })

        const shipmentCost = typeof bestRate.shipmentCost === 'number' ? bestRate.shipmentCost : 0
        const otherCost = typeof bestRate.otherCost === 'number' ? bestRate.otherCost : 0
        const amount = shipmentCost + otherCost
        const display = `${bestRate.carrierCode || '?'}|${bestRate.serviceCode || '?'}|$${amount.toFixed(2)}`

        return renderDiagnosticCell(display, {
          fontSize: 9,
          maxWidth: column.width,
          monospace: true,
          title: JSON.stringify(bestRate),
        })
      }
      case 'test_orderLocal': {
        const parts: string[] = []
        if (order.weight?.value && order.weight.value > 0) {
          parts.push(`w:${order.weight.value}${order.weight.units?.[0] || 'oz'}`)
        }
        if (order.label?.trackingNumber) parts.push('track:✓')
        if (order.bestRate) parts.push('best:✓')

        const display = parts.length ? parts.join(' ') : null
        return renderDiagnosticCell(display, {
          fontSize: 9,
          maxWidth: column.width,
          title: display ?? '—',
        })
      }
      case 'test_shippingAccount': {
        const value = diagnosticIsShipped
          ? (normalizeShippingAccountName(order.selectedRate?.providerAccountNickname) ?? toStringValue(order.label?.carrierCode))
          : null
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
    const dims = getDimensions(panelOrder, panelDetail)
    const requestedService = getRequestedService(panelOrder, panelDetail)
    const panelIndex = orderedFilteredOrders.findIndex((order) => order.orderId === panelOrder.orderId)
    const prevOrderId = panelIndex > 0 ? orderedFilteredOrders[panelIndex - 1]?.orderId ?? null : null
    const nextOrderId = panelIndex >= 0 && panelIndex < orderedFilteredOrders.length - 1 ? orderedFilteredOrders[panelIndex + 1]?.orderId ?? null : null
    const currentWeight = panelOrder.weight?.value ?? 0
    const serviceOptions = getServiceOptionsForAccount(panelForm.shipAccountId)
    const selectedPanelAccountLabel = getShipAccountLabelById(shippingAccounts, panelForm.shipAccountId) ?? getShipAccountDisplay(panelOrder, shippingAccounts)
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
              updateSelection([prevOrderId])
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
              updateSelection([nextOrderId])
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
          <button className="panel-close" type="button" onClick={clearSelection}>✕</button>
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
                    disabled={shipped}
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
                  <select className="ship-select" style={{ flex: 1 }} value={panelForm.serviceCode} disabled={shipped} onChange={(event) => setPanelForm((current) => ({ ...current, serviceCode: event.target.value }))}>
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
                      setPanelForm((current) => ({ ...current, packageId: event.target.value }))
                      void apiClient.setOrderSelectedPackageId(panelOrder.orderId, event.target.value ? Number.parseInt(event.target.value, 10) : null)
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
                <div style={{ padding: '4px 0' }}>
                  <button className="btn btn-primary btn-sm" type="button" style={{ fontSize: 11.5, gap: 4 }} onClick={() => void openRateBrowser()}>🔍 Browse Rates</button>
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
                {shipped ? (
                  <span style={{ fontSize: 10.5, color: 'var(--text3)' }}>
                    {getIsExternallyFulfilled(panelOrder)
                      ? '📦 Ext. label — purchased externally'
                      : `${formatMoney(panelOrder.label?.cost ?? panelOrder.selectedRate?.cost ?? getSelectedRateBaseCost(panelOrder))} · ${selectedPanelAccountLabel} · ${formatServiceCode(panelForm.serviceCode)}`}
                  </span>
                ) : (
                  <>
                    <span className="ship-rate-val" id="panel-rate-val">
                      {panelRateLoading ? 'Loading rates…' : panelRatePreview[0] ? `${formatMoney((toNumberValue(panelRatePreview[0].shipmentCost) ?? 0) + (toNumberValue(panelRatePreview[0].otherCost) ?? 0))} · ${formatCarrierCode(toStringValue(panelRatePreview[0].carrierCode))} · ${formatServiceCode(toStringValue(panelRatePreview[0].serviceCode))}` : panelOrder.bestRate ? `${formatMoney(applyCarrierMarkup({
                        shippingProviderId: getBestRateShippingProviderId(panelOrder),
                        carrierCode: panelOrder.bestRate.carrierCode ?? '',
                        serviceCode: getBestRateServiceCode(panelOrder) ?? '',
                        serviceName: panelOrder.bestRate.serviceName ?? '',
                        amount: typeof panelOrder.bestRate.amount === 'number' ? panelOrder.bestRate.amount : 0,
                        shipmentCost: typeof panelOrder.bestRate.shipmentCost === 'number' ? panelOrder.bestRate.shipmentCost : undefined,
                        otherCost: typeof panelOrder.bestRate.otherCost === 'number' ? panelOrder.bestRate.otherCost : undefined,
                        carrierNickname: getBestRateCarrierNickname(panelOrder),
                      }, markups))} · ${selectedPanelAccountLabel} · ${formatServiceCode(panelForm.serviceCode || getBestRateServiceCode(panelOrder))}` : '—'}
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
            {columnMenuOpen ? (
              <div ref={columnMenuRef} className="react-column-menu" style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, background: 'var(--surface)', border: '1px solid var(--border2)', borderRadius: 8, boxShadow: 'var(--shadow-lg)', padding: '8px 0', zIndex: 300, minWidth: 220 }}>
                <div style={{ padding: '0 12px 6px', fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.5px' }}>Toggle Columns</div>
                {resolvedColumnPrefs.orderedColumns.filter((column) => column.key !== 'select' && column.key !== 'orderNum').map((column) => {
                  const checked = !resolvedColumnPrefs.hiddenColumns.has(column.key)
                  return (
                    <label key={column.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', fontSize: 12, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) => {
                          const nextHidden = new Set(resolvedColumnPrefs.hiddenColumns)
                          if (event.target.checked) nextHidden.delete(column.key)
                          else nextHidden.add(column.key)
                          void saveColumnPrefsToServer(buildColumnPrefs(resolvedColumnPrefs.orderedColumns, nextHidden, resolvedColumnPrefs.widths))
                        }}
                      />
                      {column.label}
                    </label>
                  )
                })}
              </div>
            ) : null}
          </div>
          <button id="btnSelectAll" className="btn btn-ghost btn-sm" type="button" onClick={selectAll}>Select All</button>
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
                <table className="orders-table" id="ordersTable">
                  <thead id="tableHead">
                    <tr>
                      {visibleColumns.map((column) => {
                        const sortable = column.sort != null
                        const sorted = sortable && sortState.key === column.sort
                        return (
                          <th
                            key={column.key}
                            data-col={column.key}
                            style={{ width: column.width, position: 'relative' }}
                            className={sortable ? `${sorted ? `sortable sort-${sortState.dir}` : 'sortable'}` : undefined}
                            onClick={sortable ? () => toggleSort(column.sort as SortKey) : undefined}
                          >
                            {column.label}
                            {sortable ? <span className="sort-arrow" /> : null}
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
                        <tr key={`sku-group-${group.sku}`} className="sku-group-header">
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
                                aria-label={`Select all ${group.count} orders for ${group.sku}`}
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
                              <span className="sku-link" style={{ fontSize: 11.5 }}>{group.sku}</span>
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
                            onClick={() => toggleOrderSelection(order.orderId)}
                            onDoubleClick={() => openShipStationOrder(order.orderId)}
                            onMouseEnter={() => setKbRowId(order.orderId)}
                          >
                            {visibleColumns.map((column) => (
                              <td key={column.key} data-col={column.key}>
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
                          onClick={() => toggleOrderSelection(order.orderId)}
                          onDoubleClick={() => openShipStationOrder(order.orderId)}
                          onMouseEnter={() => setKbRowId(order.orderId)}
                        >
                          {visibleColumns.map((column) => (
                            <td key={column.key} data-col={column.key}>
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
              {selectedOrderIds.length >= 2 ? renderBatchPanel() : renderSinglePanel()}
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
        <div id="print-queue-panel" style={{ display: 'flex', position: 'fixed', top: 56, right: 12, width: 520, maxWidth: 'calc(100vw - 24px)', maxHeight: 'calc(100vh - 80px)', background: 'var(--surface)', border: '1px solid var(--border2)', borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,.18)', zIndex: 1200, flexDirection: 'column', overflow: 'hidden' }}>
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
          {queuePrintMessage ? <div id="pq-progress" style={{ padding: '8px 12px', fontSize: 11, borderBottom: '1px solid var(--border)' }}>{queuePrintMessage}</div> : null}
          <div id="pq-order-list" style={{ overflow: 'auto', padding: 12, flex: 1 }}>
            {queueLoading ? <div className="empty-state">Loading queue…</div> : null}
            {!queueLoading && queueGroups.length === 0 ? <div className="pq-empty">📭 Queue is empty<br /><small>Click "Send to Queue" on any order with a label</small></div> : null}
            {!queueLoading && queueGroups.map((group) => (
              <div key={group.groupId} className="pq-group" style={{ border: '1px solid var(--border)', borderRadius: 8, marginBottom: 10, overflow: 'hidden' }}>
                <div className="pq-group-header" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'var(--surface2)' }}>
                  <span className="pq-group-label" style={{ fontWeight: 700 }}>{group.label}{group.description ? ` — ${group.description}` : ''}</span>
                  <span className="pq-group-meta" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)' }}>{group.orders.length} order{group.orders.length === 1 ? '' : 's'} · Qty {group.totalQty}</span>
                  <button className="btn btn-ghost btn-xs" type="button" onClick={() => void printQueueEntries(group.orders.map((entry) => entry.queue_entry_id))}>🖨️ Print Group</button>
                </div>
                <div className="pq-group-orders">
                  {group.orders.map((entry) => (
                    <div key={entry.queue_entry_id} className="pq-order-row" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderTop: '1px solid var(--border)' }}>
                      <span className="pq-order-num" style={{ flex: 1, fontFamily: 'monospace', color: 'var(--ss-blue)' }}>Order #{entry.order_number || entry.order_id}{entry.print_count > 0 ? ` · Reprint #${entry.print_count}` : ''}</span>
                      <span className="pq-order-qty" style={{ fontSize: 11 }}>Qty: {entry.order_qty ?? 1}</span>
                      <span className="pq-order-time" style={{ fontSize: 11, color: 'var(--text3)' }}>{new Date(entry.queued_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      <button className="pq-remove-btn" type="button" onClick={() => queueClientId != null ? void apiClient.removeFromQueue(entry.queue_entry_id, queueClientId).then(() => hydrateQueue()).catch((error) => showToast(error instanceof Error ? error.message : 'Failed to remove queue entry', 'error')) : undefined}>✕</button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {printedEntries.length > 0 ? (
              <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--text3)', marginBottom: 6, fontWeight: 600 }}>
                  📋 Printed History ({printedEntries.length})
                </div>
                {printedEntries.map((entry) => (
                  <div key={entry.queue_entry_id} className="pq-order-row" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', opacity: 0.7 }}>
                    <span className="pq-order-num" style={{ flex: 1 }}>Order #{entry.order_number || entry.order_id}</span>
                    <span className="pq-order-qty">Qty: {entry.order_qty ?? 1}</span>
                    <span className="pq-order-time">✅ {entry.last_printed_at ? new Date(entry.last_printed_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</span>
                  </div>
                ))}
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
        onClose={() => setDetailDrawerOrderId(null)}
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
            shippingAccounts={shippingAccounts}
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
