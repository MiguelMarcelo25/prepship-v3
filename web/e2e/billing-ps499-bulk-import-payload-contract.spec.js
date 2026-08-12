import { test, expect } from 'playwright/test'

// PS-499 — DETERMINISTIC MOCKED PAYLOAD-CONTRACT TEST.
//
// SCOPE, stated plainly so this is never miscounted:
//   This proves ONLY what the browser SENDS. It does not prove API acceptance,
//   transactionality, persistence, sidecar state, audit rows, or post-refresh
//   database behaviour. It is NOT Step 12 evidence and does not satisfy any Step 12
//   persistence scenario. Those require a real API against a disposable database —
//   see docs/ps-499-step12-qa-runbook.md.
//
// What it does prove is the half that lives in the browser, which is exactly where
// the July HUGRAB defect was: handleBulkImportRow used to resend every money field
// under non-canonical aliases that collapsed to 0, and the route read a present
// `pickPack: 0` as the PS-389 prep-fee waiver. So the contract under test is that
// an untouched field is ABSENT from the request, never resent at any value.
//
// The server half is proven by scripts/ps-499-route-integration.ts against a real
// route and a real database.

const baseUrl = process.env.PREPSHIP_E2E_BASE_URL ?? 'http://127.0.0.1:5177'
const apiOrigin = 'http://127.0.0.1:3000'
const supabaseProjectRef = 'fdkseckgfuvdczzqmnac'

const CLIENT_ID = 1
const ORDER_ID = 501
const ORDER_NUMBER = '2515'
const BOX_A = { packageId: 42, name: '9x6x3' }
const BOX_B = { packageId: 43, name: '12x10x3' }

const clients = [{ id: CLIENT_ID, clientId: CLIENT_ID, name: 'Alpha Client', active: true, isTest: false, storeId: 101 }]

// One canonical detail row. Note it carries ONLY canonical camelCase totals — no
// `pickPack`, no `additional`, no `packageCost`, no snake_case aliases — exactly as
// billing-detail-row-sot.ts guarantees. If the import ever reads an alias again it
// will read undefined here, which is the bug this file exists to prevent.
const detailRow = {
  id: ORDER_ID,
  orderId: ORDER_ID,
  orderNumber: ORDER_NUMBER,
  lineType: 'billing_order',
  shipDate: '2026-07-01T00:00:00.000Z',
  itemNames: 'Widget',
  itemSkus: 'SKU-1',
  totalQty: 1,
  pickpackTotal: 3.5,
  additionalTotal: 0.75,
  packageTotal: 5.5,
  shippingTotal: 12,
  storageTotal: 0,
  adjustmentTotal: 0,
  pickPackFeeTotal: 4.25,
  fulfillmentFeeTotal: 9.75,
  grandTotal: 21.75,
  totalCost: 0,
  packageId: BOX_A.packageId,
}

const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
const apiPath = (url) => url.pathname.replace(/^\/api/, '') || '/'

/**
 * Installs the auth stub and API mocks, and returns a live array that collects the
 * body of every PATCH /billing/details/:id the browser issues.
 */
async function setup(page) {
  const sent = []

  await page.addInitScript(({ projectRef }) => {
    window.localStorage.setItem(`sb-${projectRef}-auth-token`, JSON.stringify({
      access_token: 'm', refresh_token: 'm', expires_at: Math.floor(Date.now() / 1000) + 3600,
      expires_in: 3600, token_type: 'bearer',
      user: { id: '00000000-0000-4000-8000-000000000042', aud: 'authenticated', role: 'authenticated', email: 'b@e.test' },
    }))
  }, { projectRef: supabaseProjectRef })

  await page.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.hostname.endsWith('supabase.co')) {
      return route.fulfill(json({ user: { id: 'u1', email: 'b@e.test' } }))
    }
    const isApi = url.origin === apiOrigin || url.pathname.startsWith('/api/') || url.origin !== baseUrl
    if (!isApi) return route.continue()

    const path = apiPath(url)

    // The whole point: capture the exact JSON the browser produced.
    if (request.method() === 'PATCH' && /^\/billing\/details\/\d+$/.test(path)) {
      sent.push(JSON.parse(request.postData() ?? '{}'))
      return route.fulfill(json({ ok: true, updated: 1, inserted: 0 }))
    }

    if (path === '/clients') return route.fulfill(json(clients))
    if (path === '/users') return route.fulfill(json({ users: [] }))
    if (path === '/locations') return route.fulfill(json([]))
    if (path === '/packages') {
      return route.fulfill(json({
        data: [
          { id: BOX_A.packageId, name: BOX_A.name, type: 'box', length: 9, width: 6, height: 3 },
          { id: BOX_B.packageId, name: BOX_B.name, type: 'box', length: 12, width: 10, height: 3 },
        ],
      }))
    }
    if (path === '/billing/config') return route.fulfill(json([]))
    if (path === '/billing/package-prices') return route.fulfill(json({ data: [] }))
    if (path === '/billing/fetch-ref-rates/status') return route.fulfill(json({ status: 'idle' }))
    if (path === '/billing/summary') {
      return route.fulfill(json({
        clients: [{
          clientId: CLIENT_ID,
          count: 1,
          total: 21.75,
          byType: { pick_pack: 3.5, additional: 0.75, package_cost: 5.5, storage: 0, shipping: 12 },
        }],
        grandTotal: 21.75,
      }))
    }
    if (path === '/billing/details') return route.fulfill(json({ data: [detailRow] }))
    if (path === '/billing/shipping-margin') {
      return route.fulfill(json({ data: [], summary: {}, carriers: [], rows: [] }))
    }
    if (path === '/init/stores') {
      return route.fulfill(json({ data: clients.map((c) => ({ id: c.storeId, name: c.name, clientId: c.id })) }))
    }
    if (path === '/init/counts') return route.fulfill(json({ awaiting_shipment: 0, shipped: 1, cancelled: 0 }))
    if (path === '/orders/sync/status' || path === '/shipments/status') return route.fulfill(json({ status: 'idle' }))
    if (path === '/settings/orders.columnPrefs') return route.fulfill(json({ value: null }))
    if (path === '/markups') return route.fulfill(json([]))
    return route.fulfill(json({}))
  })

  return sent
}

async function openBulkImport(page) {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${baseUrl}/billing`)
  // Opens the client's Line Items, which is what reveals the import trigger.
  await page.getByText('Alpha Client').first().click()
  await page.locator('[data-billing-bulk-import-trigger]').click()
}

/** Fill the first paste row. `null` leaves a cell blank — which is the whole point. */
async function fillRow(page, { box, shipping }) {
  await page.getByPlaceholder('2553').first().fill(ORDER_NUMBER)
  if (box !== null) await page.getByPlaceholder('9x6x3').first().fill(box)
  if (shipping !== null) await page.getByPlaceholder('20.72').first().fill(shipping)
  await page.getByPlaceholder('e.g. Canada re-shipment — external Unishippers cost')
    .fill('PS-499 payload contract test')
}

const apply = (page) => page.getByRole('button', { name: /^Apply \d+ row/ }).click()

const GENERATED_MONEY = ['pickPack', 'additional', 'packageCost']

function expectNoGeneratedMoney(body) {
  for (const field of GENERATED_MONEY) {
    expect(Object.prototype.hasOwnProperty.call(body, field), `${field} must be ABSENT`).toBe(false)
  }
}

test.describe('PS-499 bulk import payload contract (mocked; not Step 12 evidence)', () => {
  test('a shipping-only paste sends shipping and no generated money field', async ({ page }) => {
    const sent = await setup(page)
    await openBulkImport(page)
    await fillRow(page, { box: null, shipping: '20.83' })
    await apply(page)

    await expect.poll(() => sent.length).toBe(1)
    const body = sent[0]
    expect(body.source).toBe('bulk_import')
    expect(body.shipping).toBe(20.83)
    expectNoGeneratedMoney(body)
    expect(Object.prototype.hasOwnProperty.call(body, 'packageId'), 'packageId must be ABSENT').toBe(false)
  })

  test('a blank box cell omits packageId rather than resending the current box', async ({ page }) => {
    const sent = await setup(page)
    await openBulkImport(page)
    await fillRow(page, { box: null, shipping: '15.00' })
    await apply(page)

    await expect.poll(() => sent.length).toBe(1)
    // The row is stamped with BOX A. Resending it would re-pin the box directive.
    expect(Object.prototype.hasOwnProperty.call(sent[0], 'packageId')).toBe(false)
  })

  test('a blank shipping cell omits shipping rather than sending 0', async ({ page }) => {
    const sent = await setup(page)
    await openBulkImport(page)
    await fillRow(page, { box: BOX_B.name, shipping: null })
    await apply(page)

    await expect.poll(() => sent.length).toBe(1)
    const body = sent[0]
    expect(body.packageId).toBe(BOX_B.packageId)
    // Sending 0 here is precisely the July defect, one field over.
    expect(Object.prototype.hasOwnProperty.call(body, 'shipping'), 'shipping must be ABSENT').toBe(false)
    expectNoGeneratedMoney(body)
  })

  test('an explicitly pasted $0 shipping survives as an own property', async ({ page }) => {
    const sent = await setup(page)
    await openBulkImport(page)
    await fillRow(page, { box: null, shipping: '0' })
    await apply(page)

    await expect.poll(() => sent.length).toBe(1)
    const body = sent[0]
    // 0 is falsy. Any truthiness filter anywhere in the chain drops it, and the
    // operator's explicit decision silently disappears.
    expect(Object.prototype.hasOwnProperty.call(body, 'shipping'), 'an explicit 0 must be SENT').toBe(true)
    expect(body.shipping).toBe(0)
  })

  test('a combined paste sends exactly the box and the shipping', async ({ page }) => {
    const sent = await setup(page)
    await openBulkImport(page)
    await fillRow(page, { box: BOX_B.name, shipping: '20.83' })
    await apply(page)

    await expect.poll(() => sent.length).toBe(1)
    const body = sent[0]
    expect(body.packageId).toBe(BOX_B.packageId)
    expect(body.shipping).toBe(20.83)
    expectNoGeneratedMoney(body)
  })
})
