import { test, expect } from 'playwright/test'

// PS-374 — a confirmed $0.00 box cost is resolved, not "No box cost".
//
// Route-mocked (no DB), mirroring billing-summary-total-alignment.spec. Proves the
// user-visible symptom from the bug screenshot: in the Billing Line Items table,
// an order whose box cost was resolved to an explicit $0.00 shows NO "No box cost"
// review affordance, while an order with a genuinely missing box cost still does.
//
// /billing/details returns the grouped billing-detail DTO (toBillingDetailOrderRows);
// the FE renders the No box cost affordance purely from the backend-owned
// boxCostAlert / NO_BOX_COST badge (BillingNoBoxCostAction — no FE policy math). So
// this pins the FE half of the fix: given the backend DTO the PS-374 change now
// produces for a resolved $0 (boxCostAlert=false), the prompt is gone. The backend
// half — that decidePackageCostLine emits a resolved $0 line so the DTO carries
// boxCostAlert=false — is proven offline by scripts/ps-374-resolved-zero-box-cost-guard.ts.
// The MISSING row is the built-in positive control that the badge selector is valid.

const baseUrl = process.env.PREPSHIP_E2E_BASE_URL ?? 'http://127.0.0.1:5177'
const apiOrigin = 'http://127.0.0.1:3000'
const supabaseProjectRef = 'fdkseckgfuvdczzqmnac'

const clients = [{ id: 1, clientId: 1, name: 'Alpha Client', active: true, isTest: false, storeId: 101 }]

// One grouped billing-order DTO row. Zeroed money + the box-cost review surface
// fields the FE reads (BillingDetailTable → hasBillingNoBoxCostAlert).
function orderRow(overrides) {
  return {
    id: overrides.orderId,
    orderId: overrides.orderId,
    orderNumber: overrides.orderNumber,
    lineType: 'billing_order',
    shipDate: '2026-01-15T00:00:00.000Z',
    itemNames: 'Widget',
    itemSkus: 'SKU-1',
    totalQty: 1,
    pickpackTotal: 1,
    additionalTotal: 0,
    packageTotal: 0,
    shippingTotal: 0,
    storageTotal: 0,
    pickPackFeeTotal: 1,
    fulfillmentFeeTotal: 1,
    grandTotal: 1,
    totalCost: 0,
    boxCostNoCharge: false,
    packageCostNeedsReview: false,
    ...overrides,
  }
}

// The PS-374 fix makes the backend emit these two DTOs. RESOLVED-$0: an explicit
// $0 package_cost line → hasPackageCostLine true, boxCostAlert false. MISSING: no
// box line at all → boxCostAlert true + NO_BOX_COST badge.
const detailRows = [
  orderRow({
    orderId: 500,
    orderNumber: 'BOXZERO',
    hasPackageCostLine: true,
    boxCostAlert: false,
    billingBadges: [],
  }),
  orderRow({
    orderId: 501,
    orderNumber: 'BOXMISSING',
    hasPackageCostLine: false,
    boxCostAlert: true,
    billingBadges: ['NO_BOX_COST'],
  }),
]

function json(body, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) }
}
function apiPath(url) {
  return url.pathname.replace(/^\/api/, '') || '/'
}

async function setup(page) {
  await page.addInitScript(({ projectRef }) => {
    const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60
    window.localStorage.setItem(
      `sb-${projectRef}-auth-token`,
      JSON.stringify({
        access_token: 'mock-access-token',
        refresh_token: 'mock-refresh-token',
        expires_at: expiresAt,
        expires_in: 3600,
        token_type: 'bearer',
        user: { id: '00000000-0000-4000-8000-000000000042', aud: 'authenticated', role: 'authenticated', email: 'billing@example.test' },
      }),
    )
  }, { projectRef: supabaseProjectRef })

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.hostname.endsWith('supabase.co')) {
      await route.fulfill(json({ user: { id: 'u1', email: 'billing@example.test' } }))
      return
    }
    const isApi = url.origin === apiOrigin || url.pathname.startsWith('/api/') || url.origin !== baseUrl
    if (!isApi) {
      await route.continue()
      return
    }
    const path = apiPath(url)
    if (path === '/clients') return route.fulfill(json(clients))
    if (path === '/users') return route.fulfill(json({ users: [] }))
    if (path === '/locations') return route.fulfill(json([]))
    if (path === '/packages') return route.fulfill(json({ data: [] }))
    if (path === '/billing/config') return route.fulfill(json([]))
    if (path === '/billing/package-prices') return route.fulfill(json({ data: [] }))
    if (path === '/billing/fetch-ref-rates/status') return route.fulfill(json({ status: 'idle' }))
    if (path === '/billing/summary') {
      return route.fulfill(json({
        clients: [{ clientId: 1, count: 2, total: 2, byType: { pick_pack: 2, additional: 0, package_cost: 0, storage: 0, shipping: 0 } }],
        grandTotal: 2,
      }))
    }
    if (path === '/billing/details') return route.fulfill(json({ data: detailRows }))
    if (path === '/billing/shipping-margin') return route.fulfill(json({ data: [], summary: {}, carriers: [], rows: [] }))
    if (path === '/init/stores') return route.fulfill(json({ data: clients.map((c) => ({ id: c.storeId, name: c.name, clientId: c.id })) }))
    if (path === '/init/counts') return route.fulfill(json({ awaiting_shipment: 0, shipped: 2, cancelled: 0 }))
    if (path === '/orders/sync/status' || path === '/shipments/status') return route.fulfill(json({ status: 'idle' }))
    if (path === '/settings/orders.columnPrefs') return route.fulfill(json({ value: null }))
    if (path === '/markups') return route.fulfill(json([]))
    return route.fulfill(json({}))
  })
}

test.describe('PS-374 resolved $0 box cost clears the review prompt', () => {
  test('a resolved $0 row shows NO "No box cost" prompt; a missing row still does', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await setup(page)
    await page.goto(`${baseUrl}/billing`)

    // Open the client's Line Items (loads /billing/details).
    await page.getByText('Alpha Client').first().click()

    const missingRow = page.locator('tr', { hasText: 'BOXMISSING' })
    const resolvedRow = page.locator('tr', { hasText: 'BOXZERO' })
    await expect(missingRow).toBeVisible()
    await expect(resolvedRow).toBeVisible()

    // Positive control: a genuinely missing box cost STILL shows the No box cost
    // affordance — proves the selector is valid and the alert path still works.
    await expect(missingRow.locator('[data-billing-badge="NO_BOX_COST"]')).toBeVisible()

    // The fix: a resolved $0 box cost shows NO No box cost / review affordance.
    await expect(resolvedRow.locator('[data-billing-badge="NO_BOX_COST"]')).toHaveCount(0)
  })
})
