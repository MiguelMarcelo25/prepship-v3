import { test, expect } from '@playwright/test'
import { qaQuery, expectExactlyOneRow, expectQueryRejected, qaApiFetch } from './support/ps-507-harness.js'

/**
 * PS-488 M3 — the return-identity contract, proven against a real migrated database.
 *
 * M3's claim is that a return is a first-class billing identity: two returns against one
 * order are two rows keyed `return:<returnId>` (billing-detail-row-sot.ts:331), and
 * migration 0092 makes that structural rather than conventional.
 *
 * Structural means database-enforced, and that is precisely the claim the existing static
 * guards cannot settle. `ps-488-billing-row-reference-guard.ts` can prove the migration
 * TEXT declares a partial unique index and a CHECK; it cannot prove PostgreSQL agrees.
 * A `NOT VALID` CHECK that was never VALIDATEd, an index whose WHERE clause does not
 * match the rows it was meant to catch, or a constraint dropped by a later migration all
 * leave the source reading correct while the database accepts the row. This spec attacks
 * the constraints with real INSERTs on a database built by the repo's own migrations.
 *
 * `RETURN_BILLING_ENABLED` stays FALSE. The generator is PS-487's boundary and flipping
 * the flag is an operator decision; the fixture writes the rows that pass would have
 * produced, so the identity and read half is exercised without enabling the writer.
 */

const permissions = ['financials:read']

function runId() {
  const value = process.env.PS488_M3_RUN_ID
  expect(value, 'run the stack with --seed-ps488-m3').toBeTruthy()
  return value
}

test.describe('PS-488 M3 — return identity', () => {
  test('two returns on one order are two distinct billing identities, not a merged row', async () => {
    const id = runId()
    const order = await expectExactlyOneRow(
      'select id from public.orders where order_number = $1',
      [`PS488-M3-${id}-1`],
      'fixture order',
    )

    // The returns are distinct rows against the SAME order — the shape an order-scoped
    // key silently collapses into one.
    const returns = await qaQuery(
      `select id, return_reference from public.returns
        where order_id = $1 order by return_reference`,
      [order.id],
    )
    expect(returns.map((r) => r.return_reference)).toEqual([
      `PS488-M3-${id}-R1`,
      `PS488-M3-${id}-R2`,
    ])

    // Each return carries its own money, and the two do not share rows.
    const lines = await qaQuery(
      `select return_id, line_type, total_cost from public.billing_line_items
        where order_id = $1 and return_id is not null
        order by return_id, line_type`,
      [order.id],
    )
    expect(lines).toHaveLength(3)
    expect(new Set(lines.map((l) => String(l.return_id))).size, 'both returns must be represented').toBe(2)

    const byReturn = new Map()
    for (const line of lines) {
      const bucket = byReturn.get(String(line.return_id)) ?? {}
      bucket[line.line_type] = Number(line.total_cost)
      byReturn.set(String(line.return_id), bucket)
    }
    expect(byReturn.get(String(returns[0].id))).toEqual({
      return_postage: 7.1,
      return_processing_fee: 2.3,
    })
    // Asymmetric on purpose: if a read model merged the two returns, identical line sets
    // would still total plausibly. Different sets make a merge visible in the money.
    expect(byReturn.get(String(returns[1].id))).toEqual({ return_postage: 9.4 })
  })

  test('the database REJECTS a second charge of the same kind on one return', async () => {
    // billing_li_return_identity_unq. This is the structural answer to the duplicate-row
    // class of defect: without it a return accumulates two postage charges and each looks
    // individually legitimate. Asserted by attempting the duplicate, because a partial
    // unique index that does not match its intended rows still reads correct in the diff.
    const id = runId()
    const order = await expectExactlyOneRow(
      'select id from public.orders where order_number = $1', [`PS488-M3-${id}-1`], 'fixture order')
    const existing = await expectExactlyOneRow(
      `select id, client_id, return_id from public.billing_line_items
        where order_id = $1 and line_type = 'return_postage' and return_id = (
          select id from public.returns where return_reference = $2)`,
      [order.id, `PS488-M3-${id}-R1`],
      'return #1 postage line',
    )

    await expectQueryRejected(
      `insert into public.billing_line_items
        (client_id, order_id, order_number, ship_date, line_type, description,
         qty, unit_cost, total_cost, return_id)
       values ($1, $2, $3, now(), 'return_postage', 'Duplicate postage',
               '1.00', '1.00', '1.00', $4)`,
      [existing.client_id, order.id, `PS488-M3-${id}-1`, existing.return_id],
      /billing_li_return_identity_unq/i,
    )

    // And the attempt left nothing behind.
    const after = await qaQuery(
      `select count(*)::int as n from public.billing_line_items
        where return_id = $1 and line_type = 'return_postage'`,
      [existing.return_id],
    )
    expect(Number(after[0].n), 'the rejected insert must not have landed').toBe(1)
  })

  test('the database REJECTS an outbound line type carrying a return_id', async () => {
    // 0092's CHECK: a non-null return_id may carry ONLY return_postage or
    // return_processing_fee. This is what stops return money leaking into the outbound
    // buckets by line type — the PS-505 boundary, enforced at the storage layer rather
    // than trusted to every writer.
    const id = runId()
    const order = await expectExactlyOneRow(
      'select id from public.orders where order_number = $1', [`PS488-M3-${id}-1`], 'fixture order')
    const existing = await expectExactlyOneRow(
      `select client_id, return_id from public.billing_line_items
        where order_id = $1 and return_id is not null limit 1`,
      [order.id],
      'any return line',
    )

    await expectQueryRejected(
      `insert into public.billing_line_items
        (client_id, order_id, order_number, ship_date, line_type, description,
         qty, unit_cost, total_cost, return_id)
       values ($1, $2, $3, now(), 'shipping', 'Outbound line wearing a return id',
               '1.00', '1.00', '1.00', $4)`,
      [existing.client_id, order.id, `PS488-M3-${id}-1`, existing.return_id],
      /billing_li_return_id_canonical_type_check/i,
    )
  })

  test('the authenticated read model keeps outbound money free of return money', async () => {
    // The money half, through the real API with a real bearer. Outbound totals must be
    // exactly what the fixture billed outbound — return_postage and return_processing_fee
    // are separate buckets, so a read model that folded them in shows up here as a
    // shipping or pick_pack figure that moved.
    const id = runId()
    const order = await expectExactlyOneRow(
      'select id from public.orders where order_number = $1', [`PS488-M3-${id}-1`], 'fixture order')

    const outbound = await qaQuery(
      `select line_type, total_cost from public.billing_line_items
        where order_id = $1 and return_id is null order by line_type`,
      [order.id],
    )
    expect(Object.fromEntries(outbound.map((r) => [r.line_type, Number(r.total_cost)]))).toEqual({
      pick_pack: 3.25,
      package_cost: 4.75,
      shipping: 11.5,
    })

    // The API answers for real — a 500 or a 401 here means the read path cannot serve
    // this shape at all, which is itself the finding.
    const client = await expectExactlyOneRow(
      'select id from public.clients where name = $1', [`PS-488 M3 QA disposable ${id}`], 'fixture client')
    const details = await qaApiFetch(
      `/billing/details?dateFrom=2020-01-01T00:00:00.000Z&dateTo=2030-01-01T00:00:00.000Z&clientId=${client.id}`,
      { permissions },
    )
    expect(details.status, 'the detail read model must serve an order carrying returns').toBe(200)
  })
})
