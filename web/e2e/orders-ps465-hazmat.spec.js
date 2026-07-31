import { test, expect } from 'playwright/test'
import { ORDERS_DAILY_STATS_WIRE } from './orders-daily-stats-wire.js'

// PS-465 browser proof. Every request is intercepted. The suite cannot contact
// a carrier, buy postage, create/print a label, notify a marketplace, or mutate
// production data.
const baseUrl = 'http://127.0.0.1:5177'
const apiOrigin = 'http://127.0.0.1:3000'
// web/src/lib/api-base.ts resolves API_BASE from the repo-root .env's
// VITE_API_URL ahead of the page's own location.hostname whenever that env
// var is set in dev mode -- and this checkout's .env pins
// VITE_API_URL=http://localhost:3000. So the app calls "localhost", not
// "127.0.0.1", even though the page itself is loaded from 127.0.0.1 (see
// playwright.config.js webServer --host). Both are the same loopback mock
// backend this file intercepts and fulfills below -- neither ever reaches a
// real network host -- so both must be recognized as "ours", or the
// no-external-host bookkeeping below misreports a fully-mocked local request
// as an escape.
const apiOriginAlt = 'http://localhost:3000'
const isKnownApiOrigin = (origin) => origin === apiOrigin || origin === apiOriginAlt
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
// PS-477: a second shipped order, distinct from shippedOrder, standing in for
// the five HUGRAB orders whose label was bought in ShipStation and ingested by
// sync -- an active declaration with no purchase snapshot. setup()'s
// `unsealedShipped` option swaps this in wherever shippedOrder normally goes.
const unsealedShippedOrder = makeOrder(465005, 'shipped')
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

// PS-481: featureEnabled is a parameter now. It was hardcoded true, which meant
// every fixture took the flags-on path and the flags-off disclosure branch --
// the half of PS-477 that keeps a shipped dangerous-goods order visible when the
// hazmat kill switch is off -- was never rendered by any test.
function capabilities(writeEnabled, featureEnabled = true) {
  return {
    featureEnabled,
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
    // PS-477: the awaiting fixture declares `clear`, so the backend owner
    // resolves NOT_HAZMAT. Present even though no assertion reads it: the panel
    // falls back to `disclosure` whenever capabilities are off, and a future
    // case built on editableState(false) would hit `undefined.isHazmat` and
    // throw a TypeError instead of failing on the thing it meant to check.
    disclosure: { isHazmat: false, profile: null, provenance: 'none', snapshotHash: null, declarationRevision: null, declaration: null },
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
    // PS-479: the backend now chooses what a terminal view displays. For a
    // sealed order that is the SEALED declaration, not the live one.
    disclosure: { isHazmat: true, profile: 'shipstation_ups_dry_ice', provenance: 'sealed', snapshotHash: 'hz_snapshot_fixture', declarationRevision: 3, declaration: activeDeclaration },
  }
}

// PS-477: the label was bought in ShipStation and ingested by sync -- an
// active declaration exists but PrepShip never purchased it, so no snapshot
// was ever sealed. The disclosure fact (backend canonical owner:
// resolveHazmatDisclosure) is what tells the panel this is
// still dangerous goods.
function unsealedShippedState() {
  return {
    orderId: unsealedShippedOrder.id,
    declaration: activeDeclaration,
    revision: 3,
    semanticHash: 'hz_fixture_unsealed',
    capabilities: capabilities(false),
    validation: { valid: true, issues: [] },
    requiresRerate: false,
    // PS-479: nothing was sealed, so the live declaration is what displays.
    disclosure: { isHazmat: true, profile: null, provenance: 'declared_unsealed', snapshotHash: null, declarationRevision: 3, declaration: activeDeclaration },
  }
}

// PS-481: the kill-switch case. Rollout flags gate WRITING and RATING hazmat;
// they must never gate SEEING that a shipped order went out as dangerous goods.
// Served on unsealedShippedOrder so the id matches whatever setup() resolves as
// the active shipped order.
function flagsOffState(isHazmat) {
  return {
    orderId: unsealedShippedOrder.id,
    declaration: isHazmat ? activeDeclaration : { schemaVersion: 1, status: 'clear', materials: [] },
    revision: 3,
    semanticHash: 'hz_fixture_flags_off',
    capabilities: capabilities(false, false),
    validation: { valid: true, issues: [] },
    requiresRerate: false,
    disclosure: isHazmat
      // PS-479: declaration CONTENT is flag-gated even though the FACT is not,
      // so publicState nulls it. The chip renders off isHazmat/provenance.
      ? { isHazmat: true, profile: null, provenance: 'declared_unsealed', snapshotHash: null, declarationRevision: 3, declaration: null }
      : { isHazmat: false, profile: null, provenance: 'none', snapshotHash: null, declarationRevision: null, declaration: null },
  }
}

const queueEntries = [
  {
    queue_entry_id: 'ps465-hazmat-entry', order_id: String(shippedOrder.id), order_number: shippedOrder.orderNumber,
    client_id: client.id, label_url: 'https://example.test/hazmat.pdf', sku_group_id: 'PS465-HAZMAT',
    primary_sku: 'PS465-HAZMAT', item_description: 'Hazmat fixture', order_qty: 1, multi_sku_data: null,
    status: 'queued', print_count: 0, last_printed_at: null, auto_retired_at: null,
    queued_at: '2026-07-25T00:00:00.000Z', shipping_hold: false, held_reason: null,
    // PS-477 Task 4 moved the badge's render gate off hazmat_profile onto
    // hazmat_is_hazmat (profile is legitimately null for an unsealed order),
    // so this fixture needs the new field to still trip the badge.
    hazmat_is_hazmat: true, hazmat_provenance: 'sealed',
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

// PS-477: a label bought in ShipStation and ingested by sync has an active
// declaration but no purchase snapshot -- hazmat_profile/snapshot_hash are
// genuinely null. Isolated fixture (not mixed into queueEntries) so the new
// queue test stubs exactly the one entry the brief specifies.
const unsealedQueueEntry = {
  queue_entry_id: 'ps465-unsealed-entry', order_id: '465006', order_number: 'PS465-UNSEALED-465006',
  client_id: client.id, label_url: 'https://example.test/unsealed.pdf', sku_group_id: 'PS465-UNSEALED',
  primary_sku: 'PS465-UNSEALED', item_description: 'Unsealed hazmat fixture', order_qty: 1, multi_sku_data: null,
  status: 'queued', print_count: 0, last_printed_at: null, auto_retired_at: null,
  queued_at: '2026-07-25T00:02:00.000Z', shipping_hold: false, held_reason: null,
  hazmat_is_hazmat: true, hazmat_provenance: 'declared_unsealed', hazmat_profile: null,
  hazmat_snapshot_hash: null, hazmat_declaration_revision: 5,
}

function json(body, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) }
}

async function setup(page, options = {}) {
  const captured = { saveBodies: [], externalHosts: new Set() }
  // PS-477: options.unsealedShipped swaps in the unsealed fixture everywhere
  // the suite otherwise serves shippedOrder/shippedState(), so the existing
  // three tests (which never pass this option) stay byte-identical.
  const activeShippedOrder = options.unsealedShipped ? unsealedShippedOrder : shippedOrder
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
    if (url.origin !== baseUrl && !isKnownApiOrigin(url.origin) && !url.hostname.endsWith('supabase.co')) {
      captured.externalHosts.add(url.hostname)
    }
    if (url.hostname.endsWith('supabase.co')) return route.fulfill(json({ user: null }))
    const isApi = isKnownApiOrigin(url.origin) || url.origin !== baseUrl || url.pathname.startsWith('/api/')
    if (!isApi) return route.continue()

    const hazmatMatch = url.pathname.match(/^\/orders\/(\d+)\/hazmat$/)
    if (hazmatMatch && request.method() === 'GET') {
      const matchedId = Number(hazmatMatch[1])
      if (matchedId === activeShippedOrder.id) {
        // PS-481: options.flagsOff is 'hazmat' or 'clear' and forces
        // capabilities.featureEnabled false, so the panel takes its early-return
        // disclosure branch instead of rendering the full editor.
        if (options.flagsOff) {
          return route.fulfill(json({ data: flagsOffState(options.flagsOff === 'hazmat') }))
        }
        return route.fulfill(json({ data: options.unsealedShipped ? unsealedShippedState() : shippedState() }))
      }
      return route.fulfill(json({ data: editableState(options.writeEnabled !== false) }))
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
      // PS-477: options.queueEntries lets a test stub an isolated single-entry
      // response (per the brief) instead of the shared two-entry fixture.
      const entries = options.queueEntries ?? queueEntries
      const totalQty = entries.reduce((sum, entry) => sum + (entry.order_qty ?? 1), 0)
      return route.fulfill(json({ queuedOrders: entries, totalOrders: entries.length, totalQty }))
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
      const rows = url.searchParams.get('status') === 'shipped' ? [activeShippedOrder] : [awaitingOrder]
      return route.fulfill(json({ data: rows, pagination: { page: 1, pageSize: 50, total: rows.length, totalPages: 1 } }))
    }
    const fullMatch = url.pathname.match(/^\/orders\/(\d+)\/full$/)
    if (fullMatch) return route.fulfill(json(Number(fullMatch[1]) === activeShippedOrder.id ? activeShippedOrder : awaitingOrder))
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

// PS-481: openOrder waits on order-hazmat-declaration, which the flags-off
// branch never renders -- it returns the disclosure chip (or nothing) before
// that markup is reached. So the flags-off cases need their own opener, and it
// must confirm the detail panel actually opened via something OUTSIDE the hazmat
// component. Otherwise "renders nothing" would pass just as happily if the row
// click had silently done nothing at all.
async function openShippedRowFlagsOff(page) {
  await page.goto(`${baseUrl}/orders/shipped`)
  const row = page.locator('#ordersTable tbody tr.order-row')
  await expect(row).toHaveCount(1)
  await row.click()
  await expect(page.getByText(unsealedShippedOrder.orderNumber).first()).toBeVisible()
}

test('desktop validates, saves, invalidates the prior rate, and renders mixed queue badges', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const captured = await setup(page)
  const panel = await openOrder(page)

  // The status select was replaced by a plain checkbox (see
  // OrdersHazmatDeclaration.tsx); Dry ice/weight live under the collapsed
  // "Advanced declaration details" <details>, closed by default since this
  // fixture starts with zero validation issues, so it must be opened before
  // its fields are interactable.
  await panel.getByLabel('This shipment contains dangerous goods').check()
  await panel.locator('summary', { hasText: 'Advanced declaration details' }).click()
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
  await expect(panel.getByLabel('This shipment contains dangerous goods')).toBeDisabled()
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
  await expect(panel.getByLabel('This shipment contains dangerous goods')).toBeChecked()
  await expect(panel.getByLabel('This shipment contains dangerous goods')).toBeDisabled()
  // "Dry ice" lives under the collapsed "Advanced declaration details"
  // <details> (closed by default -- zero validation issues for a shipped
  // order). getByRole/getByLabel resolve through the accessibility tree,
  // which excludes a closed <details>' non-summary content outright -- and on
  // this narrow mobile viewport the order detail drawer's real scroll
  // container is nested inside two overflow:hidden/position:fixed ancestors
  // that defeat Playwright's (and the browser's native) scrollIntoView, so
  // opening the panel here is not viable. A plain CSS locator instead reads
  // the checkbox's DOM `checked` property directly -- attached-but-hidden is
  // enough for a state assertion; only actions (click/check/fill) need
  // visibility.
  const dryIceCheckbox = panel.locator('label', { hasText: 'Dry ice' }).locator('input[type="checkbox"]')
  await expect(dryIceCheckbox).toBeChecked()
  await expect(panel).toContainText('Shipped hazmat snapshot is immutable.')
  await expect(panel.getByRole('button', { name: 'Save declaration' })).toBeDisabled()
  const box = await panel.boundingBox()
  expect(box).not.toBeNull()
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  expect([...captured.externalHosts]).toEqual([])
})

// PS-477: five shipped HUGRAB orders carry an active hazmat declaration but no
// purchase snapshot, because the label was bought in ShipStation and ingested
// by sync rather than purchased through PrepShip. Before this ticket the panel
// fell back to clearDeclaration() whenever frozenPurchaseFacts was null,
// affirmatively lying that the shipment was clear. PS-479 then moved the
// choice to the backend; this proves the panel renders what it resolved.
test('unsealed shipped order shows an active declaration, not clear', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const captured = await setup(page, { unsealedShipped: true })
  const panel = await openOrder(page, 'shipped')
  // Proves the panel does NOT render as clear: the checkbox reflects the live
  // declaration (status 'active'), not clearDeclaration()'s unchecked default.
  await expect(panel.getByLabel('This shipment contains dangerous goods')).toBeChecked()
  await expect(panel).toContainText('not sealed')
  await expect(panel).not.toContainText('Shipped hazmat snapshot is immutable.')
  expect([...captured.externalHosts]).toEqual([])
})

// PS-477 Task 4: the badge's render gate is hazmat_is_hazmat, not
// hazmat_profile -- profile is legitimately null when PrepShip never bought
// the label, so gating on it would hide exactly the case this ticket exists
// to fix. This is the regression that would silently reappear if the gate
// moved back onto profile.
test('print queue badges an unsealed hazmat label as not purchased through PrepShip', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const captured = await setup(page, { queueEntries: [unsealedQueueEntry] })
  await page.goto(`${baseUrl}/orders/awaiting_shipment`)
  await expect(page.locator('#ordersTable tbody tr.order-row')).toHaveCount(1)
  await page.locator('#pq-toggle-btn').click()
  const queue = page.locator('#print-queue-panel')
  await expect(queue).toBeVisible()
  await expect(queue).toContainText(unsealedQueueEntry.order_number)
  const badge = queue.locator('[title*="not purchased through PrepShip"]')
  await expect(badge).toHaveCount(1)
  await expect(badge).toContainText('Hazmat')
  expect([...captured.externalHosts]).toEqual([])
})

// PS-481: the other half of PS-477's visibility fix. Rollout flags gate WRITING
// and RATING hazmat; they must never gate SEEING that a shipped order went out
// as dangerous goods. The backend side is pinned by guard case 0b in
// scripts/ps-477-hazmat-disclosure-guard.ts, which fails if anyone re-gates
// `disclosure` on featureEnabled or removes the field. Nothing pinned the
// operator-visible side, which is also the branch most likely to be deleted by
// someone who reads the early return and assumes it is dead code.
test('flags-off shipped hazmat order still discloses dangerous goods', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const captured = await setup(page, { unsealedShipped: true, flagsOff: 'hazmat' })
  await openShippedRowFlagsOff(page)

  const chip = page.getByTestId('order-hazmat-disclosure')
  await expect(chip).toBeVisible()
  await expect(chip).toContainText('Hazmat')
  await expect(chip).toContainText('declared, not sealed at purchase')

  // Writes stay gated. The flags-off branch must render a read-only chip and
  // nothing else -- no editor, no save affordance -- so a disabled kill switch
  // still disables hazmat writing while leaving the fact visible.
  await expect(page.getByTestId('order-hazmat-declaration')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Save declaration' })).toHaveCount(0)
  await expect(page.getByLabel('This shipment contains dangerous goods')).toHaveCount(0)
  expect([...captured.externalHosts]).toEqual([])
})

// PS-481: the negative half. Flags off plus a non-hazmat order must still render
// nothing, so the branch added for the kill-switch case cannot start announcing
// itself on ordinary orders.
test('flags-off order that is not hazmat renders no disclosure', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const captured = await setup(page, { unsealedShipped: true, flagsOff: 'clear' })
  // openShippedRowFlagsOff asserts the detail panel opened via the order number,
  // which is outside the hazmat component -- without that, this test would pass
  // even if the row click had done nothing.
  await openShippedRowFlagsOff(page)

  await expect(page.getByTestId('order-hazmat-disclosure')).toHaveCount(0)
  await expect(page.getByTestId('order-hazmat-declaration')).toHaveCount(0)
  expect([...captured.externalHosts]).toEqual([])
})
