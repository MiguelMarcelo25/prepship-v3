// PS-257: this module is now strict-typed. The loose DTO field reads
// (order.flags / order.externalShipped / order.expedited / order.bestRateWorkflow
// / nested label-rate records) come from the index-signature side of
// OrderSummaryDto and stay `any`; only `order.bestRate` is declared `unknown` in
// types/api.ts, so its property reads are routed through the exported LooseBestRate
// cast below (type-erased — no runtime behavior change).
//
// PS-166 (Wave 2a): OrdersView's shipped/cancelled/awaiting display-state and
// badge resolvers, moved VERBATIM (module-level pure helpers — no hooks, no
// JSX, no behavior change). The PS-036/PS-056 three-state shipped
// classification, the PS-165 display-precedence delegation, the PS-048
// shipped-account diagnostics, and the PS-038 expedited resolver all keep
// their bodies byte-identical; guards that pinned these DEFINITIONS read this
// module now (call-site pins still read OrdersView).
import type { CarrierAccountDto, OrderFullDto, OrderSummaryDto } from '../../types/api'
import {
  getBestRateCarrierNickname,
  getBestRateShippingProviderId,
  getCanonicalSourceName,
  getCanonicalSourceVersion,
  getCarrierAccountDisplay,
  getCarrierAccountLabelByProviderId,
  getSelectedRateCarrierNickname,
  getSelectedRateShippingProviderId,
  getShippingProviderAccountId,
  getShippingString,
  getV2CarrierAccountForOrder,
  normalizeShippingAccountName,
  toProviderAccountId,
  toRecord,
  toStringValue,
} from './orders-row-display'
import {
  resolveDisplayCarrierCode,
  resolveDisplayShipAccount,
  isShippBrokeredServiceCode,
  SHIPP_BROKERED_ACCOUNT_LABEL,
} from './order-shipping-display'
import { getPanelRequestedService } from './orders-panel-state'
import { classifyCarrier } from '../CarrierBadge'
import { ageHours, formatCarrierCode } from './orders-formatting'
import { isTestOrder } from './orders-items'
import { detectExpeditedShipping, type ExpeditedTier } from '../../lib/expedited'

// PS-257: `order.bestRate` is declared `unknown` in types/api.ts (out of scope to
// widen there). Display readers cast it through this loose record so its property
// reads type as `unknown` and forward to toStringValue / toProviderAccountId /
// normalizeShippingAccountName. Type-only — erased at emit, no runtime change.
// Shared with orders-table-columns.ts (imported from here).
export type LooseBestRate = Record<string, unknown>

export function getRequestedService(order: OrderSummaryDto, detail: OrderFullDto | null) {
  return getPanelRequestedService(order, detail)
}

export function isStrictShippedOrder(order: OrderSummaryDto) {
  return order.orderStatus === 'shipped'
}

export function getCarrierCodeForDisplay(order: OrderSummaryDto) {
  // PS-165: the awaiting-vs-shipped carrier precedence (incl. PS-079 best-rate-first on awaiting and
  // the known-carrier-nickname fallback for blank-carrier aggregator rates) is owned VERBATIM by
  // resolveDisplayCarrierCode (./order-shipping-display); the raw fields are still read here.
  const isAwaiting = order.orderStatus === 'awaiting_shipment'
  const bestRateNickname = isAwaiting ? getBestRateCarrierNickname(order) : null
  return resolveDisplayCarrierCode({
    isTest: isTestOrder(order),
    isAwaiting,
    // PS-173: backend-owned display tuple — preferred when the row carried it.
    backendDisplayCarrierCode: toStringValue(toRecord(order.bestRateWorkflow?.display)?.carrierCode),
    bestRateCarrierCode: toStringValue((order.bestRate as LooseBestRate | undefined)?.carrierCode),
    canonicalCarrierCode: getShippingString(order, 'carrierCode'),
    selectedRateCarrierCode: toStringValue(order.selectedRate?.carrierCode),
    bestRateNickname,
    bestRateNicknameIsKnownCarrier: bestRateNickname ? classifyCarrier(bestRateNickname) !== 'other' : false,
  })
}

export function getShipAccountDisplay(order: OrderSummaryDto, accounts: CarrierAccountDto[]) {
  // PS-165: the shipping-account display PRECEDENCE is owned VERBATIM by resolveDisplayShipAccount
  // (./order-shipping-display). The candidate RESOLUTION stays here — it depends on the FE scoped
  // carrier cache (getV2CarrierAccountForOrder) + the live `accounts` array, which the backend
  // serializer does not have. PS-079 awaiting-best-rate-first semantics preserved exactly.
  let awaitingBestRateNickname: string | null = null
  if (order.orderStatus === 'awaiting_shipment' && order.bestRate) {
    const bestRateRecord = toRecord(order.bestRate)
    awaitingBestRateNickname =
      normalizeShippingAccountName((order.bestRate as LooseBestRate).carrierNickname) ??
      normalizeShippingAccountName(toStringValue(bestRateRecord?.providerAccountNickname)) ??
      normalizeShippingAccountName(toStringValue(bestRateRecord?.accountNickname)) ??
      getCarrierAccountLabelByProviderId(accounts, getBestRateShippingProviderId(order))
  }

  const v2Account = getV2CarrierAccountForOrder(order)

  let labelAccountLabel: string | null = null
  if (order.label?.shippingProviderId != null) {
    const account = accounts.find((candidate) => candidate.shippingProviderId === order.label!.shippingProviderId)
    labelAccountLabel = getCarrierAccountDisplay(account) ?? null
  }

  let bestRateNickname: string | null = null
  if (order.bestRate) {
    const bestRateRecord = toRecord(order.bestRate)
    bestRateNickname =
      normalizeShippingAccountName((order.bestRate as LooseBestRate).carrierNickname) ??
      normalizeShippingAccountName(toStringValue(bestRateRecord?.providerAccountNickname)) ??
      normalizeShippingAccountName(toStringValue(bestRateRecord?.accountNickname))
  }

  return resolveDisplayShipAccount({
    isTest: isTestOrder(order),
    backendDisplayAccountNickname: normalizeShippingAccountName(toStringValue(toRecord(order.bestRateWorkflow?.display)?.accountNickname)),
    awaitingBestRateNickname,
    canonicalNickname: normalizeShippingAccountName(getShippingString(order, 'accountNickname')),
    selectedNickname: normalizeShippingAccountName(order.selectedRate?.providerAccountNickname),
    v2AccountNickname: v2Account ? v2Account.nickname : null,
    hasSelectedRate: Boolean(order.selectedRate),
    labelAccountLabel,
    bestRateNickname,
    carrierCodeFallback: formatCarrierCode(order.selectedRate?.carrierCode ?? (order.bestRate as LooseBestRate | undefined)?.carrierCode),
    // PS-273: the shipment's service code drives the Shipp brokered-account
    // fallback for rows whose provider_account_nickname has not been backfilled.
    brokeredServiceCode:
      toStringValue(order.label?.serviceCode) ??
      toStringValue(order.selectedRate?.serviceCode) ??
      getShippingString(order, 'serviceCode'),
  })
}

export function hasAuthoritativeProviderId(order: OrderSummaryDto) {
  const providerId = getShippingProviderAccountId(order) ?? toProviderAccountId(order.label?.shippingProviderId)
  if (providerId == null) return false
  const sourceVersion = getCanonicalSourceVersion(order, 'shipping.providerAccountId')
  const sourceName = getCanonicalSourceName(order, 'shipping.providerAccountId')
  return sourceVersion === 'v2' && sourceName !== 'shipments.provider_account_id'
}

export function hasV2SelectedRatePayload(order: OrderSummaryDto) {
  return getCanonicalSourceVersion(order, 'shipping.selectedRate') === 'v2'
}

// PS-036: read the EXPLICIT external-fulfillment signal from where the API
// actually emits it. The order summary nests these under `flags`
// (orders.ts -> flags.externallyShipped / flags.externallyFulfilled); the older
// top-level `order.externalShipped` is kept only as a defensive fallback.
// `externallyShipped` is the operator's mark-as-shipped override; `externallyFulfilled`
// is ShipStation's own marketplace/Amazon fulfillment flag. Either one is a real
// external signal — the ABSENCE of local data is NOT.
export function hasExplicitExternalFlag(order: OrderSummaryDto): boolean {
  const flags = (order.flags ?? null) as { externallyShipped?: unknown; externallyFulfilled?: unknown } | null
  return (
    flags?.externallyShipped === true ||
    flags?.externallyFulfilled === true ||
    order.externalShipped === true
  )
}

// True when the local DB actually carries shipment metadata for the row.
export function hasLocalShipmentData(order: OrderSummaryDto): boolean {
  return Boolean(
    order.label?.cost ||
    order.label?.trackingNumber ||
    hasAuthoritativeProviderId(order) ||
    hasV2SelectedRatePayload(order),
  )
}

export type ShippedDataState = 'external' | 'local' | 'missing'

// PS-036: classify a shipped row into one of three honest states instead of
// conflating "no local data" with "externally fulfilled".
// Per user override unlock shipped data on 2026-06-01: PS-056 keeps this
// shipped-row display classification explicit so marketplace-fulfilled rows
// show Ext. Label only after persisted external classification, while
// recoverable ShipStation shipment/fulfillment gaps stay on the actionable
// sync-error badge (PS-215 renamed the old raw resting text).
export function getShippedDataState(order: OrderSummaryDto): ShippedDataState {
  if (hasExplicitExternalFlag(order)) return 'external'
  if (hasLocalShipmentData(order)) return 'local'
  return 'missing'
}

export function getIsExternallyFulfilled(order: OrderSummaryDto) {
  if (order.orderStatus === 'awaiting_shipment') return false
  return getShippedDataState(order) === 'external'
}

// PS-036: shipped, not flagged external, and missing local shipment data ->
// the row needs a ShipStation re-sync, not an "Ext. Label" badge.
export function getIsMissingShipmentSync(order: OrderSummaryDto) {
  if (order.orderStatus === 'awaiting_shipment') return false
  return getShippedDataState(order) === 'missing'
}

export function getShippedDisplayCarrierCode(order: OrderSummaryDto) {
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

export function getShippedDisplayServiceCode(order: OrderSummaryDto) {
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

export function getShippedDisplayProviderId(order: OrderSummaryDto) {
  return (
    getShippingProviderAccountId(order) ??
    toProviderAccountId(order.selectedRate?.shippingProviderId) ??
    toProviderAccountId(order.selectedRate?.providerAccountId) ??
    toProviderAccountId(order.label?.shippingProviderId) ??
    toProviderAccountId((order.bestRate as LooseBestRate | undefined)?.shippingProviderId) ??
    getV2CarrierAccountForOrder(order)?.shippingProviderId ??
    null
  )
}

// PS-273: a Shipp-brokered shipment's service code is shipp_-prefixed by the
// connector. On un-backfilled rows (no persisted provider_account_nickname) this
// derives the honest "Shipp" account label so the diagnostic nickname column can
// never fall through to a fabricated direct carrier account (GG6381). Reads the
// shipment's service code (label/selected/canonical), display-only.
export function getBrokeredShippAccountNickname(order: OrderSummaryDto): string | null {
  const serviceCode =
    toStringValue(order.label?.serviceCode) ??
    toStringValue(order.selectedRate?.serviceCode) ??
    getShippingString(order, 'serviceCode')
  return isShippBrokeredServiceCode(serviceCode) ? SHIPP_BROKERED_ACCOUNT_LABEL : null
}

export function getShippedDisplayAccountNickname(order: OrderSummaryDto) {
  if (getIsExternallyFulfilled(order)) return null
  // Per user override unlock shipped data on 2026-06-01: PS-048 keeps this
  // shipped-row diagnostic display-only and forbids carrier-code nickname fallbacks.
  // Per user override unlock shipped data on 2026-06-17 (PS-273): the Shipp brokered
  // fallback now precedes the carrier-nickname / best-rate-nickname / static-registry
  // GUESSES (it still loses to a genuinely-persisted accountNickname or the selected
  // rate's providerAccountNickname). On an un-backfilled brokered row the selectedRate
  // / bestRate carry the pre-purchase DIRECT account's nickname (e.g. "ROCEL C81F70")
  // — that account is NOT the Shipp broker account the label was bought on, so it must
  // never name this shipment. Display-only; no shipped/cancelled mutation.
  return (
    getShippingString(order, 'accountNickname') ??
    toStringValue(order.selectedRate?.providerAccountNickname) ??
    getBrokeredShippAccountNickname(order) ??
    toStringValue(order.selectedRate?.carrierNickname) ??
    normalizeShippingAccountName(getBestRateCarrierNickname(order)) ??
    getV2CarrierAccountForOrder(order)?.nickname ??
    null
  )
}

export function getCancelledDisplayCarrierCode(order: OrderSummaryDto) {
  return (
    getShippingString(order, 'carrierCode') ??
    toStringValue(order.selectedRate?.carrierCode) ??
    toStringValue(order.label?.carrierCode) ??
    toStringValue(order.carrierCode) ??
    toStringValue((order.bestRate as LooseBestRate | undefined)?.carrierCode)
  )
}

export function getCancelledDisplayProviderId(order: OrderSummaryDto) {
  return (
    getSelectedRateShippingProviderId(order) ??
    toProviderAccountId((order.bestRate as LooseBestRate | undefined)?.shippingProviderId) ??
    getV2CarrierAccountForOrder(order)?.shippingProviderId ??
    null
  )
}

export function getCancelledDisplayServiceCode(order: OrderSummaryDto) {
  return (
    getShippingString(order, 'serviceCode') ??
    toStringValue(order.selectedRate?.serviceCode) ??
    toStringValue(order.label?.serviceCode) ??
    toStringValue(order.serviceCode) ??
    toStringValue((order.bestRate as LooseBestRate | undefined)?.serviceCode)
  )
}

export function getCancelledDisplayAccountNickname(order: OrderSummaryDto) {
  // Per user override unlock shipped data on 2026-06-17 (PS-273): a cancelled
  // Shipp-brokered row must also show "Shipp" rather than fabricating a direct
  // carrier account. Genuinely-persisted identity (canonical accountNickname,
  // the selected rate's providerAccountNickname) still wins; the Shipp fallback
  // then precedes every carrier-nickname / best-rate / static-registry GUESS so an
  // un-backfilled brokered row never shows the pre-purchase DIRECT account nickname
  // the label was not bought on. Display-only — no mutation, no read-only gate.
  return (
    getShippingString(order, 'accountNickname') ??
    toStringValue(order.selectedRate?.providerAccountNickname) ??
    getBrokeredShippAccountNickname(order) ??
    getSelectedRateCarrierNickname(order) ??
    normalizeShippingAccountName(getBestRateCarrierNickname(order)) ??
    getV2CarrierAccountForOrder(order)?.nickname ??
    normalizeShippingAccountName(order.label?.carrierCode) ??
    formatCarrierCode(getCancelledDisplayCarrierCode(order))
  )
}

export function shouldShowCarrierExtLabel(order: OrderSummaryDto) {
  // getIsExternallyFulfilled already honors the explicit external flags
  // (flags.externallyShipped / flags.externallyFulfilled). PS-036: a shipped row
  // with merely-missing local data is no longer treated as external here.
  return order.orderStatus === 'shipped' && getIsExternallyFulfilled(order)
}

export function getIsException(order: OrderSummaryDto) {
  if (order.orderStatus !== 'awaiting_shipment') return false
  return ageHours(order.orderDate) > 48 || !(order.weight?.value && order.weight.value > 0)
}

// PS-038 — Expedited badge resolver. Prefers the server-computed
// `order.expedited` object from the Orders list API (detected on the buyer's
// REQUESTED service for both awaiting + shipped buckets); falls back to the
// frontend mirror detector on the requested service when an older payload
// lacks the field. Returns the tier (for styling) + human-readable label.
export function getExpeditedBadge(
  order: OrderSummaryDto,
  detail: OrderFullDto | null,
): { tier: ExpeditedTier; label: string } | null {
  const fromApi = order?.expedited
  if (
    fromApi &&
    typeof fromApi === 'object' &&
    fromApi.isExpedited &&
    fromApi.tier &&
    fromApi.label
  ) {
    return { tier: fromApi.tier as ExpeditedTier, label: String(fromApi.label) }
  }
  const detected = detectExpeditedShipping(getRequestedService(order, detail))
  if (detected.isExpedited && detected.tier && detected.label) {
    return { tier: detected.tier, label: detected.label }
  }
  return null
}

export function copyText(value: string) {
  if (!value || typeof navigator === 'undefined' || !navigator.clipboard) return
  void navigator.clipboard.writeText(value)
}
