import { test, expect } from 'playwright/test'
import { ORDERS_DAILY_STATS_WIRE } from './orders-daily-stats-wire.js'

// PS-465 browser proof. Every request is intercepted. The suite cannot contact
// a carrier, buy postage, create/print a label, notify a marketplace, or mutate
// production data.
const baseUrl = 'http://127.0.0.1:5177'
const apiOrigin = 'http://127.0.0.1:3000'
const supabaseProjectRef = 'fdkseckgfuvdczzqmnac'

const client = { id: 465, name: 'PS-465 Fixture Client', active: true, isTest: true, storeId: 1465 }

function makeOrder(id, status) {
  const shipped = status === 'shipped'
  return {
    id,
    orderId: id,
    orderNumber: `PS465-${status.toUpperCase()}-${id}`,
    orderStatus: status,
    orderDate: '2026-07-25T00:00:00.000Z',
    externalOrderId: `ps465-fixture-${id}`,
    clientId: client.id,
    clientName: client.name,
    storeId: client.storeId,
    isTest: true,
    customerEmail: 'ps465-fixture@example.test',
    shipToName: 'PS-465 Fixture Recipient',
    shipToCity: 'Gardena',
    shipToState: 'CA',
    shipToPostalCode: '90248',
    orderTotal: 20,
    shippingAmount: 8,
    weightOz: 32,
    items: [{ name: 'Dry ice fixture', sku: 'PS465-DRY-ICE', quantity: 1, unitPrice: 20, imageUrl: '' }],
    raw: {
      shipTo: { name: 'PS-465 Fixture Recipient', street1: '123 Fixture Way', city: 'Gardena', state: 'CA', postalCode: '90248', country: 'US' },
      dimensions: { length: 10, width: 8, height: 4 },
      advanced_options: { dry_ice: true, dry_ice_weight: { value: 1, unit: 'pound' } },
    },
    overrides: { rateWeightOz: 32, rateDimsL: 10, rateDimsW: 8, rateDimsH: 4 },
    bestRate: null,
    selectedRate: null,
    label: shipped ? { trackingNumber: '1ZPS465FIXTURE', carrierCode: 'ups', serviceCode: 'ups_ground', labelUrl: 'https://example.test/fixture.pdf' } : null,
    shipping: shipped ? { carrierCode: 'ups', serviceCode: 'ups_ground', trackingNumber: '1ZPS465FIXTURE' } : null,
  }
}

const awaitingOrder = makeOrder(465001, 'awaiting_shipment')
const shippedOrder = makeOrder(465002, 'shipped')
const activeDeclaration = {
  schemaVersion: 1,
  status: 'active',
  limitedQuantity: false,
  containsBattery: false,
  dryIce: true,
  dryIceWeightValue: 1,
  dryIceWeightUnit: 'pound',
  emergencyContactName: null,
  emergencyContactPhone: null,
  uspsCategory: null,
  uspsPackageLevel: null,
  regulatedContentType: 'dry_ice',
  materials: [],
}

function capabilities(writeEnabled) {
  return {
    featureEnabled: true,
    writeEnabled,
    clientAllowed: true,
    profiles: {
      shipstation_ups_dry_ice: {
        profile: 'shipstation_ups_dry_ice',
        label: 'ShipStation UPS dry ice',
        visible: true,
        ratingSupported: true,
        purchaseSupported: true,
        unavailableReason: null,
        warnings: ['Use only for a certified connected UPS account.'],
      },
      shipstation_usps: {
        profile: 'shipstation_usps',
        label: 'USPS dangerous goods',
        visible: true,
        ratingSupported: false,
        purchaseSupported: false,
        unavailableReason: 'No certified Stamps.com carrier is connected.',
        warnings: [],
      },
    },
  }
}

function editableState(writeEnabled = true) {
  return {
    orderId: awaitingOrder.id,
    declaration: { schemaVersion: 1, status: 'clear', materials: [] },
    revision: 1,
    semanticHash: 'hz_fixture_clear',
    capabilities: capabilities(writeEnabled),
    validation: { valid: true, issues: [] },
    requiresRerate: false,
    frozenPurchaseFacts: null,
  }
}

function shippedState() {
  return {
    orderId: shippedOrder.id,
    declaration: { schemaVersion: 1, status: 'clear', materials: [] },
    revision: 7,
    semanticHash: 'hz_fixture_current',
    capabilities: capabilities(false),
    validation: { valid: true, issues: [] },
    requiresRerate: false,
    frozenPurchaseFacts: {
      schemaVersion: 1,
      revision: 3,
      declarationHash: 'hz_fixture_frozen',
      snapshotHash: 'hz_snapshot_fixture',
      profile: 'shipstation_ups_dry_ice',
      declaration: activeDeclaration,
    },
  }
}

const queueEntries = [
  {
    queue_entry_id: 'ps465-hazmat-entry', order_id: String(shippedOrder.id), order_number: shippedOrder.orderNumber,
    client_id: client.id, label_url: 'https://example.test/hazmat.pdf', sku_group_id: 'PS465-HAZMAT',
    primary_sku: 'PS465-HAZMAT', item_description: 'Hazmat fixture', order_qty: 1, multi_sku_data: null,
    status: 'queued', print_count: 0, last_printed_at: null, auto_retired_at: null,
    queued_at: '2026-07-25T00:00:00.000Z', shipping_hold: false, held_reason: null,
    hazmat_profile: 'shipstation_ups_dry_ice', hazmat_snapshot_hash: 'hz_snapshot_fixture', hazmat_declaration_revision: 3,
  },
  {
    queue_entry_id: 'ps465-legacy-entry', order_id: '465003', order_number: 'PS465-LEGACY-465003',
    client_id: client.id, label_url: 'https://example.test/legacy.pdf', sku_group_id: 'PS465-LEGACY',
    primary_sku: 'PS465-LEGACY', item_description: 'Legacy fixture', order_qty: 1, multi_sku_data: null,
    status: 'queued', print_count: 0, last_printed_at: null, auto_retired_at: null,
    queued_at: '2026-07-25T00:01:00.000Z', shipping_hold: false, held_reason: null,
  },
]

function json(body, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) }
}

async function setup(page, options = {}) {
  const captured = { saveBodies: [], externalHosts: new Set() }
  await page.addInitScript((projectRef) => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    window.localStorage.setItem(`sb-${projectRef}-auth-token`, JSON.stringify({
      access_token: 'mock-access-token', refresh_token: 'mock-refresh-token', expires_at: expiresAt,
      expires_in: 3600, token_type: 'bearer',
      user: { id: '00000000-0000-4000-8000-000000000465', aud: 'authenticated', role: 'authenticated', email: 'operator@example.test' },
    }))
  }, supabaseProjectRef)

  await page.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== baseUrl && url.origin !== apiOrigin && !url.hostname.endsWith('supabase.co')) {
      captured.externalHosts.add(url.hostname)
    }
    if (url.hostname.endsWith('supabase.co')) return route.fulfill(json({ user: null }))
    const isApi = url.origin === apiOrigin || url.origin !== baseUrl || url.pathname.startsWith('/api/')
    if (!isApi) return route.continue()

    const hazmatMatch = url.pathname.match(/^\/orders\/(\d+)\/hazmat$/)
    if (hazmatMatch && request.method() === 'GET') {
      return route.fulfill(json({ data: Number(hazmatMatch[1]) === shippedOrder.id ? shippedState() : editableState(options.writeEnabled !== false) }))
    }
    if (url.pathname === `/orders/${awaitingOrder.id}/hazmat/validate` && request.method() === 'POST') {
      const body = request.postDataJSON()
      return route.fulfill(json({ data: { declaration: { schemaVersion: 1, ...body.declaration }, validation: { valid: true, issues: [] } } }))
    }
    if (url.pathname === `/orders/${awaitingOrder.id}/hazmat` && request.method() === 'PUT') {
      const body = request.postDataJSON()
      captured.saveBodies.push(body)
      if (options.saveConflict) {
        return route.fulfill(json({ error: 'Hazmat declaration changed in another session. Reload before saving.', code: 'HAZMAT_REVISION_CONFLICT' }, 409))
      }
      return route.fulfill(json({ data: {
        ...editableState(true), declaration: { schemaVersion: 1, ...body.declaration }, revision: 2,
        semanticHash: 'hz_fixture_saved', validation: { valid: true, issues: [] }, requiresRerate: true,
        changed: true, invalidatedRate: true,
      } }))
    }
    if (url.pathname === '/print-queue' && request.method() === 'GET') {
      return route.fulfill(json({ queuedOrders: queueEntries, totalOrders: 2, totalQty: 2 }))
    }
    if (url.pathname === '/clients') return route.fulfill(json([client]))
    if (url.pathname === '/users') return route.fulfill(json({ users: [{ id: 'u1', email: 'operator@example.test', isAdmin: true }] }))
    if (url.pathname === '/users/me') return route.fulfill(json({ id: 'u1', email: 'operator@example.test', isAdmin: true, role: 'operator' }))
    if (url.pathname === '/markups') return route.fulfill(json({ data: [] }))
    if (url.pathname === '/locations') return route.fulfill(json([{ id: 1, name: 'Fixture Warehouse', street1: '123 Fixture Way', city: 'Gardena', state: 'CA', postalCode: '90248', country: 'US', isDefault: true, active: true }]))
    if (url.pathname === '/packages') return route.fulfill(json([{ id: 1, name: '10x8x4', length: 10, width: 8, height: 4, unitCost: '0.50', source: 'custom' }]))
    if (url.pathname === '/rates/multi') return route.fulfill(json({ carriers: [] }))
    if (url.pathname === '/api/carrier-accounts') return route.fulfill(json({ data: [] }))
    if (url.pathname === '/settings/orders.columnPrefs') return route.fulfill(json({ value: null }))
    if (url.pathname === '/settings/hugrab-default-insurance') return route.fulfill(json({ value: true }))
    if (url.pathname === '/orders/daily-stats') return route.fulfill(json(ORDERS_DAILY_STATS_WIRE))
    if (url.pathname === '/orders/sync/status') return route.fulfill(json({ status: 'idle', lastSyncAt: '2026-07-25T00:00:00.000Z' }))
    if (url.pathname === '/shipments/status') return route.fulfill(json({ status: 'idle' }))
    if (url.pathname === '/init/stores') return route.fulfill(json({ data: [{ id: client.storeId, storeId: client.storeId, name: client.name, storeName: client.name, clientName: client.name, clientId: client.id, active: true, isTest: true }] }))
    if (url.pathname === '/init/counts') return route.fulfill(json({ byStatus: [{ orderStatus: 'awaiting_shipment', cnt: 1 }, { orderStatus: 'shipped', cnt: 1 }], byStatusStore: [] }))
    if (url.pathname === '/clients/order-stats') return route.fulfill(json({ data: [{ clientId: client.id, awaiting_shipment: 1, shipped: 1, cancelled: 0 }] }))
    if (url.pathname === '/orders/distinct-skus') return route.fulfill(json({ skus: ['PS465-DRY-ICE'] }))
    if (url.pathname === '/orders') {
      const rows = url.searchParams.get('status') === 'shipped' ? [shippedOrder] : [awaitingOrder]
      return route.fulfill(json({ data: rows, pagination: { page: 1, pageSize: 50, total: rows.length, totalPages: 1 } }))
    }
    const fullMatch = url.pathname.match(/^\/orders\/(\d+)\/full$/)
    if (fullMatch) return route.fulfill(json(Number(fullMatch[1]) === shippedOrder.id ? shippedOrder : awaitingOrder))
    return route.fulfill(json({}))
  })
  return captured
}

async function openOrder(page, status = 'awaiting_shipment') {
  await page.goto(`${baseUrl}/orders/${status}`)
  const row = page.locator('#ordersTable tbody tr.order-row')
  await expect(row).toHaveCount(1)
  await row.click()
  await expect(page.getByTestId('order-hazmat-declaration')).toBeVisible()
  return page.getByTestId('order-hazmat-declaration')
}

test('desktop validates, saves, invalidates the prior rate, and renders mixed queue badges', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const captured = await setup(page)
  const panel = await openOrder(page)

  await panel.getByLabel('Hazmat declaration status').selectOption('active')
  await panel.getByLabel('Dry ice').check()
  await panel.getByPlaceholder('Dry ice weight').fill('2.5')
  await panel.getByLabel('Dry ice weight unit').selectOption('pound')
  await panel.getByRole('button', { name: 'Validate' }).click()
  await expect(panel).toContainText('Declaration is complete.')
  await panel.getByRole('button', { name: 'Save declaration' }).click()
  await expect(panel).toContainText('Saved. The previous rate was cleared; re-rate before buying a label.')
  await expect(panel).toContainText('Re-rate required before label purchase.')
  expect(captured.saveBodies).toHaveLength(1)
  expect(captured.saveBodies[0]).toMatchObject({ expectedRevision: 1, declaration: { status: 'active', dryIce: true, dryIceWeightValue: 2.5, dryIceWeightUnit: 'pound' } })

  await page.locator('#pq-toggle-btn').click()
  const queue = page.locator('#print-queue-panel')
  await expect(queue).toBeVisible()
  await expect(queue).toContainText(shippedOrder.orderNumber)
  await expect(queue).toContainText('PS465-LEGACY-465003')
  await expect(queue.locator('[title^="Immutable hazmat snapshot revision"]')).toHaveCount(1)
  expect([...captured.externalHosts]).toEqual([])
})

test('permission denial stays backend-owned', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await setup(page, { writeEnabled: false })
  const panel = await openOrder(page)
  await expect(panel).toContainText('Hazmat writes are not enabled for this account or role.')
  await expect(panel.getByLabel('Hazmat declaration status')).toBeDisabled()
  await expect(panel.getByRole('button', { name: 'Save declaration' })).toBeDisabled()
})

test('revision conflict stays backend-owned', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await setup(page, { saveConflict: true })
  const panel = await openOrder(page)
  await panel.getByRole('button', { name: 'Save declaration' }).click()
  await expect(panel).toContainText('Hazmat declaration changed in another session. Reload before saving.')
})

test('mobile shipped view renders only the immutable purchase snapshot', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const captured = await setup(page)
  const panel = await openOrder(page, 'shipped')
  await expect(panel.getByLabel('Hazmat declaration status')).toHaveValue('active')
  await expect(panel.getByLabel('Hazmat declaration status')).toBeDisabled()
  await expect(panel.getByRole('checkbox', { name: 'Dry ice' })).toBeChecked()
  await expect(panel).toContainText('Shipped hazmat snapshot is immutable.')
  await expect(panel.getByRole('button', { name: 'Save declaration' })).toBeDisabled()
  const box = await panel.boundingBox()
  expect(box).not.toBeNull()
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  expect([...captured.externalHosts]).toEqual([])
})
