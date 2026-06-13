// PS-166 (Wave 1c): OrdersView's pure item/order/ship-to accessors, moved
// VERBATIM out of OrdersView.tsx (module-level helpers — no hooks, no JSX,
// no behavior change). Strict TypeScript; OrdersView's @ts-nocheck no longer
// covers this code. Value coercion + canonical-model readers come from the
// SAME owners OrdersView already used (./orders-row-display, PS-178), and
// TEST_CLIENT_IDS from the v2 api client — no logic was duplicated.
import type { OrderFullDto, OrderSummaryDto } from '../../types/api'
import {
  getCanonicalRecord,
  getLegacyClientIdForDisplay,
  toNumberValue,
  toNumericValue,
  toRecord,
  toStringValue,
} from './orders-row-display'
import { TEST_CLIENT_IDS } from '../../lib/v2-apiClient'

export interface OrderLineItem {
  sku: string | null
  name: string | null
  quantity: number
  imageUrl: string | null
  unitPrice: number | null
  adjustment: boolean
}

export const TEST_PACK_SKU = 'TEST-PACK'
export const TEST_PACK_WEIGHT_OZ = 4
export const TEST_PACK_DIMS = { length: 5, width: 3, height: 1, units: 'inches' }

export function normalizeItems(source: unknown): OrderLineItem[] {
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

export function getActiveItems(order: OrderSummaryDto, detail: OrderFullDto | null) {
  const rawOrder = toRecord(detail?.raw)
  const detailItems = normalizeItems(rawOrder?.items)
  const sourceItems = detailItems.length > 0 ? detailItems : normalizeItems(order.items)
  return sourceItems.filter((item) => !item.adjustment)
}

export function getPrimaryItem(order: OrderSummaryDto, detail: OrderFullDto | null) {
  return getActiveItems(order, detail)[0] ?? null
}

// eBay listings frequently ship without a custom SKU, so their lines would
// otherwise collapse into a single "Missing SKU" group. For eBay orders only we
// fall back to the item title for SKU grouping/labeling (awaiting + shipped),
// mirroring the print-queue PS-070 behavior. Detection follows the app
// convention (CarrierBadge / InventoryView): the client/store name carries the
// marketplace (e.g. "eBay - DJC"); we also honor explicit source fields and the
// backend's `ebay-` externalOrderId prefix.
export function isEbayOrder(order: OrderSummaryDto): boolean {
  const clientName = (toStringValue(order.clientName) ?? '').toLowerCase()
  if (clientName.includes('ebay')) return true
  const raw = toRecord(order.raw)
  const source = (
    toStringValue(order.sourceProvider) ??
    toStringValue(raw?.source_provider) ??
    toStringValue(raw?.sourceProvider) ??
    toStringValue(raw?.source) ??
    toStringValue(raw?.provider) ??
    toStringValue(raw?.marketplace) ??
    ''
  ).toLowerCase()
  if (source.includes('ebay')) return true
  const externalOrderId = (toStringValue(order.externalOrderId) ?? '').toLowerCase()
  return externalOrderId.startsWith('ebay-')
}

export function getMergedItems(order: OrderSummaryDto, detail: OrderFullDto | null) {
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

export function getTotalQuantity(order: OrderSummaryDto, detail: OrderFullDto | null) {
  return getActiveItems(order, detail).reduce((sum, item) => sum + (item.quantity || 1), 0)
}

export function getOrderSortTimeMs(order: OrderSummaryDto) {
  const value = order.orderDate ?? order.date ?? order.createdAt ?? null
  const time = value ? new Date(value).getTime() : 0
  return Number.isFinite(time) ? time : 0
}

export function hasTestPackItem(order: OrderSummaryDto, detail: OrderFullDto | null) {
  return getActiveItems(order, detail).some((item) => (item.sku ?? '').trim().toUpperCase() === TEST_PACK_SKU)
}

export function isTestOrder(order: OrderSummaryDto, detail: OrderFullDto | null = null) {
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

// PS-186: backend-owned test-order fact for MONEY paths (testLabel on the wire). Reads only
// backend-derived facts — order.isTest (stamped by /orders from clients.isTest) and the
// TEST_CLIENT_IDS set (also populated from clients.isTest). The heuristic isTestOrder() above
// remains DISPLAY-ONLY (badges, filters, mock-rate previews) until PS-187 deletes it; it must
// never feed testLabel again — a heuristic misfire on a real order would mint a fake label.
export function isBackendTestOrder(order: OrderSummaryDto) {
  if ((order as { isTest?: boolean }).isTest === true) return true
  const clientId = toNumericValue(order.clientId)
  return clientId != null && TEST_CLIENT_IDS.has(clientId)
}

export function getOrderWeightOz(order: OrderSummaryDto, detail: OrderFullDto | null) {
  const savedWeightOz = order.weight?.value ?? 0
  if (savedWeightOz > 0) return savedWeightOz

  const directWeightOz = toNumberValue(order.weightOz)
  if (directWeightOz != null && directWeightOz > 0) return directWeightOz

  const overrideWeightOz = toNumberValue(toRecord(order.overrides)?.rateWeightOz)
  if (overrideWeightOz != null && overrideWeightOz > 0) return overrideWeightOz

  if (isTestOrder(order, detail) && hasTestPackItem(order, detail)) {
    return getActiveItems(order, detail).reduce((sum, item) => {
      const sku = (item.sku ?? '').trim().toUpperCase()
      return sum + (sku === TEST_PACK_SKU ? (item.quantity || 1) * TEST_PACK_WEIGHT_OZ : 0)
    }, 0)
  }
  return 0
}

export function getPrimarySku(order: OrderSummaryDto, detail: OrderFullDto | null) {
  const primary = getPrimaryItem(order, detail)
  return (primary?.sku ?? primary?.name ?? '').toLowerCase().trim()
}

export function getPrimarySkuLabel(order: OrderSummaryDto, detail: OrderFullDto | null) {
  const primary = getPrimaryItem(order, detail)
  return (primary?.sku ?? primary?.name ?? '').trim() || 'Unknown SKU'
}

export function buildSearchText(order: OrderSummaryDto, detail: OrderFullDto | null) {
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

export function getShipTo(order: OrderSummaryDto, detail: OrderFullDto | null) {
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

export function getShipToLine(order: OrderSummaryDto, detail: OrderFullDto | null) {
  const shipTo = getShipTo(order, detail)
  const line = [shipTo.city, shipTo.state, shipTo.postalCode].filter(Boolean).join(', ')
  return line || '—'
}

export function getAddressBlock(order: OrderSummaryDto, detail: OrderFullDto | null) {
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

export function getDimensions(order: OrderSummaryDto, detail: OrderFullDto | null) {
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
