import { test, expect } from 'playwright/test'

// PS-376 — every $0 Billing shipping row is flagged for review, with its reason,
// on EVERY page. Route-mocked (no DB), mirroring billing-summary-total-alignment.
// /billing/details returns the grouped DTO the FE renders; each $0-shipping order
// carries the backend-owned shippingZeroNeedsReview + zeroShippingReviewReason /
// label / severity. This proves the FE half: the Shipping cell shows the
// data-billing-badge="ZERO_SHIPPING_REVIEW" chip (with the reason) for every $0
// row, a positive-shipping row shows none, and the badge survives pagination.
// The backend reason classification is proven offline by
// scripts/ps-376-zero-shipping-review-reason-guard.ts.

const baseUrl = process.env.PREPSHIP_E2E_BASE_URL ?? 'http://127.0.0.1:5177'
const apiOrigin = 'http://127.0.0.1:3000'
const supabaseProjectRef = 'fdkseckgfuvdczzqmnac'

const clients = [{ id: 1, clientId: 1, name: 'Alpha Client', active: true, isTest: false, storeId: 101 }]

// Day N → newest-first sort key (higher day = nearer the top / page 1).
const shipDate = (day) => `2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`
function baseRow(orderId, orderNumber, day) {
  return {
    id: orderId, orderId, orderNumber, lineType: 'billing_order', shipDate: shipDate(day),
    itemNames: 'Widget', itemSkus: 'SKU-1', totalQty: 1,
    pickpackTotal: 1, additionalTotal: 0, packageTotal: 0, shippingTotal: 0, storageTotal: 0,
    pickPackFeeTotal: 1, fulfillmentFeeTotal: 1, grandTotal: 1, totalCost: 0,
  }
}
function zeroRow(orderId, orderNumber, day, reason, label, severity) {
  return {
    ...baseRow(orderId, orderNumber, day),
    shippingZeroNeedsReview: true,
    zeroShippingReviewReason: reason,
    zeroShippingReviewLabel: label,
    zeroShippingReviewSeverity: severity,
  }
}
function posRow(orderId, orderNumber, day) {
  return { ...baseRow(orderId, orderNumber, day), shippingTotal: 7.5, fulfillmentFeeTotal: 8.5, grandTotal: 8.5 }
}

// Page 1 (50 newest): the four reason variants at the top + a positive control.
const detailRows = [
  zeroRow(1, 'Z0CANCEL', 60, 'cancelled_or_not_shipped', 'Cancelled — review prep fee', 'warn'),
  zeroRow(2, 'Z0BUNDLE', 59, 'bundled_with_order', 'Bundled — shipping on another order', 'info'),
  zeroRow(3, 'Z0NOPROOF', 58, 'missing_shipping_proof', '$0 shipping — no shipment proof', 'warn'),
  zeroRow(4, 'Z0UNKNOWN', 57, 'zero_shipping_unknown', '$0 shipping — review', 'warn'),
  posRow(5, 'POSCTRL', 56),
]
// Filler positive rows (days 55..7) to push past one page (default 50/page).
for (let day = 55, id = 6; day >= 7; day -= 1, id += 1) detailRows.push(posRow(id, `POS-${id}`, day))
// The OLDEST row → guaranteed onto page 2 under newest-first sort.
detailRows.push(zeroRow(999, 'Z0PAGE2', 1, 'zero_shipping_unknown', '$0 shipping — review', 'warn'))

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
    if (p === '/billing/summary') return route.fulfill(json({ clients: [{ clientId: 1, count: detailRows.length, total: 0, byType: {} }], grandTotal: 0 }))
    if (p === '/billing/details') return route.fulfill(json({ data: detailRows }))
    if (p === '/billing/shipping-margin') return route.fulfill(json({ data: [], summary: {}, carriers: [], rows: [] }))
    if (p === '/init/stores') return route.fulfill(json({ data: clients.map((c) => ({ id: c.storeId, name: c.name, clientId: c.id })) }))
    if (p === '/init/counts') return route.fulfill(json({ awaiting_shipment: 0, shipped: detailRows.length, cancelled: 0 }))
    if (p === '/orders/sync/status' || p === '/shipments/status') return route.fulfill(json({ status: 'idle' }))
    if (p === '/settings/orders.columnPrefs') return route.fulfill(json({ value: null }))
    if (p === '/markups') return route.fulfill(json([]))
    return route.fulfill(json({}))
  })
}

const badge = (reason) => `[data-billing-badge="ZERO_SHIPPING_REVIEW"]${reason ? `[data-zero-shipping-reason="${reason}"]` : ''}`

test.describe('PS-376 $0 shipping review badge', () => {
  test('every $0 shipping row is flagged with its reason; positive rows are not; survives pagination', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 950 })
    await setup(page)
    await page.goto(`${baseUrl}/billing`)
    await page.getByText('Alpha Client').first().click()

    // Page 1: each reason variant shows the badge with the correct reason.
    await expect(page.locator('tr', { hasText: 'Z0CANCEL' }).locator(badge('cancelled_or_not_shipped'))).toBeVisible()
    await expect(page.locator('tr', { hasText: 'Z0BUNDLE' }).locator(badge('bundled_with_order'))).toBeVisible()
    await expect(page.locator('tr', { hasText: 'Z0NOPROOF' }).locator(badge('missing_shipping_proof'))).toBeVisible()
    await expect(page.locator('tr', { hasText: 'Z0UNKNOWN' }).locator(badge('zero_shipping_unknown'))).toBeVisible()

    // The positive-shipping control row carries NO badge.
    await expect(page.locator('tr', { hasText: 'POSCTRL' }).locator(badge())).toHaveCount(0)

    // The page-2 row is not rendered yet (paginated out)…
    await expect(page.locator('tr', { hasText: 'Z0PAGE2' })).toHaveCount(0)
    // …paginate to it and confirm the badge still renders on the next page. The
    // summary table also has a (disabled, 1-page) Next; target the enabled one
    // (the detail table's).
    await page.getByRole('button', { name: 'Next', exact: true, disabled: false }).click()
    await expect(page.locator('tr', { hasText: 'Z0PAGE2' }).locator(badge('zero_shipping_unknown'))).toBeVisible()
  })
})
