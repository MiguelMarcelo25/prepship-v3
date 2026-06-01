import { test, expect } from 'playwright/test'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const screenshotDir = path.resolve(__dirname, '../../reports/orders-ux')
const baseUrl = 'http://127.0.0.1:5177'
const apiOrigin = 'http://127.0.0.1:3000'
const supabaseProjectRef = 'fdkseckgfuvdczzqmnac'

test.beforeAll(async () => {
  await mkdir(screenshotDir, { recursive: true })
})

const clients = [
  { id: 1, name: 'KF Goods', active: true, isTest: false, storeId: 101 },
  { id: 2, name: 'eBay - DJC', active: true, isTest: false, storeId: 102 },
  { id: 3, name: 'Test Orders', active: true, isTest: true, storeId: 103 },
]

const rates = {
  carrierCode: 'ups',
  serviceCode: 'ups_ground_saver',
  serviceName: 'UPS Ground Saver (1 lb+)',
  carrierNickname: 'ROCEL C81F70',
  providerAccountNickname: 'ROCEL C81F70',
  shippingProviderId: 7381,
  amount: 9.86,
  cost: 9.86,
  shipmentCost: 9.86,
  otherCost: 0,
}

function makeOrder(id, status, clientId = 1) {
  const shipped = status === 'shipped'
  const cancelled = status === 'cancelled'
  const storeIdByClientId = {
    1: 101,
    2: 102,
    3: 103,
  }
  return {
    id,
    orderId: id,
    orderNumber: status === 'awaiting_shipment' ? `114-5414667-${id}` : `${status.toUpperCase()}-${id}`,
    orderStatus: status,
    orderDate: '2026-05-14T02:11:00.000Z',
    externalOrderId: `external-${id}`,
    clientId,
    storeId: storeIdByClientId[clientId] ?? clientId,
    customerEmail: `operator-${id}@example.com`,
    shipToName: id % 2 ? 'Ella and Seth Johnson' : 'Tony McMasters',
    shipToCity: 'El Reno',
    shipToState: 'OK',
    shipToPostalCode: '73036',
    orderTotal: 16.99,
    shippingAmount: 7.3,
    weightOz: 60,
    items: [
      {
        name: id % 2 ? 'KF GOODIES Korean Ramen Snack Box' : '2 Pack Valentina Salsa Picante',
        sku: id % 2 ? 'B0D43C5FGF' : 'VALENTINA-2PK',
        quantity: 1,
        unitPrice: 16.99,
        imageUrl: '',
      },
    ],
    raw: {
      shipTo: {
        name: id % 2 ? 'Ella and Seth Johnson' : 'Tony McMasters',
        street1: '1318 S Reno Ave',
        city: 'El Reno',
        state: 'OK',
        postalCode: '73036',
        country: 'US',
        phone: '405-368-6063',
      },
      dimensions: { length: 11, width: 8, height: 6 },
    },
    overrides: {
      rateWeightOz: 60,
      rateDimsL: 11,
      rateDimsW: 8,
      rateDimsH: 6,
      bestRateJson: rates,
    },
    bestRate: cancelled ? null : rates,
    selectedRate: cancelled ? null : rates,
    label: shipped
      ? {
          trackingNumber: `1Z999AA101${id}`,
          carrierCode: 'ups',
          serviceCode: 'ups_ground_saver',
          shippingProviderId: 7381,
          cost: 9.86,
          labelUrl: 'https://example.com/label.pdf',
        }
      : null,
    shipping: shipped
      ? {
          carrierCode: 'ups',
          serviceCode: 'ups_ground_saver',
          trackingNumber: `1Z999AA101${id}`,
          providerAccountId: 7381,
          accountNickname: 'ROCEL C81F70',
          labelCost: 9.86,
          selectedRate: rates,
          bestRate: rates,
        }
      : null,
  }
}

function makeSkuOrder(id, items, clientId = 1) {
  const order = makeOrder(id, 'awaiting_shipment', clientId)
  return {
    ...order,
    items,
    raw: {
      ...order.raw,
      items,
    },
  }
}

const ordersByStatus = {
  awaiting_shipment: [
    makeSkuOrder(970001, [{ name: 'Booster Gel', sku: 'Booster-gel-001', quantity: 2, unitPrice: 16.99, imageUrl: '' }]),
    makeSkuOrder(970002, [{ name: 'Leeds Line V2', sku: 'HU-10', quantity: 2, unitPrice: 16.99, imageUrl: '' }], 2),
    makeSkuOrder(970003, [
      { name: 'Booster Gel', sku: 'Booster-gel-001', quantity: 1, unitPrice: 16.99, imageUrl: '' },
      { name: 'Leeds Line V2', sku: 'HU-10', quantity: 1, unitPrice: 16.99, imageUrl: '' },
    ]),
    makeSkuOrder(970004, [
      { name: 'Leeds Line V2', sku: 'HU-10', quantity: 1, unitPrice: 16.99, imageUrl: '' },
      { name: 'Booster Gel', sku: 'Booster-gel-001', quantity: 2, unitPrice: 16.99, imageUrl: '' },
    ], 2),
    makeSkuOrder(970005, [
      { name: 'Booster Gel', sku: 'Booster-gel-001', quantity: 1, unitPrice: 16.99, imageUrl: '' },
      { name: 'Booster Gel', sku: 'Booster-gel-001', quantity: 1, unitPrice: 16.99, imageUrl: '' },
    ]),
  ],
  shipped: [makeOrder(864542, 'shipped'), makeOrder(864543, 'shipped', 2)],
  cancelled: [makeOrder(764542, 'cancelled'), makeOrder(764543, 'cancelled', 2)],
}

const countRows = [
  { orderStatus: 'awaiting_shipment', cnt: 5 },
  { orderStatus: 'shipped', cnt: 2 },
  { orderStatus: 'cancelled', cnt: 2 },
]

const countStoreRows = [
  { orderStatus: 'awaiting_shipment', storeId: 101, cnt: 3 },
  { orderStatus: 'awaiting_shipment', storeId: 102, cnt: 2 },
  { orderStatus: 'shipped', storeId: 101, cnt: 1 },
  { orderStatus: 'shipped', storeId: 102, cnt: 1 },
  { orderStatus: 'cancelled', storeId: 101, cnt: 1 },
  { orderStatus: 'cancelled', storeId: 102, cnt: 1 },
]

function json(body) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  }
}

function responseFor(url) {
  if (url.hostname.endsWith('supabase.co')) {
    return json({ user: null })
  }

  const isApiRequest = url.origin === apiOrigin || url.origin !== baseUrl || url.pathname.startsWith('/api/')
  if (!isApiRequest) {
    return null
  }

  if (url.pathname === '/clients') return json(clients)
  if (url.pathname === '/users') return json({ users: [{ id: 'u1', email: 'operator@example.com', isAdmin: true }] })
  if (url.pathname === '/locations') {
    return json([
      {
        id: 1,
        name: 'GWH Fulfillment Center',
        company: 'PrepShip',
        street1: '123 Warehouse Way',
        city: 'Gardena',
        state: 'CA',
        postalCode: '90248',
        country: 'US',
        phone: null,
        isDefault: true,
        active: true,
      },
    ])
  }
  if (url.pathname === '/packages') {
    return json([{ id: 1, name: '11x8x6', length: 11, width: 8, height: 6, unitCost: '0.62', source: 'custom' }])
  }
  if (url.pathname === '/rates/multi') return json({ carriers: [] })
  if (url.pathname === '/api/carrier-accounts') return json({ data: [] })
  if (url.pathname === '/settings/orders.columnPrefs') return json({ value: null })
  if (url.pathname === '/orders/sync/status') return json({ status: 'idle', lastSyncAt: '2026-05-15T00:00:00.000Z' })
  if (url.pathname === '/shipments/status') return json({ status: 'idle' })
  if (url.pathname === '/init/stores') {
    return json({
      data: clients.map((client) => ({
        id: client.storeId,
        storeId: client.storeId,
        name: client.name,
        storeName: client.name,
        clientName: client.name,
        clientId: client.id,
        active: client.active,
        isTest: client.isTest,
      })),
    })
  }
  if (url.pathname === '/init/counts') return json({ byStatus: countRows, byStatusStore: countStoreRows })
  if (url.pathname === '/clients/order-stats') {
    return json({ data: clients.map((client) => ({ clientId: client.id, awaiting_shipment: 1, shipped: 1, cancelled: 1 })) })
  }
  if (url.pathname === '/orders/distinct-skus') return json({ skus: ['Booster-gel-001', 'HU-10'] })
  if (url.pathname === '/orders') {
    const status = url.searchParams.get('status') || 'awaiting_shipment'
    const data = ordersByStatus[status] ?? []
    return json({ data, pagination: { page: 1, pageSize: 50, total: data.length, totalPages: 1 } })
  }
  const orderFull = url.pathname.match(/^\/orders\/(\d+)\/full$/)
  if (orderFull) {
    const id = Number(orderFull[1])
    const order = Object.values(ordersByStatus).flat().find((candidate) => candidate.id === id)
    return json(order ?? makeOrder(id, 'awaiting_shipment'))
  }

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
        user: {
          id: '00000000-0000-4000-8000-000000000001',
          aud: 'authenticated',
          role: 'authenticated',
          email: 'operator@example.com',
        },
      }),
    )
  }, supabaseProjectRef)

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    const mocked = responseFor(url)
    if (mocked) {
      await route.fulfill(mocked)
      return
    }
    await route.continue()
  })
}

test('SKU Sort groups orders by exact SKU and quantity composition', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await setup(page)
  await page.goto(`${baseUrl}/orders/awaiting_shipment`)
  await page.waitForSelector('#ordersTable tbody tr.order-row', { state: 'visible' })

  await page.getByRole('button', { name: /SKU Sort/ }).click()
  await page.waitForSelector('#ordersTable tbody tr.sku-group-header', { state: 'visible' })

  const headers = page.locator('#ordersTable tbody tr.sku-group-header')
  const headerTexts = await headers.allTextContents()
  expect(headerTexts.some((text) =>
    text.includes('Booster-gel-001 x2') &&
    text.includes('Qty 2') &&
    text.includes('2 orders') &&
    !text.includes('HU-10')
  )).toBe(true)
  expect(headerTexts.some((text) =>
    text.includes('HU-10 x2') &&
    text.includes('Qty 2') &&
    text.includes('1 order') &&
    !text.includes('Booster-gel-001')
  )).toBe(true)
  expect(headerTexts.some((text) =>
    text.includes('Booster-gel-001 x1 + HU-10 x1') &&
    text.includes('1 order')
  )).toBe(true)
  expect(headerTexts.some((text) =>
    text.includes('Booster-gel-001 x2 + HU-10 x1') &&
    text.includes('1 order')
  )).toBe(true)

  const boosterGroupText = await page.locator('#ordersBody').evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#ordersBody tr'))
    const headerIndex = rows.findIndex((row) =>
      row.classList.contains('sku-group-header') &&
      Boolean(row.textContent?.includes('Booster-gel-001 x2')) &&
      !row.textContent?.includes('HU-10')
    )
    if (headerIndex < 0) return ''
    const parts = []
    for (const row of rows.slice(headerIndex + 1)) {
      if (row.classList.contains('sku-group-header')) break
      parts.push(row.textContent ?? '')
    }
    return parts.join('\n')
  })

  expect(boosterGroupText).toContain('Booster-gel-001')
  expect(boosterGroupText).not.toContain('HU-10')

  await page.screenshot({ path: path.join(screenshotDir, 'desktop-ps-052-sku-exact-groups.png'), fullPage: true })
})

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 1024, height: 768 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`orders selection UX at ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await setup(page)
    await page.goto(`${baseUrl}/orders/awaiting_shipment`)
    await page.waitForSelector('#ordersTable tbody tr.order-row', { state: 'visible' })

    await page.screenshot({ path: path.join(screenshotDir, `${viewport.name}-01-awaiting-list.png`), fullPage: true })

    await page.locator('#ordersTable tbody tr.order-row').first().click()
    await expect(page.locator('#ordersSelectionToolbar')).toHaveCount(0)
    await page.screenshot({ path: path.join(screenshotDir, `${viewport.name}-02-row-click-detail.png`), fullPage: true })

    await page.locator('#ordersTable tbody tr.order-row input[type="checkbox"]').first().check()
    await expect(page.locator('#ordersSelectionToolbar')).toBeVisible()
    if (viewport.name === 'mobile') {
      const mobileActions = page.locator('.orders-selection-actions-mobile')
      await expect(mobileActions).toBeVisible()
      await expect(page.locator('#ordersSelectionToolbar')).toContainText('Print Label')
      await expect(page.locator('#ordersSelectionToolbar')).toContainText('Print to Queue')
      await expect(page.locator('#ordersSelectionToolbar')).toContainText('Test mode')

      const toolbarBox = await page.locator('#ordersSelectionToolbar').boundingBox()
      const actionsBox = await mobileActions.boundingBox()
      expect(toolbarBox).not.toBeNull()
      expect(actionsBox).not.toBeNull()
      expect(Math.abs((actionsBox.x + actionsBox.width / 2) - (toolbarBox.x + toolbarBox.width / 2))).toBeLessThan(2)
    } else {
      await expect(page.locator('#ordersSelectionToolbar')).not.toContainText('Print Label')
      await expect(page.locator('#ordersSelectionToolbar')).not.toContainText('Print to Queue')
    }
    await page.screenshot({ path: path.join(screenshotDir, `${viewport.name}-03-awaiting-selected.png`), fullPage: true })

    if (viewport.name === 'mobile') {
      await page.locator('#mobileMenuBtn').click()
      const testToggle = page.getByRole('button', { name: /Hide Test Orders|Show Test Orders/ })
      await expect(testToggle).toBeVisible()
      const toggleBox = await testToggle.boundingBox()
      expect(toggleBox).not.toBeNull()
      expect(toggleBox.width).toBeLessThanOrEqual(30)
      expect(toggleBox.height).toBeLessThanOrEqual(16)
    }

    await page.goto(`${baseUrl}/orders/shipped`)
    await page.waitForSelector('#ordersTable tbody tr.order-row', { state: 'visible' })
    await page.locator('#ordersTable tbody tr.order-row input[type="checkbox"]').first().check()
    if (viewport.name === 'mobile') {
      await expect(page.locator('#ordersSelectionToolbar')).toContainText('Queue Existing Labels')
    } else {
      await expect(page.locator('#ordersSelectionToolbar')).not.toContainText('Queue Existing Labels')
    }
    await expect(page.locator('#ordersSelectionToolbar')).not.toContainText('Print Label')
    await page.screenshot({ path: path.join(screenshotDir, `${viewport.name}-04-shipped-selected.png`), fullPage: true })

    await page.goto(`${baseUrl}/orders/cancelled`)
    await page.waitForSelector('#ordersTable tbody tr.order-row', { state: 'visible' })
    await page.locator('#ordersTable tbody tr.order-row input[type="checkbox"]').first().check()
    if (viewport.name === 'mobile') {
      await expect(page.locator('#ordersSelectionToolbar')).toContainText('Shipping actions disabled')
    } else {
      await expect(page.locator('#ordersSelectionToolbar')).not.toContainText('Shipping actions disabled')
    }
    await expect(page.locator('#ordersSelectionToolbar')).not.toContainText('Print Label')
    await page.screenshot({ path: path.join(screenshotDir, `${viewport.name}-05-cancelled-selected.png`), fullPage: true })
  })
}
