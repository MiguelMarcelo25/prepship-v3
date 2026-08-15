/**
 * PS-499 Step 12 — disposable QA fixture for the manual runtime/UI pass.
 *
 * Seeds clearly-named throwaway orders — one per QA scenario — so the operator
 * running the Billing bulk-import UI has known starting values and can assert exact
 * expected outcomes rather than eyeballing whatever happens to be in the database.
 *
 * SAFE BY DEFAULT — three modes:
 *   1. no flags    → PLAN (read-only): print exactly what would be written.
 *   2. --apply     → APPLY, behind the full interlock below.
 *   3. --teardown  → remove one run's fixture.
 *
 *   npm run seed:ps-499-step12
 *   npm run seed:ps-499-step12 -- --apply --confirm=PS499-STEP12-DISPOSABLE
 *   npm run seed:ps-499-step12 -- --teardown --run=<runId>
 *
 * --apply REQUIRES ALL OF:
 *   NODE_ENV=test
 *   DATABASE_URL host is exactly loopback
 *   the database NAME carries a disposable marker (ps499 / qa / test / disposable / scratch)
 *   --confirm=PS499-STEP12-DISPOSABLE
 *   no existing fixture for the same run id
 *
 * There is deliberately NO --force and no remote escape hatch. Loopback alone is
 * not sufficient: localhost can be an SSH tunnel, a proxy, a shared staging socket
 * or a developer's valuable database, which is why the database-name marker and the
 * confirmation token are also required.
 *
 * PREFERRED LIFECYCLE — a dedicated disposable database, so teardown is dropping the
 * database rather than deleting rows the application protects:
 *
 *   createdb prepship_ps499_qa
 *   DATABASE_URL=postgres://.../prepship_ps499_qa npm run migrate
 *   NODE_ENV=test DATABASE_URL=.../prepship_ps499_qa \
 *     npm run seed:ps-499-step12 -- --apply --confirm=PS499-STEP12-DISPOSABLE
 *   ... run the UI QA, capture evidence ...
 *   dropdb prepship_ps499_qa
 *
 * Dropping a disposable database is environment teardown, not an application-level
 * invoice mutation. It never weakens the finalized-billing trigger. Row-level
 * teardown cannot remove the finalized scenario order — correctly so — which is
 * exactly why the disposable database is preferred.
 *
 * Never calls a carrier, never regenerates billing, never mutates a real invoice,
 * never reads another client's data.
 *
 * Expected arithmetic, so the operator checks fixed numbers rather than impressions:
 *   package_cost_markup = 10%
 *   BOX A  configured 5.00 → bills 5.50
 *   BOX B  configured 8.00 → bills 8.80
 *   BOX C  no configured price → a bulk import of it must 422
 */
import { sql } from '../src/db/client';

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
const TEARDOWN = ARGS.includes('--teardown');
const CONFIRM_TOKEN = 'PS499-STEP12-DISPOSABLE';
const argValue = (name: string): string | null => {
  const hit = ARGS.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

/** Unique per run, so repeated applies cannot silently collide or be reused. */
const RUN_ID = argValue('run') ?? new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);

const clientName = (runId: string) => `PS-499 QA disposable ${runId}`;
const orderNumber = (runId: string, n: number) => `PS499-QA-${runId}-${n}`;

/**
 * The billing timestamp for every fixture line: YESTERDAY at 12:00 UTC.
 *
 * NOT `now()`, and the reason is a real failure rather than a preference. Billing's date
 * presets end at the end of the application's "today", serialised as a UTC instant — an
 * observed window was `dateTo=2026-08-14T23:59:59.999Z` while the clock read
 * 2026-08-15T00:21Z. A row stamped `now()` in that gap sits 21 minutes PAST the upper
 * bound, so the UI loads zero detail rows and any spec driving the UI fails somewhere far
 * from the cause — in our case a bulk-import modal reporting "Apply 0 rows".
 *
 * Midday of the previous UTC day is inside every window this fixture is read through: it
 * is comfortably below any end-of-today bound no matter which side of UTC the application
 * timezone sits on, and comfortably inside the 30-day default lower bound. It also makes
 * the fixture's visibility independent of what time of day it is run, which is what a
 * fixture owes its consumers.
 */
const BILLED_AT = sql`(date_trunc('day', now() at time zone 'UTC') - interval '12 hours') at time zone 'UTC'`;

const MARKUP = '10.00';
const BOX_A = 'PS499-QA BOX A 9x6x3';
const BOX_B = 'PS499-QA BOX B 12x10x3';
const BOX_C = 'PS499-QA BOX C 8x8x8 (unpriced)';

const SCENARIOS = [
  { n: 1, label: 'A · shipping-only, positive amount' },
  { n: 2, label: 'B · shipping-only, explicit $0' },
  { n: 3, label: 'C · box-only, different box (B → bills 8.80)' },
  { n: 4, label: 'D · box-only, SAME box already stamped (stale pin + review line)' },
  { n: 5, label: 'E · combined box + shipping' },
  { n: 6, label: 'F1 · blank SHIPPING must omit (box pasted, shipping blank)' },
  { n: 7, label: 'F2 · blank BOX must omit (shipping pasted, box blank)' },
  { n: 8, label: 'G · unpriced box → visible 422, durable state unchanged' },
  { n: 9, label: 'H · manual Edit Billing modal regression' },
  { n: 10, label: 'I · finalized/invoiced lockdown' },
] as const;

/** Baseline money on every fixture order, so "unchanged" is checkable and non-default. */
const BASELINE = {
  pickPack: '3.50',
  additional: '0.75',
  packageCost: '5.50', // BOX A at 5.00 + 10%
  shipping: '12.00',
};

type Preflight = { host: string; port: string; database: string; schema: string };

function preflight(requireApplyInterlock: boolean): Preflight {
  const raw = process.env.DATABASE_URL ?? '';
  if (!raw) throw new Error('DATABASE_URL is not set');
  const url = new URL(raw);
  const host = url.hostname;
  const database = url.pathname.replace(/^\//, '') || '(none)';

  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error(
      `Refusing to run: DATABASE_URL host is ${host}, not loopback. ` +
        'This fixture writes billing rows and must never touch a shared database.',
    );
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run with NODE_ENV=production');
  }

  if (requireApplyInterlock) {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('Refusing to --apply unless NODE_ENV=test');
    }
    if (!/ps499|qa|test|disposable|scratch/i.test(database)) {
      throw new Error(
        `Refusing to --apply: database "${database}" carries no disposable marker. ` +
          'Loopback alone is not proof of a throwaway database — it can be a tunnel, a ' +
          'proxy, or your real dev data. Use something like prepship_ps499_qa.',
      );
    }
    if (argValue('confirm') !== CONFIRM_TOKEN) {
      throw new Error(`Refusing to --apply without --confirm=${CONFIRM_TOKEN}`);
    }
  }

  return { host, port: url.port || '5432', database, schema: 'public' };
}

function printTarget(p: Preflight, mode: string): void {
  console.log(`PS-499 Step 12 QA fixture — ${mode}\n`);
  console.log(`  host      : ${p.host}:${p.port}`);
  console.log(`  database  : ${p.database}`);
  console.log(`  schema    : ${p.schema}`);
  console.log(`  NODE_ENV  : ${process.env.NODE_ENV ?? '(unset)'}`);
  console.log(`  run id    : ${RUN_ID}`);
  console.log(`  client    : ${clientName(RUN_ID)}`);
  console.log(`  orders    : ${orderNumber(RUN_ID, 1)} … ${orderNumber(RUN_ID, SCENARIOS.length)}\n`);
}

async function findClientId(runId: string): Promise<number | null> {
  const rows = await sql<{ id: number }[]>`select id from clients where name = ${clientName(runId)} limit 1`;
  return rows[0]?.id ?? null;
}

async function plan(p: Preflight): Promise<void> {
  printTarget(p, 'PLAN (read-only, nothing written)');
  const existing = await findClientId(RUN_ID);
  const others = await sql<{ name: string }[]>`
    select name from clients where name like 'PS-499 QA disposable %' order by name`;

  console.log(`planned rows: 1 client, 1 billing_config, 3 packages, 2 client_package_prices,`);
  console.log(`              ${SCENARIOS.length} orders + shipments, ${SCENARIOS.length * 4} billing lines,`);
  console.log(`              1 stale box resolution, 1 package_cost_missing line\n`);
  console.log('scenarios:');
  for (const s of SCENARIOS) console.log(`  ${orderNumber(RUN_ID, s.n).padEnd(28)} ${s.label}`);

  if (existing) console.log(`\nWARNING: run ${RUN_ID} already exists (client id ${existing}); --apply will refuse.`);
  if (others.length) {
    console.log(`\nexisting PS-499 QA fixtures in this database: ${others.length}`);
    for (const o of others) console.log(`  ${o.name}`);
  }
  console.log(`\nTo write it:\n  NODE_ENV=test npm run seed:ps-499-step12 -- --apply --confirm=${CONFIRM_TOKEN}`);
}

async function apply(p: Preflight): Promise<void> {
  printTarget(p, 'APPLY');
  if (await findClientId(RUN_ID)) {
    throw new Error(`Refusing to --apply: run ${RUN_ID} already exists. Use a new --run= id or tear it down.`);
  }

  await sql.begin(async (tx) => {
    const [client] = await tx<{ id: number }[]>`
      insert into clients (name, active) values (${clientName(RUN_ID)}, true) returning id`;
    const clientId = client!.id;

    await tx`insert into billing_config (client_id, package_cost_markup)
      values (${clientId}, ${MARKUP})
      on conflict (client_id) do update set package_cost_markup = ${MARKUP}`;

    const packageIds: Record<string, number> = {};
    for (const [name, price] of [[BOX_A, '5.00'], [BOX_B, '8.00'], [BOX_C, null]] as const) {
      const [found] = await tx<{ id: number }[]>`select id from packages where name = ${name} limit 1`;
      const id = found?.id
        ?? (await tx<{ id: number }[]>`insert into packages (name, source) values (${name}, 'custom') returning id`)[0]!.id;
      packageIds[name] = id;
      if (price) {
        await tx`insert into client_package_prices (client_id, package_id, price)
          values (${clientId}, ${id}, ${price}) on conflict do nothing`;
      }
    }
    const boxA = packageIds[BOX_A]!;

    for (const scenario of SCENARIOS) {
      const number = orderNumber(RUN_ID, scenario.n);
      const [order] = await tx<{ id: number }[]>`
        insert into orders (order_number) values (${number}) returning id`;
      const orderId = order!.id;
      const [shipment] = await tx<{ id: number }[]>`insert into shipments default values returning id`;
      const shipmentId = shipment!.id;

      for (const [lineType, description, amount] of [
        ['pick_pack', 'Pick & Pack', BASELINE.pickPack],
        ['additional_unit', 'Additional Units', BASELINE.additional],
        ['package_cost', `Box (${BOX_A})`, BASELINE.packageCost],
        ['shipping', 'Shipping', BASELINE.shipping],
      ] as const) {
        await tx`insert into billing_line_items
          (client_id, order_id, order_number, shipment_id, ship_date, line_type, description,
           qty, unit_cost, total_cost, package_id)
          values (${clientId}, ${orderId}, ${number}, ${shipmentId}, ${BILLED_AT},
                  ${lineType}, ${description}, '1.00', ${amount}, ${amount}, ${boxA})`;
      }

      // Scenario D: a stale pinned price and a leftover review line, so the
      // same-package import has real state to clear rather than passing vacuously.
      if (scenario.n === 4) {
        await tx`insert into billing_box_resolutions (order_id, package_id, override_price, note)
          values (${orderId}, ${boxA}, '99.00', 'PS-499 QA stale pin')`;
        await tx`insert into billing_line_items
          (client_id, order_id, order_number, shipment_id, ship_date, line_type, description,
           qty, unit_cost, total_cost)
          values (${clientId}, ${orderId}, ${number}, ${shipmentId}, ${BILLED_AT},
                  'package_cost_missing', 'No box cost', '1.00', '0.00', '0.00')`;
      }

      // Scenario I: invoiced, so the finalized lockdown actually fires.
      if (scenario.n === 10) {
        await tx`update billing_line_items set invoiced = true where order_id = ${orderId}`;
      }
    }

    console.log(`applied. client id ${clientId}, run id ${RUN_ID}`);
    console.log(`record this run id in the evidence bundle.`);
  });
}

async function teardown(p: Preflight): Promise<void> {
  printTarget(p, 'TEARDOWN');
  const clientId = await findClientId(RUN_ID);
  if (!clientId) {
    console.log(`nothing to remove — no fixture for run ${RUN_ID}`);
    return;
  }
  const orders = await sql<{ id: number; order_number: string }[]>`
    select distinct order_id as id, order_number from billing_line_items where client_id = ${clientId}`;

  const retained: string[] = [];
  for (const order of orders) {
    try {
      await sql.begin(async (tx) => {
        await tx`delete from billing_manual_overrides where order_id = ${order.id}`;
        await tx`delete from billing_fee_waivers where order_id = ${order.id}`;
        await tx`delete from billing_box_resolutions where order_id = ${order.id}`;
        await tx`delete from billing_order_descriptions where order_id = ${order.id}`;
        await tx`delete from billing_line_items where order_id = ${order.id}`;
      });
    } catch {
      // The finalized order is protected by the production block-finalized-mutation
      // trigger. That is correct: finalized billing is immutable. Do NOT weaken the
      // trigger or un-invoice the row to clean up.
      retained.push(order.order_number);
    }
  }

  console.log(`removed billing rows for ${orders.length - retained.length} of ${orders.length} order(s).`);
  if (retained.length) {
    console.log(`\nRETAINED (finalized billing is immutable by design):`);
    for (const number of retained) console.log(`  ${number}`);
    console.log(`\nThis is why a dedicated disposable database is preferred: drop the`);
    console.log(`database instead. Do not un-invoice or weaken the trigger to clean up.`);
  }
  console.log('Audit rows are append-only and are deliberately not removed.');
}

async function main(): Promise<void> {
  const p = preflight(APPLY);
  if (TEARDOWN) await teardown(p);
  else if (APPLY) await apply(p);
  else await plan(p);
  await sql.end({ timeout: 5 });
}

await main();
