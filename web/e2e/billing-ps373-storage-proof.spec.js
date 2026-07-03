import { test, expect } from 'playwright/test'

// PS-373 (slice 2) — storage-fee PROOF drilldown, browser proof.
//
// Route-mocked (no DB), mirroring billing-summary-total-alignment.spec. Proves
// against the rendered DOM that the one storage billing line exposes an admin
// drilldown which renders the backend-FROZEN per-SKU / per-interval proof
// verbatim:
//   - opening the client's Line Items shows the storage line with a
//     "Storage · proof ▸" affordance (the dating fix means the line is visible
//     in its own month at all);
//   - clicking it opens the proof modal with the period summary;
//   - the per-SKU amount rows RECONCILE to the single storage line total (the
//     feature's core invariant — line total === Σ per-SKU rows);
//   - expanding a SKU reveals its on-hand interval segments;
//   - a negative-balance SKU surfaces as an admin exception (billed at 0).
// The FE recomputes none of this — it displays exactly the /billing/storage-proof
// payload, so the assertions pin display-of-backend-truth, not FE math.

const baseUrl = process.env.PREPSHIP_E2E_BASE_URL ?? 'http://127.0.0.1:5177'
const apiOrigin = 'http://127.0.0.1:3000'
const supabaseProjectRef = 'fdkseckgfuvdczzqmnac'

const clients = [{ id: 1, clientId: 1, name: 'Alpha Client', active: true, isTest: false, storeId: 101 }]

// The single frozen storage line for Alpha (orderId null → the drilldown row).
const STORAGE_TOTAL = '49.74'
const detailRows = [
  {
    id: 9001,
    clientId: 1,
    orderId: null,
    orderNumber: null,
    lineType: 'storage',
    description:
      'Storage — 3084.00 cuft-days over 31 days × $0.5000/cuft/mo (3 SKUs) — 1 negative-balance exception',
    qty: '99.48',
    unitCost: '0.50',
    totalCost: STORAGE_TOTAL,
    shipDate: '2026-01-31T00:00:00.000Z',
  },
]

// The frozen proof the backend would return for this client+period. Per-SKU
// amounts sum EXACTLY to the storage line total (30.00 + 19.74 + 0.00 = 49.74).
const storageProof = {
  found: true,
  clientId: 1,
  periodStart: '2026-01-01T00:00:00.000Z',
  periodEnd: '2026-02-01T00:00:00.000Z',
  daysInMonth: 31,
  monthlyRatePerCuFt: '0.5000',
  dailyRatePerCuFt: '0.0161290323',
  totalCuFtDays: '3084.000000',
  amount: STORAGE_TOTAL,
  skuCount: 3,
  exceptionCount: 1,
  proof: {
    skuProofs: [
      {
        inventoryId: 11,
        sku: 'SKU-ALPHA',
        cuFtPerUnit: 1,
        cuFtDays: 1860,
        amount: 30.0,
        hadNegativeBalance: false,
        negativeDays: 0,
        segments: [
          { fromDay: '2026-01-01', toDay: '2026-01-16', balance: 100, billedQty: 100, days: 15, cuFtDays: 1500 },
          { fromDay: '2026-01-16', toDay: '2026-02-01', balance: 60, billedQty: 60, days: 16, cuFtDays: 960 },
        ],
      },
      {
        inventoryId: 12,
        sku: 'SKU-BETA',
        cuFtPerUnit: 2,
        cuFtDays: 1224,
        amount: 19.74,
        hadNegativeBalance: false,
        negativeDays: 0,
        segments: [
          { fromDay: '2026-01-01', toDay: '2026-02-01', balance: 20, billedQty: 20, days: 31, cuFtDays: 1240 },
        ],
      },
      {
        inventoryId: 13,
        sku: 'SKU-GAMMA',
        cuFtPerUnit: 3,
        cuFtDays: 0,
        amount: 0.0,
        hadNegativeBalance: true,
        negativeDays: 22,
        segments: [
          { fromDay: '2026-01-01', toDay: '2026-01-10', balance: 4, billedQty: 4, days: 9, cuFtDays: 108 },
          { fromDay: '2026-01-10', toDay: '2026-02-01', balance: -5, billedQty: 0, days: 22, cuFtDays: 0 },
        ],
      },
    ],
    exceptions: [{ inventoryId: 13, sku: 'SKU-GAMMA', negativeDays: 22 }],
  },
  updatedAt: '2026-02-01T00:00:00.000Z',
}

function json(body, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) }
}
function apiPath(url) {
  return url.pathname.replace(/^\/api/, '') || '/'
}
function money(text) {
  return Number(String(text).replace(/[^0-9.-]/g, ''))
}

async function setup(page) {
  await page.addInitScript(({ projectRef }) => {
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
          id: '00000000-0000-4000-8000-000000000042',
          aud: 'authenticated',
          role: 'authenticated',
          email: 'billing@example.test',
        },
      }),
    )
  }, { projectRef: supabaseProjectRef })

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.hostname.endsWith('supabase.co')) {
      await route.fulfill(json({ user: { id: 'u1', email: 'billing@example.test' } }))
      return
    }
    const isApi = url.origin === apiOrigin || url.pathname.startsWith('/api/') || url.origin !== baseUrl
    if (!isApi) {
      await route.continue()
      return
    }
    const path = apiPath(url)
    if (path === '/clients') return route.fulfill(json(clients))
    if (path === '/users') return route.fulfill(json({ users: [] }))
    if (path === '/locations') return route.fulfill(json([]))
    if (path === '/packages') return route.fulfill(json({ data: [] }))
    if (path === '/billing/config') return route.fulfill(json([]))
    if (path === '/billing/package-prices') return route.fulfill(json({ data: [] }))
    if (path === '/billing/fetch-ref-rates/status') return route.fulfill(json({ status: 'idle' }))
    if (path === '/billing/summary') {
      return route.fulfill(json({
        clients: [
          { clientId: 1, count: 1, total: Number(STORAGE_TOTAL), byType: { pick_pack: 0, additional: 0, package_cost: 0, storage: Number(STORAGE_TOTAL), shipping: 0 } },
        ],
        grandTotal: Number(STORAGE_TOTAL),
      }))
    }
    if (path === '/billing/details') return route.fulfill(json({ data: detailRows }))
    // The endpoint under test: the frozen storage proof for this client+period.
    if (path === '/billing/storage-proof') return route.fulfill(json(storageProof))
    if (path === '/billing/shipping-margin') return route.fulfill(json({ data: [], summary: {}, carriers: [], rows: [] }))
    if (path === '/init/stores') return route.fulfill(json({ data: clients.map((c) => ({ id: c.storeId, name: c.name, clientId: c.id })) }))
    if (path === '/init/counts') return route.fulfill(json({ awaiting_shipment: 0, shipped: 1, cancelled: 0 }))
    if (path === '/orders/sync/status' || path === '/shipments/status') return route.fulfill(json({ status: 'idle' }))
    if (path === '/settings/orders.columnPrefs') return route.fulfill(json({ value: null }))
    if (path === '/markups') return route.fulfill(json([]))
    return route.fulfill(json({}))
  })
}

test.describe('PS-373 storage-fee proof drilldown', () => {
  test('storage line opens a per-SKU proof that reconciles to the line total', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await setup(page)
    await page.goto(`${baseUrl}/billing`)

    // Open the client's Line Items (the summary row click loads /billing/details).
    await page.getByText('Alpha Client').first().click()

    // The storage line renders with the admin drilldown affordance (only reachable
    // because the line is dated inside its own month — the slice-2 dating fix).
    const proofButton = page.getByRole('button', { name: /Storage · proof/ })
    await expect(proofButton).toBeVisible()
    await proofButton.click()

    // The proof modal opens with the frozen period summary.
    const modal = page.locator('[data-billing-storage-proof-modal]')
    await expect(modal).toBeVisible()
    await expect(modal).toContainText('Storage fee proof')
    await expect(modal).toContainText('Alpha Client')
    await expect(modal).toContainText('31') // days in month
    await expect(modal).toContainText('$0.5000') // monthly rate

    // Core invariant: the per-SKU amounts RECONCILE to the single line total.
    const totalText = await modal.getByTestId('storage-proof-total').innerText()
    const skuAmountTexts = await modal.getByTestId('storage-proof-sku-amount').allInnerTexts()
    expect(skuAmountTexts.length).toBe(3)
    const skuSum = skuAmountTexts.reduce((acc, t) => acc + money(t), 0)
    expect(Math.abs(skuSum - money(totalText)), `Σ per-SKU (${skuSum}) must equal line total (${money(totalText)})`).toBeLessThan(0.005)
    expect(money(totalText)).toBeCloseTo(Number(STORAGE_TOTAL), 2)

    // All three SKUs are listed.
    await expect(modal.locator('[data-storage-proof-sku="SKU-ALPHA"]')).toBeVisible()
    await expect(modal.locator('[data-storage-proof-sku="SKU-BETA"]')).toBeVisible()
    await expect(modal.locator('[data-storage-proof-sku="SKU-GAMMA"]')).toBeVisible()

    // Expanding a SKU reveals its on-hand interval segments (drilldown depth).
    await expect(modal.getByText('2026-01-16', { exact: false })).toHaveCount(0)
    await modal.locator('[data-storage-proof-sku="SKU-ALPHA"]').click()
    await expect(modal.getByText('On hand', { exact: false }).first()).toBeVisible()
    await expect(modal.getByText('2026-01-16', { exact: false }).first()).toBeVisible()

    // The over-shipped SKU surfaces as an admin exception (billed at 0, not negative).
    await expect(modal).toContainText('1 negative-balance exception')
    await expect(modal.locator('[data-storage-proof-sku="SKU-GAMMA"]')).toContainText('NEG')
  })
})
