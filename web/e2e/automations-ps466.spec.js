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
    { key: 'line.sku', label: 'Line SKU', type: 'string', operators: ['normalized_eq', 'contains'] },
  ],
  actions: [
    { type: 'tag.add', label: 'Add tag', actionClass: 'accumulative', risk: 'low', available: true, invalidatesRateProof: false },
    { type: 'hold.for_review', label: 'Hold for review', actionClass: 'restrictive', risk: 'medium', available: true, invalidatesRateProof: true },
    { type: 'insurance.require', label: 'Require insurance', actionClass: 'minimum', risk: 'high', available: true, invalidatesRateProof: true },
    { type: 'hazmat.add_declaration', label: 'Apply hazmat declaration profile', actionClass: 'restrictive', risk: 'high', available: false, unavailableReason: 'PS-465 dependency is unavailable on the target branch', invalidatesRateProof: true },
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

function backend() {
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
    captured.push({ method: request.method(), url: request.url(), pathname: url.pathname })
    if (url.origin === baseUrl && !url.pathname.startsWith('/api/')) return routeObj.continue()
    if (url.hostname.endsWith('supabase.co')) return routeObj.fulfill(json({ user: null }))

    if (url.pathname === '/health/ready') return routeObj.fulfill(json({ status: 'ready' }))
    if (url.pathname === '/clients') return routeObj.fulfill(json([{ id: 4, name: 'HUGRAB', active: true, isTest: false, storeId: 378060 }]))
    if (url.pathname === '/users') return routeObj.fulfill(json({ users: [{ id: 'u1', email: 'operator@example.com', isAdmin: true }] }))
    if (url.pathname === '/sync/status') return routeObj.fulfill(json({ status: 'idle', queue: { started: false, queues: [] } }))
    if (url.pathname === '/init/stores') return routeObj.fulfill(json({ data: [{ id: 378060, storeId: 378060, name: 'HUGRAB', clientId: 4, active: true }] }))
    if (url.pathname === '/init/counts') return routeObj.fulfill(json({ byStatus: {}, byStatusStore: {} }))
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
    if (url.pathname === '/automation/availability') {
      return routeObj.fulfill(json({ data: [{
        store: { storeId: 378060, clientId: 4, clientName: 'HUGRAB' },
        carriers: [{ carrierId: 'se-123', carrierCode: 'ups', nickname: 'UPS', friendlyName: 'UPS', disabled: false, disabledReason: null,
          services: [{ serviceCode: 'ups_ground_saver', name: 'UPS Ground Saver', allowed: false, disabled: true, locked: true, reason: 'HUGRAB protected control' }],
        }],
      }] }))
    }
    return routeObj.fulfill(json({}))
  }
  return { captured, route }
}

test.beforeAll(async () => mkdir(screenshotDir, { recursive: true }))

test('PS-466 operations console and guided publish stay backend-driven and offline', async ({ page }) => {
  const mock = backend()
  await seedAuth(page)
  await page.route('**/*', mock.route)
  await page.goto(`${baseUrl}/automations`)

  await expect(page.getByRole('heading', { name: 'Automations' }).last()).toBeVisible()
  await expect(page.getByText('HUGRAB HU-10 review')).toBeVisible()
  await page.getByText('HUGRAB HU-10 review').click()
  await expect(page.getByText('Exact normalized HU-10 compliance gate').last()).toBeVisible()

  await page.getByRole('button', { name: 'New automation' }).click()
  await page.getByLabel('Name').fill('Browser proof automation')
  await page.getByLabel('Description').fill('Offline browser proof')
  await page.getByRole('button', { name: /Continue/ }).click()
  await page.locator('input[placeholder="Value"]').fill('4')
  await page.getByRole('button', { name: /Continue/ }).click()
  await expect(page.getByText('Only backend-allowlisted actions appear.')).toBeVisible()
  await page.getByRole('button', { name: /Continue/ }).click()
  await page.getByRole('button', { name: 'Save draft' }).click()
  await page.getByLabel('Simulation order ID').fill('101')
  await page.getByRole('button', { name: 'Simulate' }).click()
  await expect(page.getByText(/Zero writes: true/)).toBeVisible()
  await expect(page.getByText(/Zero provider calls: true/)).toBeVisible()
  await page.getByRole('button', { name: 'Review & publish' }).click()
  await expect(page.getByRole('table').getByText('Browser proof automation')).toBeVisible()

  await page.getByRole('button', { name: 'Carrier & Service Controls' }).click()
  await expect(page.getByText('UPS Ground Saver')).toBeVisible()
  await expect(page.getByTitle('HUGRAB protected control')).toBeDisabled()
  await page.getByRole('button', { name: 'Run History' }).click()
  await expect(page.getByText('Run #1')).toBeVisible()
  await page.getByRole('button', { name: 'Templates & Actions' }).click()
  await expect(page.getByText('PS-465 dependency is unavailable on the target branch')).toBeVisible()
  await page.screenshot({ path: path.join(screenshotDir, 'automations-console.png'), fullPage: true })

  expect(mock.captured.some((entry) => /shipstation|shopify|walmartapis|ups\.com/i.test(entry.url))).toBe(false)
})

test('PS-466 guided builder remains usable at mobile width', async ({ page }) => {
  const mock = backend()
  await page.setViewportSize({ width: 390, height: 844 })
  await seedAuth(page)
  await page.route('**/*', mock.route)
  await page.goto(`${baseUrl}/automations`)
  await page.getByRole('button', { name: 'New automation' }).click()
  await expect(page.getByText('Guided Builder', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /Continue/ })).toBeVisible()
  await page.screenshot({ path: path.join(screenshotDir, 'automations-mobile-builder.png'), fullPage: true })
})
