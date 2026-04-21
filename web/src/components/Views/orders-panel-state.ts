// @ts-nocheck
import type {
  OrderFullDto,
  OrderSummaryDto,
  PackageDto,
  ProductDefaultsDto,
} from '../../types/api'

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

function getRawOrder(order: OrderSummaryDto, detail: OrderFullDto | null) {
  return toRecord(detail?.raw) ?? toRecord(order.raw)
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
  if (!confirmation || confirmation === 'none') return 'delivery'
  return confirmation
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
  const local = toRecord(detail?.local)
  const localSelectedPid = toNumberValue(local?.selected_pid)
  if (localSelectedPid != null && packages.some((candidate) => candidate.packageId === localSelectedPid)) {
    return String(localSelectedPid)
  }

  const rawOrder = getRawOrder(order, detail)
  const packageCode = toStringValue(rawOrder?.packageCode)
  if (packageCode && packages.some((candidate) => String(candidate.packageId) === packageCode)) {
    return packageCode
  }

  return ''
}

export function getMatchedPackageIdByDimensions(
  dimensions: { length: number; width: number; height: number } | null | undefined,
  packages: PackageDto[],
) {
  if (!dimensions?.length || !dimensions?.width || !dimensions?.height) return ''

  const match = packages.find((candidate) => (
    candidate.length === dimensions.length
    && candidate.width === dimensions.width
    && candidate.height === dimensions.height
  ))

  return match ? String(match.packageId) : ''
}

export function getProductDefaultPackageId(product: ProductDefaultsDto | null, packages: PackageDto[]) {
  const packageCode = product?.defaultPackageCode?.trim()
  if (!packageCode) return ''

  const match = packages.find((candidate) => String(candidate.packageId) === packageCode)
  return match ? String(match.packageId) : ''
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
    return toStringValue(bestRate?.serviceCode)
      ?? rawServiceCode
      ?? order.serviceCode
      ?? order.selectedRate?.serviceCode
      ?? order.label?.serviceCode
      ?? ''
  }

  return order.label?.serviceCode
    ?? order.selectedRate?.serviceCode
    ?? toStringValue(bestRate?.serviceCode)
    ?? rawServiceCode
    ?? order.serviceCode
    ?? ''
}
