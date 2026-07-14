import { test, expect } from 'playwright/test'
import { ORDERS_DAILY_STATS_WIRE } from './orders-daily-stats-wire.js'

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

test('protected app does not show maintenance for health probe network failure when app APIs work', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await seedSession(page)

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.hostname.endsWith('supabase.co')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: null }) })
      return
    }
    if (url.pathname === '/health/ready') {
      await route.abort('failed')
      return
    }
    if (url.origin !== baseUrl || url.pathname.startsWith('/api/')) {
      if (url.pathname === '/clients') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) })
        return
      }
      if (url.pathname === '/clients/order-stats') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) })
        return
      }
      if (url.pathname === '/users') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ users: [] }) })
        return
      }
      if (url.pathname === '/init/stores') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) })
        return
      }
      if (url.pathname === '/init/counts') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ awaiting_shipment: 0, shipped: 0, cancelled: 0 }) })
        return
      }
      if (url.pathname === '/orders') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 1 } }),
        })
        return
      }
      if (url.pathname === '/orders/daily-stats') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ORDERS_DAILY_STATS_WIRE) })
        return
      }
      if (url.pathname === '/orders/sync/status' || url.pathname === '/shipments/status') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'idle' }) })
        return
      }
      if (url.pathname === '/settings/orders.columnPrefs') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ value: null }) })
        return
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) })
      return
    }
    await route.continue()
  })

  await page.goto(`${baseUrl}/orders/awaiting_shipment`)

  await expect(page.getByRole('heading', { name: "We'll be back soon" })).toHaveCount(0)
  await expect(page.locator('#view-orders')).toBeVisible()
  await expect(page.locator('#daily-strip')).toContainText(/63\s*Total Orders/)
})
