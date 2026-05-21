import { test, expect } from 'playwright/test'

const baseUrl = 'http://127.0.0.1:5177'
const supabaseProjectRef = 'fdkseckgfuvdczzqmnac'

async function seedSession(page) {
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
        user: {
          id: '00000000-0000-4000-8000-000000000001',
          aud: 'authenticated',
          role: 'authenticated',
          email: 'operator@example.com',
        },
      }),
    )
  }, supabaseProjectRef)
}

test('protected app shows maintenance page while API health is unavailable', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await seedSession(page)

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.hostname.endsWith('supabase.co')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: null }) })
      return
    }
    if (url.pathname === '/health/ready') {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'degraded', db: 'down' }),
      })
      return
    }
    if (url.origin !== baseUrl || url.pathname.startsWith('/api/')) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'deploying' }) })
      return
    }
    await route.continue()
  })

  await page.goto(`${baseUrl}/orders/awaiting_shipment`)

  await expect(page.getByRole('heading', { name: "We'll be back soon" })).toBeVisible()
  await expect(page.getByText('Waiting for backend services')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Check again' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue to app' })).toBeVisible()
  await expect(page.locator('#view-orders')).toHaveCount(0)
})
