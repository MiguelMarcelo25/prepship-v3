import { test, expect } from 'playwright/test'

// Billing INTERNATIONAL destination badge — visual + behavioral proof.
// Route-mocked (no DB), mirroring billing-ps377-cancelled-rows.spec.
//
// /billing/details returns the grouped DTO carrying the BACKEND-owned
// destinationIsInternational + destinationCountry. This proves the FE renders that
// decision verbatim next to the order number and never re-derives it from a country
// code — notably, the Puerto Rico row carries country 'PR' but
// destinationIsInternational=false (USPS domestic) and must NOT be badged.
//
// The rule itself is proven offline by scripts/billing-destination-international-guard.ts.

const baseUrl = process.env.PREPSHIP_E2E_BASE_URL ?? 'http://127.0.0.1:5177'
const apiOrigin = 'http://127.0.0.1:3000'
const supabaseProjectRef = 'fdkseckgfuvdczzqmnac'

const clients = [{ id: 1, clientId: 1, name: 'Alpha Client', active: true, isTest: false, storeId: 101 }]

function orderRow(overrides) {
  return {
    id: overrides.orderId, orderId: overrides.orderId, orderNumber: overrides.orderNumber,
    lineType: 'billing_order', shipDate: '2026-07-27T00:00:00.000Z', itemNames: 'Leeds Line', totalQty: 1,
    pickpackTotal: 2.5, additionalTotal: 0, packageTotal: 0, shippingTotal: 0, storageTotal: 0,
    pickPackFeeTotal: 2.5, fulfillmentFeeTotal: 2.5, grandTotal: 2.5, totalCost: 0,
    ...overrides,
  }
}

// Mirrors the real shapes read out of production for these orders.
const detailRows = [
  // 3212 — the order that prompted this: Coquitlam BC, country CA.
  orderRow({ orderId: 1801946, orderNumber: '3212', destinationCountry: 'CA', destinationIsInternational: true }),
  // 3219 — a normal US order on the same invoice.
  orderRow({ orderId: 1801950, orderNumber: '3219', destinationCountry: 'US', destinationIsInternational: false, grandTotal: 11.26 }),
  // A UK order — a second foreign country, so the chip is not hardcoded to CA.
  orderRow({ orderId: 1013481, orderNumber: 'GB-1013481', destinationCountry: 'GB', destinationIsInternational: true }),
  // Puerto Rico — non-US code, but USPS DOMESTIC, so the backend says false.
  orderRow({ orderId: 1700001, orderNumber: 'PR-113', destinationCountry: 'PR', destinationIsInternational: false }),
  // No country at all (293 such orders in prod) — must render like a domestic row.
  orderRow({ orderId: 1700002, orderNumber: 'NOCOUNTRY', destinationCountry: null, destinationIsInternational: false }),
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
    if (p === '/billing/summary') return route.fulfill(json({ clients: [{ clientId: 1, count: detailRows.length, total: 21.26, byType: { pick_pack: 21.26 } }], grandTotal: 21.26 }))
    if (p === '/billing/details') return route.fulfill(json({ data: detailRows }))
    if (p === '/billing/shipping-margin') return route.fulfill(json({ data: [], summary: {}, carriers: [], rows: [] }))
    if (p === '/init/stores') return route.fulfill(json({ data: clients.map((c) => ({ id: c.storeId, name: c.name, clientId: c.id })) }))
    if (p === '/init/counts') return route.fulfill(json({ awaiting_shipment: 0, shipped: 5, cancelled: 0 }))
    if (p === '/orders/sync/status' || p === '/shipments/status') return route.fulfill(json({ status: 'idle' }))
    if (p === '/markups') return route.fulfill(json([]))
    return route.fulfill(json({}))
  })
}

test.describe('Billing international destination badge', () => {
  test('an international order is badged beside its order number; domestic and unknown are not', async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 })
    await setup(page)
    await page.goto(`${baseUrl}/billing`)
    await page.getByText('Alpha Client').first().click()

    const intlRow = page.locator('tr', { hasText: '3212' })
    const usRow = page.locator('tr', { hasText: '3219' })
    const gbRow = page.locator('tr', { hasText: 'GB-1013481' })
    const prRow = page.locator('tr', { hasText: 'PR-113' })
    const noCountryRow = page.locator('tr', { hasText: 'NOCOUNTRY' })

    await expect(intlRow).toBeVisible()

    // The Canadian order carries the badge, showing WHICH country.
    const intlBadge = intlRow.locator('[data-billing-badge="INTERNATIONAL"]')
    await expect(intlBadge).toBeVisible()
    await expect(intlBadge).toHaveText('CA')

    // A second foreign country proves the chip is not hardcoded.
    await expect(gbRow.locator('[data-billing-badge="INTERNATIONAL"]')).toHaveText('GB')

    // Domestic US: no badge.
    await expect(usRow.locator('[data-billing-badge="INTERNATIONAL"]')).toHaveCount(0)
    // Puerto Rico: non-US country code, USPS domestic, so NO badge. This is the case a
    // frontend `country !== 'US'` check would get wrong.
    await expect(prRow.locator('[data-billing-badge="INTERNATIONAL"]')).toHaveCount(0)
    // Unknown country: unbadged rather than guessed.
    await expect(noCountryRow.locator('[data-billing-badge="INTERNATIONAL"]')).toHaveCount(0)

    // Visual proof of the badge in place next to the order number.
    await intlRow.screenshot({ path: 'test-results/billing-international-badge-row.png' })
    await page.screenshot({ path: 'test-results/billing-international-badge.png' })
  })
})
