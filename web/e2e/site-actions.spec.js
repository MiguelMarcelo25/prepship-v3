import { test, expect } from 'playwright/test'

const baseUrl = 'http://127.0.0.1:5177'
const apiOrigin = 'http://localhost:3000'
const apiOriginAlt = 'http://127.0.0.1:3000'
const supabaseProjectRef = 'fdkseckgfuvdczzqmnac'

const forbiddenExternalHosts = [
  'marketplace.walmartapis.com',
  'api.ebay.com',
  'apiz.ebay.com',
  'ssapi.shipstation.com',
  'api.shipstation.com',
]

let labelCreateShouldFail = false
let labelCreateShouldReturnInvalidUrl = false
let queueAddShouldFail = false
let queueMergeShouldFail = false
let ratesShouldTimeout = false
let ordersApiShouldFail = false
let ordersApiFailedOnce = false

const requestLedger = []

const clients = [
  { id: 1, name: 'Mock PrepShip Client', active: true, isTest: true, storeId: 101 },
  { id: 2, name: 'Denied Scope Client', active: true, isTest: true, storeId: 202 },
]

const packageRows = [
  { id: 1, name: '11x8x6', length: 11, width: 8, height: 6, unitCost: '0.62', source: 'fixture' },
]

const inventoryRows = [
  { id: 1, clientId: 1, sku: 'MOCK-SKU-1', name: 'Mock Snack Box', stockQty: 12, reorderLevel: 4, active: true },
]

const orders = [
  {
    id: 101,
    orderId: 101,
    orderNumber: 'MOCK-EBAY-101',
    orderStatus: 'awaiting_shipment',
    canonicalStatus: 'awaiting_shipment',
    externalOrderId: 'ebay-11-22222-33333',
    sourceProvider: 'ebay',
    clientId: 1,
    storeId: 101,
    customerEmail: 'buyer@example.test',
    shipToName: 'Mock Buyer',
    shipToCompany: 'Fixture Co',
    shipToStreet1: '123 Fixture St',
    shipToCity: 'Gardena',
    shipToState: 'CA',
    shipToPostalCode: '90248',
    shipToCountry: 'US',
    orderDate: '2026-05-22T10:00:00.000Z',
    weightOz: 16,
    length: 11,
    width: 8,
    height: 6,
    items: [{ sku: 'MOCK-SKU-1', name: 'Mock Snack Box', quantity: 1, unitPrice: 12.34 }],
    raw: { source: 'ebay' },
    bestRate: { carrierCode: 'ups', serviceCode: 'ups_ground', cost: 8.12, shippingProviderId: 1 },
    selectedRate: { carrierCode: 'ups', serviceCode: 'ups_ground', cost: 8.12, shippingProviderId: 1 },
  },
  {
    id: 102,
    orderId: 102,
    orderNumber: 'MOCK-SHIPPED-102',
    orderStatus: 'shipped',
    canonicalStatus: 'shipped',
    externalOrderId: 'walmart-450000102',
    sourceProvider: 'walmart',
    clientId: 1,
    storeId: 101,
    shipToName: 'Mock Buyer',
    shipToCity: 'Gardena',
    shipToState: 'CA',
    shipToPostalCode: '90248',
    shipToCountry: 'US',
    orderDate: '2026-05-22T10:00:00.000Z',
    weightOz: 16,
    items: [{ sku: 'MOCK-SKU-1', name: 'Mock Snack Box', quantity: 1, unitPrice: 12.34 }],
    label: { trackingNumber: 'MOCKTRACK102', labelUrl: 'mock://labels/102.pdf' },
    shipping: { trackingNumber: 'MOCKTRACK102', carrierCode: 'UPS', serviceCode: 'ups_ground' },
  },
  {
    id: 103,
    orderId: 103,
    orderNumber: 'MOCK-CANCELLED-103',
    orderStatus: 'cancelled',
    canonicalStatus: 'cancelled',
    clientId: 1,
    storeId: 101,
    shipToName: 'Mock Buyer',
    shipToCity: 'Gardena',
    shipToState: 'CA',
    shipToPostalCode: '90248',
    shipToCountry: 'US',
    orderDate: '2026-05-22T10:00:00.000Z',
    weightOz: 16,
    items: [],
  },
  {
    id: 202,
    orderId: 202,
    orderNumber: 'DENIED-SCOPE-202',
    orderStatus: 'awaiting_shipment',
    canonicalStatus: 'awaiting_shipment',
    clientId: 2,
    storeId: 202,
    shipToName: 'Denied Buyer',
    shipToCity: 'Gardena',
    shipToState: 'CA',
    shipToPostalCode: '90248',
    shipToCountry: 'US',
    orderDate: '2026-05-22T10:00:00.000Z',
    weightOz: 16,
    items: [],
  },
]

function json(body, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  }
}

function authUser() {
  return {
    id: '00000000-0000-4000-8000-000000000019',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'operator@example.test',
  }
}

function ledgerPath(pathname) {
  return pathname.replace(/^\/api/, '') || '/'
}

function recordRequest(request, url) {
  const postData = request.postData() ?? ''
  requestLedger.push({
    method: request.method(),
    url: request.url(),
    path: ledgerPath(url.pathname),
    postData,
  })
}

function assertNoObjectObjectPayloads() {
  for (const entry of requestLedger) {
    expect(entry.postData, `${entry.method} ${entry.path} payload`).not.toContain('[object Object]')
  }
}

function expectRequest(pathPattern, options = {}) {
  const method = options.method
  const match = requestLedger.find((entry) => {
    const pathMatches = typeof pathPattern === 'string'
      ? entry.path === pathPattern || entry.path.includes(pathPattern)
      : pathPattern.test(entry.path)
    const methodMatches = !method || entry.method === method
    return pathMatches && methodMatches
  })
  expect(match, `expected request ${method ?? '*'} ${pathPattern.toString()}`).toBeTruthy()
  if (options.payloadIncludes) {
    for (const token of options.payloadIncludes) {
      expect(match.postData, `${match.method} ${match.path} payload`).toContain(token)
    }
  }
  return match
}

async function waitForRequest(pathPattern, options = {}) {
  await expect.poll(() => {
    const method = options.method
    return requestLedger.some((entry) => {
      const pathMatches = typeof pathPattern === 'string'
        ? entry.path === pathPattern || entry.path.includes(pathPattern)
        : pathPattern.test(entry.path)
      const methodMatches = !method || entry.method === method
      return pathMatches && methodMatches
    })
  }, { timeout: 15000 }).toBe(true)
  return expectRequest(pathPattern, options)
}

function expectNoForbiddenExternalRequests() {
  for (const host of forbiddenExternalHosts) {
    expect(
      requestLedger.some((entry) => new URL(entry.url).hostname === host),
      `unexpected live provider request to ${host}`,
    ).toBe(false)
  }
}

function ordersForStatus(status) {
  return orders.filter((order) => {
    if (order.clientId !== 1) return false
    if (!status) return true
    return order.orderStatus === status
  })
}

function responseFor(url, request) {
  const method = request.method()
  const pathname = ledgerPath(url.pathname)

  if (forbiddenExternalHosts.includes(url.hostname)) {
    recordRequest(request, url)
    return json({ error: `Blocked live provider host ${url.hostname}` }, 599)
  }

  if (url.hostname.endsWith('supabase.co')) {
    recordRequest(request, url)
    if (url.pathname.includes('/auth/v1/user')) return json(authUser())
    if (url.pathname.includes('/auth/v1/logout')) return json({})
    return json({ user: authUser() })
  }

  const apiRequest =
    url.origin === apiOrigin ||
    url.origin === apiOriginAlt ||
    url.pathname.startsWith('/api/') ||
    (url.origin !== baseUrl && !url.hostname.endsWith('supabase.co'))

  if (!apiRequest) return null
  recordRequest(request, url)

  if (pathname === '/health') return json({ status: 'ok' })
  if (pathname === '/health/ready') return json({ status: 'ready', components: [{ name: 'db', status: 'ok' }] })
  if (pathname === '/health/deep') return json({ status: 'ready', components: [{ name: 'orders', status: 'ok' }] })
  if (pathname === '/clients') return json(clients.filter((client) => client.id === 1))
  if (pathname === '/users') return json({ users: [] })
  if (pathname === '/locations') return json([])
  if (pathname === '/packages') return json(packageRows)
  if (pathname === '/billing') return json({ invoices: [{ id: 'inv_mock_1', clientId: 1, total: 12.34 }] })
  if (pathname === '/rates/multi' || pathname === '/carriers/rates') {
    if (ratesShouldTimeout) return json({ error: 'Carrier rate provider timed out' }, 504)
    return json({ rates: [{ carrierCode: 'ups', serviceCode: 'ups_ground', cost: 8.12, shippingProviderId: 1 }] })
  }
  if (pathname === '/api/carrier-accounts' || pathname === '/carrier-accounts') return json({ data: [] })
  if (pathname === '/api/store-accounts' || pathname === '/store-accounts') return json({ data: [] })
  if (pathname === '/markups') return json([])
  if (pathname === '/settings/orders.columnPrefs') return json({ value: null })
  if (pathname === '/orders/sync/status') return json({ status: 'idle', lastSyncAt: '2026-05-22T10:00:00.000Z' })
  if (pathname === '/shipments/status') return json({ status: 'idle' })
  if (pathname === '/init/stores') {
    return json({
      data: clients.filter((client) => client.id === 1).map((client) => ({
        id: client.storeId,
        storeId: client.storeId,
        name: client.name,
        storeName: client.name,
        clientName: client.name,
        clientId: client.id,
        active: client.active,
        isTest: client.isTest,
      })),
    })
  }
  if (pathname === '/init/counts') {
    return json({
      byStatus: [
        { orderStatus: 'awaiting_shipment', cnt: 1 },
        { orderStatus: 'shipped', cnt: 1 },
        { orderStatus: 'cancelled', cnt: 1 },
      ],
      byStatusStore: [
        { orderStatus: 'awaiting_shipment', storeId: 101, cnt: 1 },
        { orderStatus: 'shipped', storeId: 101, cnt: 1 },
        { orderStatus: 'cancelled', storeId: 101, cnt: 1 },
      ],
    })
  }
  if (pathname === '/clients/order-stats') return json({ data: [{ clientId: 1, awaiting_shipment: 1, shipped: 1, cancelled: 1 }] })
  if (pathname === '/orders/distinct-skus') return json({ skus: ['MOCK-SKU-1'] })
  if (pathname === '/inventory') return json({ items: inventoryRows, rows: inventoryRows, total: inventoryRows.length })
  if (pathname === '/orders/counts') {
    return json([
      { orderStatus: 'awaiting_shipment', cnt: 1 },
      { orderStatus: 'shipped', cnt: 1 },
      { orderStatus: 'cancelled', cnt: 1 },
    ])
  }
  if (pathname === '/orders/daily-stats') return json({ summary: { totalOrders: 1, needToShip: 1, upcomingOrders: 0 } })
  if (pathname === '/orders') {
    if (ordersApiShouldFail && !ordersApiFailedOnce) {
      ordersApiFailedOnce = true
      return json({ error: 'Orders API failure: fixture timeout' }, 504)
    }
    const status = url.searchParams.get('status')
    const filtered = ordersForStatus(status)
    return json({ data: filtered, orders: filtered, pagination: { page: 1, pageSize: 50, total: filtered.length, totalPages: 1 }, total: filtered.length, page: 1, pageSize: 50 })
  }
  if (/^\/orders\/\d+\/full$/.test(pathname)) {
    const id = Number(pathname.split('/')[2])
    if (id === 202) return json({ error: 'permission denied: scope' }, 403)
    return json(orders.find((order) => order.id === id) ?? orders[0])
  }
  if (/^\/orders\/\d+$/.test(pathname)) {
    const id = Number(pathname.split('/').pop())
    if (id === 202) return json({ error: 'permission denied: scope' }, 403)
    return json(orders.find((order) => order.id === id) ?? orders[0])
  }
  if (pathname === '/print-queue' && method === 'GET') {
    return json({ entries: [{ queue_entry_id: 'q1', order_id: '101', order_number: 'MOCK-EBAY-101', sku_group: 'MOCK-SKU-1', label_url: 'mock://labels/9001.pdf', status: 'queued' }] })
  }
  if (pathname.includes('/print-queue') && method === 'POST') {
    if (queueAddShouldFail) return json({ error: 'Print queue add failure' }, 500)
    if (queueMergeShouldFail) return json({ error: 'Print queue merge/PDF failure' }, 500)
    return json({ ok: true, queued: 1, job_id: 'job_mock_1', status: 'done', message: 'done', entries: [{ id: 'q1' }] })
  }
  if (pathname.includes('/print-queue') && method === 'GET') {
    return json({ ok: true, job_id: 'job_mock_1', status: 'done', message: 'done', progress: 100, pdfUrl: 'mock://labels/merged.pdf' })
  }
  if ((pathname.includes('/labels') || pathname.includes('/carriers/labels')) && method === 'POST') {
    if (labelCreateShouldFail) return json({ error: 'Provider label service timed out' }, 500)
    if (labelCreateShouldReturnInvalidUrl) {
      return json({ ok: true, shipmentId: 9001, trackingNumber: 'MOCKTRACK101', labelUrl: '[object Object]' })
    }
    return json({
      ok: true,
      shipmentId: 9001,
      trackingNumber: 'MOCKTRACK101',
      labelUrl: 'mock://labels/9001.pdf',
      marketplaceConfirmation: { provider: 'ebay', status: 'queued' },
      fulfillmentOutbox: { provider: 'ebay', status: 'queued' },
    })
  }
  if (pathname.includes('/labels') && method === 'GET') {
    return json({ ok: true, labelUrl: 'mock://labels/9001.pdf' })
  }

  return json({})
}

test.beforeEach(async ({ page }) => {
  labelCreateShouldFail = false
  labelCreateShouldReturnInvalidUrl = false
  queueAddShouldFail = false
  queueMergeShouldFail = false
  ratesShouldTimeout = false
  ordersApiShouldFail = false
  ordersApiFailedOnce = false
  requestLedger.length = 0

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
        user: {
          id: '00000000-0000-4000-8000-000000000019',
          aud: 'authenticated',
          role: 'authenticated',
          email: 'operator@example.test',
        },
      }),
    )
  }, supabaseProjectRef)

  await page.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const response = responseFor(url, request)
    if (response) {
      await route.fulfill(response)
      return
    }
    await route.continue()
  })
})

async function openAwaitingOrderPanel(page) {
  await page.goto(`${baseUrl}/orders/awaiting_shipment`)
  await expect(page.getByText('MOCK-EBAY-101').first()).toBeVisible({ timeout: 15000 })
  await expect(page.getByText('DENIED-SCOPE-202')).toHaveCount(0)
  const orderRow = page.getByRole('row', { name: /MOCK-EBAY-101/ }).last()
  await expect(orderRow).toBeVisible({ timeout: 15000 })
  await orderRow.click({ position: { x: 220, y: 18 } })
  await expect(page.getByText(/MOCK-EBAY-101|Create \+ Print Label|Print Label/i).first()).toBeVisible({ timeout: 15000 })
}

test('shipping workflow certification records requests, payloads, queue, print, and outbox fixture state', async ({ page }) => {
  // No real postage, no live provider calls, mocked only.
  await openAwaitingOrderPanel(page)

  const printAction = page.getByRole('button', { name: /Print Label|Create.*Print Label/i }).first()
  await expect(printAction).toBeVisible({ timeout: 15000 })
  await printAction.click()
  await expect(page.getByText(/Creating label PDF|MOCKTRACK101|Label/i).first()).toBeVisible({ timeout: 15000 })

  await openAwaitingOrderPanel(page)
  const queueAction = page.getByRole('button', { name: /^Print to Queue$/ }).first()
  await expect(queueAction).toBeVisible({ timeout: 15000 })
  await queueAction.click()
  await expect(page.getByText(/Queue updated|queued|MOCK-EBAY-101|Print Queue/i).first()).toBeVisible({ timeout: 15000 })

  expectRequest(/labels|carriers\/labels/, { method: 'POST', payloadIncludes: ['101'] })
  await waitForRequest('/print-queue', { method: 'POST', payloadIncludes: ['MOCK-EBAY-101', 'mock://labels/9001.pdf'] })
  assertNoObjectObjectPayloads()
  expectNoForbiddenExternalRequests()
})

test('label creation failure shows a recoverable error', async ({ page }) => {
  // No real postage, no live provider calls, mocked only.
  labelCreateShouldFail = true
  await openAwaitingOrderPanel(page)
  const printAction = page.getByRole('button', { name: /Print Label|Create.*Print Label/i }).first()
  await expect(printAction).toBeVisible({ timeout: 15000 })
  await printAction.click()
  await expect(page.getByText(/Provider label service timed out|Label failed|failed/i).first()).toBeVisible({ timeout: 15000 })
  expectRequest(/labels|carriers\/labels/, { method: 'POST', payloadIncludes: ['101'] })
  expectNoForbiddenExternalRequests()
})

test('invalid label URL failure does not enqueue [object Object]', async ({ page }) => {
  // No real postage, no live provider calls, mocked only.
  labelCreateShouldReturnInvalidUrl = true
  await openAwaitingOrderPanel(page)
  const queueAction = page.getByRole('button', { name: /^Print to Queue$/ }).first()
  await expect(queueAction).toBeVisible({ timeout: 15000 })
  await queueAction.click()
  await waitForRequest(/labels|carriers\/labels/, { method: 'POST', payloadIncludes: ['101'] })
  await expect(page.getByText(/MOCK-EBAY-101|Awaiting/i).first()).toBeVisible({ timeout: 15000 })
  expect(
    requestLedger.some((entry) => entry.method === 'POST' && entry.path === '/print-queue' && entry.postData.includes('[object Object]')),
    'invalid label URL must not be queued as [object Object]',
  ).toBe(false)
  assertNoObjectObjectPayloads()
  expectNoForbiddenExternalRequests()
})

test('print queue add failure stays readable and recoverable', async ({ page }) => {
  // No real postage, no live provider calls, mocked only.
  queueAddShouldFail = true
  await openAwaitingOrderPanel(page)
  const failingQueueAction = page.getByRole('button', { name: /^Print to Queue$/ }).first()
  await expect(failingQueueAction).toBeVisible({ timeout: 15000 })
  await failingQueueAction.click()
  await waitForRequest('/print-queue', { method: 'POST' })
  await expect(page.getByText(/MOCK-EBAY-101|Print Queue|Awaiting/i).first()).toBeVisible({ timeout: 15000 })
  expectNoForbiddenExternalRequests()
})

test('rate, orders API, and scope failure variants remain controlled', async ({ page }) => {
  // No real postage, no live provider calls, mocked only.
  ratesShouldTimeout = true
  await page.goto(`${baseUrl}/orders/awaiting_shipment`)
  await expect(page.getByText('MOCK-EBAY-101').first()).toBeVisible({ timeout: 15000 })
  expectNoForbiddenExternalRequests()

  ordersApiShouldFail = true
  await page.goto(`${baseUrl}/orders/awaiting_shipment`)
  await expect(page.getByText(/Orders API failure|Retry|MOCK-EBAY-101|Awaiting/i).first()).toBeVisible({ timeout: 15000 })

  expectRequest('/orders', { method: 'GET' })
  assertNoObjectObjectPayloads()
  expectNoForbiddenExternalRequests()
})

test('full-page smoke/navigation certification covers critical routes and shipped/cancelled protections', async ({ page }) => {
  // No real postage, no live provider calls, mocked only.
  const routes = [
    '/',
    '/orders/awaiting_shipment',
    '/orders/shipped',
    '/orders/cancelled',
    '/inventory',
    '/packages',
    '/clients',
    '/billing',
    '/settings',
  ]

  for (const route of routes) {
    await page.goto(`${baseUrl}${route}`)
    await expect(page.locator('body')).toBeVisible({ timeout: 15000 })
    await expect(page.getByText(/PrepShip|Orders|Inventory|Packages|Clients|Billing|Settings|MOCK-|Mock/i).first()).toBeVisible({ timeout: 15000 })
  }

  await page.goto(`${baseUrl}/orders/shipped`)
  await expect(page.getByText('MOCK-SHIPPED-102').first()).toBeVisible({ timeout: 15000 })
  await page.getByRole('row', { name: /MOCK-SHIPPED-102/ }).last().click({ position: { x: 220, y: 18 } })
  await expect(page.getByTestId('shipped-label-actions')).toBeVisible({ timeout: 15000 })
  await expect(page.getByRole('button', { name: /Create \+ Print Label/i })).toHaveCount(0)

  await page.goto(`${baseUrl}/orders/cancelled`)
  await expect(page.getByText('MOCK-CANCELLED-103').first()).toBeVisible({ timeout: 15000 })
  await expect(page.getByRole('button', { name: /Create \+ Print Label/i })).toHaveCount(0)

  expectRequest('/init/stores', { method: 'GET' })
  expectRequest('/orders', { method: 'GET' })
  assertNoObjectObjectPayloads()
  expectNoForbiddenExternalRequests()
})
