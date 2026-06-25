import { test, expect } from 'playwright/test'

// ============================================================================
// PS-324 — INVENTORY READ-MODEL PROOF (the Hermes "browser proof" artifact for
// the inventory backend-owns-truth cleanup).
//
// Thesis under test: InventoryView RENDERS backend-owned facts; it does not
// re-derive operational stock / cost / status in React. This spec drives the
// real InventoryView, OFFLINE, against a fully-mocked /inventory and asserts at
// the browser boundary that the table renders the BACKEND DTO fields — proven by
// making each backend value DISAGREE with what a frontend recomputation would
// produce, so only a backend-rendering UI can show it:
//
//   1. cuFt (a storage-fee BILLING input, slice 1): the mocked row carries
//      cuFt = 88.500 while its dims (14×10×8) would compute 0.648. The cell shows
//      88.500 → the FE renders the backend cuFt, not its own L×W×H/1728.
//   2. Effective-stock status (slices 1+2): a row carries cached stockQty = 50 but
//      backend effectiveStock = 0. The Stock cell shows 0 and the badge shows OUT —
//      the FE classifies on the backend's EFFECTIVE stock via the single
//      classifyStockStatus owner, NOT the raw cached qty (which would read OK).
//   3. The canonical threshold: a row with effectiveStock == minStock renders LOW
//      (stock <= minStock), exactly the shared owner's rule.
//   4. Network allow-list: the page contacts NO real postage/marketplace host.
//
// Determinism / safety: no live calls. EVERY network response is mocked via
// page.route('**/*'); unmatched API requests get an empty json({}) so the load
// never hangs. The Supabase session is a SEEDED localStorage mock; the project
// ref is pinned in playwright.config.js so a clean worktree recognises it.
// ============================================================================

const baseUrl = process.env.PREPSHIP_E2E_BASE_URL ?? 'http://127.0.0.1:5177'
const apiOrigin = 'http://127.0.0.1:3000'
const supabaseProjectRef = 'fdkseckgfuvdczzqmnac'

const clients = [{ id: 1, clientId: 1, name: 'Proof Co', active: true, isTest: false, storeId: 101 }]

// Three rows, each engineered so the backend DTO value differs from a FE recompute.
const inventoryRows = [
  {
    // (1) cuFt proof — backend cuFt 88.5; dims would compute 14*10*8/1728 = 0.648.
    id: 1, sku: 'PS324-CUFT', name: 'Backend cuFt Render Proof', clientId: 1,
    stockQty: 12, effectiveStock: 12, reorderLevel: 5,
    length: 14, width: 10, height: 8, weightOz: 10, unitsPerPack: 1,
    cuFt: 88.5, cuFtOverride: null,
    soldLast30Days: 0, totalReceived: 12, totalSoldAllTime: 0, active: true,
  },
  {
    // (2) effective-stock status proof — cached qty 50 (would read OK), backend
    // effectiveStock 0 must win → Stock 0 + badge OUT.
    id: 2, sku: 'PS324-EFF-OUT', name: 'Effective Stock Status Proof', clientId: 1,
    stockQty: 50, effectiveStock: 0, reorderLevel: 5,
    length: 9, width: 6, height: 3, weightOz: 8, unitsPerPack: 1,
    soldLast30Days: 7, totalReceived: 7, totalSoldAllTime: 7, active: true,
  },
  {
    // (3) canonical threshold — effectiveStock == minStock → LOW (stock <= minStock).
    id: 3, sku: 'PS324-LOW', name: 'Low Threshold Proof', clientId: 1,
    stockQty: 5, effectiveStock: 5, reorderLevel: 5,
    length: 8, width: 5, height: 2, weightOz: 6, unitsPerPack: 1,
    soldLast30Days: 1, totalReceived: 6, totalSoldAllTime: 1, active: true,
  },
]

const ledgerRows = []

function json(body) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) }
}

function responseFor(url) {
  if (url.hostname.endsWith('supabase.co')) return json({ user: null })
  const isApiRequest = url.origin === apiOrigin || url.origin !== baseUrl || url.pathname.startsWith('/api/')
  if (!isApiRequest) return null // a baseUrl asset — let the dev server serve it

  if (url.pathname === '/clients') return json(clients)
  if (url.pathname === '/clients/order-stats') return json({ data: clients.map((c) => ({ clientId: c.id, awaiting_shipment: 0, shipped: 0, cancelled: 0 })) })
  if (url.pathname === '/users') return json({ users: [{ id: 'u1', email: 'operator@example.com', isAdmin: true }] })
  if (url.pathname === '/packages') return json({ data: [] })
  if (url.pathname === '/locations') return json([])
  if (url.pathname === '/settings/orders.columnPrefs') return json({ value: null })
  if (url.pathname === '/orders/sync/status') return json({ status: 'idle', lastSyncAt: '2026-06-20T00:00:00.000Z' })
  if (url.pathname === '/shipments/status') return json({ status: 'idle' })
  if (url.pathname === '/init/stores') return json({ data: clients.map((c) => ({ id: c.storeId, name: c.name, clientId: c.id })) })
  if (url.pathname === '/init/counts') return json({ awaiting_shipment: 0, shipped: 0, cancelled: 0 })
  if (url.pathname === '/orders') return json({ data: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 1 } })
  if (url.pathname === '/inventory/ledger') return json({ data: ledgerRows })
  if (url.pathname === '/parent-skus') return json({ data: [] })
  if (url.pathname === '/inventory') {
    return json({
      data: inventoryRows,
      pagination: { page: 1, pageSize: 200, total: inventoryRows.length, totalPages: 1 },
    })
  }
  return json({}) // safe default — unmatched API requests never hang the load
}

function makeBackend() {
  const captured = []
  async function route(routeObj) {
    const url = new URL(routeObj.request().url())
    captured.push({ method: routeObj.request().method(), pathname: url.pathname, host: url.host })
    const mocked = responseFor(url)
    if (mocked) { await routeObj.fulfill(mocked); return }
    await routeObj.continue()
  }
  return { captured, route }
}

async function gotoInventory(page, backend) {
  await page.setViewportSize({ width: 1680, height: 950 })
  await page.addInitScript((projectRef) => {
    const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60
    window.localStorage.setItem(
      `sb-${projectRef}-auth-token`,
      JSON.stringify({
        access_token: 'mock-access-token', refresh_token: 'mock-refresh-token',
        expires_at: expiresAt, expires_in: 3600, token_type: 'bearer',
        user: { id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated', email: 'operator@example.com' },
      }),
    )
    window.localStorage.setItem('inventory_active_only', 'true')
  }, supabaseProjectRef)
  await page.route('**/*', backend.route)
  await page.goto(`${baseUrl}/inventory`)
  await page.waitForSelector('text=PS324-CUFT', { state: 'visible' })
  await page.waitForLoadState('networkidle')
}

const FORBIDDEN_HOST_PATTERNS = [
  /shipstation\.com$/i, /ssapi\.shipstation\.com$/i, /easypost\.com$/i,
  /goshippo\.com$/i, /onlinetools\.ups\.com$/i, /api\.fedex\.com$/i, /stamps\.com$/i,
]

test.describe('PS-324 Inventory read-model proof', () => {
  test('the Inventory table renders backend-owned cuFt + effective-stock status', async ({ page }) => {
    const backend = makeBackend()
    await gotoInventory(page, backend)

    const rowFor = (sku) => page.locator('.ps-data-table-scroll tbody tr').filter({ hasText: sku })

    // 1. cuFt: backend 88.500 must render, NOT the dims-derived 0.648.
    const cuftCell = rowFor('PS324-CUFT').locator('td[data-col-key="cuFt"]')
    await expect(cuftCell).toContainText('88.500')
    await expect(cuftCell).not.toContainText('0.648')

    // 2. Effective-stock status: cached qty 50, backend effectiveStock 0 → Stock 0, badge OUT.
    const effRow = rowFor('PS324-EFF-OUT')
    await expect(effRow.locator('td[data-col-key="stock"]')).toHaveText('0')
    await expect(effRow.locator('.stock-badge')).toHaveText('OUT')

    // 3. Canonical threshold: effectiveStock == minStock → LOW.
    await expect(rowFor('PS324-LOW').locator('.stock-badge')).toHaveText('LOW')

    // Negative control: the cuFt row (effectiveStock 12 > min 5) is OK, proving the OUT/LOW
    // above are real classifications and not a blanket badge.
    await expect(rowFor('PS324-CUFT').locator('.stock-badge')).toHaveText('OK')
  })

  test('the Inventory page contacts no real postage/marketplace host', async ({ page }) => {
    const backend = makeBackend()
    await gotoInventory(page, backend)
    const offenders = backend.captured.filter((r) => FORBIDDEN_HOST_PATTERNS.some((re) => re.test(r.host)))
    expect(offenders, `inventory must not contact a real provider host: ${JSON.stringify(offenders)}`).toEqual([])
  })
})
