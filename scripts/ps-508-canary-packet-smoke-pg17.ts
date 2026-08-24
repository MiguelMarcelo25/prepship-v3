/**
 * PS-508 — smoke proof for the canary evidence packet (schema v2), against real PostgreSQL.
 *
 * Round-4 additions: the decisive case — an eligible post-boundary shipment whose tuple is
 * missing but whose $0 hold is CORRECT must yield INCOMPLETE, never PASS (a correctly-reported
 * hole is still a hole); waivers are refused for derivable cohorts and blank reasons; and
 * activation identity is BOUND — 40-hex SHAs, toolGitSha == api-sha == worker-sha, and a live
 * /health whose commitSha must equal the attested SHA (served here by a local stub).
 *
 * UNSKIPPABLE: absent PS508_PG17_ADMIN_URL this FAILS rather than skipping.
 */
import { spawn, spawnSync, execSync, type ChildProcess } from 'node:child_process';
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

const REPO_SHA = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
const PORTAL_SHA_GOOD = 'd447d89' + 'a'.repeat(33); // 40-hex, matches the embedded mirror ref
const PORTAL_SHA_STALE = 'e'.repeat(40);            // 40-hex, does NOT match the mirror ref

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

type SeedLine = { type: string; amt: string; desc: string };
type Seed = {
  shipDate: string; json: unknown; voided?: boolean; isReturn?: boolean; ext?: boolean;
  line?: SeedLine | SeedLine[];
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
const failuresOf = (p: Record<string, unknown> | null): string =>
  Array.isArray(p?.failures) ? (p!.failures as string[]).join(' | ') : '';

/**
 * The PASS-shaped population. Round-4: it contains NO post-boundary row without a tuple —
 * the previous HAPPY deliberately included one and expected PASS, which the audit correctly
 * refuted. Coverage of the hold path lives in its own case below, which must NOT pass.
 */
const HAPPY: Seed[] = [
  { shipDate: '2026-07-10T12:00:00Z', json: T508(25.5),
    line: { type: 'shipping', amt: '25.50', desc: 'Shipping (20%) · order SMK-1 · shipment #1' } },
  { shipDate: '2026-07-11T12:00:00Z', json: T509(12),
    line: { type: 'shipping', amt: '12.00', desc: 'Shipping (sync) · order SMK-2 · shipment #2' } },
  { shipDate: '2026-07-12T12:00:00Z', json: HOUSE(31),
    line: { type: 'shipping', amt: '31.00', desc: 'Shipping (20%) · order SMK-3 · shipment #3' } },
  { shipDate: '2026-05-15T12:00:00Z', json: RECEIPT,
    line: { type: 'shipping', amt: '10.00', desc: 'Shipping · order SMK-4 · shipment #4' } },
  { shipDate: '2026-07-14T12:00:00Z', json: T508(11), voided: true },
  { shipDate: '2026-07-15T12:00:00Z', json: null, isReturn: true },
  { shipDate: '2026-07-16T12:00:00Z', json: null, ext: true },
];
const HOLD_ROW: Seed = {
  shipDate: '2026-07-13T12:00:00Z', json: RECEIPT,
  line: { type: 'shipping_missing', amt: '0.00', desc: 'Customer shipping money needs review (post_cutover_shipment_missing_frozen_tuple) - order SMK-8' },
};
// multi_shipment: give SMK-1's order a second matched frozen shipment
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

/** A stub /health server whose commitSha is controllable — activation identity binding needs it. */
function startHealthStub(commitSha: string): Promise<{ url: string; child: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const script = 'const http=require("http");const s=http.createServer((q,r)=>{r.setHeader("content-type","application/json");'
      + 'r.end(JSON.stringify({status:"ok",runtime:{commitSha:process.argv[1]}}))});'
      + 's.listen(0,"127.0.0.1",()=>console.log("PORT="+s.address().port));';
    const child = spawn(process.execPath, ['-e', script, commitSha], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      const m = /PORT=(\d+)/.exec(buf);
      if (m) resolve({ url: 'http://127.0.0.1:' + m[1], child });
    });
    child.on('error', reject);
    setTimeout(() => reject(new Error('health stub did not start')), 10_000);
  });
}

async function main(): Promise<void> {
  // ---- 1. read-only is REAL: a deliberate write under the packet's exact connection fails --
  {
    const { url, db, name } = await freshDb();
    const probe = postgres(url, { max: 1, prepare: false, onnotice: () => {},
      connection: { default_transaction_read_only: true } });
    const [ro] = await probe.unsafe('show default_transaction_read_only');
    const roOn = (ro as unknown as Record<string, string>).default_transaction_read_only === 'on';
    let writeFailed = false; let code = '';
    try { await probe.unsafe("insert into orders (order_number) values ('should-never-land')"); }
    catch (e) { writeFailed = true; code = String((e as { code?: string }).code ?? e); }
    const [cnt] = await db.unsafe('select count(*)::int as n from orders');
    if (roOn && writeFailed && (cnt as unknown as { n: number }).n === 0) {
      ok('read-only is server-enforced: SHOW=on and a deliberate INSERT fails (' + code + ') leaving zero rows');
    } else {
      fail('read-only is server-enforced', 'SHOW=' + JSON.stringify(ro) + ' writeFailed=' + writeFailed);
    }
    await probe.end({ timeout: 5 }); await db.end({ timeout: 5 }); await dropDb(name);
  }

  // ---- 2. zero rows must NOT pass ------------------------------------------------------------
  {
    const { url, db, name } = await freshDb();
    const r = runPacket(url, ['--boundary', BOUNDARY, ...FULL_WAIVERS]);
    if (r.code !== 0 && r.packet?.verdict === 'INCOMPLETE' && failuresOf(r.packet).includes('zero eligible')) {
      ok('zero eligible rows -> INCOMPLETE, nonzero exit (no zero-row PASS)');
    } else fail('zero eligible rows -> INCOMPLETE', 'code=' + r.code + ' verdict=' + String(r.packet?.verdict));
    await db.end({ timeout: 5 }); await dropDb(name);
  }

  // ---- 3. full-coverage population PASSES with waivers; legacy row is OBSERVED ---------------
  {
    const { url, db, name } = await freshDb();
    await seed(db, HAPPY); await addSecondShipment(db);
    const r = runPacket(url, ['--boundary', BOUNDARY, ...FULL_WAIVERS]);
    const legacyRow = (r.packet?.shadow as Array<Record<string, unknown>> | undefined)?.find((x) => x.verdict === 'OBSERVED-LEGACY');
    if (r.code === 0 && r.packet?.verdict === 'PASS' && legacyRow) {
      ok('full-coverage population + waivers -> PASS; the legacy row is OBSERVED-LEGACY, never MATCH');
    } else fail('full-coverage population -> PASS', 'code=' + r.code + ' verdict=' + String(r.packet?.verdict) + ' failures=' + failuresOf(r.packet));
    // ---- 4. the SAME population FAILS without waivers ----------------------------------------
    const r2 = runPacket(url, ['--boundary', BOUNDARY]);
    if (r2.code !== 0 && r2.packet?.verdict === 'INCOMPLETE' && failuresOf(r2.packet).includes('insurance_adjusted_final_cost')) {
      ok('missing non-derivable cohorts without waivers -> INCOMPLETE, nonzero exit');
    } else fail('missing cohorts -> INCOMPLETE', 'code=' + r2.code);
    await db.end({ timeout: 5 }); await dropDb(name);
  }

  // ---- 5. THE ROUND-4 DECISIVE CASE: a post-boundary missing tuple with a CORRECT $0 hold
  //         must yield INCOMPLETE, never PASS — a correctly-reported hole is still a hole. -----
  {
    const { url, db, name } = await freshDb();
    await seed(db, [...HAPPY, HOLD_ROW]); await addSecondShipment(db);
    const r = runPacket(url, ['--boundary', BOUNDARY, ...FULL_WAIVERS]);
    if (r.code !== 0 && r.packet?.verdict === 'INCOMPLETE'
        && failuresOf(r.packet).includes('lack a billable frozen tuple')) {
      ok('post-boundary missing tuple with a CORRECT $0 hold -> INCOMPLETE, never PASS');
    } else fail('correct hold is still a coverage hole', 'code=' + r.code + ' verdict=' + String(r.packet?.verdict) + ' failures=' + failuresOf(r.packet));
    await db.end({ timeout: 5 }); await dropDb(name);
  }

  // ---- 6. an unbilled row is NOT-YET-COMPARED and fails the packet ---------------------------
  {
    const { url, db, name } = await freshDb();
    await seed(db, [...HAPPY, { shipDate: '2026-07-17T12:00:00Z', json: T508(19.99) }]);
    await addSecondShipment(db);
    const r = runPacket(url, ['--boundary', BOUNDARY, ...FULL_WAIVERS]);
    if (r.code !== 0 && r.packet?.verdict === 'INCOMPLETE'
        && (r.packet?.counts as Record<string, number>).notYetComparedRows === 1) {
      ok('an unbilled row -> NOT-YET-COMPARED -> INCOMPLETE, nonzero exit');
    } else fail('unbilled row fails the packet', 'code=' + r.code);
    await db.end({ timeout: 5 }); await dropDb(name);
  }

  // ---- 7. numeric-STRING tuple: Billing coerces, the real Portal SQL rejects -----------------
  {
    const { url, db, name } = await freshDb();
    const stringy = { ...T508(21), cShippingRateAmount: '21' };
    await seed(db, [...HAPPY, { shipDate: '2026-07-18T12:00:00Z', json: stringy,
      line: { type: 'shipping', amt: '21.00', desc: 'Shipping (20%) · order SMK-8 · shipment #8' } }]);
    await addSecondShipment(db);
    const r = runPacket(url, ['--boundary', BOUNDARY, ...FULL_WAIVERS]);
    const row = (r.packet?.shadow as Array<Record<string, unknown>> | undefined)?.find((x) =>
      Array.isArray(x.detail) && (x.detail as string[]).some((d) => d.includes('portal-rejects-frozen')));
    if (r.code !== 0 && r.packet?.verdict === 'VIOLATED' && row) {
      ok('numeric-string tuple -> Billing frozen but the REAL Portal SQL rejects -> portal-rejects-frozen MISMATCH');
    } else fail('numeric-string direction check', 'code=' + r.code + ' verdict=' + String(r.packet?.verdict));
    await db.end({ timeout: 5 }); await dropDb(name);
  }

  // ---- 8. half-cent: canonical roundMoney agrees with a 1.01 billed line ---------------------
  {
    const { url, db, name } = await freshDb();
    const half = { ...T508(1.005), shippingMarginAmount: -9.0 };
    await seed(db, [...HAPPY, { shipDate: '2026-07-19T12:00:00Z', json: half,
      line: { type: 'shipping', amt: '1.01', desc: 'Shipping (20%) · order SMK-8 · shipment #8' } }]);
    await addSecondShipment(db);
    const r = runPacket(url, ['--boundary', BOUNDARY, ...FULL_WAIVERS]);
    if (r.code === 0 && r.packet?.verdict === 'PASS') {
      ok('1.005 tuple vs 1.01 billed -> MATCH under canonical roundMoney');
    } else fail('half-cent canonical rounding', 'code=' + r.code + ' failures=' + failuresOf(r.packet));
    await db.end({ timeout: 5 }); await dropDb(name);
  }

  // ---- 9. duplicate lines + wrong line type: once-per-shipment mismatch counting -------------
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
      ok('duplicate lines + wrong line type -> exactly 2 mismatching shipments');
    } else fail('once-per-shipment counting', 'code=' + r.code + ' mismatchShipments=' + mm);
    await db.end({ timeout: 5 }); await dropDb(name);
  }

  // ---- 10. waiver restrictions (round-4): derivable cohorts and blank reasons refused --------
  {
    const { url, db, name } = await freshDb();
    const a = runPacket(url, ['--boundary', BOUNDARY, '--waive', 'ordinary_purchase:whatever']);
    if (a.code !== 0 && a.stderr.includes('derivable cohorts must be REPRESENTED')) {
      ok('waiving a DERIVABLE cohort is refused');
    } else fail('derivable-cohort waiver refused', 'code=' + a.code);
    const b = runPacket(url, ['--boundary', BOUNDARY, '--waive', 'insurance_adjusted_final_cost: ']);
    if (b.code !== 0 && b.stderr.includes('nonblank reason')) {
      ok('a blank waiver reason is refused');
    } else fail('blank waiver reason refused', 'code=' + b.code);
    await db.end({ timeout: 5 }); await dropDb(name);
  }

  // ---- 11. activation identity binding -------------------------------------------------------
  {
    const { url, db, name } = await freshDb();
    await seed(db, HAPPY); await addSecondShipment(db);
    const bare = runPacket(url, ['--boundary', BOUNDARY, '--mode', 'activation', ...FULL_WAIVERS]);
    if (bare.code !== 0 && bare.stderr.includes('env-clients-readback')) {
      ok('activation without operator readbacks refuses to run');
    } else fail('activation requires readbacks', 'code=' + bare.code);

    const NOW = new Date().toISOString();
    const URLS = ['--ci-run-url', 'https://ci/1', '--pg17-run-url', 'https://ci/2', '--portal-ci-run-url', 'https://ci/3'];
    const shortSha = runPacket(url, ['--boundary', BOUNDARY, '--mode', 'activation', ...FULL_WAIVERS,
      '--env-clients-readback', String(CLIENT), '--env-boundary-readback', BOUNDARY,
      '--readback-at', NOW, '--api-sha', 'aaa', '--worker-sha', 'aaa',
      '--portal-sha', PORTAL_SHA_GOOD, ...URLS]);
    if (shortSha.code !== 0 && shortSha.stderr.includes('FULL 40-hex')) {
      ok('activation with a non-40-hex SHA is refused (fabricated identities rejected)');
    } else fail('40-hex SHA required', 'code=' + shortSha.code);

    const stale = runPacket(url, ['--boundary', BOUNDARY, '--mode', 'activation', ...FULL_WAIVERS,
      '--env-clients-readback', String(CLIENT), '--env-boundary-readback', BOUNDARY,
      '--readback-at', NOW, '--api-sha', REPO_SHA, '--worker-sha', REPO_SHA,
      '--portal-sha', PORTAL_SHA_STALE, ...URLS]);
    if (stale.code !== 0 && stale.stderr.includes('PORTAL-MIRROR-STALE')) {
      ok('a 40-hex Portal SHA that does not match the embedded mirror fails PORTAL-MIRROR-STALE');
    } else fail('stale portal mirror refused', 'code=' + stale.code);

    // The GOOD path: toolGitSha == api-sha == worker-sha == the stub /health commitSha.
    const stub = await startHealthStub(REPO_SHA);
    const good = runPacket(url, ['--boundary', BOUNDARY, '--mode', 'activation', ...FULL_WAIVERS,
      '--env-clients-readback', String(CLIENT), '--env-boundary-readback', BOUNDARY,
      '--readback-at', NOW, '--api-sha', REPO_SHA, '--worker-sha', REPO_SHA,
      '--portal-sha', PORTAL_SHA_GOOD, '--api', stub.url, ...URLS]);
    const wrongHealthStub = await startHealthStub('f'.repeat(40));
    const badHealth = runPacket(url, ['--boundary', BOUNDARY, '--mode', 'activation', ...FULL_WAIVERS,
      '--env-clients-readback', String(CLIENT), '--env-boundary-readback', BOUNDARY,
      '--readback-at', NOW, '--api-sha', REPO_SHA, '--worker-sha', REPO_SHA,
      '--portal-sha', PORTAL_SHA_GOOD, '--api', wrongHealthStub.url, ...URLS]);
    stub.child.kill(); wrongHealthStub.child.kill();
    if (good.code === 0 && good.packet?.verdict === 'PASS') {
      ok('activation with bound identity (toolGitSha == api-sha == /health commitSha) -> PASS');
    } else fail('activation happy path', 'code=' + good.code + ' verdict=' + String(good.packet?.verdict) + ' failures=' + failuresOf(good.packet) + ' err=' + good.stderr.slice(-200));
    if (badHealth.code !== 0 && badHealth.stderr.includes('does not equal --api-sha')) {
      ok('a live /health whose commitSha disagrees with the attested SHA is refused');
    } else fail('health/SHA disagreement refused', 'code=' + badHealth.code + ' err=' + badHealth.stderr.slice(-200));
    await db.end({ timeout: 5 }); await dropDb(name);
  }

  console.log(failures === 0 ? '\nPASS' : '\n' + failures + ' FAILED');
  process.exit(failures === 0 ? 0 : 1);
}

void main();
