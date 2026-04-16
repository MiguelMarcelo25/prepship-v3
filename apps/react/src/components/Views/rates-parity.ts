import type { LiveRatesRequestDto, RateDto } from '@prepshipv2/contracts/rates/contracts'
import type { Rate } from '../../types/orders.ts'
import { isBlockedRate } from '../../utils/markups.ts'

export interface RatesFormState {
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
  carrierCode: string
  serviceLabel: string
  baseCost: number
  yourPrice: number
  profit: number
  isBest: boolean
  rate: RateDto
}

export function parseRatesNumber(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function getRatesValidationState(form: RatesFormState): RatesEmptyState | null {
  if (!parseRatesNumber(form.weightOz)) {
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
      value: parseRatesNumber(form.weightOz),
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

export function getServiceLabel(rate: RateDto): string {
  return rate.serviceName || rate.serviceCode || '—'
}

export function buildRateRows(rates: RateDto[], markupValue: number): RateRowView[] {
  return rates.map((rate, index) => {
    const baseCost = (rate.shipmentCost || 0) + (rate.otherCost || 0)
    return {
      carrierLabel: getCarrierLabel(rate),
      carrierBadgeLabel: getCarrierLabel(rate),
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
  const weightOz = parseRatesNumber(form.weightOz)
  const length = parseRatesNumber(form.lengthIn)
  const width = parseRatesNumber(form.widthIn)
  const height = parseRatesNumber(form.heightIn)
  const fromZip = form.fromZip.trim() || '90248'
  const toZip = form.toZip.trim()
  return `${weightOz}oz · ${length}×${width}×${height}" · ${fromZip}→${toZip}`
}

export function buildRateSelectionToast(row: RateRowView): string {
  return `${row.carrierLabel} ${row.serviceLabel.replace(/'/g, '')} @ $${row.yourPrice.toFixed(2)} — Phase 3`
}
