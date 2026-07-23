import { test, expect } from 'playwright/test'

const baseUrl = process.env.PREPSHIP_E2E_BASE_URL ?? 'http://127.0.0.1:5177'
const apiOrigin = 'http://127.0.0.1:3000'
const supabaseProjectRef = 'fdkseckgfuvdczzqmnac'

const clients = [
  { id: 1, clientId: 1, name: 'Mock Billing Client', active: true, isTest: false, storeId: 101 },
]

const billingDetails = [{
  id: 9001,
  orderId: 501,
  orderNumber: 'BILL-501',
  shipDate: '2026-07-10T12:00:00.000Z',
  clientId: 1,
  itemNames: 'Mock Item',
  itemSkus: 'MOCK-SKU',
  totalQty: 1,
  pickPackFeeTotal: 4,
  packageTotal: 0.5,
  selectedRateCost: 8.12,
  shippingTotal: 8.12,
  fulfillmentFeeTotal: 12.62,
  grandTotal: 12.62,
  lineType: 'billing_order',
}]

function json(body, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) }
}

function apiPath(url) {
  return url.pathname.replace(/^\/api/, '') || '/'
}

async function setup(page) {
  let finalization = null
  let creditNotes = []
  const requests = { finalize: null, credit: null }

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
          id: '00000000-0000-4000-8000-000000000047',
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
    if (path === '/clients') return route.fulfill(json(clients))
    if (path === '/users') return route.fulfill(json({ users: [] }))
    if (path === '/locations') return route.fulfill(json([]))
    if (path === '/packages') return route.fulfill(json({ data: [] }))
    if (path === '/billing/config') return route.fulfill(json([]))
    if (path === '/billing/package-prices') return route.fulfill(json({ data: [] }))
    if (path === '/billing/fetch-ref-rates/status') return route.fulfill(json({ status: 'idle' }))
    if (path === '/billing/preset-window') {
      return route.fulfill(json({ from: '2026-07-01', to: '2026-07-15' }))
    }
    if (path === '/billing/summary') {
      return route.fulfill(json({
        clients: [{
          clientId: 1,
          count: 1,
          total: 12.62,
          byType: { pick_pack: 4, package_cost: 0.5, shipping: 8.12 },
        }],
        grandTotal: 12.62,
      }))
    }
    if (path === '/billing/details') return route.fulfill(json({ data: billingDetails }))
    if (path === '/billing/finalizations' && request.method() === 'GET') {
      return route.fulfill(json({ data: finalization ? [finalization] : [] }))
    }
    if (path === '/billing/finalize' && request.method() === 'POST') {
      const body = request.postDataJSON()
      requests.finalize = body
      finalization = {
        id: 'finalization-1',
        clientId: 1,
        periodStart: `${body.dateFrom}T00:00:00.000Z`,
        periodEnd: `${body.dateTo}T00:00:00.000Z`,
        lineCount: 1,
        orderCount: 1,
        subtotal: '12.62',
        creditedAmount: '0.00',
        debitedAmount: '0.00',
        signedAdjustmentAmount: '0.00',
        balance: '12.62',
        finalizedBy: 'u1',
        finalizedByEmail: 'billing@example.test',
        finalizedAt: '2026-07-15T08:00:00.000Z',
      }
      return route.fulfill(json({ data: { finalization, alreadyFinalized: false } }))
    }
    if (path === '/billing/credit-notes' && request.method() === 'GET') {
      return route.fulfill(json({ data: creditNotes }))
    }
    if (path === '/billing/credit-notes' && request.method() === 'POST') {
      const body = request.postDataJSON()
      requests.credit = body
      const creditNote = {
        id: 'credit-1',
        finalizationId: 'finalization-1',
        clientId: 1,
        amount: '2.50',
        signedAmount: '-2.50',
        adjustmentKind: body.adjustmentKind,
        adjustmentSource: 'manual',
        sourceOrderId: null,
        postingVersion: 'current_period_v2',
        effectiveDate: '2026-07-15T00:00:00.000Z',
        billingPolicyVersion: 'legacy_calendar_v1',
        billingLineItemId: 9100,
        sourceFinalizationId: 'finalization-1',
        reason: body.reason,
        idempotencyKey: body.idempotencyKey,
        createdBy: 'u1',
        createdByEmail: 'billing@example.test',
        createdAt: '2026-07-15T08:05:00.000Z',
      }
      creditNotes = [creditNote]
      finalization = {
        ...finalization,
        creditedAmount: '2.50',
        signedAdjustmentAmount: '-2.50',
        balance: '10.12',
      }
      return route.fulfill(json({
        data: { creditNote, finalization, alreadyCreated: false },
      }))
    }
    if (path === '/init/stores') {
      return route.fulfill(json({ data: clients.map((client) => ({ id: client.storeId, name: client.name, clientId: client.id })) }))
    }
    if (path === '/init/counts') return route.fulfill(json({ awaiting_shipment: 0, shipped: 1, cancelled: 0 }))
    if (path === '/orders/sync/status' || path === '/shipments/status') return route.fulfill(json({ status: 'idle' }))
    if (path === '/settings/orders.columnPrefs') return route.fulfill(json({ value: null }))
    if (path === '/markups') return route.fulfill(json([]))
    return route.fulfill(json({}))
  })

  return requests
}

test('operator finalizes a period, sees the lock, and appends a current-period credit', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const requests = await setup(page)
  await page.goto(`${baseUrl}/billing`)

  await page.locator('.billing-summary-row').click()
  const workflow = page.locator('[data-billing-close-workflow]')
  await expect(workflow).toBeVisible()
  await expect(workflow).toHaveAttribute('data-billing-period-locked', 'false')
  await expect(workflow.getByText('Open billing period')).toBeVisible()

  await workflow.locator('[data-billing-finalize-trigger]').click()
  await expect(page.getByRole('dialog')).toContainText('cannot be undone')
  await page.getByRole('button', { name: 'Finalize and lock' }).click()

  await expect(workflow).toHaveAttribute('data-billing-period-locked', 'true')
  await expect(workflow.getByText('Finalized period · edits locked')).toBeVisible()
  await expect(page.locator('.billing-detail-edit-button').first()).toBeDisabled()
  expect(requests.finalize).toMatchObject({ clientId: 1 })
  expect(requests.finalize.dateFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  expect(requests.finalize.dateTo).toMatch(/^\d{4}-\d{2}-\d{2}$/)

  await workflow.locator('[data-billing-credit-trigger]').click()
  await workflow.getByLabel('Amount').fill('2.50')
  await workflow.getByLabel('Reason').fill('Carrier service refund')
  await workflow.getByRole('button', { name: 'Create credit' }).click()

  await expect(workflow.getByText('Carrier service refund')).toBeVisible()
  await expect(workflow.getByText('$10.12')).toBeVisible()
  expect(requests.credit).toMatchObject({
    clientId: 1,
    finalizationId: 'finalization-1',
    adjustmentKind: 'credit',
    amount: '2.50',
    reason: 'Carrier service refund',
  })
  expect(requests.credit.idempotencyKey).toMatch(/^billing-credit:/)
})
