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
    expect(byReturn.get(String(returns[1].id))).toEqual({ return_postage: 6.75 })
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

  test('the read model projects THREE rows to the wire — one Outbound, two Returns', async () => {
    // The identity claim as the operator actually receives it. Everything above proves
    // the storage layer; this proves the projection, because a read model that groups by
    // order would satisfy every constraint above and still hand the UI a single merged
    // row. Asserted on the DTO the API really returns, over a real bearer.
    const id = runId()
    const client = await expectExactlyOneRow(
      'select id from public.clients where name = $1', [`PS-488 M3 QA disposable ${id}`], 'fixture client')

    const res = await qaApiFetch(
      `/billing/details?dateFrom=2020-01-01T00:00:00.000Z&dateTo=2030-01-01T00:00:00.000Z&clientId=${client.id}`,
      { permissions },
    )
    expect(res.status, 'the detail read model must serve an order carrying returns').toBe(200)
    const body = await res.json()

    // One order, three rows. A per-order key would give one; a per-line key would give six.
    expect(body.data, 'two returns and one outbound must project as three rows').toHaveLength(3)
    expect(body.data.map((r) => r.rowType).sort()).toEqual(['Outbound', 'Return', 'Return'])

    const outbound = body.data.find((r) => r.rowType === 'Outbound')
    const byReturnRef = new Map(
      body.data.filter((r) => r.rowType === 'Return').map((r) => [r.returnReference, r]),
    )

    // AC-1: rowType comes from the relational returnId, so the outbound row must carry none.
    expect(outbound.returnId, 'the outbound row must not borrow a return identity').toBeNull()
    expect(outbound.returnReference).toBeNull()
    expect(outbound.displayReference).toBe(`#PS488-M3-${id}-1`)
    expect(outbound.lineTypes.slice().sort()).toEqual(['package_cost', 'pick_pack', 'shipping'])

    // The outbound row's money is EXACTLY what was billed outbound. Return money folded in
    // here is the PS-505 defect, and it would show as a moved bucket or a moved total.
    expect(outbound.pickpackTotal).toBeCloseTo(3.25, 2)
    expect(outbound.packageTotal).toBeCloseTo(4.75, 2)
    expect(outbound.shippingTotal).toBeCloseTo(11.5, 2)
    expect(outbound.returnTotal, 'an outbound row carries no return money').toBe(0)
    expect(outbound.grandTotal).toBeCloseTo(19.5, 2)

    // Return #1 — both canonical line types on one return.
    const r1 = byReturnRef.get(`PS488-M3-${id}-R1`)
    expect(r1, 'return #1 must have its own row').toBeTruthy()
    expect(r1.lineTypes.slice().sort()).toEqual(['return_postage', 'return_processing_fee'])
    expect(r1.returnPostageTotal).toBeCloseTo(7.1, 2)
    expect(r1.returnProcessingTotal).toBeCloseTo(2.3, 2)
    expect(r1.returnTotal).toBeCloseTo(9.4, 2)
    expect(r1.hasReturnProcessingLine).toBe(true)

    // Return #2 — postage only, and a DIFFERENT amount, so a merge cannot hide in a
    // plausible sum: merged postage would read 13.85 and a merged total 16.15.
    const r2 = byReturnRef.get(`PS488-M3-${id}-R2`)
    expect(r2, 'return #2 must have its own row').toBeTruthy()
    expect(r2.lineTypes).toEqual(['return_postage'])
    expect(r2.returnPostageTotal).toBeCloseTo(6.75, 2)
    expect(r2.returnProcessingTotal).toBe(0)
    expect(r2.returnTotal).toBeCloseTo(6.75, 2)
    expect(r2.hasReturnProcessingLine, 'return #2 was never billed processing').toBe(false)

    // Neither return row may carry outbound money.
    for (const [ref, row] of byReturnRef) {
      expect(row.pickpackTotal, `${ref} must carry no pick/pack`).toBe(0)
      expect(row.packageTotal, `${ref} must carry no box cost`).toBe(0)
      expect(row.shippingTotal, `${ref} must carry no outbound shipping`).toBe(0)
      expect(row.returnId, `${ref} must carry a relational return id`).toBeTruthy()
      // displayReference is asserted as DISTINCT and reference-bearing, not as an exact
      // format. AC-1's wording describes `#1234-RETURN` while the read model emits
      // `#<returnReference>`; which is intended is a product question, and pinning either
      // reading here would turn a guess into a verified fact.
      expect(row.displayReference).toContain(ref)
      expect(row.displayReference).not.toBe(outbound.displayReference)
    }

    // Return money reaches the client total exactly ONCE. The summary exposes no return
    // bucket, so the check is arithmetic: the gap between grandTotal and the outbound
    // buckets must equal the two returns combined. Double counting would make it 32.30.
    const outboundBuckets =
      body.totals.pickPackTotal + body.totals.additionalTotal + body.totals.packageTotal +
      body.totals.shippingTotal + body.totals.storageTotal + body.totals.adjustmentTotal
    expect(body.totals.grandTotal - outboundBuckets, 'return money must be counted once').toBeCloseTo(16.15, 2)
  })
})
