import { test, expect } from 'playwright/test'

// PS-375 — a manual Edit Billing Detail save of Box Cost $0.00 clears the
// No box cost / Needs Review affordance after refresh. Route-mocked with a
// STATEFUL /billing/details: it returns the order as a NO_BOX_COST review row
// until the PATCH save fires, then returns it resolved (the backend fix makes
// the $0 save emit an explicit $0 package_cost line → boxCostAlert=false). This
// proves the end-to-end operator flow: open modal → enter 0.00 → Save → the
// badge is gone and the modal closed.

const baseUrl = process.env.PREPSHIP_E2E_BASE_URL ?? 'http://127.0.0.1:5177'
const apiOrigin = 'http://127.0.0.1:3000'
const supabaseProjectRef = 'fdkseckgfuvdczzqmnac'

const clients = [{ id: 1, clientId: 1, name: 'Alpha Client', active: true, isTest: false, storeId: 101 }]

function orderRow(overrides) {
  return {
    id: 700, orderId: 700, orderNumber: 'REVIEW700', lineType: 'billing_order',
    shipDate: '2026-01-15T00:00:00.000Z', itemNames: 'Widget', itemSkus: 'SKU-1', totalQty: 1,
    pickpackTotal: 2.5, additionalTotal: 0, packageTotal: 0, shippingTotal: 5, storageTotal: 0,
    pickPackFeeTotal: 2.5, fulfillmentFeeTotal: 7.5, grandTotal: 7.5, totalCost: 0,
    boxCostNoCharge: false, packageCostNeedsReview: false, clientHasBoxPricing: true,
    ...overrides,
  }
}
// Before the save: an unresolved box → NO_BOX_COST alert. After: an explicit $0
// package_cost line → resolved (what the PS-375 backend fix produces).
const reviewRow = orderRow({ hasPackageCostLine: false, boxCostAlert: true, billingBadges: ['NO_BOX_COST'] })
const resolvedRow = orderRow({ hasPackageCostLine: true, boxCostAlert: false, billingBadges: [] })

const json = (b) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) })
const apiPath = (url) => url.pathname.replace(/^\/api/, '') || '/'

test.describe('PS-375 manual $0 box-cost save clears the review', () => {
  test('save Box Cost 0.00 → the No box cost badge is gone after refresh', async ({ page }) => {
    let saved = false // flips when the PATCH save fires; drives the stateful details mock.

    await page.setViewportSize({ width: 1500, height: 900 })
    await page.addInitScript(({ projectRef }) => {
      window.localStorage.setItem(`sb-${projectRef}-auth-token`, JSON.stringify({
        access_token: 'm', refresh_token: 'm', expires_at: Math.floor(Date.now() / 1000) + 3600,
        expires_in: 3600, token_type: 'bearer',
        user: { id: '00000000-0000-4000-8000-000000000042', aud: 'authenticated', role: 'authenticated', email: 'b@e.test' },
      }))
    }, { projectRef: supabaseProjectRef })

    await page.route('**/*', async (route) => {
      const req = route.request()
      const url = new URL(req.url())
      if (url.hostname.endsWith('supabase.co')) return route.fulfill(json({ user: { id: 'u1', email: 'b@e.test' } }))
      const isApi = url.origin === apiOrigin || url.pathname.startsWith('/api/') || url.origin !== baseUrl
      if (!isApi) return route.continue()
      const p = apiPath(url)
      // The manual save. Flip state so the next /billing/details is resolved.
      if (req.method() === 'PATCH' && /^\/billing\/details\/\d+$/.test(p)) {
        saved = true
        return route.fulfill(json({ ok: true, orderId: 700, clientId: 1, updated: 1, inserted: 1 }))
      }
      if (p === '/clients') return route.fulfill(json(clients))
      if (p === '/users') return route.fulfill(json({ users: [] }))
      if (p === '/locations') return route.fulfill(json([]))
      if (p === '/packages') return route.fulfill(json({ data: [] }))
      if (p === '/billing/config') return route.fulfill(json([]))
      if (p === '/billing/package-prices') return route.fulfill(json({ data: [] }))
      if (p === '/billing/fetch-ref-rates/status') return route.fulfill(json({ status: 'idle' }))
      if (p === '/billing/summary') return route.fulfill(json({ clients: [{ clientId: 1, count: 1, total: 7.5, byType: { pick_pack: 2.5, shipping: 5 } }], grandTotal: 7.5 }))
      if (p === '/billing/details') return route.fulfill(json({ data: [saved ? resolvedRow : reviewRow] }))
      if (p === '/billing/shipping-margin') return route.fulfill(json({ data: [], summary: {}, carriers: [], rows: [] }))
      if (p === '/init/stores') return route.fulfill(json({ data: clients.map((c) => ({ id: c.storeId, name: c.name, clientId: c.id })) }))
      if (p === '/init/counts') return route.fulfill(json({ awaiting_shipment: 0, shipped: 1, cancelled: 0 }))
      if (p === '/orders/sync/status' || p === '/shipments/status') return route.fulfill(json({ status: 'idle' }))
      if (p === '/markups') return route.fulfill(json([]))
      return route.fulfill(json({}))
    })

    await page.goto(`${baseUrl}/billing`)
    await page.getByText('Alpha Client').first().click()

    const row = page.locator('tr', { hasText: 'REVIEW700' })
    const badge = row.locator('[data-billing-badge="NO_BOX_COST"]')

    // Before: the row shows the No box cost review affordance.
    await expect(badge).toBeVisible()

    // Open the Edit modal via the row's Edit button, enter 0.00, Save.
    await row.getByRole('button', { name: 'Edit', exact: true }).click()
    const boxCostInput = page.locator('label').filter({ hasText: 'Box Cost' }).locator('input')
    await expect(boxCostInput).toBeVisible()
    await boxCostInput.fill('0')
    // The modal's primary action is Save (a Check icon + "Save"); target it by its
    // stable class in the modal action row rather than the icon-affected a11y name.
    await page.locator('.billing-edit-actions button.btn-primary').click()

    // After: the save refetched details (now resolved) and the badge is gone.
    await expect(page.locator('label').filter({ hasText: 'Box Cost' })).toHaveCount(0) // modal closed
    await expect(page.locator('tr', { hasText: 'REVIEW700' }).locator('[data-billing-badge="NO_BOX_COST"]')).toHaveCount(0)
  })
})
