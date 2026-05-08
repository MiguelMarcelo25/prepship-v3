// @ts-nocheck
import type { LiveRatesRequestDto, RateDto } from '@prepshipv2/contracts/rates/contracts'
import type { Rate } from '../../types/orders.ts'
import { isBlockedRate } from '../../utils/markups.ts'

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
  markup: string
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
    fromPostalCode: form.fromZip.trim() || '90248',
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
  const carrierCode = rate.carrierCode || ''
  if (carrierCode === 'stamps_com') return 'USPS'
  if (carrierCode.startsWith('fedex')) return 'FedEx'
  return 'UPS'
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
  easypost: 'EasyPost',
  fedex: 'FedEx Direct',
  gls: 'GLS Direct',
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

export function getRateSourceLabel(
  rate: RateDto,
  accounts: RateSourceAccount[] = [],
): { label: string; detail: string | null } {
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

  return {
    label,
    detail: detailParts.length ? detailParts.join(' | ') : null,
  }
}

export function getServiceLabel(rate: RateDto): string {
  return rate.serviceName || rate.serviceCode || '—'
}

export function buildRateRows(
  rates: RateDto[],
  markupValue: number,
  sourceAccounts: RateSourceAccount[] = [],
): RateRowView[] {
  return rates.map((rate, index) => {
    const baseCost = (rate.shipmentCost || 0) + (rate.otherCost || 0)
    const rateSource = getRateSourceLabel(rate, sourceAccounts)
    return {
      carrierLabel: getCarrierLabel(rate),
      carrierBadgeLabel: getCarrierLabel(rate),
      carrierNickname: getCarrierNickname(rate),
      rateSourceLabel: rateSource.label,
      rateSourceDetail: rateSource.detail,
      carrierCode: rate.carrierCode,
      serviceLabel: getServiceLabel(rate),
      baseCost,
      yourPrice: baseCost + markupValue,
      profit: markupValue,
      isBest: index === 0,
      rate,
    }
  })
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
  const fromZip = form.fromZip.trim() || '90248'
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
