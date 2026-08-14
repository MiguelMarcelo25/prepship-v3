/**
 * PS-488 M3 — disposable QA fixture for the return-identity contract.
 *
 * WHAT THIS EXISTS TO SET UP
 *
 * M3's claim is that a return is a FIRST-CLASS billing row identity, not a variation of
 * the outbound order it came from: two returns against one order are two rows, each
 * keyed on `return:<returnId>` (billing-detail-row-sot.ts:331), and migration 0092 makes
 * that structural with a partial unique index and a CHECK on the line-type vocabulary.
 *
 * Those are database-enforced facts. A static guard can prove the migration TEXT says so;
 * only a real migrated PostgreSQL rejecting a real INSERT proves the engine agrees. So
 * this fixture builds the smallest shape that lets the constraints be attacked directly:
 *
 *   one order, outbound-billed as normal
 *   TWO returns against that same order  ← the case a per-order key silently merges
 *   return #1 billed for postage AND processing  ← both canonical types, one return
 *   return #2 billed for postage only            ← so the pair is not symmetric
 *
 * The asymmetry is deliberate. If both returns carried identical line sets, a read model
 * that merged them would still produce plausible-looking totals; with different sets, a
 * merge is visible in the money.
 *
 * WHAT THIS FIXTURE DOES NOT DO
 *
 * It does not run the return-billing GENERATOR. `RETURN_BILLING_ENABLED` stays false —
 * on the QA stack and everywhere else — because flipping it is what starts putting
 * return_postage / return_processing_fee lines on real invoices and is a deliberate
 * operator decision, not a test's to make (billing.ts:1797-1800). The rows here are
 * written directly, in the shape that pass would have produced, so the READ and IDENTITY
 * half of M3 is exercised without enabling the writer.
 *
 *   npm run seed:ps-488-m3 -- --plan
 *   NODE_ENV=test npm run seed:ps-488-m3 -- --apply --confirm=PS488-M3-DISPOSABLE
 *   npm run seed:ps-488-m3 -- --teardown --run=<runId>
 *
 * --apply REQUIRES ALL OF: a loopback DATABASE_URL, NODE_ENV=test, a database name
 * carrying a disposable marker, and the confirmation token. Loopback alone is not proof
 * of a throwaway database — it can be a tunnel or a proxy onto real data.
 */
import postgres from 'postgres'

const ARGS = process.argv.slice(2)
const PLAN = ARGS.includes('--plan')
const APPLY = ARGS.includes('--apply')
const TEARDOWN = ARGS.includes('--teardown')
const CONFIRM_TOKEN = 'PS488-M3-DISPOSABLE'

function argValue(name: string): string | null {
  const hit = ARGS.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}

const RUN_ID = argValue('run') ?? new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)

const clientName = (runId: string) => `PS-488 M3 QA disposable ${runId}`
const orderNumber = (runId: string) => `PS488-M3-${runId}-1`
const returnReference = (runId: string, n: number) => `PS488-M3-${runId}-R${n}`

// Outbound money. Deliberately different from every return amount below, so a row that
// mixes the two is visible as a wrong number rather than a coincidence.
const OUTBOUND = { pickPack: '3.25', packageCost: '4.75', shipping: '11.50' } as const
// Return money, distinct per return AND per line type for the same reason.
const RETURN_1 = { postage: '7.10', processing: '2.30' } as const
const RETURN_2 = { postage: '9.40' } as const

const sql = postgres(process.env.DATABASE_URL ?? '', { max: 1, onnotice: () => {} })

type Preflight = { host: string; port: string; database: string }

function preflight(requireApplyInterlock: boolean): Preflight {
  const raw = process.env.DATABASE_URL
  if (!raw) throw new Error('DATABASE_URL is not set')
  const url = new URL(raw)
  const host = url.hostname
  const database = url.pathname.replace(/^\//, '') || '(none)'

  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error(
      `Refusing to run: DATABASE_URL host is ${host}, not loopback. ` +
        'This fixture writes billing and return rows and must never touch a shared database.',
    )
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run with NODE_ENV=production')
  }

  if (requireApplyInterlock) {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('Refusing to --apply unless NODE_ENV=test')
    }
    if (!/ps488|ps507|qa|test|disposable|scratch/i.test(database)) {
      throw new Error(
        `Refusing to --apply: database "${database}" carries no disposable marker. ` +
          'Loopback alone is not proof of a throwaway database — it can be a tunnel, a ' +
          'proxy, or your real dev data.',
      )
    }
    if (argValue('confirm') !== CONFIRM_TOKEN) {
      throw new Error(`Refusing to --apply without --confirm=${CONFIRM_TOKEN}`)
    }
  }

  return { host, port: url.port || '5432', database }
}

function printTarget(p: Preflight, mode: string): void {
  console.log(`PS-488 M3 QA fixture — ${mode}\n`)
  console.log(`  host      : ${p.host}:${p.port}`)
  console.log(`  database  : ${p.database}`)
  console.log(`  NODE_ENV  : ${process.env.NODE_ENV ?? '(unset)'}`)
  console.log(`  run id    : ${RUN_ID}`)
  console.log(`  client    : ${clientName(RUN_ID)}`)
  console.log(`  order     : ${orderNumber(RUN_ID)}`)
  console.log(`  returns   : ${returnReference(RUN_ID, 1)}, ${returnReference(RUN_ID, 2)}\n`)
}

async function findClientId(runId: string): Promise<number | null> {
  const rows = await sql<{ id: number }[]>`select id from clients where name = ${clientName(runId)} limit 1`
  return rows[0]?.id ?? null
}

async function plan(p: Preflight): Promise<void> {
  printTarget(p, 'PLAN (read-only, nothing written)')
  const existing = await findClientId(RUN_ID)
  console.log('planned rows: 1 client, 1 order, 1 shipment, 3 outbound billing lines,')
  console.log('              2 returns, 3 return billing lines (2 on return #1, 1 on return #2)\n')
  if (existing) console.log(`WARNING: run ${RUN_ID} already exists (client id ${existing}); --apply will refuse.`)
  console.log(`To write it:\n  NODE_ENV=test npm run seed:ps-488-m3 -- --apply --confirm=${CONFIRM_TOKEN}`)
}

async function apply(p: Preflight): Promise<void> {
  printTarget(p, 'APPLY')
  if (await findClientId(RUN_ID)) {
    throw new Error(`Refusing to --apply: run ${RUN_ID} already exists. Use a new --run= id or tear it down.`)
  }

  await sql.begin(async (tx) => {
    const [client] = await tx<{ id: number }[]>`
      insert into clients (name, active) values (${clientName(RUN_ID)}, true) returning id`
    const clientId = client!.id

    const number = orderNumber(RUN_ID)
    const [order] = await tx<{ id: number }[]>`
      insert into orders (order_number) values (${number}) returning id`
    const orderId = order!.id
    const [shipment] = await tx<{ id: number }[]>`insert into shipments default values returning id`
    const shipmentId = shipment!.id

    for (const [lineType, description, amount] of [
      ['pick_pack', 'Pick & Pack', OUTBOUND.pickPack],
      ['package_cost', 'Box', OUTBOUND.packageCost],
      ['shipping', 'Shipping', OUTBOUND.shipping],
    ] as const) {
      await tx`insert into billing_line_items
        (client_id, order_id, order_number, shipment_id, ship_date, line_type, description,
         qty, unit_cost, total_cost)
        values (${clientId}, ${orderId}, ${number}, ${shipmentId}, now(),
                ${lineType}, ${description}, '1.00', ${amount}, ${amount})`
    }

    // Two returns against the SAME order. This is the shape a per-order key merges.
    const returnIds: number[] = []
    for (const n of [1, 2]) {
      const [row] = await tx<{ id: number }[]>`
        insert into returns
          (order_id, client_id, status, initiated_by, admin_override, requested_at,
           created_at, updated_at, return_reference)
        values (${orderId}, ${clientId}, 'received', 'qa-fixture', false, now(),
                now(), now(), ${returnReference(RUN_ID, n)})
        returning id`
      returnIds.push(row!.id)
    }

    // Only 'return_postage' and 'return_processing_fee' are writable here — 0092's CHECK
    // rejects anything else carrying a return_id, and the legacy pair is read-only.
    //
    // Return lines carry shipment_id NULL and a description naming the return. Both are
    // forced by the pre-existing outbound identity indexes, and the reasons are worth
    // stating because they are the same reasons production must satisfy:
    // `billing_li_shipment_unique_idx` keys on (order_id, shipment_id, line_type,
    // description), so hanging return lines off the OUTBOUND shipment makes the second
    // return's postage a duplicate of the first's; `billing_li_order_unique_idx` then
    // keys the shipment-less rows on (order_id, line_type, description), so the
    // description has to distinguish the returns. A return is not a shipment of the
    // outbound order, and its charge is not interchangeable with another return's.
    const returnLines = [
      [returnIds[0]!, 1, 'return_postage', RETURN_1.postage],
      [returnIds[0]!, 1, 'return_processing_fee', RETURN_1.processing],
      [returnIds[1]!, 2, 'return_postage', RETURN_2.postage],
    ] as const

    for (const [returnId, n, lineType, amount] of returnLines) {
      const description =
        `${lineType === 'return_postage' ? 'Return postage' : 'Return processing'} ` +
        `(${returnReference(RUN_ID, n)})`
      await tx`insert into billing_line_items
        (client_id, order_id, order_number, ship_date, line_type, description,
         qty, unit_cost, total_cost, return_id)
        values (${clientId}, ${orderId}, ${number}, now(),
                ${lineType}, ${description}, '1.00', ${amount}, ${amount}, ${returnId})`
    }

    console.log(`applied. client id ${clientId}, order id ${orderId}, run id ${RUN_ID}`)
    console.log(`returns: ${returnIds.join(', ')}`)
  })
}

async function teardown(p: Preflight): Promise<void> {
  printTarget(p, 'TEARDOWN')
  const clientId = await findClientId(RUN_ID)
  if (!clientId) {
    console.log(`nothing to remove — no fixture for run ${RUN_ID}`)
    return
  }
  await sql.begin(async (tx) => {
    // Billing lines first: return_id is ON DELETE RESTRICT, so returns cannot go first.
    await tx`delete from billing_line_items where client_id = ${clientId}`
    await tx`delete from returns where client_id = ${clientId}`
    await tx`delete from orders where order_number = ${orderNumber(RUN_ID)}`
    await tx`delete from clients where id = ${clientId}`
  })
  console.log(`removed fixture for run ${RUN_ID}`)
}

async function main(): Promise<void> {
  try {
    if (TEARDOWN) return await teardown(preflight(false))
    if (APPLY) return await apply(preflight(true))
    if (PLAN) return await plan(preflight(false))
    console.log('Specify one of --plan, --apply or --teardown.')
    process.exitCode = 1
  } finally {
    await sql.end({ timeout: 5 })
  }
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
