import { test, expect } from 'playwright/test'

const baseUrl = process.env.PREPSHIP_E2E_BASE_URL ?? 'http://127.0.0.1:5177'
const apiOrigin = 'http://127.0.0.1:3000'
const supabaseProjectRef = 'fdkseckgfuvdczzqmnac'

const clients = [
  { id: 1, clientId: 1, name: 'Mock Billing Client', active: true, isTest: false, storeId: 101 },
]

const billingDetails = [
  {
    id: 9001,
    orderId: 501,
    orderNumber: 'BILL-501',
    shipDate: '2026-05-28T12:00:00.000Z',
    clientId: 1,
    carrierNickname: 'UPS Main',
    itemNames: 'Mock Item',
    itemSkus: 'MOCK-SKU',
    totalQty: 1,
    pickpackTotal: 4,
    additionalTotal: 0,
    packageTotal: 0.5,
    packageName: '12x10x3',
    actualLabelCost: 8.12,
    ref_ups_rate: 9.44,
    ref_usps_rate: 7.95,
    shippingTotal: 8.12,
    fulfillmentFeeTotal: 12.62,
    lineType: 'shipping',
  },
]

function json(body, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  }
}

function apiPath(url) {
  return url.pathname.replace(/^\/api/, '') || '/'
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
        user: {
          id: '00000000-0000-4000-8000-000000000043',
          aud: 'authenticated',
          role: 'authenticated',
          email: 'billing@example.test',
        },
      }),
    )
  }, supabaseProjectRef)

  await page.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())

    if (url.hostname.endsWith('supabase.co')) {
      await route.fulfill(json({ user: { id: 'u1', email: 'billing@example.test' } }))
      return
    }

    const isApiRequest = url.origin === apiOrigin || url.pathname.startsWith('/api/') || url.origin !== baseUrl
    if (!isApiRequest) {
      await route.continue()
      return
    }

    const path = apiPath(url)
    if (path === '/clients') {
      await route.fulfill(json(clients))
      return
    }
    if (path === '/users') {
      await route.fulfill(json({ users: [] }))
      return
    }
    if (path === '/locations') {
      await route.fulfill(json([]))
      return
    }
    if (path === '/packages') {
      await route.fulfill(json({ data: [] }))
      return
    }
    if (path === '/billing/config') {
      await route.fulfill(json([]))
      return
    }
    if (path === '/billing/package-prices') {
      await route.fulfill(json({ data: [] }))
      return
    }
    if (path === '/billing/fetch-ref-rates/status') {
      await route.fulfill(json({ status: 'idle' }))
      return
    }
    if (path === '/billing/summary') {
      await route.fulfill(json({
        clients: [{
          clientId: 1,
          count: 1,
          total: 12.62,
          byType: {
            pick_pack: 4,
            package_cost: 0.5,
            shipping: 8.12,
          },
        }],
        grandTotal: 12.62,
      }))
      return
    }
    if (path === '/billing/details') {
      await route.fulfill(json({ data: billingDetails }))
      return
    }
    if (path === '/init/stores') {
      await route.fulfill(json({ data: clients.map((client) => ({ id: client.storeId, name: client.name, clientId: client.id })) }))
      return
    }
    if (path === '/init/counts') {
      await route.fulfill(json({ awaiting_shipment: 0, shipped: 1, cancelled: 0 }))
      return
    }
    if (path === '/orders/sync/status' || path === '/shipments/status') {
      await route.fulfill(json({ status: 'idle' }))
      return
    }
    if (path === '/settings/orders.columnPrefs') {
      await route.fulfill(json({ value: null }))
      return
    }
    if (path === '/markups') {
      await route.fulfill(json([]))
      return
    }

    await route.fulfill(json({}))
  })
}

test('Billing Detail Best Rate cell has no blue outline', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await setup(page)
  await page.goto(`${baseUrl}/billing`)

  await expect(page.getByText('Mock Billing Client')).toBeVisible()
  await page.getByText('Mock Billing Client').click()

  const bestRateCell = page.locator('td[data-col-key="bestRate"]').first()
  await expect(bestRateCell).toBeVisible()
  await expect(bestRateCell.locator('[data-billing-rate="bestRate"]')).toHaveText('$8.12')

  const styles = await bestRateCell.locator('[data-billing-rate="bestRate"]').evaluate((element) => {
    const computed = window.getComputedStyle(element)
    return {
      borderTopWidth: computed.borderTopWidth,
      borderTopStyle: computed.borderTopStyle,
      borderTopColor: computed.borderTopColor,
      outlineStyle: computed.outlineStyle,
      outlineWidth: computed.outlineWidth,
    }
  })

  expect(styles.borderTopWidth).toBe('0px')
  expect(styles.outlineStyle).toBe('none')
  expect(styles.borderTopColor).not.toBe('rgb(42, 91, 215)')
})
