import { test, expect } from 'playwright/test'

// PS-377 — cancelled orders are VISIBLE in Billing as $0 rows with a CANCELLED
// badge. Route-mocked (no DB), mirroring billing-summary-total-alignment.spec.
// /billing/details returns the grouped DTO; a cancelled order carries the
// backend-owned billingStatusBadge='CANCELLED' + $0 totals. This proves the FE
// renders the badge verbatim (it never infers cancellation from $0) and the row
// adds no dollars. The backend $0-semantics + inclusion policy are proven offline
// by scripts/ps-377-cancelled-billing-rows-guard.ts.

const baseUrl = process.env.PREPSHIP_E2E_BASE_URL ?? 'http://127.0.0.1:5177'
const apiOrigin = 'http://127.0.0.1:3000'
const supabaseProjectRef = 'fdkseckgfuvdczzqmnac'

const clients = [{ id: 1, clientId: 1, name: 'Alpha Client', active: true, isTest: false, storeId: 101 }]

function orderRow(overrides) {
  return {
    id: overrides.orderId, orderId: overrides.orderId, orderNumber: overrides.orderNumber,
    lineType: 'billing_order', shipDate: '2026-01-15T00:00:00.000Z', itemNames: 'Widget', totalQty: 1,
    pickpackTotal: 0, additionalTotal: 0, packageTotal: 0, shippingTotal: 0, storageTotal: 0,
    pickPackFeeTotal: 0, fulfillmentFeeTotal: 0, grandTotal: 0, totalCost: 0,
    ...overrides,
  }
}
const detailRows = [
  // A cancelled order — $0, backend-owned CANCELLED badge.
  orderRow({ orderId: 900, orderNumber: 'CANC900', orderStatus: 'cancelled', billingStatusBadge: 'CANCELLED' }),
  // A normal shipped order — keeps its fees, no cancelled badge.
  orderRow({ orderId: 901, orderNumber: 'SHIP901', pickpackTotal: 2.5, pickPackFeeTotal: 2.5, fulfillmentFeeTotal: 2.5, grandTotal: 2.5 }),
]

const json = (b) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) })
const apiPath = (url) => url.pathname.replace(/^\/api/, '') || '/'

async function setup(page) {
  await page.addInitScript(({ projectRef }) => {
    window.localStorage.setItem(`sb-${projectRef}-auth-token`, JSON.stringify({
      access_token: 'm', refresh_token: 'm', expires_at: Math.floor(Date.now() / 1000) + 3600,
      expires_in: 3600, token_type: 'bearer',
      user: { id: '00000000-0000-4000-8000-000000000042', aud: 'authenticated', role: 'authenticated', email: 'b@e.test' },
    }))
  }, { projectRef: supabaseProjectRef })

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.hostname.endsWith('supabase.co')) return route.fulfill(json({ user: { id: 'u1', email: 'b@e.test' } }))
    const isApi = url.origin === apiOrigin || url.pathname.startsWith('/api/') || url.origin !== baseUrl
    if (!isApi) return route.continue()
    const p = apiPath(url)
    if (p === '/clients') return route.fulfill(json(clients))
    if (p === '/users') return route.fulfill(json({ users: [] }))
    if (p === '/locations') return route.fulfill(json([]))
    if (p === '/packages') return route.fulfill(json({ data: [] }))
    if (p === '/billing/config') return route.fulfill(json([]))
    if (p === '/billing/package-prices') return route.fulfill(json({ data: [] }))
    if (p === '/billing/fetch-ref-rates/status') return route.fulfill(json({ status: 'idle' }))
    if (p === '/billing/summary') return route.fulfill(json({ clients: [{ clientId: 1, count: 2, total: 2.5, byType: { pick_pack: 2.5 } }], grandTotal: 2.5 }))
    if (p === '/billing/details') return route.fulfill(json({ data: detailRows }))
    if (p === '/billing/shipping-margin') return route.fulfill(json({ data: [], summary: {}, carriers: [], rows: [] }))
    if (p === '/init/stores') return route.fulfill(json({ data: clients.map((c) => ({ id: c.storeId, name: c.name, clientId: c.id })) }))
    if (p === '/init/counts') return route.fulfill(json({ awaiting_shipment: 0, shipped: 1, cancelled: 1 }))
    if (p === '/orders/sync/status' || p === '/shipments/status') return route.fulfill(json({ status: 'idle' }))
    if (p === '/markups') return route.fulfill(json([]))
    return route.fulfill(json({}))
  })
}

test.describe('PS-377 cancelled billing rows', () => {
  test('a cancelled order is visible at $0 with a CANCELLED badge; a shipped order is not', async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 })
    await setup(page)
    await page.goto(`${baseUrl}/billing`)
    await page.getByText('Alpha Client').first().click()

    const cancelledRow = page.locator('tr', { hasText: 'CANC900' })
    const shippedRow = page.locator('tr', { hasText: 'SHIP901' })
    await expect(cancelledRow).toBeVisible()
    await expect(shippedRow).toBeVisible()

    // The cancelled order shows the backend-owned CANCELLED badge…
    await expect(cancelledRow.locator('[data-billing-badge="CANCELLED"]')).toBeVisible()
    // …at $0 (it must not add dollars: its fulfillment-fee cell reads $0.00).
    await expect(cancelledRow).toContainText('$0.00')

    // A shipped order keeps its fee and carries no cancelled badge.
    await expect(shippedRow.locator('[data-billing-badge="CANCELLED"]')).toHaveCount(0)
    await expect(shippedRow).toContainText('$2.50')
  })
})
