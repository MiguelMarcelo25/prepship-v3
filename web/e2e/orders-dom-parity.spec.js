import { test, expect } from 'playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// PS-258 (2026-06-23): committed snapshots live as PLATFORM-AGNOSTIC files (no -win32/-darwin
// suffix) compared directly, so the cert passes from any review OS (Hermes runs it on macOS).
// Regenerate with UPDATE_DOM_PARITY=1.
const DOM_PARITY_SNAP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'orders-dom-parity-snapshots')
const UPDATE_DOM_PARITY = process.env.UPDATE_DOM_PARITY === '1'

// PS-258 — OrdersView DOM byte-equality certification (the safety net for the
// PS-166 / PS-306 hook-extraction track).
//
// Why this suite exists:
//   OrdersView.tsx (~9,935 lines, @ts-nocheck) is being decomposed by moving
//   inline React hooks into their own files, ONE AT A TIME, verbatim. Because
//   the file is @ts-nocheck, the compiler is NOT the proof of behaviour
//   preservation. This cert is: it renders both the Awaiting and Shipped tabs
//   from a fixed deterministic fixture, captures the orders-table innerHTML,
//   normalizes away presentational/volatile noise, and pins it as a committed
//   snapshot. Any later hook extraction that drifts the rendered DOM fails here
//   byte-for-byte BEFORE it can ship.
//
// Determinism contract (copied verbatim from orders-column-integrity.spec.js):
//   No live ShipStation calls, labels, postage, or marketplace notifications are
//   made — every network response is mocked via page.route. The rate fixture is
//   built from a fixed-date fingerprint so the rendered amounts are stable.
//
// Selector: the orders table is rendered as <table id="ordersTable">. We pin its
//   innerHTML. (No data-testid edit to OrdersView was required — #ordersTable is
//   already a stable, long-standing id that the sibling column-integrity suite
//   also targets.)

const baseUrl = 'http://127.0.0.1:5177'
const apiOrigin = 'http://127.0.0.1:3000'
const supabaseProjectRef = 'fdkseckgfuvdczzqmnac'

const clients = [
  { id: 1, name: 'KF Goods', active: true, isTest: false, storeId: 101 },
  { id: 2, name: 'eBay - DJC', active: true, isTest: false, storeId: 102 },
]

const SHIPPING_SERVICE_ELIGIBILITY_VERSION = 'ps-057-hugrab-ground-saver-v1'

// Canonical rate payload — base cost 9.86, no markup rules are mocked so the
// grid renders the base amount verbatim.
function ps050Fingerprint({ weightOz, zip, country = 'US', state, city, dims, clientId, carrierIds = [], confirmation = 'none' }) {
  const parts = [
    `v=ground-saver-v2|eligibility=${SHIPPING_SERVICE_ELIGIBILITY_VERSION}`,
    `d=${new Date().toISOString().slice(0, 10)}`,
    `w=${Math.round(weightOz * 10)}`,
    `z=${String(zip).replace(/\D/g, '').slice(0, 5)}`,
    `co=${country}`,
  ]
  if (state) parts.push(`st=${state.toUpperCase()}`)
  if (city) parts.push(`ci=${city.toLowerCase().replace(/\s+/g, '-')}`)
  parts.push('r=1')
  if (clientId != null) parts.push(`cl=${clientId}`)
  parts.push(`l=${Math.round(dims.length * 10)}`)
  parts.push(`dw=${Math.round(dims.width * 10)}`)
  parts.push(`h=${Math.round(dims.height * 10)}`)
  parts.push(`cf=${confirmation}`)
  if (carrierIds.length) parts.push(`c=${[...carrierIds].sort().join(',')}`)
  return parts.join('|')
}

const ps050RateFingerprint = ps050Fingerprint({
  weightOz: 60,
  zip: '73036',
  state: 'OK',
  city: 'El Reno',
  dims: { length: 11, width: 8, height: 6 },
  clientId: 1,
  carrierIds: ['se-7381'],
})

const rate = {
  carrierCode: 'ups',
  serviceCode: 'ups_ground_saver',
  serviceName: 'UPS Ground Saver (1 lb+)',
  carrierNickname: 'ROCEL C81F70',
  providerAccountNickname: 'ROCEL C81F70',
  shippingProviderId: 7381,
  amount: 9.86,
  cost: 9.86,
  shipmentCost: 9.86,
  otherCost: 0,
  requestFingerprint: ps050RateFingerprint,
  cacheKey: ps050RateFingerprint,
  proofSource: 'backend_rate_response',
  cacheCreatedAt: new Date().toISOString(),
  cacheExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  isComplete: true,
  rateCount: 1,
  matchType: 'exact',
  eligibilityVersion: SHIPPING_SERVICE_ELIGIBILITY_VERSION,
}

const storeIdByClientId = { 1: 101, 2: 102 }

function baseRow(id, status, clientId, overrides = {}) {
  return {
    id,
    orderId: id,
    orderNumber: `ORD-${id}`,
    orderStatus: status,
    orderDate: '2026-05-14T18:11:00.000Z',
    externalOrderId: `external-${id}`,
    clientId,
    storeId: storeIdByClientId[clientId] ?? clientId,
    customerEmail: `operator-${id}@example.com`,
    shipToName: 'Ella Johnson',
    shipToCity: 'El Reno',
    shipToState: 'OK',
    shipToPostalCode: '73036',
    orderTotal: 16.99,
    shippingAmount: 7.3,
    weightOz: 60,
    items: [{ name: 'KF GOODIES Korean Ramen Snack Box', sku: 'B0D43C5FGF', quantity: 1, unitPrice: 16.99, imageUrl: '' }],
    raw: {
      shipTo: { name: 'Ella Johnson', street1: '1318 S Reno Ave', city: 'El Reno', state: 'OK', postalCode: '73036', country: 'US' },
      dimensions: { length: 11, width: 8, height: 6 },
    },
    overrides: { rateWeightOz: 60, rateDimsL: 11, rateDimsW: 8, rateDimsH: 6, bestRateDims: '11x8x6', bestRateJson: rate },
    bestRate: rate,
    selectedRate: null,
    label: null,
    shipping: null,
    externallyShipped: false,
    ...overrides,
  }
}

// --- Fixtures mirror the six certified row classes from column-integrity -----

const awaitingValid = baseRow(970001, 'awaiting_shipment', 1, {
  bestRateWorkflow: { bestRateState: 'fresh', savedRateDisplay: 'fresh', canDisplayFinalRate: true, canUseDisplayedRateForPurchase: true, allowedActions: { canUseSavedRate: true, canCreateLabel: true, requiresRerate: false } },
})

const awaitingMissingDims = baseRow(970002, 'awaiting_shipment', 1, {
  orderNumber: 'ORD-970002',
  raw: { shipTo: { name: 'Ella Johnson', city: 'El Reno', state: 'OK', postalCode: '73036', country: 'US' } },
  overrides: { rateWeightOz: 60 },
  bestRate: null,
})

const awaitingMultiItem = baseRow(970003, 'awaiting_shipment', 1, {
  orderNumber: 'ORD-970003',
  items: [
    { name: 'Booster Gel', sku: 'Booster-gel-001', quantity: 2, unitPrice: 5, imageUrl: '' },
    { name: 'Leeds Line V2', sku: 'HU-10', quantity: 1, unitPrice: 4, imageUrl: '' },
  ],
})

const awaitingSingleQuantity = baseRow(970004, 'awaiting_shipment', 1, {
  orderNumber: 'ORD-970004',
  items: [
    { name: 'Single Pack Refill', sku: 'REFILL-4PK', quantity: 4, unitPrice: 3, imageUrl: '' },
  ],
})

const bestRateDivergent = {
  ...rate,
  carrierNickname: 'BEST ACCT 111',
  providerAccountNickname: 'BEST ACCT 111',
}
const awaitingBestRateDivergent = baseRow(970005, 'awaiting_shipment', 1, {
  orderNumber: 'ORD-970005',
  bestRateWorkflow: { bestRateState: 'fresh', savedRateDisplay: 'fresh', canDisplayFinalRate: true, canUseDisplayedRateForPurchase: true, allowedActions: { canUseSavedRate: true, canCreateLabel: true, requiresRerate: false } },
  overrides: { rateWeightOz: 60, rateDimsL: 11, rateDimsW: 8, rateDimsH: 6, bestRateDims: '11x8x6', bestRateJson: bestRateDivergent },
  bestRate: bestRateDivergent,
  selectedRate: {
    carrierCode: 'ups',
    serviceCode: 'ups_ground',
    serviceName: 'UPS Ground',
    carrierNickname: 'STALE ACCT 999',
    providerAccountNickname: 'STALE ACCT 999',
    shippingProviderId: 9999,
    amount: 9.86,
    cost: 9.86,
    shipmentCost: 9.86,
    otherCost: 0,
  },
})

const shippedPersisted = baseRow(980001, 'shipped', 1, {
  orderNumber: 'SHIPPED-980001',
  selectedRate: null,
  label: {
    trackingNumber: '1Z999AA1010980001',
    carrierCode: 'ups',
    serviceCode: 'ups_ground_saver',
    shippingProviderId: 7381,
    cost: 9.86,
    createdAt: '2026-05-15T17:02:00.000Z',
    labelUrl: 'https://example.com/label.pdf',
  },
  shipping: {
    carrierCode: 'ups',
    serviceCode: 'ups_ground_saver',
    trackingNumber: '1Z999AA1010980001',
    providerAccountId: 7381,
    accountNickname: 'ROCEL C81F70',
    labelCost: 9.86,
    labelCreatedAt: '2026-05-15T17:02:00.000Z',
    bestRate: rate,
  },
})

const shippedExternal = baseRow(980002, 'shipped', 2, {
  orderNumber: 'SHIPPED-980002',
  shipToName: 'Tony McMasters',
  raw: { shipTo: { name: 'Tony McMasters', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' }, dimensions: { length: 11, width: 8, height: 6 } },
  shipToCity: 'Austin',
  shipToState: 'TX',
  shipToPostalCode: '78701',
  selectedRate: null,
  label: null,
  shipping: null,
  externallyShipped: true,
})

const shippedMissingSync = baseRow(980003, 'shipped', 1, {
  orderNumber: 'SHIPPED-980003',
  selectedRate: null,
  label: null,
  shipping: null,
  externallyShipped: false,
})

const shippedNoNickname = baseRow(980004, 'shipped', 1, {
  orderNumber: 'SHIPPED-980004',
  bestRate: null,
  selectedRate: { carrierCode: 'ups', serviceCode: 'ups_ground_saver', serviceName: 'UPS Ground Saver', amount: 9.86, cost: 9.86, shipmentCost: 9.86, otherCost: 0 },
  label: { trackingNumber: '1Z999AA1010980004', carrierCode: 'ups', serviceCode: 'ups_ground_saver', shippingProviderId: 7381, cost: 9.86, createdAt: '2026-05-15T17:02:00.000Z', labelUrl: 'https://example.com/label.pdf' },
  shipping: { carrierCode: 'ups', serviceCode: 'ups_ground_saver', trackingNumber: '1Z999AA1010980004', providerAccountId: 7381, labelCost: 9.86, labelCreatedAt: '2026-05-15T17:02:00.000Z' },
})

const shippedShippBrokered = baseRow(980005, 'shipped', 1, {
  orderNumber: 'SHIPPED-980005',
  bestRate: null,
  selectedRate: { carrierCode: 'ups', serviceCode: 'shipp_ups_ground', serviceName: 'Shipp UPS Ground', amount: 9.86, cost: 9.86, shipmentCost: 9.86, otherCost: 0 },
  label: { trackingNumber: '1Z999AA1010980005', carrierCode: 'ups', serviceCode: 'shipp_ups_ground', shippingProviderId: 10000025, cost: 9.86, createdAt: '2026-05-15T17:02:00.000Z', labelUrl: 'https://example.com/label.pdf' },
  shipping: { carrierCode: 'ups', serviceCode: 'shipp_ups_ground', trackingNumber: '1Z999AA1010980005', providerAccountId: 10000025, labelCost: 9.86, labelCreatedAt: '2026-05-15T17:02:00.000Z' },
})

const ordersByStatus = {
  awaiting_shipment: [awaitingValid, awaitingMissingDims, awaitingMultiItem, awaitingSingleQuantity, awaitingBestRateDivergent],
  shipped: [shippedPersisted, shippedExternal, shippedMissingSync, shippedNoNickname, shippedShippBrokered],
  cancelled: [],
}

const countRows = [
  { orderStatus: 'awaiting_shipment', cnt: ordersByStatus.awaiting_shipment.length },
  { orderStatus: 'shipped', cnt: ordersByStatus.shipped.length },
  { orderStatus: 'cancelled', cnt: 0 },
]

function json(body) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) }
}

function responseFor(url) {
  if (url.hostname.endsWith('supabase.co')) return json({ user: null })

  const isApiRequest = url.origin === apiOrigin || url.origin !== baseUrl || url.pathname.startsWith('/api/')
  if (!isApiRequest) return null

  if (url.pathname === '/clients') return json(clients)
  if (url.pathname === '/users') return json({ users: [{ id: 'u1', email: 'operator@example.com', isAdmin: true }] })
  if (url.pathname === '/markups') return json({ data: [] })
  if (url.pathname === '/locations') {
    return json([{ id: 1, name: 'GWH Fulfillment Center', company: 'PrepShip', street1: '123 Warehouse Way', city: 'Gardena', state: 'CA', postalCode: '90248', country: 'US', phone: null, isDefault: true, active: true }])
  }
  if (url.pathname === '/packages') return json([{ id: 1, name: '11x8x6', length: 11, width: 8, height: 6, unitCost: '0.62', source: 'custom' }])
  if (url.pathname === '/rates/multi') return json({ carriers: [{ carrier_id: 'se-7381', carrier_code: 'ups', nickname: 'ROCEL C81F70', friendly_name: 'ROCEL C81F70' }] })
  if (url.pathname === '/api/carrier-accounts') return json({ data: [] })
  if (url.pathname === '/settings/orders.columnPrefs') return json({ value: null })
  if (url.pathname === '/orders/sync/status') return json({ status: 'idle', lastSyncAt: '2026-05-15T00:00:00.000Z' })
  if (url.pathname === '/shipments/status') return json({ status: 'idle' })
  if (url.pathname === '/init/stores') {
    return json({ data: clients.map((client) => ({ id: client.storeId, storeId: client.storeId, name: client.name, storeName: client.name, clientName: client.name, clientId: client.id, active: client.active, isTest: client.isTest })) })
  }
  if (url.pathname === '/init/counts') return json({ byStatus: countRows, byStatusStore: [] })
  if (url.pathname === '/clients/order-stats') {
    return json({ data: clients.map((client) => ({ clientId: client.id, awaiting_shipment: 1, shipped: 1, cancelled: 0 })) })
  }
  if (url.pathname === '/orders/distinct-skus') return json({ skus: ['B0D43C5FGF', 'Booster-gel-001', 'HU-10', 'REFILL-4PK'] })
  if (url.pathname === '/orders') {
    const status = url.searchParams.get('status') || 'awaiting_shipment'
    const data = ordersByStatus[status] ?? []
    return json({ data, pagination: { page: 1, pageSize: 50, total: data.length, totalPages: 1 } })
  }
  const orderFull = url.pathname.match(/^\/orders\/(\d+)\/full$/)
  if (orderFull) {
    const id = Number(orderFull[1])
    const order = Object.values(ordersByStatus).flat().find((candidate) => candidate.id === id)
    return json(order ?? baseRow(id, 'awaiting_shipment', 1))
  }

  return json({})
}

async function setup(page) {
  await page.addInitScript((projectRef) => {
    const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60
    window.localStorage.setItem(
      `sb-${projectRef}-auth-token`,
      JSON.stringify({
        access_token: 'mock-access-token',
        refresh_token: 'mock-refresh-token',
        expires_at: expiresAt,
        expires_in: 3600,
        token_type: 'bearer',
        user: { id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated', email: 'operator@example.com' },
      }),
    )
  }, supabaseProjectRef)

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    const mocked = responseFor(url)
    if (mocked) {
      await route.fulfill(mocked)
      return
    }
    await route.continue()
  })
}

// Strip volatile / presentational bits so the snapshot pins STRUCTURE + content,
// not noise. The goal of this cert is "the rendered orders table is identical
// after a verbatim hook move", so presentational attributes that a refactor must
// not be allowed to change are kept, but genuinely volatile or purely-stylistic
// noise is removed:
//   - inline style="..." (presentational; e.g. colgroup/cell widths)
//   - React/dev attributes (data-reactid, data-react*)
//   - HTML id="..."  (React useId() / list ids can be non-deterministic)
//   - aria-controls / aria-describedby / aria-labelledby / for / list / headers
//     (these reference generated ids, so they carry the same volatility)
//   - ISO-8601 datetimes (e.g. the rate tooltip's cacheCreatedAt/cacheExpiresAt
//     are stamped with new Date().toISOString() at fixture-build time, so they
//     change by milliseconds run-to-run — pure wall-clock noise, not behaviour)
//   - collapse all runs of whitespace to a single space
const ISO_DATETIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g
function normalize(html) {
  return html
    .replace(/\s+data-reactid="[^"]*"/g, '')
    .replace(/\s+data-react[\w-]*="[^"]*"/g, '')
    .replace(/ style="[^"]*"/g, '')
    .replace(/ id="[^"]*"/g, '')
    .replace(/ (?:aria-controls|aria-describedby|aria-labelledby|aria-activedescendant|for|list|headers)="[^"]*"/g, '')
    .replace(ISO_DATETIME, '<ISO_DATETIME>')
    // PS-258 hardening: the awaiting passive-rating cell settles non-deterministically between
    // "Add dims" (data-rate-state="add-dims") and "Rate unavailable · Retry"
    // (data-rate-state="unavailable") — same <button> shape, differing only by state attr/title/
    // text, depending on whether passive rating wins the race before capture. Pure timing, not
    // decomposition behaviour. Collapse the volatile NON-PRICED rate states to one placeholder so
    // the byte-snapshot is invariant to it. The priced "ready" state is deliberately NOT matched,
    // so real rate amounts stay asserted byte-for-byte.
    .replace(
      /<button type="button" data-rate-state="(?:add-dims|unavailable|calculating|loading|pending|rating)" title="[^"]*">[^<]*<\/button>/g,
      '<button type="button" data-rate-state="<RATE_PENDING>"></button>',
    )
    // PS-317 hardening: the "age" cell renders the order's age in relative units (e.g. "40d"), which
    // ticks up over time — the byte-snapshot would go stale a day after capture (40d -> 41d) and fail
    // for everyone, regardless of code. Mask the volatile age VALUE (the cell structure is still
    // asserted byte-for-byte). Pure time-dependence, not decomposition behaviour. Same approach as the
    // rate-state mask above.
    .replace(
      /(<div class="age-wrap"><span class="age-dot"><\/span><span>)[^<]*(<\/span><\/div>)/g,
      '$1<AGE>$2',
    )
    .replace(/\s{2,}/g, ' ')
    .replace(/>\s+</g, '><')
    .trim()
}

for (const tab of [
  { status: 'awaiting_shipment', snap: 'awaiting-table.txt' },
  { status: 'shipped', snap: 'shipped-table.txt' },
]) {
  test(`orders ${tab.status} table DOM is byte-stable`, async ({ page }) => {
    await page.setViewportSize({ width: 1680, height: 950 })
    await setup(page)
    await page.goto(`${baseUrl}/orders/${tab.status}`)
    await page.waitForSelector('#ordersTable tbody tr.order-row', { state: 'visible' })
    // Let any in-flight per-row hydration settle so the captured DOM is final.
    await page.waitForLoadState('networkidle')
    // PS-258 (2026-06-23): the per-row passive auto-rating renders a TRANSIENT
    // "calculating"/loading rate state before it resolves to a terminal state
    // (ready / unavailable). Wait for every rate cell to leave that transient state so the
    // captured DOM is deterministic across machines — Hermes caught the awaiting snapshot
    // alternating calculating<->unavailable on the macOS review box. Best-effort (.catch):
    // a tab with no rate cells (or already-terminal) resolves immediately.
    await page
      .waitForFunction(
        () => {
          const cells = document.querySelectorAll('#ordersTable [data-rate-state]')
          return (
            cells.length === 0 ||
            [...cells].every(
              (c) => !/calculating|loading|pending|rating/i.test(c.getAttribute('data-rate-state') || ''),
            )
          )
        },
        { timeout: 12000 },
      )
      .catch(() => {})
    const normalized = normalize(await page.locator('#ordersTable').innerHTML())
    const snapPath = path.join(DOM_PARITY_SNAP_DIR, tab.snap)
    if (UPDATE_DOM_PARITY) {
      fs.mkdirSync(DOM_PARITY_SNAP_DIR, { recursive: true })
      fs.writeFileSync(snapPath, normalized, 'utf8')
    }
    const expected = fs.readFileSync(snapPath, 'utf8')
    expect(normalized).toBe(expected)
  })
}
