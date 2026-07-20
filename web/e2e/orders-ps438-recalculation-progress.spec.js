import { test, expect } from 'playwright/test'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ORDERS_DAILY_STATS_WIRE } from './orders-daily-stats-wire.js'

// PS-438 rendered proof. Every request is mocked; this suite cannot buy labels,
// spend postage, notify a marketplace, or mutate production order data.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const screenshotDir = path.resolve(__dirname, '../../docs/ps-tickets/evidence/ps-438')
const baseUrl = 'http://127.0.0.1:5177'
const apiOrigin = 'http://127.0.0.1:3000'
const supabaseProjectRef = 'fdkseckgfuvdczzqmnac'

test.beforeAll(async () => {
  await mkdir(screenshotDir, { recursive: true })
})

const clients = [{ id: 1, name: 'PS-438 Fixture Client', active: true, isTest: false, storeId: 101 }]
const order = {
  id: 438001,
  orderId: 438001,
  orderNumber: 'PS438-FIXTURE-001',
  orderStatus: 'awaiting_shipment',
  orderDate: '2026-07-20T18:11:00.000Z',
  externalOrderId: 'ps438-fixture-external',
  clientId: 1,
  storeId: 101,
  customerEmail: 'ps438-fixture@example.test',
  shipToName: 'PS-438 Fixture Customer',
  shipToCity: 'Gardena',
  shipToState: 'CA',
  shipToPostalCode: '90248',
  orderTotal: 24.99,
  shippingAmount: 8.25,
  weightOz: 32,
  items: [{ name: 'Fixture Product', sku: 'PS438-SKU', quantity: 1, unitPrice: 24.99, imageUrl: '' }],
  raw: {
    shipTo: { name: 'PS-438 Fixture Customer', street1: '123 Fixture Way', city: 'Gardena', state: 'CA', postalCode: '90248', country: 'US' },
    dimensions: { length: 10, width: 8, height: 4 },
  },
  overrides: { rateWeightOz: 32, rateDimsL: 10, rateDimsW: 8, rateDimsH: 4 },
  bestRate: null,
  selectedRate: null,
  label: null,
  shipping: null,
  externallyShipped: false,
}

function json(body, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) }
}

function baseResponseFor(url) {
  if (url.hostname.endsWith('supabase.co')) return json({ user: null })
  const isApiRequest = url.origin === apiOrigin || url.origin !== baseUrl || url.pathname.startsWith('/api/')
  if (!isApiRequest) return null
  if (url.pathname === '/clients') return json(clients)
  if (url.pathname === '/users') return json({ users: [{ id: 'u1', email: 'operator@example.test', isAdmin: true }] })
  if (url.pathname === '/users/me') return json({ id: 'u1', email: 'operator@example.test', isAdmin: true })
  if (url.pathname === '/markups') return json({ data: [] })
  if (url.pathname === '/locations') return json([{ id: 1, name: 'Fixture Warehouse', street1: '123 Fixture Way', city: 'Gardena', state: 'CA', postalCode: '90248', country: 'US', isDefault: true, active: true }])
  if (url.pathname === '/packages') return json([{ id: 1, name: '10x8x4', length: 10, width: 8, height: 4, unitCost: '0.50', source: 'custom' }])
  if (url.pathname === '/rates/multi') return json({ carriers: [] })
  if (url.pathname === '/api/carrier-accounts') return json({ data: [] })
  if (url.pathname === '/settings/orders.columnPrefs') return json({ value: null })
  if (url.pathname === '/settings/hugrab-default-insurance') return json({ value: true })
  if (url.pathname === '/orders/daily-stats') return json(ORDERS_DAILY_STATS_WIRE)
  if (url.pathname === '/orders/sync/status') return json({ status: 'idle', lastSyncAt: '2026-07-20T20:00:00.000Z' })
  if (url.pathname === '/shipments/status') return json({ status: 'idle' })
  if (url.pathname === '/init/stores') return json({ data: clients.map((client) => ({ id: client.storeId, storeId: client.storeId, name: client.name, storeName: client.name, clientName: client.name, clientId: client.id, active: true, isTest: false })) })
  if (url.pathname === '/init/counts') return json({ byStatus: [{ orderStatus: 'awaiting_shipment', cnt: 20 }], byStatusStore: [] })
  if (url.pathname === '/clients/order-stats') return json({ data: [{ clientId: 1, awaiting_shipment: 20, shipped: 0, cancelled: 0 }] })
  if (url.pathname === '/orders/distinct-skus') return json({ skus: ['PS438-SKU'] })
  if (url.pathname === '/orders') return json({ data: [order], pagination: { page: 1, pageSize: 50, total: 20, totalPages: 1 } })
  if (url.pathname === `/orders/${order.id}/full`) return json(order)
  return json({})
}

async function seedSession(page) {
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
        user: { id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated', email: 'operator@example.test' },
      }),
    )
  }, supabaseProjectRef)
}

async function openAwaiting(page, routeHandler) {
  await seedSession(page)
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (await routeHandler(route, url)) return
    const mocked = baseResponseFor(url)
    if (mocked) return route.fulfill(mocked)
    return route.continue()
  })
  await page.goto(`${baseUrl}/orders/awaiting_shipment`)
  await page.waitForSelector('#ordersTable tbody tr.order-row', { state: 'visible' })
}

test('manual and full-live jobs render preparing, partial, complete, and error progress', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const postedBodies = []
  let nextJob = 0
  const jobs = new Map()

  await openAwaiting(page, async (route, url) => {
    if (url.pathname === '/rates/backfill-best/latest') {
      await route.fulfill(json({ job: null, durableJob: null, generation: null }))
      return true
    }
    if (url.pathname === '/rates/backfill-best' && route.request().method() === 'POST') {
      const body = route.request().postDataJSON()
      postedBodies.push(body)
      const jobId = `ps438-browser-${++nextJob}`
      jobs.set(jobId, { jobId, status: 'pending', processed: 0, total: 0, updated: 0, skipped: 0, failed: 0, message: 'Querying orders...' })
      await route.fulfill(json({ job_id: jobId, status: 'pending' }))
      return true
    }
    const statusMatch = url.pathname.match(/^\/rates\/backfill-best\/status\/(.+)$/)
    if (statusMatch) {
      await route.fulfill(json(jobs.get(decodeURIComponent(statusMatch[1])) ?? { error: 'Job not found' }, jobs.has(decodeURIComponent(statusMatch[1])) ? 200 : 404))
      return true
    }
    return false
  })

  await page.getByRole('button', { name: 'Recalculate All' }).click()
  const progress = page.locator('[data-recalculate-all-progress]')
  await expect(progress).toContainText('Preparing recalculation')
  await expect(progress.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
  await progress.screenshot({ path: path.join(screenshotDir, '01-preparing.png') })
  expect(postedBodies[0]).toMatchObject({ mode: 'cache_first', maxAgeHours: 6 })

  jobs.set('ps438-browser-1', { jobId: 'ps438-browser-1', status: 'running', processed: 5, total: 20, updated: 4, skipped: 1, failed: 0, message: 'Rating awaiting orders' })
  await expect(progress).toContainText('25%', { timeout: 6_000 })
  await expect(progress).toContainText('Completed 5')
  await expect(progress).toContainText('Remaining 15')
  await expect(progress).toContainText('Total 20')
  await expect(progress.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25')
  await page.setViewportSize({ width: 900, height: 900 })
  const partialBox = await progress.boundingBox()
  expect(partialBox).not.toBeNull()
  expect(partialBox.x + partialBox.width).toBeLessThanOrEqual(900)
  await progress.screenshot({ path: path.join(screenshotDir, '02-partial.png') })

  jobs.set('ps438-browser-1', { jobId: 'ps438-browser-1', status: 'done', processed: 20, total: 20, updated: 18, skipped: 1, failed: 1, message: 'Complete' })
  await expect(progress).toContainText('100%', { timeout: 6_000 })
  await expect(progress).toContainText('Failed 1')
  await expect(progress).toContainText('Skipped 1')
  await progress.screenshot({ path: path.join(screenshotDir, '03-complete.png') })

  await page.getByRole('button', { name: 'Full Live Audit' }).click()
  expect(postedBodies[1]).toMatchObject({ mode: 'full_live_audit', maxAgeHours: 0 })
  await expect(progress).toContainText('Preparing recalculation')
  jobs.set('ps438-browser-2', { jobId: 'ps438-browser-2', status: 'error', processed: 8, total: 20, updated: 6, skipped: 1, failed: 1, message: 'Carrier timeout', error: 'Carrier timeout. Retry the full live audit.' })
  await expect(progress).toContainText('Recalculation needs attention', { timeout: 6_000 })
  await expect(progress).toContainText('40%')
  await expect(progress).toContainText('Remaining 12')
  await expect(progress).toContainText('Retry the full live audit')
  await progress.screenshot({ path: path.join(screenshotDir, '04-error.png') })
})

test('refresh restores only backend-identified manual progress', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  let latestCalls = 0
  await openAwaiting(page, async (route, url) => {
    if (url.pathname === '/rates/backfill-best/latest') {
      latestCalls += 1
      await route.fulfill(json({
        job: { jobId: 'manual-refresh', status: 'running', processed: 7, total: 20, updated: 6, skipped: 0, failed: 0, message: 'Continuing manual recalculation' },
        generation: { generationId: 'manual-refresh', status: 'active', requestedBy: 'manual' },
      }))
      return true
    }
    if (url.pathname === '/rates/backfill-best/status/manual-refresh') {
      await route.fulfill(json({ jobId: 'manual-refresh', status: 'running', processed: 7, total: 20, updated: 6, skipped: 0, failed: 0, message: 'Continuing manual recalculation' }))
      return true
    }
    return false
  })
  await expect.poll(() => latestCalls).toBeGreaterThan(0)
  await expect(page.locator('[data-recalculate-all-progress]')).toContainText('35%')
})

test('cadence work refreshes rows without impersonating an operator click', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  let latestCalls = 0
  await openAwaiting(page, async (route, url) => {
    if (url.pathname === '/rates/backfill-best/latest') {
      latestCalls += 1
      await route.fulfill(json({
        job: { jobId: 'cadence-refresh', status: 'running', processed: 7, total: 20, updated: 6, skipped: 0, failed: 0, message: 'Cadence refresh' },
        generation: { generationId: 'cadence-refresh', status: 'active', requestedBy: 'cadence' },
      }))
      return true
    }
    if (url.pathname === '/rates/backfill-best/status/cadence-refresh') {
      await route.fulfill(json({ jobId: 'cadence-refresh', status: 'running', processed: 7, total: 20, updated: 6, skipped: 0, failed: 0, message: 'Cadence refresh' }))
      return true
    }
    return false
  })
  await expect.poll(() => latestCalls).toBeGreaterThan(0)
  await expect(page.locator('[data-recalculate-all-progress]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Recalculate All' })).toBeEnabled()
})
