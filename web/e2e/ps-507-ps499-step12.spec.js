import { test, expect } from '@playwright/test'
import { qaEnv, qaQuery, qaApiFetch, expectExactlyOneRow, expectNoRows } from './support/ps-507-harness.js'

/**
 * PS-499 Step 12 — the first consumer of the PS-507 harness.
 *
 * docs/ps-499-step12-qa-runbook.md is a MANUAL pass. It is careful and it says the right
 * thing — "a screenshot is never sufficient on its own", and several checks are marked
 * **DB:** because the deciding state is not visible in the UI at all. But it depends on a
 * human running ten scenarios and reading four SQL results per scenario, so it is run
 * rarely and its evidence lives in a chat message.
 *
 * This automates the two scenarios whose truth is invisible on screen. It uses the REAL
 * fixture (scripts/ps-499-step12-qa-fixture.ts, unmodified), the REAL PATCH
 * /billing/details/:orderId route the Billing UI calls, and reads the REAL database back.
 *
 *   npm run test:ps-507-step12
 *
 * SCOPE, stated so nobody over-claims it. This proves the API -> persistence half of
 * Step 12 — the half the runbook needs SQL for. It does NOT yet drive the bulk-import
 * paste through the browser UI, so the request-shape checks ("the request has no
 * `shipping` own-property") are asserted by sending that exact shape rather than by
 * observing what the UI produced. Wiring the UI leg is the natural next slice.
 */

const permissions = ['financials:read', 'financials:write']

/** Orders are PS499-QA-<runId>-<n>; the stack exports the run id the fixture printed. */
async function fixtureOrder(n) {
  const runId = process.env.PS499_STEP12_RUN_ID
  expect(runId, 'PS499_STEP12_RUN_ID missing — run the stack with --seed-ps499-step12').toBeTruthy()
  const orderNumber = `PS499-QA-${runId}-${n}`
  const row = await expectExactlyOneRow(
    'select id, order_number from public.orders where order_number = $1', [orderNumber],
    `fixture order ${orderNumber}`,
  )
  // clientId is required by detailPatchSchema — the route scopes the write to a client
  // rather than trusting the order alone, so it has to travel with the patch. It is read
  // from the order's BILLING LINES, not from orders.client_id, which the fixture leaves
  // unset: billing scope lives on the line in this schema.
  const [line] = await qaQuery(
    'select distinct client_id from public.billing_line_items where order_id = $1 and client_id is not null',
    [row.id])
  expect(line?.client_id, 'fixture order must have billing lines carrying a client_id').toBeTruthy()
  return { ...row, client_id: line.client_id }
}

const boxCostOf = (orderId) => qaQuery(
  `select total_cost from public.billing_line_items
    where order_id = $1 and line_type = 'package_cost'`, [orderId])

const shippingOf = (orderId) => qaQuery(
  `select total_cost from public.billing_line_items
    where order_id = $1 and line_type = 'shipping'`, [orderId])

test.describe('PS-499 Step 12 via the PS-507 harness', () => {
  test('scenario D — a same-box import clears the stale pin and the review line', async () => {
    // The runbook's blocker-2 regression. Before the fix the box-resolution block was
    // skipped when the pasted box matched the one already on the order, leaving a stale
    // 99.00 pin and a package_cost_missing review line in place. Neither is visible as a
    // wrong number on screen — the row simply keeps looking fine — which is exactly why
    // the runbook marks this "DB: all four facts".
    const order = await fixtureOrder(4)

    // PRE-state, asserted rather than assumed: if the fixture ever stops seeding the
    // stale pin, this test would otherwise "pass" while proving nothing.
    const [pinBefore] = await qaQuery(
      'select package_id, override_price from public.billing_box_resolutions where order_id = $1',
      [order.id])
    expect(pinBefore, 'fixture must seed a box resolution').toBeTruthy()
    expect(Number(pinBefore.override_price), 'fixture must seed the stale 99.00 pin').toBe(99)
    const reviewBefore = await qaQuery(
      `select id from public.billing_line_items
        where order_id = $1 and line_type = 'package_cost_missing'`, [order.id])
    expect(reviewBefore.length, 'fixture must seed the leftover review line').toBe(1)

    // Paste BOX A — the box already on the order. A pasted box is intent even when it
    // matches, so the import must be accepted and must re-resolve the price.
    const res = await qaApiFetch(`/billing/details/${order.id}`, {
      method: 'PATCH',
      permissions,
      body: { source: 'bulk_import', clientId: order.client_id, packageId: pinBefore.package_id, reason: 'PS-507 step12 scenario D' },
    })
    expect([200, 201, 204], `PATCH rejected: ${await res.clone().text()}`).toContain(res.status)

    // FACT 1 — the box cost is the real price, not the stale pin.
    const [box] = await boxCostOf(order.id)
    expect(Number(box.total_cost), 'box cost must re-resolve to 5.50').toBe(5.5)

    // FACT 2 — the review line is gone.
    await expectNoRows(
      `select id from public.billing_line_items
        where order_id = $1 and line_type = 'package_cost_missing'`, [order.id],
      'package_cost_missing review line',
    )

    // FACT 3 — the pin is cleared. override_price NULL, same package.
    const pinAfter = await expectExactlyOneRow(
      'select package_id, override_price from public.billing_box_resolutions where order_id = $1',
      [order.id], 'box resolution')
    expect(pinAfter.override_price, 'the stale 99.00 pin must be cleared to NULL').toBeNull()
    expect(pinAfter.package_id).toBe(pinBefore.package_id)

    // FACT 4 — no manual override sidecar was written. Absence is the claim a screenshot
    // can never make, and it is the reason this scenario needs a database at all.
    await expectNoRows(
      'select 1 from public.billing_manual_overrides where order_id = $1', [order.id],
      'manual override sidecar for a box-only import',
    )
  })

  test('scenario F1 — a blank shipping cell must not zero the existing shipping', async () => {
    // The underbilling incident this card exists for: a full-resend read of a patch
    // payload silently clears fees the operator never touched. A blank cell must be an
    // OMITTED property, not `shipping: 0`.
    const order = await fixtureOrder(6)

    const [before] = await shippingOf(order.id)
    expect(Number(before.total_cost), 'fixture seeds shipping at 12.00').toBe(12)

    // Box only. No `shipping` own-property at all — which is what the UI must send when
    // the cell is blank.
    const [boxRow] = await qaQuery(
      `select package_id from public.billing_box_resolutions where order_id = $1`, [order.id])
    const packageId = boxRow?.package_id
      ?? (await qaQuery(`select id as package_id from public.packages order by id limit 1`))[0].package_id

    const res = await qaApiFetch(`/billing/details/${order.id}`, {
      method: 'PATCH',
      permissions,
      body: { source: 'bulk_import', clientId: order.client_id, packageId, reason: 'PS-507 step12 scenario F1' },
    })
    expect([200, 201, 204], `PATCH rejected: ${await res.clone().text()}`).toContain(res.status)

    const [after] = await shippingOf(order.id)
    expect(
      Number(after.total_cost),
      'shipping must survive a box-only patch — 0.00 here is the underbilling bug',
    ).toBe(12)
  })
})
