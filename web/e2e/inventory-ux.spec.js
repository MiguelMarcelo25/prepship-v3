import { test, expect } from 'playwright/test'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const screenshotDir = path.resolve(__dirname, '../../reports/inventory-ux')
const baseUrl = process.env.PREPSHIP_E2E_BASE_URL ?? 'http://127.0.0.1:5177'
const apiOrigin = 'http://127.0.0.1:3000'
const supabaseProjectRef = 'fdkseckgfuvdczzqmnac'

test.beforeAll(async () => {
  await mkdir(screenshotDir, { recursive: true })
})

const clients = [
  { id: 1, clientId: 1, name: 'Tran Agency', active: true, isTest: false, storeId: 101 },
  { id: 2, clientId: 2, name: 'Walmart - DJC', active: true, isTest: false, storeId: 102 },
  { id: 3, clientId: 3, name: 'Heritage Kids Press', active: true, isTest: false, storeId: 103 },
]

const packages = [
  { id: 1, packageId: 1, name: '14x10x8', length: 14, width: 10, height: 8, unitCost: 0.64, source: 'custom' },
  { id: 2, packageId: 2, name: '11x8x6', length: 11, width: 8, height: 6, unitCost: 0.31, source: 'custom' },
]

const inventoryRows = [
  {
    id: 1,
    sku: 'B07PKGDPBJ',
    name: '[Samyang] Carbo Spicy Chicken Fried Cup Noodles 80g x 6EA',
    clientId: 1,
    stockQty: 0,
    reorderLevel: 12,
    weightOz: 19,
    length: 14,
    width: 10,
    height: 8,
    unitsPerPack: 1,
    soldLast30Days: 69,
    totalReceived: 30,
    totalSoldAllTime: 69,
    active: true,
    packageId: 1,
    packageName: '14x10x8',
    imageUrl: '',
  },
  {
    id: 2,
    sku: 'B000OBYO3K',
    name: 'Bacchus-d Energy Drink 10 X 100ml',
    clientId: 1,
    stockQty: -3,
    reorderLevel: 8,
    weightOz: 87,
    length: 11,
    width: 8,
    height: 5,
    unitsPerPack: 1,
    soldLast30Days: 72,
    totalReceived: 45,
    totalSoldAllTime: 72,
    active: true,
    packageId: 2,
    packageName: '11x8x6',
    imageUrl: '',
  },
  {
    id: 3,
    sku: 'tagalog-series',
    name: 'My First Tagalog Words Series',
    clientId: 3,
    stockQty: -20,
    reorderLevel: 20,
    weightOz: 42,
    length: 8.5,
    width: 8,
    height: 2.5,
    unitsPerPack: 1,
    soldLast30Days: 83,
    totalReceived: 100,
    totalSoldAllTime: 83,
    active: true,
    packageId: 1,
    packageName: '8.5x8x2.5',
    imageUrl: '',
  },
  {
    id: 4,
    sku: 'INACTIVE-SKU',
    name: 'Paused SKU example',
    clientId: 2,
    stockQty: 18,
    reorderLevel: 2,
    weightOz: 12,
    length: 9,
    width: 6,
    height: 3,
    unitsPerPack: 1,
    soldLast30Days: 0,
    totalReceived: 18,
    totalSoldAllTime: 0,
    active: false,
    packageId: 2,
    packageName: '9x6x3',
    imageUrl: '',
  },
]

const parentSkus = [
  { parentSkuId: 10, id: 10, clientId: 1, name: 'Korean Snack Parent', sku: 'KOREAN-SNACK-PARENT', baseUnitQty: 6 },
]

const ledgerRows = [
  {
    id: 100,
    createdAt: '2026-05-14T08:30:00.000Z',
    sku: 'B07PKGDPBJ',
    type: 'receive',
    qty: 30,
    note: 'PO 5514',
    createdBy: 'operator@example.com',
  },
  {
    id: 101,
    createdAt: '2026-05-14T09:10:00.000Z',
    sku: 'B000OBYO3K',
    type: 'ship',
    qty: -2,
    note: 'Order shipped',
    createdBy: 'system',
  },
]

function json(body) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  }
}

function inventoryResponse(url) {
  const lowStock = url.searchParams.get('lowStock') === 'true'
  const clientId = Number(url.searchParams.get('clientId') || 0)
  let rows = lowStock
    ? inventoryRows.filter((row) => row.stockQty <= row.reorderLevel)
    : inventoryRows
  if (clientId) rows = rows.filter((row) => row.clientId === clientId)
  return json({
    data: rows,
    pagination: {
      page: Number(url.searchParams.get('page') || 1),
      pageSize: Number(url.searchParams.get('pageSize') || 200),
      total: rows.length,
      totalPages: 1,
    },
  })
}

function responseFor(url) {
  if (url.hostname.endsWith('supabase.co')) return json({ user: null })

  const isApiRequest = url.origin === apiOrigin || url.origin !== baseUrl || url.pathname.startsWith('/api/')
  if (!isApiRequest) return null

  if (url.pathname === '/clients') return json(clients)
  if (url.pathname === '/clients/order-stats') {
    return json({ data: clients.map((client) => ({ clientId: client.id, awaiting_shipment: 1, shipped: 2, cancelled: 0 })) })
  }
  if (url.pathname === '/users') return json({ users: [{ id: 'u1', email: 'operator@example.com', isAdmin: true }] })
  if (url.pathname === '/packages') return json({ data: packages })
  if (url.pathname === '/locations') return json([])
  if (url.pathname === '/settings/orders.columnPrefs') return json({ value: null })
  if (url.pathname === '/orders/sync/status') return json({ status: 'idle', lastSyncAt: '2026-05-15T00:00:00.000Z' })
  if (url.pathname === '/shipments/status') return json({ status: 'idle' })
  if (url.pathname === '/init/stores') return json({ data: clients.map((client) => ({ id: client.storeId, name: client.name, clientId: client.id })) })
  if (url.pathname === '/init/counts') return json({ awaiting_shipment: 2, shipped: 1717, cancelled: 15 })
  if (url.pathname === '/orders') return json({ data: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 1 } })
  if (url.pathname === '/inventory/ledger') return json({ data: ledgerRows })
  if (url.pathname === '/parent-skus') return json({ data: parentSkus })

  const skuOrders = url.pathname.match(/^\/inventory\/(\d+)\/sku-orders$/)
  if (skuOrders) {
    const row = inventoryRows.find((item) => item.id === Number(skuOrders[1])) ?? inventoryRows[0]
    return json({
      sku: row.sku,
      name: row.name,
      clientId: row.clientId,
      totalUnits: row.soldLast30Days,
      dailySales: [
        { day: '2026-05-12', units: 2 },
        { day: '2026-05-13', units: 4 },
        { day: '2026-05-14', units: 1 },
      ],
      orders: [
        {
          order_id: 5514,
          order_number: '114-5514',
          order_date: '2026-05-14T06:10:00.000Z',
          order_status: 'shipped',
          ship_to_name: 'Warehouse Operator',
          carrier_code: 'ups',
          service_code: 'ups_ground_saver',
          qty: 2,
          item_name: row.name,
        },
      ],
    })
  }

  if (url.pathname === '/inventory') return inventoryResponse(url)

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
    window.localStorage.setItem('inventory_active_only', 'true')
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

async function expectPanelGutter(page, selector) {
  const padding = await page.locator(selector).evaluate((element) => {
    const style = window.getComputedStyle(element)
    return {
      left: Number.parseFloat(style.paddingLeft),
      right: Number.parseFloat(style.paddingRight),
    }
  })
  expect(padding.left).toBeGreaterThanOrEqual(16)
  expect(padding.right).toBeGreaterThanOrEqual(16)
}

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 1024, height: 768 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`inventory UX layout at ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await setup(page)
    await page.goto(`${baseUrl}/inventory`)

    await expect(page.locator('#view-inventory')).toBeVisible()
    await expect(page.locator('.inventory-section-header')).toBeVisible()
    await expect(page.locator('.inventory-section-header-actions')).toBeVisible()
    await expect(page.locator('.inventory-section-header-actions').getByRole('button', { name: /Import SKUs from Orders/ })).toBeVisible()
    const alertShortcut = page.locator('.inventory-alert-shortcut')
    if (await alertShortcut.count()) {
      await expect(alertShortcut).toContainText('Low/Out')
      await expect(alertShortcut).toBeVisible()
    } else {
      await expect(page.locator('#inventory-tab-alerts')).toBeVisible()
    }
    await expect(page.locator('.inventory-section-header-actions').getByRole('button', { name: /Refresh/ })).toBeVisible()
    await expect(page.locator('.inventory-stock-toolbar')).toBeVisible()
    await expectPanelGutter(page, '#inv-panel-stock')
    await expect(page.getByText('B07PKGDPBJ')).toBeVisible()
    await page.screenshot({ path: path.join(screenshotDir, `${viewport.name}-01-stock-layout.png`), fullPage: true })

    await page.locator('.ps-data-table-scroll tbody tr').first().click()
    await expect(page.locator('.inventory-drawer-panel')).toBeVisible()
    await expect(page.locator('.inventory-drawer-panel')).toContainText('Recent Orders')
    const overlayBox = await page.locator('.inventory-drawer-overlay').boundingBox()
    expect(overlayBox).toBeTruthy()
    if (viewport.width > 768) {
      const sidebarBox = await page.locator('aside[aria-label="Primary navigation"], .sidebar').first().boundingBox()
      expect(sidebarBox).toBeTruthy()
      expect(overlayBox.x).toBeGreaterThanOrEqual(sidebarBox.x + sidebarBox.width - 1)
    } else {
      expect(overlayBox.x).toBeLessThanOrEqual(1)
    }
    await page.screenshot({ path: path.join(screenshotDir, `${viewport.name}-02-sku-drawer.png`), fullPage: true })
    await page.locator('.inventory-drawer-panel button').first().click()

    await page.locator('#inventory-tab-receive').click()
    await expect(page.getByText('Receive Inventory')).toBeVisible()
    await expectPanelGutter(page, '#inv-panel-receive')
    await expect(page.locator('.inventory-section-header-actions').getByRole('button', { name: /Import SKUs from Orders/ })).toHaveCount(0)
    await page.locator('#inv-panel-receive select').first().selectOption('1')
    const receiveSkuInput = page.getByRole('combobox', { name: 'SKU or product name' }).first()
    await receiveSkuInput.click()
    const receiveListbox = page.getByRole('listbox')
    await expect(receiveListbox).toBeVisible()
    await expect(receiveListbox.getByRole('option')).toHaveCount(2)
    const receiveListboxState = await receiveListbox.evaluate((element) => ({
      parentTag: element.parentElement?.tagName,
      position: window.getComputedStyle(element).position,
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
    }))
    const receiveInputWidth = await receiveSkuInput.evaluate((element) => element.getBoundingClientRect().width)
    expect(receiveListboxState).toEqual(expect.objectContaining({
      parentTag: 'BODY',
      position: 'fixed',
    }))
    expect(Math.abs(receiveListboxState.width - receiveInputWidth)).toBeLessThanOrEqual(2)
    expect(receiveListboxState.height).toBeGreaterThan(70)
    await expect(page.locator('#inv-panel-receive').getByText('Product name', { exact: true })).toHaveCount(0)
    await receiveListbox.getByRole('option').first().click()
    await expect(page.locator('#inv-recv-rows').getByText('Bacchus-d Energy Drink 10 X 100ml')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.screenshot({ path: path.join(screenshotDir, `${viewport.name}-03-receive-layout.png`), fullPage: true })

    await page.locator('#inventory-tab-alerts').click()
    await expect(page.locator('#inv-panel-alerts')).toBeVisible()
    await expectPanelGutter(page, '#inv-panel-alerts')
    await expect(page.locator('#inv-panel-alerts')).toContainText('out of stock')
    await page.screenshot({ path: path.join(screenshotDir, `${viewport.name}-04-alerts-layout.png`), fullPage: true })

    await page.locator('#inventory-tab-parents').click()
    await expect(page.locator('#inv-panel-parents')).toBeVisible()
    await expectPanelGutter(page, '#inv-panel-parents')
    await expect(page.locator('#inv-panel-parents')).toContainText('Create Parent SKU')
    await page.screenshot({ path: path.join(screenshotDir, `${viewport.name}-05-parents-layout.png`), fullPage: true })

    await page.locator('#inventory-tab-history').click()
    await expect(page.locator('#inv-panel-history')).toBeVisible()
    await expectPanelGutter(page, '#inv-panel-history')
    await expect(page.locator('#inv-panel-history')).toContainText('Recent Movements')
    await page.screenshot({ path: path.join(screenshotDir, `${viewport.name}-06-history-layout.png`), fullPage: true })
  })
}

test('inventory stock table fits desktop viewport and shows active page number', async ({ page }) => {
  await page.setViewportSize({ width: 1365, height: 768 })
  await setup(page)
  await page.addInitScript(() => {
    window.localStorage.setItem('inventory_page_size', '20')
  })

  const manyRows = Array.from({ length: 75 }, (_, index) => {
    const source = inventoryRows[index % 3]
    return {
      ...source,
      id: 1000 + index,
      sku: `SKU-${String(index + 1).padStart(3, '0')}`,
      name: `${source.name} ${index + 1}`,
      stockQty: index % 4 === 0 ? -3 : index,
      soldLast30Days: index % 11,
    }
  })

  await page.route((url) => url.pathname === '/inventory' && url.search.length > 0, async (route) => {
    const url = new URL(route.request().url())
    const pageNumber = Number(url.searchParams.get('page') || 1)
    const pageSize = Number(url.searchParams.get('pageSize') || 50)
    const start = (pageNumber - 1) * pageSize
    await route.fulfill(json({
      data: manyRows.slice(start, start + pageSize),
      pagination: {
        page: pageNumber,
        pageSize,
        total: manyRows.length,
        totalPages: Math.ceil(manyRows.length / pageSize),
      },
    }))
  })

  await page.goto(`${baseUrl}/inventory/stock-levels`)

  const tableScroll = page.locator('.inventory-stock-table-shell > .ps-data-table-scroll')
  await expect(tableScroll).toBeVisible()
  const overflow = await tableScroll.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflowY: window.getComputedStyle(element).overflowY,
  }))
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 2)
  expect(overflow.scrollHeight).toBeGreaterThan(overflow.clientHeight + 2)
  expect(overflow.overflowY).toBe('auto')
  await expect(page.locator('.inventory-stock-table-shell tbody > tr')).toHaveCount(20)

  const actionsCellOverflow = await page.locator('td[data-col-key="actions"]').first().evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }))
  expect(actionsCellOverflow.scrollWidth).toBeLessThanOrEqual(actionsCellOverflow.clientWidth + 2)

  const pagination = page.locator('.inventory-stock-table-shell > .data-table-pagination-bar')
  await expect(pagination).toBeVisible()
  const view = page.locator('#view-inventory')
  const viewMetrics = await view.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }))
  expect(viewMetrics.scrollHeight).toBeGreaterThan(viewMetrics.clientHeight)
  await view.evaluate((element) => {
    element.scrollTop = Math.round(element.scrollHeight / 3)
  })
  await page.waitForTimeout(50)
  const viewBox = await view.boundingBox()
  expect(viewBox).not.toBeNull()
  const paginationBox = await pagination.boundingBox()
  expect(paginationBox).not.toBeNull()
  expect(Math.abs((paginationBox.y + paginationBox.height) - (viewBox.y + viewBox.height))).toBeLessThanOrEqual(48)
  const pageOne = pagination.getByRole('button', { name: '1' })
  await expect(pageOne).toBeVisible()
  await expect(pageOne).toHaveText('1')
  await expect(pageOne).toHaveCSS('color', 'rgb(255, 255, 255)')
})
