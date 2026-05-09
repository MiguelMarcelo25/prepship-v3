// @ts-nocheck
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Store,
  Truck,
  Wifi,
  Receipt,
  Users2,
  Trash2,
  PackageSearch,
  Plus,
  Check as CheckIcon,
  X as XIcon,
  Loader2,
  AlertCircle,
} from 'lucide-react'
import { callVercelFunction } from '../../lib/vercelFunction'
import { formatCaDateShort } from '../../lib/ca-time'
import { useClients } from '../../hooks'

// Modern animated checkbox — used in the Assign-Clients popover.
// Native <input type="checkbox"> hidden with sr-only; the visual is
// a div with brand-blue fill + tick path animated via spring physics.
// Tick draws via SVG strokeDasharray so it has a satisfying "draw on"
// motion when toggling. Designed to match the rest of the PrepShip
// brand vocabulary (brand-blue fill, soft ring, clean geometry).
function ModernCheckbox({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) {
  return (
    <span
      className={`relative inline-flex items-center justify-center w-[18px] h-[18px] flex-shrink-0 cursor-pointer transition-all duration-150 ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      role="presentation"
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="sr-only"
      />
      <motion.span
        aria-hidden
        animate={{
          backgroundColor: checked
            ? 'rgb(var(--brand-rgb, 42 91 215))'
            : 'rgb(var(--surface-rgb, 255 255 255))',
          borderColor: checked
            ? 'rgb(var(--brand-rgb, 42 91 215))'
            : 'rgb(var(--border-rgb, 225 228 232))',
          scale: checked ? 1.05 : 1,
        }}
        whileTap={disabled ? undefined : { scale: 0.9 }}
        transition={{ type: 'spring', stiffness: 500, damping: 28 }}
        className="absolute inset-0 rounded-[5px] border-2"
        style={{
          boxShadow: checked
            ? '0 2px 6px -1px rgb(var(--brand-rgb, 42 91 215) / 0.4), inset 0 1px 0 0 rgba(255,255,255,0.18)'
            : 'inset 0 1px 2px rgba(15, 23, 42, 0.04)',
        }}
      />
      {/* Tick path with stroke-draw animation — pathLength=1 lets us
          animate from 0 (invisible) to 1 (fully drawn) on toggle. */}
      <svg
        aria-hidden
        viewBox="0 0 18 18"
        className="relative w-[12px] h-[12px] pointer-events-none"
        style={{ zIndex: 1 }}
      >
        <motion.path
          d="M 4 9 L 8 13 L 14 5"
          fill="none"
          stroke="#fff"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={false}
          animate={{
            pathLength: checked ? 1 : 0,
            opacity: checked ? 1 : 0,
          }}
          transition={{
            pathLength: { duration: 0.2, ease: [0.65, 0, 0.35, 1] },
            opacity: { duration: 0.1 },
          }}
        />
      </svg>
    </span>
  )
}

// Action button — icon + label combo with hover lift + active scale.
// Three variants:
//   default: outline-style, neutral
//   primary: brand-blue tinted background
//   danger:  rose-tinted text
type ActionVariant = 'default' | 'primary' | 'danger'

function ActionButton({
  icon,
  label,
  loadingLabel,
  loading,
  disabled,
  onClick,
  variant = 'default',
  title,
}: {
  icon: React.ReactNode
  label: string
  loadingLabel?: string
  loading?: boolean
  disabled?: boolean
  onClick: () => void
  variant?: ActionVariant
  title?: string
}) {
  const styles: Record<ActionVariant, React.CSSProperties> = {
    default: {
      background: 'var(--surface)',
      color: 'var(--text)',
      borderColor: 'var(--border)',
    },
    primary: {
      background: 'rgb(var(--brand-rgb, 42 91 215) / 0.1)',
      color: 'rgb(var(--brand-rgb, 42 91 215))',
      borderColor: 'rgb(var(--brand-rgb, 42 91 215) / 0.3)',
    },
    danger: {
      background: 'rgb(244 63 94 / 0.06)',
      color: 'rgb(190 18 60)',
      borderColor: 'rgb(244 63 94 / 0.25)',
    },
  }
  return (
    <motion.button
      type="button"
      whileHover={!disabled && !loading ? { y: -1 } : undefined}
      whileTap={!disabled && !loading ? { scale: 0.96 } : undefined}
      transition={{ type: 'spring', stiffness: 400, damping: 22 }}
      onClick={onClick}
      disabled={!!(disabled || loading)}
      title={title}
      style={{
        ...styles[variant],
        padding: '5px 10px',
        border: '1px solid',
        borderRadius: 6,
        fontSize: 11,
        fontWeight: 700,
        cursor: loading ? 'wait' : disabled ? 'not-allowed' : 'pointer',
        opacity: disabled && !loading ? 0.5 : 1,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        whiteSpace: 'nowrap',
        boxShadow: '0 1px 2px rgba(15, 23, 42, 0.04)',
        transition: 'box-shadow 150ms, background 100ms, color 100ms',
      }}
      onMouseEnter={(e) => {
        if (!disabled && !loading) {
          e.currentTarget.style.boxShadow = '0 4px 8px -2px rgba(15, 23, 42, 0.12), 0 2px 4px -1px rgba(15, 23, 42, 0.06)'
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = '0 1px 2px rgba(15, 23, 42, 0.04)'
      }}
    >
      {loading ? <Loader2 size={11} strokeWidth={2.5} className="animate-spin" /> : icon}
      <span>{loading && loadingLabel ? loadingLabel : label}</span>
    </motion.button>
  )
}

// Phase 2 frontend stub. Each provider declares the credential fields its
// "Add integration" form needs. When the backend route POST /carrier-accounts
// goes live (see src/db/schema/carrier-accounts.ts and src/lib/carriers/),
// the form just starts working — no UI changes required.

type ProviderKey =
  | 'simulator'
  | 'shipengine'
  | 'ehub'
  | 'ups'
  | 'usps'
  | 'fedex'
  | 'dhl_express'
  | 'amazon_shipping'
  | 'walmart'
  | 'walmart_shipping'
  | 'amazon'
  | 'ebay'
  | 'ebay_shipping'
  | 'shopify'
  | 'etsy'
  | 'tiktok_shop'
  | 'woocommerce'
  | 'bigcommerce'
  | 'seko'
  | 'epost_global'
  | 'intelliquick'
  | 'gls'
  | 'stamps_com'
  | 'endicia'
  | 'easypost'

interface CredentialField {
  name: string
  label: string
  placeholder?: string
  type?: 'text' | 'password'
  /** Optional gray help-text rendered below the input. Use it for fields
   *  that need explanation about where to find the value, when it's
   *  required, etc. */
  hint?: string
  /** Defaults to true. Set false for fields that aren't strictly needed for
   *  credential verification (e.g. Walmart Partner ID is a header on later
   *  API calls, not the OAuth token endpoint). */
  required?: boolean
}

type ProviderCategory = 'store' | 'carrier'

interface ProviderDef {
  key: ProviderKey
  label: string
  blurb: string
  badge: string
  badgeColor: string
  /** Domain used as the input for logo and favicon CDNs. */
  domain: string
  /** simpleicons.org slug, when the brand has a SVG entry there. */
  simpleIconsSlug?: string
  /** Exact logo asset to try before CDN/favicon fallbacks. */
  logoUrl?: string
  fields: CredentialField[]
  /** 'store' = marketplace order source (Walmart, Amazon). 'carrier' = real
   *  shipping carrier (UPS, USPS, FedEx, DHL, etc.). Drives which Settings
   *  section the integration lives in, what action buttons appear on saved
   *  rows, and whether the row shows up in the Rate Browser sidebar (only
   *  carriers do — stores never return shipping rate quotes). */
  category: ProviderCategory
  /** Set true for carriers whose API confirmed cannot return shipping rate
   *  quotes (Walmart Shipping is the canonical example). Suppresses the
   *  Get Rates button on the saved row and shows a "tracking-only" note
   *  in its place so the user isn't tempted to click and get the same
   *  predictable error. */
  noRateQuotes?: boolean
  /** Setup difficulty / time estimate. Drives the colored badge on the
   *  Add Integration tile and the sort order in the picker (easiest
   *  first), so users naturally land on the fastest path to working
   *  rates. Mirrors the tier system EasyPost uses on its dashboard.
   *    1 = Instant: paste an API key, ~3 min total including signup.
   *    2 = Quick:   developer-portal app + paste 2-3 fields, ~10 min.
   *    3 = OAuth:   browser consent flow, refresh token, ~15-20 min. */
  setupTier?: 1 | 2 | 3
  /** Direct deep-link URL where the user can grab the credentials this
   *  carrier needs. Surfaced as a "Get credentials →" button at the top
   *  of the Add form so the user doesn't have to hunt for the page. */
  credentialsUrl?: string
}

const TIER_META: Record<1 | 2 | 3, { label: string; color: string; bg: string; time: string }> = {
  1: { label: 'Instant', color: '#0a7d1d', bg: '#dcfce7', time: '~3 min' },
  2: { label: 'Quick',   color: '#9a3412', bg: '#fed7aa', time: '~10 min' },
  3: { label: 'OAuth',   color: '#1e40af', bg: '#dbeafe', time: '~15 min' },
}

// Set of provider keys treated as marketplace stores rather than carriers.
// Used both here for UI grouping and on the data-fetching side (v2Hooks)
// to filter direct accounts out of the Rate Browser sidebar.
//
// Note: 'amazon_shipping' is NOT here even though it shares SP-API
// credentials with 'amazon' — Amazon Shipping is the carrier-side
// Buy Shipping API (purchase labels at Amazon-negotiated rates), so it
// belongs under Carriers in the UI and should appear in the Rate Browser
// sidebar so it can be selected for rate-shopping.
export const STORE_PROVIDERS: Set<string> = new Set([
  'walmart',
  'amazon',
  'ebay',
  'shopify',
  'etsy',
  'tiktok_shop',
  'woocommerce',
  'bigcommerce',
])

// Credential fields below match each carrier's documented authentication
// requirements as of the 2024–2025 API specs:
//   ShipEngine    — single API key (Bearer)
//   UPS           — OAuth 2.0 (Client ID + Secret + Account Number)
//   USPS          — APIs v3 OAuth (CRID + MID + Consumer Key/Secret)
//   FedEx         — REST OAuth 2.0 (Account # + API Key/Secret)
//   DHL Express   — MyDHL API (EKP Account # + API Key/Secret)
//   Amazon        — SP-API Buy Shipping (Seller + Marketplace + LWA OAuth)
//   SEKO          — OmniShip (Account ID + API Key)
//   ePost Global  — Account ID + API Key
//   IntelliQuick  — Account # + API Key
//   GLS US        — Username/Password + Customer ID (legacy SOAP)
//   Stamps.com    — SwsimV1 SOAP (Integration ID + Username + Password)
//   Endicia       — Label Server (Account ID + Pass Phrase)
const PROVIDER_DEFS: ProviderDef[] = [
  {
    key: 'easypost',
    category: 'carrier',
    label: 'EasyPost',
    blurb: 'Multi-carrier aggregator — one API key gives access to UPS, USPS, FedEx, DHL, GLS, OnTrac, LaserShip, and 100+ other carriers. Pay-per-label pricing, no monthly fee. Recommended for the simplest setup.',
    badge: 'EZP',
    badgeColor: '#0c5fa4',
    setupTier: 1,
    credentialsUrl: 'https://www.easypost.com/account/api-keys',
    domain: 'easypost.com',
    fields: [
      {
        name: 'apiKey',
        label: 'API Key',
        type: 'password',
        hint: 'Production or test API key from your EasyPost dashboard → API Keys. Test keys are free and work for getting rate quotes; production keys are required to actually purchase labels.',
      },
      // Ship-from override: same pattern as Walmart Shipping. Most users
      // will set up their default ship-from address inside EasyPost
      // itself, but for the Settings demo button (no order context) we
      // need *some* address — these fields let the user paste it
      // without editing code.
      { name: 'shipFromName', label: 'Ship-From Name (optional)', required: false, placeholder: 'DR Prepper Warehouse' },
      { name: 'shipFromAddress1', label: 'Ship-From Street (optional)', required: false, placeholder: '1234 Warehouse Way' },
      { name: 'shipFromCity', label: 'Ship-From City (optional)', required: false, placeholder: 'Carson' },
      { name: 'shipFromState', label: 'Ship-From State (optional)', required: false, placeholder: 'CA' },
      { name: 'shipFromZip', label: 'Ship-From Zip (optional)', required: false, placeholder: '90248' },
      { name: 'shipFromPhone', label: 'Ship-From Phone (optional)', required: false, placeholder: '5551234567' },
    ],
  },
  {
    key: 'ebay_shipping',
    category: 'carrier',
    label: 'eBay Shipping',
    blurb: 'eBay Logistics API for eBay-label shipping quotes on eBay orders, plus Sell Fulfillment tracking-push after labels are purchased. Uses the same app credentials as the eBay store integration, but the refresh token must include the sell.logistics scope for rates.',
    badge: 'eBayS',
    badgeColor: '#E53238',
    setupTier: 3,
    credentialsUrl: 'https://developer.ebay.com/my/keys',
    domain: 'ebay.com',
    simpleIconsSlug: 'ebay',
    fields: [
      { name: 'appId', label: 'App ID (Client ID)', hint: 'Same App ID used for the eBay store integration.' },
      { name: 'certId', label: 'Cert ID (Client Secret)', type: 'password' },
      { name: 'devId', label: 'Dev ID' },
      { name: 'ruName', label: 'RuName / Redirect URL Name', placeholder: 'DrprepperUSA-Drpreppe-Prepsh-qoumohks', hint: 'From eBay Developer Portal -> User Tokens -> RuName. eBay requires this value, not the callback URL, when exchanging the OAuth code.' },
      { name: 'refreshToken', label: 'User OAuth Refresh Token', type: 'password', hint: 'Long-lived token from the eBay sign-in flow. For rates, it must include https://api.ebay.com/oauth/api_scope/sell.logistics.' },
      { name: 'environment', label: 'Environment (optional)', required: false, placeholder: 'production | sandbox' },
      { name: 'shipFromName', label: 'Ship-From Name (optional)', required: false, placeholder: 'DR Prepper Warehouse' },
      { name: 'shipFromAddress1', label: 'Ship-From Street (optional)', required: false, placeholder: '1234 Warehouse Way' },
      { name: 'shipFromCity', label: 'Ship-From City (optional)', required: false, placeholder: 'Carson' },
      { name: 'shipFromState', label: 'Ship-From State (optional)', required: false, placeholder: 'CA' },
      { name: 'shipFromZip', label: 'Ship-From Zip (optional)', required: false, placeholder: '90248' },
      { name: 'shipFromPhone', label: 'Ship-From Phone (optional)', required: false, placeholder: '5551234567' },
    ],
  },
  {
    key: 'walmart_shipping',
    category: 'carrier',
    label: 'Walmart Shipping',
    blurb: 'Ship With Walmart — pulls real shipping estimates from Walmart\'s Sponsored Carrier program (POST /v3/shipping/labels/shipping-estimates). Same OAuth credentials as the Walmart Store integration. Per-Walmart-order: rate quotes are scoped to a Walmart purchaseOrderId.',
    badge: 'WMTS',
    badgeColor: '#0071DC',
    setupTier: 2,
    credentialsUrl: 'https://developer.walmart.com/account/login',
    domain: 'walmart.com',
    fields: [
      { name: 'clientId', label: 'Client ID', hint: 'Same Client ID used for the Walmart Store integration.' },
      { name: 'clientSecret', label: 'Client Secret', type: 'password' },
      { name: 'partnerId', label: 'Partner ID (Seller ID)', required: false, hint: 'Walmart Seller ID. Required for actually creating labels via Walmart shipping APIs.' },
      { name: 'channelType', label: 'Channel Type (optional)', required: false, placeholder: 'UUID', hint: 'For Solution Provider integrations. Same value as the Store entry.' },
      // Ship-from override: Walmart's WSS rate service validates the
      // shipFromAddress against the seller's registered shipping origin in
      // Seller Center. If our hardcoded default doesn't match, the API
      // returns the generic "unable to retrieve data" 500. Letting the user
      // paste their actual registered warehouse address here is the
      // simplest fix without requiring a Walmart support ticket.
      { name: 'shipFromName', label: 'Ship-From Name (optional)', required: false, placeholder: 'DR Prepper Warehouse', hint: 'Leave blank to use a default; set this to your registered shipping origin in Seller Center if rates fail with a generic 500.' },
      { name: 'shipFromAddress1', label: 'Ship-From Street (optional)', required: false, placeholder: '1234 Warehouse Way' },
      { name: 'shipFromCity', label: 'Ship-From City (optional)', required: false, placeholder: 'Carson' },
      { name: 'shipFromState', label: 'Ship-From State (optional)', required: false, placeholder: 'CA' },
      { name: 'shipFromZip', label: 'Ship-From Zip (optional)', required: false, placeholder: '90248' },
      { name: 'shipFromPhone', label: 'Ship-From Phone (optional)', required: false, placeholder: '5551234567' },
    ],
  },
  {
    key: 'simulator',
    category: 'carrier',
    label: 'Simulator (Demo)',
    blurb: 'Sandbox carrier for testing the add-carrier → verify → fetch-rates flow without real API credentials. Returns synthetic Standard / Priority / Express rates.',
    badge: 'DEMO',
    badgeColor: '#0F766E',
    setupTier: 1,
    domain: 'example.com',
    fields: [
      {
        name: 'label',
        label: 'Display Label',
        placeholder: 'e.g. Demo Carrier',
        hint: "Just a name. The simulator doesn't talk to any real API; everything is synthetic.",
      },
    ],
  },
  {
    key: 'shipengine',
    category: 'carrier',
    label: 'ShipEngine',
    blurb: 'Multi-carrier rate aggregator. One API key for USPS, UPS, FedEx, DHL.',
    badge: 'SE',
    badgeColor: '#0072CE',
    setupTier: 1,
    credentialsUrl: 'https://app.shipengine.com/account/api-management',
    domain: 'shipengine.com',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', placeholder: 'TEST_xxxxxxxx or live_xxxxxxxx' },
      { name: 'carrierIds', label: 'Carrier IDs (optional)', required: false, placeholder: 'se-123890, se-456789', hint: 'Leave blank to rate with every connected ShipEngine carrier returned by /v1/carriers.' },
      { name: 'shipFromName', label: 'Ship-From Name (optional)', required: false, placeholder: 'DR Prepper Warehouse' },
      { name: 'shipFromAddress1', label: 'Ship-From Street (optional)', required: false, placeholder: '1234 Warehouse Way' },
      { name: 'shipFromCity', label: 'Ship-From City (optional)', required: false, placeholder: 'Carson' },
      { name: 'shipFromState', label: 'Ship-From State (optional)', required: false, placeholder: 'CA' },
      { name: 'shipFromZip', label: 'Ship-From Zip (optional)', required: false, placeholder: '90248' },
      { name: 'shipFromPhone', label: 'Ship-From Phone (optional)', required: false, placeholder: '5551234567' },
    ],
  },
  {
    key: 'ehub',
    category: 'carrier',
    label: 'eHub',
    blurb: 'eHub shipping API for rate shopping and label workflows. Add the API token and base URL from the eHub portal; live rates need eHub API endpoint access before quotes can be returned.',
    badge: 'eHub',
    badgeColor: '#F47B20',
    setupTier: 2,
    credentialsUrl: 'https://docs.ehub.com/',
    domain: 'ehub.com',
    logoUrl: 'https://knowledge.ehub.com/hs-fs/hubfs/eHub-Logo-FullColor-May-15-2024-07-27-43-6708-PM.png',
    fields: [
      {
        name: 'apiKey',
        label: 'API Key / Token',
        type: 'password',
        hint: 'Paste the API credential from the eHub docs/API Explorer token area. Live verification and rates require the exact eHub API base URL and rate endpoint contract.',
      },
      { name: 'baseUrl', label: 'API Base URL (optional)', required: false, placeholder: 'https://api.ehub.com' },
      { name: 'accountId', label: 'Account ID (optional)', required: false },
      { name: 'shipFromName', label: 'Ship-From Name (optional)', required: false, placeholder: 'DR Prepper Warehouse' },
      { name: 'shipFromAddress1', label: 'Ship-From Street (optional)', required: false, placeholder: '1234 Warehouse Way' },
      { name: 'shipFromCity', label: 'Ship-From City (optional)', required: false, placeholder: 'Carson' },
      { name: 'shipFromState', label: 'Ship-From State (optional)', required: false, placeholder: 'CA' },
      { name: 'shipFromZip', label: 'Ship-From Zip (optional)', required: false, placeholder: '90248' },
      { name: 'shipFromPhone', label: 'Ship-From Phone (optional)', required: false, placeholder: '5551234567' },
    ],
  },
  {
    key: 'ups',
    category: 'carrier',
    label: 'UPS',
    blurb: 'OAuth 2.0 credentials from the UPS Developer Kit. Required for direct UPS Rating, Shipping & Tracking.',
    badge: 'UPS',
    badgeColor: '#5A1F00',
    setupTier: 2,
    credentialsUrl: 'https://developer.ups.com/apps',
    domain: 'ups.com',
    simpleIconsSlug: 'ups',
    fields: [
      { name: 'accountNumber', label: 'UPS Account Number', placeholder: '6-character account' },
      { name: 'clientId', label: 'OAuth Client ID' },
      { name: 'clientSecret', label: 'OAuth Client Secret', type: 'password' },
    ],
  },
  {
    key: 'usps',
    category: 'carrier',
    label: 'USPS',
    blurb: 'USPS APIs v3 OAuth (developer.usps.com). Replaces the legacy WebTools APIs.',
    badge: 'USPS',
    badgeColor: '#004B87',
    setupTier: 2,
    credentialsUrl: 'https://developer.usps.com/apps',
    domain: 'usps.com',
    fields: [
      { name: 'crid', label: 'Customer Registration ID (CRID)' },
      { name: 'mid', label: 'Mailer ID (MID)', placeholder: '9-digit MID' },
      { name: 'consumerKey', label: 'Consumer Key', type: 'password' },
      { name: 'consumerSecret', label: 'Consumer Secret', type: 'password' },
    ],
  },
  {
    key: 'fedex',
    category: 'carrier',
    label: 'FedEx',
    blurb: 'FedEx Developer Portal REST APIs (Rate, Ship, Track). OAuth 2.0.',
    badge: 'FedEx',
    badgeColor: '#4D148C',
    setupTier: 2,
    credentialsUrl: 'https://developer.fedex.com/api/en-us/home.html',
    domain: 'fedex.com',
    simpleIconsSlug: 'fedex',
    fields: [
      { name: 'accountNumber', label: 'Account Number', placeholder: '9-digit FedEx account' },
      { name: 'apiKey', label: 'API Key (Client ID)' },
      { name: 'apiSecret', label: 'Secret Key (Client Secret)', type: 'password' },
    ],
  },
  {
    key: 'dhl_express',
    category: 'carrier',
    label: 'DHL Express',
    blurb: 'MyDHL API. International parcel rating, shipping, tracking.',
    badge: 'DHL',
    badgeColor: '#D40511',
    setupTier: 1,
    credentialsUrl: 'https://developer.dhl.com/user/apps',
    domain: 'dhl.com',
    simpleIconsSlug: 'dhl',
    fields: [
      { name: 'accountNumber', label: 'DHL Account Number (EKP)', placeholder: '10-digit EKP' },
      { name: 'apiKey', label: 'API Key' },
      { name: 'apiSecret', label: 'API Secret', type: 'password' },
    ],
  },
  {
    key: 'amazon_shipping',
    category: 'carrier',
    label: 'Amazon Buy Shipping',
    blurb: 'Amazon SP-API Shipping v2 — purchase labels at Amazon-negotiated carrier rates (USPS, UPS, FedEx) for Merchant-Fulfilled (FBM) orders, including non-Amazon orders via channelType EXTERNAL. Same SP-API credentials as the Amazon Marketplace store integration.',
    badge: 'AMZ',
    badgeColor: '#FF9900',
    setupTier: 3,
    credentialsUrl: 'https://sellercentral.amazon.com/sellingpartner/developerconsole',
    domain: 'amazon.com',
    fields: [
      { name: 'sellerId', label: 'Seller ID' },
      { name: 'marketplaceId', label: 'Marketplace ID', placeholder: 'ATVPDKIKX0DER (US)' },
      { name: 'lwaClientId', label: 'LWA Client ID' },
      { name: 'lwaClientSecret', label: 'LWA Client Secret', type: 'password' },
      { name: 'refreshToken', label: 'Refresh Token', type: 'password' },
    ],
  },
  {
    key: 'walmart',
    category: 'store',
    label: 'Walmart Marketplace',
    blurb: 'Walmart Marketplace API (Seller Center). OAuth 2.0 client_credentials issued via developer.walmart.com.',
    badge: 'WMT',
    badgeColor: '#0071DC',
    setupTier: 2,
    credentialsUrl: 'https://developer.walmart.com/account/login',
    domain: 'walmart.com',
    fields: [
      {
        name: 'clientId',
        label: 'Client ID',
        hint: 'Issued by developer.walmart.com when you register the integration. Required.',
      },
      {
        name: 'clientSecret',
        label: 'Client Secret',
        type: 'password',
        hint: 'Paired with the Client ID. Required.',
      },
      {
        name: 'partnerId',
        label: 'Partner ID (optional)',
        required: false,
        hint: 'Walmart Seller ID. Optional for OAuth verification, but needed when actually pulling rates/orders. Found in Seller Center → Settings → Account.',
      },
      {
        name: 'channelType',
        label: 'Channel Type (optional)',
        required: false,
        placeholder: 'e.g. 0f3e4dd4-0514-4346-b39d-af0e00ea066d',
        hint: 'UUID issued by Walmart for Solution Provider integrations. Optional for OAuth verification. If Walmart returns 401 for your account during real API calls, fill this in.',
      },
    ],
  },
  {
    key: 'amazon',
    category: 'store',
    label: 'Amazon Marketplace',
    blurb: 'Amazon SP-API. Pull orders, push tracking, fulfillment, FBA reports. Requires Login with Amazon (LWA) OAuth + a registered SP-API app.',
    badge: 'AMZN',
    badgeColor: '#FF9900',
    setupTier: 3,
    credentialsUrl: 'https://sellercentral.amazon.com/sellingpartner/developerconsole',
    domain: 'amazon.com',
    simpleIconsSlug: 'amazon',
    fields: [
      { name: 'sellerId', label: 'Seller ID', hint: 'Your Merchant Token from Seller Central → Settings → Account Info.' },
      { name: 'marketplaceId', label: 'Marketplace ID', placeholder: 'ATVPDKIKX0DER (US)', hint: 'ATVPDKIKX0DER for US, A2EUQ1WTGCTBG2 for CA, A1AM78C64UM0Y8 for MX, etc.' },
      { name: 'lwaClientId', label: 'LWA Client ID', hint: 'From your SP-API app registration on Seller Central.' },
      { name: 'lwaClientSecret', label: 'LWA Client Secret', type: 'password' },
      { name: 'refreshToken', label: 'Refresh Token', type: 'password', hint: 'Long-lived token from the user-authorization step (Atza|… or Atzr|…).' },
      { name: 'region', label: 'Region (optional)', required: false, placeholder: 'na | eu | fe', hint: "Defaults to 'na' (North America). Use 'eu' or 'fe' if your marketplaces are in Europe / Far East." },
    ],
  },
  {
    key: 'ebay',
    category: 'store',
    label: 'eBay',
    blurb: 'eBay Sell API. Pull orders, push tracking, manage listings. Requires app keyset + user OAuth refresh token.',
    badge: 'eBay',
    badgeColor: '#E53238',
    setupTier: 3,
    credentialsUrl: 'https://developer.ebay.com/my/keys',
    domain: 'ebay.com',
    simpleIconsSlug: 'ebay',
    fields: [
      { name: 'appId', label: 'App ID (Client ID)', hint: 'Production app ID from developer.ebay.com → My Account → Application Keys.' },
      { name: 'certId', label: 'Cert ID (Client Secret)', type: 'password' },
      { name: 'devId', label: 'Dev ID', hint: 'Your developer account ID; needed for Trading API legacy calls.' },
      { name: 'ruName', label: 'RuName / Redirect URL Name', placeholder: 'DrprepperUSA-Drpreppe-Prepsh-qoumohks', hint: 'From eBay Developer Portal -> User Tokens -> RuName. eBay requires this value, not the callback URL, when exchanging the OAuth code.' },
      { name: 'refreshToken', label: 'User OAuth Refresh Token', type: 'password', hint: 'Long-lived token from the user-consent flow (v^1.1.#i^1#…). Required for Sell API order operations.' },
      { name: 'environment', label: 'Environment (optional)', required: false, placeholder: 'production | sandbox', hint: "Defaults to 'production'. Use 'sandbox' to point at api.sandbox.ebay.com." },
    ],
  },
  {
    key: 'shopify',
    category: 'store',
    label: 'Shopify',
    blurb: 'Shopify Admin API. Pull orders, push fulfillments. Use a Custom App access token from your store admin.',
    badge: 'SHOP',
    badgeColor: '#7AB55C',
    setupTier: 1,
    credentialsUrl: 'https://help.shopify.com/en/manual/apps/app-types/custom-apps',
    domain: 'shopify.com',
    simpleIconsSlug: 'shopify',
    fields: [
      { name: 'shopDomain', label: 'Shop Domain', placeholder: 'yourstore.myshopify.com', hint: 'The .myshopify.com domain (not your custom domain).' },
      { name: 'accessToken', label: 'Admin API Access Token', type: 'password', hint: 'Custom App → API credentials → Admin API access token (shpat_…). Needs read_orders + write_fulfillments scopes.' },
      { name: 'apiVersion', label: 'API Version (optional)', required: false, placeholder: '2025-01', hint: 'Defaults to the latest stable. Pin to a date string like 2025-01 if you need a specific version.' },
    ],
  },
  {
    key: 'etsy',
    category: 'store',
    label: 'Etsy',
    blurb: 'Etsy Open API v3. Pull receipts (orders), push tracking. Requires OAuth 2.0 with PKCE and a refresh token.',
    badge: 'ETSY',
    badgeColor: '#F1641E',
    setupTier: 3,
    credentialsUrl: 'https://www.etsy.com/developers/your-apps',
    domain: 'etsy.com',
    simpleIconsSlug: 'etsy',
    fields: [
      { name: 'apiKey', label: 'Keystring (Client ID)', hint: 'From your app on developers.etsy.com.' },
      { name: 'clientSecret', label: 'Shared Secret', type: 'password' },
      { name: 'shopId', label: 'Shop ID', hint: 'Numeric shop ID (e.g. 12345678).' },
      { name: 'refreshToken', label: 'OAuth Refresh Token', type: 'password', hint: 'Long-lived refresh token from the OAuth 2.0 with PKCE flow.' },
    ],
  },
  {
    key: 'tiktok_shop',
    category: 'store',
    label: 'TikTok Shop',
    blurb: 'TikTok Shop Partner API. Pull orders, push fulfillment, manage listings. Requires a partner app + shop authorization.',
    badge: 'TTS',
    badgeColor: '#000000',
    setupTier: 3,
    credentialsUrl: 'https://partner.tiktokshop.com',
    domain: 'tiktok.com',
    simpleIconsSlug: 'tiktok',
    fields: [
      { name: 'appKey', label: 'App Key', hint: 'From partner.tiktokshop.com → My Apps → Credentials.' },
      { name: 'appSecret', label: 'App Secret', type: 'password' },
      { name: 'shopCipher', label: 'Shop Cipher', hint: 'Per-shop identifier returned during the auth callback.' },
      { name: 'accessToken', label: 'Access Token', type: 'password', hint: 'Shop-scoped access token from the auth flow.' },
      { name: 'refreshToken', label: 'Refresh Token (optional)', type: 'password', required: false, hint: 'For automated token refresh. Not strictly required while access token is fresh.' },
    ],
  },
  {
    key: 'woocommerce',
    category: 'store',
    label: 'WooCommerce',
    blurb: 'WooCommerce REST API for self-hosted WordPress stores. Uses consumer key + consumer secret over Basic Auth (HTTPS only).',
    badge: 'WOO',
    badgeColor: '#7F54B3',
    setupTier: 1,
    credentialsUrl: 'https://woocommerce.com/document/woocommerce-rest-api/',
    domain: 'woocommerce.com',
    simpleIconsSlug: 'woocommerce',
    fields: [
      { name: 'siteUrl', label: 'Store URL', placeholder: 'https://yourstore.com', hint: 'Full URL of the WooCommerce site (must be HTTPS).' },
      { name: 'consumerKey', label: 'Consumer Key', hint: 'WooCommerce → Settings → Advanced → REST API → Add Key. Needs Read/Write permissions.' },
      { name: 'consumerSecret', label: 'Consumer Secret', type: 'password' },
    ],
  },
  {
    key: 'bigcommerce',
    category: 'store',
    label: 'BigCommerce',
    blurb: 'BigCommerce Stores API V2/V3. Pull orders, push shipments. Uses store hash + access token from a custom store-level API account.',
    badge: 'BIG',
    badgeColor: '#34313F',
    setupTier: 1,
    credentialsUrl: 'https://login.bigcommerce.com/login',
    domain: 'bigcommerce.com',
    simpleIconsSlug: 'bigcommerce',
    fields: [
      { name: 'storeHash', label: 'Store Hash', placeholder: 'abc123def4', hint: 'The 8-10 character hash from your BigCommerce control panel URL (api.bigcommerce.com/stores/<HASH>).' },
      { name: 'accessToken', label: 'Access Token', type: 'password', hint: 'V2/V3 API access token from Advanced Settings → API Accounts.' },
      { name: 'clientId', label: 'Client ID (optional)', required: false, hint: 'Only needed if you intend to do OAuth refresh later.' },
    ],
  },
  {
    key: 'seko',
    category: 'carrier',
    label: 'SEKO Ecommerce',
    blurb: 'SEKO Logistics OmniShip API.',
    badge: 'SEKO',
    badgeColor: '#D32F2F',
    domain: 'sekologistics.com',
    fields: [
      { name: 'accountId', label: 'Account ID' },
      { name: 'apiKey', label: 'API Key', type: 'password' },
    ],
  },
  {
    key: 'epost_global',
    category: 'carrier',
    label: 'ePost Global',
    blurb: 'ePost Global cross-border shipping API.',
    badge: 'ePost',
    badgeColor: '#2E7D32',
    domain: 'epostglobal.com',
    fields: [
      { name: 'accountId', label: 'Account ID' },
      { name: 'apiKey', label: 'API Key', type: 'password' },
    ],
  },
  {
    key: 'intelliquick',
    category: 'carrier',
    label: 'IntelliQuick',
    blurb: 'IntelliQuick same-day & regional delivery.',
    badge: 'IQ',
    badgeColor: '#1976D2',
    domain: 'intelliquickdelivery.com',
    fields: [
      { name: 'accountNumber', label: 'Account Number' },
      { name: 'apiKey', label: 'API Key', type: 'password' },
    ],
  },
  {
    key: 'gls',
    category: 'carrier',
    label: 'GLS US',
    blurb: 'GLS US (formerly Golden State Overnight). Username/password.',
    badge: 'GLS',
    badgeColor: '#FFB300',
    domain: 'gls-us.com',
    fields: [
      { name: 'customerId', label: 'Customer ID' },
      { name: 'username', label: 'Username' },
      { name: 'password', label: 'Password', type: 'password' },
    ],
  },
  {
    key: 'stamps_com',
    category: 'carrier',
    label: 'Stamps.com',
    blurb: 'Stamps.com SwsimV1 API (USPS-authorized postage).',
    badge: 'STMP',
    badgeColor: '#0033A0',
    domain: 'stamps.com',
    fields: [
      { name: 'integrationId', label: 'Integration ID' },
      { name: 'username', label: 'Username' },
      { name: 'password', label: 'Password', type: 'password' },
    ],
  },
  {
    key: 'endicia',
    category: 'carrier',
    label: 'Endicia',
    blurb: 'Endicia Label Server XML postage and label printing.',
    badge: 'ENDI',
    badgeColor: '#E65100',
    domain: 'endicia.com',
    fields: [
      { name: 'accountId', label: 'Account ID' },
      { name: 'passPhrase', label: 'Pass Phrase', type: 'password' },
    ],
  },
]

// Tries each public logo CDN in turn until one succeeds. Each onError advances
// to the next source. Final fallback is the solid-color badge so we never
// render a broken-image icon.
//   1. simple-icons SVG  — sharp brand-color mark when the slug exists
//   2. Google s2 favicon — always responds for any registered domain
//   3. Clearbit Logo API — full-color logo when their index has the brand
//                          (their free tier is deprecated but URLs still
//                          serve some brands as of late 2024)
function ProviderLogo({ provider, size }: { provider: ProviderDef; size: number }) {
  const sources: string[] = []
  if (provider.logoUrl) sources.push(provider.logoUrl)
  if (provider.simpleIconsSlug) {
    sources.push(`https://cdn.simpleicons.org/${provider.simpleIconsSlug}/${provider.badgeColor.replace('#', '')}`)
  }
  sources.push(`https://www.google.com/s2/favicons?domain=${provider.domain}&sz=128`)
  sources.push(`https://logo.clearbit.com/${provider.domain}?size=${size * 2}`)

  const [attempt, setAttempt] = useState(0)
  if (attempt >= sources.length) {
    return (
      <div style={{
        width: size,
        height: Math.round(size * 0.65),
        borderRadius: 4,
        background: provider.badgeColor,
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: Math.max(10, Math.round(size * 0.18)),
        fontWeight: 800,
        letterSpacing: 0.5,
      }}>{provider.badge}</div>
    )
  }
  return (
    <img
      src={sources[attempt]}
      alt={`${provider.label} logo`}
      onError={() => setAttempt((n) => n + 1)}
      style={{
        width: 'auto',
        height: Math.round(size * 0.65),
        maxWidth: size,
        objectFit: 'contain',
      }}
    />
  )
}

interface DraftIntegration {
  id: string
  provider: ProviderKey
  label: string
  accountIdentifier: string
}

interface SavedRow {
  // Globally unique display/state id. Stores get a large offset so a
  // store_accounts row at id=5 can never collide with a carrier_accounts
  // row at id=5 in component state dicts (testResults, rateResults, etc.).
  id: number
  // The real primary key in the source table — what API calls send back
  // when verifying / deleting / pulling from this row.
  accountId: number
  // Which table this row came from. Drives endpoint selection and id-param
  // naming (storeAccountId vs carrierAccountId).
  kind: 'store' | 'carrier'
  clientId: number | null
  provider: string
  label: string | null
  accountIdentifier: string | null
  source: string
  active: boolean
  createdAt: string
  /**
   * Many-to-many: which client(s) can use this carrier account.
   * The legacy single-client `clientId` above stays as a backward-
   * compat anchor; this array is the authoritative source going
   * forward. Empty array = unassigned (admin-global). Populated via
   * the new `Assign Clients` popover on each saved row.
   */
  assignedClientIds: number[]
}

// Stores live in /api/store-accounts, carriers in /api/carrier-accounts.
// Picking the right endpoint is the only thing the FE needs to know.
function endpointForCategory(category: ProviderCategory): string {
  return category === 'store' ? '/store-accounts' : '/carrier-accounts'
}

function endpointForProvider(provider: string): string {
  return STORE_PROVIDERS.has(provider) ? '/store-accounts' : '/carrier-accounts'
}

async function postIntegration(
  body: Record<string, unknown>,
  category: ProviderCategory,
): Promise<SavedRow | null> {
  // Diagnostic — surfaces what the FE is actually sending without leaking
  // secret values.
  const credObj = (body?.credentials && typeof body.credentials === 'object'
    ? (body.credentials as Record<string, unknown>)
    : {})
  const endpoint = endpointForCategory(category)
  // eslint-disable-next-line no-console
  console.log(`[${endpoint}:POST]`, {
    bodyKeys: Object.keys(body ?? {}).sort(),
    credentialKeys: Object.keys(credObj).sort(),
    credentialKeysWithValues: Object.entries(credObj)
      .filter(([, v]) => typeof v === 'string' && v.length > 0)
      .map(([k]) => k)
      .sort(),
    payloadBytes: JSON.stringify(body).length,
  })
  const json = await callVercelFunction<{ data: SavedRow | null }>(endpoint, {
    method: 'POST',
    body,
  })
  return (json?.data as SavedRow) ?? null
}

interface VerifyResult {
  ok: boolean
  accountIdentifier?: string
  accountLabel?: string
  meta?: Record<string, unknown>
  error?: string
  reason?: string
}

async function verifyConnection(rowId: number, provider: string): Promise<VerifyResult> {
  // Tell the verifier which table to load from. Stores → store_accounts,
  // carriers → carrier_accounts.
  const isStore = STORE_PROVIDERS.has(provider)
  return callVercelFunction<VerifyResult>('/carriers/verify', {
    method: 'POST',
    body: isStore ? { storeAccountId: rowId } : { carrierAccountId: rowId },
  })
}

async function deleteIntegration(rowId: number, provider: string): Promise<void> {
  const endpoint = endpointForProvider(provider)
  await callVercelFunction<unknown>(`${endpoint}?id=${rowId}`, {
    method: 'DELETE',
  })
}

interface WalmartOrdersResult {
  ok: boolean
  fetched?: number
  inserted?: number
  updated?: number
  count?: number // legacy field — kept for backward compat with older deploys
  sample?: Array<Record<string, unknown>>
  windowStart?: string
  fetchedAt?: string
  error?: string
}

async function pullWalmartOrders(storeAccountId: number): Promise<WalmartOrdersResult> {
  return callVercelFunction<WalmartOrdersResult>('/carriers/walmart/orders', {
    method: 'POST',
    body: { storeAccountId },
  })
}

async function pullEbayOrders(storeAccountId: number): Promise<WalmartOrdersResult> {
  // Same response shape as Walmart's orders endpoint, so we reuse
  // WalmartOrdersResult — no need for a parallel type.
  return callVercelFunction<WalmartOrdersResult>('/carriers/ebay/orders', {
    method: 'POST',
    body: { storeAccountId },
  })
}

// Maps a store provider key to the matching Pull Orders endpoint helper.
// Adding a new store puller (Amazon, Shopify, Etsy, etc.) is one entry.
const STORE_PULLERS: Record<string, (storeAccountId: number) => Promise<WalmartOrdersResult>> = {
  walmart: pullWalmartOrders,
  ebay: pullEbayOrders,
}

interface CarrierRatesResult {
  ok: boolean
  provider?: string
  simulated?: boolean
  rates?: Array<{ service: string; cost: number; days: number; currency: string }>
  error?: string
}

async function fetchDemoRates(carrierAccountId: number): Promise<CarrierRatesResult> {
  // Demo defaults: a small medium-weight box to a CA zip. Dimensions are
  // included because some quoters (Walmart Shipping Estimates, FedEx for
  // certain accounts) reject calls without boxDimensions — and including
  // them is harmless for quoters that don't care (UPS, USPS, Simulator).
  // For Walmart specifically, the API also requires a purchaseOrderId; the
  // server-side dispatcher (api/carriers/rates.ts) falls back to the most
  // recent Walmart store_orders row when none is passed, which is exactly
  // what we want for a Settings "test the connection" preview.
  return callVercelFunction<CarrierRatesResult>('/carriers/rates', {
    method: 'POST',
    body: {
      carrierAccountId,
      weightOz: 32,
      toZip: '94601',
      dimsL: 12,
      dimsW: 10,
      dimsH: 6,
    },
  })
}

function carrierRateErrorMessage(provider: string, error?: string): string {
  const message = error ?? 'Rate fetch failed'
  if (
    provider === 'walmart_shipping' &&
    /Walmart Shipping Estimates|unable to retrieve data|technical issue|required fields/i.test(message)
  ) {
    return 'Walmart Shipping reached Walmart, but Walmart did not return rates. Confirm Ship With Walmart is enabled and the ship-from origin matches Seller Center.'
  }
  return message
}

// View prop lets the parent (SettingsView drawer) render just the
// Stores section or just the Carriers section in isolation. Default
// is 'all' so existing call sites (no prop) keep the original
// two-section layout.
export type CarrierIntegrationsView = 'all' | 'stores' | 'carriers'

export function CarrierIntegrationsCard({ view = 'all' }: { view?: CarrierIntegrationsView } = {}) {
  // useShippingAccounts (in v2Hooks.ts) caches /api/carrier-accounts results
  // under ['v2-hooks:carrier-accounts']. The Rate Browser sidebar reads from
  // that cache. Adding/deleting a carrier here only updates this component's
  // local `saved` state — without invalidating the React Query cache, the
  // sidebar still shows the pre-mutation list (e.g. "Simulator (Demo) is
  // deleted but still appears in Rate Browser"). Same trap for stores via
  // ['v2-hooks:carriers'] indirectly — invalidate both to be safe.
  const queryClient = useQueryClient()
  const refreshAccountsCache = () => {
    void queryClient.invalidateQueries({ queryKey: ['v2-hooks:carrier-accounts'] })
    void queryClient.invalidateQueries({ queryKey: ['v2-hooks:carriers'] })
  }

  const [saved, setSaved] = useState<SavedRow[]>([])
  const [openProvider, setOpenProvider] = useState<ProviderKey | null>(null)
  const [formValues, setFormValues] = useState<Record<string, string>>({})
  const [formLabel, setFormLabel] = useState('')
  const [submitState, setSubmitState] = useState<{ kind: 'idle' | 'saving' | 'success' | 'error'; message?: string }>({ kind: 'idle' })
  const [listError, setListError] = useState<string | null>(null)
  const [testing, setTesting] = useState<Record<number, boolean>>({})
  const [testResults, setTestResults] = useState<Record<number, VerifyResult>>({})
  const [deleting, setDeleting] = useState<Record<number, boolean>>({})
  const [pulling, setPulling] = useState<Record<number, boolean>>({})
  const [pullResults, setPullResults] = useState<Record<number, WalmartOrdersResult>>({})
  const [rating, setRating] = useState<Record<number, boolean>>({})
  // Per-row "Assign Clients" popover state. Only one popover is open
  // at a time — `assignOpenForId` holds the SavedRow.id (or null).
  // `assignDraft` is the in-progress checkbox set inside the open
  // popover; on Save we PUT to backend and merge into `saved` state.
  const [assignOpenForId, setAssignOpenForId] = useState<number | null>(null)
  const [assignDraft, setAssignDraft] = useState<Set<number>>(new Set())
  const [assignSaving, setAssignSaving] = useState(false)
  const { clients: allClients } = useClients()
  // Index clients by id for fast name lookup when rendering chips.
  const clientById = useMemo(() => {
    const m = new Map<number, { id: number; name: string }>()
    for (const c of allClients ?? []) {
      const id = (c as any).clientId ?? (c as any).id
      if (typeof id === 'number') m.set(id, { id, name: c.name ?? `#${id}` })
    }
    return m
  }, [allClients])
  const [rateResults, setRateResults] = useState<Record<number, CarrierRatesResult>>({})
  // Tracks which category we're adding (store vs carrier) so the Add modal
  // can filter its provider tiles to only the relevant integrations.
  const [addCategory, setAddCategory] = useState<ProviderCategory | null>(null)

  // The run* handlers take the SavedRow directly so they can use:
  //   d.id        — globally unique state-dict key (offset for stores)
  //   d.accountId — real DB primary key in its source table (passed to API)
  //   d.provider  — drives endpoint selection (store-accounts vs carrier-accounts)
  const runFetchRates = async (d: SavedRow) => {
    setRating((prev) => ({ ...prev, [d.id]: true }))
    try {
      const result = await fetchDemoRates(d.accountId)
      setRateResults((prev) => ({ ...prev, [d.id]: result }))
    } catch (err) {
      setRateResults((prev) => ({
        ...prev,
        [d.id]: { ok: false, error: err instanceof Error ? err.message : String(err) },
      }))
    } finally {
      setRating((prev) => ({ ...prev, [d.id]: false }))
    }
  }

  const runPullOrders = async (d: SavedRow) => {
    const puller = STORE_PULLERS[d.provider]
    if (!puller) {
      setPullResults((prev) => ({
        ...prev,
        [d.id]: { ok: false, error: `No orders puller wired for provider "${d.provider}".` },
      }))
      return
    }
    setPulling((prev) => ({ ...prev, [d.id]: true }))
    try {
      const result = await puller(d.accountId)
      setPullResults((prev) => ({ ...prev, [d.id]: result }))
    } catch (err) {
      setPullResults((prev) => ({
        ...prev,
        [d.id]: { ok: false, error: err instanceof Error ? err.message : String(err) },
      }))
    } finally {
      setPulling((prev) => ({ ...prev, [d.id]: false }))
    }
  }

  // Open the assign popover for a row; seed the draft from the row's
  // current assignedClientIds so the operator sees the existing
  // assignments and can adjust without re-typing.
  const openAssignPopover = (d: SavedRow) => {
    setAssignDraft(new Set(d.assignedClientIds ?? []))
    setAssignOpenForId(d.id)
  }
  const closeAssignPopover = () => {
    setAssignOpenForId(null)
    setAssignDraft(new Set())
  }
  // Toggle one client in the draft Set (immutable replace — React
  // doesn't track Set mutations, only reference changes).
  const toggleAssignClient = (clientId: number) => {
    setAssignDraft((prev) => {
      const next = new Set(prev)
      if (next.has(clientId)) next.delete(clientId)
      else next.add(clientId)
      return next
    })
  }
  // PUT the new assignment list to the backend, merge the response
  // into local `saved` state so the chip display updates without a
  // full refresh round-trip.
  const saveAssignments = async (d: SavedRow) => {
    if (d.kind !== 'carrier') {
      // Stores route through a different table that doesn't yet have
      // a junction. Surface a clear message instead of silently no-op.
      alert('Multi-client assignment is currently carrier-only. Stores assignment is coming soon.')
      return
    }
    setAssignSaving(true)
    try {
      const ids = Array.from(assignDraft)
      const res = await callVercelFunction<{
        data: { id: number; assignedClientIds: number[] }
      }>(`/carrier-accounts?id=${d.accountId}`, {
        method: 'PUT',
        body: { clientIds: ids },
      })
      const fresh = res?.data?.assignedClientIds ?? ids
      setSaved((prev) =>
        prev.map((row) =>
          row.id === d.id ? { ...row, assignedClientIds: fresh } : row,
        ),
      )
      closeAssignPopover()
    } catch (err) {
      alert(`Failed to save assignments: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setAssignSaving(false)
    }
  }

  const runDelete = async (d: SavedRow) => {
    if (!confirm(`Delete the saved integration "${d.label ?? d.accountId}"? This cannot be undone.`)) return
    setDeleting((prev) => ({ ...prev, [d.id]: true }))
    try {
      await deleteIntegration(d.accountId, d.provider)
      setSaved((prev) => prev.filter((r) => r.id !== d.id))
      setTestResults((prev) => { const next = { ...prev }; delete next[d.id]; return next })
      setRateResults((prev) => { const next = { ...prev }; delete next[d.id]; return next })
      setPullResults((prev) => { const next = { ...prev }; delete next[d.id]; return next })
      // Tell the Rate Browser sidebar (useShippingAccounts) that the cached
      // carrier list is stale so the deleted row drops out immediately
      // rather than after the 60s staleTime expires.
      refreshAccountsCache()
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Failed to delete')
    } finally {
      setDeleting((prev) => ({ ...prev, [d.id]: false }))
    }
  }

  const runTest = async (d: SavedRow) => {
    setTesting((prev) => ({ ...prev, [d.id]: true }))
    try {
      const result = await verifyConnection(d.accountId, d.provider)
      setTestResults((prev) => ({ ...prev, [d.id]: result }))
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [d.id]: { ok: false, error: err instanceof Error ? err.message : String(err) },
      }))
    } finally {
      setTesting((prev) => ({ ...prev, [d.id]: false }))
    }
  }

  const refresh = async () => {
    try {
      // Fetch from BOTH tables in parallel and merge for the unified list view.
      // Each row gets:
      //   - accountId: the real PK in its source table (use this for API calls)
      //   - kind: 'store' | 'carrier' (drives endpoint + id-param naming)
      //   - id: offset for stores so two tables can't share a state-dict key
      // The state dicts (testResults, rateResults, deleting, …) all key on
      // `id` so the offset guarantees no cross-table collisions.
      const STORE_DISPLAY_OFFSET = 1_000_000_000
      type RawRow = Omit<SavedRow, 'accountId' | 'kind'>
      const [carriersRes, storesRes] = await Promise.all([
        callVercelFunction<{ data: RawRow[] }>('/carrier-accounts?source=admin').catch((e) => {
          console.warn('[Settings] /carrier-accounts fetch failed:', e)
          return { data: [] as RawRow[] }
        }),
        callVercelFunction<{ data: RawRow[] }>('/store-accounts?source=admin').catch((e) => {
          console.warn('[Settings] /store-accounts fetch failed:', e)
          return { data: [] as RawRow[] }
        }),
      ])
      const carriers: SavedRow[] = (carriersRes?.data ?? []).map((r) => ({
        ...r,
        accountId: r.id,
        kind: 'carrier' as const,
        // Backend may return assignedClientIds as null on legacy rows
        // before the junction table existed. Normalize to [] so the
        // FE can always do `.length` / `.map` without null-checks.
        assignedClientIds: Array.isArray((r as any).assignedClientIds)
          ? ((r as any).assignedClientIds as number[])
          : [],
      }))
      const stores: SavedRow[] = (storesRes?.data ?? []).map((r) => ({
        ...r,
        accountId: r.id,
        id: r.id + STORE_DISPLAY_OFFSET,
        kind: 'store' as const,
        // Stores don't currently support multi-client assignment
        // (separate table, separate junction needed). Keep the
        // field present for type uniformity; renderSavedRow checks
        // `kind` before showing the assign UI so this stays inert.
        assignedClientIds: Array.isArray((r as any).assignedClientIds)
          ? ((r as any).assignedClientIds as number[])
          : [],
      }))
      setSaved([...carriers, ...stores])
      setListError(null)
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Failed to load')
    }
  }
  useEffect(() => { void refresh() }, [])

  const handleAdd = async (provider: ProviderDef) => {
    if (!formLabel.trim()) {
      setSubmitState({ kind: 'error', message: 'Label is required' })
      return
    }
    const missingField = provider.fields.find(
      (f) => f.required !== false && !formValues[f.name]?.trim(),
    )
    if (missingField) {
      setSubmitState({ kind: 'error', message: `${missingField.label} is required` })
      return
    }
    setSubmitState({ kind: 'saving' })
    const accountIdentifier = String(
      formValues.accountNumber ?? formValues.apiKey ?? formValues.clientId ?? formLabel,
    ).trim()
    try {
      await postIntegration({
        provider: provider.key,
        label: formLabel.trim(),
        accountIdentifier,
        credentials: { ...formValues },
        source: 'admin',
      }, provider.category)
      setSubmitState({ kind: 'success', message: 'Integration saved.' })
      setFormValues({})
      setFormLabel('')
      setOpenProvider(null)
      await refresh()
      // Bump the Rate Browser sidebar cache so a newly-saved carrier
      // appears without waiting for the 60s staleTime.
      refreshAccountsCache()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      setSubmitState({ kind: 'error', message })
    }
  }

  const [modalOpen, setModalOpen] = useState(false)

  // Helper that opens the Add modal for a specific category. Resets the
  // form scratch state so the user lands on a clean tile picker, not a
  // half-filled credentials form from a previous attempt.
  const openAddModal = (category: ProviderCategory) => {
    setAddCategory(category)
    setModalOpen(true)
    setOpenProvider(null)
    setFormValues({})
    setFormLabel('')
    setSubmitState({ kind: 'idle' })
  }

  // Group saved rows by category so we can render each section against its
  // own slice. Unknown providers default to 'carrier' rather than disappearing.
  const savedByCategory = (() => {
    const stores: SavedRow[] = []
    const carriers: SavedRow[] = []
    for (const row of saved) {
      if (STORE_PROVIDERS.has(row.provider)) stores.push(row)
      else carriers.push(row)
    }
    return { stores, carriers }
  })()

  // Renders one saved-row line item — extracted so we can call it from both
  // the Stores section and the Carriers section without duplicating markup.
  // `index` drives the stagger entrance: rows fade+slide in 40ms after the
  // one above. `motion.li` also gets a subtle hover lift so rows feel like
  // tappable cards rather than table rows.
  const renderSavedRow = (d: SavedRow, index: number) => {
    const result = testResults[d.id]
    const isTesting = !!testing[d.id]
    const isStore = STORE_PROVIDERS.has(d.provider)
    return (
      <motion.li
        key={d.id}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{
          duration: 0.32,
          delay: Math.min(index, 12) * 0.04,
          ease: [0.22, 1, 0.36, 1],
        }}
        whileHover={{ y: -1 }}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          padding: '10px 12px',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          marginBottom: 6,
          fontSize: 12,
          boxShadow: '0 1px 2px rgba(15, 23, 42, 0.04)',
          transition: 'box-shadow 200ms, border-color 200ms',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.boxShadow =
            '0 6px 14px -4px rgba(15, 23, 42, 0.10), 0 2px 4px -2px rgba(15, 23, 42, 0.06)'
          e.currentTarget.style.borderColor = 'rgb(var(--brand-rgb, 42 91 215) / 0.25)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.boxShadow = '0 1px 2px rgba(15, 23, 42, 0.04)'
          e.currentTarget.style.borderColor = 'var(--border)'
        }}
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontWeight: 700 }}>{d.provider.toUpperCase()}</span>
          <span style={{ color: 'var(--text2)' }}>{d.label ?? '—'}</span>
          <span style={{ flex: 1, color: 'var(--text3)', fontFamily: 'monospace', fontSize: 11 }}>
            {d.accountIdentifier ?? '—'}
          </span>
          <span style={{ fontSize: 10, color: 'var(--text3)' }}>{formatCaDateShort(d.createdAt)}</span>
          <ActionButton
            icon={<Wifi size={11} strokeWidth={2.5} />}
            label="Test Connection"
            loadingLabel="Testing…"
            loading={isTesting}
            onClick={() => runTest(d)}
            title="Verify credentials with the carrier API"
          />
          {isStore && STORE_PULLERS[d.provider] ? (
            <ActionButton
              icon={<PackageSearch size={11} strokeWidth={2.5} />}
              label="Pull Orders"
              loadingLabel="Pulling…"
              loading={!!pulling[d.id]}
              onClick={() => runPullOrders(d)}
              title={`Pull recent ${d.provider} orders`}
            />
          ) : null}
          {!isStore && !PROVIDER_DEFS.find((p) => p.key === d.provider)?.noRateQuotes ? (
            <ActionButton
              icon={<Receipt size={11} strokeWidth={2.5} />}
              label="Get Rates"
              loadingLabel="Fetching…"
              loading={!!rating[d.id]}
              onClick={() => runFetchRates(d)}
              title="Fetch a sample shipping rate for this carrier"
            />
          ) : null}
          {d.kind === 'carrier' ? (
            <ActionButton
              icon={<Users2 size={11} strokeWidth={2.5} />}
              label={`Assign${d.assignedClientIds.length > 0 ? ` (${d.assignedClientIds.length})` : ''}`}
              variant="primary"
              onClick={() => openAssignPopover(d)}
              title="Assign this carrier account to one or more clients"
            />
          ) : null}
          <ActionButton
            icon={<Trash2 size={11} strokeWidth={2.25} />}
            label="Delete"
            loadingLabel="Deleting…"
            loading={!!deleting[d.id]}
            variant="danger"
            onClick={() => runDelete(d)}
            title="Delete integration"
          />
        </div>

        {/* Assigned-client chips — inline summary of which clients
            currently have access to this carrier account. Empty
            state nudges operators toward assigning. Carriers only;
            stores hide it (separate table without junction yet). */}
        {d.kind === 'carrier' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', paddingLeft: 4, marginTop: 2 }}>
            <span style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 700 }}>
              Assigned to:
            </span>
            {d.assignedClientIds.length === 0 ? (
              <span style={{ fontSize: 11, color: 'var(--text3)', fontStyle: 'italic' }}>
                No clients yet — click Assign to add
              </span>
            ) : (
              d.assignedClientIds.map((cid) => {
                const client = clientById.get(cid)
                return (
                  <span
                    key={cid}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 3,
                      padding: '2px 7px',
                      borderRadius: 10,
                      background: 'rgb(var(--brand-rgb, 42 91 215) / 0.1)',
                      color: 'rgb(var(--brand-rgb, 42 91 215))',
                      fontSize: 10.5,
                      fontWeight: 700,
                      lineHeight: 1.3,
                    }}
                  >
                    {client?.name ?? `#${cid}`}
                  </span>
                )
              })
            )}
          </div>
        ) : null}

        {/* Assign-clients popover — anchored modal-style overlay.
            AnimatePresence handles enter/exit; backdrop click +
            Cancel button + Escape (via input handlers) all close it.
            Renders ALL clients with checkboxes; saves on click.

            CRITICAL: rendered through createPortal to document.body
            so position: fixed actually anchors to the viewport. The
            parent <motion.li> has whileHover={{ y: -1 }}, which
            applies a transform to the row. Any ancestor with
            transform makes position: fixed re-anchor to that
            ancestor (well-known CSS quirk dating to the original
            CSS Transforms spec) — without the portal, the modal
            slides off-screen on hover and the Save Assignments
            button ends up unreachable. The portal escapes the
            transformed ancestor entirely. */}
        {createPortal(
        <AnimatePresence>
          {assignOpenForId === d.id ? (
            <motion.div
              key="assignBackdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              onClick={(e) => {
                if (e.target === e.currentTarget && !assignSaving) closeAssignPopover()
              }}
              style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(15, 23, 42, 0.5)',
                backdropFilter: 'blur(4px)',
                WebkitBackdropFilter: 'blur(4px)',
                zIndex: 9998,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 24,
              }}
            >
              <motion.div
                key="assignPanel"
                initial={{ opacity: 0, y: 12, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.97 }}
                transition={{ type: 'spring', stiffness: 380, damping: 28 }}
                style={{
                  background: 'var(--surface)',
                  borderRadius: 12,
                  width: 'min(440px, 100%)',
                  maxHeight: '80vh',
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column',
                  boxShadow:
                    '0 20px 60px -12px rgba(15, 23, 42, 0.35), 0 8px 24px -8px rgba(15, 23, 42, 0.18)',
                }}
              >
                <div
                  style={{
                    padding: '16px 18px',
                    borderBottom: '1px solid var(--border)',
                    background:
                      'linear-gradient(135deg, rgb(var(--brand-rgb, 42 91 215) / 0.08), transparent)',
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 12,
                  }}
                >
                  <motion.div
                    initial={{ scale: 0.6, opacity: 0, rotate: -8 }}
                    animate={{ scale: 1, opacity: 1, rotate: 0 }}
                    transition={{ type: 'spring', stiffness: 320, damping: 18, delay: 0.05 }}
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 10,
                      flexShrink: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background:
                        'linear-gradient(135deg, rgb(var(--brand-rgb, 42 91 215) / 0.18), rgb(var(--brand-rgb, 42 91 215) / 0.05))',
                      boxShadow: 'inset 0 0 0 1px rgb(var(--brand-rgb, 42 91 215) / 0.22)',
                      color: 'rgb(var(--brand-rgb, 42 91 215))',
                    }}
                  >
                    <Users2 size={18} strokeWidth={2.25} />
                  </motion.div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--text)', letterSpacing: '-0.01em' }}>
                      Assign clients · {d.provider.toUpperCase()}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 3, lineHeight: 1.45 }}>
                      Select which client(s) can use this carrier account for rate shopping and label purchase.
                    </div>
                  </div>
                </div>

                <div style={{ overflowY: 'auto', padding: '8px 4px', flex: 1, minHeight: 0 }}>
                  {(allClients ?? []).length === 0 ? (
                    <div style={{ padding: '12px 16px', fontSize: 12, color: 'var(--text3)', textAlign: 'center' }}>
                      No clients available. Add clients in the Inventory → Clients tab first.
                    </div>
                  ) : (
                    (allClients ?? []).map((c, idx) => {
                      const cid = (c as any).clientId ?? (c as any).id
                      if (typeof cid !== 'number') return null
                      const checked = assignDraft.has(cid)
                      return (
                        <motion.label
                          key={cid}
                          initial={{ opacity: 0, x: -6 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{
                            duration: 0.22,
                            delay: Math.min(idx, 10) * 0.025,
                            ease: [0.22, 1, 0.36, 1],
                          }}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 12,
                            padding: '10px 14px',
                            cursor: assignSaving ? 'wait' : 'pointer',
                            transition: 'background 120ms',
                            borderRadius: 6,
                            margin: '2px 6px',
                            background: checked
                              ? 'rgb(var(--brand-rgb, 42 91 215) / 0.10)'
                              : 'transparent',
                          }}
                          onMouseEnter={(e) => {
                            if (!checked) e.currentTarget.style.background = 'var(--surface2)'
                          }}
                          onMouseLeave={(e) => {
                            if (!checked) e.currentTarget.style.background = 'transparent'
                          }}
                        >
                          <ModernCheckbox
                            checked={checked}
                            onChange={() => toggleAssignClient(cid)}
                            disabled={assignSaving}
                          />
                          <span
                            style={{
                              flex: 1,
                              fontSize: 13,
                              fontWeight: checked ? 700 : 500,
                              color: checked ? 'rgb(var(--brand-rgb, 42 91 215))' : 'var(--text)',
                              transition: 'color 150ms, font-weight 150ms',
                            }}
                          >
                            {c.name}
                          </span>
                          <span
                            style={{
                              fontSize: 10,
                              color: 'var(--text3)',
                              fontFamily: 'monospace',
                              padding: '2px 6px',
                              borderRadius: 4,
                              background: 'var(--surface2)',
                            }}
                          >
                            #{cid}
                          </span>
                        </motion.label>
                      )
                    })
                  )}
                </div>

                <div
                  style={{
                    padding: '12px 16px',
                    borderTop: '1px solid var(--border)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    background: 'var(--surface2)',
                  }}
                >
                  <span style={{ flex: 1, fontSize: 11.5, color: 'var(--text3)' }}>
                    {assignDraft.size} selected
                  </span>
                  <motion.button
                    type="button"
                    onClick={closeAssignPopover}
                    disabled={assignSaving}
                    whileHover={!assignSaving ? { y: -1 } : undefined}
                    whileTap={!assignSaving ? { scale: 0.96 } : undefined}
                    transition={{ type: 'spring', stiffness: 400, damping: 22 }}
                    style={{
                      padding: '7px 14px',
                      border: '1px solid var(--border)',
                      borderRadius: 7,
                      background: 'var(--surface)',
                      color: 'var(--text2)',
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: assignSaving ? 'wait' : 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <XIcon size={12} strokeWidth={2.5} />
                    Cancel
                  </motion.button>
                  <motion.button
                    type="button"
                    onClick={() => void saveAssignments(d)}
                    disabled={assignSaving}
                    whileHover={!assignSaving ? { y: -1 } : undefined}
                    whileTap={!assignSaving ? { scale: 0.96 } : undefined}
                    transition={{ type: 'spring', stiffness: 400, damping: 22 }}
                    style={{
                      padding: '7px 16px',
                      border: 'none',
                      borderRadius: 7,
                      background:
                        'linear-gradient(135deg, rgb(var(--brand-rgb, 42 91 215)), rgb(79 70 229))',
                      color: '#fff',
                      fontSize: 12,
                      fontWeight: 800,
                      cursor: assignSaving ? 'wait' : 'pointer',
                      opacity: assignSaving ? 0.7 : 1,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      boxShadow:
                        '0 4px 10px -2px rgb(var(--brand-rgb, 42 91 215) / 0.4), inset 0 1px 0 0 rgba(255, 255, 255, 0.18)',
                    }}
                  >
                    {assignSaving ? (
                      <Loader2 size={12} strokeWidth={2.5} className="animate-spin" />
                    ) : (
                      <CheckIcon size={12} strokeWidth={2.75} />
                    )}
                    {assignSaving ? 'Saving…' : 'Save Assignments'}
                  </motion.button>
                </div>
              </motion.div>
            </motion.div>
          ) : null}
        </AnimatePresence>,
        document.body,
        )}
        {result ? (
          <div style={{
            fontSize: 11,
            color: result.ok ? 'var(--green)' : 'var(--red)',
            paddingLeft: 4,
          }}>
            {result.ok
              ? `✅ ${result.accountLabel ?? 'Connected'}`
              : `❌ ${result.error ?? 'Verification failed'}${result.reason ? ` (${result.reason})` : ''}`}
            {!result.ok && Array.isArray((result.meta as any)?._credentialKeysReceived) ? (
              <div style={{ color: 'var(--text3)', marginTop: 2 }}>
                Saved credential keys: {((result.meta as any)._credentialKeysReceived as string[]).join(', ') || '(none)'}
              </div>
            ) : null}
          </div>
        ) : null}
        {pullResults[d.id] ? (
          <div style={{
            fontSize: 11,
            color: pullResults[d.id].ok ? 'var(--green)' : 'var(--red)',
            paddingLeft: 4,
            marginTop: 2,
          }}>
            {(() => {
              const r = pullResults[d.id]
              if (!r.ok) return `❌ Pull failed: ${r.error ?? 'Unknown error'}`
              const fetched = r.fetched ?? r.count ?? 0
              const inserted = r.inserted ?? 0
              const updated = r.updated ?? 0
              const sampleStr = r.sample && r.sample.length > 0
                ? ` — sample PO IDs: ${r.sample.slice(0, 3).map((s: any) => s.purchaseOrderId).filter(Boolean).join(', ')}`
                : ''
              if (r.fetched != null) {
                return `📦 ${fetched} fetched · ${inserted} new · ${updated} updated (saved to store_orders)${sampleStr}`
              }
              return `📦 ${fetched} orders found in last 7 days${sampleStr}`
            })()}
          </div>
        ) : null}
        {!isStore && PROVIDER_DEFS.find((p) => p.key === d.provider)?.noRateQuotes ? (
          <div style={{
            fontSize: 11,
            color: 'var(--text3)',
            paddingLeft: 4,
            marginTop: 2,
            fontStyle: 'italic',
          }}>
            ℹ️ Tracking-push only. This carrier doesn't expose rate quotes — use UPS / USPS / FedEx direct for rate-shopping.
          </div>
        ) : null}
        {rateResults[d.id] ? (
          <div style={{
            fontSize: 11,
            color: rateResults[d.id].ok ? 'var(--green)' : 'var(--red)',
            paddingLeft: 4,
            marginTop: 2,
          }}>
            {(() => {
              const r = rateResults[d.id]
              if (!r.ok) return `❌ ${carrierRateErrorMessage(d.provider, r.error)}`
              const tag = r.simulated ? '🧪 Simulated' : '💰 Live'
              const ratesText = (r.rates ?? [])
                .map((rt) => `${rt.service} $${rt.cost.toFixed(2)} (${rt.days}d)`)
                .join(' · ')
              return `${tag} rates for 2 lb to 94601: ${ratesText || '(none)'}`
            })()}
          </div>
        ) : null}
      </motion.li>
    )
  }

  // Section header + add button used for both Stores and Carriers. Centralized
  // here so styling stays consistent and we only have one button definition.
  // Section header — replaces the emoji-prefix pattern with a proper
  // lucide icon in a soft brand-tinted circular badge. Pairs the icon
  // with a clean two-line text block (title + blurb) and a refined
  // "Add" button on the right featuring an icon, gradient background,
  // and hover lift. Animated entrance per section so the header
  // settles into place rather than appearing flat.
  const renderSectionHeader = (
    Icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>,
    title: string,
    blurb: string,
    addLabel: string,
    category: ProviderCategory,
  ) => (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="flex items-center justify-between gap-3"
    >
      <div className="flex items-center gap-3 min-w-0">
        <motion.div
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 280, damping: 18, delay: 0.05 }}
          className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{
            background:
              'linear-gradient(135deg, rgb(var(--brand-rgb, 42 91 215) / 0.14), rgb(var(--brand-rgb, 42 91 215) / 0.04))',
            boxShadow: 'inset 0 0 0 1px rgb(var(--brand-rgb, 42 91 215) / 0.18)',
          }}
        >
          <Icon size={16} strokeWidth={2.25} className="text-brand" />
        </motion.div>
        <div className="min-w-0">
          <h3 className="m-0 text-[14px] font-extrabold tracking-tight text-ink font-display">
            {title}
          </h3>
          <p className="text-[11px] text-ink-3 mt-0.5 leading-snug">{blurb}</p>
        </div>
      </div>
      <motion.button
        type="button"
        whileHover={{ y: -1 }}
        whileTap={{ scale: 0.96 }}
        transition={{ type: 'spring', stiffness: 400, damping: 24 }}
        onClick={() => openAddModal(category)}
        className="inline-flex items-center gap-1.5 h-8 px-3.5 rounded-lg text-[12px] font-bold text-white whitespace-nowrap"
        style={{
          background:
            'linear-gradient(135deg, rgb(var(--brand-rgb, 42 91 215)), rgb(79 70 229))',
          boxShadow:
            '0 4px 10px -2px rgb(var(--brand-rgb, 42 91 215) / 0.4), inset 0 1px 0 0 rgba(255, 255, 255, 0.18)',
        }}
      >
        <Plus size={13} strokeWidth={2.75} />
        {addLabel}
      </motion.button>
    </motion.div>
  )

  const showStores = view === 'all' || view === 'stores'
  const showCarriers = view === 'all' || view === 'carriers'

  return (
    <div className="markup-card" style={{ marginTop: 16 }}>
      {/* ── Stores: marketplace order sources (Walmart, Amazon) ──────────── */}
      {showStores ? (
        <>
          {renderSectionHeader(
            Store,
            'Your Stores',
            'Marketplace order sources. Use these to pull orders into PrepShip and push tracking back. Stores do not return shipping rates.',
            'Add Store',
            'store',
          )}
          <div style={{ height: 12 }} />
          {listError && saved.length > 0 ? (
            <div style={{
              background: 'var(--surface2)',
              border: '1px dashed var(--red)',
              borderRadius: 4,
              padding: '6px 10px',
              fontSize: 11,
              color: 'var(--red)',
              marginBottom: 12,
            }}>
              ⚠ Couldn't refresh integrations: {listError}
            </div>
          ) : null}
          {savedByCategory.stores.length > 0 ? (
            <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 16px' }}>
              {savedByCategory.stores.map(renderSavedRow)}
            </ul>
          ) : (
            <div style={{
              fontSize: 12,
              color: 'var(--text3)',
              background: 'var(--surface)',
              border: '1px dashed var(--border2)',
              borderRadius: 4,
              padding: '12px',
              textAlign: 'center',
              marginBottom: 16,
            }}>
              No stores connected yet. Click <b>+ Add Store</b> to connect a marketplace.
            </div>
          )}
        </>
      ) : null}

      {/* ── Carriers: actual shipping carriers (UPS, USPS, FedEx, …) ─────── */}
      {showCarriers ? (
        <>
          {renderSectionHeader(
            Truck,
            'Your Carriers',
            'Direct shipping carriers — used for rate shopping and label purchase. These appear in the Rate Browser sidebar.',
            'Add Carrier',
            'carrier',
          )}
          <div style={{ height: 12 }} />
          {savedByCategory.carriers.length > 0 ? (
            <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 12px' }}>
              {savedByCategory.carriers.map(renderSavedRow)}
            </ul>
          ) : (
            <div style={{
              fontSize: 12,
              color: 'var(--text3)',
              background: 'var(--surface)',
              border: '1px dashed var(--border2)',
              borderRadius: 4,
              padding: '12px',
              textAlign: 'center',
            }}>
              No carriers connected yet. Click <b>+ Add Carrier</b> to connect one (UPS, USPS, FedEx, etc.).
            </div>
          )}
        </>
      ) : null}


      <AnimatePresence>
      {modalOpen ? (
        <motion.div
          key="addModalBackdrop"
          role="dialog"
          aria-modal="true"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setModalOpen(false)
              setOpenProvider(null)
            }
          }}
          style={{
            position: 'fixed',
            inset: 0,
            // Slightly darker tint + backdrop blur so the modal pops
            // off the page instead of feeling like a flat overlay.
            background: 'rgba(15, 23, 42, 0.55)',
            backdropFilter: 'blur(6px)',
            WebkitBackdropFilter: 'blur(6px)',
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <motion.div
            key="addModalPanel"
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 360, damping: 28 }}
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              width: '100%',
              maxWidth: 760,
              maxHeight: '88vh',
              overflow: 'auto',
              // Stronger shadow + soft brand glow on the top edge —
              // matches the "Calm Command Center" tone of the new
              // settings page; the modal feels like a deliberate
              // elevation, not a basic dialog.
              boxShadow:
                '0 20px 60px -12px rgba(15, 23, 42, 0.35), 0 8px 24px -8px rgba(15, 23, 42, 0.18), inset 0 1px 0 0 rgba(255, 255, 255, 0.6)',
            }}
          >
            <div style={{
              padding: '14px 18px',
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}>
              <div style={{ fontSize: 14, fontWeight: 800 }}>
                {openProvider
                  ? `Connect ${PROVIDER_DEFS.find((p) => p.key === openProvider)?.label}`
                  : addCategory === 'store'
                    ? 'Connect a Store'
                    : addCategory === 'carrier'
                      ? 'Connect a Carrier'
                      : 'Connect an Integration'}
              </div>
              <button
                type="button"
                onClick={() => {
                  setModalOpen(false)
                  setOpenProvider(null)
                }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  fontSize: 18,
                  color: 'var(--text3)',
                  cursor: 'pointer',
                  lineHeight: 1,
                }}
                aria-label="Close"
              >×</button>
            </div>
            <div style={{ padding: 18 }}>
              {!openProvider ? (
                <>
                  <p style={{ fontSize: 12, color: 'var(--text3)', margin: '0 0 14px' }}>
                    Click a tile to add credentials for that {addCategory ?? 'integration'}.
                  </p>
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                    gap: 12,
                  }}>
                    {PROVIDER_DEFS
                      .filter((p) => addCategory == null || p.category === addCategory)
                      // Sort by setup tier so the easiest carriers appear
                      // first — users naturally land on the fastest path
                      // to working rates. Stable sort within tier preserves
                      // the original PROVIDER_DEFS ordering.
                      .slice()
                      .sort((a, b) => (a.setupTier ?? 99) - (b.setupTier ?? 99))
                      .map((p) => {
                      const tier = p.setupTier
                      const tierMeta = tier ? TIER_META[tier] : null
                      return (
                      <button
                        key={p.key}
                        type="button"
                        onClick={() => {
                          setOpenProvider(p.key)
                          setFormValues({})
                          setFormLabel('')
                          setSubmitState({ kind: 'idle' })
                        }}
                        style={{
                          position: 'relative',
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 8,
                          padding: 16,
                          height: 110,
                          background: 'var(--surface)',
                          border: '1px solid var(--border)',
                          borderRadius: 6,
                          cursor: 'pointer',
                          transition: 'border-color 0.15s, box-shadow 0.15s',
                        }}
                        onMouseEnter={(e) => {
                          ;(e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--ss-blue)'
                          ;(e.currentTarget as HTMLButtonElement).style.boxShadow = '0 2px 6px rgba(0,0,0,0.08)'
                        }}
                        onMouseLeave={(e) => {
                          ;(e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'
                          ;(e.currentTarget as HTMLButtonElement).style.boxShadow = 'none'
                        }}
                      >
                        {tierMeta && (
                          // Setup-tier badge in the corner — colored by
                          // difficulty so the user can scan the grid and
                          // pick whichever fits the time they have. Same
                          // pattern EasyPost uses on its dashboard.
                          <div
                            style={{
                              position: 'absolute',
                              top: 4,
                              right: 4,
                              fontSize: 9,
                              fontWeight: 700,
                              padding: '2px 6px',
                              borderRadius: 10,
                              color: tierMeta.color,
                              background: tierMeta.bg,
                              letterSpacing: 0.3,
                              textTransform: 'uppercase',
                            }}
                            title={`${tierMeta.label} setup — ${tierMeta.time}`}
                          >
                            {tierMeta.time}
                          </div>
                        )}
                        <ProviderLogo provider={p} size={64} />
                        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', textAlign: 'center' }}>
                          {p.label}
                        </div>
                      </button>
                      )
                    })}
                  </div>
                </>
              ) : (() => {
                const def = PROVIDER_DEFS.find((p) => p.key === openProvider)!
                return (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                      <ProviderLogo provider={def} size={72} />
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 700 }}>{def.label}</div>
                        <div style={{ fontSize: 11, color: 'var(--text3)' }}>{def.blurb}</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setOpenProvider(null)
                          setFormValues({})
                          setFormLabel('')
                          setSubmitState({ kind: 'idle' })
                        }}
                        style={{
                          marginLeft: 'auto',
                          padding: '4px 10px',
                          border: '1px solid var(--border)',
                          borderRadius: 3,
                          background: 'var(--surface2)',
                          color: 'var(--text)',
                          fontSize: 11,
                          cursor: 'pointer',
                        }}
                      >
                        ← All providers
                      </button>
                    </div>
                    {(def.credentialsUrl || def.setupTier) && (
                      // Setup-help banner: tier indicator + direct link to
                      // the carrier's developer portal credentials page.
                      // Eliminates the "where do I get the API key from?"
                      // question every new user asks. Mirrors how
                      // EasyPost / Shopify / Stripe surface this on
                      // their integration setup pages.
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          padding: '8px 12px',
                          marginBottom: 14,
                          background: 'var(--surface2)',
                          border: '1px solid var(--border)',
                          borderRadius: 4,
                          fontSize: 11,
                        }}
                      >
                        {def.setupTier && (
                          <span
                            style={{
                              fontWeight: 700,
                              fontSize: 9,
                              padding: '3px 7px',
                              borderRadius: 10,
                              color: TIER_META[def.setupTier].color,
                              background: TIER_META[def.setupTier].bg,
                              letterSpacing: 0.3,
                              textTransform: 'uppercase',
                            }}
                          >
                            {TIER_META[def.setupTier].label} • {TIER_META[def.setupTier].time}
                          </span>
                        )}
                        {def.credentialsUrl && (
                          <>
                            <span style={{ color: 'var(--text3)' }}>
                              Don't have credentials yet?
                            </span>
                            <a
                              href={def.credentialsUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{
                                color: 'var(--ss-blue)',
                                fontWeight: 600,
                                textDecoration: 'none',
                                marginLeft: 'auto',
                              }}
                            >
                              Get from {def.label} →
                            </a>
                          </>
                        )}
                      </div>
                    )}
                    <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'minmax(200px, 1fr) minmax(200px, 1fr)' }}>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span style={{ fontSize: 11, color: 'var(--text3)' }}>Display label</span>
                        <input
                          type="text"
                          value={formLabel}
                          placeholder={`e.g. ${def.label} – primary`}
                          onChange={(e) => setFormLabel(e.target.value)}
                          style={{
                            border: '1px solid var(--border)',
                            borderRadius: 3,
                            padding: '6px 8px',
                            fontSize: 12,
                            background: 'var(--surface2)',
                            color: 'var(--text)',
                          }}
                        />
                      </label>
                      {def.fields.map((f) => (
                        <label key={f.name} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <span style={{ fontSize: 11, color: 'var(--text3)' }}>{f.label}</span>
                          <input
                            type={f.type ?? 'text'}
                            value={formValues[f.name] ?? ''}
                            placeholder={f.placeholder}
                            onChange={(e) => setFormValues((prev) => ({ ...prev, [f.name]: e.target.value }))}
                            style={{
                              border: '1px solid var(--border)',
                              borderRadius: 3,
                              padding: '6px 8px',
                              fontSize: 12,
                              fontFamily: f.type === 'password' ? 'monospace' : 'inherit',
                              background: 'var(--surface2)',
                              color: 'var(--text)',
                            }}
                          />
                          {f.hint ? (
                            <span style={{
                              fontSize: 10.5,
                              color: 'var(--text3)',
                              lineHeight: 1.4,
                              marginTop: 2,
                            }}>
                              {f.hint}
                            </span>
                          ) : null}
                        </label>
                      ))}
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 14, alignItems: 'center' }}>
                      <button
                        type="button"
                        onClick={() => handleAdd(def)}
                        disabled={submitState.kind === 'saving'}
                        style={{
                          padding: '7px 14px',
                          border: 'none',
                          borderRadius: 3,
                          background: 'rgb(var(--brand-rgb, 42 91 215))',
                          color: '#fff',
                          fontSize: 12,
                          fontWeight: 700,
                          cursor: submitState.kind === 'saving' ? 'wait' : 'pointer',
                        }}
                      >
                        {submitState.kind === 'saving' ? 'Saving…' : 'Connect'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setModalOpen(false)
                          setOpenProvider(null)
                        }}
                        style={{
                          padding: '7px 14px',
                          border: '1px solid var(--border)',
                          borderRadius: 3,
                          background: 'var(--surface2)',
                          color: 'var(--text)',
                          fontSize: 12,
                          cursor: 'pointer',
                        }}
                      >
                        Cancel
                      </button>
                      {submitState.kind === 'error' ? (
                        <span style={{ fontSize: 11, color: 'var(--red)' }}>{submitState.message}</span>
                      ) : null}
                    </div>
                  </div>
                )
              })()}
            </div>
          </motion.div>
        </motion.div>
      ) : null}
      </AnimatePresence>

      {submitState.kind === 'success' ? (
        <div style={{
          marginTop: 10,
          fontSize: 11,
          color: 'var(--green)',
          background: 'var(--surface2)',
          border: '1px solid var(--border)',
          borderRadius: 3,
          padding: '6px 8px',
        }}>
          ✅ {submitState.message}
        </div>
      ) : null}
    </div>
  )
}
