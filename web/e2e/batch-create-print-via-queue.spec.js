// Batch-print pipeline browser smoke (design: docs/superpowers/specs/2026-07-07-batch-print-pipeline-design.md).
// Drives the REAL "Create + Print Label" batch button with BATCH_PRINT_VIA_QUEUE mocked ON.
// Every backend endpoint is intercepted (no real carrier, postage, or marketplace). Asserts the
// chain: POST /print-queue/batch-send → status → POST /print-queue/print with THAT job's entry
// ids — and that the FE never buys (/labels never called).
//
// NOTE: OrdersBatchPanel replaces the right-side detail panel only when the batch selection
// grows to ≥ 2 orders (OrdersView drawer comment), so this harness selects TWO orders.
import { test, expect } from 'playwright/test'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ORDERS_DAILY_STATS_WIRE } from './orders-daily-stats-wire.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ps442ScreenshotDir = path.resolve(__dirname, '../../docs/ps-tickets/evidence/ps-442-queue-progress')
const baseUrl = 'http://127.0.0.1:5177'
const apiOrigin = 'http://127.0.0.1:3000'
const supabaseProjectRef = 'fdkseckgfuvdczzqmnac'

test.beforeAll(async () => {
  await mkdir(ps442ScreenshotDir, { recursive: true })
})

const TEST_CLIENT = { id: 3, name: '__BATCH_PRINT_HARNESS__', active: true, isTest: true, storeId: 103 }

const rate = {
  carrierCode: 'ups', serviceCode: 'ups_ground_saver', serviceName: 'UPS Ground Saver',
  carrierNickname: 'HARNESS', providerAccountNickname: 'HARNESS', shippingProviderId: 7381,
  amount: 9.86, cost: 9.86, shipmentCost: 9.86, otherCost: 0,
}

const PDF_DATAURI = 'data:application/pdf;base64,JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCAyMDAgMjAwXT4+CmVuZG9iagp0cmFpbGVyPDwvUm9vdCAxIDAgUj4+Cg=='

function makeTestOrder(orderId, orderNumber, sku) {
  return {
    id: orderId, orderId, orderNumber, orderStatus: 'awaiting_shipment',
    orderDate: '2026-07-07T02:11:00.000Z', externalOrderId: null, sourceProvider: 'internal',
    clientId: TEST_CLIENT.id, storeId: TEST_CLIENT.storeId, isTestOrdersStore: true,
    customerEmail: 'harness@example.com', shipToName: 'Batch Print Tester',
    shipToCity: 'San Francisco', shipToState: 'CA', shipToPostalCode: '94104',
    orderTotal: 16.99, shippingAmount: 7.3, weightOz: 16,
    items: [{ name: `Batch print item ${sku}`, sku, quantity: 1, unitPrice: 16.99, imageUrl: '' }],
    raw: { shipTo: { name: 'Batch Print Tester', street1: '417 Montgomery St', city: 'San Francisco', state: 'CA', postalCode: '94104', country: 'US', phone: '4150000000' }, dimensions: { length: 8, width: 6, height: 4 } },
    overrides: { rateWeightOz: 16, rateDimsL: 8, rateDimsW: 6, rateDimsH: 4, bestRateJson: rate },
    bestRate: rate, selectedRate: rate, label: null, shipping: null,
    // Backend test-order fact (PS-186): isBackendTestOrder(order) keys off DTO isTest, which
    // makes the chain's needsOverride false — no strict-recalc round-trip in this harness, and
    // the queue payload uses the TEST service codes (backend is fully mocked anyway).
    isTest: true,
  }
}

function json(body) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) }
}

const orders = [
  makeTestOrder(990001, 'HARNESS-BATCH-PRINT-1', 'TEST-BATCH-PRINT-A'),
  makeTestOrder(990002, 'HARNESS-BATCH-PRINT-2', 'TEST-BATCH-PRINT-B'),
]
const ordersById = new Map(orders.map((o) => [String(o.orderId), o]))

function queueEntryFor(order, entryId) {
  return {
    queue_entry_id: entryId, order_id: String(order.orderId), order_number: order.orderNumber,
    client_id: TEST_CLIENT.id, label_url: PDF_DATAURI, sku_group_id: order.items[0].sku,
    primary_sku: order.items[0].sku, item_description: order.items[0].name, order_qty: 1,
    multi_sku_data: null, status: 'queued', print_count: 0, last_printed_at: null,
    auto_retired_at: null, queued_at: '2026-07-07T02:15:00.000Z', shipping_hold: false, held_reason: null,
  }
}

const queueListPayload = {
  queuedOrders: [queueEntryFor(orders[0], 'entry-1'), queueEntryFor(orders[1], 'entry-2')],
  totalOrders: 2, totalQty: 2,
}

function responseFor(url, method) {
  if (url.hostname.endsWith('supabase.co')) return json({ user: null })
  const isApi = url.origin === apiOrigin || url.origin !== baseUrl || url.pathname.startsWith('/api/')
  if (!isApi) return null

  // ── the chain under test ──
  if (url.pathname === '/print-queue/batch-send' && method === 'POST') return json({ job_id: 'qs_e2e', total: 2 })
  if (url.pathname === '/print-queue/batch-send/status/qs_e2e') {
    return json({
      job_id: 'qs_e2e', status: 'done', progress: 100, total: 2, current: 2, queued: 2, failed: 0,
      message: 'done', client_id: TEST_CLIENT.id, queued_entry_ids: ['entry-1', 'entry-2'],
      results: [
        { orderId: 990001, success: true, queueEntryId: 'entry-1', labelUrl: PDF_DATAURI },
        { orderId: 990002, success: true, queueEntryId: 'entry-2', labelUrl: PDF_DATAURI },
      ],
      error: null, durableJob: null,
    })
  }
  if (url.pathname === '/print-queue/print' && method === 'POST') return json({ job_id: 'mg_e2e', total: 2 })
  if (url.pathname === '/print-queue/print/status/mg_e2e') {
    return json({
      job_id: 'mg_e2e', status: 'done', progress: 100, total: 2, current: 2,
      message: 'Done - 2 labels merged.', file_name: 'batch_print_e2e.pdf', error: null,
      label_errors: [], successful_entry_ids: ['entry-1', 'entry-2'], durableJob: null,
    })
  }
  if (url.pathname === '/print-queue/print/signed-url/mg_e2e') {
    return json({ url: `${apiOrigin}/print-queue/print/view/mg_e2e?token=e2e`, expires_at: '2026-07-07T03:00:00.000Z', expires_in_seconds: 300, filename: 'batch_print_e2e.pdf', disposition: 'inline' })
  }
  if (url.pathname === '/print-queue/print/last') return json({ job: null })
  if (url.pathname === '/print-queue' && method === 'GET') return json(queueListPayload)
  if (url.pathname.startsWith('/print-queue')) return json({ ok: true })

  // ── FE must NEVER buy: these return 500 so any hit fails the test loudly ──
  if (url.pathname === '/labels' || url.pathname === '/api/carriers/labels') {
    return { status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'FE MUST NOT BUY' }) }
  }

  // ── identity (the chain is the unconditional batch path since the 2026-07-07 cleanup) ──
  if (url.pathname === '/users/me') {
    return json({ id: 'u1', email: 'operator@example.com', isAdmin: true })
  }

  // ── supporting reads (mirrors carrier-print-to-queue.spec.js) ──
  if (url.pathname === '/api/carriers/rates') return json({ rates: [rate], rateQuoteId: 'rq_e2e', carrierEligibility: null })
  if (url.pathname === '/clients') return json([TEST_CLIENT])
  if (url.pathname === '/users') return json({ users: [{ id: 'u1', email: 'operator@example.com', isAdmin: true }] })
  if (url.pathname === '/locations') return json([{ id: 1, name: 'GWH', company: 'PrepShip', street1: '123 Warehouse Way', city: 'Gardena', state: 'CA', postalCode: '90248', country: 'US', isDefault: true, active: true }])
  if (url.pathname === '/packages') return json([{ id: 1, name: '8x6x4', length: 8, width: 6, height: 4, unitCost: '0.62', source: 'custom' }])
  if (url.pathname === '/api/carrier-accounts') return json({ data: [] })
  if (url.pathname === '/rates/multi') return json({ carriers: [] })
  if (url.pathname === '/settings/orders.columnPrefs') return json({ value: null })
  if (url.pathname === '/orders/daily-stats') return json(ORDERS_DAILY_STATS_WIRE)
  if (url.pathname === '/orders/sync/status') return json({ status: 'idle', lastSyncAt: '2026-07-07T00:00:00.000Z' })
  if (url.pathname === '/shipments/status') return json({ status: 'idle' })
  if (url.pathname === '/init/stores') return json({ data: [{ id: TEST_CLIENT.storeId, storeId: TEST_CLIENT.storeId, name: TEST_CLIENT.name, storeName: TEST_CLIENT.name, clientName: TEST_CLIENT.name, clientId: TEST_CLIENT.id, active: true, isTest: true }] })
  if (url.pathname === '/init/counts') return json({ byStatus: [{ orderStatus: 'awaiting_shipment', cnt: 2 }], byStatusStore: [{ orderStatus: 'awaiting_shipment', storeId: TEST_CLIENT.storeId, cnt: 2 }] })
  if (url.pathname === '/clients/order-stats') return json({ data: [{ clientId: TEST_CLIENT.id, awaiting_shipment: 2, shipped: 0, cancelled: 0 }] })
  if (url.pathname === '/orders/distinct-skus') return json({ skus: ['TEST-BATCH-PRINT-A', 'TEST-BATCH-PRINT-B'] })
  if (url.pathname === '/orders') return json({ data: orders, pagination: { page: 1, pageSize: 50, total: 2, totalPages: 1 } })
  const fullMatch = url.pathname.match(/^\/orders\/(\d+)\/full$/)
  if (fullMatch) return json(ordersById.get(fullMatch[1]) ?? orders[0])
  return json({})
}

async function setup(page) {
  await page.addInitScript((projectRef) => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    window.localStorage.setItem(`sb-${projectRef}-auth-token`, JSON.stringify({
      access_token: 'mock-access-token', refresh_token: 'mock-refresh-token', expires_at: expiresAt, expires_in: 3600, token_type: 'bearer',
      user: { id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated', email: 'operator@example.com' },
    }))
  }, supabaseProjectRef)
  await page.route('**/*', async (route) => {
    const req = route.request()
    const mocked = responseFor(new URL(req.url()), req.method())
    if (mocked) { await route.fulfill(mocked); return }
    await route.continue()
  })
}

test('Create + Print Label with flag ON chains batch-send → print and never buys from the FE', async ({ page }) => {
  const consoleErrors = []
  const failedResponses = []
  const pipelineCalls = []
  let printRequestBody = null
  page.on('pageerror', (err) => consoleErrors.push(String(err)))
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
  page.on('request', (req) => {
    const u = new URL(req.url())
    if (u.pathname === '/print-queue/print' && req.method() === 'POST') {
      try { printRequestBody = JSON.parse(req.postData() ?? 'null') } catch { printRequestBody = null }
    }
    if (/^\/print-queue\/(batch-send|print)$/.test(u.pathname) || u.pathname === '/labels' || u.pathname === '/api/carriers/labels') {
      pipelineCalls.push(`${req.method()} ${u.pathname}`)
    }
  })
  page.on('response', (res) => {
    const u = new URL(res.url())
    if (u.origin === baseUrl && !u.pathname.startsWith('/api/') && !u.pathname.startsWith('/labels') && !u.pathname.startsWith('/print-queue')) return
    if (res.status() >= 400) failedResponses.push(`${res.status()} ${u.pathname}`)
  })

  const ordersListCalls = []
  let ordersCallsAtBatchSend = null
  let ordersCallsAtPrint = null
  page.on('request', (req) => {
    const u = new URL(req.url())
    if (u.pathname === '/orders' && req.method() === 'GET') ordersListCalls.push(u.search)
    if (req.method() === 'POST' && u.pathname === '/print-queue/batch-send') ordersCallsAtBatchSend = ordersListCalls.length
    if (req.method() === 'POST' && u.pathname === '/print-queue/print') ordersCallsAtPrint = ordersListCalls.length
  })

  await page.setViewportSize({ width: 1440, height: 900 })
  await setup(page)
  await page.goto(`${baseUrl}/orders/awaiting_shipment`)
  await page.waitForSelector('#ordersTable tbody tr.order-row', { state: 'visible' })
  await expect(page.locator('#daily-strip')).toContainText(/63\s*Total Orders/)

  // Select BOTH orders — the batch panel replaces the detail panel at selection ≥ 2.
  const checkboxes = page.locator('#ordersTable tbody tr.order-row input[type="checkbox"]')
  await checkboxes.nth(0).check()
  await checkboxes.nth(1).check()
  await page.waitForSelector('[data-testid="orders-selection-toolbar"]', { state: 'visible' })

  const batchButton = page.getByRole('button', { name: '🖨️ Create + Print Label' })
  await batchButton.waitFor({ state: 'visible' })

  await batchButton.click()

  // batch-send poll (750ms) + print poll (600ms) + signed-url — give the chain room.
  await page.waitForTimeout(5000)

  expect(pipelineCalls, 'chain order').toEqual(['POST /print-queue/batch-send', 'POST /print-queue/print'])
  expect(printRequestBody?.queue_entry_ids, 'print uses the job-returned entry ids').toEqual(['entry-1', 'entry-2'])
  // Fade directive: the chain defers the orders refetch to the per-row 30s timers. A
  // non-deferred refetch would land BETWEEN the buy job and the print call, so assert
  // that window is clean (background pollers outside the chain can fire whenever).
  expect(ordersCallsAtPrint, 'no orders refetch between batch-send and print (deferred to fade timers)').toBe(ordersCallsAtBatchSend)
  expect(failedResponses, `failed API responses: ${failedResponses.join(', ')}`).toEqual([])
  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([])
})

test('PS-444 interrupted batch renders backend recovery outcomes and resumes by job id only', async ({ page }) => {
  let resumed = false
  let resumeCalls = 0
  let resumeRequestBody = null
  let printCalls = 0

  await page.setViewportSize({ width: 1440, height: 900 })
  await setup(page)
  await page.route('**/print-queue/batch-send/status/qs_e2e', async (route) => {
    const outcomes = resumed
      ? [
          { orderId: 990001, orderNumber: 'HARNESS-BATCH-PRINT-1', state: 'queued', outcome: 'queued', reasonCode: null, reason: null, retryEligible: false, nextAction: 'none' },
          { orderId: 990002, orderNumber: 'HARNESS-BATCH-PRINT-2', state: 'provider_pending_recovery', outcome: 'provider_pending', reasonCode: 'label_purchase_reconciliation_required', reason: 'Carrier outcome remains unknown; protected from repurchase.', retryEligible: false, nextAction: 'reconcile_provider' },
        ]
      : [
          { orderId: 990001, orderNumber: 'HARNESS-BATCH-PRINT-1', state: 'ready', outcome: 'ready', reasonCode: null, reason: 'Safe to resume.', retryEligible: false, nextAction: 'retry_later' },
          { orderId: 990002, orderNumber: 'HARNESS-BATCH-PRINT-2', state: 'provider_pending_recovery', outcome: 'provider_pending', reasonCode: 'label_purchase_reconciliation_required', reason: 'Carrier outcome remains unknown; protected from repurchase.', retryEligible: false, nextAction: 'reconcile_provider' },
        ]
    await route.fulfill(json({
      job_id: 'qs_e2e', status: 'interrupted', progress: resumed ? 50 : 0, total: 2,
      current: resumed ? 1 : 0, queued: resumed ? 1 : 0, failed: 0,
      message: '1 provider outcome requires reconciliation; protected orders were not resent.',
      client_id: TEST_CLIENT.id, queued_entry_ids: resumed ? ['entry-1'] : [], results: [],
      outcomes, can_resume: !resumed, error: null,
    }))
  })
  await page.route('**/print-queue/batch-send/qs_e2e/resume', async (route) => {
    resumeCalls += 1
    resumeRequestBody = route.request().postDataJSON()
    resumed = true
    await route.fulfill(json({ job_id: 'qs_e2e', resumed: true, safe_orders: 1, provider_pending: 1 }))
  })
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname === '/print-queue/print' && request.method() === 'POST') printCalls += 1
  })

  await page.goto(`${baseUrl}/orders/awaiting_shipment`)
  await page.waitForSelector('#ordersTable tbody tr.order-row', { state: 'visible' })
  const checkboxes = page.locator('#ordersTable tbody tr.order-row input[type="checkbox"]')
  await checkboxes.nth(0).check()
  await checkboxes.nth(1).check()
  await page.waitForSelector('[data-testid="orders-selection-toolbar"]', { state: 'visible' })
  await page.getByRole('button', { name: /Create \+ Print Label/ }).click()

  const panel = page.getByRole('region', { name: 'Print Queue recovery details' })
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('Order HARNESS-BATCH-PRINT-1')
  await expect(panel).toContainText('Order HARNESS-BATCH-PRINT-2')
  await expect(panel).toContainText('reconcile provider')
  await expect(panel).toContainText('protected from repurchase')

  await panel.getByRole('button', { name: 'Resume safe items' }).click()
  await expect.poll(() => resumeCalls).toBe(1)
  expect(resumeRequestBody).toEqual({})
  await expect(panel.getByRole('button', { name: 'Resume safe items' })).toHaveCount(0)
  await expect(panel).toContainText('Carrier outcome remains unknown')
  expect(printCalls, 'an interrupted recovery must not start PDF printing').toBe(0)
})

test('PS-442 queue progress stays fully readable at desktop and zoom-equivalent widths', async ({ page }) => {
  let finishJob = false

  await page.setViewportSize({ width: 1440, height: 900 })
  await setup(page)
  await page.route('**/print-queue/batch-send', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    await route.fulfill(json({ job_id: 'qs_ps442', total: 7 }))
  })
  await page.route('**/print-queue/batch-send/status/qs_ps442', async (route) => {
    await route.fulfill(json(finishJob
      ? {
          job_id: 'qs_ps442', status: 'done', progress: 100, total: 7, current: 7,
          queued: 2, skipped: 4, failed: 1, message: 'done', client_id: TEST_CLIENT.id,
          queued_entry_ids: ['entry-1', 'entry-2'],
          results: [
            { orderId: 990001, success: true, queueEntryId: 'entry-1', labelUrl: PDF_DATAURI },
            { orderId: 990002, success: true, queueEntryId: 'entry-2', labelUrl: PDF_DATAURI },
          ],
          error: null,
        }
      : {
          job_id: 'qs_ps442', status: 'running', progress: 57, total: 7, current: 4,
          queued: 0, skipped: 4, failed: 0, message: 'working', client_id: TEST_CLIENT.id,
          queued_entry_ids: [], results: [], error: null,
        }))
  })

  await page.goto(`${baseUrl}/orders/awaiting_shipment`)
  await page.waitForSelector('#ordersTable tbody tr.order-row', { state: 'visible' })
  const checkboxes = page.locator('#ordersTable tbody tr.order-row input[type="checkbox"]')
  await checkboxes.nth(0).check()
  await checkboxes.nth(1).check()
  await page.getByRole('button', { name: /Create \+ Print Label/ }).click()

  const widget = page.locator('#queue-progress-indicator')
  const detail = widget.getByText(/4\/7 - working \d+s - 4 skipped/)
  await expect(widget).toBeVisible()
  await expect(detail).toBeVisible()
  await expect(widget).toHaveAttribute('aria-label', /Sending to queue.*57%.*4\/7.*4 skipped/i)
  await expect(widget.getByRole('progressbar')).toHaveAttribute('aria-label', /Sending to queue.*57%/i)

  const assertReadable = async () => {
    const metrics = await detail.evaluate((element) => {
      const style = window.getComputedStyle(element)
      return {
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        overflow: style.overflow,
        textOverflow: style.textOverflow,
        whiteSpace: style.whiteSpace,
      }
    })
    expect(metrics.scrollWidth, 'detail must not be horizontally clipped').toBeLessThanOrEqual(metrics.clientWidth + 1)
    expect(metrics.overflow).not.toBe('hidden')
    expect(metrics.textOverflow).not.toBe('ellipsis')
    expect(metrics.whiteSpace).not.toBe('nowrap')
  }

  const assertNoOverlap = async (selector) => {
    const target = page.locator(selector)
    if (!await target.isVisible()) return
    const [widgetBox, targetBox] = await Promise.all([widget.boundingBox(), target.boundingBox()])
    expect(widgetBox).not.toBeNull()
    expect(targetBox).not.toBeNull()
    const overlap = widgetBox.x < targetBox.x + targetBox.width
      && widgetBox.x + widgetBox.width > targetBox.x
      && widgetBox.y < targetBox.y + targetBox.height
      && widgetBox.y + widgetBox.height > targetBox.y
    expect(overlap, `queue progress must not overlap ${selector}`).toBe(false)
  }

  expect(await widget.evaluate((element) => element.parentElement?.id)).toBe('queue-progress-slot')
  await expect(widget).toHaveCSS('z-index', '1300')
  await assertReadable()
  await assertNoOverlap('#viewTitle h1')
  await assertNoOverlap('#pq-toggle-btn')
  await page.screenshot({ path: path.join(ps442ScreenshotDir, 'after-desktop-100-percent.png') })

  for (const viewport of [
    { width: 1252, zoom: '115-percent' },
    { width: 960, zoom: '150-percent' },
    { width: 720, zoom: '200-percent' },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: 900 })
    await expect.poll(() => widget.evaluate((element) => element.parentElement?.id)).toBe('filterbar')
    if (viewport.width <= 768 && await page.locator('.mobile-sidebar-backdrop').isVisible()) {
      await page.locator('.mobile-sidebar-backdrop').click({ position: { x: viewport.width - 20, y: 100 } })
      await expect(page.locator('.mobile-sidebar-backdrop')).toHaveCount(0)
      await page.waitForTimeout(350)
    }
    await expect(widget).toBeVisible()
    await expect(widget).toHaveCSS('z-index', '10')
    await assertReadable()
    const box = await widget.boundingBox()
    expect(box).not.toBeNull()
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
    await page.screenshot({ path: path.join(ps442ScreenshotDir, `after-${viewport.zoom}.png`) })
  }

  finishJob = true
})
