import { test, expect } from 'playwright/test'
import { ORDERS_DAILY_STATS_WIRE } from './orders-daily-stats-wire.js'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// PS-038 — PERMANENT expedited-shipping badge + red-row certification.
//
// Asserts the actual rendered DOM/data state (never just "render succeeded"):
//   - Awaiting expedited row -> Order Date badge text + row-expedited class.
//   - Awaiting expedited via the FRONTEND MIRROR fallback (payload omits the
//     server `expedited` object, only carries raw.requestedShippingService) ->
//     still badged, proving the mirror detector matches the backend.
//   - Awaiting NON-expedited (ground) -> NO badge, NO row-expedited class.
//   - Shipped expedited keyed off the BUYER'S REQUESTED service even when the
//     PURCHASED label is ground -> badged 2-Day (ticket: base the indicator on
//     the original customer expectation, not the bought label).
//   - Shipped NON-expedited -> neither.
//   - The red treatment STAYS visible when the row is selected (computed td
//     background remains the expedited red, not the blue selection tint).
//
// No live ShipStation calls, labels, postage, or marketplace notifications:
// every network response is mocked via page.route.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const screenshotDir = path.resolve(__dirname, '../../reports/orders-expedited')
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

// The exact shape src/routes/orders.ts now attaches via detectExpeditedShipping.
function expeditedObj(tier, label, matchedText) {
  return { isExpedited: true, tier, label, matchedText }
}
const notExpedited = { isExpedited: false, tier: null, label: null, matchedText: null }

// --- Awaiting fixtures ------------------------------------------------------

// Server-computed expedited object present (the production contract).
const awaitingOvernight = baseRow(971001, 'awaiting_shipment', 1, {
  orderNumber: 'ORD-971001',
  raw: { shipTo: { name: 'Ella Johnson', city: 'El Reno', state: 'OK', postalCode: '73036', country: 'US' }, dimensions: { length: 11, width: 8, height: 6 }, requestedShippingService: 'Priority Overnight' },
  expedited: expeditedObj('overnight', 'Overnight', 'overnight'),
})

// Payload OMITS `expedited` -> exercises the frontend mirror fallback that
// detects from raw.requestedShippingService. Proves web/src/lib/expedited.ts
// agrees with the backend on "UPS Next Day Air" -> 1-Day.
const awaitingFallback1Day = baseRow(971002, 'awaiting_shipment', 1, {
  orderNumber: 'ORD-971002',
  raw: { shipTo: { name: 'Ella Johnson', city: 'El Reno', state: 'OK', postalCode: '73036', country: 'US' }, dimensions: { length: 11, width: 8, height: 6 }, requestedShippingService: 'UPS Next Day Air' },
})

// Ground -> server returns isExpedited:false -> NO badge / NO highlight.
const awaitingGround = baseRow(971003, 'awaiting_shipment', 1, {
  orderNumber: 'ORD-971003',
  raw: { shipTo: { name: 'Ella Johnson', city: 'El Reno', state: 'OK', postalCode: '73036', country: 'US' }, dimensions: { length: 11, width: 8, height: 6 }, requestedShippingService: 'UPS Ground' },
  expedited: notExpedited,
})

// --- Shipped fixtures -------------------------------------------------------

// Requested 2-Day but the PURCHASED label is ground. The badge must reflect the
// REQUESTED service (2-Day), not the bought ground label.
const shippedTwoDayRequested = baseRow(981001, 'shipped', 1, {
  orderNumber: 'SHIPPED-981001',
  raw: { shipTo: { name: 'Ella Johnson', city: 'El Reno', state: 'OK', postalCode: '73036', country: 'US' }, dimensions: { length: 11, width: 8, height: 6 }, requestedShippingService: 'FedEx 2Day' },
  expedited: expeditedObj('two_day', '2-Day', '2day'),
  selectedRate: rate,
  label: { trackingNumber: '1Z999AA1010981001', carrierCode: 'ups', serviceCode: 'ups_ground_saver', shippingProviderId: 7381, cost: 9.86, createdAt: '2026-05-15T17:02:00.000Z', labelUrl: 'https://example.com/label.pdf' },
  shipping: { carrierCode: 'ups', serviceCode: 'ups_ground_saver', trackingNumber: '1Z999AA1010981001', providerAccountId: 7381, accountNickname: 'ROCEL C81F70', labelCost: 9.86, labelCreatedAt: '2026-05-15T17:02:00.000Z', selectedRate: rate, bestRate: rate },
})

// Shipped, requested ground -> NO badge / NO highlight.
const shippedGround = baseRow(981002, 'shipped', 1, {
  orderNumber: 'SHIPPED-981002',
  raw: { shipTo: { name: 'Ella Johnson', city: 'El Reno', state: 'OK', postalCode: '73036', country: 'US' }, dimensions: { length: 11, width: 8, height: 6 }, requestedShippingService: 'UPS Ground' },
  expedited: notExpedited,
  selectedRate: rate,
  label: { trackingNumber: '1Z999AA1010981002', carrierCode: 'ups', serviceCode: 'ups_ground_saver', shippingProviderId: 7381, cost: 9.86, createdAt: '2026-05-15T17:02:00.000Z', labelUrl: 'https://example.com/label.pdf' },
  shipping: { carrierCode: 'ups', serviceCode: 'ups_ground_saver', trackingNumber: '1Z999AA1010981002', providerAccountId: 7381, accountNickname: 'ROCEL C81F70', labelCost: 9.86, labelCreatedAt: '2026-05-15T17:02:00.000Z', selectedRate: rate, bestRate: rate },
})

const ordersByStatus = {
  awaiting_shipment: [awaitingOvernight, awaitingFallback1Day, awaitingGround],
  shipped: [shippedTwoDayRequested, shippedGround],
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
  if (url.pathname === '/rates/multi') return json({ carriers: [] })
  if (url.pathname === '/api/carrier-accounts') return json({ data: [] })
  if (url.pathname === '/settings/orders.columnPrefs') return json({ value: null })
  if (url.pathname === '/orders/daily-stats') return json(ORDERS_DAILY_STATS_WIRE)
  if (url.pathname === '/orders/sync/status') return json({ status: 'idle', lastSyncAt: '2026-05-15T00:00:00.000Z' })
  if (url.pathname === '/shipments/status') return json({ status: 'idle' })
  if (url.pathname === '/init/stores') {
    return json({ data: clients.map((client) => ({ id: client.storeId, storeId: client.storeId, name: client.name, storeName: client.name, clientName: client.name, clientId: client.id, active: client.active, isTest: client.isTest })) })
  }
  if (url.pathname === '/init/counts') return json({ byStatus: countRows, byStatusStore: [] })
  if (url.pathname === '/clients/order-stats') {
    return json({ data: clients.map((client) => ({ clientId: client.id, awaiting_shipment: 1, shipped: 1, cancelled: 0 })) })
  }
  if (url.pathname === '/orders/distinct-skus') return json({ skus: ['B0D43C5FGF'] })
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

// Assert a row carries the expedited badge (in its Order Date cell) + the
// row-expedited tier class, against the actual DOM — not just "rendered".
async function assertExpedited(page, rowId, { label, tier }) {
  const row = page.locator(`#row-${rowId}`)
  await expect(row, `row ${rowId} should be rendered`).toHaveCount(1)
  await expect(row, `row ${rowId} must carry row-expedited`).toHaveClass(/\brow-expedited\b/)
  await expect(row, `row ${rowId} must carry row-expedited--${tier}`).toHaveClass(new RegExp(`row-expedited--${tier}\\b`))
  await expect(row).toHaveAttribute('data-expedited', tier)
  const badge = row.locator('.expedited-badge')
  await expect(badge, `row ${rowId} must render exactly one expedited badge`).toHaveCount(1)
  await expect(badge).toHaveText(label)
  await expect(badge).toHaveClass(new RegExp(`expedited-badge--${tier}\\b`))
  // The badge lives inside the Order Date cell.
  await expect(row.locator('td[data-col="date"] .expedited-badge')).toHaveCount(1)
}

// Assert a row is NOT treated as expedited: no class, no badge anywhere.
async function assertNotExpedited(page, rowId) {
  const row = page.locator(`#row-${rowId}`)
  await expect(row, `row ${rowId} should be rendered`).toHaveCount(1)
  await expect(row, `row ${rowId} must NOT carry row-expedited`).not.toHaveClass(/\brow-expedited\b/)
  await expect(row.locator('.expedited-badge'), `row ${rowId} must render no expedited badge`).toHaveCount(0)
}

test('Awaiting: expedited rows badge + highlight (server object AND mirror fallback); ground shows neither', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 950 })
  await setup(page)
  await page.goto(`${baseUrl}/orders/awaiting_shipment`)
  await page.waitForSelector('#ordersTable tbody tr.order-row', { state: 'visible' })
  await expect(page.locator('#daily-strip')).toContainText(/63\s*Total Orders/)
  await page.screenshot({ path: path.join(screenshotDir, 'awaiting-expedited.png'), fullPage: true })

  // Server-computed expedited object -> Overnight.
  await assertExpedited(page, awaitingOvernight.orderId, { label: 'Overnight', tier: 'overnight' })
  // Mirror fallback (no server object, only requestedShippingService) -> 1-Day.
  await assertExpedited(page, awaitingFallback1Day.orderId, { label: '1-Day', tier: 'one_day' })
  // Ground -> neither.
  await assertNotExpedited(page, awaitingGround.orderId)

  // Red treatment must PERSIST under selection. Select the expedited row and
  // confirm a content cell's computed background stays in the expedited
  // red/pink range, not the normal blue selection tint. Browser/style
  // composition has historically varied by a few RGB points (213-216).
  const selectBox = page.locator(`#row-${awaitingOvernight.orderId} td[data-col="select"] input[type="checkbox"]`)
  await selectBox.check()
  const selectedRow = page.locator(`#row-${awaitingOvernight.orderId}`)
  await expect(selectedRow).toHaveClass(/\brow-selected\b/)
  await expect(selectedRow).toHaveClass(/\brow-expedited\b/)
  const bg = await selectedRow.locator('td[data-col="date"]').evaluate((el) => getComputedStyle(el).backgroundColor)
  const channels = bg.match(/\d+/g)?.map(Number) ?? []
  expect(channels.length, `selected expedited row background must be rgb(), got ${bg}`).toBeGreaterThanOrEqual(3)
  expect(channels[0], 'selected expedited row red channel').toBeGreaterThanOrEqual(245)
  expect(channels[1], 'selected expedited row green channel').toBeGreaterThanOrEqual(205)
  expect(channels[1], 'selected expedited row green channel').toBeLessThanOrEqual(225)
  expect(channels[2], 'selected expedited row blue channel').toBeGreaterThanOrEqual(205)
  expect(channels[2], 'selected expedited row blue channel').toBeLessThanOrEqual(225)
  expect(Math.abs(channels[1] - channels[2]), 'selected expedited row should stay a neutral red tint').toBeLessThanOrEqual(3)
})

test('Shipped: badge reflects REQUESTED service (2-Day) even when the purchased label is ground; ground shows neither', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 950 })
  await setup(page)
  await page.goto(`${baseUrl}/orders/shipped`)
  await page.waitForSelector('#ordersTable tbody tr.order-row', { state: 'visible' })
  await expect(page.locator('#daily-strip')).toContainText(/63\s*Total Orders/)
  await page.screenshot({ path: path.join(screenshotDir, 'shipped-expedited.png'), fullPage: true })

  // Requested 2-Day, purchased label ups_ground_saver -> badge is 2-Day.
  await assertExpedited(page, shippedTwoDayRequested.orderId, { label: '2-Day', tier: 'two_day' })
  // Requested ground -> neither.
  await assertNotExpedited(page, shippedGround.orderId)
})
