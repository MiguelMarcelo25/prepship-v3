// @ts-nocheck
import type {
  OrderFullDto,
  OrderSummaryDto,
  PackageDto,
  ProductDefaultsDto,
} from '../../types/api'
import {
  describeShippingService,
  evaluateShippingServiceEligibility,
} from '../../../../src/lib/shipping-service-eligibility'

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

function toFiniteNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function getPackageIdentifier(candidate: PackageDto | null | undefined) {
  const id = toFiniteNumber(candidate?.packageId ?? candidate?.id)
  return id == null ? '' : String(id)
}

function toPackageCode(value: unknown) {
  if (typeof value === 'string' && value.trim()) return value.trim()
  const numeric = toFiniteNumber(value)
  return numeric == null ? '' : String(numeric)
}

function packageExists(packages: PackageDto[], packageCode: unknown) {
  const code = packageCode == null ? '' : String(packageCode)
  if (!code) return false
  return packages.some((candidate) => getPackageIdentifier(candidate) === code)
}

function getRawOrder(order: OrderSummaryDto, detail: OrderFullDto | null) {
  return toRecord(detail?.raw) ?? toRecord(order.raw)
}

function orderShippingContext(order: OrderSummaryDto) {
  return {
    clientId: order.clientId ?? null,
    clientName: order.clientName ?? null,
    storeId: order.storeId ?? null,
  }
}

function isEligiblePanelService(order: OrderSummaryDto, serviceCode: string | null, source?: unknown) {
  if (!serviceCode) return false
  return evaluateShippingServiceEligibility(
    orderShippingContext(order),
    describeShippingService({
      ...(toRecord(source) ?? {}),
      serviceCode,
      serviceName: toRecord(source)?.serviceName ?? toRecord(source)?.service_type ?? serviceCode,
    }),
  ).allowed
}

function getAdvancedOptions(order: OrderSummaryDto, detail: OrderFullDto | null) {
  return toRecord(getRawOrder(order, detail)?.advancedOptions)
}

export function getPanelRequestedService(order: OrderSummaryDto, detail: OrderFullDto | null) {
  const rawOrder = getRawOrder(order, detail)
  return toStringValue(rawOrder?.requestedShippingService)
    ?? toStringValue(rawOrder?.serviceCode)
    ?? order.serviceCode
    ?? null
}

export function getPanelConfirmation(order: OrderSummaryDto, detail: OrderFullDto | null) {
  const advancedOptions = getAdvancedOptions(order, detail)
  const confirmation = toStringValue(advancedOptions?.deliveryConfirmation)
  // POLICY (DJ, 2026-06-04): default confirmation is 'none' (no surcharge,
  // matches ShipStation). Honor an explicit source-order confirmation if set.
  return confirmation || 'none'
}

export function getPanelInsurance(order: OrderSummaryDto, detail: OrderFullDto | null) {
  const rawOrder = getRawOrder(order, detail)
  const insurance = toRecord(rawOrder?.insuranceOptions)

  return {
    type: toStringValue(insurance?.provider) ?? 'none',
    value: toNumberValue(insurance?.insuredValue),
  }
}

export function getPanelWarehouseId(order: OrderSummaryDto, detail: OrderFullDto | null) {
  const advancedOptions = getAdvancedOptions(order, detail)
  return toNumberValue(advancedOptions?.warehouseId)
}

export function getPanelBillingProviderId(order: OrderSummaryDto, detail: OrderFullDto | null) {
  const advancedOptions = getAdvancedOptions(order, detail)
  return toNumberValue(advancedOptions?.billToMyOtherAccount)
}

export function getPanelPackageId(order: OrderSummaryDto, detail: OrderFullDto | null, packages: PackageDto[]) {
  const overrides = toRecord(detail?.overrides) ?? toRecord(detail?.local)
  const selectedPackageId = toPackageCode(overrides?.selectedPackageId)
    || toPackageCode(overrides?.selected_package_id)
    || toPackageCode(order.selectedPackageId)
    || toPackageCode(order.selected_package_id)
  if (selectedPackageId && packageExists(packages, selectedPackageId)) {
    return selectedPackageId
  }

  const local = toRecord(detail?.local)
  const localSelectedPid = toFiniteNumber(local?.selected_pid ?? local?.selectedPid)
  if (localSelectedPid != null && packageExists(packages, localSelectedPid)) {
    return String(localSelectedPid)
  }

  const rawOrder = getRawOrder(order, detail)
  const packageCode = toStringValue(rawOrder?.packageCode)
  if (packageCode && packageExists(packages, packageCode)) {
    return packageCode
  }

  return ''
}

export function getMatchedPackageIdByDimensions(
  dimensions: { length: number; width: number; height: number } | null | undefined,
  packages: PackageDto[],
) {
  if (!dimensions?.length || !dimensions?.width || !dimensions?.height) return ''
  const tol = 0.15

  const match = packages.find((candidate) => {
    const length = toFiniteNumber(candidate.length) ?? 0
    const width = toFiniteNumber(candidate.width) ?? 0
    const height = toFiniteNumber(candidate.height) ?? 0
    return length > 0
      && width > 0
      && height > 0
      && Math.abs(length - dimensions.length) <= tol
      && Math.abs(width - dimensions.width) <= tol
      && Math.abs(height - dimensions.height) <= tol
  })

  return match ? getPackageIdentifier(match) : ''
}

// PS-037: per-client SKU+qty combination default, resolved server-side and
// attached to the order detail payload as `comboPackageDefault`. Returns the
// package identifier when the saved package still exists, else ''.
export function getComboDefaultPackageId(detail: OrderFullDto | null, packages: PackageDto[]) {
  const combo = toRecord((detail as Record<string, unknown> | null)?.comboPackageDefault)
  if (!combo) return ''
  const packageCode = toPackageCode(combo.packageId) || toPackageCode(combo.packageCode)
  if (!packageCode) return ''
  return packageExists(packages, packageCode) ? packageCode : ''
}

export function getProductDefaultPackageId(product: ProductDefaultsDto | null, packages: PackageDto[]) {
  const packageCode = toPackageCode(product?.defaultPackageCode) || toPackageCode(product?.packageId)
  if (!packageCode) return ''

  const match = packages.find((candidate) => getPackageIdentifier(candidate) === packageCode)
  return match ? getPackageIdentifier(match) : ''
}

export function getInitialPanelShipAccountId(order: OrderSummaryDto, detail: OrderFullDto | null) {
  const bestRate = toRecord(order.bestRate)
  const bestRateProviderId = toNumberValue(bestRate?.shippingProviderId)
  const selectedRateProviderId = order.selectedRate?.providerAccountId ?? order.selectedRate?.shippingProviderId ?? null
  const labelProviderId = order.label?.shippingProviderId ?? null
  const billToMyOtherAccount = getPanelBillingProviderId(order, detail)

  if (order.orderStatus === 'awaiting_shipment') {
    return bestRateProviderId ?? billToMyOtherAccount ?? selectedRateProviderId ?? labelProviderId ?? null
  }

  return labelProviderId ?? selectedRateProviderId ?? bestRateProviderId ?? billToMyOtherAccount ?? null
}

export function getInitialPanelServiceCode(order: OrderSummaryDto, detail: OrderFullDto | null) {
  const bestRate = toRecord(order.bestRate)
  const rawOrder = getRawOrder(order, detail)
  const rawServiceCode = toStringValue(rawOrder?.serviceCode)

  if (order.orderStatus === 'awaiting_shipment') {
    const candidates: Array<[string | null, unknown]> = [
      [toStringValue(bestRate?.serviceCode), bestRate],
      [rawServiceCode, rawOrder],
      [order.serviceCode ?? null, order],
      [order.selectedRate?.serviceCode ?? null, order.selectedRate],
      [order.label?.serviceCode ?? null, order.label],
    ]
    return candidates.find(([serviceCode, source]) => isEligiblePanelService(order, serviceCode, source))?.[0] ?? ''
  }

  return order.label?.serviceCode
    ?? order.selectedRate?.serviceCode
    ?? toStringValue(bestRate?.serviceCode)
    ?? rawServiceCode
    ?? order.serviceCode
    ?? ''
}
