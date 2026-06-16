/**
 * NewOrderModal — manual-order creation surface for PrepShip.
 *
 * UX contract
 * ───────────
 * Two-pane layout (left = recipient address, right = order metadata)
 * with a third row at the bottom for line-items. Inspired by
 * ShipStation's New Order modal but reskinned to PrepShip's existing
 * surface vocabulary (brand-blue gradients, soft shadows, slate ink,
 * rounded card sections).
 *
 * Differentiator vs ShipStation:
 *   • An inline "Rate preview" section that calls /rates as soon as
 *     the operator has entered weight + dest ZIP, so they can see
 *     carrier options BEFORE saving the order. Beats ShipStation's
 *     separate Rate Browser that requires saving first.
 *   • Sticky bottom action bar (Cancel / Save Order + Get Rates)
 *     stays in view while the operator scrolls through long line
 *     items.
 *   • PrepShip-style focus rings + soft brand-bg gradients.
 *
 * Wire-up status:
 *   • Save handler posts to /orders/manual and creates a local awaiting
 *     shipment order under the Manual Orders sandbox client.
 *   • Rate preview calls existing apiClient.fetchRates which DOES
 *     work; this section is fully live.
 */

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  X as XIcon,
  User,
  MapPin,
  Phone,
  Mail,
  Building2,
  ShoppingBag,
  Calendar,
  Hash,
  DollarSign,
  Package,
  Plus,
  Trash2,
  Sparkles,
  Truck,
  Search as SearchIcon,
  Check as CheckIcon,
} from 'lucide-react'
// Shared carrier badge (renders official UPS/USPS SVG logos plus
// fallback pills for other carriers). Single source of truth so this
// modal, OrdersView, RateBrowserModal, and RatesView all show
// identical carrier marks.
import CarrierBadge from './CarrierBadge'

interface LineItem {
  id: string
  sku: string
  name: string
  quantity: string
  price: string
}

interface RatePreviewRow {
  carrierCode: string
  serviceCode: string
  serviceLabel: string
  cost: number
}

interface NewOrderModalProps {
  open: boolean
  onClose: () => void
  /**
   * Called when the operator clicks Save. Returns truthy = success
   * (modal closes), falsy = error (modal stays open). The caller is
   * responsible for the actual API call and the toast.
   */
  onSave: (payload: NewOrderPayload) => Promise<boolean> | boolean
  /** Optional pre-fill — e.g. when duplicating an existing order. */
  initial?: Partial<NewOrderPayload>
  /** Pre-fill the From ZIP if known; defaults to a sensible US ZIP. */
  defaultFromZip?: string
  /** Saved locations from Settings > Ship-From Locations, used as recipient address templates. */
  locations?: Array<Record<string, any>>
}

export interface NewOrderPayload {
  // Recipient
  shipToName: string
  shipToCompany: string
  shipToCountry: string
  shipToAddress1: string
  shipToAddress2: string
  shipToAddress3: string
  shipToCity: string
  shipToState: string
  shipToPostalCode: string
  shipToPhone: string
  customerEmail: string
  // Order summary
  orderNumber: string
  orderNumberAuto: boolean
  orderDate: string
  paidDate: string
  shippingPaid: string
  taxPaid: string
  totalPaid: string
  rateWeightLb: string
  rateWeightOz: string
  rateLength: string
  rateWidth: string
  rateHeight: string
  // Line items
  items: Array<{ sku: string; name: string; quantity: number; price: number }>
}

function newLineItem(): LineItem {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sku: '',
    name: '',
    quantity: '1',
    price: '',
  }
}

const fieldCls =
  'w-full h-9 px-3 rounded-lg ring-1 ring-line bg-surface text-[13px] text-ink ' +
  'placeholder:text-ink-3 focus:ring-2 focus:ring-brand/40 focus:bg-surface ' +
  'transition-all duration-150 outline-none'

// Carrier logo components — inline SVG approximations of the
// official UPS and USPS marks, sized for the rate-preview row's
// 22px-tall badge slot. Drawn as SVG so they scale crisply at any
// zoom/density and can be themed without relying on external image
// hosts (no marketplace-CDN expiry, no referrer policy headaches).

const labelCls = 'flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.08em] text-ink-3 mb-1'
const sectionTitleCls =
  'flex items-center gap-2 text-[12px] font-extrabold uppercase tracking-[0.06em] text-ink-2'

function todayIsoDate() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC','PR',
]

export default function NewOrderModal({
  open,
  onClose,
  onSave,
  initial,
  defaultFromZip = '90248',
  locations = [],
}: NewOrderModalProps) {
  // Form state — flat for simplicity. Sub-objects would be cleaner but
  // every field is a string anyway and a flat shape is trivial to spread
  // into the API payload at submit time.
  const today = todayIsoDate()
  const [name, setName] = useState(initial?.shipToName ?? '')
  const [company, setCompany] = useState(initial?.shipToCompany ?? '')
  const [country, setCountry] = useState(initial?.shipToCountry ?? 'US')
  const [address1, setAddress1] = useState(initial?.shipToAddress1 ?? '')
  const [address2, setAddress2] = useState(initial?.shipToAddress2 ?? '')
  const [address3, setAddress3] = useState(initial?.shipToAddress3 ?? '')
  const [city, setCity] = useState(initial?.shipToCity ?? '')
  const [state, setState] = useState(initial?.shipToState ?? '')
  const [zip, setZip] = useState(initial?.shipToPostalCode ?? '')
  const [phone, setPhone] = useState(initial?.shipToPhone ?? '')
  const [email, setEmail] = useState(initial?.customerEmail ?? '')
  const [locationQuery, setLocationQuery] = useState('')
  const [locationPickerOpen, setLocationPickerOpen] = useState(false)
  const [selectedLocationId, setSelectedLocationId] = useState<string>('')

  const [orderNumber, setOrderNumber] = useState(initial?.orderNumber ?? '')
  const [orderNumberAuto, setOrderNumberAuto] = useState(initial?.orderNumberAuto ?? true)
  const [orderDate, setOrderDate] = useState(initial?.orderDate ?? today)
  const [paidDate, setPaidDate] = useState(initial?.paidDate ?? today)
  const [shippingPaid, setShippingPaid] = useState(initial?.shippingPaid ?? '')
  const [taxPaid, setTaxPaid] = useState(initial?.taxPaid ?? '')
  const [totalPaid, setTotalPaid] = useState(initial?.totalPaid ?? '')

  const [items, setItems] = useState<LineItem[]>(() => [newLineItem()])

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Rate preview state — separate from save flow so operators can
  // explore rates iteratively (try different weights) without
  // accidentally saving a half-filled order.
  const [rateWeightLb, setRateWeightLb] = useState('1')
  const [rateWeightOz, setRateWeightOz] = useState('0')
  const [rateLength, setRateLength] = useState('12')
  const [rateWidth, setRateWidth] = useState('9')
  const [rateHeight, setRateHeight] = useState('4')
  const [ratesLoading, setRatesLoading] = useState(false)
  const [ratesError, setRatesError] = useState<string | null>(null)
  const [rates, setRates] = useState<RatePreviewRow[] | null>(null)

  // Reset form when modal opens fresh (not re-pre-filled)
  useEffect(() => {
    if (!open) {
      setError(null)
      setRates(null)
      setRatesError(null)
    }
  }, [open])

  // Auto-fill total from line-items when total field is blank — gentle
  // helper so the operator doesn't have to do the addition manually.
  // Once they type a value, we stop overwriting it.
  const computedItemsTotal = useMemo(() => {
    return items.reduce((sum, it) => {
      const qty = Number.parseFloat(it.quantity) || 0
      const price = Number.parseFloat(it.price) || 0
      return sum + qty * price
    }, 0)
  }, [items])

  const locationOptions = useMemo(() => {
    const query = locationQuery.trim().toLowerCase()
    const activeLocations = (Array.isArray(locations) ? locations : []).filter((location) => location?.active !== false)

    const scored = activeLocations
      .map((location) => {
        const searchable = [
          location.name,
          location.company,
          location.street1,
          location.street2,
          location.city,
          location.state,
          location.postalCode,
          location.country,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        const matches = !query || searchable.includes(query)
        return { location, matches }
      })
      .filter((entry) => entry.matches)
      .map((entry) => entry.location)

    return scored.slice(0, 8)
  }, [locationQuery, locations])

  function formatLocationLine(location: Record<string, any>) {
    return [location.street1, location.city, location.state, location.postalCode]
      .filter(Boolean)
      .join(', ')
  }

  function applyRecipientLocation(location: Record<string, any>) {
    const id = String(location.locationId ?? location.id ?? '')
    setSelectedLocationId(id)
    setLocationQuery(location.name ?? location.company ?? formatLocationLine(location))

    setName((current) => current || location.name || location.company || '')
    setCompany(location.company ?? location.name ?? '')
    setCountry(location.country ?? 'US')
    setAddress1(location.street1 ?? '')
    setAddress2(location.street2 ?? '')
    setAddress3('')
    setCity(location.city ?? '')
    setState(location.state ?? '')
    setZip(location.postalCode ?? '')
    setPhone(location.phone ?? '')
    setLocationPickerOpen(false)
  }

  // ESC closes the modal — standard modal contract.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose, saving])

  function pasteUSAddress() {
    // Paste-helper: parses clipboard text into address fields. Common
    // CSR workflow ('paste this address from the email') — saves four
    // separate paste actions.
    void navigator.clipboard.readText().then((txt) => {
      if (!txt) return
      const lines = txt
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
      // Heuristic: 3-4 lines. First = name, middle = address, last = city/state/zip
      if (lines.length >= 3) {
        const last = lines[lines.length - 1]!
        const m = last.match(/^(.+?),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/)
        if (m) {
          setCity(m[1]!)
          setState(m[2]!)
          setZip(m[3]!)
          setName(lines[0] ?? '')
          setAddress1(lines[1] ?? '')
          if (lines.length === 4) setAddress2(lines[2] ?? '')
        }
      }
    })
  }

  function addItem() {
    setItems((current) => [...current, newLineItem()])
  }

  function removeItem(id: string) {
    setItems((current) => (current.length === 1 ? current : current.filter((i) => i.id !== id)))
  }

  function updateItem(id: string, patch: Partial<LineItem>) {
    setItems((current) => current.map((i) => (i.id === id ? { ...i, ...patch } : i)))
  }

  async function handleGetRates() {
    if (!zip.trim()) {
      setRatesError('Enter a destination ZIP first')
      return
    }
    const totalOz =
      (Number.parseFloat(rateWeightLb) || 0) * 16 + (Number.parseFloat(rateWeightOz) || 0)
    if (totalOz <= 0) {
      setRatesError('Enter a non-zero weight')
      return
    }
    setRatesError(null)
    setRatesLoading(true)
    setRates(null)
    try {
      const { apiClient } = await import('../api/client')
      const payload = {
        fromPostalCode: defaultFromZip,
        toPostalCode: zip.trim(),
        toCountry: country || 'US',
        weight: { value: totalOz, units: 'ounces' },
        dimensions: {
          units: 'inches',
          length: Number.parseFloat(rateLength) || 0,
          width: Number.parseFloat(rateWidth) || 0,
          height: Number.parseFloat(rateHeight) || 0,
        },
      }
      const result = await apiClient.fetchRates(payload)
      const rows: RatePreviewRow[] = (Array.isArray(result) ? result : [])
        .map((r: any) => ({
          carrierCode: r.carrierCode ?? '',
          serviceCode: r.serviceCode ?? '',
          serviceLabel: r.serviceName ?? r.serviceLabel ?? r.serviceCode ?? '',
          cost: Number(r.shipmentCost ?? 0) + Number(r.otherCost ?? 0),
        }))
        .sort((a, b) => a.cost - b.cost)
        .slice(0, 8) // Show top 8 cheapest — ShipStation overwhelms with 30+
      setRates(rows)
    } catch (err) {
      setRatesError(err instanceof Error ? err.message : 'Could not fetch rates')
    } finally {
      setRatesLoading(false)
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) return

    // Minimal validation — required fields per ShipStation parity.
    const errors: string[] = []
    if (!name.trim()) errors.push('Name')
    if (!address1.trim()) errors.push('Address')
    if (!city.trim()) errors.push('City')
    if (!state) errors.push('State')
    if (!zip.trim()) errors.push('Zip')
    if (items.every((i) => !i.sku.trim() && !i.name.trim())) errors.push('At least one line item')

    if (errors.length > 0) {
      setError(`Required: ${errors.join(', ')}`)
      return
    }

    setError(null)
    setSaving(true)
    try {
      const payload: NewOrderPayload = {
        shipToName: name.trim(),
        shipToCompany: company.trim(),
        shipToCountry: country.trim() || 'US',
        shipToAddress1: address1.trim(),
        shipToAddress2: address2.trim(),
        shipToAddress3: address3.trim(),
        shipToCity: city.trim(),
        shipToState: state,
        shipToPostalCode: zip.trim(),
        shipToPhone: phone.trim(),
        customerEmail: email.trim(),
        orderNumber: orderNumberAuto ? '' : orderNumber.trim(),
        orderNumberAuto,
        orderDate,
        paidDate,
        shippingPaid: shippingPaid.trim(),
        taxPaid: taxPaid.trim(),
        totalPaid: totalPaid.trim() || computedItemsTotal.toFixed(2),
        rateWeightLb: rateWeightLb.trim(),
        rateWeightOz: rateWeightOz.trim(),
        rateLength: rateLength.trim(),
        rateWidth: rateWidth.trim(),
        rateHeight: rateHeight.trim(),
        items: items
          .filter((i) => i.sku.trim() || i.name.trim())
          .map((i) => ({
            sku: i.sku.trim(),
            name: i.name.trim(),
            quantity: Number.parseFloat(i.quantity) || 1,
            price: Number.parseFloat(i.price) || 0,
          })),
      }
      const ok = await onSave(payload)
      if (ok) {
        // Modal will close from the outside (parent sets open=false).
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[1000] flex items-center justify-center p-4 bg-ink/40 backdrop-blur-sm"
          onClick={() => !saving && onClose()}
          role="dialog"
          aria-modal="true"
          aria-label="New manual order"
        >
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 380, damping: 30 }}
            className="w-full max-w-[1100px] max-h-[92vh] flex flex-col bg-surface rounded-2xl shadow-2xl ring-1 ring-line overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header — gradient strip with title and close. The
                gradient (brand → indigo) is the same blue used on
                topbar Print Labels pill, so the modal feels native to
                PrepShip rather than a cookie-cutter form sheet. */}
            <header
              className="relative px-5 py-4 flex items-center gap-3 border-b border-line"
              style={{
                background:
                  'linear-gradient(135deg, rgb(var(--brand-rgb, 42 91 215) / 0.06), rgb(var(--brand-rgb, 42 91 215) / 0.02))',
              }}
            >
              <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-brand to-indigo-600 flex items-center justify-center shadow-md ring-1 ring-brand/20">
                <Sparkles size={16} strokeWidth={2.5} className="text-white" />
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="text-[16px] font-extrabold text-ink font-display tracking-tight m-0">
                  New Manual Order
                </h2>
                <p className="text-[11.5px] text-ink-3 mt-0.5">
                  Goes into the Manual Orders client. Get live rates without saving via the preview below.
                </p>
              </div>
              <button
                type="button"
                onClick={() => !saving && onClose()}
                disabled={saving}
                className="w-8 h-8 rounded-md flex items-center justify-center text-ink-3 hover:text-ink hover:bg-surface-2 transition disabled:opacity-50"
                aria-label="Close"
              >
                <XIcon size={16} strokeWidth={2.5} />
              </button>
            </header>

            <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto">
              <div className="p-5 grid grid-cols-1 lg:grid-cols-[1.3fr_1fr] gap-5">
                {/* ─────── LEFT: Recipient ─────── */}
                <section className="flex flex-col gap-4">
                  <div className="flex items-center justify-between">
                    <h3 className={sectionTitleCls}>
                      <User size={13} strokeWidth={2.5} className="text-brand" />
                      Recipient
                    </h3>
                    <button
                      type="button"
                      onClick={pasteUSAddress}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10.5px] font-semibold text-brand bg-brand-bg hover:bg-brand/10 transition ring-1 ring-brand-border"
                    >
                      📋 Paste US Address
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="col-span-2">
                      <label className={labelCls}>
                        <MapPin size={10} strokeWidth={2.5} /> Saved Location
                      </label>
                      <div className="relative">
                        <input
                          className={fieldCls}
                          value={locationQuery}
                          onChange={(e) => {
                            setLocationQuery(e.target.value)
                            setSelectedLocationId('')
                            setLocationPickerOpen(true)
                          }}
                          onFocus={() => setLocationPickerOpen(true)}
                          onBlur={() => window.setTimeout(() => setLocationPickerOpen(false), 120)}
                          placeholder={locations.length ? 'Search saved locations...' : 'No saved locations loaded yet'}
                          disabled={locations.length === 0}
                        />
                        {selectedLocationId ? (
                          <button
                            type="button"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => {
                              setSelectedLocationId('')
                              setLocationQuery('')
                            }}
                            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-1.5 py-0.5 text-[10px] font-bold text-ink-3 hover:bg-surface-2 hover:text-ink"
                            aria-label="Clear saved location"
                          >
                            Clear
                          </button>
                        ) : null}
                        {locationPickerOpen && locationOptions.length > 0 ? (
                          <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-20 max-h-56 overflow-y-auto rounded-lg border border-line bg-surface shadow-xl">
                            {locationOptions.map((location) => {
                              const id = String(location.locationId ?? location.id ?? location.name)
                              return (
                                <button
                                  key={id}
                                  type="button"
                                  onMouseDown={(event) => event.preventDefault()}
                                  onClick={() => applyRecipientLocation(location)}
                                  className="w-full px-3 py-2 text-left hover:bg-brand-bg/70 focus:bg-brand-bg/70 focus:outline-none"
                                >
                                  <div className="flex items-center justify-between gap-3">
                                    <span className="truncate text-[12px] font-bold text-ink">
                                      {location.name ?? location.company ?? 'Saved location'}
                                    </span>
                                    {location.isDefault ? (
                                      <span className="shrink-0 rounded-full bg-brand-bg px-1.5 py-0.5 text-[9px] font-extrabold uppercase text-brand ring-1 ring-brand-border">
                                        Default
                                      </span>
                                    ) : null}
                                  </div>
                                  <div className="mt-0.5 truncate text-[11px] text-ink-3">
                                    {formatLocationLine(location) || location.company || 'No address saved'}
                                  </div>
                                </button>
                              )
                            })}
                          </div>
                        ) : locationPickerOpen && locationQuery.trim() && locations.length > 0 ? (
                          <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-20 rounded-lg border border-line bg-surface px-3 py-2 text-[11px] text-ink-3 shadow-xl">
                            No matching locations.
                          </div>
                        ) : null}
                      </div>
                      <p className="mt-1 text-[10px] text-ink-3">
                        Pick a saved location to fill the recipient address fields.
                      </p>
                    </div>
                    <div className="col-span-2">
                      <label className={labelCls}>
                        <User size={10} strokeWidth={2.5} /> Name <span className="text-danger">*</span>
                      </label>
                      <input className={fieldCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Recipient name" />
                    </div>
                    <div className="col-span-2">
                      <label className={labelCls}>
                        <Building2 size={10} strokeWidth={2.5} /> Company
                      </label>
                      <input className={fieldCls} value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Optional" />
                    </div>
                    <div className="col-span-2">
                      <label className={labelCls}>
                        <MapPin size={10} strokeWidth={2.5} /> Country
                      </label>
                      <select className={fieldCls} value={country} onChange={(e) => setCountry(e.target.value)}>
                        <option value="US">United States</option>
                        <option value="CA">Canada</option>
                        <option value="MX">Mexico</option>
                        <option value="GB">United Kingdom</option>
                        <option value="AU">Australia</option>
                      </select>
                    </div>
                    <div className="col-span-2">
                      <label className={labelCls}>
                        <MapPin size={10} strokeWidth={2.5} /> Address <span className="text-danger">*</span>
                      </label>
                      <div className="space-y-2">
                        <input className={fieldCls} value={address1} onChange={(e) => setAddress1(e.target.value)} placeholder="Address Line 1" />
                        <input className={fieldCls} value={address2} onChange={(e) => setAddress2(e.target.value)} placeholder="Address Line 2 (optional)" />
                        <input className={fieldCls} value={address3} onChange={(e) => setAddress3(e.target.value)} placeholder="Address Line 3 (optional)" />
                      </div>
                    </div>
                    <div>
                      <label className={labelCls}>
                        City <span className="text-danger">*</span>
                      </label>
                      <input className={fieldCls} value={city} onChange={(e) => setCity(e.target.value)} placeholder="City" />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className={labelCls}>
                          State <span className="text-danger">*</span>
                        </label>
                        <select className={fieldCls} value={state} onChange={(e) => setState(e.target.value)}>
                          <option value="">—</option>
                          {US_STATES.map((s) => (
                            <option key={s} value={s}>{s}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className={labelCls}>
                          Zip <span className="text-danger">*</span>
                        </label>
                        <input className={fieldCls} value={zip} onChange={(e) => setZip(e.target.value)} placeholder="ZIP" inputMode="numeric" />
                      </div>
                    </div>
                    <div>
                      <label className={labelCls}>
                        <Phone size={10} strokeWidth={2.5} /> Phone
                      </label>
                      <input className={fieldCls} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Optional" />
                    </div>
                    <div>
                      <label className={labelCls}>
                        <Mail size={10} strokeWidth={2.5} /> Email
                      </label>
                      <input className={fieldCls} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="customer@example.com" />
                    </div>
                  </div>
                </section>

                {/* ─────── RIGHT: Order summary + Rate preview ─────── */}
                <section className="flex flex-col gap-4">
                  <h3 className={sectionTitleCls}>
                    <ShoppingBag size={13} strokeWidth={2.5} className="text-brand" />
                    Order Summary
                  </h3>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="col-span-2">
                      <label className={labelCls}>
                        <Building2 size={10} strokeWidth={2.5} /> Store
                      </label>
                      <div className={fieldCls + ' flex items-center text-ink-3'} aria-readonly>
                        Manual Orders
                      </div>
                    </div>
                    <div className="col-span-2">
                      <label className={labelCls}>
                        <Hash size={10} strokeWidth={2.5} /> Order #
                      </label>
                      <div className="flex gap-2">
                        <input
                          className={fieldCls + (orderNumberAuto ? ' opacity-50 pointer-events-none' : '')}
                          value={orderNumberAuto ? '' : orderNumber}
                          onChange={(e) => setOrderNumber(e.target.value)}
                          placeholder={orderNumberAuto ? 'Order # will be autogenerated' : 'e.g. MAN-2026-001'}
                          disabled={orderNumberAuto}
                        />
                      </div>
                      <label className="inline-flex items-center gap-2 mt-1.5 text-[11px] text-ink-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={orderNumberAuto}
                          onChange={(e) => setOrderNumberAuto(e.target.checked)}
                          className="w-3.5 h-3.5 accent-brand"
                        />
                        Autogenerate Order #
                      </label>
                    </div>
                    <div>
                      <label className={labelCls}>
                        <Calendar size={10} strokeWidth={2.5} /> Order Date
                      </label>
                      <input type="date" className={fieldCls} value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
                    </div>
                    <div>
                      <label className={labelCls}>
                        <Calendar size={10} strokeWidth={2.5} /> Paid Date
                      </label>
                      <input type="date" className={fieldCls} value={paidDate} onChange={(e) => setPaidDate(e.target.value)} />
                    </div>
                    <div>
                      <label className={labelCls}>
                        <DollarSign size={10} strokeWidth={2.5} /> Shipping Paid
                      </label>
                      <input className={fieldCls} value={shippingPaid} onChange={(e) => setShippingPaid(e.target.value)} placeholder="$" inputMode="decimal" />
                    </div>
                    <div>
                      <label className={labelCls}>
                        <DollarSign size={10} strokeWidth={2.5} /> Tax Paid
                      </label>
                      <input className={fieldCls} value={taxPaid} onChange={(e) => setTaxPaid(e.target.value)} placeholder="$" inputMode="decimal" />
                    </div>
                    <div className="col-span-2">
                      <label className={labelCls}>
                        <DollarSign size={10} strokeWidth={2.5} /> Total Paid
                      </label>
                      <input
                        className={fieldCls}
                        value={totalPaid}
                        onChange={(e) => setTotalPaid(e.target.value)}
                        placeholder={`$${computedItemsTotal.toFixed(2)} (auto)`}
                        inputMode="decimal"
                      />
                      <p className="text-[10px] text-ink-3 mt-1">
                        Leave blank to auto-fill from line-item subtotals.
                      </p>
                    </div>
                  </div>

                  {/* ─── Rate Preview (PrepShip differentiator) ─── */}
                  <div className="mt-1 rounded-xl ring-1 ring-line bg-gradient-to-br from-brand-bg/40 to-transparent p-4">
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="flex items-center gap-2 text-[12px] font-extrabold uppercase tracking-[0.06em] text-ink-2">
                        <Truck size={13} strokeWidth={2.5} className="text-brand" />
                        Rate Preview
                      </h4>
                      <span className="text-[10px] text-ink-3 italic">no save required</span>
                    </div>
                    <div className="grid grid-cols-5 gap-2 mb-3">
                      <div>
                        <label className={labelCls}>Lb</label>
                        <input className={fieldCls + ' h-8 text-[12px]'} value={rateWeightLb} onChange={(e) => setRateWeightLb(e.target.value)} inputMode="numeric" />
                      </div>
                      <div>
                        <label className={labelCls}>Oz</label>
                        <input className={fieldCls + ' h-8 text-[12px]'} value={rateWeightOz} onChange={(e) => setRateWeightOz(e.target.value)} inputMode="decimal" />
                      </div>
                      <div>
                        <label className={labelCls}>L</label>
                        <input className={fieldCls + ' h-8 text-[12px]'} value={rateLength} onChange={(e) => setRateLength(e.target.value)} inputMode="numeric" />
                      </div>
                      <div>
                        <label className={labelCls}>W</label>
                        <input className={fieldCls + ' h-8 text-[12px]'} value={rateWidth} onChange={(e) => setRateWidth(e.target.value)} inputMode="numeric" />
                      </div>
                      <div>
                        <label className={labelCls}>H</label>
                        <input className={fieldCls + ' h-8 text-[12px]'} value={rateHeight} onChange={(e) => setRateHeight(e.target.value)} inputMode="numeric" />
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleGetRates()}
                      disabled={ratesLoading || !zip.trim()}
                      className="w-full h-9 rounded-lg text-[12px] font-bold text-white bg-gradient-to-br from-brand to-indigo-600 hover:shadow-md disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center justify-center gap-2"
                    >
                      <SearchIcon size={13} strokeWidth={2.5} />
                      {ratesLoading ? 'Fetching live rates…' : 'Get Live Rates'}
                    </button>
                    {ratesError ? (
                      <div className="mt-2 text-[11px] text-danger bg-danger-bg ring-1 ring-danger-border rounded-md px-2 py-1.5">
                        ⚠ {ratesError}
                      </div>
                    ) : null}
                    {rates && rates.length > 0 ? (
                      <div className="mt-3 space-y-1 max-h-[200px] overflow-y-auto">
                        {rates.map((r, idx) => (
                          <div
                            key={`${r.carrierCode}-${r.serviceCode}-${idx}`}
                            className={`flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md ${idx === 0 ? 'bg-emerald-50 ring-1 ring-emerald-200' : 'hover:bg-surface-2'}`}
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              {idx === 0 ? <CheckIcon size={12} strokeWidth={3} className="text-emerald-600 flex-shrink-0" /> : <span className="w-3 flex-shrink-0" />}
                              {/* Carrier badge — branded pill instead
                                  of plain text so the row identifies
                                  the carrier at a glance and the
                                  service label gets full width
                                  without overlapping. */}
                              <CarrierBadge code={r.carrierCode} size="md" />
                              <span className="text-[11.5px] text-ink truncate min-w-0 flex-1">{r.serviceLabel}</span>
                            </div>
                            <span className="text-[12px] font-bold tabular-nums text-ink">${r.cost.toFixed(2)}</span>
                          </div>
                        ))}
                      </div>
                    ) : rates && rates.length === 0 && !ratesLoading ? (
                      <div className="mt-2 text-[11px] text-ink-3 text-center py-2">No rates returned.</div>
                    ) : null}
                  </div>
                </section>
              </div>

              {/* ─────── Line Items ─────── */}
              <div className="px-5 pb-5">
                <div className="rounded-xl ring-1 ring-line bg-surface overflow-hidden">
                  <div className="px-4 py-3 bg-surface-2 border-b border-line flex items-center justify-between">
                    <h3 className={sectionTitleCls}>
                      <Package size={13} strokeWidth={2.5} className="text-brand" />
                      Order Line Items
                    </h3>
                    <button
                      type="button"
                      onClick={addItem}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-bold text-brand bg-brand-bg hover:bg-brand/10 ring-1 ring-brand-border transition"
                    >
                      <Plus size={12} strokeWidth={2.5} />
                      Add a Line Item
                    </button>
                  </div>
                  <div className="divide-y divide-line">
                    <div className="grid grid-cols-[1fr_2fr_80px_100px_36px] gap-2 px-4 py-2 bg-surface-2/50 text-[10px] font-bold uppercase tracking-wider text-ink-3">
                      <span>SKU</span>
                      <span>Name</span>
                      <span>Qty</span>
                      <span>Price</span>
                      <span />
                    </div>
                    {items.map((item) => (
                      <div key={item.id} className="grid grid-cols-[1fr_2fr_80px_100px_36px] gap-2 px-4 py-2 items-center">
                        <input
                          className={fieldCls + ' h-8 text-[12px]'}
                          value={item.sku}
                          onChange={(e) => updateItem(item.id, { sku: e.target.value })}
                          placeholder="SKU"
                        />
                        <input
                          className={fieldCls + ' h-8 text-[12px]'}
                          value={item.name}
                          onChange={(e) => updateItem(item.id, { name: e.target.value })}
                          placeholder="Item name"
                        />
                        <input
                          className={fieldCls + ' h-8 text-[12px] text-center'}
                          value={item.quantity}
                          onChange={(e) => updateItem(item.id, { quantity: e.target.value })}
                          inputMode="numeric"
                        />
                        <input
                          className={fieldCls + ' h-8 text-[12px] text-right'}
                          value={item.price}
                          onChange={(e) => updateItem(item.id, { price: e.target.value })}
                          placeholder="$"
                          inputMode="decimal"
                        />
                        <button
                          type="button"
                          onClick={() => removeItem(item.id)}
                          disabled={items.length === 1}
                          className="w-8 h-8 rounded-md flex items-center justify-center text-ink-3 hover:text-danger hover:bg-danger-bg/50 transition disabled:opacity-30 disabled:cursor-not-allowed"
                          aria-label="Remove item"
                        >
                          <Trash2 size={13} strokeWidth={2.25} />
                        </button>
                      </div>
                    ))}
                    <div className="px-4 py-2 bg-surface-2/30 flex items-center justify-end text-[12px] text-ink-2 gap-3">
                      <span className="text-[10px] uppercase tracking-wide font-bold text-ink-3">Subtotal:</span>
                      <span className="font-bold tabular-nums">${computedItemsTotal.toFixed(2)}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Sticky bottom action bar */}
              <div className="sticky bottom-0 px-5 py-3 bg-surface border-t border-line flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  {error ? (
                    <div className="text-[12px] text-danger font-semibold">⚠ {error}</div>
                  ) : (
                    <div className="text-[10.5px] text-ink-3">
                      Press <kbd className="px-1 py-0.5 ring-1 ring-line rounded bg-surface-2 text-ink-2 font-mono text-[9.5px]">Esc</kbd> to cancel · saving creates the order in Manual Orders
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => !saving && onClose()}
                  disabled={saving}
                  className="h-9 px-4 rounded-lg text-[12.5px] font-semibold text-ink-2 hover:text-ink hover:bg-surface-2 ring-1 ring-line transition disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="h-9 px-5 rounded-lg text-[12.5px] font-bold text-white bg-gradient-to-br from-brand to-indigo-600 shadow-md hover:shadow-lg disabled:opacity-60 disabled:cursor-not-allowed transition flex items-center gap-2"
                >
                  <CheckIcon size={13} strokeWidth={2.75} />
                  {saving ? 'Saving…' : 'Save Order'}
                </button>
              </div>
            </form>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
