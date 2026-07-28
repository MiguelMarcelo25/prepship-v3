import { test, expect } from 'playwright/test'
const baseUrl = 'http://127.0.0.1:5177'
const ref = 'fdkseckgfuvdczzqmnac'
const catalog = {
  engineVersion: 'ps-466-v1', limits: { maxDepth: 3, maxNodes: 50, maxActions: 12 },
  triggers: [{ value: 'order_imported', label: 'order imported' }],
  fields: [{ key: 'order.client_id', label: 'Client', type: 'number', operators: ['eq'] }],
  actions: [{ type: 'tag.add', label: 'Add tag', actionClass: 'accumulative', risk: 'low', available: true, invalidatesRateProof: false, requiresSimulation: false }],
  prohibitedCapabilities: ['label purchase'],
}
const json = (b, s = 200) => ({ status: s, contentType: 'application/json', body: JSON.stringify(b) })
const rule = {
  id: 4, name: 'Test HaZ', description: null, clientId: null, storeId: null,
  priority: 100, position: 0, trigger: 'order_imported', status: 'paused',
  draftRevision: 1, systemLocked: false, hasExecutionHistory: false,
  provenance: 'operator', updatedAt: '2026-07-28T00:00:00.000Z',
  activeVersion: { id: 900, versionNumber: 2, documentHash: 'a'.repeat(64), publishedAt: '2026-07-28T00:00:00.000Z' },
}
const draftDoc = {
  name: 'Test HaZ', description: null, trigger: 'order_imported', priority: 100,
  scope: { clientIds: [], storeIds: [] }, unknownPolicy: 'skip',
  condition: { kind: 'group', op: 'all', children: [] },
  actions: [{ type: 'tag.add', config: { tag: 'AUTOMATED' } }],
}

test('discard draft works even when the first rule fetch lacked the draft', async ({ page }) => {
  const calls = []
  let ruleFetches = 0
  await page.addInitScript((r) => {
    window.localStorage.setItem(`sb-${r}-auth-token`, JSON.stringify({
      access_token: 't', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600,
      expires_in: 3600, token_type: 'bearer',
      user: { id: '00000000-0000-4000-8000-000000000466', aud: 'authenticated', role: 'authenticated', email: 'o@e.com' },
    }))
  }, ref)
  await page.route('**/*', (route) => {
    const req = route.request()
    const u = new URL(req.url())
    if (u.origin === baseUrl && !u.pathname.startsWith('/api/')) return route.continue()
    if (u.hostname.endsWith('supabase.co')) return route.fulfill(json({ user: null }))
    calls.push(`${req.method()} ${u.pathname}`)
    if (u.pathname === '/automations/catalog') return route.fulfill(json({ data: catalog }))
    if (u.pathname === '/automations' && req.method() === 'GET') return route.fulfill(json({ data: [rule] }))
    if (u.pathname === '/automations/4/draft' && req.method() === 'POST') return route.fulfill(json({ data: { created: true } }))
    if (u.pathname === '/automations/4/draft' && req.method() === 'DELETE') return route.fulfill(json({ data: { deleted: true, ruleId: 4, versionId: 901, ruleRemoved: false } }))
    if (u.pathname === '/automations/4' && req.method() === 'GET') {
      ruleFetches += 1
      if (ruleFetches === 1) {
        // Stale first answer: the freshly created draft is not visible yet.
        return route.fulfill(json({ data: { rule, versions: [
          { id: 900, lifecycle: 'published', draftRevision: 1, document: draftDoc, versionNumber: 2 },
        ] } }))
      }
      return route.fulfill(json({ data: { rule, versions: [
        { id: 901, lifecycle: 'draft', draftRevision: 1, document: draftDoc, versionNumber: 3 },
        { id: 900, lifecycle: 'published', draftRevision: 1, document: draftDoc, versionNumber: 2 },
      ] } }))
    }
    if (u.pathname === '/init/stores') return route.fulfill(json({ data: [] }))
    return route.fulfill(json({}))
  })

  await page.goto(`${baseUrl}/automations`)
  await page.getByRole('button', { name: 'Edit Test HaZ' }).click()
  await expect(page.getByText('Guided Builder', { exact: true })).toBeVisible()

  const discard = page.getByRole('button', { name: 'Discard draft' })
  await expect(discard).toBeVisible()
  // The regression: react-query can answer the post-create rule read from a
  // cache populated before the draft existed. The builder must still recover.
  expect(await discard.isDisabled(), 'Discard must not be dead after a stale first fetch').toBe(false)
  await discard.click()

  // Does the confirm dialog actually appear?
  const dialog = page.getByRole('dialog', { name: /Discard this draft/ })
  await expect(dialog).toBeVisible()
  await page.getByRole('button', { name: 'Discard draft', exact: true }).last().click()
  await expect(page.getByText('Guided Builder', { exact: true })).toBeHidden({ timeout: 5000 })
  expect(calls).toContain('DELETE /automations/4/draft')
})
