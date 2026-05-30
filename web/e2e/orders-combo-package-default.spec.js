import { test, expect } from 'playwright/test'

// PS-037 — Hugrab-style SKU+qty combination package auto-selection.
//
// Route-mocked (no DB), mirroring orders-ux.spec.js. Proves the side panel
// auto-selects the package the backend resolved as the client's combo default
// (returned on /orders/:id/full as `comboPackageDefault`), and that distinct
// SKU+qty combinations select distinct packages. Server-side combo-key
// normalization (casing/whitespace/sort/dup-summing/qty) is covered by
// scripts/package-combo-key-guard.ts; this spec proves the UI consumes the
// resolved default and that reversed line-order still auto-selects (the API
// returns the same default because the key is order-independent).

const baseUrl = 'http://127.0.0.1:5177'
const apiOrigin = 'http://127.0.0.1:3000'
const supabaseProjectRef = 'fdkseckgfuvdczzqmnac'

const clients = [{ id: 4, name: 'HUGRAB', active: true, isTest: false, storeId: 378060 }]

// Two distinct packages: the combo box (id 2) and a different box (id 3).
const packages = [
  { id: 2, name: 'Combo-A 12x10x3', length: 12, width: 10, height: 3, unitCost: '0.62', source: 'custom' },
  { id: 3, name: 'Combo-B 14x12x4', length: 14, width: 12, height: 4, unitCost: '0.80', source: 'custom' },
]

function boosterLeeds(boosterQty, leedsQty, reversed = false) {
  const lines = [
    { name: 'Booster Gel', sku: 'Booster-gel-001', quantity: boosterQty, unitPrice: 21.9, imageUrl: '' },
    { name: 'Leeds Line V2', sku: 'HU-10', quantity: leedsQty, unitPrice: 109.9, imageUrl: '' },
  ]
  return reversed ? lines.reverse() : lines
}

// id -> { items, comboPackageDefaultPackageId } — what the backend would resolve.
const orderDefs = {
  // Booster x1 + Leeds x1 -> combo box 2
  9101: { items: boosterLeeds(1, 1), combo: 2 },
  // Reversed line order, same combo -> still box 2 (backend key is order-independent)
  9102: { items: boosterLeeds(1, 1, true), combo: 2 },
  // Booster x2 + Leeds x1 -> a DIFFERENT box (3), proving qty-sensitivity
  9103: { items: boosterLeeds(2, 1), combo: 3 },
  // Single-SKU order with NO combo default -> must NOT auto-pick the combo box
  9104: { items: [{ name: 'Booster Gel', sku: 'Booster-gel-001', quantity: 1, unitPrice: 21.9, imageUrl: '' }], combo: null },
}

function makeOrder(id) {
  const def = orderDefs[id]
  return {
    id,
    orderId: id,
    orderNumber: `HUG-${id}`,
    orderStatus: 'awaiting_shipment',
    orderDate: '2026-05-27T02:11:00.000Z',
    externalOrderId: `ss-${id}`,
    clientId: 4,
    storeId: 378060,
    customerEmail: `op-${id}@example.com`,
    shipToName: 'Esther Lee',
    shipToCity: 'Bayside',
    shipToState: 'NY',
    shipToPostalCode: '11361',
    orderTotal: 153.7,
    shippingAmount: 0,
    weightOz: 31,
    items: def.items,
    raw: { shipTo: { name: 'Esther Lee', city: 'Bayside', state: 'NY', postalCode: '11361', country: 'US' } },
  }
}

const awaitingOrders = Object.keys(orderDefs).map((id) => makeOrder(Number(id)))

function json(body) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) }
}

function responseFor(url) {
  if (url.hostname.endsWith('supabase.co')) return json({ user: null })
  const isApi = url.origin === apiOrigin || url.origin !== baseUrl || url.pathname.startsWith('/api/')
  if (!isApi) return null

  if (url.pathname === '/clients') return json(clients)
  if (url.pathname === '/users') return json({ users: [{ id: 'u1', email: 'operator@example.com', isAdmin: true }] })
  if (url.pathname === '/locations') {
    return json([{ id: 1, name: 'GWH Fulfillment Center', company: 'PrepShip', street1: '123 Warehouse Way', city: 'Gardena', state: 'CA', postalCode: '90248', country: 'US', isDefault: true, active: true }])
  }
  if (url.pathname === '/packages') return json(packages)
  if (url.pathname === '/rates/multi') return json({ carriers: [] })
  if (url.pathname === '/api/carrier-accounts') return json({ data: [] })
  if (url.pathname === '/settings/orders.columnPrefs') return json({ value: null })
  if (url.pathname === '/orders/sync/status') return json({ status: 'idle', lastSyncAt: '2026-05-27T00:00:00.000Z' })
  if (url.pathname === '/shipments/status') return json({ status: 'idle' })
  if (url.pathname === '/init/stores') {
    return json({ data: clients.map((c) => ({ id: c.storeId, storeId: c.storeId, name: c.name, storeName: c.name, clientName: c.name, clientId: c.id, active: c.active, isTest: c.isTest })) })
  }
  if (url.pathname === '/init/counts') return json({ byStatus: { awaiting_shipment: awaitingOrders.length }, byStatusStore: [] })
  if (url.pathname === '/clients/order-stats') return json({ data: clients.map((c) => ({ clientId: c.id, awaiting_shipment: awaitingOrders.length, shipped: 0, cancelled: 0 })) })
  if (url.pathname === '/orders/distinct-skus') return json({ skus: ['Booster-gel-001', 'HU-10'] })
  if (url.pathname === '/orders') {
    const status = url.searchParams.get('status') || 'awaiting_shipment'
    const data = status === 'awaiting_shipment' ? awaitingOrders : []
    return json({ data, pagination: { page: 1, pageSize: 50, total: data.length, totalPages: 1 } })
  }
  const full = url.pathname.match(/^\/orders\/(\d+)(?:\/full)?$/)
  if (full) {
    const id = Number(full[1])
    const def = orderDefs[id]
    const order = makeOrder(id)
    // The backend attaches the resolved combo default here.
    const comboPackageDefault = def && def.combo != null
      ? { packageId: def.combo, packageCode: null, length: null, width: null, height: null, weightOz: null, comboKey: 'mock' }
      : null
    return json({ ...order, overrides: null, shipments: [], comboPackageDefault })
  }
  // Single product default lookup (single-SKU path) — return nothing useful so
  // the single-SKU order does NOT get a package from here.
  if (url.pathname.startsWith('/products')) return json(null)
  if (url.pathname === '/orders/distinct-skus') return json({ skus: [] })
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

  await page.route('**/*', async (route) => {
    const mocked = responseFor(new URL(route.request().url()))
    if (mocked) { await route.fulfill(mocked); return }
    await route.continue()
  })
}

function packageSelect(page) {
  return page.locator('.ship-field-row', { hasText: 'Package' }).locator('select.ship-select')
}

async function openOrder(page, orderNumber) {
  await page.goto(`${baseUrl}/orders/awaiting_shipment`)
  await page.waitForSelector('#ordersTable tbody tr.order-row', { state: 'visible' })
  await page.locator('#ordersTable tbody tr.order-row', { hasText: orderNumber }).first().click()
  await expect(packageSelect(page)).toBeVisible()
}

test.describe('PS-037 combo package auto-selection', () => {
  test('Booster x1 + Leeds x1 auto-selects the saved combo package', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await setup(page)
    await openOrder(page, 'HUG-9101')
    await expect(packageSelect(page)).toHaveValue('2')
  })

  test('reversed line order auto-selects the same combo package', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await setup(page)
    await openOrder(page, 'HUG-9102')
    await expect(packageSelect(page)).toHaveValue('2')
  })

  test('different quantity (Booster x2 + Leeds x1) auto-selects a different package', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await setup(page)
    await openOrder(page, 'HUG-9103')
    await expect(packageSelect(page)).toHaveValue('3')
  })

  test('single-SKU order with no combo default does not auto-pick the combo box', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await setup(page)
    await openOrder(page, 'HUG-9104')
    await expect(packageSelect(page)).not.toHaveValue('2')
    await expect(packageSelect(page)).not.toHaveValue('3')
  })
})
