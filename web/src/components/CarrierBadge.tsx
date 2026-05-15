// @ts-nocheck
/**
 * Shared CarrierBadge — single source of truth for how a carrier
 * (UPS, USPS, FedEx, DHL, etc.) renders anywhere in the app.
 *
 * For UPS and USPS specifically, this component renders the official
 * SVG marks (web/src/utils/logo/ups.tsx and usps.tsx). For everyone
 * else, it falls back to the existing pastel pill defined in
 * app-shell.css (.carrier-badge + .carrier-{ups,usps,fedex,other}),
 * preserving every place in the app that already styles those.
 *
 * Three size variants:
 *   xs  — for tight inline pills inside table cells (orders table,
 *         awaiting/shipped row carrier columns). Slot 28×16.
 *   sm  — for medium-density rate lists (RateBrowserModal,
 *         RatesView, side-panel rate previews). Slot 38×22.
 *   md  — for prominent surfaces like the New Order modal's Rate
 *         Preview pane. Slot 50×32 with the UPS shield grown to
 *         visually match the wider USPS lockup.
 *
 * Both SVG logos preserve aspect ratio per their viewBoxes — the
 * `slot` is a fixed-size flex container that centers each logo,
 * so consecutive rows in a list keep their service-label columns
 * aligned regardless of which carrier each row uses.
 */

import UpsLogo from '../utils/logo/ups'
import UspsLogo from '../utils/logo/usps'
import FedexLogo from '../utils/logo/fedex'
import ShippLogo from '../utils/logo/shipp'
import EasyPostLogo from '../utils/logo/easypost'
import WalmartLogo from '../utils/logo/walmart'

type CarrierBadgeSize = 'xs' | 'sm' | 'md'

interface Props {
  code: string | null | undefined
  size?: CarrierBadgeSize
  /** Extra classes appended to the slot wrapper (e.g. opacity, margin). */
  className?: string
}

interface SizeConfig {
  /** Slot dimensions in pixels — every variant of the badge fills this exact box. */
  slot: { w: number; h: number }
  /** UPS SVG height (px). UPS shield aspect is ~0.73, taller than wide. */
  ups: number
  /** USPS SVG height (px). USPS lockup aspect is ~1.6, wider than tall. */
  usps: number
  /**
   * FedEx wordmark height (px). FedEx aspect is ~3.6 (much wider than
   * tall), so we size by width-fit instead of letting height drive.
   * Computed as ~0.27 × slot.w to keep the wordmark within the slot
   * width with a few px of horizontal padding on each side.
   */
  fedex: number
  shipp: number
  easypost: number
  walmart: number
  /** Pill font size (px) for non-UPS/USPS carriers. */
  pillFontSize: number
  /** Pill horizontal padding (px). */
  pillPaddingX: number
}

const SIZES: Record<CarrierBadgeSize, SizeConfig> = {
  // xs — compact for future extra-tight contexts. FedEx h=10 lands
  // at width ~36 (matches slot width).
  xs: { slot: { w: 36, h: 22 }, ups: 20, usps: 14, fedex: 10, shipp: 9, easypost: 18, walmart: 19, pillFontSize: 9.5, pillPaddingX: 4 },
  // sm — orders-table / rate-list. FedEx stays smaller because the wide
  // wordmark dominates the row when it fills the full 64-px slot.
  sm: { slot: { w: 64, h: 38 }, ups: 36, usps: 26, fedex: 13, shipp: 15, easypost: 30, walmart: 31, pillFontSize: 12, pillPaddingX: 7 },
  // md — New Order modal prominent rate preview. FedEx h=20 → w=72
  // fits 78-px slot with 3px breathing room each side.
  md: { slot: { w: 78, h: 48 }, ups: 46, usps: 32, fedex: 20, shipp: 19, easypost: 38, walmart: 39, pillFontSize: 13, pillPaddingX: 9 },
}

function classifyCarrier(code: string): 'ups' | 'usps' | 'fedex' | 'shipp' | 'easypost' | 'walmart' | 'other' {
  const lower = code.toLowerCase().trim()
  if (
    lower === 'shipp' ||
    lower.startsWith('shipp_') ||
    lower.startsWith('shipp-') ||
    lower.includes('shipp.to') ||
    lower.includes('shipp carrier')
  )
    return 'shipp'
  if (lower.includes('easypost') || lower.includes('easy_post') || lower.includes('easy-post')) return 'easypost'
  if (lower.includes('walmart')) return 'walmart'
  if (
    lower === 'usps' ||
    lower.startsWith('usps_') ||
    lower.includes('usps') ||
    lower === 'stamps_com' ||
    lower.startsWith('stamps_com_') ||
    lower.includes('stamps')
  )
    return 'usps'
  if (lower === 'ups' || lower.startsWith('ups_') || lower.includes('ups')) return 'ups'
  if (lower.includes('fedex')) return 'fedex'
  return 'other'
}

/** Mirror OrdersView's display formatter so non-logo pills read consistently. */
function formatCarrierLabel(code: string): string {
  if (!code) return '—'
  const lower = code.toLowerCase()
  if (lower.includes('stamps') || lower.includes('usps')) return 'USPS'
  if (lower.includes('ups')) return 'UPS'
  if (lower.includes('fedex')) return 'FedEx'
  if (
    lower === 'shipp' ||
    lower.startsWith('shipp_') ||
    lower.startsWith('shipp-') ||
    lower.includes('shipp.to') ||
    lower.includes('shipp carrier')
  )
    return 'Shipp'
  if (lower.includes('dhl')) return 'DHL'
  if (lower.includes('walmart')) return 'Walmart'
  if (lower.includes('amazon')) return 'Amazon'
  if (lower.includes('ebay')) return 'eBay'
  if (lower.includes('easypost') || lower.includes('easy_post') || lower.includes('easy-post')) return 'EasyPost'
  return code.replace(/^custom_?/i, '').replace(/_/g, ' ').toUpperCase()
}

export default function CarrierBadge({ code, size = 'sm', className = '' }: Props) {
  const cleanCode = (code ?? '').toString()
  const dims = SIZES[size]
  const slotStyle = { width: `${dims.slot.w}px`, height: `${dims.slot.h}px` }
  const slotClass = `inline-flex items-center justify-center flex-shrink-0 ${className}`

  if (!cleanCode) {
    return (
      <span className={`${slotClass} carrier-badge carrier-other`} style={{
        ...slotStyle,
        fontSize: `${dims.pillFontSize}px`,
        paddingLeft: `${dims.pillPaddingX}px`,
        paddingRight: `${dims.pillPaddingX}px`,
      }}>
        —
      </span>
    )
  }

  const carrier = classifyCarrier(cleanCode)

  if (carrier === 'usps') {
    return (
      <span className={slotClass} style={slotStyle} title="USPS">
        <UspsLogo height={dims.usps} />
      </span>
    )
  }

  if (carrier === 'ups') {
    return (
      <span className={slotClass} style={slotStyle} title="UPS">
        <UpsLogo height={dims.ups} />
      </span>
    )
  }

  if (carrier === 'fedex') {
    return (
      <span className={slotClass} style={slotStyle} title="FedEx">
        <FedexLogo height={dims.fedex} />
      </span>
    )
  }

  if (carrier === 'shipp') {
    return (
      <span className={slotClass} style={slotStyle} title="Shipp">
        <ShippLogo height={dims.shipp} />
      </span>
    )
  }

  if (carrier === 'easypost') {
    return (
      <span className={slotClass} style={slotStyle} title="EasyPost">
        <EasyPostLogo height={dims.easypost} />
      </span>
    )
  }

  if (carrier === 'walmart') {
    return (
      <span className={slotClass} style={slotStyle} title="Walmart">
        <WalmartLogo height={dims.walmart} />
      </span>
    )
  }

  // DHL / Walmart / Amazon / eBay / EasyPost / Other — fall back to
  // the existing carrier-badge pastel pill from app-shell.css. Slot
  // dimensions still apply so rows align with their UPS/USPS/FedEx
  // siblings.
  const pillClass = 'carrier-other'
  return (
    <span
      className={`${slotClass} carrier-badge ${pillClass}`}
      style={{
        ...slotStyle,
        fontSize: `${dims.pillFontSize}px`,
        paddingLeft: `${dims.pillPaddingX}px`,
        paddingRight: `${dims.pillPaddingX}px`,
      }}
      title={formatCarrierLabel(cleanCode)}
    >
      {formatCarrierLabel(cleanCode)}
    </span>
  )
}

export type { CarrierBadgeSize }
