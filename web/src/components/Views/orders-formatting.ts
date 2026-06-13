// PS-166 (Wave 1b): OrdersView's pure display formatters, moved VERBATIM out
// of OrdersView.tsx (module-level helpers — no hooks, no JSX, no behavior
// change). Strict TypeScript; OrdersView's @ts-nocheck no longer covers this
// code.
//
// Date/time formatters DELEGATE to the canonical CA-time module (unchanged
// contract): ShipStation v1 timestamps are parsed as true UTC from the
// account-local wall clock; the UI never guesses from the operator browser.
import {
  formatCaDateTime,
  formatCaShort,
  formatCaDateLong,
  formatCaWeekday,
  CALIFORNIA_TZ,
} from '../../lib/ca-time'

export interface ClientPalette {
  bg: string
  color: string
  border: string
}

const CLIENT_PALETTES: ClientPalette[] = [
  { bg: '#dbeafe', color: '#1e40af', border: '#93c5fd' },
  { bg: '#dcfce7', color: '#166534', border: '#86efac' },
  { bg: '#fce7f3', color: '#9d174d', border: '#f9a8d4' },
  { bg: '#fef9c3', color: '#854d0e', border: '#fde047' },
  { bg: '#f3e8ff', color: '#6b21a8', border: '#c4b5fd' },
  { bg: '#ffe4e6', color: '#9f1239', border: '#fda4af' },
  { bg: '#e0f2fe', color: '#075985', border: '#7dd3fc' },
  { bg: '#f0fdf4', color: '#14532d', border: '#4ade80' },
  { bg: '#fff7ed', color: '#9a3412', border: '#fdba74' },
  { bg: '#f1f5f9', color: '#334155', border: '#94a3b8' },
]

const CARRIER_NAMES: Record<string, string> = {
  stamps_com: 'USPS',
  ups: 'UPS',
  ups_walleted: 'UPS',
  fedex: 'FedEx',
  fedex_walleted: 'FedEx',
  dhl_express: 'DHL',
  asendia_us: 'Asendia',
  ontrac: 'OnTrac',
  lasership: 'LaserShip',
  amazon_swa: 'Amazon',
  globegistics: 'Globegistics',
}

const SERVICE_NAMES: Record<string, string> = {
  usps_priority_mail: 'Priority Mail',
  usps_priority_mail_express: 'Priority Express',
  usps_first_class_mail: 'First Class',
  usps_ground_advantage: 'Ground Advantage',
  usps_media_mail: 'Media Mail',
  usps_library_mail: 'Library Mail',
  usps_parcel_select: 'Parcel Select',
  ups_ground: 'UPS Ground',
  ups_ground_saver: 'UPS Ground Saver',
  ups_surepost: 'UPS Ground Saver',
  ups_surepost_1_lb_or_greater: 'UPS Ground Saver (1 lb+)',
  ups_surepost_less_than_1_lb: 'UPS Ground Saver (<1 lb)',
  ups_3_day_select: 'UPS 3 Day Select',
  ups_2nd_day_air: 'UPS 2nd Day Air',
  ups_2nd_day_air_am: 'UPS 2nd Day Air AM',
  ups_next_day_air_saver: 'UPS Next Day Air Saver',
  ups_next_day_air: 'UPS Next Day Air',
  ups_next_day_air_early_am: 'UPS Next Day Air Early AM',
  fedex_ground: 'FedEx Ground',
  fedex_home_delivery: 'FedEx Home Delivery',
  fedex_2day: 'FedEx 2Day',
  fedex_2_day: 'FedEx 2Day',
  fedex_2day_am: 'FedEx 2Day AM',
  fedex_express_saver: 'FedEx Express Saver',
  fedex_priority_overnight: 'FedEx Priority Overnight',
  fedex_standard_overnight: 'FedEx Standard Overnight',
  fedex_first_overnight: 'FedEx First Overnight',
}

const clientPaletteCache = new Map<string, ClientPalette>()

export function truncate(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value
}

export function formatDateTime(value: string | null | undefined) {
  return formatCaDateTime(value)
}

export function formatLabelCreated(value: string | null | undefined) {
  return formatCaShort(value)
}

export function formatDateOnly(value: string | null | undefined, options?: Intl.DateTimeFormatOptions) {
  if (!value) return '—'
  // Two specific shapes used in OrdersView are mapped to the canonical
  // helpers; everything else falls back to a custom Intl call (still
  // forced to CA timezone for consistency).
  if (!options || (options.month === 'short' && options.day === 'numeric' && options.year === 'numeric' && !options.weekday)) {
    return formatCaDateLong(value)
  }
  if (options.weekday === 'short') {
    return formatCaWeekday(value)
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return '—'
  // Caller provided custom Intl options; render in CA TZ regardless.
  return parsed.toLocaleDateString('en-US', { ...options, timeZone: CALIFORNIA_TZ })
}

export function formatWeight(ounces: number | null | undefined) {
  if (!ounces) return '—'
  const pounds = Math.floor(ounces / 16)
  const remaining = Math.round((ounces % 16) * 10) / 10
  if (pounds === 0) return `${remaining} oz`
  if (remaining === 0) return `${pounds} lb`
  return `${pounds} lb ${remaining} oz`
}

export function ageHours(value: string | null | undefined) {
  if (!value) return 0
  return (Date.now() - new Date(value).getTime()) / (1000 * 60 * 60)
}

export function ageLabel(value: string | null | undefined) {
  const hours = ageHours(value)
  if (hours < 1) return `${Math.floor(hours * 60)}m`
  if (hours < 24) return `${Math.floor(hours)}h`
  return `${Math.floor(hours / 24)}d`
}

export function getAgeColor(value: string | null | undefined) {
  const hours = ageHours(value)
  if (hours > 48) return 'var(--red)'
  if (hours > 24) return '#d97706'
  return 'var(--green)'
}

export function getClientPalette(name: string) {
  const cached = clientPaletteCache.get(name)
  if (cached) return cached

  let hash = 0
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) & 0xffff
  }
  const palette = CLIENT_PALETTES[hash % CLIENT_PALETTES.length]!
  clientPaletteCache.set(name, palette)
  return palette
}

export function formatServiceCode(value: string | null | undefined) {
  if (!value) return '—'
  return SERVICE_NAMES[value] ?? value.replace(/_/g, ' ')
}

export function formatCarrierCode(value: string | null | undefined) {
  if (!value) return '—'
  return CARRIER_NAMES[value] ?? value.replace(/^custom_?/i, '').replace(/_/g, ' ').toUpperCase()
}

export function getCarrierClass(carrierCode: string | null | undefined) {
  if (!carrierCode) return 'carrier-other'
  if (carrierCode.includes('ups')) return 'carrier-ups'
  if (carrierCode.includes('fedex')) return 'carrier-fedex'
  if (carrierCode.includes('stamps') || carrierCode.includes('usps')) return 'carrier-usps'
  return 'carrier-other'
}
