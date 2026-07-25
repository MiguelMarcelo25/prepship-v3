import { test, expect } from 'playwright/test'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const baseUrl = 'http://127.0.0.1:5177'
const apiOrigin = 'http://127.0.0.1:3000'
const supabaseProjectRef = 'fdkseckgfuvdczzqmnac'
const screenshotDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../reports/ps-466')

const catalog = {
  engineVersion: 'ps-466-v1',
  limits: { maxDepth: 3, maxNodes: 50, maxActions: 12 },
  triggers: [
    { value: 'order_imported', label: 'order imported' },
    { value: 'manual_reprocess', label: 'manual reprocess' },
  ],
  fields: [
    { key: 'order.client_id', label: 'Client', type: 'number', operators: ['eq', 'in'] },
    { key: 'order.store_id', label: 'Store', type: 'number', operators: ['eq', 'in'] },
    { key: 'line.sku', label: 'Line SKU', type: 'string', operators: ['normalized_eq', 'contains'] },
  ],
  actions: [
    { type: 'tag.add', label: 'Add tag', actionClass: 'accumulative', risk: 'low', available: true, invalidatesRateProof: false },
    { type: 'hold.for_review', label: 'Hold for review', actionClass: 'restrictive', risk: 'medium', available: true, invalidatesRateProof: true },
    { type: 'insurance.require', label: 'Require insurance', actionClass: 'minimum', risk: 'high', available: true, invalidatesRateProof: true },
    { type: 'hazmat.add_declaration', label: 'Set shipment as dangerous goods', actionClass: 'restrictive', risk: 'high', available: true, invalidatesRateProof: true },
  ],
  prohibitedCapabilities: ['label purchase', 'ship/cancel status mutation', 'marketplace notification'],
}

function json(body, status = 200, headers = {}) {
  return { status, contentType: 'application/json', headers, body: JSON.stringify(body) }
}

function seedAuth(page) {
  return page.addInitScript((projectRef) => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    window.localStorage.setItem(`sb-${projectRef}-auth-token`, JSON.stringify({
      access_token: 'ps466-offline-token', refresh_token: 'ps466-offline-refresh',
      expires_at: expiresAt, expires_in: 3600, token_type: 'bearer',
      user: { id: '00000000-0000-4000-8000-000000000466', aud: 'authenticated', role: 'authenticated', email: 'operator@example.com' },
    }))
  }, supabaseProjectRef)
}

function backend({ controlServiceCount = 1 } = {}) {
  const captured = []
  let created = false
  let published = false
  const baseRule = {
    id: 466, name: 'HUGRAB HU-10 review', description: 'Exact normalized HU-10 compliance gate',
    clientId: 4, storeId: 378060, priority: 10, position: 0, trigger: 'order_imported',
    status: 'active', draftRevision: 1, systemLocked: false, provenance: 'operator',
    updatedAt: '2026-07-25T00:00:00.000Z',
    activeVersion: { id: 9001, versionNumber: 1, documentHash: 'a'.repeat(64), publishedAt: '2026-07-25T00:00:00.000Z' },
  }
  const createdRule = {
    ...baseRule, id: 467, name: 'Browser proof automation', description: 'Offline browser proof',
    status: published ? 'active' : 'draft', activeVersion: published ? { ...baseRule.activeVersion, id: 9002 } : null,
  }

  async function route(routeObj) {
    const request = routeObj.request()
    const url = new URL(request.url())
    captured.push({ method: request.method(), url: request.url(), pathname: url.pathname, postData: request.postData() })
    if (url.origin === baseUrl && !url.pathname.startsWith('/api/')) return routeObj.continue()
    if (url.hostname.endsWith('supabase.co')) return routeObj.fulfill(json({ user: null }))

    if (url.pathname === '/health/ready') return routeObj.fulfill(json({ status: 'ready' }))
    if (url.pathname === '/clients') return routeObj.fulfill(json([{ id: 4, name: 'HUGRAB', active: true, isTest: false, storeId: 378060 }]))
    if (url.pathname === '/users') return routeObj.fulfill(json({ users: [{ id: 'u1', email: 'operator@example.com', isAdmin: true }] }))
    if (url.pathname === '/sync/status') return routeObj.fulfill(json({ status: 'idle', queue: { started: false, queues: [] } }))
    if (url.pathname === '/init/stores') return routeObj.fulfill(json({ data: [{ storeId: 378060, clientName: 'HUGRAB', clientId: 4, active: true }] }))
    if (url.pathname === '/init/counts') return routeObj.fulfill(json({ byStatus: {}, byStatusStore: {} }))
    if (url.pathname === '/inventory') return routeObj.fulfill(json({ data: [
      { sku: 'HU-10', name: 'Leeds Line V2', clientId: 4 },
      { sku: 'BOOSTER-GEL-001', name: 'Booster Gel', clientId: 4 },
    ], pagination: { page: 1, pageSize: 2000, total: 2, totalPages: 1 } }))
    if (url.pathname === '/automations/catalog') return routeObj.fulfill(json({ data: catalog }))
    if (url.pathname === '/automations' && request.method() === 'GET') {
      return routeObj.fulfill(json({ data: created ? [baseRule, createdRule] : [baseRule] }))
    }
    if (url.pathname === '/automations' && request.method() === 'POST') {
      created = true
      return routeObj.fulfill(json({ data: { rule: createdRule, version: { id: 9002, draftRevision: 1 } } }, 201, { ETag: '"1"' }))
    }
    if (url.pathname === '/automations/467/simulate') {
      return routeObj.fulfill(json({ data: {
        zeroWrites: true, zeroProviderCalls: true, draftHash: 'b'.repeat(64), terminalAuditOnly: false,
        evaluation: { blocked: false, matches: [{ ruleName: 'Browser proof automation', result: 'true', trace: { summary: 'matched' } }], intents: [{ intentId: 'i1', action: { type: 'tag.add' } }] },
        reduction: { conflicts: [], plan: { tags: ['AUTOMATED'] } },
      } }))
    }
    if (url.pathname === '/automations/467/publish') {
      published = true
      return routeObj.fulfill(json({ data: { activation: 'future_orders_only' } }))
    }
    if (url.pathname === '/automations/runs') {
      return routeObj.fulfill(json({ data: [{ id: 1, orderId: 101, ruleId: 466, trigger: 'before_rate', mode: 'apply', status: 'completed', startedAt: '2026-07-25T00:00:00.000Z', completedAt: '2026-07-25T00:00:01.000Z', errorSummary: null }] }))
    }
    if (url.pathname === '/automations/controls') {
      const controlCarriers = [{ carrierId: 'se-123', carrierCode: 'ups', nickname: 'UPS', friendlyName: 'UPS', disabled: false, disabledReason: null,
          services: Array.from({ length: controlServiceCount }, (_, index) => index === 0
            ? { serviceCode: 'ups_ground_saver', name: 'UPS Ground Saver', allowed: false, disabled: true, locked: true, reason: 'HUGRAB protected control' }
            : { serviceCode: `service_${index + 1}`, name: `Service ${index + 1}`, allowed: true, disabled: false, locked: false, reason: null }),
        }]
      return routeObj.fulfill(json({ data: [
        { store: { storeId: 356678, clientId: 2, clientName: 'eBay - DJC' }, carriers: [] },
        { store: { storeId: 378060, clientId: 4, clientName: 'HUGRAB' }, carriers: controlCarriers },
      ] }))
    }
    return routeObj.fulfill(json({}))
  }
  return { captured, route }
}

test.beforeAll(async () => mkdir(screenshotDir, { recursive: true }))

test('Settings ignores the retired Automation section saved in local storage', async ({ page }) => {
  const mock = backend()
  await seedAuth(page)
  await page.addInitScript(() => {
    window.localStorage.setItem('settings:active-drawer-section', 'automation')
  })
  await page.route('**/*', mock.route)
  await page.goto(`${baseUrl}/automations`)

  await page.getByRole('button', { name: 'Settings', exact: true }).click()

  await expect(page).toHaveURL(`${baseUrl}/settings/markups`)
})

test('PS-466 operations console and guided publish stay backend-driven and offline', async ({ page }) => {
  const mock = backend()
  await page.setViewportSize({ width: 1440, height: 1100 })
  await seedAuth(page)
  await page.route('**/*', mock.route)
  await page.goto(`${baseUrl}/automations`)

  await expect(page.getByRole('heading', { name: 'Automations' }).last()).toBeVisible()
  await expect(page.getByText('HUGRAB HU-10 review')).toBeVisible()
  await page.getByText('HUGRAB HU-10 review').click()
  await expect(page.getByText('Exact normalized HU-10 compliance gate').last()).toBeVisible()

  await page.getByRole('button', { name: 'New automation' }).click()
  await expect(page.getByRole('combobox', { name: 'Automation trigger' })).toHaveValue('order_imported')
  await expect(page.getByRole('switch', { name: 'Active rule' })).toBeChecked()
  await expect(page.getByText('Orders match all of these specific criteria')).toBeVisible()
  await expect(page.getByText('Automation Complete')).toBeVisible()
  await expect(page.getByRole('button', { name: /Continue/ })).toHaveCount(0)
  await expect(page.getByLabel('Summary')).toHaveValue('HUGRAB - HAZMAT')
  await expect(page.getByLabel('Condition 1 field')).toHaveValue('line.sku')
  await expect(page.getByLabel('Condition 1 operator')).toHaveValue('contains')
  const skuValue = page.getByLabel('Condition 1 value')
  await expect(skuValue).toHaveValue('HU-10')
  await skuValue.fill('HU')
  const skuSuggestion = page.getByRole('option', { name: /HU-10.*Leeds Line V2/ })
  await expect(skuSuggestion).toBeVisible()
  await page.screenshot({ path: path.join(screenshotDir, 'automation-sku-autosuggest.png'), fullPage: true })
  await skuSuggestion.click()
  await expect(skuValue).toHaveValue('HU-10')
  expect(mock.captured.some((entry) => entry.pathname === '/inventory' && entry.url.includes('clientId=4'))).toBe(true)
  await expect(page.getByLabel('Condition 2 field')).toHaveValue('order.store_id')
  await expect(page.getByLabel('Condition 2 value')).toHaveValue('378060')
  await expect(page.getByRole('combobox', { name: 'Action type 1' })).toHaveValue('Set shipment as dangerous goods')
  await expect(page.getByText('Name Contact')).toBeVisible()
  await expect(page.getByText('Phone Contact')).toBeVisible()
  await expect(page.getByLabel('Dangerous-goods contact name')).toHaveValue('Eddie Kim')
  await expect(page.getByLabel('Dangerous-goods contact phone')).toHaveValue('310-720-1871')
  await expect(page.getByText('Save the draft, enter a test order ID, then run Test rule.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Publish rule' })).toBeDisabled()

  await page.getByRole('button', { name: 'Add action' }).click()
  const secondActionType = page.getByRole('combobox', { name: 'Action type 2' })
  const secondActionValue = page.getByLabel('Action value 2')
  const [actionTypeBox, actionValueBox] = await Promise.all([
    secondActionType.boundingBox(),
    secondActionValue.boundingBox(),
  ])
  expect(actionTypeBox).not.toBeNull()
  expect(actionValueBox).not.toBeNull()
  expect(Math.abs(actionTypeBox.y - actionValueBox.y)).toBeLessThanOrEqual(1)
  expect(actionTypeBox.height).toBe(actionValueBox.height)
  await page.screenshot({ path: path.join(screenshotDir, 'automation-aligned-actions.png'), fullPage: true })
  await page.getByRole('button', { name: 'Remove action 2' }).click()
  await page.getByLabel('Summary').scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(screenshotDir, 'automations-shipstation-builder.png'), fullPage: true })

  await page.getByLabel('Summary').fill('Browser proof automation')
  await page.getByText('Advanced options').click()
  await page.getByLabel('Description').fill('Offline browser proof')
  await page.getByLabel('Dangerous-goods contact name').fill('Dispatch Desk')
  await page.getByLabel('Dangerous-goods contact phone').fill('310-555-0100')
  const createRequestPromise = page.waitForRequest((request) => (
    new URL(request.url()).pathname === '/automations' && request.method() === 'POST'
  ))
  await page.getByRole('button', { name: 'Save draft' }).click()
  const createdDocument = (await createRequestPromise).postDataJSON().document
  expect(createdDocument.actions).toEqual([{
    type: 'hazmat.add_declaration',
    schemaVersion: 1,
    config: { contactName: 'Dispatch Desk', contactPhone: '310-555-0100' },
  }])
  expect(createdDocument.scope).toEqual({ clientIds: [4], storeIds: [378060] })
  expect(createdDocument.condition).toEqual({
    kind: 'group', op: 'all', children: [
      { kind: 'predicate', field: 'order.store_id', operator: 'eq', value: 378060 },
      { kind: 'line_any', condition: { kind: 'group', op: 'all', children: [
        { kind: 'predicate', field: 'line.sku', operator: 'contains', value: 'HU-10' },
      ] } },
    ],
  })
  await expect(page.getByText('Enter a test order ID and run Test rule before publishing.')).toBeVisible()
  await page.getByLabel('Test order ID').fill('101')
  await page.getByRole('button', { name: 'Test rule' }).click()
  await expect(page.getByText(/Order unchanged/)).toBeVisible()
  await expect(page.getByText(/No provider calls/)).toBeVisible()
  await expect(page.getByText('Test passed. Ready to publish.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Publish rule' })).toBeEnabled()
  await page.getByRole('button', { name: 'Publish rule' }).click()
  await expect(page.getByRole('table').getByText('Browser proof automation')).toBeVisible()

  await page.getByRole('tab', { name: 'Carrier & Service Controls' }).click()
  await expect(page.getByRole('button', { name: /eBay - DJC/ })).toBeVisible()
  const hugrabControls = page.getByRole('button', { name: /HUGRAB/ })
  await expect(hugrabControls).toBeVisible()
  await expect(page.getByText('UPS Ground Saver')).toHaveCount(0)
  await hugrabControls.click()
  await expect(page.getByText('UPS Ground Saver')).toBeVisible()
  await expect(page.getByTitle('HUGRAB protected control')).toBeDisabled()
  await page.screenshot({ path: path.join(screenshotDir, 'automation-client-controls.png'), fullPage: true })
  await page.getByRole('tab', { name: 'Run History' }).click()
  await expect(page.getByText('Run #1')).toBeVisible()
  await page.getByRole('tab', { name: 'Templates & Actions' }).click()
  await expect(page.getByText('Set shipment as dangerous goods')).toBeVisible()
  await page.screenshot({ path: path.join(screenshotDir, 'automations-console.png'), fullPage: true })

  expect(mock.captured.some((entry) => /shipstation|shopify|walmartapis|ups\.com/i.test(entry.url))).toBe(false)
})

test('automation tabs stay visible above a tall controls panel', async ({ page }) => {
  const mock = backend({ controlServiceCount: 75 })
  await page.setViewportSize({ width: 1440, height: 800 })
  await seedAuth(page)
  await page.route('**/*', mock.route)
  await page.goto(`${baseUrl}/automations`)

  const controlsTab = page.getByRole('tab', { name: 'Carrier & Service Controls' })
  await controlsTab.click()
  await page.getByRole('button', { name: /HUGRAB/ }).click()
  await expect(page.getByText('Service 75')).toBeVisible()

  const scrollArea = page.getByTestId('automations-scroll')
  const scrollSize = await scrollArea.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }))
  expect(scrollSize.scrollHeight).toBeGreaterThan(scrollSize.clientHeight)
  await scrollArea.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  expect(await scrollArea.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)

  const tablist = page.getByRole('tablist', { name: 'Automation workspace sections' })
  const [tablistBox, controlsTabBox] = await Promise.all([
    tablist.boundingBox(),
    controlsTab.boundingBox(),
  ])
  expect(tablistBox).not.toBeNull()
  expect(controlsTabBox).not.toBeNull()
  expect(tablistBox.height).toBeGreaterThanOrEqual(controlsTabBox.height)

  await expect(page.getByRole('tab', { name: 'Rules' })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Run History' })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Templates & Actions' })).toBeVisible()
})

test('PS-466 guided builder remains usable at mobile width', async ({ page }) => {
  const mock = backend()
  await page.setViewportSize({ width: 390, height: 844 })
  await seedAuth(page)
  await page.route('**/*', mock.route)
  await page.goto(`${baseUrl}/automations`)
  await page.getByRole('button', { name: 'New automation' }).click()
  await expect(page.getByText('Guided Builder', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Summary')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Continue/ })).toHaveCount(0)
  await page.screenshot({ path: path.join(screenshotDir, 'automations-mobile-builder.png'), fullPage: true })
})
