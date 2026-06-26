// PS-257: this module is now strict-typed. `order.bestRate` is declared `unknown`
// in types/api.ts (out of scope to widen there), so its property reads
// (order.bestRate.shipmentCost etc.) are routed through the shared LooseBestRate
// cast imported from ./orders-display-state — type-erased, no runtime change. The
// other loose DTO field reads (selectedRate / label / bestRateWorkflow / canonical)
// come from the index-signature side of OrderSummaryDto and stay `any`.
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
// PS-257: order.bestRate is `unknown` in types/api.ts; cast its property reads
// through this shared loose-record type (type-only — erased at emit).
import type { LooseBestRate } from './orders-display-state'
import type { OrderBundleDto } from './orders/use-order-bundles'
// PS-165: service display precedence owned by ./order-shipping-display (verbatim cascade).
import {
  resolveDisplayServiceCode,
  isShippBrokeredServiceCode,
  SHIPP_BROKERED_ACCOUNT_LABEL,
} from './order-shipping-display'

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
//
// PS-273: identity FIRST, carrier family NEVER. This now ONLY resolves an EXACT
// providerAccountId match against the static registry. The previous carrier-code
// fallback (return the single match, or the client/shared UPS account) FABRICATED
// an account the label was not bought on: a Shipp-brokered label stores a synthetic
// provider id (10_000_000 + carrier_accounts.id) that has no registry entry, so the
// old fallback matched carrierCode='ups' and returned the first shared UPS account
// (GG6381 on order #1587) — a direct account, not Shipp's broker account. Returning
// null for carrier-code-only input matches the backend's identity-first stance and
// lets the persisted provider_account_nickname (or the Shipp brokered-fallback in
// resolveDisplayShipAccount) own the display. No fabrication from carrier family.
export function resolveV2CarrierAccount(
  providerAccountId: number | null,
  carrierCode: string | null,
  clientId: number | null,
) {
  // carrierCode/clientId retained for signature parity with the backend twin
  // (resolveV2CarrierAccountRef); intentionally unused now that the carrier-code
  // fabrication is removed.
  void carrierCode
  void clientId
  if (providerAccountId != null) {
    const exact = V2_CARRIER_ACCOUNT_REFS.find((account) => account.shippingProviderId === providerAccountId)
    if (exact) return exact
  }

  return null
}

export function getV2CarrierAccountForOrder(order: OrderSummaryDto) {
  // PS-286: an awaiting_shipment row's CURRENT best rate is the source of truth
  // for the displayed carrier/account — required-behavior #2. The previously-
  // selected rate / partially-written label can be STALE (the operator re-rated,
  // or a saved rate moved to a different account), so on awaiting rows the
  // bestRate provider id / carrier wins over selectedRate + label. getBestRateBaseCost
  // already prefers bestRate for the awaiting COST; this aligns the account.
  // Shipped/cancelled keep the selected-first precedence (the bought label is the
  // truth there) — no shipped path is changed.
  const isAwaiting = order.orderStatus === 'awaiting_shipment'
  const bestRateProviderId = toProviderAccountId((order.bestRate as LooseBestRate | undefined)?.shippingProviderId)
  const selectedProviderId =
    getShippingProviderAccountId(order) ??
    toProviderAccountId(order.selectedRate?.shippingProviderId) ??
    toProviderAccountId(order.selectedRate?.providerAccountId) ??
    toProviderAccountId(order.label?.shippingProviderId)
  const providerAccountId = isAwaiting
    ? bestRateProviderId ?? selectedProviderId
    : selectedProviderId ?? bestRateProviderId
  const bestRateCarrierCode = toStringValue((order.bestRate as LooseBestRate | undefined)?.carrierCode)
  const selectedCarrierCode =
    getShippingString(order, 'carrierCode') ??
    toStringValue(order.selectedRate?.carrierCode)
  const carrierCode = isAwaiting
    ? bestRateCarrierCode ?? selectedCarrierCode
    : selectedCarrierCode ?? bestRateCarrierCode
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
    const hasShipmentCost = typeof (order.bestRate as LooseBestRate).shipmentCost === 'number'
    const hasOtherCost = typeof (order.bestRate as LooseBestRate).otherCost === 'number'
    const hasAmount = typeof (order.bestRate as LooseBestRate).amount === 'number'
    const shipmentCost = hasShipmentCost ? (order.bestRate as LooseBestRate).shipmentCost as number : 0
    const otherCost = hasOtherCost ? (order.bestRate as LooseBestRate).otherCost as number : 0
    const amount = hasAmount ? (order.bestRate as LooseBestRate).amount as number : 0
    const total = shipmentCost + otherCost
    if (total > 0) return total
    if (hasAmount) return amount
  }

  const canonicalAmount = getShippingNumber(order, 'bestRateAmount')
  if (canonicalAmount && canonicalAmount > 0) return canonicalAmount

  const hasShipmentCost = typeof (order.bestRate as LooseBestRate | undefined)?.shipmentCost === 'number'
  const hasOtherCost = typeof (order.bestRate as LooseBestRate | undefined)?.otherCost === 'number'
  const hasAmount = typeof (order.bestRate as LooseBestRate | undefined)?.amount === 'number'
  const shipmentCost = hasShipmentCost ? (order.bestRate as LooseBestRate | undefined)!.shipmentCost as number : 0
  const otherCost = hasOtherCost ? (order.bestRate as LooseBestRate | undefined)!.otherCost as number : 0
  const amount = hasAmount ? (order.bestRate as LooseBestRate | undefined)!.amount as number : 0
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
    bestRateServiceCode: order.bestRate ? toStringValue((order.bestRate as LooseBestRate).serviceCode) : null,
    canonicalServiceCode: getShippingString(order, 'serviceCode'),
  })
}

export function getBestRateCarrierNickname(order: OrderSummaryDto) {
  const bestRateRecord = toRecord(order.bestRate)
  // PS-273: a Shipp-brokered best rate (shipp_* service code) must render "Shipp",
  // never the fabricated underlying-carrier nickname carried on the raw rate (the
  // "980006 / GG6381" vector). Delegate the brokered test to the canonical owner.
  const bestRateServiceCode = order.bestRate
    ? toStringValue((order.bestRate as LooseBestRate).serviceCode)
    : null
  const rateNickname =
    (isShippBrokeredServiceCode(bestRateServiceCode) ? SHIPP_BROKERED_ACCOUNT_LABEL : null) ??
    (order.bestRate ? toStringValue((order.bestRate as LooseBestRate).carrierNickname) : null) ??
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
    toStringValue((order.bestRate as LooseBestRate | undefined)?.carrierCode)
  )
}

export function getSelectedRateServiceCode(order: OrderSummaryDto) {
  return (
    getShippingString(order, 'serviceCode') ??
    toStringValue(order.selectedRate?.serviceCode) ??
    toStringValue((order.bestRate as LooseBestRate | undefined)?.serviceCode)
  )
}

export function getSelectedRateCarrierNickname(order: OrderSummaryDto) {
  return (
    getShippingString(order, 'accountNickname') ??
    toStringValue(order.selectedRate?.providerAccountNickname) ??
    // PS-273: un-backfilled Shipp-brokered row -> "Shipp", never the fabricated
    // underlying-carrier nickname on the raw rate. Non-Shipp rows fall through
    // to the existing carrierNickname fallback unchanged.
    (isShippBrokeredServiceCode(getSelectedRateServiceCode(order)) ? SHIPP_BROKERED_ACCOUNT_LABEL : null) ??
    toStringValue(order.selectedRate?.carrierNickname) ??
    toStringValue(order.label?.carrierNickname) ??
    getV2CarrierAccountForOrder(order)?.nickname
  )
}

export function getAwaitingDisplayAccountNickname(order: OrderSummaryDto) {
  return (
    getShippingString(order, 'accountNickname') ??
    toStringValue(order.selectedRate?.providerAccountNickname) ??
    // PS-273: brokered awaiting row -> "Shipp" before the raw carrierNickname.
    (isShippBrokeredServiceCode(getSelectedRateServiceCode(order)) ? SHIPP_BROKERED_ACCOUNT_LABEL : null) ??
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

// PS-179: getMarkupAmount removed — its last callers (the FE margin math)
// were deleted in PS-178; the backend money tuple carries markupAmount.

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
// local FE markup-math fallback paths in OrdersView remain ONLY as a deploy-skew
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
    // PS-308: the backend SEPARATED money fields — customer-facing Best/Selected Rate
    // (customerRateAmount), the raw provider Rate Cost (rateCostAmount, financial-only —
    // null for non-financial viewers since the whole money tuple is backend-redacted), and
    // the shipping margin. Read-only pass-through; the FE never recomputes these.
    customerRateAmount: toNumberValue(money.customerRateAmount),
    rateCostAmount: toNumberValue(money.rateCostAmount),
    houseRateAmount: toNumberValue(money.houseRateAmount),
    shippingMarginAmount: toNumberValue(money.shippingMarginAmount),
    // PS-220 (slice 4b): 'house_account' => SHIPP house order (marked = the customer_rate DRP bills,
    // base = DRP's SHIPP cost, markup = the house margin). Defaults to 'carrier_markup' on deploy-skew
    // (older backends omit the field), so the badge only ever shows on a confirmed house tuple.
    markupSource: money.markupSource === 'house_account' ? ('house_account' as const) : ('carrier_markup' as const),
  }
}

// PS-239: marketplace fee + profit ride a SEPARATE backend tuple (bestRateWorkflow
// .marketplace), NOT money — so the fee shows even when there's no rate yet (the
// money getter above returns null when markedAmount is null). Backend-computed +
// canViewFinancials-redacted; the FE only renders.
export function getBackendRowMarketplace(order: OrderSummaryDto) {
  const marketplace = toRecord(toRecord(order.bestRateWorkflow)?.marketplace)
  if (!marketplace) return null
  return {
    productSubtotal: toNumberValue(marketplace.productSubtotal),
    marketplaceFee: toNumberValue(marketplace.marketplaceFee),
    profit: toNumberValue(marketplace.profit),
  }
}

// ── stateless row renderers ───────────────────────────────────────────────────

// PS-290 (slice 1): the HUGRAB $100-insurance coverage BADGE the Best Rate money cell renders
// UNDER the price. The verdict is BACKEND-owned — the DTO carries insuranceCoverageStatus /
// insuranceBadgeLabel / insuranceBadgeTone (order-rate-dto.ts -> resolveInsuranceCoverageStatus);
// this reader is a PURE pass-through of those fields, NOT a FE heuristic. Returns null for
// non-HUGRAB rows (status 'not_required') or rows the backend has not stamped, so the cell renders
// EXACTLY as today unless the backend asserted a HUGRAB coverage status.
export type RowInsuranceCoverage = {
  status: string
  label: string
  tone: string
}

export function getRowInsuranceCoverage(rate: unknown): RowInsuranceCoverage | null {
  const record = toRecord(rate)
  if (!record) return null
  const status = toStringValue(record.insuranceCoverageStatus)
  if (!status || status === 'not_required') return null
  return {
    status,
    label: toStringValue(record.insuranceBadgeLabel) ?? '',
    tone: toStringValue(record.insuranceBadgeTone) ?? 'neutral',
  }
}

export function getBestRateInsuranceCoverage(order: OrderSummaryDto): RowInsuranceCoverage | null {
  return getRowInsuranceCoverage(order.bestRate)
}

// Backend tone -> swatch. Mirrors the PS-274 certainty-chip palette; the FE only colors what the
// backend decided (green INCLUDED / red NO INSURANCE / amber UNKNOWN|UNSUPPORTED).
const COVERAGE_TONE_COLORS: Record<string, string> = {
  green: 'var(--green)',
  red: 'var(--red)',
  amber: 'var(--amber, #b7791f)',
  neutral: 'var(--text3)',
}

export function renderInsuranceCoverageBadge(coverage: RowInsuranceCoverage | null | undefined) {
  if (!coverage || !coverage.label) return null
  const color: string = COVERAGE_TONE_COLORS[coverage.tone] ?? 'var(--text3)'
  return (
    <div
      data-insurance-coverage-status={coverage.status}
      style={{ fontSize: 9.5, color, fontWeight: 700, whiteSpace: 'nowrap', letterSpacing: 0.2 }}
      title="HUGRAB $100 insurance coverage status (backend-verified)"
    >
      {coverage.label}
    </div>
  )
}

// PS-261 (display slice): the HUGRAB label-PURCHASE-GATE verdict the Rate Browser row shows
// pre-purchase, so the operator sees whether the mandatory $100 coverage is PROVEN (purchase
// allowed) vs BLOCKED (missing / unproven / unsupported) BEFORE buying. The verdict is BACKEND-owned
// — order-rate-dto stamps hugrabPurchaseAllowed / hugrabPurchaseBlockReason by delegating to the
// SAME PS-261 gate (resolveHugrabLabelPurchaseGate) the buy-path preflight uses, so display and
// purchase agree by construction. This reader is a PURE pass-through of those fields; the FE NEVER
// recomputes the purchase verdict. Returns null for non-HUGRAB / unstamped rows (allow + no reason),
// and for allowed rows (the indicator only warns about a BLOCK) so the row is unchanged unless the
// backend asserted a purchase BLOCK.
export type RowHugrabPurchaseGate = {
  allow: boolean
  reason: string
}

export function getRowHugrabPurchaseGate(rate: unknown): RowHugrabPurchaseGate | null {
  const record = toRecord(rate)
  if (!record) return null
  // Only a backend-asserted BLOCK is surfaced — `false` is the explicit signal. Allowed/unstamped
  // rows (missing flag, or allow === true) render nothing, so the row is unchanged.
  if (record.hugrabPurchaseAllowed !== false) return null
  const reason = toStringValue(record.hugrabPurchaseBlockReason) ?? ''
  if (!reason) return null
  return { allow: false, reason }
}

export function renderHugrabPurchaseGateBadge(gate: RowHugrabPurchaseGate | null | undefined) {
  if (!gate || gate.allow || !gate.reason) return null
  return (
    <div
      data-hugrab-purchase-gate="blocked"
      style={{ fontSize: 9.5, color: 'var(--red)', fontWeight: 700, whiteSpace: 'nowrap', letterSpacing: 0.2 }}
      title={gate.reason}
    >
      ⚠ COVERAGE BLOCKED
    </div>
  )
}

export function renderRateAmountWithMarkup(
  baseAmount: number | null,
  markedAmount: number | null,
  insuranceAddOn?: number | null,
  // PS-290 — backend-owned HUGRAB coverage verdict, rendered UNDER the price (HUGRAB rows only).
  // Optional + additive: omit it (or pass null) and the cell renders EXACTLY as before.
  coverage?: RowInsuranceCoverage | null,
) {
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
      {/* PS-290: HUGRAB $100-insurance coverage badge under the price (backend verdict only). */}
      {renderInsuranceCoverageBadge(coverage)}
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

// PS-309 (Per user override unlock shipped data on 2026-06-23): a shipped order whose
// only/chosen label is VOIDED reads as "Voided label" — never "Ext. Label" and never an
// active label cost. The backend (resolveShippedLabelDisplayState) owns the classification
// (shippedLabelDisplayState === 'voided_label'); this renderer is display-only.
export function renderVoidedLabelBadge() {
  return (
    <span
      data-shipped-label-state="voided"
      style={{
        display: 'inline-block',
        background: '#fdecec',
        color: '#b42318',
        padding: '2px 6px',
        borderRadius: 3,
        fontSize: 11,
        fontWeight: 700,
        cursor: 'help',
      }}
      title="The label for this order was voided — no active label exists. Any cost shown is the historical voided label, not an active charge."
    >
      Voided label
    </span>
  )
}

// PS-220 (slice 4b): SHIPP house-account order. The displayed Best/Selected Rate is the
// customer_rate DRP bills (cheapest eligible non-SHIPP); the green Margin is DRP's spread
// over its actual SHIPP cost. Shows ONLY when the backend money tuple is markupSource
// 'house_account' — never inferred client-side.
export function renderHouseBadge() {
  return (
    <span
      style={{
        display: 'inline-block',
        background: '#dcfce7',
        color: '#166534',
        padding: '1px 5px',
        borderRadius: 3,
        fontSize: 9.5,
        fontWeight: 700,
        cursor: 'help',
      }}
      title="SHIPP house account: the shown rate is the customer_rate billed (cheapest eligible non-SHIPP); the green margin is DRP's spread over its SHIPP cost."
    >
      HOUSE
    </span>
  )
}

// PS-036 + PS-215: a shipped order with no local shipment data is NOT the
// same as an externally-fulfilled order (never infer "Ext. Label" from
// absence — PS-036 safety rule, unchanged). PS-215 changes only the RESTING
// PRESENTATION: the raw "Missing shipment sync" text sat in the operator-
// facing table as a dead-end; DJ's invariant is that shipped rows show either
// External Label or an ACTIONABLE sync-error diagnostic. The shipped display
// states are:
//   local_label     — local shipment/label/rate data exists (normal render)
//   external_label  — persisted external/marketplace flag (Ext. Label badge)
//   sync_error      — neither: a recoverable ShipStation sync gap or a row
//                     the PS-056 external-shipped classifier has not
//                     classified yet (this badge; see the PS-215 runbook)
// The external/sync-error split stays owned by the canonical predicates
// (getIsExternallyFulfilled / getIsMissingShipmentSync) — this is a renderer.
export function renderShipmentSyncErrorBadge() {
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
      title="Shipment sync error: shipped, but no local label/shipment data. Re-run ShipStation sync to backfill; if it persists, this is either a marketplace-fulfilled order awaiting the external-shipped classifier or a sync gap — see the PS-215 remediation runbook."
    >
      Shipment sync error
    </span>
  )
}

// PS-312/PS-317 (S4): a combined-shipment bundle CHILD has no own label — it ships under the bundle
// PRIMARY's single label. So instead of the "Shipment sync error" dead-end, show that it resolves to
// the bundle's shared shipment (primary order # + shared tracking once the one label is bought).
// Pure renderer of the backend read-model DTO — no bundle logic in the frontend.
export function renderBundleChildBadge(bundle: OrderBundleDto) {
  const tracking = bundle.trackingNumber
  return (
    <span
      style={{
        display: 'inline-block',
        background: '#e0e7ff',
        color: '#3730a3',
        padding: '2px 6px',
        borderRadius: 3,
        fontSize: 11,
        fontWeight: 600,
        cursor: 'help',
      }}
      title={`Combined shipment: ships with order #${bundle.primaryOrderId}${
        tracking ? ` under shared tracking ${tracking}` : ' (label pending)'
      }. ${bundle.memberCount} orders in this bundle.`}
    >
      🔗 Bundled · #{bundle.primaryOrderId}
      {tracking ? ` · ${tracking}` : ''}
    </span>
  )
}
