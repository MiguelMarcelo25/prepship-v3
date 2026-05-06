// @ts-nocheck
import { useEffect, useState } from 'react'
import { callVercelFunction } from '../../lib/vercelFunction'

// Phase 2 frontend stub. Each provider declares the credential fields its
// "Add integration" form needs. When the backend route POST /carrier-accounts
// goes live (see src/db/schema/carrier-accounts.ts and src/lib/carriers/),
// the form just starts working — no UI changes required.

type ProviderKey =
  | 'simulator'
  | 'shipengine'
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
    key: 'ebay_shipping',
    category: 'carrier',
    noRateQuotes: true,
    label: 'eBay Shipping',
    blurb: 'eBay Sell Fulfillment API for tracking-push. Pushes tracking back to eBay when you ship via UPS / USPS / FedEx so the order flips to Shipped on eBay\'s seller dashboard. Same credentials as the eBay store integration. Note: eBay does not expose rate quotes through this API.',
    badge: 'eBayS',
    badgeColor: '#E53238',
    domain: 'ebay.com',
    simpleIconsSlug: 'ebay',
    fields: [
      { name: 'appId', label: 'App ID (Client ID)', hint: 'Same App ID used for the eBay store integration.' },
      { name: 'certId', label: 'Cert ID (Client Secret)', type: 'password' },
      { name: 'devId', label: 'Dev ID' },
      { name: 'refreshToken', label: 'User OAuth Refresh Token', type: 'password', hint: 'Same long-lived refresh token from the eBay sign-in flow.' },
      { name: 'environment', label: 'Environment (optional)', required: false, placeholder: 'production | sandbox' },
    ],
  },
  {
    key: 'walmart_shipping',
    category: 'carrier',
    noRateQuotes: true,
    label: 'Walmart Shipping',
    blurb: 'Walmart Marketplace shipping for tracking-push back to Walmart after a label is created via UPS / USPS / FedEx. Walmart Marketplace API does NOT expose rate quotes — use real carriers for rate-shopping.',
    badge: 'WMTS',
    badgeColor: '#0071DC',
    domain: 'walmart.com',
    fields: [
      { name: 'clientId', label: 'Client ID', hint: 'Same Client ID used for the Walmart Store integration.' },
      { name: 'clientSecret', label: 'Client Secret', type: 'password' },
      { name: 'partnerId', label: 'Partner ID (Seller ID)', required: false, hint: 'Walmart Seller ID. Required for actually creating labels via Walmart shipping APIs.' },
      { name: 'channelType', label: 'Channel Type (optional)', required: false, placeholder: 'UUID', hint: 'For Solution Provider integrations. Same value as the Store entry.' },
    ],
  },
  {
    key: 'simulator',
    category: 'carrier',
    label: 'Simulator (Demo)',
    blurb: 'Sandbox carrier for testing the add-carrier → verify → fetch-rates flow without real API credentials. Returns synthetic Standard / Priority / Express rates.',
    badge: 'DEMO',
    badgeColor: '#0F766E',
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
    domain: 'shipengine.com',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', placeholder: 'TEST_xxxxxxxx or live_xxxxxxxx' },
    ],
  },
  {
    key: 'ups',
    category: 'carrier',
    label: 'UPS',
    blurb: 'OAuth 2.0 credentials from the UPS Developer Kit. Required for direct UPS Rating, Shipping & Tracking.',
    badge: 'UPS',
    badgeColor: '#5A1F00',
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
    label: 'Amazon Shipping',
    blurb: 'Amazon Buy Shipping API. Purchase shipping labels at Amazon-negotiated rates for Merchant-Fulfilled Network (FBM) orders. Same SP-API credentials as the Amazon Marketplace store integration.',
    badge: 'AMZ',
    badgeColor: '#FF9900',
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
    blurb: 'eBay Sell API. Pull orders, push tracking, manage listings. Save the keyset below, then click "Connect with eBay" on the saved row to grant access — the OAuth flow auto-populates the refresh token.',
    badge: 'eBay',
    badgeColor: '#E53238',
    domain: 'ebay.com',
    simpleIconsSlug: 'ebay',
    fields: [
      { name: 'appId', label: 'App ID (Client ID)', hint: 'Production app ID from developer.ebay.com → My Account → Application Keys.' },
      { name: 'certId', label: 'Cert ID (Client Secret)', type: 'password' },
      { name: 'devId', label: 'Dev ID', hint: 'Your developer account ID; needed for Trading API legacy calls.' },
      { name: 'ruName', label: 'RuName (Redirect URL Name)', hint: 'eBay-issued alias for your callback URL. developer.ebay.com → User Tokens → Get a Token from eBay via Your Application → "Get RuName". The RuName\'s "Auth Accepted URL" must point to <your-domain>/oauth/ebay/callback for Connect with eBay to work.' },
      { name: 'refreshToken', label: 'User OAuth Refresh Token', type: 'password', required: false, hint: 'OPTIONAL — leave blank and use the "Connect with eBay" button on the saved row to obtain this automatically. Manually paste only if you already have a long-lived token from a prior OAuth dance.' },
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
  // Non-secret subset of credentials needed for client-side OAuth init
  // (e.g. constructing the eBay sign-in URL). Returned by the GET endpoint
  // for stores; secrets like certId / refreshToken stay server-side.
  // `hasRefreshToken` is a presence flag (boolean) not the value itself.
  oauthMeta?: {
    appId?: string | null
    clientId?: string | null
    ruName?: string | null
    environment?: string | null
    hasRefreshToken?: boolean
  }
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
  return callVercelFunction<CarrierRatesResult>('/carriers/rates', {
    method: 'POST',
    body: { carrierAccountId, weightOz: 32, toZip: '94601' },
  })
}

export function CarrierIntegrationsCard() {
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

  const runDelete = async (d: SavedRow) => {
    if (!confirm(`Delete the saved integration "${d.label ?? d.accountId}"? This cannot be undone.`)) return
    setDeleting((prev) => ({ ...prev, [d.id]: true }))
    try {
      await deleteIntegration(d.accountId, d.provider)
      setSaved((prev) => prev.filter((r) => r.id !== d.id))
      setTestResults((prev) => { const next = { ...prev }; delete next[d.id]; return next })
      setRateResults((prev) => { const next = { ...prev }; delete next[d.id]; return next })
      setPullResults((prev) => { const next = { ...prev }; delete next[d.id]; return next })
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

  // Opens eBay's OAuth consent screen in a new tab. eBay redirects back to
  // /oauth/ebay/callback (handled by api/oauth/ebay/callback.ts), which
  // exchanges the auth code for a refresh_token and writes it into this
  // store_accounts row's credentials JSONB. After the new tab closes,
  // the user clicks "Test Connection" to confirm everything is wired.
  //
  // eBay quirk: the `redirect_uri` parameter on the authorize URL must be
  // the RuName ALIAS (e.g. "DrPrepperUSA-Prepship-PRD-…"), NOT the actual
  // callback URL. The actual URL is configured server-side in eBay's
  // developer console as the RuName's "Auth Accepted URL". Token exchange
  // (in the callback handler) uses the actual URL — they don't match,
  // by design.
  const connectEbay = (d: SavedRow) => {
    const meta = d.oauthMeta ?? {}
    const appId = String(meta.appId ?? '').trim()
    const ruName = String(meta.ruName ?? '').trim()
    const environment = String(meta.environment ?? '').toLowerCase()
    if (!appId) {
      alert(
        'This eBay row is missing the App ID.\n\n' +
        'Click Delete on this row, then re-add it making sure all fields are filled in.',
      )
      return
    }
    if (!ruName) {
      alert(
        'This eBay row is missing the RuName.\n\n' +
        'Get a RuName from developer.ebay.com → User Tokens → Get a Token from eBay via Your Application,\n' +
        'set its "Auth Accepted URL" to ' + window.location.origin + '/oauth/ebay/callback,\n' +
        'then Delete this row and re-add it with the RuName filled in.',
      )
      return
    }
    const isSandbox = environment === 'sandbox'
    const authBase = isSandbox
      ? 'https://auth.sandbox.ebay.com/oauth2/authorize'
      : 'https://auth.ebay.com/oauth2/authorize'
    // Scopes for Sell Fulfillment (orders) + Sell Account (store info).
    // Same scopes the api/carriers/ebay/orders.ts puller needs.
    const scopes = [
      'https://api.ebay.com/oauth/api_scope',
      'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
      'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
      'https://api.ebay.com/oauth/api_scope/sell.account',
      'https://api.ebay.com/oauth/api_scope/sell.account.readonly',
    ].join(' ')
    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: ruName,
      response_type: 'code',
      scope: scopes,
      state: String(d.accountId),
    })
    const authUrl = `${authBase}?${params.toString()}`
    window.open(authUrl, '_blank', 'noopener,noreferrer')
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
      }))
      const stores: SavedRow[] = (storesRes?.data ?? []).map((r) => ({
        ...r,
        accountId: r.id,
        id: r.id + STORE_DISPLAY_OFFSET,
        kind: 'store' as const,
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
  const renderSavedRow = (d: SavedRow) => {
    const result = testResults[d.id]
    const isTesting = !!testing[d.id]
    const isStore = STORE_PROVIDERS.has(d.provider)
    return (
      <li
        key={d.id}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          padding: '8px 10px',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          marginBottom: 4,
          fontSize: 12,
        }}
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontWeight: 700 }}>{d.provider.toUpperCase()}</span>
          <span style={{ color: 'var(--text2)' }}>{d.label ?? '—'}</span>
          <span style={{ flex: 1, color: 'var(--text3)', fontFamily: 'monospace', fontSize: 11 }}>
            {d.accountIdentifier ?? '—'}
          </span>
          <span style={{ fontSize: 10, color: 'var(--text3)' }}>{new Date(d.createdAt).toLocaleDateString()}</span>
          <button
            type="button"
            onClick={() => runTest(d)}
            disabled={isTesting}
            style={{
              padding: '3px 10px',
              border: '1px solid var(--border)',
              borderRadius: 3,
              background: 'var(--surface2)',
              color: 'var(--text)',
              fontSize: 11,
              fontWeight: 600,
              cursor: isTesting ? 'wait' : 'pointer',
            }}
          >
            {isTesting ? 'Testing…' : 'Test Connection'}
          </button>
          {isStore && STORE_PULLERS[d.provider] ? (
            <button
              type="button"
              onClick={() => runPullOrders(d)}
              disabled={!!pulling[d.id]}
              title={`Pull recent ${d.provider} orders`}
              style={{
                padding: '3px 10px',
                border: '1px solid var(--border)',
                borderRadius: 3,
                background: 'var(--surface2)',
                color: 'var(--text)',
                fontSize: 11,
                fontWeight: 600,
                cursor: pulling[d.id] ? 'wait' : 'pointer',
              }}
            >
              {pulling[d.id] ? 'Pulling…' : 'Pull Orders'}
            </button>
          ) : null}
          {/* Connect with eBay — opens the eBay OAuth consent screen so the
              user can grant access without manually pasting a refresh token.
              The /oauth/ebay/callback Vercel function completes the exchange
              and writes the refresh_token into this row's credentials. */}
          {d.provider === 'ebay' ? (
            <button
              type="button"
              onClick={() => connectEbay(d)}
              title={
                d.oauthMeta?.hasRefreshToken
                  ? 'Re-connect — replace the saved refresh token by signing in to eBay again'
                  : 'Connect — sign in to eBay to grant PrepShip access (auto-saves the refresh token)'
              }
              style={{
                padding: '3px 10px',
                border: '1px solid #E53238',
                borderRadius: 3,
                background: d.oauthMeta?.hasRefreshToken ? 'var(--surface2)' : '#E53238',
                color: d.oauthMeta?.hasRefreshToken ? '#E53238' : '#fff',
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {d.oauthMeta?.hasRefreshToken ? '↻ Re-connect eBay' : '🔗 Connect with eBay'}
            </button>
          ) : null}
          {!isStore && !PROVIDER_DEFS.find((p) => p.key === d.provider)?.noRateQuotes ? (
            <button
              type="button"
              onClick={() => runFetchRates(d)}
              disabled={!!rating[d.id]}
              title="Fetch a sample shipping rate for this carrier"
              style={{
                padding: '3px 10px',
                border: '1px solid var(--border)',
                borderRadius: 3,
                background: 'var(--surface2)',
                color: 'var(--text)',
                fontSize: 11,
                fontWeight: 600,
                cursor: rating[d.id] ? 'wait' : 'pointer',
              }}
            >
              {rating[d.id] ? 'Fetching…' : 'Get Rates'}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => runDelete(d)}
            disabled={!!deleting[d.id]}
            title="Delete integration"
            style={{
              padding: '3px 10px',
              border: '1px solid var(--border)',
              borderRadius: 3,
              background: 'var(--surface2)',
              color: 'var(--red)',
              fontSize: 11,
              fontWeight: 600,
              cursor: deleting[d.id] ? 'wait' : 'pointer',
            }}
          >
            {deleting[d.id] ? 'Deleting…' : 'Delete'}
          </button>
        </div>
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
              if (!r.ok) return `❌ ${r.error ?? 'Rate fetch failed'}`
              const tag = r.simulated ? '🧪 Simulated' : '💰 Live'
              const ratesText = (r.rates ?? [])
                .map((rt) => `${rt.service} $${rt.cost.toFixed(2)} (${rt.days}d)`)
                .join(' · ')
              return `${tag} rates for 2 lb to 94601: ${ratesText || '(none)'}`
            })()}
          </div>
        ) : null}
      </li>
    )
  }

  // Section header + add button used for both Stores and Carriers. Centralized
  // here so styling stays consistent and we only have one button definition.
  const renderSectionHeader = (
    icon: string,
    title: string,
    blurb: string,
    addLabel: string,
    category: ProviderCategory,
  ) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <div>
        <h3 style={{ margin: 0 }}>{icon} {title}</h3>
        <p style={{ fontSize: 11.5, color: 'var(--text3)', margin: '4px 0 0' }}>{blurb}</p>
      </div>
      <button
        type="button"
        onClick={() => openAddModal(category)}
        style={{
          padding: '7px 14px',
          border: 'none',
          borderRadius: 4,
          background: 'var(--green)',
          color: '#fff',
          fontSize: 12,
          fontWeight: 700,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        {addLabel}
      </button>
    </div>
  )

  return (
    <div className="markup-card" style={{ marginTop: 16 }}>
      {/* ── Stores: marketplace order sources (Walmart, Amazon) ──────────── */}
      {renderSectionHeader(
        '🏪',
        'Your Stores',
        'Marketplace order sources. Use these to pull orders into PrepShip and push tracking back. Stores do not return shipping rates.',
        '+ Add Store',
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

      {/* ── Carriers: actual shipping carriers (UPS, USPS, FedEx, …) ─────── */}
      {renderSectionHeader(
        '🚚',
        'Your Carriers',
        'Direct shipping carriers — used for rate shopping and label purchase. These appear in the Rate Browser sidebar.',
        '+ Add Carrier',
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


      {modalOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setModalOpen(false)
              setOpenProvider(null)
            }
          }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <div style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            width: '100%',
            maxWidth: 760,
            maxHeight: '88vh',
            overflow: 'auto',
            boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
          }}>
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
                    {PROVIDER_DEFS.filter((p) => addCategory == null || p.category === addCategory).map((p) => (
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
                        <ProviderLogo provider={p} size={64} />
                        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', textAlign: 'center' }}>
                          {p.label}
                        </div>
                      </button>
                    ))}
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
                          background: 'var(--green)',
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
          </div>
        </div>
      ) : null}

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
