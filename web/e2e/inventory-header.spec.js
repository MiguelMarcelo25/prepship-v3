import { test, expect } from 'playwright/test'

// ============================================================================
// Inventory section header — operator request 2026-09-03.
//
// Stock Levels no longer shows a Refresh button: with four import/edit actions
// already in the header it wrapped onto its own row. The other Inventory tabs
// have no other header action, so they keep Refresh.
//
// Header-only proof, deliberately independent of the stock table: the header
// renders from static tab metadata above the table, so an empty /inventory
// payload is enough. Offline, mocked backend, seeded Supabase session (project
// ref pinned in playwright.config.js).
// ============================================================================

const baseUrl = 'http://127.0.0.1:5177'
const apiOrigin = 'http://127.0.0.1:3000'
const supabaseProjectRef = 'fdkseckgfuvdczzqmnac'

const clients = [{ id: 1, name: 'KF Goods', active: true, isTest: false, storeId: 101 }]
const emptyPage = { data: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 1 } }

function json(body) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) }
}

function responseFor(url) {
  if (url.hostname.endsWith('supabase.co')) return json({ user: null })
  const isApiRequest = url.origin === apiOrigin || url.origin !== baseUrl || url.pathname.startsWith('/api/')
  if (!isApiRequest) return null
  if (url.pathname === '/health/ready') return json({ status: 'ready', components: [{ name: 'db', status: 'ok' }] })
  if (url.pathname === '/clients') return json(clients)
  if (url.pathname === '/users') return json({ users: [{ id: 'u1', email: 'operator@example.com', isAdmin: true }] })
  if (url.pathname === '/init/stores') {
    return json({ data: clients.map((c) => ({ id: c.storeId, storeId: c.storeId, name: c.name, storeName: c.name, clientName: c.name, clientId: c.id, active: true, isTest: false })) })
  }
  if (url.pathname === '/init/counts') return json({ byStatus: {}, byStatusStore: {} })
  if (url.pathname === '/inventory') return json(emptyPage)
  if (url.pathname === '/inventory/ledger') return json({ data: [] })
  if (url.pathname === '/parent-skus') return json({ data: [] })
  if (url.pathname === '/locations') return json([])
  return json({})
}

async function setup(page) {
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
  await page.setViewportSize({ width: 1680, height: 950 })
  await page.route('**/*', async (route) => {
    const mocked = responseFor(new URL(route.request().url()))
    if (mocked) { await route.fulfill(mocked); return }
    await route.continue()
  })
}

const actions = (page) => page.locator('.inventory-section-header-actions')

test.describe('Inventory section header', () => {
  test('Stock Levels has no Refresh button but keeps its import/edit actions', async ({ page }) => {
    await setup(page)
    await page.goto(`${baseUrl}/inventory/stock-levels`)
    await expect(page.getByRole('heading', { name: 'Stock Levels' })).toBeVisible()
    await expect(actions(page).getByRole('button', { name: /Import SKUs from Orders/ })).toBeVisible()
    await expect(actions(page).getByRole('button', { name: /Purge Test Data/ })).toBeVisible()
    await expect(actions(page).getByRole('button', { name: /Refresh/ })).toHaveCount(0)

    const shots = process.env.INVENTORY_HEADER_SHOTS
    if (shots) await page.screenshot({ path: `${shots}/inventory-header-stock.png` })
  })

  test('the other tabs keep their Refresh button', async ({ page }) => {
    await setup(page)
    for (const [slug, heading] of [
      ['receive', 'Receive Inventory'],
      ['alerts', 'Low / Out-of-Stock Alerts'],
      ['history', 'Inventory History'],
    ]) {
      await page.goto(`${baseUrl}/inventory/${slug}`)
      await expect(page.getByRole('heading', { name: heading })).toBeVisible()
      await expect(actions(page).getByRole('button', { name: /Refresh/ })).toBeVisible()
    }
    const shots = process.env.INVENTORY_HEADER_SHOTS
    if (shots) await page.screenshot({ path: `${shots}/inventory-header-history.png` })
  })
})
