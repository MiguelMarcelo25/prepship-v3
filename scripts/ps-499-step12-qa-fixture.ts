/**
 * PS-499 Step 12 — disposable QA fixture for the manual runtime/UI pass.
 *
 * Seeds one clearly-named throwaway client with one order per QA scenario, so the
 * operator running the Billing bulk-import UI has known starting values and can
 * assert exact expected outcomes rather than eyeballing whatever happens to be in
 * the local database.
 *
 * SAFE BY DEFAULT — three modes:
 *   1. no flags    → PLAN (read-only): print exactly what would be written.
 *   2. --apply     → APPLY: write the fixture inside one transaction.
 *   3. --teardown  → remove the fixture (see the finalized-order caveat below).
 *
 *   npx tsx scripts/ps-499-step12-qa-fixture.ts
 *   npx tsx scripts/ps-499-step12-qa-fixture.ts --apply
 *   npx tsx scripts/ps-499-step12-qa-fixture.ts --teardown
 *
 * REFUSES TO RUN against anything but a loopback database. This writes billing
 * rows; pointing it at a shared or production DATABASE_URL would create real
 * client records. There is no --force.
 *
 * Touches only: a QA-named client, its orders/shipments/billing lines, QA-named
 * packages and that client's package prices and billing config. It never reads or
 * modifies another client's data, never calls a carrier, never regenerates billing
 * and never mutates an invoice.
 *
 * Expected arithmetic, so the operator can check the UI against fixed numbers:
 *   package_cost_markup = 10%
 *   QA BOX A  configured 5.00 → bills 5.50
 *   QA BOX B  configured 8.00 → bills 8.80
 *   QA BOX C  no configured price → a bulk import of it must 422
 */
import { sql } from '../src/db/client';

const APPLY = process.argv.includes('--apply');
const TEARDOWN = process.argv.includes('--teardown');

const CLIENT_NAME = 'PS-499 QA (disposable)';
const MARKUP = '10.00';

const BOX_A = 'PS499-QA BOX A 9x6x3';
const BOX_B = 'PS499-QA BOX B 12x10x3';
const BOX_C = 'PS499-QA BOX C 8x8x8 (unpriced)';

/** One order per scenario, so a mistake in one case cannot contaminate another. */
const SCENARIOS = [
  { order: 'PS499-QA-1', label: 'A · shipping-only, positive amount' },
  { order: 'PS499-QA-2', label: 'B · shipping-only, explicit $0' },
  { order: 'PS499-QA-3', label: 'C · box-only, different box (B → bills 8.80)' },
  { order: 'PS499-QA-4', label: 'D · box-only, SAME box already stamped (stale pin + review line)' },
  { order: 'PS499-QA-5', label: 'E · combined box + shipping' },
  { order: 'PS499-QA-6', label: 'F · blank cells must omit, not resend' },
  { order: 'PS499-QA-7', label: 'G · unpriced box → visible 422, row stays editable' },
  { order: 'PS499-QA-8', label: 'H · manual Edit Billing modal regression' },
  { order: 'PS499-QA-9', label: 'I · finalized/invoiced lockdown' },
] as const;

/** Baseline money on every fixture order, so "unchanged" is checkable by eye. */
const BASELINE = {
  pickPack: '3.50',
  additional: '0.75',
  packageCost: '5.50', // BOX A at 5.00 + 10%
  shipping: '12.00',
};

function assertLoopback(): void {
  const url = process.env.DATABASE_URL ?? '';
  if (!url) throw new Error('DATABASE_URL is not set');
  const host = new URL(url).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error(
      `Refusing to run: DATABASE_URL host is ${host}, not loopback. ` +
        'This fixture writes billing rows and must never touch a shared database.',
    );
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run with NODE_ENV=production');
  }
}

async function findClientId(): Promise<number | null> {
  const rows = await sql<{ id: number }[]>`select id from clients where name = ${CLIENT_NAME} limit 1`;
  return rows[0]?.id ?? null;
}

async function plan(): Promise<void> {
  const existing = await findClientId();
  console.log('PS-499 Step 12 QA fixture — PLAN (read-only, nothing written)\n');
  console.log(`client            : ${CLIENT_NAME}${existing ? ` (exists, id ${existing})` : ' (would be created)'}`);
  console.log(`billing config    : package_cost_markup = ${MARKUP}%`);
  console.log(`packages          : ${BOX_A} @ 5.00, ${BOX_B} @ 8.00, ${BOX_C} @ (no price)`);
  console.log(`baseline per order: pick&pack ${BASELINE.pickPack}, additional ${BASELINE.additional}, ` +
    `box ${BASELINE.packageCost}, shipping ${BASELINE.shipping}`);
  console.log('\norders:');
  for (const s of SCENARIOS) console.log(`  ${s.order.padEnd(12)} ${s.label}`);
  console.log('\nPS499-QA-4 additionally gets a stale box override_price of 99.00 and a');
  console.log('package_cost_missing review line, so the same-package import has something');
  console.log('real to clear.');
  console.log('PS499-QA-9 is marked invoiced, so the finalized lockdown actually fires.');
  console.log('\nRe-run with --apply to write it.');
}

async function apply(): Promise<void> {
  await sql.begin(async (tx) => {
    const [client] = await tx<{ id: number }[]>`
      insert into clients (name, active) values (${CLIENT_NAME}, true)
      on conflict do nothing returning id`;
    const clientId = client?.id ?? (await findClientId());
    if (!clientId) throw new Error('could not create or find the QA client');

    await tx`insert into billing_config (client_id, package_cost_markup)
      values (${clientId}, ${MARKUP})
      on conflict (client_id) do update set package_cost_markup = ${MARKUP}`;

    const packageIds: Record<string, number> = {};
    for (const [name, price] of [[BOX_A, '5.00'], [BOX_B, '8.00'], [BOX_C, null]] as const) {
      const [existing] = await tx<{ id: number }[]>`select id from packages where name = ${name} limit 1`;
      let id = existing?.id;
      if (!id) {
        const [created] = await tx<{ id: number }[]>`
          insert into packages (name, source) values (${name}, 'custom') returning id`;
        id = created!.id;
      }
      packageIds[name] = id;
      if (price) {
        await tx`insert into client_package_prices (client_id, package_id, price)
          values (${clientId}, ${id}, ${price}) on conflict do nothing`;
      }
    }

    for (const scenario of SCENARIOS) {
      const [order] = await tx<{ id: number }[]>`
        insert into orders (order_number) values (${scenario.order}) returning id`;
      const orderId = order!.id;
      const [shipment] = await tx<{ id: number }[]>`insert into shipments default values returning id`;
      const shipmentId = shipment!.id;
      const boxA = packageIds[BOX_A]!;

      for (const [lineType, description, amount] of [
        ['pick_pack', 'Pick & Pack', BASELINE.pickPack],
        ['additional_unit', 'Additional Units', BASELINE.additional],
        ['package_cost', `Box (${BOX_A})`, BASELINE.packageCost],
        ['shipping', 'Shipping', BASELINE.shipping],
      ] as const) {
        await tx`insert into billing_line_items
          (client_id, order_id, order_number, shipment_id, ship_date, line_type, description,
           qty, unit_cost, total_cost, package_id)
          values (${clientId}, ${orderId}, ${scenario.order}, ${shipmentId}, now(),
                  ${lineType}, ${description}, '1.00', ${amount}, ${amount}, ${boxA})`;
      }

      if (scenario.order === 'PS499-QA-4') {
        // A stale pinned price and a leftover review line, so the same-package
        // import has real state to clear rather than passing vacuously.
        await tx`insert into billing_box_resolutions (order_id, package_id, override_price, note)
          values (${orderId}, ${boxA}, '99.00', 'PS-499 QA stale pin')`;
        await tx`insert into billing_line_items
          (client_id, order_id, order_number, shipment_id, ship_date, line_type, description,
           qty, unit_cost, total_cost)
          values (${clientId}, ${orderId}, ${scenario.order}, ${shipmentId}, now(),
                  'package_cost_missing', 'No box cost', '1.00', '0.00', '0.00')`;
      }

      if (scenario.order === 'PS499-QA-9') {
        await tx`update billing_line_items set invoiced = true where order_id = ${orderId}`;
      }
    }

    console.log(`applied. QA client id = ${clientId}`);
  });
}

async function teardown(): Promise<void> {
  const clientId = await findClientId();
  if (!clientId) {
    console.log('nothing to remove — QA client not present');
    return;
  }
  const orders = await sql<{ id: number; order_number: string }[]>`
    select distinct order_id as id, order_number from billing_line_items where client_id = ${clientId}`;

  let blocked = 0;
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
      // The finalized scenario order is protected by the production
      // block-finalized-mutation trigger. That is correct behaviour, not a bug:
      // finalized billing is not deletable. Leave it and say so.
      blocked += 1;
    }
  }
  console.log(`removed billing rows for ${orders.length - blocked} QA order(s).`);
  if (blocked) {
    console.log(`${blocked} finalized QA order(s) left in place — finalized billing is ` +
      'immutable by design. Drop the local database if you need a clean slate.');
  }
  console.log('Audit rows are append-only and are deliberately not removed.');
}

async function main(): Promise<void> {
  assertLoopback();
  if (TEARDOWN) await teardown();
  else if (APPLY) await apply();
  else await plan();
  await sql.end({ timeout: 5 });
}

await main();
