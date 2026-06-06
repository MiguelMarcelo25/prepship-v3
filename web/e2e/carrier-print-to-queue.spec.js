// Carrier harness — Slice 5 browser smoke.
// Plan: ~/.claude/plans/zany-spinning-hennessy.md
//
// Drives the REAL "Print to Queue" button in the real frontend for a TEST- SKU
// order, with every carrier/label/queue endpoint intercepted (no real carrier, no
// real postage, no marketplace). Asserts the user-facing pipeline runs with no
// console errors and no failed network — i.e. printing to queue does not bug out.
import { test, expect } from 'playwright/test'

const baseUrl = 'http://127.0.0.1:5177'
const apiOrigin = 'http://127.0.0.1:3000'
const supabaseProjectRef = 'fdkseckgfuvdczzqmnac'

const TEST_CLIENT = { id: 3, name: '__CARRIER_HARNESS__', active: true, isTest: true, storeId: 103 }

const rate = {
  carrierCode: 'ups', serviceCode: 'ups_ground_saver', serviceName: 'UPS Ground Saver',
  carrierNickname: 'HARNESS', providerAccountNickname: 'HARNESS', shippingProviderId: 7381,
  amount: 9.86, cost: 9.86, shipmentCost: 9.86, otherCost: 0,
}

// Minimal valid 1-page PDF data-uri so the label looks real to the UI.
const PDF_DATAURI = 'data:application/pdf;base64,JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCAyMDAgMjAwXT4+CmVuZG9iagp0cmFpbGVyPDwvUm9vdCAxIDAgUj4+Cg=='

function makeTestOrder() {
  return {
    id: 990001, orderId: 990001, orderNumber: 'HARNESS-UPS-GROUND-1', orderStatus: 'awaiting_shipment',
    orderDate: '2026-06-06T02:11:00.000Z', externalOrderId: null, sourceProvider: 'internal',
    clientId: TEST_CLIENT.id, storeId: TEST_CLIENT.storeId, isTestOrdersStore: true,
    customerEmail: 'harness@example.com', shipToName: 'Carrier Harness Tester',
    shipToCity: 'San Francisco', shipToState: 'CA', shipToPostalCode: '94104',
    orderTotal: 16.99, shippingAmount: 7.3, weightOz: 16,
    items: [{ name: 'Carrier harness test item', sku: 'TEST-CARRIER-UPS-GROUND', quantity: 1, unitPrice: 16.99, imageUrl: '' }],
    raw: { shipTo: { name: 'Carrier Harness Tester', street1: '417 Montgomery St', city: 'San Francisco', state: 'CA', postalCode: '94104', country: 'US', phone: '4150000000' }, dimensions: { length: 8, width: 6, height: 4 } },
    overrides: { rateWeightOz: 16, rateDimsL: 8, rateDimsW: 6, rateDimsH: 4, bestRateJson: rate },
    bestRate: rate, selectedRate: rate, label: null, shipping: null,
  }
}

function json(body) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) }
}

const order = makeTestOrder()

function responseFor(url, method) {
  if (url.hostname.endsWith('supabase.co')) return json({ user: null })
  const isApi = url.origin === apiOrigin || url.origin !== baseUrl || url.pathname.startsWith('/api/')
  if (!isApi) return null

  // ── carrier / label / queue endpoints — the safety surface ──
  if (url.pathname === '/api/carriers/rates') return json({ rates: [rate], rateQuoteId: 'rq_test', carrierEligibility: null })
  if (url.pathname === '/api/carriers/labels') return json({ ok: true, provider: 'ups', trackingNumber: 'TESTUPS00000001', labelUrl: PDF_DATAURI, labelFormat: 'PDF', cost: 0, currency: 'USD' })
  if (url.pathname === '/labels') return json({ ok: true, trackingNumber: 'TESTUPS00000001', labelUrl: PDF_DATAURI, labelFormat: 'PDF', cost: '0.00', source: 'test_offline' })
  if (url.pathname.startsWith('/print-queue')) return json({ ok: true, queueEntryId: 1, status: 'queued' })

  // ── supporting reads ──
  if (url.pathname === '/clients') return json([TEST_CLIENT])
  if (url.pathname === '/users') return json({ users: [{ id: 'u1', email: 'operator@example.com', isAdmin: true }] })
  if (url.pathname === '/locations') return json([{ id: 1, name: 'GWH', company: 'PrepShip', street1: '123 Warehouse Way', city: 'Gardena', state: 'CA', postalCode: '90248', country: 'US', isDefault: true, active: true }])
  if (url.pathname === '/packages') return json([{ id: 1, name: '8x6x4', length: 8, width: 6, height: 4, unitCost: '0.62', source: 'custom' }])
  if (url.pathname === '/api/carrier-accounts') return json({ data: [] })
  if (url.pathname === '/rates/multi') return json({ carriers: [] })
  if (url.pathname === '/settings/orders.columnPrefs') return json({ value: null })
  if (url.pathname === '/orders/sync/status') return json({ status: 'idle', lastSyncAt: '2026-06-06T00:00:00.000Z' })
  if (url.pathname === '/shipments/status') return json({ status: 'idle' })
  if (url.pathname === '/init/stores') return json({ data: [{ id: TEST_CLIENT.storeId, storeId: TEST_CLIENT.storeId, name: TEST_CLIENT.name, storeName: TEST_CLIENT.name, clientName: TEST_CLIENT.name, clientId: TEST_CLIENT.id, active: true, isTest: true }] })
  if (url.pathname === '/init/counts') return json({ byStatus: [{ orderStatus: 'awaiting_shipment', cnt: 1 }], byStatusStore: [{ orderStatus: 'awaiting_shipment', storeId: TEST_CLIENT.storeId, cnt: 1 }] })
  if (url.pathname === '/clients/order-stats') return json({ data: [{ clientId: TEST_CLIENT.id, awaiting_shipment: 1, shipped: 0, cancelled: 0 }] })
  if (url.pathname === '/orders/distinct-skus') return json({ skus: ['TEST-CARRIER-UPS-GROUND'] })
  if (url.pathname === '/orders') return json({ data: [order], pagination: { page: 1, pageSize: 50, total: 1, totalPages: 1 } })
  if (/^\/orders\/\d+\/full$/.test(url.pathname)) return json(order)
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

test('Print to Queue on a TEST order runs with no bugs and never hits a real carrier', async ({ page }) => {
  const consoleErrors = []
  const failedResponses = []
  const labelOrQueueCalls = []
  page.on('pageerror', (err) => consoleErrors.push(String(err)))
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
  page.on('response', (res) => {
    const u = new URL(res.url())
    if (u.origin === baseUrl && !u.pathname.startsWith('/api/') && !u.pathname.startsWith('/labels') && !u.pathname.startsWith('/print-queue')) return
    if (res.status() >= 400) failedResponses.push(`${res.status()} ${u.pathname}`)
    if (/\/labels|\/print-queue|\/api\/carriers\/labels/.test(u.pathname)) labelOrQueueCalls.push(u.pathname)
  })

  await page.setViewportSize({ width: 1440, height: 900 })
  await setup(page)
  await page.goto(`${baseUrl}/orders/awaiting_shipment`)
  await page.waitForSelector('#ordersTable tbody tr.order-row', { state: 'visible' })

  // Select the test order → selection toolbar appears.
  await page.locator('#ordersTable tbody tr.order-row input[type="checkbox"]').first().check()
  await page.waitForSelector('[data-testid="orders-selection-toolbar"]', { state: 'visible' })

  // Click the REAL Print to Queue button.
  await page.getByText('Print to Queue', { exact: true }).first().click()

  // Let the rate→label→queue pipeline run.
  await page.waitForTimeout(2500)

  // No real carrier was ever hit (all intercepted), and the pipeline did not error.
  expect(failedResponses, `failed API responses: ${failedResponses.join(', ')}`).toEqual([])
  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([])
  expect(labelOrQueueCalls.length, 'expected the label/queue pipeline to be exercised').toBeGreaterThan(0)
})
