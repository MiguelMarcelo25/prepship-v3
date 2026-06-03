// PS-076 — Awaiting/Orders daily strip must NOT disappear when
// /orders/daily-stats is delayed, skipped, fails, times out, or returns the
// older { summary: ... } compat shape.
//
// Browser coverage with mocked API responses (fake fixture data only — no real
// customer/recipient PII, no labels, no postage, no marketplace calls):
//   A) daily-stats succeeds            -> strip renders normal stats/progress
//   B) first daily-stats request 500s  -> strip still renders an unavailable
//                                         (retry) state, NOT a missing strip
//   C) retry succeeds                  -> strip updates to normal stats with no
//                                         page refresh
//   D) older { summary: ... } shape    -> strip renders normal stats
import { test, expect } from 'playwright/test'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const screenshotDir = path.resolve(__dirname, '../../reports/orders-daily-strip')
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

// A minimal awaiting order so the Orders view fully mounts and the daily strip
// region renders. Fake data only.
function makeOrder(id) {
  return {
    id,
    orderId: id,
    orderNumber: `114-5414667-${id}`,
    orderStatus: 'awaiting_shipment',
    orderDate: '2026-06-02T02:11:00.000Z',
    externalOrderId: `external-${id}`,
    clientId: 1,
    storeId: 101,
    customerEmail: `operator-${id}@example.com`,
    shipToName: 'Test Picker',
    shipToCity: 'El Reno',
    shipToState: 'OK',
    shipToPostalCode: '73036',
    orderTotal: 16.99,
    shippingAmount: 7.3,
    weightOz: 60,
    items: [{ name: 'Booster Gel', sku: 'Booster-gel-001', quantity: 1, unitPrice: 16.99, imageUrl: '' }],
    raw: { shipTo: { name: 'Test Picker', city: 'El Reno', state: 'OK', postalCode: '73036', country: 'US' } },
    bestRate: null,
    selectedRate: null,
    label: null,
    shipping: null,
  }
}

const awaitingOrders = [makeOrder(970001), makeOrder(970002)]

// The boss-approved DTO: 63 total / 5 need -> 58 shipped, 92%. Labels carry the
// server's "PT" suffix so we can also prove the CA normalization survives.
const STATS_WINDOW = {
  from: '2026-06-02T19:00:00.000Z',
  to: '2026-06-03T19:00:00.000Z',
  fromLabel: 'Jun 2, 12pm PT',
  toLabel: 'Jun 3, 12pm PT',
}
const statsTopLevel = { totalOrders: 63, needToShip: 5, upcomingOrders: 4, window: STATS_WINDOW }
const statsSummaryShape = { summary: { totalOrders: 63, needToShip: 5, upcomingOrders: 4, window: STATS_WINDOW } }

function json(body) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) }
}

const countRows = [{ orderStatus: 'awaiting_shipment', cnt: awaitingOrders.length }]
const countStoreRows = [{ orderStatus: 'awaiting_shipment', storeId: 101, cnt: awaitingOrders.length }]

function baseResponseFor(url) {
  if (url.hostname.endsWith('supabase.co')) return json({ user: null })

  const isApiRequest = url.origin === apiOrigin || url.origin !== baseUrl || url.pathname.startsWith('/api/')
  if (!isApiRequest) return null

  if (url.pathname === '/clients') return json(clients)
  if (url.pathname === '/users') return json({ users: [{ id: 'u1', email: 'operator@example.com', isAdmin: true }] })
  if (url.pathname === '/locations') {
    return json([
      { id: 1, name: 'GWH Fulfillment Center', company: 'PrepShip', street1: '123 Warehouse Way', city: 'Gardena', state: 'CA', postalCode: '90248', country: 'US', phone: null, isDefault: true, active: true },
    ])
  }
  if (url.pathname === '/packages') return json([{ id: 1, name: '11x8x6', length: 11, width: 8, height: 6, unitCost: '0.62', source: 'custom' }])
  if (url.pathname === '/rates/multi') return json({ carriers: [] })
  if (url.pathname === '/api/carrier-accounts') return json({ data: [] })
  if (url.pathname === '/settings/orders.columnPrefs') return json({ value: null })
  if (url.pathname === '/orders/sync/status') return json({ status: 'idle', lastSyncAt: '2026-06-02T00:00:00.000Z' })
  if (url.pathname === '/shipments/status') return json({ status: 'idle' })
  if (url.pathname === '/init/stores') {
    return json({ data: clients.map((c) => ({ id: c.storeId, storeId: c.storeId, name: c.name, storeName: c.name, clientName: c.name, clientId: c.id, active: c.active, isTest: c.isTest })) })
  }
  if (url.pathname === '/init/counts') return json({ byStatus: countRows, byStatusStore: countStoreRows })
  if (url.pathname === '/clients/order-stats') {
    return json({ data: clients.map((c) => ({ clientId: c.id, awaiting_shipment: 1, shipped: 1, cancelled: 1 })) })
  }
  if (url.pathname === '/orders/distinct-skus') return json({ skus: ['Booster-gel-001'] })
  if (url.pathname === '/orders') {
    return json({ data: awaitingOrders, pagination: { page: 1, pageSize: 50, total: awaitingOrders.length, totalPages: 1 } })
  }
  const orderFull = url.pathname.match(/^\/orders\/(\d+)\/full$/)
  if (orderFull) {
    const id = Number(orderFull[1])
    return json(awaitingOrders.find((o) => o.id === id) ?? makeOrder(id))
  }
  return json({})
}

// `daily` is a mutable controller so a single mounted page can be flipped from
// failure to success (proving retry works without a page refresh).
async function setup(page, daily) {
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
    // Daily-stats is the unit under test — answer it from the mutable controller
    // BEFORE the generic catch-all.
    if (url.pathname === '/orders/daily-stats') {
      daily.calls += 1
      const next = daily.next()
      if (next.kind === 'fail') {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'mocked daily-stats failure' }) })
        return
      }
      await route.fulfill(json(next.body))
      return
    }
    const mocked = baseResponseFor(url)
    if (mocked) {
      await route.fulfill(mocked)
      return
    }
    await route.continue()
  })
}

async function gotoAwaiting(page) {
  await page.goto(`${baseUrl}/orders/awaiting_shipment`)
  await page.waitForSelector('#ordersTable tbody tr.order-row', { state: 'visible' })
  // The strip container must exist for awaiting regardless of daily-stats state.
  await expect(page.locator('#daily-strip')).toHaveCount(1)
}

test('A: daily-stats success renders the strip stats + progress', async ({ page }) => {
  const daily = { calls: 0, next: () => ({ kind: 'ok', body: statsTopLevel }) }
  await page.setViewportSize({ width: 1440, height: 900 })
  await setup(page, daily)
  await gotoAwaiting(page)

  const strip = page.locator('#daily-strip')
  await expect(strip).toContainText('Total Orders', { timeout: 10_000 })
  await expect(strip).toContainText('Need to Ship')
  await expect(strip).toContainText('Upcoming')
  await expect(strip).toContainText('58 of 63 shipped')
  await expect(strip).toContainText('92%')
  // boss-approved CA label normalization: server "PT" is shown as "CA".
  await expect(strip).toContainText('Jun 2, 12pm CA')
  await expect(strip).not.toContainText('PT')

  await page.screenshot({ path: path.join(screenshotDir, 'A-success.png'), fullPage: true })
})

test('B+C: first failure shows an unavailable/retry strip, retry recovers without refresh', async ({ page }) => {
  // First daily-stats call fails; every call after the first succeeds.
  const daily = {
    calls: 0,
    next() {
      return this.calls === 1 ? { kind: 'fail' } : { kind: 'ok', body: statsTopLevel }
    },
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await setup(page, daily)
  await gotoAwaiting(page)

  // Scenario B: strip is STILL present and offers a retry — never missing.
  const strip = page.locator('#daily-strip')
  const retry = page.getByRole('button', { name: /Daily stats unavailable/i })
  await expect(retry).toBeVisible({ timeout: 10_000 })
  await expect(strip).toHaveCount(1)
  await page.screenshot({ path: path.join(screenshotDir, 'B-first-failure-fallback.png'), fullPage: true })

  // Scenario C: click retry (no navigation) -> stats appear.
  const urlBefore = page.url()
  await retry.click()
  await expect(strip).toContainText('58 of 63 shipped', { timeout: 10_000 })
  await expect(strip).toContainText('92%')
  expect(page.url()).toBe(urlBefore) // recovered without a page refresh
  await page.screenshot({ path: path.join(screenshotDir, 'C-retry-success.png'), fullPage: true })
})

test('D: older { summary: ... } compat shape renders normal stats', async ({ page }) => {
  const daily = { calls: 0, next: () => ({ kind: 'ok', body: statsSummaryShape }) }
  await page.setViewportSize({ width: 1440, height: 900 })
  await setup(page, daily)
  await gotoAwaiting(page)

  const strip = page.locator('#daily-strip')
  await expect(strip).toContainText('58 of 63 shipped', { timeout: 10_000 })
  await expect(strip).toContainText('92%')
  await expect(strip).toContainText('Jun 3, 12pm CA')
  await page.screenshot({ path: path.join(screenshotDir, 'D-summary-shape.png'), fullPage: true })
})
