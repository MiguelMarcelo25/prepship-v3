import { test, expect } from 'playwright/test'
import { ORDERS_DAILY_STATS_WIRE } from './orders-daily-stats-wire.js'

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

// PS-050 exactness matrix evidence:
// - different ZIP invalidation
// - different weight invalidation
// - different eligible carrier/account set invalidation
// - ship-date bucket invalidation
// - confirmation invalidation
// Same dims alone are never enough; the route must return exact or miss.

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

const cheaperCurrentRate = {
  ...exactFreshRate,
  amount: 7.25,
  cost: 7.25,
  shipmentCost: 7.25,
  requestFingerprint: 'ps050-cheaper-current-fingerprint',
}

// Exact backend-owned row workflow shape from withOrderRowWorkflow() in
// src/services/shipping-workflow/best-rate-workflow-dto.ts. Orders mount is
// passive; a displayable saved rate arrives through this /orders DTO contract.
function freshOrderWorkflow(rate) {
  return {
    bestRateState: 'fresh',
    requestFingerprint: rate.requestFingerprint,
    backendRequestKey: rate.requestFingerprint,
    sourceConfidence: 'cache_fresh',
    carrierStatuses: [],
    allowedActions: {
      canUseSavedRate: true,
      requiresRerate: false,
      canCreateLabel: true,
      canRate: true,
      canBrowseRates: true,
      canRecalculate: true,
      canQueueLabel: true,
      canMarkExternalShipped: true,
      canApplyBestRate: true,
      canPrintToQueue: true,
      canEditPackage: true,
      canSelectRow: true,
    },
    savedRateDisplay: 'fresh',
    canDisplayFinalRate: true,
    canUseDisplayedRateForPurchase: true,
    needsDisplayRefresh: false,
    activeRateCheckState: 'none',
    rowState: 'final',
    lifecycleState: 'awaiting',
    rateState: 'final',
    labelState: 'none',
    queueState: 'can_queue',
    packageState: 'resolved',
    blockedReasons: {},
    display: {
      carrierCode: rate.carrierCode,
      serviceCode: rate.serviceCode,
      accountNickname: rate.carrierNickname,
      providerAccountId: rate.shippingProviderId,
    },
    queueRoute: 'backend',
    money: {
      baseAmount: rate.shipmentCost,
      markedAmount: rate.shipmentCost,
      markupAmount: 0,
      insuranceAddOn: null,
      marginPercent: null,
      source: 'best_rate',
      markupSource: 'carrier_markup',
      rateAdjustmentKind: 'customer_profit_markup',
      cShippingRateAmount: rate.shipmentCost,
      selectedRateCost: rate.shipmentCost,
      shippingMarginAmount: 0,
      shippingMarginPct: null,
      houseApplied: false,
      houseBadgeVisible: false,
      customerRateSource: 'best_rate_marked_amount',
      rateCostSource: 'best_rate_internal_cost',
    },
    marketplace: null,
  }
}

function makeOrder(id, bestRate, overrides = {}) {
  const { bestRateWorkflow = null, ...rateOverrides } = overrides
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
      ...rateOverrides,
    },
    bestRate,
    selectedRate: null,
    label: null,
    shipping: bestRate ? { bestRate, bestRateAmount: bestRate.shipmentCost, bestRateDims: '12x10x3' } : null,
    bestRateWorkflow,
  }
}

const staleOrder = makeOrder(1107, staleDimsOnlyRate)
const freshOrder = makeOrder(1108, exactFreshRate, {
  bestRateWorkflow: freshOrderWorkflow(exactFreshRate),
})
const cheaperOrder = makeOrder(1109, {
  ...staleDimsOnlyRate,
  requestFingerprint: 'ps050-old-more-expensive-fingerprint',
  cacheKey: 'ps050-old-more-expensive-fingerprint',
  cacheCreatedAt: new Date().toISOString(),
  cacheExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  isComplete: false,
  rateCount: 1,
  matchType: 'stale',
})
const orders = [staleOrder, freshOrder, cheaperOrder]

function json(body) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) }
}

test('Awaiting Shipment passively consumes backend rate workflow and rejects unproven saved rates', async ({ page }) => {
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
    if (url.pathname === '/orders/daily-stats') return route.fulfill(json(ORDERS_DAILY_STATS_WIRE))
    if (url.pathname === '/orders/sync/status') return route.fulfill(json({ status: 'idle' }))
    if (url.pathname === '/shipments/status') return route.fulfill(json({ status: 'idle' }))
    if (url.pathname === '/init/stores') return route.fulfill(json({ data: [{ id: 101, storeId: 101, name: 'KF Goods', clientId: 1, active: true, isTest: false }] }))
    if (url.pathname === '/init/counts') return route.fulfill(json({ byStatus: [{ orderStatus: 'awaiting_shipment', cnt: 3 }], byStatusStore: [] }))
    if (url.pathname === '/clients/order-stats') return route.fulfill(json({ data: [{ clientId: 1, awaiting_shipment: 3, shipped: 0, cancelled: 0 }] }))
    if (url.pathname === '/orders/distinct-skus') return route.fulfill(json({ skus: ['B0D43C5FGF'] }))
    if (url.pathname === '/orders') return route.fulfill(json({ data: orders, pagination: { page: 1, pageSize: 50, total: 3, totalPages: 1 } }))
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
          { orderId: 1109, matchType: 'miss', hit: null, isComplete: false, cacheKey: 'ps050-cheaper-current-miss' },
        ],
      }))
    }
    if (url.pathname === '/rates') {
      expect(body?.forceRefresh, 'passive auto-rating must not force live refresh').not.toBe(true)
      const responseRate = body?.orderId === 1109 ? cheaperCurrentRate : exactFreshRate
      return route.fulfill(json({
        // prior saved best is not assumed best: live/current-equivalent response
        // can expose a cheaper eligible rate than the old saved $8.31.
        rates: [responseRate, staleDimsOnlyRate],
        bestRate: responseRate,
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
  await expect(page.locator('#daily-strip')).toContainText(/63\s*Total Orders/)

  await expect(page.locator('#row-1108 td[data-col="bestrate"]')).toContainText('10.30')
  await expect(page.locator('#row-1107 td[data-col="bestrate"]')).not.toContainText('8.31')
  await expect(page.locator('#row-1109 td[data-col="bestrate"]')).not.toContainText(/8\.31|7\.25/)

  expect(requests.some((request) => request.path === '/rates/cached/bulk')).toBe(false)
  expect(requests.some((request) => request.path === '/rates')).toBe(false)
})
