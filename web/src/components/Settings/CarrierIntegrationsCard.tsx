// @ts-nocheck
import { useEffect, useState } from 'react'
import { callVercelFunction } from '../../lib/vercelFunction'
import { api } from '../../lib/api'

// Phase 2 frontend stub. Each provider declares the credential fields its
// "Add integration" form needs. When the backend route POST /carrier-accounts
// goes live (see src/db/schema/carrier-accounts.ts and src/lib/carriers/),
// the form just starts working — no UI changes required.

type ProviderKey =
  | 'shipengine'
  | 'ups'
  | 'usps'
  | 'fedex'
  | 'dhl_express'
  | 'amazon_shipping'
  | 'walmart'
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
}

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
    key: 'shipengine',
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
    label: 'Amazon Shipping',
    blurb: 'Amazon Buy Shipping via SP-API for FBA/MCF orders. Requires LWA OAuth.',
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
    key: 'seko',
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
  id: number
  clientId: number | null
  provider: string
  label: string | null
  accountIdentifier: string | null
  source: string
  active: boolean
  createdAt: string
}

async function postIntegration(body: Record<string, unknown>): Promise<SavedRow | null> {
  const json = await api.post<{ data: SavedRow | null }>('/carrier-accounts', body)
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

async function verifyConnection(carrierAccountId: number): Promise<VerifyResult> {
  return api.post<VerifyResult>('/carriers/verify', { carrierAccountId })
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

  const runTest = async (rowId: number) => {
    setTesting((prev) => ({ ...prev, [rowId]: true }))
    try {
      const result = await verifyConnection(rowId)
      setTestResults((prev) => ({ ...prev, [rowId]: result }))
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [rowId]: { ok: false, error: err instanceof Error ? err.message : String(err) },
      }))
    } finally {
      setTesting((prev) => ({ ...prev, [rowId]: false }))
    }
  }

  const refresh = async () => {
    try {
      const res = await callVercelFunction<{ data: SavedRow[] }>('/carrier-accounts?source=admin')
      setSaved(Array.isArray(res?.data) ? res.data : [])
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
      })
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

  return (
    <div className="markup-card" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <h3 style={{ margin: 0 }}>🔌 Your Carrier Accounts</h3>
          <p style={{ fontSize: 11.5, color: 'var(--text3)', margin: '4px 0 0' }}>
            Direct carrier integrations — independent of ShipStation. Each appears as its own group in the markup table above.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setModalOpen(true)
            setOpenProvider(null)
            setFormValues({})
            setFormLabel('')
            setSubmitState({ kind: 'idle' })
          }}
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
          + Add Carrier
        </button>
      </div>
      <div style={{ height: 12 }} />
      {/* Only surface the error banner when there are existing rows that might
          have been cut off by the failure. If the list is empty, the empty
          state below is sufficient signal — a red banner on a clean slate
          adds noise. */}
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

      {saved.length > 0 ? (
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 12px' }}>
          {saved.map((d) => {
            const result = testResults[d.id]
            const isTesting = !!testing[d.id]
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
                    onClick={() => runTest(d.id)}
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
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}

      {saved.length === 0 && !modalOpen ? (
        <div style={{
          fontSize: 12,
          color: 'var(--text3)',
          background: 'var(--surface)',
          border: '1px dashed var(--border2)',
          borderRadius: 4,
          padding: '12px',
          textAlign: 'center',
        }}>
          No direct carrier integrations yet. Click <b>Add Carrier</b> to connect one.
        </div>
      ) : null}

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
                {openProvider ? `Connect ${PROVIDER_DEFS.find((p) => p.key === openProvider)?.label}` : 'Connect a Shipping Provider'}
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
                    Click a tile to add credentials for that carrier.
                  </p>
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                    gap: 12,
                  }}>
                    {PROVIDER_DEFS.map((p) => (
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
