/**
 * PS-508 — smoke proof for the canary evidence packet (schema v2), against real PostgreSQL.
 *
 * The round-3 audit refused to bless the v1 packet because its false-green paths were
 * unproven-against: zero-row HOLDS, missing cohorts, zero-exit on incomplete comparison,
 * legacy self-validation, a weaker handwritten Portal mirror, noncanonical cents, and an
 * unproven read-only claim. Each of those is a CASE here, executed by spawning the real
 * packet tool as a subprocess against seeded disposable databases and asserting BOTH the
 * verdict in the JSON and the process exit code.
 *
 * UNSKIPPABLE: absent PS508_PG17_ADMIN_URL this FAILS rather than skipping.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';

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
function ok(name: string): void { console.log('ok   ' + name); }
function fail(name: string, detail: string): void { failures += 1; console.log('FAIL ' + name + ' — ' + detail); }

// The packet reads exactly three tables; a minimal hand schema keeps each case surgical.
const SCHEMA = `
  create table orders (
    id serial primary key, order_number text not null, client_id integer,
    externally_shipped boolean default false, raw jsonb
  );
  create table shipments (
    id serial primary key, order_id integer, client_id integer, ship_date timestamptz,
    voided boolean default false, is_return boolean default false, source text,
    selected_rate_json jsonb
  );
  create table billing_line_items (
    id serial primary key, client_id integer, shipment_id integer, line_type text,
    description text, unit_cost numeric(10,2), total_cost numeric(10,2),
    invoiced boolean default false
  );
`;

let dbSeq = 0;
async function freshDb(): Promise<{ url: string; db: postgres.Sql; name: string }> {
  dbSeq += 1;
  const name = 'ps508_pkt_smoke_' + process.pid + '_' + dbSeq;
  const a = postgres(ADMIN_URL as string, { max: 1, prepare: false, onnotice: () => {} });
  await a.unsafe('drop database if exists ' + name);
  await a.unsafe('create database ' + name);
  await a.end({ timeout: 5 });
  const u = new URL(ADMIN_URL as string);
  u.pathname = '/' + name;
  const db = postgres(u.toString(), { max: 1, prepare: false, onnotice: () => {} });
  await db.unsafe(SCHEMA);
  return { url: u.toString(), db, name };
}
async function dropDb(name: string): Promise<void> {
  const a = postgres(ADMIN_URL as string, { max: 1, prepare: false, onnotice: () => {} });
  await a.unsafe("select pg_terminate_backend(pid) from pg_stat_activity where datname='" + name + "' and pid <> pg_backend_pid()").catch(() => {});
  await a.unsafe('drop database if exists ' + name).catch(() => {});
  await a.end({ timeout: 5 });
}

const CLIENT = 7001;
const BOUNDARY = '2026-06-01T00:00:00Z';
const T508 = (amount: number, suffix = ' (20%)') => ({
  selectedRateCost: 10, cShippingRateAmount: amount,
  shippingMarginAmount: Number((amount - 10).toFixed(2)), shippingMarginPct: null,
  rateCostSource: 'label_final_cost', customerRateSource: 'realized_customer_shipping_rate',
  billingDescriptionSuffix: suffix, customerShippingMoneyPolicyVersion: 'ps-508-v1',
});
const T509 = (amount: number) => ({
  selectedRateCost: 8, cShippingRateAmount: amount,
  shippingMarginAmount: Number((amount - 8).toFixed(2)), shippingMarginPct: null,
  rateCostSource: 'shipstation_sync_receipt_cost',
  customerRateSource: 'carrier_markup_customer_shipping_rate',
  billingDescriptionSuffix: ' (sync)', customerShippingMoneyPolicyVersion: 'ps-509-v1',
  customerShippingMoneyCaptureSource: 'shipstation_sync_ingestion',
});
const HOUSE = (amount: number) => ({
  ...T508(amount), customerRateSource: 'house_next_best_customer_rate',
});
const RECEIPT = { carrierCode: 'ups', cost: 10, totalCost: 10, providerLabelId: 'x' };

type Seed = {
  shipDate: string; json: unknown; voided?: boolean; isReturn?: boolean; ext?: boolean;
  line?: { type: string; amt: string; desc: string } | Array<{ type: string; amt: string; desc: string }>;
};
async function seed(db: postgres.Sql, seeds: Seed[]): Promise<void> {
  let n = 0;
  for (const s of seeds) {
    n += 1;
    const [o] = await db.unsafe(
      "insert into orders (order_number, client_id, externally_shipped, raw) values ($1, $2, $3, '{}'::jsonb) returning id",
      ['SMK-' + n, CLIENT, s.ext ?? false],
    );
    const [sh] = await db.unsafe(
      'insert into shipments (order_id, client_id, ship_date, voided, is_return, source, selected_rate_json) '
      + "values ($1, $2, $3, $4, $5, 'smoke', $6::text::jsonb) returning id",
      [(o as unknown as { id: number }).id, CLIENT, s.shipDate, s.voided ?? false, s.isReturn ?? false,
        s.json == null ? null : JSON.stringify(s.json)],
    );
    const lines = Array.isArray(s.line) ? s.line : s.line ? [s.line] : [];
    for (const l of lines) {
      await db.unsafe(
        'insert into billing_line_items (client_id, shipment_id, line_type, description, unit_cost, total_cost) '
        + 'values ($1, $2, $3, $4, $5, $5)',
        [CLIENT, (sh as unknown as { id: number }).id, l.type, l.desc, l.amt],
      );
    }
  }
}

const FULL_WAIVERS = [
  '--waive', 'insurance_adjusted_final_cost:smoke fixture has no insurance leg',
  '--waive', 'markup_changed_after_purchase:smoke fixture cannot mutate config',
  '--waive', 'direct_carrier_purchase:smoke fixture has no direct-carrier row',
];
function runPacket(dbUrl: string, extra: string[]): { code: number; packet: Record<string, unknown> | null; stderr: string } {
  const out = path.join(os.tmpdir(), 'ps508-pkt-' + process.pid + '-' + (++dbSeq) + '.json');
  const r = spawnSync('npx', ['tsx', 'scripts/ps-508-canary-evidence-packet.ts',
    '--client', String(CLIENT), '--from', '2026-05-01', '--to', '2026-08-01', '--out', out, ...extra],
  { shell: true, encoding: 'utf8', timeout: 300_000, env: { ...process.env, PS508_PACKET_DATABASE_URL: dbUrl } });
  let packet: Record<string, unknown> | null = null;
  try { packet = JSON.parse(fs.readFileSync(out, 'utf8')); fs.unlinkSync(out); } catch { /* no packet */ }
  return { code: r.status ?? 1, packet, stderr: (r.stderr ?? '') + (r.stdout ?? '') };
}

/** The full derivable-cohort population every PASS-shaped case builds on. */
const HAPPY: Seed[] = [
  { shipDate: '2026-07-10T12:00:00Z', json: T508(25.5),
    line: { type: 'shipping', amt: '25.50', desc: 'Shipping (20%) · order SMK-1 · shipment #1' } },
  { shipDate: '2026-07-11T12:00:00Z', json: T509(12),
    line: { type: 'shipping', amt: '12.00', desc: 'Shipping (sync) · order SMK-2 · shipment #2' } },
  { shipDate: '2026-07-12T12:00:00Z', json: HOUSE(31),
    line: { type: 'shipping', amt: '31.00', desc: 'Shipping (20%) · order SMK-3 · shipment #3' } },
  { shipDate: '2026-07-13T12:00:00Z', json: RECEIPT,
    line: { type: 'shipping_missing', amt: '0.00', desc: 'Customer shipping money needs review (post_cutover_shipment_missing_frozen_tuple) - order SMK-4' } },
  { shipDate: '2026-05-15T12:00:00Z', json: RECEIPT,
    line: { type: 'shipping', amt: '10.00', desc: 'Shipping · order SMK-5 · shipment #5' } },
  { shipDate: '2026-07-14T12:00:00Z', json: T508(11), voided: true },
  { shipDate: '2026-07-15T12:00:00Z', json: null, isReturn: true },
  { shipDate: '2026-07-16T12:00:00Z', json: null, ext: true },
];
// multi_shipment: give SMK-1's order a second non-voided shipment
async function addSecondShipment(db: postgres.Sql): Promise<void> {
  await db.unsafe(
    'insert into shipments (order_id, client_id, ship_date, source, selected_rate_json) '
    + "select order_id, client_id, '2026-07-10T13:00:00Z', 'smoke', $1::text::jsonb from shipments where id = 1",
    [JSON.stringify(T508(5.5))],
  );
  await db.unsafe(
    "insert into billing_line_items (client_id, shipment_id, line_type, description, unit_cost, total_cost) "
    + "values ($1, (select max(id) from shipments), 'shipping', 'Shipping (20%) · order SMK-1 · shipment #9', 5.50, 5.50)",
    [CLIENT],
  );
}

async function main(): Promise<void> {
  // ---- 1. read-only is REAL: a deliberate write under the packet's exact connection fails --
  {
    const { url, db, name } = await freshDb();
    const probe = postgres(url, { max: 1, prepare: false, onnotice: () => {},
      connection: { default_transaction_read_only: true } });
    const [ro] = await probe.unsafe('show default_transaction_read_only');
    const roOn = (ro as Record<string, string>).default_transaction_read_only === 'on';
    let writeFailed = false; let code = '';
    try { await probe.unsafe("insert into orders (order_number) values ('should-never-land')"); }
    catch (e) { writeFailed = true; code = String((e as { code?: string }).code ?? e); }
    const [cnt] = await db.unsafe('select count(*)::int as n from orders');
    if (roOn && writeFailed && (cnt as unknown as { n: number }).n === 0) {
      ok('read-only is server-enforced: SHOW=on and a deliberate INSERT fails (' + code + ') leaving zero rows');
    } else {
      fail('read-only is server-enforced', 'SHOW=' + JSON.stringify(ro) + ' writeFailed=' + writeFailed + ' rows=' + (cnt as unknown as { n: number }).n);
    }
    await probe.end({ timeout: 5 }); await db.end({ timeout: 5 }); await dropDb(name);
  }

  // ---- 2. zero rows must NOT pass ------------------------------------------------------------
  {
    const { url, db, name } = await freshDb();
    const r = runPacket(url, ['--boundary', BOUNDARY, ...FULL_WAIVERS]);
    if (r.code !== 0 && r.packet?.verdict === 'INCOMPLETE'
        && String((r.packet?.failures as string[]).join()).includes('zero eligible')) {
      ok('zero eligible rows -> INCOMPLETE, nonzero exit (no zero-row HOLDS)');
    } else fail('zero eligible rows -> INCOMPLETE, nonzero exit', 'code=' + r.code + ' verdict=' + r.packet?.verdict);
    await db.end({ timeout: 5 }); await dropDb(name);
  }

  // ---- 3. the full derivable population PASSES with waivers... ------------------------------
  {
    const { url, db, name } = await freshDb();
    await seed(db, HAPPY); await addSecondShipment(db);
    const r = runPacket(url, ['--boundary', BOUNDARY, ...FULL_WAIVERS]);
    const legacyRow = (r.packet?.shadow as Array<Record<string, unknown>>)?.find((s) => s.verdict === 'OBSERVED-LEGACY');
    if (r.code === 0 && r.packet?.verdict === 'PASS' && legacyRow) {
      ok('full population + waivers -> PASS, and the legacy row is OBSERVED-LEGACY, never MATCH');
    } else fail('full population + waivers -> PASS with OBSERVED-LEGACY', 'code=' + r.code + ' verdict=' + r.packet?.verdict + ' legacy=' + JSON.stringify(legacyRow));
    // ---- 4. ...and the SAME population FAILS without the waivers (missing cohorts bite) ------
    const r2 = runPacket(url, ['--boundary', BOUNDARY]);
    if (r2.code !== 0 && r2.packet?.verdict === 'INCOMPLETE'
        && String((r2.packet?.failures as string[]).join()).includes('insurance_adjusted_final_cost')) {
      ok('missing non-derivable cohorts without waivers -> INCOMPLETE, nonzero exit');
    } else fail('missing cohorts -> INCOMPLETE', 'code=' + r2.code + ' verdict=' + r2.packet?.verdict);
    await db.end({ timeout: 5 }); await dropDb(name);
  }

  // ---- 5. an unbilled row is NOT-YET-COMPARED and fails the packet ---------------------------
  {
    const { url, db, name } = await freshDb();
    await seed(db, [...HAPPY, { shipDate: '2026-07-17T12:00:00Z', json: T508(19.99) }]);
    await addSecondShipment(db);
    const r = runPacket(url, ['--boundary', BOUNDARY, ...FULL_WAIVERS]);
    if (r.code !== 0 && r.packet?.verdict === 'INCOMPLETE'
        && (r.packet?.counts as Record<string, number>).notYetComparedRows === 1) {
      ok('an unbilled row -> NOT-YET-COMPARED -> INCOMPLETE, nonzero exit');
    } else fail('unbilled row fails the packet', 'code=' + r.code + ' verdict=' + r.packet?.verdict);
    await db.end({ timeout: 5 }); await dropDb(name);
  }

  // ---- 6. a numeric-STRING tuple: Billing coerces, the real Portal SQL rejects ---------------
  {
    const { url, db, name } = await freshDb();
    const stringy = { ...T508(21), cShippingRateAmount: '21' };
    await seed(db, [...HAPPY, { shipDate: '2026-07-18T12:00:00Z', json: stringy,
      line: { type: 'shipping', amt: '21.00', desc: 'Shipping (20%) · order SMK-9 · shipment #9' } }]);
    await addSecondShipment(db);
    const r = runPacket(url, ['--boundary', BOUNDARY, ...FULL_WAIVERS]);
    const row = (r.packet?.shadow as Array<Record<string, unknown>>)?.find((s) =>
      Array.isArray(s.detail) && (s.detail as string[]).some((d) => d.includes('portal-rejects-frozen')));
    if (r.code !== 0 && r.packet?.verdict === 'VIOLATED' && row) {
      ok('numeric-string tuple -> Billing frozen but the REAL Portal SQL rejects -> portal-rejects-frozen MISMATCH');
    } else fail('numeric-string tuple direction check', 'code=' + r.code + ' verdict=' + r.packet?.verdict);
    await db.end({ timeout: 5 }); await dropDb(name);
  }

  // ---- 7. half-cent: canonical roundMoney ties-away agrees with a 1.01 billed line -----------
  {
    const { url, db, name } = await freshDb();
    const half = { ...T508(1.005), shippingMarginAmount: -9.0 }; // margin = 1.005 - 10 rounds to -9.00
    await seed(db, [...HAPPY, { shipDate: '2026-07-19T12:00:00Z', json: half,
      line: { type: 'shipping', amt: '1.01', desc: 'Shipping (20%) · order SMK-9 · shipment #9' } }]);
    await addSecondShipment(db);
    const r = runPacket(url, ['--boundary', BOUNDARY, ...FULL_WAIVERS]);
    if (r.code === 0 && r.packet?.verdict === 'PASS') {
      ok('1.005 tuple vs 1.01 billed -> MATCH under canonical roundMoney (Math.round would have mismatched)');
    } else fail('half-cent canonical rounding', 'code=' + r.code + ' verdict=' + r.packet?.verdict
      + ' failures=' + JSON.stringify(r.packet?.failures));
    await db.end({ timeout: 5 }); await dropDb(name);
  }

  // ---- 8. duplicate lines + wrong line type each mismatch, counted ONCE per shipment ---------
  {
    const { url, db, name } = await freshDb();
    await seed(db, [...HAPPY,
      { shipDate: '2026-07-20T12:00:00Z', json: T508(40), line: [
        { type: 'shipping', amt: '40.00', desc: 'dup A' },
        { type: 'shipping', amt: '40.00', desc: 'dup B' },
      ] },
      { shipDate: '2026-07-21T12:00:00Z', json: T508(50),
        line: { type: 'shipping_missing', amt: '0.00', desc: 'wrong type' } },
    ]);
    await addSecondShipment(db);
    const r = runPacket(url, ['--boundary', BOUNDARY, ...FULL_WAIVERS]);
    const mm = (r.packet?.counts as Record<string, number>).mismatchShipments;
    if (r.code !== 0 && r.packet?.verdict === 'VIOLATED' && mm === 2) {
      ok('duplicate lines + wrong line type -> exactly 2 mismatching shipments (once each, despite multiple defects)');
    } else fail('duplicate/wrong-type counted once per shipment', 'code=' + r.code + ' mismatchShipments=' + mm);
    await db.end({ timeout: 5 }); await dropDb(name);
  }

  // ---- 9. activation mode: identity gates ----------------------------------------------------
  {
    const { url, db, name } = await freshDb();
    await seed(db, HAPPY); await addSecondShipment(db);
    const bare = runPacket(url, ['--boundary', BOUNDARY, '--mode', 'activation', ...FULL_WAIVERS]);
    if (bare.code !== 0 && bare.stderr.includes('env-clients-readback')) {
      ok('activation without operator readbacks refuses to run');
    } else fail('activation requires operator readbacks', 'code=' + bare.code);
    const stale = runPacket(url, ['--boundary', BOUNDARY, '--mode', 'activation', ...FULL_WAIVERS,
      '--env-clients-readback', String(CLIENT), '--env-boundary-readback', BOUNDARY,
      '--readback-at', '2026-08-24T00:00:00Z', '--api-sha', 'aaa', '--worker-sha', 'aaa',
      '--portal-sha', '0000000deadbeef']);
    if (stale.code !== 0 && stale.stderr.includes('PORTAL-MIRROR-STALE')) {
      ok('activation with a Portal SHA that does not match the embedded mirror fails PORTAL-MIRROR-STALE');
    } else fail('stale portal mirror refused', 'code=' + stale.code);
    const good = runPacket(url, ['--boundary', BOUNDARY, '--mode', 'activation', ...FULL_WAIVERS,
      '--env-clients-readback', String(CLIENT), '--env-boundary-readback', BOUNDARY,
      '--readback-at', '2026-08-24T00:00:00Z', '--api-sha', 'aaa', '--worker-sha', 'aaa',
      '--portal-sha', 'd447d89000000']);
    if (good.code === 0 && good.packet?.verdict === 'PASS') {
      ok('activation with complete matching identity + waivers + clean population -> PASS');
    } else fail('activation happy path', 'code=' + good.code + ' verdict=' + good.packet?.verdict
      + ' failures=' + JSON.stringify(good.packet?.failures));
    await db.end({ timeout: 5 }); await dropDb(name);
  }

  console.log(failures === 0 ? '\nPASS' : '\n' + failures + ' FAILED');
  process.exit(failures === 0 ? 0 : 1);
}

void main();
