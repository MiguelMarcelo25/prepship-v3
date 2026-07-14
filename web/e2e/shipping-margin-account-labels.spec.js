import { test, expect } from 'playwright/test'

const baseUrl = process.env.PREPSHIP_E2E_BASE_URL ?? 'http://127.0.0.1:5177'
const apiOrigin = 'http://127.0.0.1:3000'
const supabaseProjectRef = 'fdkseckgfuvdczzqmnac'
const COMPUTED_AT = '2026-06-20T12:00:00.000Z'
const META = { computedAt: COMPUTED_AT, source: 'live', window: { from: '2026-05-21', to: '2026-06-20', tz: 'America/Los_Angeles' } }

const clients = [
  { id: 1, clientId: 1, name: 'Mock Margin Client', active: true, isTest: false, storeId: 101 },
]

const marginAnalytics = {
  canViewFinancials: true,
  dateFrom: '2026-05-21',
  dateTo: '2026-06-20',
  summary: {
    rowCount: 3,
    marginRowCount: 3,
    frozenCount: 3,
    projectedCount: 0,
    missingBillableCount: 0,
    missingActualCostCount: 0,
    missingAnyProofCount: 0,
    actualShippingTotal: 25.5,
    billableShippingTotal: 36,
    marginTotal: 10.5,
    marginPct: 41.18,
  },
  clients: [],
  carriers: [
    {
      carrierCode: 'ups',
      serviceCode: 'ups_ground',
      providerAccountId: 607857,
      providerAccountNickname: null,
      accountDisplayName: 'ROCEL C81F70',
      accountDisplaySource: 'carrier_resolver',
      actualShippingTotal: 8.5,
      billableShippingTotal: 12,
      marginTotal: 3.5,
      marginPct: 41.18,
      marginRowCount: 1,
      negativeMarginCount: 0,
    },
    {
      carrierCode: 'shipp',
      serviceCode: 'shipp_ups_ground',
      providerAccountId: 10000025,
      providerAccountNickname: null,
      accountDisplayName: 'Shipp',
      accountDisplaySource: 'shipp_policy',
      actualShippingTotal: 9.5,
      billableShippingTotal: 14,
      marginTotal: 4.5,
      marginPct: 47.37,
      marginRowCount: 1,
      negativeMarginCount: 0,
    },
    {
      carrierCode: 'ups',
      serviceCode: 'ups_ground',
      providerAccountId: 607855,
      providerAccountNickname: null,
      accountDisplayName: 'Unresolved account',
      accountDisplaySource: 'unknown',
      actualShippingTotal: 7.5,
      billableShippingTotal: 10,
      marginTotal: 2.5,
      marginPct: 33.33,
      marginRowCount: 1,
      negativeMarginCount: 0,
    },
  ],
  rows: [
    {
      shipmentId: 332001,
      orderId: 1900,
      orderNumber: 'PS-332-ORDER',
      shipDate: '2026-06-20T12:00:00.000Z',
      carrierCode: 'ups',
      serviceCode: 'ups_ground',
      providerAccountId: 607857,
      providerAccountNickname: null,
      accountDisplayName: 'ROCEL C81F70',
      accountDisplaySource: 'carrier_resolver',
      actualShippingCost: 8.5,
      billableShippingAmount: 12,
      marginAmount: 3.5,
      marginPct: 41.18,
      state: 'complete',
      missingProofReasons: [],
    },
  ],
}

function json(body, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) }
}

function apiPath(url) {
  return url.pathname.replace(/^\/api/, '') || '/'
}

async function seedAuth(page) {
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
        user: { id: '00000000-0000-4000-8000-000000000332', aud: 'authenticated', role: 'authenticated', email: 'margin@example.test' },
      }),
    )
  }, supabaseProjectRef)
}

async function setupMockBackend(page) {
  const captured = []
  await seedAuth(page)
  await page.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    captured.push({ method: request.method(), host: url.host, pathname: url.pathname })

    if (url.hostname.endsWith('supabase.co')) {
      await route.fulfill(json({ user: { id: 'u1', email: 'margin@example.test' } }))
      return
    }

    const isApiRequest = url.origin === apiOrigin || url.pathname.startsWith('/api/') || url.origin !== baseUrl
    if (!isApiRequest) {
      await route.continue()
      return
    }

    const path = apiPath(url)
    if (path === '/clients') return route.fulfill(json(clients))
    if (path === '/users') return route.fulfill(json({ users: [] }))
    if (path === '/locations') return route.fulfill(json([]))
    if (path === '/packages') return route.fulfill(json({ data: [] }))
    if (path === '/markups') return route.fulfill(json([]))
    if (path === '/settings/orders.columnPrefs') return route.fulfill(json({ value: null }))
    if (path === '/init/stores') {
      return route.fulfill(json({ data: clients.map((client) => ({ id: client.storeId, name: client.name, clientId: client.id })) }))
    }
    if (path === '/init/counts') return route.fulfill(json({ awaiting_shipment: 0, shipped: 3, cancelled: 0 }))
    if (path === '/orders/sync/status' || path === '/shipments/status' || path === '/sync/status') {
      return route.fulfill(json({ status: 'idle', lastSync: '2026-06-20T11:55:00.000Z', cadenceMinutes: 3, worker: { status: { mode: 'idle' } }, queue: { started: false, queues: [] } }))
    }

    if (path === '/dashboard/summary') {
      return route.fulfill(json({ revenue: 120, units: 3, bySku: [], dailyRevenue: [], meta: META }))
    }
    if (path === '/dashboard/daily-counts') return route.fulfill(json({ data: [], meta: META }))
    if (path === '/dashboard/inventory-risk') {
      return route.fulfill(json({ items: [], total: 0, snapshot: { inStock: 0, lowStock: 0, outOfStock: 0, totalSkus: 0, computedAt: COMPUTED_AT } }))
    }
    if (path === '/dashboard/sku-trends') return route.fulfill(json({ topSkus: [], days: [], unitsBySku: [], meta: META }))
    if (path === '/dashboard/top-skus') {
      return route.fulfill(json({
        data: [{
          sku: 'PS-332-SKU', name: 'Margin Fixture SKU', image_url: null, inv_sku_id: 332,
          client_id: 1, client_name: 'Mock Margin Client',
          orders: 3, pending: 0, ext_shipped: 0,
          std_orders: 3, std_ship_count: 3, std_total: '25.50', std_qty_total: 3,
          exp_orders: 0, exp_ship_count: 0, exp_total: '0.00', exp_qty_total: 0,
          ship_count_with_cost: 3, total_qty: 3,
          total_shipping: '25.50', total_revenue: '120.00', total_selling_fee: '12.00',
          selling_fee_complete: true,
          financialsState: 'complete',
          standardAvgShipping: 8.5, expeditedAvgShipping: null, blendedAvgShipping: 8.5,
          totalShipping: 25.5, totalRevenue: 120, avgSellingPrice: 40,
          totalSellingFee: 12, profit: 82.5,
          daily_qty: [3],
        }],
        dateBuckets: ['2026-06-20'],
        totalSkus: 1,
        totalOrders: 3,
        totals: {
          skuCount: 1, totalOrders: 3, totalPending: 0, totalExternal: 0, totalQty: 3,
          totalStdCount: 3, totalExpCount: 0, totalStdQty: 3, totalExpQty: 0,
          totalStdShipping: 25.5, totalExpShipping: 0,
          standardAvgShipping: 8.5, expeditedAvgShipping: null,
          totalShipping: 25.5, totalRevenue: 120, avgSellingPrice: 40,
          totalSellingFee: 12, totalProfit: 82.5, financialsState: 'complete',
        },
        window: { dateFrom: '2026-05-21T00:00:00.000Z', dateToInclusive: '2026-06-20T23:59:59.999Z' },
        meta: META,
      }))
    }
    if (path === '/dashboard/top-combos') return route.fulfill(json({ combos: [], totalCombos: 0, multiSkuOrders: 0, meta: META }))
    if (path === '/dashboard/daily-revenue-by-client') return route.fulfill(json({ data: [], meta: META }))
    if (path === '/dashboard/shipping-margin' || path === '/billing/shipping-margin') return route.fulfill(json(marginAnalytics))

    if (path === '/billing/config') return route.fulfill(json([]))
    if (path === '/billing/package-prices') return route.fulfill(json({ data: [] }))
    if (path === '/billing/fetch-ref-rates/status') return route.fulfill(json({ status: 'idle' }))
    if (path === '/billing/summary') {
      return route.fulfill(json({
        clients: [{ clientId: 1, count: 3, total: 36, byType: { pick_pack: 12, additional: 0, package_cost: 0, storage: 0, shipping: 24 } }],
        grandTotal: 36,
      }))
    }
    if (path === '/billing/details') return route.fulfill(json({ data: [] }))

    await route.fulfill(json({}))
  })
  return captured
}

function shippingMarginTable(page) {
  return page.locator('table').filter({ hasText: 'ROCEL C81F70' })
}

async function assertAccountLabels(page) {
  const table = shippingMarginTable(page)
  await expect(table).toHaveCount(1)
  await expect(table).toBeVisible()
  await expect(table.getByText('ROCEL C81F70')).toBeVisible()
  await expect(table.getByText('Shipp', { exact: true })).toBeVisible()
  await expect(table.getByText('Unresolved account')).toBeVisible()
  await expect(table).not.toContainText('607857')
  await expect(table).not.toContainText('10000025')
  await expect(table).not.toContainText('607855')
}

test.describe('PS-332 shipping-margin account display labels', () => {
  test('Dashboard renders backend accountDisplayName labels from fake shipping-margin payload', async ({ page }) => {
    await page.setViewportSize({ width: 1680, height: 950 })
    await setupMockBackend(page)
    await page.goto(`${baseUrl}/dashboard`)

    await expect(page.getByLabel('Dashboard shipping margin')).toBeVisible()
    await expect(page.locator('table tbody tr').filter({ hasText: 'PS-332-SKU' })).toBeVisible()
    await assertAccountLabels(page)
  })

  test('Billing renders the same backend accountDisplayName labels and drilldown account text', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await setupMockBackend(page)
    await page.goto(`${baseUrl}/billing`)

    await assertAccountLabels(page)
    await page.getByRole('button', { name: /Per-order reconciliation/ }).click()
    const drilldownRow = page.locator('tr').filter({ hasText: 'PS-332-ORDER' })
    await expect(drilldownRow).toBeVisible()
    await expect(drilldownRow).toContainText('ROCEL C81F70')
    await expect(page.locator('body')).not.toContainText('607857')
  })
})
