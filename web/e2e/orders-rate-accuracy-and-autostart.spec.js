import { test, expect } from 'playwright/test'

const baseUrl = 'http://127.0.0.1:5177'
const apiOrigin = 'http://127.0.0.1:3000'
const supabaseProjectRef = 'fdkseckgfuvdczzqmnac'

const staleDimsOnlyRate = {
  carrierCode: 'ups',
  serviceCode: 'ups_ground_saver',
  serviceName: 'UPS Ground Saver (1 lb+)',
  carrierNickname: 'ORION',
  shippingProviderId: 596001,
  amount: 8.31,
  cost: 8.31,
  shipmentCost: 8.31,
  otherCost: 0,
}

const exactFreshRate = {
  carrierCode: 'ups',
  serviceCode: 'ups_ground_saver',
  serviceName: 'UPS Ground Saver (1 lb+)',
  carrierNickname: 'ROCEL C81F70',
  shippingProviderId: 607855,
  amount: 10.3,
  cost: 10.3,
  shipmentCost: 10.3,
  otherCost: 0,
  requestFingerprint: 'ps050-exact-fingerprint',
  isComplete: true,
  rateCount: 2,
  cacheCreatedAt: new Date().toISOString(),
  cacheExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
}

function makeOrder(id, bestRate, overrides = {}) {
  return {
    id,
    orderId: id,
    orderNumber: `PS050-${id}`,
    orderStatus: 'awaiting_shipment',
    orderDate: '2026-06-01T00:00:00.000Z',
    externalOrderId: `external-${id}`,
    clientId: 1,
    storeId: 101,
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
      shipTo: { name: 'Ella Johnson', city: 'El Reno', state: 'OK', postalCode: '73036', country: 'US', residential: true },
      dimensions: { length: 12, width: 10, height: 3 },
    },
    overrides: {
      rateWeightOz: 60,
      rateDimsL: 12,
      rateDimsW: 10,
      rateDimsH: 3,
      bestRateJson: bestRate,
      bestRateDims: '12x10x3',
      bestRateAt: new Date().toISOString(),
      ...overrides,
    },
    bestRate,
    selectedRate: null,
    label: null,
    shipping: bestRate ? { bestRate, bestRateAmount: bestRate.shipmentCost, bestRateDims: '12x10x3' } : null,
  }
}

const staleOrder = makeOrder(1107, staleDimsOnlyRate)
const freshOrder = makeOrder(1108, exactFreshRate)
const orders = [staleOrder, freshOrder]

function json(body) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) }
}

test('Awaiting Shipment auto-starts safe cache-first rating and rejects dims-only saved rates', async ({ page }) => {
  const requests = []

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
    const request = route.request()
    const url = new URL(request.url())
    if (url.hostname.endsWith('supabase.co')) return route.fulfill(json({ user: null }))

    const isApiRequest = url.origin === apiOrigin || url.origin !== baseUrl || url.pathname.startsWith('/api/')
    if (!isApiRequest) return route.continue()

    let body = null
    if (request.method() === 'POST' || request.method() === 'PATCH') {
      try { body = request.postDataJSON() } catch { body = request.postData() }
    }
    requests.push({ method: request.method(), path: url.pathname, body })

    if (url.pathname === '/clients') return route.fulfill(json([{ id: 1, name: 'KF Goods', active: true, isTest: false, storeId: 101 }]))
    if (url.pathname === '/users') return route.fulfill(json({ users: [{ id: 'u1', email: 'operator@example.com', isAdmin: true }] }))
    if (url.pathname === '/locations') return route.fulfill(json([{ id: 1, name: 'GWH', postalCode: '90248', country: 'US', active: true, isDefault: true }]))
    if (url.pathname === '/packages') return route.fulfill(json([{ id: 1, name: '12x10x3', length: 12, width: 10, height: 3, unitCost: '0.62', source: 'custom' }]))
    if (url.pathname === '/rates/multi') {
      return route.fulfill(json({
        carriers: [
          { carrier_id: 'se-596001', carrier_code: 'ups', friendly_name: 'ORION', nickname: 'ORION' },
          { carrier_id: 'se-607855', carrier_code: 'ups', friendly_name: 'ROCEL C81F70', nickname: 'ROCEL C81F70' },
        ],
      }))
    }
    if (url.pathname === '/api/carrier-accounts') {
      return route.fulfill(json({
        data: [
          { id: 'se-596001', carrier_id: 'se-596001', carrier_code: 'ups', friendly_name: 'ORION', nickname: 'ORION', active: true },
          { id: 'se-607855', carrier_id: 'se-607855', carrier_code: 'ups', friendly_name: 'ROCEL C81F70', nickname: 'ROCEL C81F70', active: true },
        ],
      }))
    }
    if (url.pathname === '/settings/orders.columnPrefs') return route.fulfill(json({ value: null }))
    if (url.pathname === '/orders/sync/status') return route.fulfill(json({ status: 'idle' }))
    if (url.pathname === '/shipments/status') return route.fulfill(json({ status: 'idle' }))
    if (url.pathname === '/init/stores') return route.fulfill(json({ data: [{ id: 101, storeId: 101, name: 'KF Goods', clientId: 1, active: true, isTest: false }] }))
    if (url.pathname === '/init/counts') return route.fulfill(json({ byStatus: [{ orderStatus: 'awaiting_shipment', cnt: 2 }], byStatusStore: [] }))
    if (url.pathname === '/clients/order-stats') return route.fulfill(json({ data: [{ clientId: 1, awaiting_shipment: 2, shipped: 0, cancelled: 0 }] }))
    if (url.pathname === '/orders/distinct-skus') return route.fulfill(json({ skus: ['B0D43C5FGF'] }))
    if (url.pathname === '/orders') return route.fulfill(json({ data: orders, pagination: { page: 1, pageSize: 50, total: 2, totalPages: 1 } }))
    if (url.pathname.match(/^\/orders\/\d+\/full$/)) {
      const id = Number(url.pathname.match(/\d+/)?.[0])
      return route.fulfill(json(orders.find((order) => order.id === id) ?? orders[0]))
    }
    if (url.pathname === '/rates/cached/bulk') {
      return route.fulfill(json({
        data: [
          { orderId: 1107, matchType: 'miss', hit: null, isComplete: false, cacheKey: 'ps050-stale-miss' },
          {
            orderId: 1108,
            matchType: 'exact',
            cacheKey: 'ps050-exact-fingerprint',
            requestFingerprint: 'ps050-exact-fingerprint',
            isComplete: true,
            rateCount: 2,
            cacheCreatedAt: exactFreshRate.cacheCreatedAt,
            cacheExpiresAt: exactFreshRate.cacheExpiresAt,
            hit: { rates: [exactFreshRate], bestRate: exactFreshRate, fetchedAt: exactFreshRate.cacheCreatedAt },
          },
        ],
      }))
    }
    if (url.pathname === '/rates') {
      expect(body?.forceRefresh, 'passive auto-rating must not force live refresh').not.toBe(true)
      return route.fulfill(json({
        rates: [exactFreshRate],
        bestRate: exactFreshRate,
        cached: false,
        cacheKey: 'ps050-live-refresh',
        fetchedAt: new Date().toISOString(),
        carrierDiagnostics: [
          { carrierId: 'se-596001', status: 'empty', rateCount: 0 },
          { carrierId: 'se-607855', status: 'ok', rateCount: 1 },
        ],
      }))
    }
    if (url.pathname.match(/^\/orders\/\d+$/) && request.method() === 'PATCH') return route.fulfill(json({ ok: true }))

    return route.fulfill(json({}))
  })

  await page.goto(`${baseUrl}/orders/awaiting_shipment`)
  await page.waitForSelector('#ordersTable tbody tr.order-row', { state: 'visible' })

  await expect(page.locator('#row-1108 td[data-col="bestrate"]')).toContainText('10.30')
  await expect(page.locator('#row-1107 td[data-col="bestrate"]')).not.toContainText('8.31')

  await expect.poll(() => requests.some((request) => request.path === '/api/carrier-accounts')).toBe(true)
  await expect.poll(() => requests.some((request) => request.path === '/rates/cached/bulk')).toBe(true)
  await expect.poll(() => requests.some((request) => request.path === '/rates')).toBe(true)
  expect(requests.filter((request) => request.path === '/rates').every((request) => request.body?.forceRefresh !== true)).toBe(true)
})
