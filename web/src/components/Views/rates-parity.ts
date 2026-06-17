// TODO PS-257: restore real types — @prepshipv2/contracts is erased at runtime
// and absent in v4, so these DTO shapes are aliased to `any` locally (matching
// the analysis-parity.ts / RatesView.tsx precedent) until v4 grows a real rates
// contracts module.
type LiveRatesRequestDto = any
type RateDto = any
import type { Rate } from '../../types/orders'
import { isBlockedRate } from '../../utils/markups'

export interface RatesFormState {
  // Weight is split into pounds + ounces in the UI so operators can
  // type natural shipping weight ('2 lb 8 oz' instead of mentally
  // converting to '40 oz'). The backend still receives total ounces;
  // the conversion happens in buildLiveRatesPayload.
  weightLb: string
  weightOz: string
  lengthIn: string
  widthIn: string
  heightIn: string
  fromZip: string
  toZip: string
}

export interface RatesEmptyState {
  icon: string
  message: string
}

export interface RateRowView {
  carrierLabel: string
  carrierBadgeLabel: string
  carrierNickname: string | null
  rateSourceLabel: string
  rateSourceDetail: string | null
  rateSourceTone: string
  carrierCode: string
  serviceLabel: string
  baseCost: number
  yourPrice: number
  profit: number
  isBest: boolean
  rate: RateDto
}

export interface RateSourceAccount {
  carrierId?: string | null
  shippingProviderId?: number | string | null
  sourceClientName?: string | null
  clientId?: number | null
  nickname?: string | null
  _label?: string | null
  code?: string | null
  carrierCode?: string | null
}

type RateMarkup = { type?: string; value?: number }
type RateMarkupsMap = Record<string, RateMarkup | undefined>

export function parseRatesNumber(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

// Returns total weight in ounces given the lb + oz form fields.
// Single source of truth so validation, payload build, and display
// label all derive from the same number.
export function totalWeightOz(form: RatesFormState): number {
  const lb = parseRatesNumber(form.weightLb)
  const oz = parseRatesNumber(form.weightOz)
  return lb * 16 + oz
}

export function getRatesValidationState(form: RatesFormState): RatesEmptyState | null {
  if (totalWeightOz(form) <= 0) {
    return { icon: '⚖️', message: 'Enter weight to get rates' }
  }

  if (!form.toZip.trim()) {
    return { icon: '📍', message: 'Enter a destination ZIP' }
  }

  return null
}

export function buildLiveRatesPayload(form: RatesFormState): LiveRatesRequestDto {
  return {
    // PS-188: the origin is BACKEND-owned (getDefaultShipFrom — default Location
    // row, env fallback). The form value is seeded from GET /locations/default-
    // ship-from; no FE hardcode. Empty is fine: the backend rates path always
    // quotes from its canonical default when no origin is sent.
    fromPostalCode: form.fromZip.trim(),
    toPostalCode: form.toZip.trim(),
    toCountry: 'US',
    weight: {
      // Backend wants total ounces — combine lb + oz at the boundary
      // so server-side code stays unchanged.
      value: totalWeightOz(form),
      units: 'ounces',
    },
    dimensions: {
      units: 'inches',
      length: parseRatesNumber(form.lengthIn),
      width: parseRatesNumber(form.widthIn),
      height: parseRatesNumber(form.heightIn),
    },
  }
}

export function getAvailableRates(rates: RateDto[]): RateDto[] {
  return rates.filter((rate) => !isBlockedRate({
    shippingProviderId: rate.shippingProviderId ?? -1,
    carrierCode: rate.carrierCode,
    serviceCode: rate.serviceCode,
    serviceName: rate.serviceName,
    packageType: rate.packageType,
    amount: rate.shipmentCost + rate.otherCost,
    shipmentCost: rate.shipmentCost,
    otherCost: rate.otherCost,
    carrierNickname: rate.carrierNickname,
    deliveryDays: rate.deliveryDays,
    estimatedDelivery: rate.estimatedDelivery,
  } as Rate))
}

export function getCarrierBadgeClass(carrierCode: string | null | undefined) {
  if (!carrierCode) return 'carrier-other'
  if (carrierCode.includes('ups')) return 'carrier-ups'
  if (carrierCode.includes('fedex')) return 'carrier-fedex'
  if (carrierCode.includes('stamps') || carrierCode.includes('usps')) return 'carrier-usps'
  return 'carrier-other'
}

export function getCarrierLabel(rate: RateDto): string {
  const carrierCode = (rate.carrierCode || '').toLowerCase()
  if (carrierCode.includes('stamps') || carrierCode.includes('usps')) return 'USPS'
  if (carrierCode.includes('fedex')) return 'FedEx'
  if (carrierCode.includes('dhl')) return 'DHL'
  if (carrierCode.includes('walmart')) return 'Walmart'
  if (carrierCode.includes('ehub')) return 'eHub'
  if (carrierCode.includes('easypost')) return 'EasyPost'
  if (carrierCode.includes('amazon')) return 'Amazon'
  if (carrierCode.includes('ebay')) return 'eBay'
  if (carrierCode.includes('ups')) return 'UPS'
  return carrierCode ? carrierCode.replace(/_/g, ' ').toUpperCase() : '—'
}

export function getCarrierNickname(rate: RateDto): string | null {
  const raw = (rate as any)?.raw ?? {}
  const nickname =
    (rate as any)?.carrierNickname ??
    (rate as any)?.providerAccountNickname ??
    (rate as any)?.carrier_nickname ??
    raw.carrier_nickname ??
    raw.nickname ??
    null
  return typeof nickname === 'string' && nickname.trim() ? nickname.trim() : null
}

function cleanRateSource(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function toProviderAccountId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const match = value.match(/^se-(\d+)$/i)
  const parsed = Number.parseInt(match?.[1] ?? value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

function getRateProviderId(rate: RateDto): number | null {
  const raw = (rate as any)?.raw ?? {}
  return toProviderAccountId(
    (rate as any)?.shippingProviderId ??
      (rate as any)?.providerAccountId ??
      (rate as any)?.carrierId ??
      raw.carrier_id ??
      raw.carrierId
  )
}

function findRateSourceAccount(rate: RateDto, accounts: RateSourceAccount[]): RateSourceAccount | null {
  const providerId = getRateProviderId(rate)
  if (providerId != null) {
    const byProvider = accounts.find((account) =>
      toProviderAccountId(account.shippingProviderId ?? account.carrierId) === providerId
    )
    if (byProvider) return byProvider
  }

  const raw = (rate as any)?.raw ?? {}
  const carrierId = cleanRateSource((rate as any)?.carrierId ?? raw.carrier_id ?? raw.carrierId)
  if (carrierId) {
    const byCarrierId = accounts.find((account) =>
      cleanRateSource(account.carrierId)?.toLowerCase() === carrierId.toLowerCase()
    )
    if (byCarrierId) return byCarrierId
  }

  const carrierCode = cleanRateSource((rate as any)?.carrierCode ?? raw.carrier_code ?? raw.carrierCode)
  const nickname = getCarrierNickname(rate)
  if (!carrierCode || !nickname) return null

  return accounts.find((account) =>
    cleanRateSource(account.carrierCode ?? account.code)?.toLowerCase() === carrierCode.toLowerCase() &&
    cleanRateSource(account.nickname ?? account._label)?.toLowerCase() === nickname.toLowerCase()
  ) ?? null
}

const DIRECT_PROVIDER_LABELS: Record<string, string> = {
  amazon_shipping: 'Amazon Shipping',
  ebay_shipping: 'eBay Shipping',
  ehub: 'eHub',
  easypost: 'EasyPost',
  fedex: 'FedEx Direct',
  gls: 'GLS Direct',
  shipp: 'Shipp',
  shipengine: 'ShipEngine',
  simulator: 'Simulator',
  stamps_com: 'Stamps.com Direct',
  ups: 'UPS Direct',
  usps: 'USPS Direct',
  walmart_shipping: 'Walmart Shipping',
}

function normalizeProviderKey(value: unknown): string | null {
  const cleaned = cleanRateSource(value)
  return cleaned ? cleaned.toLowerCase().replace(/[\s-]+/g, '_') : null
}

function getDirectProviderLabel(value: unknown): string | null {
  const key = normalizeProviderKey(value)
  return key ? DIRECT_PROVIDER_LABELS[key] ?? null : null
}

const PROVIDER_TONE_CLASSES = [
  'bg-sky-50 text-sky-800 ring-sky-200',
  'bg-emerald-50 text-emerald-800 ring-emerald-200',
  'bg-amber-50 text-amber-800 ring-amber-200',
  'bg-violet-50 text-violet-800 ring-violet-200',
  'bg-rose-50 text-rose-800 ring-rose-200',
  'bg-cyan-50 text-cyan-800 ring-cyan-200',
  'bg-fuchsia-50 text-fuchsia-800 ring-fuchsia-200',
  'bg-lime-50 text-lime-800 ring-lime-200',
  'bg-indigo-50 text-indigo-800 ring-indigo-200',
  'bg-teal-50 text-teal-800 ring-teal-200',
  'bg-orange-50 text-orange-800 ring-orange-200',
  'bg-slate-100 text-slate-800 ring-slate-200',
]

// 2026-05-13: explicit tone overrides for well-known providers.
// The hash-mod-12 lookup below works fine for arbitrary unknown
// labels, but it deterministically COLLIDES when two well-known
// labels happen to hash to the same bucket — which is exactly
// what happened with "shipp" and "shipstation" both landing in
// the violet slot. Operators couldn't tell them apart at a
// glance on the Rate Shop page.
//
// Anchoring well-known providers to a deliberately-chosen tone:
//   • Shipp gets sky-blue, matching its brand color (#1f7fd4 in
//     utils/logo/shipp.tsx). Operators see the same blue on the
//     Settings → Carriers page and the Rate Shop, reinforcing
//     "blue = Shipp" recognition.
//   • ShipStation stays in violet (its current hash result) so
//     existing muscle memory is preserved.
//
// Add a new entry here when another collision shows up. The
// hash fallback remains for any label not on this list.
const EXPLICIT_TONE_BY_LABEL: Record<string, string> = {
  shipp: 'bg-sky-50 text-sky-800 ring-sky-200',
  shipstation: 'bg-violet-50 text-violet-800 ring-violet-200',
}

function sourceToneFor(value: unknown): string {
  const text = String(value ?? '').trim().toLowerCase()
  const explicit = EXPLICIT_TONE_BY_LABEL[text]
  if (explicit) return explicit
  let hash = 0
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0
  }
  return PROVIDER_TONE_CLASSES[hash % PROVIDER_TONE_CLASSES.length]!
}

export function getRateSourceLabel(
  rate: RateDto,
  accounts: RateSourceAccount[] = [],
): { label: string; detail: string | null; tone: string } {
  const raw = (rate as any)?.raw ?? {}
  const account = findRateSourceAccount(rate, accounts)
  const providerKey =
    normalizeProviderKey(account?.code ?? account?.carrierCode) ??
    normalizeProviderKey((rate as any)?.provider ?? raw.provider) ??
    normalizeProviderKey((rate as any)?.source ?? raw.source) ??
    normalizeProviderKey((rate as any)?.carrierCode ?? raw.carrier_code ?? raw.carrierCode)
  const accountSource = cleanRateSource(account?.sourceClientName)
  const accountSourceKey = normalizeProviderKey(accountSource)
  const rawSourceKey = normalizeProviderKey((rate as any)?.source ?? raw.source)
  const directProviderLabel = getDirectProviderLabel(providerKey) ?? getDirectProviderLabel(rawSourceKey)
  const providerId = getRateProviderId(rate)
  const isSyntheticDirectProvider = providerId != null && providerId >= 10_000_000
  const isDirectAccount =
    accountSourceKey === 'direct_carrier_accounts' ||
    rawSourceKey === 'direct' ||
    rawSourceKey === 'carrier_accounts' ||
    isSyntheticDirectProvider
  const label = isDirectAccount
    ? directProviderLabel ?? 'Direct Carrier'
    : directProviderLabel && rawSourceKey && rawSourceKey !== 'shipstation'
      ? directProviderLabel
      : 'ShipStation'

  const sourceClientId =
    (rate as any)?.sourceClientId ??
    (rate as any)?.source_client_id ??
    raw.sourceClientId ??
    raw.source_client_id ??
    account?.clientId ??
    null
  const detailParts: string[] = []
  if (!isDirectAccount && accountSource && accountSourceKey !== 'direct_carrier_accounts') {
    detailParts.push(accountSource)
  }
  if (isDirectAccount) {
    const accountLabel = cleanRateSource(account?._label ?? account?.nickname)
    if (accountLabel && accountLabel !== label) detailParts.push(accountLabel)
  }
  if (sourceClientId != null) detailParts.push(`Client #${sourceClientId}`)
  if (providerId != null) detailParts.push(`Provider #${providerId}`)
  const detail = detailParts.length ? detailParts.join(' | ') : null

  return {
    label,
    detail,
    tone: sourceToneFor(label),
  }
}

export function getServiceLabel(rate: RateDto): string {
  return rate.serviceName || rate.serviceCode || '—'
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function providerIdFromCarrierId(value: unknown): string | null {
  const text = String(value ?? '').trim()
  if (!text) return null
  const match = text.match(/^se-(\d+)$/i)
  return match?.[1] ?? (/^\d+$/.test(text) ? text : null)
}

function getRateBaseCost(rate: RateDto): number {
  const raw = (rate as any)?.raw ?? {}
  const originalShipping = finiteNumber(raw?.original_amount?.amount)
  const shipmentCost = originalShipping ?? finiteNumber((rate as any)?.shipmentCost) ?? 0
  return shipmentCost + (finiteNumber((rate as any)?.otherCost) ?? 0)
}

function getRateMarkup(rate: RateDto, markups: RateMarkupsMap): RateMarkup | null {
  const raw = (rate as any)?.raw ?? {}
  const candidateKeys = [
    (rate as any)?.shippingProviderId,
    raw?.shippingProviderId,
    providerIdFromCarrierId(raw?.carrier_id),
    raw?.carrier_id,
    (rate as any)?.carrierCode,
    raw?.carrier_code,
  ]

  for (const candidate of candidateKeys) {
    const key = String(candidate ?? '').trim()
    if (!key) continue
    const markup = markups[key]
    if (markup) return markup
  }
  return null
}

function getMarkupAmount(baseCost: number, markup: RateMarkup | null): number {
  const value = Number(markup?.value ?? 0)
  if (!Number.isFinite(value) || value <= 0) return 0
  return markup?.type === 'pct' || markup?.type === 'percent'
    ? baseCost * (value / 100)
    : value
}

export function buildRateRows(
  rates: RateDto[],
  sourceAccounts: RateSourceAccount[] = [],
  markups: RateMarkupsMap = {},
): RateRowView[] {
  const rows = rates.map((rate) => {
    const baseCost = getRateBaseCost(rate)
    const profit = getMarkupAmount(baseCost, getRateMarkup(rate, markups))
    const rateSource = getRateSourceLabel(rate, sourceAccounts)
    return {
      carrierLabel: getCarrierLabel(rate),
      carrierBadgeLabel: getCarrierLabel(rate),
      carrierNickname: getCarrierNickname(rate),
      rateSourceLabel: rateSource.label,
      rateSourceDetail: rateSource.detail,
      rateSourceTone: rateSource.tone,
      carrierCode: rate.carrierCode,
      serviceLabel: getServiceLabel(rate),
      baseCost,
      yourPrice: baseCost + profit,
      profit,
      isBest: false,
      rate,
    }
  })

  const cheapest = rows.reduce<number | null>((bestIndex, row, index) => {
    if (bestIndex == null) return index
    return row.yourPrice < rows[bestIndex]!.yourPrice ? index : bestIndex
  }, null)
  if (cheapest != null) rows[cheapest]!.isBest = true
  return rows
}

export function buildRatesSummary(form: RatesFormState, count: number): string {
  return `${count} rates`
}

export function buildRatesMetaLabel(form: RatesFormState): string {
  const lb = parseRatesNumber(form.weightLb)
  const oz = parseRatesNumber(form.weightOz)
  const length = parseRatesNumber(form.lengthIn)
  const width = parseRatesNumber(form.widthIn)
  const height = parseRatesNumber(form.heightIn)
  // PS-188: never display a hardcoded origin. When the backend-seeded value
  // hasn't arrived (or no default Location is configured), say so honestly
  // instead of pretending a ZIP was used.
  const fromZip = form.fromZip.trim() || 'default origin'
  const toZip = form.toZip.trim()
  // Display the weight in the same lb + oz form the operator typed,
  // so the meta label confirms what was sent (no surprise unit
  // conversions like '36 oz' for someone who wrote '2 lb 4 oz').
  // When lb is 0 we omit the 'lb' segment for cleanliness.
  const weightLabel = lb > 0
    ? (oz > 0 ? `${lb} lb ${oz} oz` : `${lb} lb`)
    : `${oz} oz`
  return `${weightLabel} · ${length}×${width}×${height}" · ${fromZip}→${toZip}`
}

export function buildRateSelectionToast(row: RateRowView): string {
  return `${row.carrierLabel} ${row.serviceLabel.replace(/'/g, '')} @ $${row.yourPrice.toFixed(2)} — Phase 3`
}
