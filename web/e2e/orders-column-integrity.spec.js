import { test, expect } from 'playwright/test'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// PS-036 — PERMANENT Orders column-integrity certification.
//
// Why this suite exists / why the prior E2E missed the bug:
//   orders-ux.spec.js only ever asserted the selection toolbar + lockdown
//   behaviour. It NEVER inspected the rendered content of any grid cell, so a
//   shipped row that silently rendered "Ext. Label" (or blanked Carrier /
//   Shipping Account / Selected Rate) passed certification. This suite closes
//   that gap by asserting EVERY required column for each order status against
//   the source-of-truth values the fixture was built from — not merely that a
//   cell is non-empty.
//
// It also pins the three honest shipped data-states introduced by PS-036 and
// made immutable by PS-056:
//   - LOCAL -> real local shipment data -> carrier/acct/rate
//   - RECOVERABLE_MISSING_SYNC -> upstream shipment/fulfillment may still be
//     backfilled; no explicit external flag -> "Shipment sync error"
//   - EXTERNAL -> explicit operator/marketplace flag -> Ext. Label
//
// No live ShipStation calls, labels, postage, or marketplace notifications are
// made: every network response is mocked via page.route.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const screenshotDir = path.resolve(__dirname, '../../reports/orders-column-integrity')
const baseUrl = 'http://127.0.0.1:5177'
const apiOrigin = 'http://127.0.0.1:3000'
const supabaseProjectRef = 'fdkseckgfuvdczzqmnac'

test.beforeAll(async () => {
  await mkdir(screenshotDir, { recursive: true })
})

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
  cacheCreatedAt: new Date().toISOString(),
  cacheExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  isComplete: true,
  rateCount: 1,
  matchType: 'exact',
  eligibilityVersion: SHIPPING_SERVICE_ELIGIBILITY_VERSION,
}

const storeIdByClientId = { 1: 101, 2: 102 }

// Build a raw `/orders` list row (the shape the API actually returns). The
// useOrders normalizer (transformOrderRowV4toV2) turns this into the DTO the
// grid consumes — exactly the production path.
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
    // bestRateDims is the dims-provenance label production stores next to the
    // cached rate (order_overrides.best_rate_dims). The grid only displays a
    // saved best rate when this label matches the order's CURRENT dims — that
    // is the staleness guard (hasValidBestRateForCurrentDims). A fixture that
    // omits it is less faithful than production and would render a spinner.
    overrides: { rateWeightOz: 60, rateDimsL: 11, rateDimsW: 8, rateDimsH: 6, bestRateDims: '11x8x6', bestRateJson: rate },
    bestRate: rate,
    selectedRate: null,
    label: null,
    shipping: null,
    externallyShipped: false,
    ...overrides,
  }
}

// --- The six certified row classes -----------------------------------------

// 1) Awaiting, fully rated.
const awaitingValid = baseRow(970001, 'awaiting_shipment', 1)

// 2) Awaiting, missing dims + no rate -> carrier/account/best-rate must say "— add dims".
const awaitingMissingDims = baseRow(970002, 'awaiting_shipment', 1, {
  orderNumber: 'ORD-970002',
  raw: { shipTo: { name: 'Ella Johnson', city: 'El Reno', state: 'OK', postalCode: '73036', country: 'US' } },
  overrides: { rateWeightOz: 60 },
  bestRate: null,
})

// 6) Awaiting multi-item: SKU column lists every SKU with matching quantity
// badges where needed, Qty column sums to 3.
const awaitingMultiItem = baseRow(970003, 'awaiting_shipment', 1, {
  orderNumber: 'ORD-970003',
  items: [
    { name: 'Booster Gel', sku: 'Booster-gel-001', quantity: 2, unitPrice: 5, imageUrl: '' },
    { name: 'Leeds Line V2', sku: 'HU-10', quantity: 1, unitPrice: 4, imageUrl: '' },
  ],
})

// 7) Awaiting single-SKU quantity > 1: SKU column still carries quantity context.
const awaitingSingleQuantity = baseRow(970004, 'awaiting_shipment', 1, {
  orderNumber: 'ORD-970004',
  items: [
    { name: 'Single Pack Refill', sku: 'REFILL-4PK', quantity: 4, unitPrice: 3, imageUrl: '' },
  ],
})

// PS-079 — Awaiting row where a divergent selectedRate account ("STALE ACCT 999")
// disagrees with the current best-rate account ("BEST ACCT 111"). The Awaiting
// shipping-account column must show the BEST RATE account, never the stale
// selected/canonical one.
const bestRateDivergent = {
  ...rate,
  carrierNickname: 'BEST ACCT 111',
  providerAccountNickname: 'BEST ACCT 111',
}
const awaitingBestRateDivergent = baseRow(970005, 'awaiting_shipment', 1, {
  orderNumber: 'ORD-970005',
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

// 3) Shipped, real local shipment data persisted.
const shippedPersisted = baseRow(980001, 'shipped', 1, {
  orderNumber: 'SHIPPED-980001',
  // Persisted local shipment/account data can exist even when the row no
  // longer has a v2 selected-rate payload. PS-048 pins that Acct Nickname still
  // comes from shipping.accountNickname instead of falling through to
  // label.carrierCode ("ups").
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

// 4) Shipped, EXPLICIT external flag, no local data -> must render "Ext. Label".
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

// 5) Shipped, NO flag and NO local data -> must render "Shipment sync error"
//    (the exact bug PS-036 fixes — previously this rendered "Ext. Label").
const shippedMissingSync = baseRow(980003, 'shipped', 1, {
  orderNumber: 'SHIPPED-980003',
  selectedRate: null,
  label: null,
  shipping: null,
  externallyShipped: false,
})

// 5b) Shipped with a REAL carrier label (carrierCode 'ups') but NO account
//     nickname anywhere (no shipping.accountNickname, no selectedRate/bestRate
//     nickname). The diagnostic "Acct Nickname" column must NOT fall back to
//     the carrier code "ups" — regression guard for commit 03df3d8 (DJ's
//     `Acct Nickname = ups` bug). Blank/honest-missing is correct here.
const shippedNoNickname = baseRow(980004, 'shipped', 1, {
  orderNumber: 'SHIPPED-980004',
  bestRate: null,
  selectedRate: { carrierCode: 'ups', serviceCode: 'ups_ground_saver', serviceName: 'UPS Ground Saver', amount: 9.86, cost: 9.86, shipmentCost: 9.86, otherCost: 0 },
  label: { trackingNumber: '1Z999AA1010980004', carrierCode: 'ups', serviceCode: 'ups_ground_saver', shippingProviderId: 7381, cost: 9.86, createdAt: '2026-05-15T17:02:00.000Z', labelUrl: 'https://example.com/label.pdf' },
  shipping: { carrierCode: 'ups', serviceCode: 'ups_ground_saver', trackingNumber: '1Z999AA1010980004', providerAccountId: 7381, labelCost: 9.86, labelCreatedAt: '2026-05-15T17:02:00.000Z' },
})

const ordersByStatus = {
  awaiting_shipment: [awaitingValid, awaitingMissingDims, awaitingMultiItem, awaitingSingleQuantity, awaitingBestRateDivergent],
  shipped: [shippedPersisted, shippedExternal, shippedMissingSync, shippedNoNickname],
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

// Reusable per-column source-of-truth assertion. `columns` maps a data-col key
// to either { contains } (substring), { equals } (trimmed exact), { matches }
// (regex), or { notContains } (must NOT contain). Every entry is validated
// against the actual rendered cell text — never just "is non-empty".
async function assertColumns(page, rowId, columns) {
  const row = page.locator(`#row-${rowId}`)
  await expect(row, `row ${rowId} should be rendered`).toHaveCount(1)
  for (const [col, rule] of Object.entries(columns)) {
    const cell = row.locator(`td[data-col="${col}"]`)
    await expect(cell, `row ${rowId} must have a [data-col="${col}"] cell`).toHaveCount(1)
    if (rule.equals !== undefined) {
      await expect(cell, `row ${rowId} col ${col} text`).toHaveText(rule.equals, { timeout: 15000 })
    }
    if (rule.matches !== undefined) {
      await expect(cell, `row ${rowId} col ${col} should match ${rule.matches}`).toContainText(rule.matches, { timeout: 15000 })
    }
    if (rule.contains !== undefined) {
      const needles = Array.isArray(rule.contains) ? rule.contains : [rule.contains]
      for (const needle of needles) {
        await expect(cell, `row ${rowId} col ${col} should contain "${needle}"`).toContainText(needle, { timeout: 15000 })
      }
    }
    const text = ((await cell.textContent()) ?? '').trim()
    if (rule.equals !== undefined) {
      expect(text, `row ${rowId} col ${col} text`).toBe(rule.equals)
    }
    if (rule.contains !== undefined) {
      const needles = Array.isArray(rule.contains) ? rule.contains : [rule.contains]
      for (const needle of needles) {
        expect(text, `row ${rowId} col ${col} should contain "${needle}"`).toContain(needle)
      }
    }
    if (rule.notContains !== undefined) {
      const needles = Array.isArray(rule.notContains) ? rule.notContains : [rule.notContains]
      for (const needle of needles) {
        expect(text, `row ${rowId} col ${col} must NOT contain "${needle}"`).not.toContain(needle)
      }
    }
  }
}

async function scrollOrdersTableRight(page) {
  await page.locator('.orders-wrap').evaluate((el) => {
    el.scrollLeft = el.scrollWidth
  })
}

test('Awaiting grid columns render every required field from source of truth', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 950 })
  await setup(page)
  await page.goto(`${baseUrl}/orders/awaiting_shipment`)
  await page.waitForSelector('#ordersTable tbody tr.order-row', { state: 'visible' })
  await page.screenshot({ path: path.join(screenshotDir, 'awaiting.png'), fullPage: true })

  // Valid awaiting row — every required column populated from the fixture.
  await assertColumns(page, awaitingValid.orderId, {
    date: { matches: /\d/ },
    client: { equals: 'KF Goods' },
    orderNum: { contains: 'ORD-970001' },
    customer: { contains: 'Ella Johnson' },
    itemname: { contains: 'KF GOODIES Korean Ramen Snack Box' },
    sku: { equals: 'B0D43C5FGF' },
    qty: { equals: '1' },
    weight: { matches: /\d/ },
    shipto: { contains: ['El Reno', 'OK', '73036'] },
    total: { contains: '16.99' },
  })
  await scrollOrdersTableRight(page)
  await assertColumns(page, awaitingValid.orderId, {
    carrier: { notContains: ['Ext. Label', 'Shipment sync error', '— add dims'] },
    custcarrier: { contains: 'ROCEL C81F70' },
    bestrate: { contains: '9.86', notContains: ['Ext. Label', 'Shipment sync error'] },
    test_bestRate: { contains: ['ups', '9.86'] },
  })

  // PS-079 — divergent account: best rate account is "BEST ACCT 111" while a
  // stale selectedRate carries "STALE ACCT 999". Awaiting shipping-account column
  // must show the BEST RATE account, never the stale selected one.
  await assertColumns(page, awaitingBestRateDivergent.orderId, {
    custcarrier: { contains: 'BEST ACCT 111', notContains: 'STALE ACCT 999' },
  })

  // Missing-dims awaiting row — rate-dependent columns MUST surface the
  // actionable "— add dims" prompt, not a blank/spinner masquerading as data.
  await assertColumns(page, awaitingMissingDims.orderId, {
    client: { equals: 'KF Goods' },
    orderNum: { contains: 'ORD-970002' },
    sku: { equals: 'B0D43C5FGF' },
    qty: { equals: '1' },
    total: { contains: '16.99' },
    carrier: { contains: '— add dims' },
    custcarrier: { contains: '— add dims' },
    bestrate: { contains: '— add dims' },
  })

  // Multi-item row — Item Name and SKU columns both carry per-line quantity
  // context. HU-10 quantity is 1 and must not render a noisy ×1 badge.
  await assertColumns(page, awaitingMultiItem.orderId, {
    orderNum: { contains: 'ORD-970003' },
    itemname: { contains: ['Booster Gel', '×2', 'Leeds Line V2'] },
    sku: { contains: ['Booster-gel-001', '×2', 'HU-10'], notContains: '×1' },
    qty: { equals: '3' },
  })

  // Single-SKU quantity > 1 — SKU column should not lose quantity context
  // just because there is only one SKU line.
  await assertColumns(page, awaitingSingleQuantity.orderId, {
    orderNum: { contains: 'ORD-970004' },
    itemname: { contains: 'Single Pack Refill' },
    sku: { contains: ['REFILL-4PK', '×4'] },
    qty: { equals: '4' },
  })
})

test('Shipped grid columns are correctly classified (persisted vs external vs missing-sync)', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 950 })
  await setup(page)
  await page.goto(`${baseUrl}/orders/shipped`)
  await page.waitForSelector('#ordersTable tbody tr.order-row', { state: 'visible' })
  await page.screenshot({ path: path.join(screenshotDir, 'shipped.png'), fullPage: true })

  // Persisted shipped row — real carrier / account / selected-rate / tracking.
  await assertColumns(page, shippedPersisted.orderId, {
    client: { equals: 'KF Goods' },
    orderNum: { contains: 'SHIPPED-980001' },
    customer: { contains: 'Ella Johnson' },
    weight: { matches: /\d/ },
    shipto: { contains: ['El Reno', 'OK', '73036'] },
    carrier: { notContains: ['Ext. Label', 'Shipment sync error'] },
    custcarrier: { contains: 'ROCEL C81F70', notContains: ['Ext. Label', 'Shipment sync error'] },
    bestrate: { contains: '9.86', notContains: ['Ext. Label', 'Shipment sync error'] },
    tracking: { contains: '1Z999AA1010980001' },
    labelcreated: { matches: /\d/ },
    test_carrierCode: { contains: 'ups' },
    test_shippingProviderID: { contains: '7381' },
    test_shippingAccount: {
      contains: 'ROCEL C81F70',
      notContains: ['ups', 'Ext. Label', 'Shipment sync error'],
    },
  })

  // Explicit external row — operator/marketplace flag drives "Ext. Label" and
  // it must NEVER be confused with a missing-sync row.
  await assertColumns(page, shippedExternal.orderId, {
    client: { equals: 'eBay - DJC' },
    orderNum: { contains: 'SHIPPED-980002' },
    customer: { contains: 'Tony McMasters' },
    carrier: { contains: 'Ext. Label', notContains: 'Shipment sync error' },
    custcarrier: { contains: 'Ext. Label', notContains: 'Shipment sync error' },
    bestrate: { contains: 'Ext. Label', notContains: 'Shipment sync error' },
  })

  // Missing-sync row — shipped, no explicit flag, no local data. THE PS-036
  // regression guard: this must render "Shipment sync error", NOT "Ext. Label".
  await assertColumns(page, shippedMissingSync.orderId, {
    client: { equals: 'KF Goods' },
    orderNum: { contains: 'SHIPPED-980003' },
    carrier: { contains: 'Shipment sync error', notContains: 'Ext. Label' },
    custcarrier: { contains: 'Shipment sync error', notContains: 'Ext. Label' },
    bestrate: { contains: 'Shipment sync error', notContains: 'Ext. Label' },
  })

  // Real carrier label, NO nickname source -> diagnostic "Acct Nickname"
  // (test_shippingAccount) must NOT fall back to the carrier code "ups".
  // Regression guard for commit 03df3d8 (getShippedDisplayAccountNickname).
  await assertColumns(page, shippedNoNickname.orderId, {
    orderNum: { contains: 'SHIPPED-980004' },
    test_carrierCode: { contains: 'ups' },        // carrier-code column legitimately shows ups
    test_shippingAccount: { notContains: 'ups' }, // Acct Nickname must NEVER be the carrier code
  })
})

// PS-077 — Shipped "Selected Rate" (internal `bestrate`) must resize compactly
// below the old 175px Best Rate floor, with header/body staying aligned.
test('PS-077: Shipped Selected Rate column resizes below 175px and stays aligned', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 950 })
  await setup(page)
  await page.goto(`${baseUrl}/orders/shipped`)
  await page.waitForSelector('#ordersTable tbody tr.order-row', { state: 'visible' })

  const header = page.locator('#ordersTable thead th[data-col="bestrate"]')
  await expect(header).toHaveCount(1)
  await expect(header).toContainText('Selected Rate') // relabeled in Shipped/Cancelled

  const before = await header.boundingBox()
  expect(before).not.toBeNull()
  expect(before.width).toBeGreaterThanOrEqual(170) // started at the old ~175 floor

  // Resize via the keyboard path (Shift+ArrowLeft → resizeColumnByKeyboard, −10px
  // each). It hits the SAME status-aware getColumnMinWidth as drag, and is used
  // here instead of a synthetic drag because the header is `draggable`, which
  // races the native HTML5 drag under Playwright. 12 presses drives 175 → the
  // compact floor (88) for Shipped.
  await header.focus()
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press('Shift+ArrowLeft')
  }

  const headerWidth = async () => {
    const b = await header.boundingBox()
    return b ? b.width : Number.POSITIVE_INFINITY
  }
  // Width updates via setColumnPrefs re-render, so poll. It shrank below the OLD
  // 175 clamp (down toward the 88 compact floor).
  await expect.poll(headerWidth, { timeout: 5000 }).toBeLessThan(175)
  expect(await headerWidth()).toBeLessThan(before.width)

  // Header and body cell widths stay aligned (table-layout: fixed shares width).
  const after = await header.boundingBox()
  const bodyCell = page.locator(`#row-${shippedPersisted.orderId} td[data-col="bestrate"]`)
  const cellBox = await bodyCell.boundingBox()
  expect(cellBox).not.toBeNull()
  expect(Math.abs(cellBox.width - after.width)).toBeLessThan(2)

  // Compact, but the amount is still rendered (no blanking/overflow break).
  await expect(bodyCell).toContainText('9.86')

  await page.screenshot({ path: path.join(screenshotDir, 'shipped-selected-rate-compact.png'), fullPage: true })
})

// PS-077 follow-up — Awaiting "Best Rate" must shrink below 175px too.
test('PS-077: Awaiting Best Rate column resizes below 175px and stays aligned', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 950 })
  await setup(page)
  await page.goto(`${baseUrl}/orders/awaiting_shipment`)
  await page.waitForSelector('#ordersTable tbody tr.order-row', { state: 'visible' })

  const header = page.locator('#ordersTable thead th[data-col="bestrate"]')
  await expect(header).toHaveCount(1)
  await expect(header).toContainText('Best Rate') // NOT relabeled in Awaiting

  const before = await header.boundingBox()
  expect(before).not.toBeNull()
  expect(before.width).toBeGreaterThanOrEqual(170) // started at the old ~175 floor

  // Same keyboard resize path as the Shipped test; hits getColumnMinWidth.
  await header.focus()
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press('Shift+ArrowLeft')
  }

  const headerWidth = async () => {
    const b = await header.boundingBox()
    return b ? b.width : Number.POSITIVE_INFINITY
  }
  await expect.poll(headerWidth, { timeout: 5000 }).toBeLessThan(175)
  expect(await headerWidth()).toBeLessThan(before.width)

  // Header and body cell stay aligned.
  const after = await header.boundingBox()
  const bodyCell = page.locator('#ordersTable tbody tr.order-row td[data-col="bestrate"]').first()
  const cellBox = await bodyCell.boundingBox()
  expect(cellBox).not.toBeNull()
  expect(Math.abs(cellBox.width - after.width)).toBeLessThan(2)

  await page.screenshot({ path: path.join(screenshotDir, 'awaiting-best-rate-compact.png'), fullPage: true })
})
