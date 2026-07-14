import { test, expect } from 'playwright/test'
import { ORDERS_DAILY_STATS_WIRE } from './orders-daily-stats-wire.js'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// PS-210 — Orders search is GLOBAL across Awaiting / Shipped / Cancelled.
//
// Operator report: a customer search that found the order on the Shipped tab
// returned nothing on Awaiting Shipment — the UI claimed "Searching all
// orders" while the table query stayed pinned to the active tab.
//
// This suite proves the rendered behavior end-to-end against a search-aware
// /orders mock that only returns cross-status rows when the request carries
// BOTH a non-empty `search` AND `searchScope=global` — so if the frontend
// ever stops declaring the global intent, the shipped fixture vanishes from
// the Awaiting search and the suite fails:
//   - From Awaiting, searching a fixture customer whose order is SHIPPED
//     surfaces the row, labeled with its REAL status pill.
//   - The same search from Shipped and Cancelled behaves identically.
//   - Clearing the search restores the tab's normal local rows (and drops
//     searchScope from the request).
//   - Mixed-status rows keep their real orderStatus rendering — the shipped
//     row keeps its tracking-bearing shipped shape; nothing re-labels it as
//     an awaiting order. (Mutation safety is backend-owned: every
//     modification endpoint still rejects shipped/cancelled rows via
//     assertOrderEditable — this suite is read-only display proof.)
//
// All fixture names are FAKE. No live ShipStation calls, labels, postage, or
// marketplace notifications: every network response is mocked via page.route.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const screenshotDir = path.resolve(__dirname, '../../reports/orders-global-search')
const baseUrl = 'http://127.0.0.1:5177'
const apiOrigin = 'http://127.0.0.1:3000'
const supabaseProjectRef = 'fdkseckgfuvdczzqmnac'

test.beforeAll(async () => {
  await mkdir(screenshotDir, { recursive: true })
})

const clients = [
  { id: 1, name: 'KF Goods', active: true, isTest: false, storeId: 101 },
]

const rate = {
  carrierCode: 'ups',
  serviceCode: 'ups_ground',
  serviceName: 'UPS Ground',
  carrierNickname: 'ROCEL C81F70',
  providerAccountNickname: 'ROCEL C81F70',
  shippingProviderId: 7381,
  amount: 9.86,
  cost: 9.86,
  shipmentCost: 9.86,
  otherCost: 0,
}

function baseRow(id, status, customerName, orderNumber, overrides = {}) {
  return {
    id,
    orderId: id,
    orderNumber,
    orderStatus: status,
    orderDate: '2026-06-10T18:11:00.000Z',
    externalOrderId: `external-${id}`,
    clientId: 1,
    storeId: 101,
    customerEmail: `fixture-${id}@example.com`,
    shipToName: customerName,
    shipToCity: 'El Reno',
    shipToState: 'OK',
    shipToPostalCode: '73036',
    orderTotal: 16.99,
    shippingAmount: 7.3,
    weightOz: 60,
    items: [{ name: 'Fixture Snack Box', sku: 'FAKE-SKU-1', quantity: 1, unitPrice: 16.99, imageUrl: '' }],
    raw: {
      shipTo: { name: customerName, street1: '1318 S Reno Ave', city: 'El Reno', state: 'OK', postalCode: '73036', country: 'US' },
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

// The search target: "Riley Globalsearch" owns one SHIPPED and one CANCELLED
// order. The awaiting tab's local row belongs to a different fixture customer.
const awaitingLocal = baseRow(972001, 'awaiting_shipment', 'Casey Fixture', 'ORD-972001')
const shippedMatch = baseRow(982001, 'shipped', 'Riley Globalsearch', 'SHIPPED-982001', {
  selectedRate: rate,
  label: { trackingNumber: '1Z999AA1010982001', carrierCode: 'ups', serviceCode: 'ups_ground', shippingProviderId: 7381, cost: 9.86, createdAt: '2026-06-11T17:02:00.000Z', labelUrl: 'https://example.com/label.pdf' },
  shipping: { carrierCode: 'ups', serviceCode: 'ups_ground', trackingNumber: '1Z999AA1010982001', providerAccountId: 7381, accountNickname: 'ROCEL C81F70', labelCost: 9.86, labelCreatedAt: '2026-06-11T17:02:00.000Z', selectedRate: rate, bestRate: rate },
})
const cancelledMatch = baseRow(992001, 'cancelled', 'Riley Globalsearch', 'CANCELLED-992001')

const ordersByStatus = {
  awaiting_shipment: [awaitingLocal],
  shipped: [shippedMatch],
  cancelled: [cancelledMatch],
}
const allRows = [awaitingLocal, shippedMatch, cancelledMatch]

const countRows = [
  { orderStatus: 'awaiting_shipment', cnt: 1 },
  { orderStatus: 'shipped', cnt: 1 },
  { orderStatus: 'cancelled', cnt: 1 },
]

// Every /orders request the app makes, for asserting the wire contract.
const ordersRequests = []

function rowMatchesSearch(row, search) {
  const needle = search.toLowerCase()
  return (
    String(row.shipToName ?? '').toLowerCase().includes(needle) ||
    String(row.orderNumber ?? '').toLowerCase().includes(needle)
  )
}

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
  if (url.pathname === '/orders/sync/status') return json({ status: 'idle', lastSyncAt: '2026-06-12T00:00:00.000Z' })
  if (url.pathname === '/shipments/status') return json({ status: 'idle' })
  if (url.pathname === '/init/stores') {
    return json({ data: clients.map((client) => ({ id: client.storeId, storeId: client.storeId, name: client.name, storeName: client.name, clientName: client.name, clientId: client.id, active: client.active, isTest: client.isTest })) })
  }
  if (url.pathname === '/init/counts') return json({ byStatus: countRows, byStatusStore: [] })
  if (url.pathname === '/clients/order-stats') {
    return json({ data: clients.map((client) => ({ clientId: client.id, awaiting_shipment: 1, shipped: 1, cancelled: 1 })) })
  }
  if (url.pathname === '/orders/distinct-skus') return json({ skus: ['FAKE-SKU-1'] })
  if (url.pathname === '/orders') {
    const status = url.searchParams.get('status') || 'awaiting_shipment'
    const search = (url.searchParams.get('search') ?? '').trim()
    const searchScope = url.searchParams.get('searchScope')
    ordersRequests.push({ status, search, searchScope })
    // PS-210 wire contract: cross-status rows come back ONLY for a non-empty
    // search carrying the explicit global scope — exactly the backend rule.
    let data
    if (search && searchScope === 'global') {
      data = allRows.filter((row) => rowMatchesSearch(row, search))
    } else if (search) {
      data = (ordersByStatus[status] ?? []).filter((row) => rowMatchesSearch(row, search))
    } else {
      data = ordersByStatus[status] ?? []
    }
    return json({ data, pagination: { page: 1, pageSize: 50, total: data.length, totalPages: 1 } })
  }
  const orderFull = url.pathname.match(/^\/orders\/(\d+)\/full$/)
  if (orderFull) {
    const id = Number(orderFull[1])
    const order = allRows.find((candidate) => candidate.id === id)
    return json(order ?? baseRow(id, 'awaiting_shipment', 'Casey Fixture', `ORD-${id}`))
  }

  return json({})
}

async function setup(page) {
  ordersRequests.length = 0
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

const searchInput = (page) => page.getByPlaceholder('Search orders, SKUs, names…')

async function searchAndExpectGlobalMatches(page, tab, screenshotName) {
  await page.setViewportSize({ width: 1680, height: 950 })
  await setup(page)
  await page.goto(`${baseUrl}/orders/${tab}`)
  await page.waitForSelector('#ordersTable tbody tr.order-row', { state: 'visible' })
  if (tab !== 'cancelled') {
    await expect(page.locator('#daily-strip')).toContainText(/63\s*Total Orders/)
  }

  await searchInput(page).fill('Riley Globalsearch')
  // Both lifecycle matches surface regardless of the active tab.
  await expect(page.locator(`#row-${shippedMatch.orderId}`)).toHaveCount(1)
  await expect(page.locator(`#row-${cancelledMatch.orderId}`)).toHaveCount(1)
  // The honest pill: the claim is now true (and discloses the date filter).
  await expect(page.getByText(/Searching all statuses & stores/)).toBeVisible()
  // Off-tab rows are labeled with their REAL status — a shipped match on a
  // non-shipped tab can never read as an awaiting order.
  if (tab !== 'shipped') {
    await expect(
      page.locator(`#row-${shippedMatch.orderId} [data-testid="off-tab-status-pill"]`),
    ).toHaveText(/shipped/i)
  }
  if (tab !== 'cancelled') {
    await expect(
      page.locator(`#row-${cancelledMatch.orderId} [data-testid="off-tab-status-pill"]`),
    ).toHaveText(/cancelled/i)
  }
  // The wire carried the explicit global intent (backend rule, not a UI trick).
  expect(
    ordersRequests.some((req) => req.search.toLowerCase().includes('riley') && req.searchScope === 'global'),
    'the table fetch must declare searchScope=global with the non-empty search',
  ).toBe(true)
  await page.screenshot({ path: path.join(screenshotDir, screenshotName), fullPage: true })
}

test('From Awaiting: a SHIPPED + CANCELLED customer match surfaces with real-status pills; clearing restores the tab', async ({ page }) => {
  await searchAndExpectGlobalMatches(page, 'awaiting_shipment', 'from-awaiting.png')

  // The shipped row keeps its real shipped identity (status pill above) and
  // the awaiting-local row of a DIFFERENT customer is filtered out.
  await expect(page.locator(`#row-${awaitingLocal.orderId}`)).toHaveCount(0)

  // Clearing the search restores normal tab-local rows…
  await page.locator('#searchClear').click()
  await expect(page.locator(`#row-${awaitingLocal.orderId}`)).toHaveCount(1)
  await expect(page.locator(`#row-${shippedMatch.orderId}`)).toHaveCount(0)
  await expect(page.locator(`#row-${cancelledMatch.orderId}`)).toHaveCount(0)
  // …and the empty-search request drops the global scope (tab-local again).
  await expect.poll(
    () => ordersRequests[ordersRequests.length - 1]?.search,
    { message: 'the debounced table request must observe the cleared search' },
  ).toBe('')
  const lastRequest = ordersRequests[ordersRequests.length - 1]
  expect(lastRequest.search).toBe('')
  expect(lastRequest.searchScope).toBe(null)
  await page.screenshot({ path: path.join(screenshotDir, 'after-clear.png'), fullPage: true })
})

test('From Shipped: the same global search surfaces the cancelled match too', async ({ page }) => {
  await searchAndExpectGlobalMatches(page, 'shipped', 'from-shipped.png')
  // On its OWN tab the shipped row carries no off-tab pill — it is not off-tab.
  await expect(
    page.locator(`#row-${shippedMatch.orderId} [data-testid="off-tab-status-pill"]`),
  ).toHaveCount(0)
})

test('From Cancelled: the same global search surfaces the shipped match too', async ({ page }) => {
  await searchAndExpectGlobalMatches(page, 'cancelled', 'from-cancelled.png')
  await expect(
    page.locator(`#row-${cancelledMatch.orderId} [data-testid="off-tab-status-pill"]`),
  ).toHaveCount(0)
})
