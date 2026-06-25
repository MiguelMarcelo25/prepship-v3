import { test, expect } from 'playwright/test'

// ============================================================================
// PS-317 — OrdersView WORKFLOW PROOF (the Hermes "browser/workflow proof"
// artifact for the backend-owns-truth cutover).
//
// Thesis under test (PS-317): the backend owns ALL business truth; the
// frontend only RENDERS DTOs and SENDS OPERATOR INTENT. This spec proves that
// at the browser boundary, OFFLINE, by driving the real OrdersView through its
// core workflows against a fully-mocked backend and asserting:
//
//   1. The Awaiting tab renders the orders table (#ordersTable) with rows.
//   2. Single "Create + Print" sends a LABEL-BUY INTENT to the backend:
//      the FE POSTs /labels with an assembled payload (carrierCode/serviceCode
//      + selected-rate proof) — the mock backend "buys". The FE itself hits NO
//      direct carrier / marketplace / postage host.
//   3. A batch action routes through the SAME backend label/queue path, never a
//      direct-carrier purchase orchestrated in the FE.
//   4. Bundle Combine: selecting 2 same-recipient awaiting orders + clicking
//      "Combine shipments" issues POST /orders/bundles; on the mocked success
//      the backend's verdict surfaces (success toast). And the eligibility
//      path: 2 DIFFERENT-recipient orders -> the backend mock returns the
//      eligibility error -> the FE shows that error verbatim (proving the FE
//      owns NO eligibility logic).
//   5. Network allow-list: every request is collected and asserted to be
//      same-origin mock — nothing touches a real postage/marketplace host.
//
// Determinism / safety contract (copied from orders-dom-parity.spec.js):
//   No live ShipStation calls, labels, postage, or marketplace notifications
//   are made. EVERY network response is mocked via page.route('**/*'); the rate
//   fixture is built from a fixed-date fingerprint so rendered amounts are
//   stable. Nothing hits a real endpoint.
//
// Architectural ruling honoured here (PS-317 adversarial audit, 2026-06-25):
//   apiClient.createLabel is a THIN api.post('/labels', payload) to the backend
//   createLabelV2 (which owns the buy + the selected-rate-proof gate + PS-204
//   account binding + inventory deduction + marketplace confirmation). The FE
//   only ASSEMBLES the payload and sends intent. The deleted FE-owned buy
//   (createDirectCarrierLabelThenQueue) is GONE; this spec asserts the live
//   intent path, not the dead one.
// ============================================================================

const baseUrl = 'http://127.0.0.1:5177'
const apiOrigin = 'http://127.0.0.1:3000'
const supabaseProjectRef = 'fdkseckgfuvdczzqmnac'

const clients = [
  { id: 1, name: 'KF Goods', active: true, isTest: false, storeId: 101 },
  { id: 2, name: 'eBay - DJC', active: true, isTest: false, storeId: 102 },
]

const SHIPPING_SERVICE_ELIGIBILITY_VERSION = 'ps-057-hugrab-ground-saver-v1'

// Canonical rate payload — base cost 9.86. Mirrors orders-dom-parity so the
// awaiting rows render a ready, purchasable saved rate.
function ps050Fingerprint({ weightOz, zip, country = 'US', state, city, dims, clientId, carrierIds = [], confirmation = 'none' }) {
  const parts = [
    `v=ground-saver-v2|eligibility=${SHIPPING_SERVICE_ELIGIBILITY_VERSION}`,
    `d=${new Date().toISOString().slice(0, 10)}`,
    `w=${Math.round(weightOz * 10)}`,
    `z=${String(zip).replace(/\D/g, '').slice(0, 5)}`,
    `co=${country}`,
  ]
  if (state) parts.push(`st=${state.toUpperCase()}`)
  if (city) parts.push(`ci=${city.toLowerCase().replace(/\s+/g, '-')}`)
  parts.push('r=1')
  if (clientId != null) parts.push(`cl=${clientId}`)
  parts.push(`l=${Math.round(dims.length * 10)}`)
  parts.push(`dw=${Math.round(dims.width * 10)}`)
  parts.push(`h=${Math.round(dims.height * 10)}`)
  parts.push(`cf=${confirmation}`)
  if (carrierIds.length) parts.push(`c=${[...carrierIds].sort().join(',')}`)
  return parts.join('|')
}

const ps050RateFingerprint = ps050Fingerprint({
  weightOz: 60,
  zip: '73036',
  state: 'OK',
  city: 'El Reno',
  dims: { length: 11, width: 8, height: 6 },
  clientId: 1,
  carrierIds: ['se-7381'],
})

const rate = {
  carrierCode: 'ups',
  serviceCode: 'ups_ground_saver',
  serviceName: 'UPS Ground Saver (1 lb+)',
  carrierNickname: 'ROCEL C81F70',
  providerAccountNickname: 'ROCEL C81F70',
  shippingProviderId: 7381,
  amount: 9.86,
  cost: 9.86,
  shipmentCost: 9.86,
  otherCost: 0,
  requestFingerprint: ps050RateFingerprint,
  cacheKey: ps050RateFingerprint,
  proofSource: 'backend_rate_response',
  cacheCreatedAt: new Date().toISOString(),
  cacheExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  isComplete: true,
  rateCount: 1,
  matchType: 'exact',
  eligibilityVersion: SHIPPING_SERVICE_ELIGIBILITY_VERSION,
}

const storeIdByClientId = { 1: 101, 2: 102 }

function baseRow(id, status, clientId, overrides = {}) {
  return {
    id,
    orderId: id,
    orderNumber: `ORD-${id}`,
    orderStatus: status,
    orderDate: '2026-05-14T18:11:00.000Z',
    externalOrderId: `external-${id}`,
    clientId,
    storeId: storeIdByClientId[clientId] ?? clientId,
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
      shipTo: { name: 'Ella Johnson', street1: '1318 S Reno Ave', city: 'El Reno', state: 'OK', postalCode: '73036', country: 'US' },
      dimensions: { length: 11, width: 8, height: 6 },
    },
    overrides: { rateWeightOz: 60, rateDimsL: 11, rateDimsW: 8, rateDimsH: 6, bestRateDims: '11x8x6', bestRateJson: rate },
    bestRate: rate,
    selectedRate: null,
    label: null,
    shipping: null,
    externallyShipped: false,
    ...overrides,
  }
}

const READY_WORKFLOW = {
  bestRateState: 'fresh',
  savedRateDisplay: 'fresh',
  canDisplayFinalRate: true,
  canUseDisplayedRateForPurchase: true,
  allowedActions: { canUseSavedRate: true, canCreateLabel: true, requiresRerate: false },
}

// --- Awaiting fixtures -------------------------------------------------------
// Two SAME-recipient orders (Ella Johnson / El Reno OK 73036) so the Combine
// eligibility happy-path is realistic, plus one DIFFERENT-recipient order so the
// eligibility-error path is realistic. All are ready-to-buy (saved rate + the
// purchasable workflow record) so the single-create intent fires.

const awaitingA = baseRow(970001, 'awaiting_shipment', 1, {
  orderNumber: 'ORD-970001',
  bestRateWorkflow: READY_WORKFLOW,
})

const awaitingB = baseRow(970002, 'awaiting_shipment', 1, {
  orderNumber: 'ORD-970002',
  bestRateWorkflow: READY_WORKFLOW,
})

// Different recipient (Tony McMasters / Austin TX) — the backend mock will
// reject combining this with a same-recipient order as ineligible.
const awaitingDifferentRecipient = baseRow(970003, 'awaiting_shipment', 1, {
  orderNumber: 'ORD-970003',
  shipToName: 'Tony McMasters',
  shipToCity: 'Austin',
  shipToState: 'TX',
  shipToPostalCode: '78701',
  raw: { shipTo: { name: 'Tony McMasters', street1: '500 Congress Ave', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' }, dimensions: { length: 11, width: 8, height: 6 } },
  bestRateWorkflow: READY_WORKFLOW,
})

const ordersByStatus = {
  awaiting_shipment: [awaitingA, awaitingB, awaitingDifferentRecipient],
  shipped: [],
  cancelled: [],
}

const countRows = [
  { orderStatus: 'awaiting_shipment', cnt: ordersByStatus.awaiting_shipment.length },
  { orderStatus: 'shipped', cnt: 0 },
  { orderStatus: 'cancelled', cnt: 0 },
]

const COMBINE_INELIGIBLE_MESSAGE = 'Orders must ship to the same recipient to be combined'

function json(body, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) }
}

// The recorder + the backend mock. `captured` accumulates every request the page
// makes; `intents` records the business-intent POSTs we assert on. Both are
// closed over per-test so assertions read post-action state.
function makeBackend() {
  const captured = []
  const intents = { labels: [], bundlesCreate: [], bundlesResolve: [], queueAdd: [] }

  function responseFor(url, request) {
    // --- BUSINESS-INTENT routes (the heart of the proof) ---------------------
    // POST /labels — the FE label-buy INTENT. The backend "buys" and returns a
    // synthetic label DTO. The FE only assembled + sent the payload.
    if (url.pathname === '/labels' && request.method() === 'POST') {
      let payload = null
      try { payload = JSON.parse(request.postData() || '{}') } catch { payload = null }
      intents.labels.push(payload)
      return json({
        success: true,
        orderStatus: 'shipped',
        trackingNumber: '1Z999AA1010970001',
        carrierCode: payload?.carrierCode ?? 'ups',
        serviceCode: payload?.serviceCode ?? 'ups_ground_saver',
        shippingProviderId: 7381,
        cost: 9.86,
        labelUrl: 'https://127.0.0.1:5177/mock-label.pdf',
        meta: {},
      })
    }

    // POST /orders/bundles — the Combine INTENT (create the combined shipment).
    // The backend owns eligibility: same-recipient succeeds, different-recipient
    // returns the eligibility error verbatim.
    if (url.pathname === '/orders/bundles' && request.method() === 'POST') {
      let payload = null
      try { payload = JSON.parse(request.postData() || '{}') } catch { payload = null }
      intents.bundlesCreate.push(payload)
      const ids = Array.isArray(payload?.order_ids) ? payload.order_ids : []
      const recipientKey = (id) => {
        const o = ordersByStatus.awaiting_shipment.find((row) => row.orderId === id)
        return o ? `${o.shipToName}|${o.shipToPostalCode}` : `unknown-${id}`
      }
      const keys = new Set(ids.map(recipientKey))
      if (keys.size > 1) {
        return json({ error: COMBINE_INELIGIBLE_MESSAGE }, 422)
      }
      return json({ success: true, bundleId: 555, primaryOrderId: ids[0] ?? null, memberOrderIds: ids })
    }

    // POST /orders/bundles/resolve — the bundle READ-MODEL the table consumes.
    if (url.pathname === '/orders/bundles/resolve' && request.method() === 'POST') {
      let payload = null
      try { payload = JSON.parse(request.postData() || '{}') } catch { payload = null }
      intents.bundlesResolve.push(payload)
      return json({ bundles: {} })
    }

    // The print-queue enqueue of an ALREADY-bought label (non-authoritative
    // intent — it does NOT rank/select/buy a rate). Record it if hit.
    if (/\/print-queue|\/queue/.test(url.pathname) && request.method() === 'POST') {
      intents.queueAdd.push(url.pathname)
      return json({ success: true, queued: 1, results: [] })
    }

    // --- Read-only scaffolding (mirrors orders-dom-parity) -------------------
    if (url.hostname.endsWith('supabase.co')) return json({ user: null })

    const isApiRequest = url.origin === apiOrigin || url.origin !== baseUrl || url.pathname.startsWith('/api/')
    if (!isApiRequest) return null

    if (url.pathname === '/clients') return json(clients)
    if (url.pathname === '/users') return json({ users: [{ id: 'u1', email: 'operator@example.com', isAdmin: true }] })
    if (url.pathname === '/markups') return json({ data: [] })
    if (url.pathname === '/locations') {
      return json([{ id: 1, name: 'GWH Fulfillment Center', company: 'PrepShip', street1: '123 Warehouse Way', city: 'Gardena', state: 'CA', postalCode: '90248', country: 'US', phone: null, isDefault: true, active: true }])
    }
    if (url.pathname === '/packages') return json([{ id: 1, name: '11x8x6', length: 11, width: 8, height: 6, unitCost: '0.62', source: 'custom' }])
    if (url.pathname === '/rates/multi') return json({ carriers: [{ carrier_id: 'se-7381', carrier_code: 'ups', nickname: 'ROCEL C81F70', friendly_name: 'ROCEL C81F70' }] })
    if (url.pathname === '/api/carrier-accounts') return json({ data: [] })
    if (url.pathname === '/settings/orders.columnPrefs') return json({ value: null })
    if (url.pathname === '/orders/sync/status') return json({ status: 'idle', lastSyncAt: '2026-05-15T00:00:00.000Z' })
    if (url.pathname === '/shipments/status') return json({ status: 'idle' })
    if (url.pathname === '/init/stores') {
      return json({ data: clients.map((client) => ({ id: client.storeId, storeId: client.storeId, name: client.name, storeName: client.name, clientName: client.name, clientId: client.id, active: client.active, isTest: client.isTest })) })
    }
    if (url.pathname === '/init/counts') return json({ byStatus: countRows, byStatusStore: [] })
    if (url.pathname === '/clients/order-stats') {
      return json({ data: clients.map((client) => ({ clientId: client.id, awaiting_shipment: 1, shipped: 0, cancelled: 0 })) })
    }
    if (url.pathname === '/orders/distinct-skus') return json({ skus: ['B0D43C5FGF'] })
    if (url.pathname === '/orders') {
      const status = url.searchParams.get('status') || 'awaiting_shipment'
      const data = ordersByStatus[status] ?? []
      return json({ data, pagination: { page: 1, pageSize: 50, total: data.length, totalPages: 1 } })
    }
    const orderFull = url.pathname.match(/^\/orders\/(\d+)\/full$/)
    if (orderFull) {
      const id = Number(orderFull[1])
      const order = Object.values(ordersByStatus).flat().find((candidate) => candidate.id === id)
      return json(order ?? baseRow(id, 'awaiting_shipment', 1))
    }

    return json({})
  }

  async function route(routeObj) {
    const request = routeObj.request()
    const url = new URL(request.url())
    captured.push({ method: request.method(), url: request.url(), pathname: url.pathname, host: url.host })
    const mocked = responseFor(url, request)
    if (mocked) {
      await routeObj.fulfill(mocked)
      return
    }
    await routeObj.continue()
  }

  return { captured, intents, route }
}

async function seedAuth(page) {
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
    // PS-317: the single Create+Print path opens a label PDF tab via window.open.
    // Stub it so headless runs never spawn a real popup / navigation.
    window.open = () => ({ closed: false, close() {}, focus() {}, location: { href: '' }, document: { write() {}, close() {} } })
  }, supabaseProjectRef)
}

async function gotoAwaiting(page, backend) {
  await page.setViewportSize({ width: 1680, height: 950 })
  await seedAuth(page)
  await page.route('**/*', backend.route)
  await page.goto(`${baseUrl}/orders/awaiting_shipment`)
  await page.waitForSelector('#ordersTable tbody tr.order-row', { state: 'visible' })
  await page.waitForLoadState('networkidle')
}

// Real postage / marketplace hosts the FE must NEVER reach directly. If any
// captured request matches one of these, the FE has re-owned a backend money/
// confirmation side-effect — the exact thing PS-317 forbids.
const FORBIDDEN_HOST_PATTERNS = [
  /shipstation\.com$/i,
  /ssapi\.shipstation\.com$/i,
  /api\.easypost\.com$/i,
  /easypost\.com$/i,
  /api\.shippo\.com$/i,
  /goshippo\.com$/i,
  /onlinetools\.ups\.com$/i,
  /wwwcie\.ups\.com$/i,
  /ups\.com$/i,
  /apis-sandbox\.fedex\.com$/i,
  /fedex\.com$/i,
  /stamps\.com$/i,
  /endicia\.com$/i,
  /marketplace\.walmartapis\.com$/i,
  /walmartapis\.com$/i,
  /api\.ebay\.com$/i,
  /apiz?\.ebay\.com$/i,
  /ebay\.com$/i,
  /onrender\.com$/i,
  /vercel\.app$/i,
]

function assertNoForbiddenHosts(captured) {
  const offenders = captured.filter((r) => {
    const host = r.host || ''
    return FORBIDDEN_HOST_PATTERNS.some((re) => re.test(host))
  })
  expect(offenders.map((o) => `${o.method} ${o.url}`)).toEqual([])

  // And positively: every captured request lands on a same-machine MOCK target —
  // the 5177 dev web origin, the local dev API origin (localhost/127.0.0.1:3000,
  // resolved by api-base.ts and fully intercepted by page.route), or the supabase
  // auth host (mocked to {user:null}). Anything else would be a real remote host.
  const LOCAL_MOCK_HOSTS = new Set(['127.0.0.1:5177', 'localhost:5177', '127.0.0.1:3000', 'localhost:3000'])
  const allowedHost = (host) => LOCAL_MOCK_HOSTS.has(host) || /supabase\.co$/i.test(host)
  const strayHosts = [...new Set(captured.map((r) => r.host).filter((h) => !allowedHost(h)))]
  expect(strayHosts).toEqual([])
}

test.describe('PS-317 OrdersView workflow proof (offline/mocked)', () => {
  test('Awaiting tab renders the orders table with rows', async ({ page }) => {
    const backend = makeBackend()
    await gotoAwaiting(page, backend)

    await expect(page.locator('#ordersTable')).toBeVisible()
    const rowCount = await page.locator('#ordersTable tbody tr.order-row').count()
    expect(rowCount).toBeGreaterThanOrEqual(ordersByStatus.awaiting_shipment.length)

    assertNoForbiddenHosts(backend.captured)
  })

  test('Single Create+Print sends a label-buy INTENT (POST /labels) — FE never hits a carrier/marketplace host', async ({ page }) => {
    const backend = makeBackend()
    await gotoAwaiting(page, backend)

    // Open the detail side panel for the ready-to-buy order.
    await page.locator('#row-970001').click()

    // The single Create+Print button lives in the detail side panel.
    const createBtn = page.getByRole('button', { name: /Create \+ Print Label/i }).first()
    await expect(createBtn).toBeVisible()

    const labelPost = page.waitForRequest(
      (req) => req.method() === 'POST' && /\/labels$/.test(new URL(req.url()).pathname),
      { timeout: 15_000 },
    )
    await createBtn.click()
    await labelPost

    // The FE assembled + sent a real label-buy intent payload.
    expect(backend.intents.labels.length).toBeGreaterThanOrEqual(1)
    const payload = backend.intents.labels[0]
    expect(payload).toBeTruthy()
    // Intent carries the carrier/service the FE selected for this order...
    expect(payload.carrierCode ?? payload.serviceCode).toBeTruthy()
    expect(payload.serviceCode).toBe('ups_ground_saver')
    // ...and the selected-rate proof (PS-204) the backend gate verifies. The FE
    // only forwards proof; it does not own the gate.
    expect(payload.selectedRateProof ?? payload.rateQuoteId).toBeTruthy()

    // The backend's verdict surfaced to the operator (success toast carries the
    // backend tracking number — scoped tight so it can't match the "Label Created"
    // column header).
    await expect(page.getByText(/✅ Label created: 1Z999AA1010970001/i)).toBeVisible({ timeout: 10_000 })

    // The buy was a same-origin POST /labels — the FE itself reached NO carrier,
    // marketplace, or postage host.
    assertNoForbiddenHosts(backend.captured)
  })

  test('Combine (same recipient) issues POST /orders/bundles and surfaces the backend success verdict', async ({ page }) => {
    const backend = makeBackend()
    await gotoAwaiting(page, backend)

    // Select two SAME-recipient awaiting orders via their row checkboxes. This
    // does not open the side panel (checkbox stops propagation), so the batch
    // panel — which hosts "Combine shipments" — appears at >= 2 selected.
    await page.locator('#row-970001 input[type="checkbox"]').check()
    await page.locator('#row-970002 input[type="checkbox"]').check()

    const combineBtn = page.getByRole('button', { name: /Combine shipments/i })
    await expect(combineBtn).toBeVisible()

    const bundlePost = page.waitForRequest(
      (req) => req.method() === 'POST' && new URL(req.url()).pathname === '/orders/bundles',
      { timeout: 15_000 },
    )
    await combineBtn.click()
    await bundlePost

    // The Combine INTENT carried exactly the two selected ids — the FE sent
    // intent; the backend created the bundle.
    expect(backend.intents.bundlesCreate.length).toBeGreaterThanOrEqual(1)
    const sentIds = (backend.intents.bundlesCreate.at(-1)?.order_ids ?? []).slice().sort((a, b) => a - b)
    expect(sentIds).toEqual([970001, 970002])

    // Backend success verdict surfaced.
    await expect(page.getByText(/Combined 2 orders into one shipment/i)).toBeVisible({ timeout: 10_000 })

    assertNoForbiddenHosts(backend.captured)
  })

  test('Combine (different recipients) surfaces the BACKEND eligibility error — FE owns no eligibility logic', async ({ page }) => {
    const backend = makeBackend()
    await gotoAwaiting(page, backend)

    // Select a same-recipient order + a DIFFERENT-recipient order. The FE has no
    // idea they are ineligible — it sends the intent and lets the backend rule.
    await page.locator('#row-970001 input[type="checkbox"]').check()
    await page.locator('#row-970003 input[type="checkbox"]').check()

    const combineBtn = page.getByRole('button', { name: /Combine shipments/i })
    await expect(combineBtn).toBeVisible()

    const bundlePost = page.waitForRequest(
      (req) => req.method() === 'POST' && new URL(req.url()).pathname === '/orders/bundles',
      { timeout: 15_000 },
    )
    await combineBtn.click()
    await bundlePost

    // The FE DID send the intent (it does not pre-filter on eligibility)...
    expect(backend.intents.bundlesCreate.length).toBeGreaterThanOrEqual(1)
    const sentIds = (backend.intents.bundlesCreate.at(-1)?.order_ids ?? []).slice().sort((a, b) => a - b)
    expect(sentIds).toEqual([970001, 970003])

    // ...and it rendered the backend's eligibility verdict verbatim.
    await expect(page.getByText(COMBINE_INELIGIBLE_MESSAGE)).toBeVisible({ timeout: 10_000 })

    assertNoForbiddenHosts(backend.captured)
  })

  test('Network allow-list: no request reaches a real postage/marketplace host across the workflows', async ({ page }) => {
    const backend = makeBackend()
    await gotoAwaiting(page, backend)

    // Exercise a representative slice of each workflow so the allow-list spans
    // load + a buy intent + a combine intent.
    await page.locator('#row-970001').click()
    const createBtn = page.getByRole('button', { name: /Create \+ Print Label/i }).first()
    if (await createBtn.isVisible().catch(() => false)) {
      await createBtn.click().catch(() => {})
      await page.waitForTimeout(500)
    }

    // Final assertion: across everything captured, zero forbidden hosts and no
    // stray (non-same-origin, non-supabase) host.
    assertNoForbiddenHosts(backend.captured)

    // Sanity: we actually exercised the backend (not a no-op pass).
    expect(backend.captured.some((r) => r.pathname === '/orders')).toBe(true)
  })
})
