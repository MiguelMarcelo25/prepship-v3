import { test, expect } from 'playwright/test'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// PS-218 — Orders search must show a Searching… spinner instead of a false
// "No orders match" while the server search is in flight.
//
// Operator report: searching `laura` took ~10s; during the wait the table area
// showed "No orders match", so the operator thought there were no matches.
//
// This suite drives the rendered behavior against a /orders mock that DELAYS
// any request carrying a non-empty `search` (simulating the slow server
// search) while answering all other requests immediately. It proves:
//   - typing a search shows the in-flight Searching… state;
//   - "No orders match" does NOT appear while the request is delayed;
//   - matching rows render once the delayed response returns;
//   - a confirmed zero-result search shows "No orders match" only AFTER the
//     request settles;
//   - an API failure shows the error state, never a false no-match.
//
// All fixture names are FAKE. No live calls, labels, postage, or marketplace
// notifications: every network response is mocked via page.route.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const screenshotDir = path.resolve(__dirname, '../../reports/orders-search-loading')
const baseUrl = 'http://127.0.0.1:5177'
const apiOrigin = 'http://127.0.0.1:3000'
const supabaseProjectRef = 'fdkseckgfuvdczzqmnac'
// Long enough that the in-flight assertions (spinner visible, no-match absent)
// always run BEFORE the delayed search response arrives.
const SEARCH_DELAY_MS = 2000

test.beforeAll(async () => {
  await mkdir(screenshotDir, { recursive: true })
})

const clients = [{ id: 1, name: 'KF Goods', active: true, isTest: false, storeId: 101 }]

function baseRow(id, customerName, orderNumber) {
  return {
    id,
    orderId: id,
    orderNumber,
    orderStatus: 'awaiting_shipment',
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
    overrides: { rateWeightOz: 60, rateDimsL: 11, rateDimsW: 8, rateDimsH: 6 },
    bestRate: null,
    selectedRate: null,
    label: null,
    shipping: null,
    externallyShipped: false,
  }
}

// The awaiting tab's resting row is a DIFFERENT customer than the search term,
// so filtering the placeholder rows by "laura" yields zero — the exact
// condition that produced the false "No orders match" before this fix.
const restingRow = baseRow(973101, 'Casey Fixture', 'ORD-973101')
const lauraRow = baseRow(973102, 'Laura Test', 'ORD-973102')

const countRows = [
  { orderStatus: 'awaiting_shipment', cnt: 1 },
  { orderStatus: 'shipped', cnt: 0 },
  { orderStatus: 'cancelled', cnt: 0 },
]

function json(body) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) }
}

// Non-/orders endpoints — answered immediately.
function staticResponseFor(url) {
  if (url.hostname.endsWith('supabase.co')) return json({ user: null })
  const isApiRequest = url.origin === apiOrigin || url.origin !== baseUrl || url.pathname.startsWith('/api/')
  if (!isApiRequest) return null
  if (url.pathname === '/clients') return json(clients)
  if (url.pathname === '/users') return json({ users: [{ id: 'u1', email: 'operator@example.com', isAdmin: true }] })
  if (url.pathname === '/markups') return json({ data: [] })
  if (url.pathname === '/locations') return json([{ id: 1, name: 'GWH Fulfillment Center', company: 'PrepShip', street1: '123 Warehouse Way', city: 'Gardena', state: 'CA', postalCode: '90248', country: 'US', phone: null, isDefault: true, active: true }])
  if (url.pathname === '/packages') return json([{ id: 1, name: '11x8x6', length: 11, width: 8, height: 6, unitCost: '0.62', source: 'custom' }])
  if (url.pathname === '/rates/multi') return json({ carriers: [] })
  if (url.pathname === '/api/carrier-accounts') return json({ data: [] })
  if (url.pathname === '/settings/orders.columnPrefs') return json({ value: null })
  if (url.pathname === '/orders/sync/status') return json({ status: 'idle', lastSyncAt: '2026-06-12T00:00:00.000Z' })
  if (url.pathname === '/shipments/status') return json({ status: 'idle' })
  if (url.pathname === '/init/stores') return json({ data: clients.map((c) => ({ id: c.storeId, storeId: c.storeId, name: c.name, storeName: c.name, clientName: c.name, clientId: c.id, active: c.active, isTest: c.isTest })) })
  if (url.pathname === '/init/counts') return json({ byStatus: countRows, byStatusStore: [] })
  if (url.pathname === '/clients/order-stats') return json({ data: clients.map((c) => ({ clientId: c.id, awaiting_shipment: 1, shipped: 0, cancelled: 0 })) })
  if (url.pathname === '/orders/distinct-skus') return json({ skus: ['FAKE-SKU-1'] })
  const orderFull = url.pathname.match(/^\/orders\/(\d+)\/full$/)
  if (orderFull) {
    const id = Number(orderFull[1])
    const order = [restingRow, lauraRow].find((c) => c.id === id)
    return json(order ?? baseRow(id, 'Casey Fixture', `ORD-${id}`))
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
    if (url.pathname === '/orders') {
      const search = (url.searchParams.get('search') ?? '').trim().toLowerCase()
      if (search) {
        // Simulate the slow server search the operator hit.
        await new Promise((resolve) => setTimeout(resolve, SEARCH_DELAY_MS))
        if (search.includes('boom')) {
          await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'search_failed' }) })
          return
        }
        const data = search.includes('laura') ? [lauraRow] : []
        await route.fulfill(json({ data, pagination: { page: 1, pageSize: 50, total: data.length, totalPages: 1 } }))
        return
      }
      // Empty search → the resting tab row, immediately.
      await route.fulfill(json({ data: [restingRow], pagination: { page: 1, pageSize: 50, total: 1, totalPages: 1 } }))
      return
    }
    const mocked = staticResponseFor(url)
    if (mocked) {
      await route.fulfill(mocked)
      return
    }
    await route.continue()
  })
}

const searchInput = (page) => page.getByPlaceholder('Search orders, SKUs, names…')

test('a slow search shows the Searching… state, never a false No orders match, then renders the match', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 950 })
  await setup(page)
  await page.goto(`${baseUrl}/orders/awaiting_shipment`)
  await page.waitForSelector('#ordersTable tbody tr.order-row', { state: 'visible' })
  await expect(page.locator(`#row-${restingRow.orderId}`)).toHaveCount(1)

  await searchInput(page).fill('laura')

  // While the delayed search is in flight: the spinner is shown and the false
  // empty state is NOT. (The placeholder rows filtered by "laura" are empty —
  // pre-fix this rendered "No orders match".)
  await expect(page.getByTestId('orders-searching')).toBeVisible()
  await expect(page.locator('#emptyState')).toHaveCount(0)
  await page.screenshot({ path: path.join(screenshotDir, 'searching-in-flight.png'), fullPage: true })

  // After the delayed response returns, the matching row renders and the
  // spinner clears.
  await expect(page.locator(`#row-${lauraRow.orderId}`)).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId('orders-searching')).toHaveCount(0)
  await expect(page.locator('#emptyState')).toHaveCount(0)
  await page.screenshot({ path: path.join(screenshotDir, 'search-results.png'), fullPage: true })
})

test('a confirmed zero-result search shows No orders match only AFTER the request settles', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 950 })
  await setup(page)
  await page.goto(`${baseUrl}/orders/awaiting_shipment`)
  await page.waitForSelector('#ordersTable tbody tr.order-row', { state: 'visible' })

  await searchInput(page).fill('nobodyhere')

  // In flight: spinner, not the empty state.
  await expect(page.getByTestId('orders-searching')).toBeVisible()
  await expect(page.locator('#emptyState')).toHaveCount(0)

  // Settled with zero rows: NOW the honest empty state appears and the spinner
  // is gone.
  await expect(page.locator('#emptyState')).toBeVisible({ timeout: 15000 })
  await expect(page.getByText('No orders match')).toBeVisible()
  await expect(page.getByTestId('orders-searching')).toHaveCount(0)
})

test('a failed search shows the error state, never a false No orders match', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 950 })
  await setup(page)
  await page.goto(`${baseUrl}/orders/awaiting_shipment`)
  await page.waitForSelector('#ordersTable tbody tr.order-row', { state: 'visible' })

  await searchInput(page).fill('boom')

  // In flight: spinner, not the empty state.
  await expect(page.getByTestId('orders-searching')).toBeVisible()
  await expect(page.locator('#emptyState')).toHaveCount(0)

  // After the failure settles (delay + one retry), the error state renders and
  // the false no-match never appears.
  await expect(page.getByText('Failed to load orders')).toBeVisible({ timeout: 20000 })
  await expect(page.locator('#emptyState')).toHaveCount(0)
})
