import { test, expect } from 'playwright/test'

// ============================================================================
// Settings rail — operator request 2026-09-03.
//
// The Settings tab rail used to carry an "Automations" pointer tab whose only
// job was to send the operator to the top-level Automations workspace, which
// already has its own sidebar entry. The tab is gone; the legacy
// /settings/automation bookmark still redirects (Home.tsx, PS-466).
//
// Offline: every API call is mocked with an empty object except the shell
// scaffolding. The rail renders from static tab metadata, so that is enough.
// The Supabase session is a SEEDED localStorage mock (project ref pinned in
// playwright.config.js).
// ============================================================================

const baseUrl = 'http://127.0.0.1:5177'
const apiOrigin = 'http://127.0.0.1:3000'
const supabaseProjectRef = 'fdkseckgfuvdczzqmnac'

const clients = [{ id: 1, name: 'KF Goods', active: true, isTest: false, storeId: 101 }]

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

test.describe('Settings rail', () => {
  test('has no Automations tab; Automations stays in the sidebar', async ({ page }) => {
    await setup(page)
    await page.goto(`${baseUrl}/settings/pending`)

    const rail = page.locator('[aria-label="Settings sections"]')
    await expect(rail).toBeVisible()
    await expect(rail.getByRole('tab', { name: /Pending/ })).toBeVisible()
    await expect(rail.getByRole('tab', { name: /Automations/ })).toHaveCount(0)

    const tabNames = await rail.getByRole('tab').allInnerTexts()
    expect(tabNames.map((t) => t.trim())).toEqual(
      expect.arrayContaining(['Markups', 'Locations', 'Stores', 'Carriers', 'Pending', 'Sandbox', 'Cache', 'System']),
    )
    expect(tabNames.some((t) => /Automations/.test(t))).toBe(false)

    // The sidebar entry is the one that remains.
    await expect(page.locator('aside, nav').getByText('Automations', { exact: true }).first()).toBeVisible()

    const shots = process.env.SETTINGS_RAIL_SHOTS
    if (shots) await page.screenshot({ path: `${shots}/settings-rail.png` })
  })

  test('the legacy /settings/automation bookmark still lands on Automations', async ({ page }) => {
    await setup(page)
    await page.goto(`${baseUrl}/settings/automation`)
    await expect(page).toHaveURL(/\/automations$/)
  })
})
