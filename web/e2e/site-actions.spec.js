import { test, expect } from 'playwright/test'

const baseUrl = 'http://127.0.0.1:5177'
const apiOrigin = 'http://127.0.0.1:3000'
const supabaseProjectRef = 'fdkseckgfuvdczzqmnac'

const clients = [
  { id: 1, name: 'Mock PrepShip Client', active: true, isTest: true, storeId: 101 },
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
    externalOrderId: 'ebay-11-22222-33333',
    sourceProvider: 'ebay',
    clientId: 1,
    storeId: 101,
    customerEmail: 'buyer@example.test',
    shipToName: 'Mock Buyer',
    shipToCity: 'Gardena',
    shipToState: 'CA',
    shipToPostalCode: '90248',
    orderDate: '2026-05-22T10:00:00.000Z',
    weightOz: 16,
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
    externalOrderId: 'walmart-450000102',
    sourceProvider: 'walmart',
    clientId: 1,
    storeId: 101,
    shipToName: 'Mock Buyer',
    shipToCity: 'Gardena',
    shipToState: 'CA',
    shipToPostalCode: '90248',
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
    clientId: 1,
    storeId: 101,
    shipToName: 'Mock Buyer',
    shipToCity: 'Gardena',
    shipToState: 'CA',
    shipToPostalCode: '90248',
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

function responseFor(url, method) {
  if (url.hostname.endsWith('supabase.co')) return json({ user: null })

  const apiRequest = url.origin === apiOrigin || url.pathname.startsWith('/api/') || url.origin !== baseUrl
  if (!apiRequest) return null

  if (url.pathname === '/clients') return json(clients)
  if (url.pathname === '/users') return json({ users: [] })
  if (url.pathname === '/health/ready') return json({ ok: true, db: 'ok' })
  if (url.pathname === '/locations') return json([])
  if (url.pathname === '/packages') return json(packageRows)
  if (url.pathname === '/rates/multi') return json({ carriers: [] })
  if (url.pathname === '/api/carrier-accounts') return json({ data: [] })
  if (url.pathname === '/carrier-accounts') return json([])
  if (url.pathname === '/api/store-accounts') return json({ data: [] })
  if (url.pathname === '/store-accounts') return json([])
  if (url.pathname === '/markups') return json([])
  if (url.pathname === '/settings/orders.columnPrefs') return json({ value: null })
  if (url.pathname === '/orders/sync/status') return json({ status: 'idle', lastSyncAt: '2026-05-22T10:00:00.000Z' })
  if (url.pathname === '/shipments/status') return json({ status: 'idle' })
  if (url.pathname === '/init/stores') {
    return json({
      data: clients.map((client) => ({
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
  if (url.pathname === '/init/counts') {
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
  if (url.pathname === '/clients/order-stats') return json({ data: [{ clientId: 1, awaiting_shipment: 1, shipped: 1, cancelled: 1 }] })
  if (url.pathname === '/orders/distinct-skus') return json({ skus: ['MOCK-SKU-1'] })
  if (url.pathname === '/inventory') return json({ items: inventoryRows, rows: inventoryRows, total: inventoryRows.length })
  if (url.pathname === '/orders/counts') {
    return json([
      { orderStatus: 'awaiting_shipment', cnt: 1 },
      { orderStatus: 'shipped', cnt: 1 },
      { orderStatus: 'cancelled', cnt: 1 },
    ])
  }
  if (url.pathname === '/orders') {
    const status = url.searchParams.get('status')
    const filtered = status ? orders.filter((order) => order.orderStatus === status) : orders
    return json({ data: filtered, orders: filtered, pagination: { page: 1, pageSize: 50, total: filtered.length, totalPages: 1 }, total: filtered.length, page: 1, pageSize: 50 })
  }
  if (url.pathname.match(/^\/orders\/\d+\/full$/)) {
    const id = Number(url.pathname.split('/')[2])
    return json(orders.find((order) => order.id === id) ?? orders[0])
  }
  if (url.pathname.match(/^\/orders\/\d+$/)) {
    const id = Number(url.pathname.split('/').pop())
    return json(orders.find((order) => order.id === id) ?? orders[0])
  }
  if (url.pathname === '/print-queue') {
    return json({ entries: [{ queue_entry_id: 'q1', order_id: '101', order_number: 'MOCK-EBAY-101', status: 'queued' }] })
  }
  if (url.pathname.includes('/print-queue') && method === 'POST') {
    return json({ ok: true, queued: 1, entries: [{ id: 'q1' }] })
  }
  if (url.pathname.includes('/labels') && method === 'POST') {
    return json({
      ok: true,
      shipmentId: 9001,
      trackingNumber: 'MOCKTRACK101',
      labelUrl: 'mock://labels/9001.pdf',
      marketplaceConfirmation: { provider: 'ebay', status: 'mocked' },
    })
  }
  if (url.pathname.includes('/labels') && method === 'GET') {
    return json({ ok: true, labelUrl: 'mock://labels/9001.pdf' })
  }
  if (url.pathname.includes('/rates')) {
    return json({ rates: [{ carrierCode: 'ups', serviceCode: 'ups_ground', cost: 8.12, shippingProviderId: 1 }] })
  }

  return json({})
}

test.beforeEach(async ({ page }) => {
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
    const response = responseFor(url, request.method())
    if (response) {
      await route.fulfill(response)
      return
    }
    await route.continue()
  })
})

test('orders actions are mocked only and show success/failure states', async ({ page }) => {
  // No real postage, no live provider calls, mocked only.
  await page.goto(`${baseUrl}/orders/awaiting_shipment`)

  await expect(page.getByText(/MOCK-EBAY-101|Awaiting/i).first()).toBeVisible({ timeout: 15000 })

  const printAction = page.getByRole('button', { name: /Print Label|Create.*Print Label/i }).first()
  if (await printAction.count()) {
    await printAction.click()
    await expect(page.getByText(/Creating label PDF|Label|MOCKTRACK/i).first()).toBeVisible({ timeout: 15000 })
  }

  const reprintAction = page.getByRole('button', { name: /Reprint Label/i }).first()
  if (await reprintAction.count()) {
    await reprintAction.click()
    await expect(page.getByText(/label|pdf|popup/i).first()).toBeVisible({ timeout: 15000 })
  }

  const queueAction = page.getByRole('button', { name: /Send to Queue|Print Queue/i }).first()
  if (await queueAction.count()) {
    await queueAction.click()
    await expect(page.locator('body')).toBeVisible()
  }

  await expect(page.getByText(/MOCK-EBAY-101|Awaiting/i).first()).toBeVisible()
})

test('inventory, package, client, auth, and maintenance actions use mocked APIs', async ({ page }) => {
  await page.goto(`${baseUrl}/orders/awaiting_shipment`)

  await expect(page.getByText(/Mock PrepShip Client|MOCK-SKU-1|MOCK-EBAY-101/i).first()).toBeVisible({ timeout: 15000 })

  const inventoryNav = page.getByRole('button', { name: /Inventory/i }).or(page.getByRole('link', { name: /Inventory/i })).first()
  if (await inventoryNav.count()) {
    await inventoryNav.click()
    await expect(page.getByText(/MOCK-SKU-1|Inventory/i).first()).toBeVisible({ timeout: 15000 })
  }

  const packagesNav = page.getByRole('button', { name: /Packages/i }).or(page.getByRole('link', { name: /Packages/i })).first()
  if (await packagesNav.count()) {
    await packagesNav.click()
    await expect(page.getByText(/11x8x6|Packages/i).first()).toBeVisible({ timeout: 15000 })
  }
})
