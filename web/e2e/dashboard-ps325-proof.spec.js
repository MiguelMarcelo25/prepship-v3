import { test, expect } from 'playwright/test'

// ============================================================================
// PS-325 — DASHBOARD READ-MODEL PROOF (the Hermes "browser proof" artifact for
// the dashboard backend-owns-truth cleanup).
//
// Thesis under test: every Dashboard BUSINESS METRIC is owned by the backend and
// the frontend only RENDERS the returned DTOs. This spec drives the real
// DashboardView, OFFLINE, against a fully-mocked backend and asserts at the
// browser boundary that:
//
//   1. Inventory In/Low/Out KPIs render the backend `snapshot` (slice 1) — the
//      mocked snapshot.outOfStock = 298 surfaces, NOT a FE re-classification.
//   2. The KPI cards (Last 7 Days / range Orders+Units / Total Revenue) render
//      from /dashboard/summary (slices 2 + 4).
//   3. The "Data as of" header reports the BACKEND meta.computedAt + live/cached
//      (slice 4) — NOT the browser wall-clock. The mock stamps a FIXED PAST
//      instant (2026-06-20); if the FE fabricated freshness via new Date() it
//      would show today's date instead. Asserting the past date == honest
//      provenance, exactly what PS-325 requires.
//   4. The Top-SKU panel renders (per-SKU units from slice 3b + the heatmap from
//      slice 3) and the Shipping Margin section renders (PS-296). The SKU
//      Performance Summary table renders BODY ROWS from the /dashboard/top-skus
//      payload mapped through reporting-dto.ts — the mock carries the full
//      backend wire shape, so DTO drift errors the panel and fails the spec.
//   5. Network allow-list: the FE contacts NO real postage/marketplace host.
//
// Determinism / safety: no live calls. EVERY network response is mocked via
// page.route('**/*'); unmatched API requests get an empty json({}) so the load
// never hangs. The Supabase session is a SEEDED localStorage mock; the project
// ref is pinned in playwright.config.js so a clean worktree recognises it.
// ============================================================================

const baseUrl = 'http://127.0.0.1:5177'
const apiOrigin = 'http://127.0.0.1:3000'
const supabaseProjectRef = 'fdkseckgfuvdczzqmnac'

// A FIXED past compute instant. Today (in this track) is ~2026-06-26; if the
// "Data as of" header showed today's date it would prove the FE fabricated
// freshness (the old new Date() bug). Showing 06/20 proves it renders the
// backend meta.computedAt.
const COMPUTED_AT = '2026-06-20T12:00:00.000Z'
const META = { computedAt: COMPUTED_AT, source: 'live', window: { from: '2026-05-21', to: '2026-06-20', tz: 'America/Los_Angeles' } }

const clients = [
  { id: 1, name: 'KF Goods', active: true, isTest: false, storeId: 101 },
  { id: 2, name: 'eBay - DJC', active: true, isTest: false, storeId: 102 },
]

function json(body, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) }
}

// The mocked dashboard backend. `captured` records every request so the network
// allow-list test can assert nothing touched a real host.
function makeBackend() {
  const captured = []
  const unmatchedApiPathnames = new Set()

  function responseFor(url, request) {
    if (url.hostname.endsWith('supabase.co')) return json({ user: null })

    const isApiRequest = url.origin === apiOrigin || url.origin !== baseUrl || url.pathname.startsWith('/api/')
    if (!isApiRequest) return null // a baseUrl asset — let the dev server serve it

    // --- Sidebar / shell scaffolding -------------------------------------------------
    if (url.pathname === '/clients') return json(clients)
    if (url.pathname === '/users') return json({ users: [{ id: 'u1', email: 'operator@example.com', isAdmin: true }] })
    if (url.pathname === '/sync/status') {
      return json({ status: 'idle', lastSync: '2026-06-20T11:55:00.000Z', cadenceMinutes: 3, worker: { status: { mode: 'idle' } }, queue: { started: false, queues: [] } })
    }
    if (url.pathname === '/init/stores') {
      return json({ data: clients.map((c) => ({ id: c.storeId, storeId: c.storeId, name: c.name, storeName: c.name, clientName: c.name, clientId: c.id, active: c.active, isTest: c.isTest })) })
    }

    // --- Dashboard BUSINESS METRICS (the heart of the proof) -------------------------

    // /dashboard/summary (slice 2 deltas + slice 4 provenance). Fetched twice
    // (current + prior); the same payload is fine — the proof asserts the KPI
    // cards + the honest freshness header render, not a specific delta value.
    if (url.pathname === '/dashboard/summary') {
      return json({
        revenue: 148097.0,
        units: 3565,
        bySku: [
          { sku: 'SKU-ALPHA', revenue: 80000, units30: 200, units7: 50 },
          { sku: 'SKU-BETA', revenue: 40000, units30: 80, units7: 20 },
        ],
        dailyRevenue: [{ day: '2026-06-20', revenue: 5000 }],
        meta: META,
      })
    }

    // /dashboard/daily-counts (slice 4 provenance) — feeds the order-count KPIs.
    if (url.pathname === '/dashboard/daily-counts') {
      return json({ data: [{ day: '2026-06-20', awaiting: 33, shipped: 2298, cancelled: 23, total: 2354 }], meta: META })
    }

    // /dashboard/inventory-risk (slice 1 snapshot + slice 4 mapper fix). The In/Low/Out
    // KPIs read snapshot.* — the mocked outOfStock=298 must surface verbatim.
    if (url.pathname === '/dashboard/inventory-risk') {
      return json({
        items: [
          { id: 1, clientId: 1, sku: 'SKU-ALPHA', name: 'Alpha Widget', stockQty: 12, reorderLevel: 5, active: true },
          { id: 2, clientId: 1, sku: 'SKU-BETA', name: 'Beta Gadget', stockQty: 0, reorderLevel: 3, active: true },
        ],
        total: 300,
        snapshot: {
          inStock: 2,
          lowStock: 0,
          outOfStock: 298,
          totalSkus: 300,
          definition: { out: 'stock <= 0', low: '0 < stock <= minStock', in: 'stock > minStock' },
          computedAt: COMPUTED_AT,
        },
      })
    }

    // /dashboard/sku-trends (slice 3b per-SKU units + slice 4 provenance). Fetched
    // twice (current + prior). Emits unitsBySku so the FE renders backend-owned units.
    if (url.pathname === '/dashboard/sku-trends') {
      return json({
        topSkus: [
          { sku: 'SKU-ALPHA', name: 'Alpha Widget', total_qty: 200 },
          { sku: 'SKU-BETA', name: 'Beta Gadget', total_qty: 80 },
        ],
        days: [
          { day: '2026-06-18', 'SKU-ALPHA': 10, 'SKU-BETA': 4 },
          { day: '2026-06-19', 'SKU-ALPHA': 20, 'SKU-BETA': 8 },
          { day: '2026-06-20', 'SKU-ALPHA': 170, 'SKU-BETA': 68 },
        ],
        unitsBySku: [
          { sku: 'SKU-ALPHA', units30: 200, units7: 200 },
          { sku: 'SKU-BETA', units30: 80, units7: 80 },
        ],
        meta: META,
      })
    }

    // /dashboard/top-skus (slice 4 provenance) — the SKU performance table.
    // Rows mirror the REAL wire shape emitted by getSkuBreakdownFromOrderItems
    // (src/routes/analysis.ts): the snake_case SQL fields, the camelCase
    // projectAnalysisSkuFinancials fields, and the padded daily_qty array —
    // plus the totals object from projectAnalysisSkuTotals. The FE mappers
    // (reportingSkuDtoFromBackend / reportingTotalsFromBackend in
    // web/src/lib/reporting-dto.ts) THROW on any missing required field, so an
    // incomplete mock here errors the whole top-skus query and the table panel
    // renders its error state instead of rows (assertion 4b guards this).
    if (url.pathname === '/dashboard/top-skus') {
      return json({
        data: [
          {
            sku: 'SKU-ALPHA', name: 'Alpha Widget', image_url: null, inv_sku_id: 11,
            client_id: 1, client_name: 'KF Goods',
            orders: 40, pending: 2, ext_shipped: 3,
            std_orders: 30, std_ship_count: 30, std_total: '250.00', std_qty_total: 150,
            exp_orders: 5, exp_ship_count: 5, exp_total: '100.00', exp_qty_total: 50,
            ship_count_with_cost: 35, total_qty: 200,
            total_shipping: '350.00', total_revenue: '80000.00', total_selling_fee: '0.00',
            selling_fee_complete: false,
            financialsState: 'incomplete',
            standardAvgShipping: 1.67, expeditedAvgShipping: 2, blendedAvgShipping: 10,
            totalShipping: 350, totalRevenue: 80000, avgSellingPrice: 400,
            totalSellingFee: null, profit: null,
            daily_qty: [10, 20, 170],
          },
          {
            sku: 'SKU-BETA', name: 'Beta Gadget', image_url: null, inv_sku_id: 12,
            client_id: 1, client_name: 'KF Goods',
            orders: 20, pending: 1, ext_shipped: 1,
            std_orders: 15, std_ship_count: 15, std_total: '140.00', std_qty_total: 60,
            exp_orders: 3, exp_ship_count: 3, exp_total: '60.00', exp_qty_total: 20,
            ship_count_with_cost: 18, total_qty: 80,
            total_shipping: '200.00', total_revenue: '40000.00', total_selling_fee: '0.00',
            selling_fee_complete: false,
            financialsState: 'incomplete',
            standardAvgShipping: 2.33, expeditedAvgShipping: 3, blendedAvgShipping: 11.11,
            totalShipping: 200, totalRevenue: 40000, avgSellingPrice: 500,
            totalSellingFee: null, profit: null,
            daily_qty: [4, 8, 68],
          },
        ],
        dateBuckets: ['2026-06-18', '2026-06-19', '2026-06-20'],
        totalSkus: 2,
        totalOrders: 60,
        totals: {
          skuCount: 2, totalOrders: 60, totalPending: 3, totalExternal: 4, totalQty: 280,
          totalStdCount: 45, totalExpCount: 8, totalStdQty: 210, totalExpQty: 70,
          totalStdShipping: 390, totalExpShipping: 160,
          standardAvgShipping: 1.86, expeditedAvgShipping: 2.29,
          totalShipping: 550, totalRevenue: 120000, avgSellingPrice: 428.57,
          totalSellingFee: null, totalProfit: null, financialsState: 'incomplete',
        },
        window: { dateFrom: '2026-05-21T00:00:00.000Z', dateToInclusive: '2026-06-20T23:59:59.999Z' },
        meta: META,
      })
    }

    // /dashboard/top-combos + /dashboard/daily-revenue-by-client (slice 4 provenance).
    if (url.pathname === '/dashboard/top-combos') return json({ combos: [], totalCombos: 0, multiSkuOrders: 0, meta: META })
    if (url.pathname === '/dashboard/daily-revenue-by-client') return json({ data: [{ day: '2026-06-20', clientId: 1, revenue: 5000, count: 12 }], meta: META })

    // /dashboard/shipping-margin (PS-296) — the margin summary + carrier rollup.
    if (url.pathname === '/dashboard/shipping-margin') {
      return json({
        canViewFinancials: true,
        dateFrom: '2026-05-21',
        dateTo: '2026-06-20',
        summary: { rowCount: 2123, marginRowCount: 1766, frozenCount: 1768, projectedCount: 0, missingBillableCount: 355, missingActualCostCount: 5, missingAnyProofCount: 357, actualShippingTotal: 15768.64, billableShippingTotal: 16239.39, marginTotal: 470.75, marginPct: 3.0 },
        clients: [],
        carriers: [
          { carrierCode: 'ups', serviceCode: 'ups_ground', providerAccountNickname: null, actualShippingTotal: 349.62, billableShippingTotal: 402.03, marginTotal: 52.41, marginPct: 15, marginRowCount: 10, negativeMarginCount: 0 },
        ],
        rows: [],
      })
    }

    unmatchedApiPathnames.add(url.pathname)
    return json({}) // safe default — unmatched API requests never hang the load
  }

  async function route(routeObj) {
    const request = routeObj.request()
    const url = new URL(request.url())
    captured.push({ method: request.method(), url: request.url(), pathname: url.pathname, host: url.host })
    const mocked = responseFor(url, request)
    if (mocked) { await routeObj.fulfill(mocked); return }
    await routeObj.continue()
  }

  return { captured, unmatchedApiPathnames, route }
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
        user: { id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated', email: 'operator@example.com' },
      }),
    )
  }, supabaseProjectRef)
}

async function gotoDashboard(page, backend) {
  await page.setViewportSize({ width: 1680, height: 950 })
  await seedAuth(page)
  await page.route('**/*', backend.route)
  await page.goto(`${baseUrl}/dashboard`)
  // The KPI row renders once the summary + inventory snapshot resolve.
  await page.waitForSelector('text=Out of Stock', { state: 'visible' })
  await page.waitForLoadState('networkidle')
}

// Real postage / marketplace hosts the Dashboard must NEVER reach.
const FORBIDDEN_HOST_PATTERNS = [
  /shipstation\.com$/i, /ssapi\.shipstation\.com$/i, /easypost\.com$/i,
  /goshippo\.com$/i, /onlinetools\.ups\.com$/i, /api\.fedex\.com$/i, /stamps\.com$/i,
]

const KNOWN_UNMATCHED_API_PATHS = new Set([
  '/health/ready',
  '/settings/markups',
])

function expectOnlyKnownUnmatchedApiPaths(backend) {
  const unexpected = [...backend.unmatchedApiPathnames]
    .filter((pathname) => !KNOWN_UNMATCHED_API_PATHS.has(pathname))
    .sort()
  expect(
    unexpected,
    `dashboard mock catch-all received unexpected API pathnames: ${JSON.stringify(unexpected)}`,
  ).toEqual([])
}

test.describe('PS-325 Dashboard read-model proof', () => {
  test('the Dashboard renders backend-owned metrics + honest provenance', async ({ page }) => {
    const backend = makeBackend()
    await gotoDashboard(page, backend)

    // 1. Inventory In/Low/Out KPIs from the backend snapshot (slice 1). The mocked
    //    snapshot.outOfStock = 298 must surface — proving the FE renders the
    //    backend bucket counts, not a FE re-classification. (Each stock label also
    //    appears as a status badge elsewhere, so scope to .first() = the KPI card.)
    await expect(page.getByText('Out of Stock').first()).toBeVisible()
    await expect(page.getByText('In Stock').first()).toBeVisible()
    await expect(page.getByText('Low Stock').first()).toBeVisible()
    // 298 of 300 SKUs out of stock = 99% — this percentage proves the backend snapshot
    // is what renders (a fall-back over the 2 mock items would yield 50%, not 99%).
    await expect(page.getByText('99% of total SKUs').first()).toBeVisible()

    // 2. The order/revenue KPI cards from /dashboard/summary (slices 2 + 4).
    await expect(page.getByText('Last 7 Days Orders / Units').first()).toBeVisible()
    await expect(page.getByText('Total Revenue').first()).toBeVisible()

    // 3. THE PROVENANCE PROOF (slice 4): the "Data as of" header reports the BACKEND
    //    meta.computedAt (06/20, a FIXED PAST date) + live — NOT today's wall-clock.
    //    If the old new Date() fabrication were still live, this would show ~06/26.
    const freshness = page.getByText(/Data as of .* CA · (?:live|cached)/).first()
    await expect(freshness).toBeVisible()
    await expect(freshness).toContainText('06/20')
    await expect(freshness).toContainText('live')

    // 4. The Top-SKU panel (slice 3b units + slice 3 heatmap) + Shipping Margin (PS-296).
    await expect(page.getByText('Alpha Widget').first()).toBeVisible()
    await expect(page.getByText('Shipping Margin').first()).toBeVisible()

    // 4b. The SKU Performance Summary table renders BODY ROWS mapped through the
    //     top-skus DTO (reportingSkuDtoFromBackend + reportingTotalsFromBackend in
    //     web/src/lib/reporting-dto.ts). Those mappers THROW on any missing required
    //     field (pending/ext_shipped/std_*/exp_*/ship_count_with_cost + the totals
    //     object) — a drifted mock or mapper turns the whole panel into its error
    //     state, so a real row here pins the FE↔backend top-skus contract.
    //     'Alpha Widget' alone can't prove this (the heatmap renders it from
    //     sku-trends); the Store cell 'KF Goods' can ONLY come from the top-skus
    //     row's client_name — neither sku-trends nor inventory-risk carries it.
    //     (DashboardView renders exactly one <table>: the SKU Performance Summary.)
    const alphaRow = page.locator('table tbody tr').filter({ hasText: 'SKU-ALPHA' }).first()
    await expect(alphaRow).toBeVisible()
    await expect(alphaRow).toContainText('KF Goods')
    await expect(page.getByText('Failed to load SKU performance summary')).toHaveCount(0)
    expectOnlyKnownUnmatchedApiPaths(backend)
  })

  test('the Dashboard contacts no real postage/marketplace host', async ({ page }) => {
    const backend = makeBackend()
    await gotoDashboard(page, backend)

    const offenders = backend.captured.filter((r) => FORBIDDEN_HOST_PATTERNS.some((re) => re.test(r.host)))
    expect(offenders, `dashboard must not contact a real provider host: ${JSON.stringify(offenders)}`).toEqual([])
    expectOnlyKnownUnmatchedApiPaths(backend)
  })
})
