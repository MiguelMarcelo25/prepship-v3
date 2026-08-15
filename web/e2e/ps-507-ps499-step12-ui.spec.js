import { test, expect } from '@playwright/test'
import { qaQuery, expectExactlyOneRow, signInAsQaUser, gotoApp, gotoView } from './support/ps-507-harness.js'

/**
 * PS-499 Step 12 — the BROWSER leg.
 *
 * The API-side spec (ps-507-ps499-step12.spec.js) proves what happens when a given
 * payload arrives. It cannot prove the UI PRODUCES that payload — it asserts the shape by
 * sending it, which is an assumption about the frontend dressed as a test.
 *
 * This closes that gap for the case the whole card exists for: a BLANK shipping cell must
 * be an OMITTED property, never `shipping: 0`. A full-resend read of a patch payload
 * silently clears fees the operator never touched, and that is the underbilling incident.
 * Here a real operator flow is driven in a real browser, the outgoing request is captured
 * off the wire, and the database is read afterwards.
 *
 * NOTHING on the persistence path is mocked — no page.route anywhere. The bearer is real,
 * the API is real, the database is real.
 */

const permissions = ['financials:read', 'financials:write']

test.describe('PS-499 Step 12 — browser leg', () => {
  test('a blank shipping cell omits the property on the wire and leaves shipping intact', async ({ page }) => {
    const runId = process.env.PS499_STEP12_RUN_ID
    expect(runId, 'run the stack with --seed-ps499-step12').toBeTruthy()

    const orderNumber = `PS499-QA-${runId}-6`
    const order = await expectExactlyOneRow(
      'select id from public.orders where order_number = $1', [orderNumber], `fixture order ${orderNumber}`)

    const [before] = await qaQuery(
      `select total_cost from public.billing_line_items
        where order_id = $1 and line_type = 'shipping'`, [order.id])
    expect(Number(before.total_cost), 'fixture seeds shipping at 12.00').toBe(12)

    // Capture the PATCH off the wire. This is the evidence the API-side spec cannot
    // produce: what the UI actually decided to send.
    const patches = []
    page.on('request', (req) => {
      if (req.method() === 'PATCH' && /\/billing\/details\/\d+/.test(req.url())) {
        patches.push({ url: req.url(), body: req.postDataJSON() })
      }
    })

    await signInAsQaUser(page, { permissions })
    await gotoApp(page)
    await gotoView(page, 'Billing')
    await expect(page.getByText('Billing Dashboard')).toBeVisible({ timeout: 20_000 })

    // The fixture bills "today" relative to the seeder, but the default window is Last 30
    // Days; All removes any doubt about the row being in range. This is a read filter,
    // not Update Billing — nothing is regenerated.
    await page.getByRole('button', { name: 'All', exact: true }).click()

    // Open the client's line items from the summary table. The client name also appears
    // in the reconciliation panel and in a filter <select>, so this is scoped to the
    // summary row class and confirmed by the selected-row class — an unscoped
    // getByText().first() picked a non-interactive copy on some runs and the test then
    // failed for a reason that had nothing to do with the payload.
    const summaryRow = page
      .locator('tr.billing-summary-row')
      .filter({ hasText: `PS-499 QA disposable ${runId}` })
    await summaryRow.click()
    await expect(summaryRow).toHaveClass(/is-detail-selected/)

    // The trigger only mounts once a client's details are loaded.
    const importButton = page.locator('[data-billing-bulk-import-trigger]')
    await importButton.waitFor({ state: 'visible', timeout: 20_000 })

    // Wait for the detail ROWS, not just the trigger.
    //
    // The trigger mounts on `detailState.clientId != null`, which is set when the client is
    // selected — BEFORE /billing/details resolves. The bulk-import modal resolves each
    // pasted line against those rows, so opening it too early yields "Apply 0 rows" and the
    // spec fails on a disabled button with nothing to say why. This was a real race: it
    // passed repeatedly, then failed on an unchanged tree.
    await expect(
      page.getByText(orderNumber, { exact: false }).first(),
      'the client detail rows must be loaded before the import modal can resolve against them',
    ).toBeVisible({ timeout: 20_000 })
    await importButton.scrollIntoViewIfNeeded()
    await importButton.click()

    const modal = page.getByRole('dialog', { name: /Import billing corrections/i })
    await expect(modal).toBeVisible()

    // Row 1: order number and a DIFFERENT box. Shipping is left untouched — the whole
    // point. Filling it with '' would still be a blank cell; not touching it is stronger.
    await modal.getByLabel('Order number, row 1').fill(orderNumber)
    await modal.getByLabel('Box size, row 1').fill('PS499-QA BOX B 12x10x3')
    await expect(modal.getByLabel('Shipping, row 1')).toHaveValue('')

    // A reason is required before Apply enables — the route audits every write.
    await modal.getByPlaceholder(/Canada re-shipment/i).fill('PS-507 browser leg — box only, shipping untouched')

    const apply = modal.getByRole('button', { name: /^Apply/i })
    await expect(apply).toBeEnabled({ timeout: 10_000 })
    await apply.click()

    await expect.poll(() => patches.length, { timeout: 20_000 }).toBeGreaterThan(0)

    // THE ASSERTION THIS SPEC EXISTS FOR — an own-property check, not a value check.
    // `shipping: 0` and an absent `shipping` are different instructions to the route:
    // one clears the fee, the other leaves it alone. `toBeUndefined()` would pass for
    // both, so the test asks whether the key is there at all.
    const [patch] = patches
    expect(patch.body, 'the UI must send a JSON body').toBeTruthy()
    expect(
      Object.prototype.hasOwnProperty.call(patch.body, 'shipping'),
      `a blank shipping cell must OMIT the property; the UI sent ${JSON.stringify(patch.body)}`,
    ).toBe(false)
    expect(patch.body.packageId, 'the pasted box must travel').toBeTruthy()
    expect(patch.body.source).toBe('bulk_import')

    // And the durable consequence: the fee the operator never touched is still there.
    await expect.poll(async () => {
      const [after] = await qaQuery(
        `select total_cost from public.billing_line_items
          where order_id = $1 and line_type = 'shipping'`, [order.id])
      return Number(after.total_cost)
    }, { timeout: 15_000 }).toBe(12)

    // The box did change — proving the patch was applied, not merely accepted. Without
    // this the shipping assertion would also pass if nothing happened at all.
    const [box] = await qaQuery(
      `select total_cost from public.billing_line_items
        where order_id = $1 and line_type = 'package_cost'`, [order.id])
    expect(Number(box.total_cost), 'the pasted box must have been applied').not.toBe(5.5)
  })
})
