import { test, expect } from 'playwright/test'
import { ORDERS_DAILY_STATS_WIRE } from './orders-daily-stats-wire.js'

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
  'api.easypost.com',
  'shipp.to',
  'api.zippopotam.us',
  'onlinetools.ups.com',
  'api.ups.com',
]

let labelCreateShouldFail = false
let labelCreateShouldReturnInvalidUrl = false
let queueAddShouldFail = false
let queueMergeShouldFail = false
let ratesShouldTimeout = false
let ordersApiShouldFail = false
let ordersApiFailedOnce = false
let orderWriteShouldFail = false
let orderDimsWriteShouldFail = false
let destructiveDeleteShouldFail = false
let rateBrowserPartialFailureMode = false
let primaryClientIsTest = true

const requestLedger = []

const clients = [
  { id: 1, name: 'Mock PrepShip Client', active: true, isTest: true, storeId: 101 },
  { id: 2, name: 'Denied Scope Client', active: true, isTest: true, storeId: 202 },
]

function visibleClients() {
  return clients
    .filter((client) => client.id === 1)
    .map((client) => ({
      ...client,
      isTest: client.id === 1 ? primaryClientIsTest : client.isTest,
    }))
}

const packageRows = [
  { id: 1, name: '11x8x6', length: 11, width: 8, height: 6, unitCost: '0.62', source: 'fixture' },
]

const inventoryRows = [
  { id: 1, clientId: 1, sku: 'MOCK-SKU-1', name: 'Mock Snack Box', stockQty: 12, reorderLevel: 4, active: true },
]

const shipStationRateAccounts = [
  { carrier_id: 'se-4101', carrier_code: 'stamps_com', nickname: 'USPS Chase x7439', friendly_name: 'USPS Chase x7439' },
  { carrier_id: 'se-4102', carrier_code: 'ups', nickname: 'ROCEL C81F70', friendly_name: 'ROCEL C81F70' },
  { carrier_id: 'se-4103', carrier_code: 'ups', nickname: 'GG6381', friendly_name: 'GG6381' },
  { carrier_id: 'se-4104', carrier_code: 'ups', nickname: 'ORI Account', friendly_name: 'ORI Account' },
  { carrier_id: 'se-4105', carrier_code: 'fedex', nickname: 'FedEx Ground', friendly_name: 'FedEx Ground' },
  { carrier_id: 'se-4106', carrier_code: 'ups', nickname: 'GREG P...', friendly_name: 'GREG P...' },
  { carrier_id: 'se-4107', carrier_code: 'fedex', nickname: 'FedEx Express', friendly_name: 'FedEx Express' },
]

const directRateAccounts = [
  { id: 1, clientId: 1, provider: 'shipp', label: 'Shipp Carrier', accountIdentifier: 'shipp-test', active: true, assignedClientIds: [1] },
  { id: 2, clientId: 1, provider: 'easypost', label: 'EasyPost Account', accountIdentifier: 'easypost-test', active: true, assignedClientIds: [1] },
  { id: 3, clientId: 1, provider: 'ups', label: 'UPS Carrier', accountIdentifier: 'ups-test', active: true, assignedClientIds: [1] },
]

const scopedDirectRateAccounts = directRateAccounts.map((account) => ({
  carrier_id: `se-${10_000_000 + account.id}`,
  carrier_code: account.provider,
  nickname: account.label,
  friendly_name: account.label,
  source_client_id: account.clientId,
  source_client_name: 'Direct carrier accounts',
  direct_carrier_account_id: account.id,
  direct_carrier_source_table: 'carrier_accounts',
}))

const scopedRateAccounts = [...shipStationRateAccounts, ...scopedDirectRateAccounts]

function withBackendRateProof(rate, key, overrides = {}) {
  const selectedRateCost = Number(rate.selectedRateCost ?? rate.amount ?? rate.cost ?? 0)
  const cShippingRateAmount = Number(rate.cShippingRateAmount ?? selectedRateCost)
  const proof = {
    isComplete: true,
    eligibilityBlocked: false,
    eligibilityBlockReason: null,
    rateQuoteId: `ps321-rq-${key}`,
    selectedRateKey: `ps321-sr-${key}`,
    requestFingerprint: `ps321-fp-${key}`,
    proofSource: 'backend_rate_response',
  }
  const rawOverrides = overrides.raw ?? {}
  return {
    ...rate,
    amount: selectedRateCost,
    shipmentCost: Number(rate.shipmentCost ?? selectedRateCost),
    otherCost: Number(rate.otherCost ?? 0),
    totalCost: selectedRateCost,
    total_cost: selectedRateCost,
    cShippingRateAmount,
    selectedRateCost,
    shippingMarginAmount: Number((cShippingRateAmount - selectedRateCost).toFixed(2)),
    shippingMarginPct: cShippingRateAmount > 0
      ? Number((((cShippingRateAmount - selectedRateCost) / cShippingRateAmount) * 100).toFixed(1))
      : null,
    ...proof,
    ...overrides,
    raw: {
      ...(rate.raw ?? {}),
      ...proof,
      ...rawOverrides,
    },
  }
}

const shipStationRateRows = [
  withBackendRateProof({ carrierCode: 'stamps_com', serviceCode: 'usps_ground_advantage', serviceName: 'USPS Ground Advantage', shippingProviderId: 4101, amount: 5.25, cost: 5.25, shipmentCost: 5.25, otherCost: 0, raw: { carrier_id: 'se-4101' } }, '1'),
  withBackendRateProof({ carrierCode: 'ups', serviceCode: 'ups_ground_saver', serviceName: 'UPS Ground Saver', shippingProviderId: 4102, amount: 6.1, cost: 6.1, shipmentCost: 6.1, otherCost: 0, raw: { carrier_id: 'se-4102' } }, '2'),
  withBackendRateProof({ carrierCode: 'ups', serviceCode: 'ups_ground', serviceName: 'UPS Ground', shippingProviderId: 4103, amount: 7.4, cost: 7.4, shipmentCost: 7.4, otherCost: 0, raw: { carrier_id: 'se-4103' } }, '3'),
  withBackendRateProof({ carrierCode: 'fedex', serviceCode: 'fedex_ground', serviceName: 'FedEx Ground', shippingProviderId: 4105, amount: 8.15, cost: 8.15, shipmentCost: 8.15, otherCost: 0, raw: { carrier_id: 'se-4105' } }, '4'),
  withBackendRateProof({ carrierCode: 'ups', serviceCode: 'ups_3_day_select', serviceName: 'UPS 3 Day Select', shippingProviderId: 4104, amount: 9.7, cost: 9.7, shipmentCost: 9.7, otherCost: 0, raw: { carrier_id: 'se-4104' } }, '5'),
  withBackendRateProof({ carrierCode: 'ups', serviceCode: 'ups_2nd_day_air', serviceName: 'UPS 2nd Day Air', shippingProviderId: 4106, amount: 13.85, cost: 13.85, shipmentCost: 13.85, otherCost: 0, raw: { carrier_id: 'se-4106' } }, '6'),
  withBackendRateProof({ carrierCode: 'fedex', serviceCode: 'fedex_2_day', serviceName: 'FedEx 2Day', shippingProviderId: 4107, amount: 15.45, cost: 15.45, shipmentCost: 15.45, otherCost: 0, raw: { carrier_id: 'se-4107' } }, '7'),
  withBackendRateProof({ carrierCode: 'ups', serviceCode: 'ups_ground_saver_blocked', serviceName: 'PS-321 Blocked Saver', shippingProviderId: 4102, amount: 16.1, cost: 16.1, shipmentCost: 16.1, otherCost: 0, raw: { carrier_id: 'se-4102' } }, 'blocked', {
    eligibilityBlocked: true,
    eligibilityBlockReason: 'Backend blocked by PS-321 fixture',
    raw: { eligibilityBlocked: true, eligibilityBlockReason: 'Backend blocked by PS-321 fixture' },
  }),
  withBackendRateProof({ carrierCode: 'fedex', serviceCode: 'fedex_stale_proof', serviceName: 'PS-321 Stale Proof', shippingProviderId: 4107, amount: 17.45, cost: 17.45, shipmentCost: 17.45, otherCost: 0, raw: { carrier_id: 'se-4107' } }, 'stale', {
    isComplete: false,
    raw: { isComplete: false },
  }),
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
  if (method === 'DELETE' && /^\/(?:clients|locations|packages)\/\d+$/.test(pathname)) {
    if (destructiveDeleteShouldFail) return json({ error: `Delete fixture failure: ${pathname}` }, 500)
    return json({ ok: true })
  }
  if (pathname === '/clients') return json(visibleClients())
  if (pathname === '/users') return json({ users: [] })
  if (pathname === '/locations') return json([])
  if (pathname === '/packages') return json(packageRows)
  if (pathname === '/billing') return json({ invoices: [{ id: 'inv_mock_1', clientId: 1, total: 12.34 }] })
  if (pathname === '/rates/carriers-for-store') {
    const carriers = rateBrowserPartialFailureMode ? scopedRateAccounts : []
    return json({
      carriers,
      data: carriers.map((account) => ({
        carrierId: account.carrier_id,
        carrierCode: account.carrier_code,
        nickname: account.nickname ?? null,
        friendlyName: account.friendly_name ?? account.nickname ?? null,
        sourceClientId: account.source_client_id ?? null,
        sourceClientName: account.source_client_name ?? null,
        ...account,
      })),
      storeId: 101,
      clientId: 1,
      orderId: 101,
    })
  }
  if (/^\/orders\/\d+\/(?:dims|save-dims)$/.test(pathname)) {
    if (orderDimsWriteShouldFail) return json({ error: 'Order dimensions fixture failure' }, 500)
    return json({ data: { l: 11, w: 8, h: 6, weightOz: 16 } })
  }
  if (pathname === '/rates/browse' || pathname === '/rates/browse/workflow') {
    const requested = JSON.parse(request.postData() || '{}')
    const requestedCarrierIds = Array.isArray(requested.carrierIds)
      ? requested.carrierIds.map(String)
      : []
    const scopedRates = shipStationRateRows.filter((rate) => requestedCarrierIds.length === 0 || requestedCarrierIds.includes(rate.raw.carrier_id))
    const directCarrierErrors = rateBrowserPartialFailureMode
      ? [
          { shippingProviderId: 10000001, carrierCode: 'shipp', message: 'Shipp reached the quote API but did not return rates. Confirm the package dimensions, ship-from address, and destination address are valid for your Shipp account.' },
          { shippingProviderId: 10000002, carrierCode: 'easypost', message: 'EasyPost did not return eligible rates for this package and destination.' },
          { shippingProviderId: 10000003, carrierCode: 'ups', message: 'UPS Carrier did not return eligible services for this package and destination.' },
        ]
      : []
    const carrierStatuses = [
      ...shipStationRateAccounts.map((account) => ({
        carrierId: account.carrier_id,
        accountId: account.carrier_id,
        source: 'shipstation',
        carrierName: account.nickname,
        carrierCode: account.carrier_code,
        nickname: account.nickname,
        status: requested.cachedOnly ? 'cached' : 'live',
        rateCount: scopedRates.filter((rate) => rate.raw.carrier_id === account.carrier_id).length,
      })),
      ...scopedDirectRateAccounts.map((account, index) => ({
        carrierId: account.carrier_id,
        accountId: String(account.direct_carrier_account_id),
        source: 'direct',
        carrierName: account.nickname,
        carrierCode: account.carrier_code,
        nickname: account.nickname,
        status: requested.cachedOnly ? 'uncached' : 'error',
        rateCount: 0,
        error: directCarrierErrors[index]?.message,
      })),
    ]
    const carrierDiagnostics = carrierStatuses.map((status) => ({
      carrierId: status.carrierId,
      accountId: status.accountId,
      nickname: status.nickname,
      carrierCode: status.carrierCode,
      source: status.source,
      status: status.status === 'live' ? 'ok' : status.status === 'error' ? 'failed' : status.status,
      rateCount: status.rateCount,
      ...(status.error ? { error: status.error } : {}),
    }))
    const result = {
      requestKey: 'ps321-workflow-request',
      cacheKey: 'ps321-workflow-request',
      cacheExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      rateQuoteId: 'ps321-rate-quote',
      rates: scopedRates,
      bestRate: scopedRates[0] ?? null,
      secondBestRate: scopedRates[1] ?? null,
      cached: false,
      source: requested.cachedOnly ? 'cache' : 'live',
      carrierStatuses,
      carrierDiagnostics,
      directCarrierErrors,
      directCarrierMetas: [],
      directCarrierDiagnostics: carrierDiagnostics.filter((diagnostic) => diagnostic.source === 'direct'),
    }
    if (pathname === '/rates/browse/workflow') {
      const now = new Date().toISOString()
      return json({
        job_id: 'ps321-workflow-job',
        status: 'complete',
        progress: {
          total_carriers: carrierStatuses.length,
          completed_carriers: carrierStatuses.length,
          successful_carriers: shipStationRateAccounts.length,
          failed_carriers: directCarrierErrors.length,
          rates_count: scopedRates.length,
        },
        message: 'Rate browse complete',
        request_key: result.requestKey,
        order_id: 101,
        result,
        diagnostics: null,
        error: null,
        started_at: now,
        updated_at: now,
        finished_at: now,
      })
    }
    return json(result)
  }
  if (pathname === '/rates/multi' && method === 'GET') {
    return json({ carriers: shipStationRateAccounts })
  }
  if (pathname === '/rates/multi' || pathname === '/carriers/rates') {
    if (ratesShouldTimeout) return json({ error: 'Carrier rate provider timed out' }, 504)
    if (rateBrowserPartialFailureMode && pathname === '/rates/multi') {
      const requested = JSON.parse(request.postData() || '{}')
      const requestedCarrierIds = Array.isArray(requested.carrierIds)
        ? requested.carrierIds.map(String)
        : []
      const scopedRates = shipStationRateRows.filter((rate) => requestedCarrierIds.length === 0 || requestedCarrierIds.includes(rate.raw.carrier_id))
      return json({
        rates: scopedRates,
        bestRate: scopedRates[0] ?? null,
        cached: false,
        source: 'live',
        carrierStatuses: shipStationRateAccounts.map((account) => ({
          carrierId: account.carrier_id,
          carrierName: account.nickname,
          status: 'live',
          rateCount: scopedRates.filter((rate) => rate.raw.carrier_id === account.carrier_id).length,
        })),
        carrierDiagnostics: shipStationRateAccounts.map((account) => ({
          carrierId: account.carrier_id,
          nickname: account.nickname,
          source: 'shipstation',
          status: 'ok',
          rateCount: scopedRates.filter((rate) => rate.raw.carrier_id === account.carrier_id).length,
        })),
      })
    }
    if (rateBrowserPartialFailureMode && pathname === '/carriers/rates') {
      const body = JSON.parse(request.postData() || '{}')
      const provider = String(body.provider ?? '').toLowerCase()
      const messages = {
        shipp: 'Shipp reached the quote API but did not return rates. Confirm the package dimensions, ship-from address, and destination address are valid for your Shipp account.',
        easypost: 'EasyPost did not return eligible rates for this package and destination.',
        ups: 'UPS Carrier did not return eligible services for this package and destination.',
      }
      return json({
        ok: false,
        provider,
        error: messages[provider] ?? 'Carrier did not return rates',
      })
    }
    return json({ rates: [{ carrierCode: 'ups', serviceCode: 'ups_ground', cost: 8.12, shippingProviderId: 1 }] })
  }
  if (pathname === '/api/carrier-accounts' || pathname === '/carrier-accounts') {
    return json({ data: rateBrowserPartialFailureMode ? directRateAccounts : [] })
  }
  if (pathname === '/api/store-accounts' || pathname === '/store-accounts') return json({ data: [] })
  if (pathname === '/markups') return json([])
  if (pathname === '/settings/orders.columnPrefs') return json({ value: null })
  if (pathname === '/orders/sync/status') return json({ status: 'idle', lastSyncAt: '2026-05-22T10:00:00.000Z' })
  if (pathname === '/shipments/status') return json({ status: 'idle' })
  if (pathname === '/init/stores') {
    return json({
      data: visibleClients().map((client) => ({
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
  if (pathname === '/orders/daily-stats') return json(ORDERS_DAILY_STATS_WIRE)
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
    if (method === 'PATCH' && orderWriteShouldFail) return json({ error: 'Order write fixture failure' }, 500)
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
  orderWriteShouldFail = false
  orderDimsWriteShouldFail = false
  destructiveDeleteShouldFail = false
  rateBrowserPartialFailureMode = false
  primaryClientIsTest = true
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
  await expect(page.locator('#daily-strip')).toContainText(/63\s*Total Orders/)
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
  await waitForRequest('/print-queue', { method: 'POST', payloadIncludes: ['MOCK-EBAY-101', 'prepship_test_standard'] })
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
  const printAction = page.getByRole('button', { name: /Print Label|Create.*Print Label/i }).first()
  await expect(printAction).toBeVisible({ timeout: 15000 })
  await printAction.click()
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
  // Per user override unlock shipped data on 2026-07-11: mocked-only proof that
  // shipped-label queue failures surface; no real postage or provider calls.
  queueAddShouldFail = true
  await openAwaitingOrderPanel(page)
  const failingQueueAction = page.getByRole('button', { name: /^Print to Queue$/ }).first()
  await expect(failingQueueAction).toBeVisible({ timeout: 15000 })
  await failingQueueAction.click()
  await waitForRequest('/print-queue', { method: 'POST' })
  await expect(page.getByText('Print queue add failure').first()).toBeVisible({ timeout: 15000 })
  expectNoForbiddenExternalRequests()
})

test('Orders write failure rejects and never shows fake success', async ({ page }) => {
  // Per user override unlock shipped data on 2026-07-11: mocked-only failure
  // proof; no production order, label, postage, or marketplace mutation occurs.
  orderWriteShouldFail = true
  await openAwaitingOrderPanel(page)
  await page.getByRole('button', { name: 'change', exact: true }).click()
  await waitForRequest('/orders/101', { method: 'PATCH', payloadIncludes: ['residential'] })
  await expect(page.getByText('Order write fixture failure').first()).toBeVisible({ timeout: 15000 })
  await expect(page.getByText('Address type updated')).toHaveCount(0)
  expectNoForbiddenExternalRequests()
})

test('Order dimensions failure stops shipment-details success', async ({ page }) => {
  // Per user override unlock shipped data on 2026-07-11: mocked-only failure
  // proof; no production order, rate, label, postage, or provider call occurs.
  orderDimsWriteShouldFail = true
  await openAwaitingOrderPanel(page)
  const shipmentInputs = page.getByRole('spinbutton')
  await shipmentInputs.nth(2).fill('11')
  await shipmentInputs.nth(3).fill('8')
  await shipmentInputs.nth(4).fill('6')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await waitForRequest('/orders/101/save-dims', { method: 'POST', payloadIncludes: ['11', '8', '6'] })
  await expect(page.getByText('Order dimensions fixture failure').first()).toBeVisible({ timeout: 15000 })
  await expect(page.getByText('Shipment details saved')).toHaveCount(0)
  expectNoForbiddenExternalRequests()
})

test('client, location, and package delete transports reject backend failures', async ({ page }) => {
  // Mocked-only destructive failure proof; no production records are deleted.
  destructiveDeleteShouldFail = true
  await openAwaitingOrderPanel(page)
  const failures = await page.evaluate(async () => {
    const { apiClient } = await import('/src/api/client.ts')
    const capture = async (operation) => {
      try {
        await operation()
        return 'resolved'
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }
    return {
      client: await capture(() => apiClient.deleteClientRecord(1)),
      location: await capture(() => apiClient.deleteLocationMutation(1)),
      package: await capture(() => apiClient.deletePackageMutation(1)),
    }
  })
  expect(failures.client).toContain('Delete fixture failure: /clients/1')
  expect(failures.location).toContain('Delete fixture failure: /locations/1')
  expect(failures.package).toContain('Delete fixture failure: /packages/1')
  expectRequest('/clients/1', { method: 'DELETE' })
  expectRequest('/locations/1', { method: 'DELETE' })
  expectRequest('/packages/1', { method: 'DELETE' })
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

test('Rate Browser partial carrier failures remain readable and keep successful rates selectable', async ({ page }) => {
  // No real postage, no live provider calls, mocked only.
  rateBrowserPartialFailureMode = true
  primaryClientIsTest = false
  await openAwaitingOrderPanel(page)

  await page.getByRole('button', { name: /Browse Rates/i }).first().click()
  const rateDialog = page.getByRole('dialog', { name: /Rate Browser/i })
  await expect(rateDialog).toBeVisible({ timeout: 15000 })
  const modalNumberInputs = rateDialog.getByRole('spinbutton')
  await modalNumberInputs.nth(2).fill('11')
  await modalNumberInputs.nth(3).fill('8')
  await modalNumberInputs.nth(4).fill('6')
  const refreshRates = rateDialog.getByRole('button', { name: /Refresh Live Rates/i })
  await expect(refreshRates).toBeEnabled({ timeout: 5000 })
  await refreshRates.click()
  await expect(page.getByText(/10 of 10 carriers checked[\s\S]*7 with rates/)).toBeVisible({ timeout: 20000 })
  await expect(page.getByText(/\|\s*live/)).toBeVisible({ timeout: 20000 })
  await expect(page.getByLabel('Hide Unavailable')).toBeChecked()

  await expect(rateDialog.getByText('USPS Chase x7439').first()).toBeVisible()
  await expect(rateDialog.getByText('ROCEL C81F70').first()).toBeVisible()
  await expect(rateDialog.locator('span[title*="Shipp reached the quote API"]')).toBeVisible()
  await expect(rateDialog.locator('span[title*="EasyPost did not return eligible rates"]')).toBeVisible()
  await expect(rateDialog.locator('span[title*="UPS Carrier did not return eligible services"]')).toBeVisible()

  await expect(page.getByText('$5.25').first()).toBeVisible()
  await expect(page.getByText('$6.10').first()).toBeVisible()
  await expect(page.getByText('$7.40').first()).toBeVisible()
  const cheapest = await page.locator('strong').filter({ hasText: '$5.25' }).first().boundingBox()
  const nextCheapest = await page.locator('strong').filter({ hasText: '$6.10' }).first().boundingBox()
  expect(cheapest?.y ?? 0, 'cheapest rate should render before the next-cheapest rate').toBeLessThan(nextCheapest?.y ?? Number.POSITIVE_INFINITY)

  await expect(page.getByText('Backend blocked by PS-321 fixture')).toHaveCount(0)
  await page.getByLabel('Hide Unavailable').uncheck()
  await expect(page.getByText('Backend blocked by PS-321 fixture')).toBeVisible()
  await expect(page.getByText('Backend rate proof unavailable - browse rates again before selecting.').first()).toBeVisible()
  await page.getByLabel('Hide Unavailable').check()

  await rateDialog.getByText('Shipp Carrier').click()
  await expect(page.getByText(/No rates available for/i)).toBeVisible()
  await expect(page.getByText(/Shipp reached the quote API but did not return rates/i)).toBeVisible()

  await page.getByRole('button', { name: /Refresh Live Rates/i }).click()
  await expect(page.getByText(/10 of 10 carriers checked[\s\S]*7 with rates/)).toBeVisible({ timeout: 20000 })

  await rateDialog.locator('strong').filter({ hasText: '$5.25' }).first().click()
  await waitForRequest('/orders/101/apply-best-rate', {
    method: 'POST',
    payloadIncludes: ['ps321-rq-1', 'ps321-sr-1', 'ps321-fp-1', 'backend_rate_response'],
  })

  expectRequest(/rates\/(browse|multi)/, { method: 'POST', payloadIncludes: ['se-4101', 'se-4107'] })
  // QA root-cause 2026-06-23: PS-200 (8c243859) removed the FE direct /carriers/rates fan-out — the
  // Rate Browser now reads failed direct carriers from the /rates/browse/workflow result above,
  // so there are no longer any /carriers/rates POSTs to assert. The partial-failure UX (failure
  // tooltips + "10 of 10 carriers checked · 7 with rates") is verified by the assertions above.
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
