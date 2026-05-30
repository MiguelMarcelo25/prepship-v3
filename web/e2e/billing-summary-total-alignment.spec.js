import { test, expect } from 'playwright/test'

// PS-042 — Billing summary Total row column alignment.
//
// Root cause fixed: the shared <Table> hardcoded body/header cells to
// text-left and ignored col.align, while the caller-built footer/total row DID
// honor align (right for money). So within each numeric column the body values
// sat left but the Total sat right — they didn't line up. Now the Table honors
// col.align for header + body + footer.
//
// This spec proves, against the rendered DOM, that for each numeric column the
// footer Total cell shares the SAME column position AND the SAME text-alignment
// as the body cells — including after an operator reorders columns (persisted
// in localStorage). Route-mocked (no DB), mirroring billing-best-rate-ui.spec.

const baseUrl = process.env.PREPSHIP_E2E_BASE_URL ?? 'http://127.0.0.1:5177'
const apiOrigin = 'http://127.0.0.1:3000'
const supabaseProjectRef = 'fdkseckgfuvdczzqmnac'

const clients = [
  { id: 1, clientId: 1, name: 'Alpha Client', active: true, isTest: false, storeId: 101 },
  { id: 2, clientId: 2, name: 'Bravo Client', active: true, isTest: false, storeId: 102 },
]

const NUMERIC_KEYS = ['orders', 'pickPack', 'additional', 'package', 'storage', 'shipping', 'total']

function json(body, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) }
}
function apiPath(url) {
  return url.pathname.replace(/^\/api/, '') || '/'
}

async function setup(page, { columnOrder } = {}) {
  await page.addInitScript(({ projectRef, order }) => {
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
    if (order) window.localStorage.setItem('billing-summary-table:order', JSON.stringify(order))
  }, { projectRef: supabaseProjectRef, order: columnOrder ?? null })

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.hostname.endsWith('supabase.co')) { await route.fulfill(json({ user: { id: 'u1', email: 'billing@example.test' } })); return }
    const isApi = url.origin === apiOrigin || url.pathname.startsWith('/api/') || url.origin !== baseUrl
    if (!isApi) { await route.continue(); return }
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
        clients: [
          { clientId: 1, count: 3, total: 41.5, byType: { pick_pack: 12, additional: 2, package_cost: 1.5, storage: 3, shipping: 23 } },
          { clientId: 2, count: 5, total: 88.25, byType: { pick_pack: 20, additional: 4, package_cost: 2.25, storage: 5, shipping: 57 } },
        ],
        grandTotal: 129.75,
      }))
    }
    if (path === '/billing/details') return route.fulfill(json({ data: [] }))
    if (path === '/init/stores') return route.fulfill(json({ data: clients.map((c) => ({ id: c.storeId, name: c.name, clientId: c.id })) }))
    if (path === '/init/counts') return route.fulfill(json({ awaiting_shipment: 0, shipped: 8, cancelled: 0 }))
    if (path === '/orders/sync/status' || path === '/shipments/status') return route.fulfill(json({ status: 'idle' }))
    if (path === '/settings/orders.columnPrefs') return route.fulfill(json({ value: null }))
    if (path === '/markups') return route.fulfill(json([]))
    return route.fulfill(json({}))
  })
}

// The summary table is the only one with a tagged footer total cell.
function summaryTable(page) {
  return page.locator('table').filter({ has: page.locator('td[data-col-footer][data-col-key="total"]') })
}

async function assertColumnAligned(table, key) {
  const header = table.locator(`thead th[data-col-key="${key}"]`).first()
  const bodyCell = table.locator(`tbody td[data-col-key="${key}"]:not([data-col-footer])`).first()
  const footerCell = table.locator(`td[data-col-footer][data-col-key="${key}"]`).first()

  await expect(header, `header ${key} visible`).toBeVisible()
  await expect(footerCell, `footer ${key} visible`).toBeVisible()

  // Semantic: footer total alignment must match the body cell alignment.
  const bodyAlign = await bodyCell.evaluate((el) => window.getComputedStyle(el).textAlign)
  const footerAlign = await footerCell.evaluate((el) => window.getComputedStyle(el).textAlign)
  expect(footerAlign, `footer/body text-align must match for ${key}`).toBe(bodyAlign)
  if (NUMERIC_KEYS.includes(key)) {
    expect(['right', 'end'], `${key} numeric column must be right-aligned`).toContain(footerAlign)
  }

  // Structural: footer cell sits in the SAME column as its header + body
  // (same left edge + width, within tolerance) regardless of column order.
  const [hb, fb, bb] = await Promise.all([header.boundingBox(), footerCell.boundingBox(), bodyCell.boundingBox()])
  expect(Math.abs(fb.x - hb.x), `footer ${key} x must align with header`).toBeLessThanOrEqual(2)
  expect(Math.abs(fb.x - bb.x), `footer ${key} x must align with body`).toBeLessThanOrEqual(2)
  expect(Math.abs(fb.width - hb.width), `footer ${key} width must match header`).toBeLessThanOrEqual(2)
}

test.describe('PS-042 billing summary total-row alignment', () => {
  test('total row aligns under every column (default order)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await setup(page)
    await page.goto(`${baseUrl}/billing`)
    const table = summaryTable(page)
    await expect(table).toBeVisible()
    // Total row present + labelled.
    await expect(table.locator('td[data-col-footer][data-col-key="client"]')).toHaveText('Total')

    await assertColumnAligned(table, 'client')
    for (const key of NUMERIC_KEYS) await assertColumnAligned(table, key)
  })

  test('total row stays aligned after operator reorders columns', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    // Operator-customized order persisted in localStorage: total moved next to client.
    await setup(page, { columnOrder: ['client', 'total', 'shipping', 'storage', 'package', 'additional', 'pickPack', 'orders'] })
    await page.goto(`${baseUrl}/billing`)
    const table = summaryTable(page)
    await expect(table).toBeVisible()

    await assertColumnAligned(table, 'client')
    for (const key of NUMERIC_KEYS) await assertColumnAligned(table, key)
  })
})
