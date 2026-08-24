/**
 * PS-508 — the frozen customer-money tuple survives REAL PostgreSQL, and Billing's decision is
 * taken from what the database actually holds.
 *
 * The pure guards build tuples as JavaScript object literals. That proves the RULE but not the
 * ROUND TRIP, and the round trip is where this class of bug lives: JSONB returns numerics as JS
 * numbers only when they were written as numbers, `timestamptz` comes back shifted if the
 * comparison is naive about zones, and an absent key is not the same value as a null one. If a
 * persisted tuple failed to classify, every shipment would silently route to review in
 * production while every pure guard stayed green — the exact shape of the PS-497 failure this
 * ticket already cites.
 *
 * UNSKIPPABLE: absent PS508_PG17_ADMIN_URL this FAILS. It never skips.
 */
import postgres from 'postgres';
import { decideBillableShippingMoney } from '../src/services/customer-shipping-money-billable-decision.js';
import {
  resolveCutoverBoundary,
  isAfterCutover,
} from '../src/services/customer-shipping-money-cutover-gate.js';
import {
  ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS,
  CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_OUTBOUND,
} from '../src/services/customer-shipping-money-snapshot.js';

const ADMIN_URL = process.env.PS508_PG17_ADMIN_URL;
if (!ADMIN_URL) {
  console.error('FAIL: PS508_PG17_ADMIN_URL is not set. This proof is unskippable.');
  process.exit(1);
}
{
  const host = new URL(ADMIN_URL).hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1', 'postgres'].includes(host)) {
    console.error('FAIL: refusing non-ephemeral host "' + host + '"');
    process.exit(1);
  }
}

let failures = 0;
let counter = 0;
const accept = ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS;

const SCHEMA =
  'create table public.shipments (' +
  '  id serial primary key,' +
  '  ship_date timestamptz,' +
  '  selected_rate_json jsonb' +
  ');';

const admin = () => postgres(ADMIN_URL as string, { max: 1, prepare: false, onnotice: () => {} });

async function fresh(): Promise<{ name: string; db: postgres.Sql }> {
  counter += 1;
  const name = 'ps508_tuple_' + process.pid + '_' + counter;
  const a = admin();
  try {
    await a.unsafe('drop database if exists ' + name);
    await a.unsafe('create database ' + name);
  } finally {
    await a.end({ timeout: 5 });
  }
  const url = new URL(ADMIN_URL as string);
  url.pathname = '/' + name;
  const db = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
  await db.unsafe(SCHEMA);
  return { name, db };
}

async function drop(name: string): Promise<void> {
  const a = admin();
  try {
    await a.unsafe(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname='" +
        name +
        "' and pid <> pg_backend_pid()",
    );
    await a.unsafe('drop database if exists ' + name);
  } finally {
    await a.end({ timeout: 5 });
  }
}

async function check(name: string, fn: (db: postgres.Sql) => Promise<void>): Promise<void> {
  const { name: dbName, db } = await fresh();
  try {
    await fn(db);
    console.log('ok   ' + name);
  } catch (error) {
    failures += 1;
    console.error('FAIL ' + name + ': ' + (error instanceof Error ? error.message : String(error)));
  } finally {
    await db.end({ timeout: 5 }).catch(() => {});
    await drop(dbName).catch(() => {});
  }
}

function must(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** A spy recalculator — for a frozen row it must never fire. */
function spy(v: { amount: number; descriptionSuffix: string } = { amount: 999, descriptionSuffix: ' (LEGACY)' }) {
  let calls = 0;
  return { fn: () => { calls += 1; return v; }, calls: () => calls };
}

/** The tuple exactly as freezeOutboundCustomerShippingMoney writes it. */
const OUTBOUND_TUPLE = {
  selectedRateCost: 10.25,
  cShippingRateAmount: 12.55,
  shippingMarginAmount: 2.3,
  shippingMarginPct: 18.33,
  rateCostSource: 'label_final_cost',
  customerRateSource: 'realized_customer_shipping_rate',
  billingDescriptionSuffix: ' (20% + $1.00)',
  customerShippingMoneyPolicyVersion: CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_OUTBOUND,
};

async function main(): Promise<void> {
  // Version gate: prod and CI are PostgreSQL 17. Never let this silently prove nothing on an
  // ancient server; 18+ is allowed so the same proof runs on a developer box.
  {
    const a = admin();
    const rows = await a.unsafe("select current_setting('server_version_num') as v");
    await a.end({ timeout: 5 });
    const num = Number((rows[0] as { v: string }).v);
    console.log('server_version_num = ' + num);
    if (!Number.isFinite(num) || num < 170000) {
      console.error('FAIL: refusing to prove against server_version_num ' + num + ' (need >= 170000)');
      process.exit(1);
    }
  }

  await check('a persisted outbound tuple classifies VALID and bills the frozen amount', async (db) => {
    await db`insert into shipments (ship_date, selected_rate_json) values (now(), ${db.json(OUTBOUND_TUPLE as never)})`;
    const rows = await db`select selected_rate_json from shipments limit 1`;
    const s = spy();
    const d = decideBillableShippingMoney({
      selectedRateJson: (rows[0] as Record<string, unknown>).selected_rate_json,
      accept,
      recompute: s.fn,
    });
    must(d.source === 'frozen', 'round-tripped tuple did not classify frozen: ' + d.source);
    must(d.source === 'frozen' && d.value.amount === 12.55, 'amount drifted through JSONB');
    must(
      d.source === 'frozen' && d.value.descriptionSuffix === ' (20% + $1.00)',
      'description suffix drifted through JSONB',
    );
    must(s.calls() === 0, 'the legacy recalculator fired for a frozen row');
  });

  await check('JSONB numeric round trip does not turn money into strings', async (db) => {
    await db`insert into shipments (selected_rate_json) values (${db.json(OUTBOUND_TUPLE as never)})`;
    const rows = await db`select selected_rate_json from shipments limit 1`;
    const raw = (rows[0] as Record<string, unknown>).selected_rate_json as Record<string, unknown>;
    must(typeof raw.cShippingRateAmount === 'number', 'cShippingRateAmount came back as ' + typeof raw.cShippingRateAmount);
    must(typeof raw.selectedRateCost === 'number', 'selectedRateCost came back as ' + typeof raw.selectedRateCost);
  });

  await check('NULL selected_rate_json is legacy_absent and recomputes', async (db) => {
    await db`insert into shipments (ship_date, selected_rate_json) values (now(), null)`;
    const rows = await db`select selected_rate_json from shipments limit 1`;
    const s = spy({ amount: 31, descriptionSuffix: ' (10%)' });
    const d = decideBillableShippingMoney({
      selectedRateJson: (rows[0] as Record<string, unknown>).selected_rate_json,
      accept,
      recompute: s.fn,
    });
    must(d.source === 'legacy_recompute', 'NULL json should be legacy, got ' + d.source);
    must(s.calls() === 1, 'legacy row did not consult the recalculator');
  });

  await check('a real carrier receipt with no tuple is legacy_absent, not malformed', async (db) => {
    const receipt = {
      carrierCode: 'ups',
      serviceCode: 'ups_ground',
      cost: 10.25,
      totalCost: 10.25,
      providerLabelId: 'lbl_1',
    };
    await db`insert into shipments (selected_rate_json) values (${db.json(receipt as never)})`;
    const rows = await db`select selected_rate_json from shipments limit 1`;
    const s = spy();
    const d = decideBillableShippingMoney({
      selectedRateJson: (rows[0] as Record<string, unknown>).selected_rate_json,
      accept,
      recompute: s.fn,
    });
    must(d.source === 'legacy_recompute', 'receipt-only should be legacy, got ' + d.source);
  });

  // A NUMERIC string is tolerated on purpose (the reader coerces through finiteNumber), so a
  // serialization variant does not strand real money. What must never happen is the string
  // itself reaching the invoice: billing feeds this straight into roundMoney(...).toFixed(2),
  // and a string there would produce a wrong line rather than an error.
  await check('a numeric STRING amount is coerced to a real number, never passed through', async (db) => {
    const stringy = { ...OUTBOUND_TUPLE, cShippingRateAmount: '12.55' };
    await db`insert into shipments (selected_rate_json) values (${db.json(stringy as never)})`;
    const rows = await db`select selected_rate_json from shipments limit 1`;
    const s = spy();
    const d = decideBillableShippingMoney({
      selectedRateJson: (rows[0] as Record<string, unknown>).selected_rate_json,
      accept,
      recompute: s.fn,
    });
    must(d.source === 'frozen', 'a numeric string should still be billable frozen; got ' + d.source);
    must(
      d.source === 'frozen' && typeof d.value.amount === 'number',
      'a STRING leaked into the billed amount: ' + JSON.stringify(d.source === 'frozen' ? d.value.amount : null),
    );
    must(d.source === 'frozen' && d.value.amount === 12.55, 'coercion produced the wrong number');
    must(s.calls() === 0, 'a frozen row consulted the recalculator');
  });

  await check('a NON-numeric amount fails closed to review, never coerced to NaN money', async (db) => {
    const bad = { ...OUTBOUND_TUPLE, cShippingRateAmount: '1,255.00 USD' };
    await db`insert into shipments (selected_rate_json) values (${db.json(bad as never)})`;
    const rows = await db`select selected_rate_json from shipments limit 1`;
    const s = spy();
    const d = decideBillableShippingMoney({
      selectedRateJson: (rows[0] as Record<string, unknown>).selected_rate_json,
      accept,
      recompute: s.fn,
    });
    must(d.source === 'review', 'unparseable money must be held; got ' + d.source);
    must(s.calls() === 0, 'a malformed tuple silently recomputed');
  });

  // The timestamptz leg: a boundary comparison naive about zones would place shipments on the
  // wrong side of the cutover, which decides whether money is billed or held.
  await check('timestamptz ship_date lands on the correct side of the cutover boundary', async (db) => {
    await db`insert into shipments (ship_date, selected_rate_json) values ('2026-07-31T23:59:59Z', null), ('2026-08-01T00:00:01Z', null), (null, null)`;
    const rows = (await db`select id, ship_date from shipments order by id`) as unknown as Array<Record<string, unknown>>;
    const B = resolveCutoverBoundary('2026-08-01T00:00:00Z');
    must(isAfterCutover(B, rows[0].ship_date as Date) === false, 'a pre-boundary row was treated as post-cutover');
    must(isAfterCutover(B, rows[1].ship_date as Date) === true, 'a post-boundary row was treated as pre-cutover');
    must(isAfterCutover(B, rows[2].ship_date as Date) === true, 'a NULL ship_date must fail closed to post-cutover');
  });

  await check('post-cutover row with no tuple is HELD, never repriced', async (db) => {
    await db`insert into shipments (ship_date, selected_rate_json) values ('2026-08-02T12:00:00Z', null)`;
    const rows = (await db`select ship_date, selected_rate_json from shipments limit 1`) as unknown as Array<Record<string, unknown>>;
    const s = spy();
    const d = decideBillableShippingMoney({
      selectedRateJson: rows[0].selected_rate_json,
      accept,
      recompute: s.fn,
      afterCutover: isAfterCutover(resolveCutoverBoundary('2026-08-01T00:00:00Z'), rows[0].ship_date as Date),
    });
    must(d.source === 'review', 'post-cutover missing tuple should be held, got ' + d.source);
    must(s.calls() === 0, 'a post-cutover freeze failure silently recomputed');
  });

  console.log(failures === 0 ? '\nPASS' : '\n' + failures + ' FAILED');
  process.exit(failures === 0 ? 0 : 1);
}

void main();
