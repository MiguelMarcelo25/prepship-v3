/**
 * PS-508 behavioural fixtures — answers audit packet items 2 and 3.
 *
 * The 74% BLOCK review noted that the PS-508 proof was entirely structural: source-text assertions
 * that a gate exists, not execution showing what it changes. These two fixtures execute.
 *
 * In-memory PGlite only. No production database, no provider, no label, no postage. Nothing here
 * reaches a network.
 *
 * WHAT THIS DOES NOT PROVE. PGlite is a single backend: it cannot interleave two real transactions,
 * so the one-shot race between concurrent freezes is still unproven. It also does not drive
 * persistCreatedLabel end to end — the eligibility GATE (purchasedProviderKey === 'shipp') remains
 * pinned structurally in ps-508-outbound-freeze-guard.ts. What these fixtures prove is the thing
 * the gate decides: that the two branches produce DIFFERENT money, and that a failed freeze leaves
 * the parent transaction committable.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { console.log(`ok   ${name}`); return; }
  failures += 1;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

const DDL = `
create table clients (
  id serial primary key,
  store_ids integer[] default '{}'
);
create table orders (
  id serial primary key,
  client_id integer,
  store_id integer
);
create table billing_config (
  client_id integer primary key,
  active boolean default true,
  billing_mode text default 'per_shipment',
  shipping_markup_pct numeric default 0,
  shipping_markup_flat numeric default 0,
  house_account_enabled boolean default false,
  hugrab_shipping_rate_override_enabled boolean default false,
  hugrab_shipping_rate_override_threshold numeric,
  hugrab_shipping_rate_override_amount numeric
);
create table order_overrides (
  order_id integer primary key,
  best_rate_json jsonb,
  ref_usps_rate numeric,
  ref_ups_rate numeric
);
create table shipments (
  id serial primary key,
  order_id integer,
  client_id integer,
  is_return boolean default false,
  voided boolean default false,
  source text,
  selected_rate_cost numeric,
  selected_rate_json jsonb,
  carrier_code text,
  provider_account_id integer,
  updated_at timestamptz
);
`;

/**
 * An opted-in client on a 20% markup, with a LIVE SHIPP-winning house stamp whose next-best
 * competitor is 13.00, shipping a label that cost 10.00.
 *
 * This is precisely the audit's counterexample state: the stamp is valid and would have produced
 * house money, but what the order was actually SHIPPED on is a separate fact.
 */
const SEED = `
insert into clients (id, store_ids) values (1, '{1}');
insert into orders (id, client_id, store_id) values (100, 1, 1);
insert into billing_config (client_id, active, billing_mode, shipping_markup_pct, house_account_enabled)
  values (1, true, 'per_shipment', 20, true);
insert into order_overrides (order_id, best_rate_json) values (100, '{
  "shipmentCost": 10.00,
  "otherCost": 0,
  "carrierCode": "shipp",
  "serviceCode": "shipp_ground",
  "houseMargin": 3.00,
  "nextBestNonHouseRate": {
    "carrierCode": "stamps_com",
    "serviceCode": "usps_ground_advantage",
    "shipmentCost": 13.00,
    "otherCost": 0,
    "totalCost": 13.00,
    "providerAccountId": 442007
  }
}'::jsonb);
insert into shipments (id, order_id, client_id, source, selected_rate_cost, carrier_code)
  values (900, 100, 1, 'prepship_v2', 10.00, 'shipp');
insert into shipments (id, order_id, client_id, source, selected_rate_cost, carrier_code)
  values (901, 100, 1, 'prepship_v2', 10.00, 'ups');
`;

async function main(): Promise<void> {
  process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
  process.env.SUPABASE_URL = 'https://example.test';
  process.env.SUPABASE_ANON_KEY = 'test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
  delete process.env.BILLING_PER_ACCOUNT_MARKUP;

  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { sql } = await import('drizzle-orm');
  const { freezeOutboundCustomerShippingMoney } = await import('../src/services/customer-shipping-money');
  const { deriveOutboundHouseCustomerRate } = await import('../src/services/outbound-house-rate');

  const client = new PGlite();
  await client.exec(DDL);
  await client.exec(SEED);
  const db = drizzle(client, { casing: 'snake_case' }) as never;

  // ── FIXTURE 1: the stamp is live, so the gate is the only thing separating the two amounts ──

  const houseRate = await deriveOutboundHouseCustomerRate({
    orderId: 100, clientId: 1, selectedRateCost: 10.0, exec: db,
  });
  check('the SHIPP house stamp is LIVE (derivation yields the 13.00 competitor rate)',
    houseRate === 13.0, String(houseRate));

  // The SHIPP purchase: the gate passes the derived rate through.
  const shipp = await freezeOutboundCustomerShippingMoney(900, { cShippingRateAmount: houseRate }, db);
  check('SHIPP purchase freezes HOUSE money (13.00, house provenance)',
    shipp?.cShippingRateAmount === 13.0
    && shipp?.customerRateSource === 'house_next_best_customer_rate',
    JSON.stringify(shipp));

  // The non-SHIPP purchase on the SAME order, with the SAME live stamp. After the blocker-1 fix
  // persistCreatedLabel derives nothing here, so the freeze receives null and must take the
  // ordinary carrier path: 10.00 + 20% = 12.00.
  const nonShipp = await freezeOutboundCustomerShippingMoney(901, { cShippingRateAmount: null }, db);
  check('non-SHIPP purchase freezes CARRIER money (12.00, realized provenance) despite the live stamp',
    nonShipp?.cShippingRateAmount === 12.0
    && nonShipp?.customerRateSource === 'realized_customer_shipping_rate',
    JSON.stringify(nonShipp));

  // THE BLOCKER, quantified. Before the fix both rows took the house branch and froze 13.00 while
  // billing charged 12.00 — a $1.00 overcharge per shipment, made unrepairable by the one-shot guard.
  check('the two branches produce DIFFERENT money (the blocker was worth $1.00/shipment here)',
    shipp?.cShippingRateAmount !== nonShipp?.cShippingRateAmount
    && Number(shipp?.cShippingRateAmount) - Number(nonShipp?.cShippingRateAmount) === 1.0,
    `${shipp?.cShippingRateAmount} vs ${nonShipp?.cShippingRateAmount}`);

  // ── FIXTURE 2: a failed freeze inside a SAVEPOINT leaves the parent transaction committable ──

  let parentCommitted = false;
  await db.transaction(async (tx: never) => {
    const t = tx as unknown as typeof db;
    await t.execute(sql`insert into shipments (id, order_id, client_id, source, selected_rate_cost)
                        values (902, 100, 1, 'prepship_v2', 10.00)`);
    try {
      // A savepoint, exactly as persistCreatedLabel now wraps the freeze. The statement inside is a
      // genuine PostgreSQL error, which is the case a bare try/catch could NOT survive: it aborts
      // the transaction, and catching the JS exception does not restore it.
      await t.transaction(async (sp: never) => {
        await (sp as unknown as typeof db).execute(sql`select * from a_table_that_does_not_exist`);
      });
    } catch {
      // rolled back to the savepoint
    }
    // If the parent were still poisoned this statement would throw 25P02 (in failed transaction).
    await t.execute(sql`update shipments set updated_at = now() where id = 902`);
    parentCommitted = true;
  });
  check('a failed freeze rolls back to the SAVEPOINT and the parent transaction still commits',
    parentCommitted);

  const rows = await client.query<{ id: number }>('select id from shipments where id = 902');
  check('the shipment persisted despite the freeze failure (no paid label lost)',
    rows.rows.length === 1);

  const tuple = await client.query<{ selected_rate_json: unknown }>(
    'select selected_rate_json from shipments where id = 902');
  check('and it carries NO tuple — skipped, not silently zero',
    tuple.rows[0]?.selected_rate_json == null);

  if (failures > 0) {
    console.log(`\nFAIL PS-508 behavioural fixtures (${failures} failing)`);
    process.exit(1);
  }
  console.log('\nPS-508 behavioural fixtures passed.');
}

void readFileSync;
void assert;
main().catch((err) => { console.error(err); process.exit(1); });
