import { test, expect } from '@playwright/test'
import { qaEnv, qaQuery, qaApiFetch, expectExactlyOneRow, expectNoRows, signInAsQaUser } from './support/ps-507-harness.js'

/**
 * PS-507 — proves the harness itself, before anything relies on it.
 *
 * A harness whose failure mode is "silently passes" is worse than no harness: PS-499 and
 * PS-488 would then cite it as evidence of persistence it never checked. So this spec
 * asserts the NEGATIVE cases too — a wrong bearer must 401, and the row-absence helper
 * must actually fail when a row is present.
 *
 * Run through the stack, which supplies every PS507_* variable:
 *   NODE_ENV=test node scripts/ps-507-qa-stack.mjs -- npx playwright test web/e2e/ps-507-persistence-proof.spec.js
 */

test.describe('PS-507 disposable QA stack', () => {
  test('the stack is real: migrated schema, live API, reachable database', async () => {
    const env = qaEnv()
    expect(env.apiUrl).toMatch(/^http:\/\/127\.0\.0\.1:/)
    expect(env.webUrl).toMatch(/^http:\/\/127\.0\.0\.1:/)

    // The schema arrived by the real migration path, including the 0092 return-identity
    // contract — so a billing test here meets the same constraints production enforces.
    const [schema] = await qaQuery(`
      select (select confdeltype from pg_constraint
               where conname = 'billing_line_items_return_id_returns_id_fk') as fk_deltype,
             (select count(*)::int from pg_class
               where relname = 'billing_li_return_identity_unq') as unq,
             (select count(*)::int from information_schema.tables
               where table_schema = 'public') as tables`)
    expect(schema.fk_deltype).toBe('r')
    expect(schema.unq).toBe(1)
    expect(schema.tables).toBeGreaterThan(80)
  })

  test('readiness is FULLY green — every component, not just the main pool', async () => {
    // Readiness is the assertion that catches provisioning drift early, so it is pinned
    // as all-green rather than as a tolerated shape.
    //
    // It was briefly the opposite. The stack ran the socket server at its default
    // maxConnections of 1, and the API is not a one-connection client — health.ts builds
    // `healthSql` as a SEPARATE pool on purpose, so a saturated main pool cannot hide
    // behind health checks, and the advisory lock, sync queue, lane lock, reaper and
    // worker-status each construct their own. The refused connections tore down the
    // active socket, `db`/`dbWrite` failed, the web app rendered the maintenance page
    // instead of the shell, and bulk-import PATCHes failed intermittently. Raising
    // maxConnections fixed the harness. Asserting the degraded shape here would have
    // preserved the harness fault as a specification.
    const { apiUrl } = qaEnv()

    const health = await fetch(`${apiUrl}/health`)
    expect(health.status, '/health must be ok — the API itself is up').toBe(200)

    const ready = await fetch(`${apiUrl}/health/ready`)
    const body = await ready.json()
    const failing = body.components.filter((c) => c.status !== 'ok').map((c) => c.name).sort()

    expect(failing, 'every readiness component must be ok on a correctly provisioned stack').toEqual([])
    expect(ready.status).toBe(200)
  })

  test('the auth boundary is REAL, not mocked', async () => {
    const { apiUrl } = qaEnv()

    const anonymous = await fetch(`${apiUrl}/clients`)
    expect(anonymous.status).toBe(401)

    // Signed with the wrong secret. If this ever returns 200 the harness is not
    // verifying anything and every persistence claim built on it is void.
    const { mintQaToken } = await import('../../scripts/ps-507-qa-stack.mjs')
    const forged = await fetch(`${apiUrl}/clients`, {
      headers: { authorization: `Bearer ${mintQaToken({ secret: 'x'.repeat(48), sub: 'forged', email: 'f@x.test' })}` },
    })
    expect(forged.status).toBe(401)

    const authorised = await qaApiFetch('/clients')
    expect(authorised.status).toBe(200)
  })

  test('a write through the authenticated API is visible in the database', async () => {
    const { runId } = qaEnv()
    const name = `PS507 QA ${runId}`

    const created = await qaApiFetch('/clients', { method: 'POST', body: { name } })
    expect([200, 201]).toContain(created.status)

    // The claim is not "the API answered 200" — it is "the row is in PostgreSQL".
    const row = await expectExactlyOneRow(
      'select id, name from public.clients where name = $1', [name], `client named ${name}`,
    )
    expect(row.name).toBe(name)

    // And nothing else was written under that name: the duplicate half of the proof.
    await expectNoRows(
      'select id from public.clients where name = $1 and id <> $2', [name, row.id],
      `duplicate client named ${name}`,
    )
  })

  test('expectNoRows FAILS when a forbidden row exists', async () => {
    // Guards the guard. If this helper cannot fail, "no sidecar was written" is an
    // unfalsifiable claim and PS-499/PS-488 would inherit it.
    const { runId } = qaEnv()
    const name = `PS507 sentinel ${runId}`
    await qaApiFetch('/clients', { method: 'POST', body: { name } })

    let threw = false
    try {
      await expectNoRows('select id from public.clients where name = $1', [name], 'sentinel client')
    } catch (error) {
      threw = true
      expect(String(error.message)).toContain('A forbidden write occurred')
    }
    expect(threw, 'expectNoRows must fail when the row exists').toBe(true)
  })

  test('the browser authenticates with a real token and reaches the QA API', async ({ page }) => {
    const { webUrl, apiUrl } = qaEnv()
    await signInAsQaUser(page)

    // Record where the app actually sent traffic. No page.route anywhere: if the app
    // called a different origin, or was never authorised, this list shows it.
    const apiCalls = []
    page.on('request', (req) => { if (req.url().startsWith(apiUrl)) apiCalls.push(req.url()) })
    const unauthorised = []
    page.on('response', (res) => { if (res.url().startsWith(apiUrl) && res.status() === 401) unauthorised.push(res.url()) })

    await page.goto(webUrl, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(4000)

    expect(apiCalls.length, 'the app must call the QA API').toBeGreaterThan(0)
    expect(unauthorised, 'no QA API call may come back 401').toEqual([])
  })
})
