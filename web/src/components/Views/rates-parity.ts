// TODO PS-257: restore real types — @prepshipv2/contracts is erased at runtime
// and absent in v4, so these DTO shapes are aliased to `any` locally (matching
// the analysis-parity.ts / RatesView.tsx precedent) until v4 grows a real rates
// contracts module.
type LiveRatesRequestDto = any
type RateDto = any

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
): { label: string; detail: string | null; tone: string } {
  const label = typeof rate?.rateSourceLabel === 'string' && rate.rateSourceLabel.trim()
    ? rate.rateSourceLabel.trim()
    : 'Unknown source'
  const detail = typeof rate?.rateSourceDetail === 'string' && rate.rateSourceDetail.trim()
    ? rate.rateSourceDetail.trim()
    : null

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

function backendRateIdentity(rate: RateDto | null | undefined): string | null {
  const selectedRateKey = String((rate as any)?.selectedRateKey ?? '').trim()
  return selectedRateKey || null
}

export function buildRateRows(
  rates: RateDto[],
  backendBestRate: RateDto | null = null,
): RateRowView[] {
  const backendBestIdentity = backendRateIdentity(backendBestRate)
  return rates.map((rate) => {
    const baseCost = finiteNumber((rate as any)?.selectedRateCost) ?? 0
    const yourPrice = finiteNumber((rate as any)?.cShippingRateAmount) ?? baseCost
    const profit = finiteNumber((rate as any)?.shippingMarginAmount) ?? 0
    const rateSource = getRateSourceLabel(rate)
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
      yourPrice,
      profit,
      isBest: backendBestIdentity != null && backendRateIdentity(rate) === backendBestIdentity,
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
