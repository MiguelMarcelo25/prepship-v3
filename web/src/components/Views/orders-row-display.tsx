// @ts-nocheck — extracted VERBATIM from the @ts-nocheck OrdersView.tsx; the loose
// DTO field reads (order.bestRate.shipmentCost etc.) predate strict typing there.
// Strict-typing this module = a deliberate later Phase 6 part (type the DTO fields,
// not the readers) — NOT done here so this extraction stays byte-identical.
//
// PS-178 (Phase 6, part 2) — order ROW display readers, extracted VERBATIM from
// OrdersView.tsx (behavior-preserving decomposition; the ratchet guard lowered
// the OrdersView line ceiling in the same PR).
//
// Everything here is a PURE READER of order DTOs: canonical-model accessors,
// best-rate / selected-rate display field resolution, the backend money tuple
// reader (PS-177), the static v2 carrier-account reference registry, and the
// two stateless row badges. Nothing in this module touches component state,
// hooks, or the live accounts list — functions that need those
// (getShipAccountDisplay, getCarrierCodeForDisplay, isTestOrder consumers)
// stay in OrdersView and import these readers.
import type { CarrierAccountDto, OrderSummaryDto } from '../../types/api'
// PS-165: service display precedence owned by ./order-shipping-display (verbatim cascade).
import { resolveDisplayServiceCode } from './order-shipping-display'

// ── primitives ────────────────────────────────────────────────────────────────

export function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function toStringValue(value: unknown) {
  return typeof value === 'string' ? value : null
}

export function toNumberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function toNumericValue(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function toProviderAccountId(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const match = value.match(/^se-(\d+)$/i)
  const parsed = Number.parseInt(match?.[1] ?? value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

export function formatMoney(amount: number | null | undefined) {
  if (typeof amount !== 'number' || Number.isNaN(amount)) return '—'
  return `$${amount.toFixed(2)}`
}

export function normalizeShippingAccountName(value: unknown) {
  const label = toStringValue(value)
  if (!label) return null
  return label
}

// ── canonical-model readers ───────────────────────────────────────────────────

export function getCanonicalOrderModel(order: OrderSummaryDto) {
  return toRecord(order.canonicalOrder)
}

export function getCanonicalRecord(order: OrderSummaryDto, key: string) {
  return toRecord(getCanonicalOrderModel(order)?.[key])
}

export function getShippingModel(order: OrderSummaryDto) {
  return getCanonicalRecord(order, 'shipping') ?? toRecord(order.shipping)
}

export function getBestRateWorkflowModel(order: OrderSummaryDto) {
  return toRecord(getShippingModel(order)?.bestRateWorkflow) ?? toRecord(order.bestRateWorkflow)
}

export function getShippingString(order: OrderSummaryDto, key: string) {
  return toStringValue(getShippingModel(order)?.[key])
}

export function getShippingNumber(order: OrderSummaryDto, key: string) {
  return toNumberValue(getShippingModel(order)?.[key])
}

export function getShippingProviderAccountId(order: OrderSummaryDto) {
  return toProviderAccountId(getShippingModel(order)?.providerAccountId)
}

export function getCanonicalSource(order: OrderSummaryDto, key: string) {
  const canonicalSourceMap = toRecord(getCanonicalOrderModel(order)?.sourceMap)
  const shippingSourceMap = toRecord(getShippingModel(order)?.sourceMap)
  return toRecord(canonicalSourceMap?.[key]) ?? toRecord(shippingSourceMap?.[key])
}

export function getCanonicalSourceVersion(order: OrderSummaryDto, key: string) {
  return toStringValue(getCanonicalSource(order, key)?.version)
}

export function getCanonicalSourceName(order: OrderSummaryDto, key: string) {
  return toStringValue(getCanonicalSource(order, key)?.source)
}

export function getLegacyClientIdForDisplay(order: OrderSummaryDto) {
  // PS-184: pure pass-through of the backend-derived value (resolveLegacyClientId
  // stamps it on every row from the canonical store/client parity map). The
  // clientId fallback only covers rows from before the backend stamped the field.
  return toNumericValue(order.legacyClientId) ?? toNumericValue(order.clientId)
}

// ── carrier-account display lookups (pure; accounts passed in) ────────────────

export function getCarrierAccountDisplay(account: CarrierAccountDto | null | undefined) {
  if (!account) return null
  return (
    normalizeShippingAccountName(account.nickname) ??
    normalizeShippingAccountName(account._label) ??
    normalizeShippingAccountName(account.code)
  )
}

export function getCarrierAccountByProviderId(accounts: CarrierAccountDto[], providerAccountId: number | null | undefined) {
  if (providerAccountId == null) return null
  return accounts.find((candidate) => (
    toProviderAccountId(candidate.shippingProviderId) === providerAccountId ||
    toProviderAccountId(candidate.carrierId) === providerAccountId
  )) ?? null
}

export function getCarrierAccountLabelByProviderId(accounts: CarrierAccountDto[], providerAccountId: number | null | undefined) {
  return getCarrierAccountDisplay(getCarrierAccountByProviderId(accounts, providerAccountId))
}

export function getShipAccountLabelById(accounts: CarrierAccountDto[], accountId: string) {
  if (!accountId) return null
  return getCarrierAccountLabelByProviderId(accounts, toProviderAccountId(accountId))
}

// ── static v2 carrier-account reference registry ──────────────────────────────

export type V2CarrierAccountRef = {
  carrierCode: string
  shippingProviderId: number
  nickname: string
  clientId: number | null
  accountNumber: string | null
}

export const V2_CARRIER_ACCOUNT_REFS: V2CarrierAccountRef[] = [
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

// PS-185: the UPS 1Z tracking-prefix attribution is BACKEND-owned —
// resolveV2CarrierAccountRef (src/routes/orders.ts) performs the identical
// derivation at the DTO layer and its result feeds the canonical
// providerAccountId + account nickname on every order's shipping model, which
// this lookup reads FIRST. The FE's duplicate tracking-prefix block could only fire
// when the backend (same data, same registry) had already failed — deleted.
// What remains is display lookup of the backend-stamped id.
export function resolveV2CarrierAccount(
  providerAccountId: number | null,
  carrierCode: string | null,
  clientId: number | null,
) {
  if (providerAccountId != null) {
    const exact = V2_CARRIER_ACCOUNT_REFS.find((account) => account.shippingProviderId === providerAccountId)
    if (exact) return exact
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

export function getV2CarrierAccountForOrder(order: OrderSummaryDto) {
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
  const clientId = getLegacyClientIdForDisplay(order)

  return resolveV2CarrierAccount(providerAccountId, carrierCode, clientId)
}

// ── rate field readers ────────────────────────────────────────────────────────

export function getRateProviderAccountId(rate: Record<string, unknown> | null | undefined) {
  if (!rate) return null
  const raw = toRecord(rate.raw)
  return (
    toProviderAccountId(rate.shippingProviderId) ??
    toProviderAccountId(rate.providerAccountId) ??
    toProviderAccountId(raw?.carrier_id) ??
    toProviderAccountId(raw?.shippingProviderId)
  )
}

export function getBestRateBaseCost(order: OrderSummaryDto) {
  if (order.orderStatus === 'awaiting_shipment' && order.bestRate) {
    const hasShipmentCost = typeof order.bestRate.shipmentCost === 'number'
    const hasOtherCost = typeof order.bestRate.otherCost === 'number'
    const hasAmount = typeof order.bestRate.amount === 'number'
    const shipmentCost = hasShipmentCost ? order.bestRate.shipmentCost as number : 0
    const otherCost = hasOtherCost ? order.bestRate.otherCost as number : 0
    const amount = hasAmount ? order.bestRate.amount as number : 0
    const total = shipmentCost + otherCost
    if (total > 0) return total
    if (hasAmount) return amount
  }

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

export function getBestRateShippingProviderId(order: OrderSummaryDto) {
  const rateProviderId = getRateProviderAccountId(toRecord(order.bestRate))
  if (order.orderStatus === 'awaiting_shipment') {
    return rateProviderId ?? getShippingProviderAccountId(order) ?? undefined
  }
  return getShippingProviderAccountId(order) ?? rateProviderId ?? undefined
}

export function getBestRateServiceCode(order: OrderSummaryDto) {
  // PS-165: service precedence (awaiting best-rate-first → canonical → best-rate) owned VERBATIM by
  // resolveDisplayServiceCode (./order-shipping-display); fields read here.
  return resolveDisplayServiceCode({
    isAwaiting: order.orderStatus === 'awaiting_shipment',
    // PS-173: backend-owned display tuple — preferred when the row carried it.
    backendDisplayServiceCode: toStringValue(toRecord(order.bestRateWorkflow?.display)?.serviceCode),
    hasBestRate: Boolean(order.bestRate),
    bestRateServiceCode: order.bestRate ? toStringValue(order.bestRate.serviceCode) : null,
    canonicalServiceCode: getShippingString(order, 'serviceCode'),
  })
}

export function getBestRateCarrierNickname(order: OrderSummaryDto) {
  const bestRateRecord = toRecord(order.bestRate)
  const rateNickname =
    (order.bestRate ? toStringValue(order.bestRate.carrierNickname) : null) ??
    toStringValue(bestRateRecord?.providerAccountNickname) ??
    toStringValue(bestRateRecord?.accountNickname)
  if (order.orderStatus === 'awaiting_shipment') return rateNickname
  return getShippingString(order, 'accountNickname') ?? rateNickname
}

export function getSelectedRateBaseCost(order: OrderSummaryDto) {
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

export function getSelectedRateFinalCost(order: OrderSummaryDto) {
  return (
    getShippingNumber(order, 'labelCost') ??
    toNumberValue(order.label?.cost) ??
    toNumberValue(order.selectedRate?.cost) ??
    getShippingNumber(order, 'selectedRateAmount') ??
    null
  )
}

export function getSelectedRateCarrierCode(order: OrderSummaryDto) {
  return (
    getShippingString(order, 'carrierCode') ??
    toStringValue(order.selectedRate?.carrierCode) ??
    toStringValue(order.bestRate?.carrierCode)
  )
}

export function getSelectedRateServiceCode(order: OrderSummaryDto) {
  return (
    getShippingString(order, 'serviceCode') ??
    toStringValue(order.selectedRate?.serviceCode) ??
    toStringValue(order.bestRate?.serviceCode)
  )
}

export function getSelectedRateCarrierNickname(order: OrderSummaryDto) {
  return (
    getShippingString(order, 'accountNickname') ??
    toStringValue(order.selectedRate?.providerAccountNickname) ??
    toStringValue(order.selectedRate?.carrierNickname) ??
    toStringValue(order.label?.carrierNickname) ??
    getV2CarrierAccountForOrder(order)?.nickname
  )
}

export function getAwaitingDisplayAccountNickname(order: OrderSummaryDto) {
  return (
    getShippingString(order, 'accountNickname') ??
    toStringValue(order.selectedRate?.providerAccountNickname) ??
    toStringValue(order.selectedRate?.carrierNickname) ??
    normalizeShippingAccountName(getBestRateCarrierNickname(order)) ??
    getV2CarrierAccountForOrder(order)?.nickname ??
    null
  )
}

export function getSelectedRateShippingProviderId(order: OrderSummaryDto) {
  return (
    getShippingProviderAccountId(order) ??
    toProviderAccountId(order.selectedRate?.shippingProviderId) ??
    toProviderAccountId(order.selectedRate?.providerAccountId) ??
    toProviderAccountId(order.label?.shippingProviderId) ??
    undefined
  )
}

export function getMarkupAmount(baseAmount: number, markedAmount: number) {
  return markedAmount - baseAmount
}

export function getBackendInsuranceAddOn(rate: unknown): number | null {
  const record = toRecord(rate)
  const direct = toNumberValue(record?.insuranceCost)
  if (direct != null && direct > 0) return direct
  const nested = toRecord(record?.insuranceCost)
  const nestedAmount = toNumberValue(nested?.amount)
  return nestedAmount != null && nestedAmount > 0 ? nestedAmount : null
}

// PS-177 (Phase 5): backend-owned row money tuple (base/marked/markup/insurance/
// margin) off the workflow DTO. Preferred by the Best Rate + Margin cells; the
// local applyCarrierMarkup paths in OrdersView remain ONLY as a deploy-skew
// fallback for rows that did not carry the tuple (deleted in Phase 6).
export function getBackendRowMoney(order: OrderSummaryDto) {
  const money = toRecord(toRecord(order.bestRateWorkflow)?.money)
  if (!money) return null
  const markedAmount = toNumberValue(money.markedAmount)
  if (markedAmount == null) return null
  return {
    baseAmount: toNumberValue(money.baseAmount),
    markedAmount,
    markupAmount: toNumberValue(money.markupAmount),
    insuranceAddOn: toNumberValue(money.insuranceAddOn),
    marginPercent: toNumberValue(money.marginPercent),
  }
}

// ── stateless row renderers ───────────────────────────────────────────────────

export function renderRateAmountWithMarkup(baseAmount: number | null, markedAmount: number | null, insuranceAddOn?: number | null) {
  const displayAmount = markedAmount ?? baseAmount
  if (displayAmount == null) return <span style={{ color: 'var(--text3)', fontSize: 11 }}>{'—'}</span>

  const markupAmount = baseAmount != null && markedAmount != null ? Math.max(0, markedAmount - baseAmount) : null
  const hasMarkup = markupAmount != null && markupAmount >= 0.005
  const hasInsurance = insuranceAddOn != null && insuranceAddOn >= 0.005
  const breakdownTitle =
    hasInsurance
      ? `Backend insurance add-on ${formatMoney(insuranceAddOn)}`
      : baseAmount != null && markupAmount != null && hasMarkup
        ? `Label Cost ${formatMoney(displayAmount)} | Base ${formatMoney(baseAmount)} + Markup ${formatMoney(markupAmount)}`
      : undefined
  return (
    <div style={{ lineHeight: 1.15 }} title={breakdownTitle}>
      <strong style={{ color: 'var(--green)', fontSize: 12 }}>{formatMoney(displayAmount)}</strong>
      {hasInsurance ? (
        <div style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 600, whiteSpace: 'nowrap' }}>
          Insurance {formatMoney(insuranceAddOn)}
        </div>
      ) : null}
      {baseAmount != null && markupAmount != null && hasMarkup ? (
        <div style={{ fontSize: 10, color: '#111827', fontWeight: 600, whiteSpace: 'nowrap' }}>
          {formatMoney(baseAmount)}
        </div>
      ) : null}
    </div>
  )
}

export function renderExtLabelBadge() {
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

// PS-036: a shipped order with no local shipment data is NOT the same as an
// externally-fulfilled order. Surfacing it as "Missing shipment sync" keeps the
// grid honest — it tells the operator the row needs a ShipStation re-sync rather
// than implying the label lives in a marketplace.
export function renderMissingShipmentSyncBadge() {
  return (
    <span
      style={{
        display: 'inline-block',
        background: '#fef3c7',
        color: '#92400e',
        padding: '2px 6px',
        borderRadius: 3,
        fontSize: 11,
        fontWeight: 600,
        cursor: 'help',
      }}
      title="Shipped in ShipStation, but local shipment data (carrier/account/rate) hasn't synced yet. Re-run ShipStation sync to backfill."
    >
      Missing shipment sync
    </span>
  )
}
