/**
 * PS-508 — smoke proof for the canary evidence packet (schema v3), against real PostgreSQL.
 *
 * Round-6 additions: git verification is injection-proof (argv arrays — the audit DEMONSTRATED
 * a shell injection through the old concatenated --portal-repo) and sourced from the OFFICIAL
 * remote, so an unpushed local descendant is refused as UNPUBLISHED; the worker decision is a
 * pure owner unit-tested across missing/stale-SHA/stale-heartbeat/malformed/duplicate/current;
 * excluded rows must carry ZERO shipping-domain lines of any type or sign and no Portal money;
 * multi_shipment is an evidence-grain cohort — only orders with >=2 CLEANLY-COMPARED frozen
 * shipments represent it.
 *
 * UNSKIPPABLE: absent PS508_PG17_ADMIN_URL this FAILS rather than skipping.
 */
import { spawn, spawnSync, execSync, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { decideWorkerIdentity, WORKER_HEARTBEAT_MAX_AGE_MS } from './ps-508-canary-worker-identity';

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
const PORTAL_REPO = process.env.PS508_SMOKE_PORTAL_REPO
  ?? path.resolve('..', 'client-portal-prepship');
const PORTAL_HEAD = 'cd486cc982870b190692e41bd8fbe35944f1e5ec'; // == the embedded mirror SHA, pushed
const PORTAL_ANCESTOR = 'd447d89d83238ea2a522c06e9a158c2f1b20466e'; // real + pushed, but BEHIND the mirror
const PORTAL_FABRICATED = 'd447d89' + 'a'.repeat(33); // round-4's fabrication — refused as unknown
const INJECTION_REPO = '/definitely/not/a/repo"; printf commit; #'; // the audit's demonstrated payload
if (!fs.existsSync(path.join(PORTAL_REPO, '.git'))) {
  console.error('FAIL: portal clone not found at ' + PORTAL_REPO
    + ' (set PS508_SMOKE_PORTAL_REPO) — the ancestry cases are unskippable.');
  process.exit(1);
}
/** An UNPUSHED descendant of the mirror with the predicate unchanged — must be refused. */
const UNPUSHED_DESCENDANT = (() => {
  const tree = execFileSync('git', ['-C', PORTAL_REPO, 'rev-parse', PORTAL_HEAD + '^{tree}'], { encoding: 'utf8' }).trim();
  return execFileSync('git', ['-C', PORTAL_REPO, 'commit-tree', tree, '-p', PORTAL_HEAD, '-m', 'ps508-smoke unpushed descendant'],
    { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'smoke', GIT_AUTHOR_EMAIL: 's@s', GIT_COMMITTER_NAME: 'smoke', GIT_COMMITTER_EMAIL: 's@s' } }).trim();
})();

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
  create table settings (key text primary key, value text);
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
const WAIVER_APPROVAL = ['--waive-approved-by', 'smoke-harness', '--waive-evidence', 'scripts/ps-508-canary-packet-smoke-pg17.ts'];

function runPacket(dbUrl: string, extra: string[], windowFrom = '2026-05-01'): { code: number; packet: Record<string, unknown> | null; stderr: string } {
  const out = path.join(os.tmpdir(), 'ps508-pkt-' + process.pid + '-' + (++dbSeq) + '.json');
  const r = spawnSync('npx', ['tsx', 'scripts/ps-508-canary-evidence-packet.ts',
    '--client', String(CLIENT), '--from', windowFrom, '--to', '2026-08-01', '--out', out, ...extra],
  { shell: true, encoding: 'utf8', timeout: 300_000, env: { ...process.env, PS508_PACKET_DATABASE_URL: dbUrl } });
  let packet: Record<string, unknown> | null = null;
  try { packet = JSON.parse(fs.readFileSync(out, 'utf8')); fs.unlinkSync(out); } catch { /* no packet */ }
  return { code: r.status ?? 1, packet, stderr: (r.stderr ?? '') + (r.stdout ?? '') };
}
const failuresOf = (p: Record<string, unknown> | null): string =>
  Array.isArray(p?.failures) ? (p!.failures as string[]).join(' | ') : '';
const countFailLines = (stderr: string): number => (stderr.match(/^FAIL: /gm) ?? []).length;

/** PASS-shaped population — every eligible row tuple-covered and billed clean; excluded rows
 *  carry NO shipping-domain lines and no Portal-visible money (round-6). */
const HAPPY: Seed[] = [
  { shipDate: '2026-07-10T12:00:00Z', json: T508(25.5),
    line: { type: 'shipping', amt: '25.50', desc: 'Shipping (20%) · order SMK-1 · shipment #1' } },
  { shipDate: '2026-07-11T12:00:00Z', json: T509(12),
    line: { type: 'shipping', amt: '12.00', desc: 'Shipping (sync) · order SMK-2 · shipment #2' } },
  { shipDate: '2026-07-12T12:00:00Z', json: HOUSE(31),
    line: { type: 'shipping', amt: '31.00', desc: 'Shipping (20%) · order SMK-3 · shipment #3' } },
  { shipDate: '2026-05-15T12:00:00Z', json: RECEIPT,
    line: { type: 'shipping', amt: '10.00', desc: 'Shipping · order SMK-4 · shipment #4' } },
  { shipDate: '2026-07-14T12:00:00Z', json: RECEIPT, voided: true },
  { shipDate: '2026-07-15T12:00:00Z', json: null, isReturn: true },
  { shipDate: '2026-07-16T12:00:00Z', json: null, ext: true },
];
const HOLD_ROW: Seed = {
  shipDate: '2026-07-13T12:00:00Z', json: RECEIPT,
  line: { type: 'shipping_missing', amt: '0.00', desc: 'Customer shipping money needs review (post_cutover_shipment_missing_frozen_tuple) - order SMK-8' },
};
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
async function seedWorkerSnapshot(db: postgres.Sql, sha: string, heartbeatAt: string): Promise<void> {
  const snapshot = JSON.stringify({ version: 1, service: 'worker', mode: 'worker-scheduler',
    heartbeatAt,
    runtime: { commitSha: sha, commitSource: 'RENDER_GIT_COMMIT', serviceId: 'smoke', instanceId: 'smoke' } });
  await db.unsafe(
    "insert into settings (key, value) values ('worker.status.snapshot:worker-scheduler', $1) "
    + 'on conflict (key) do update set value = excluded.value',
    [snapshot],
  );
}

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
  // ---- 1. read-only is REAL -----------------------------------------------------------------
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
      ok('read-only is server-enforced: SHOW=on, deliberate INSERT fails (' + code + '), zero rows');
    } else fail('read-only enforced', 'writeFailed=' + writeFailed);
    await probe.end({ timeout: 5 }); await db.end({ timeout: 5 }); await dropDb(name);
  }

  // ---- 2. acceptance core (unchanged from round-5, re-proven) --------------------------------
  {
    const { url, db, name } = await freshDb();
    const r = runPacket(url, ['--boundary', BOUNDARY, ...FULL_WAIVERS]);
    if (r.code !== 0 && r.packet?.verdict === 'INCOMPLETE' && failuresOf(r.packet).includes('zero eligible')) {
      ok('zero eligible rows -> INCOMPLETE, nonzero exit');
    } else fail('zero-row INCOMPLETE', 'code=' + r.code);
    await db.end({ timeout: 5 }); await dropDb(name);
  }
  {
    const { url, db, name } = await freshDb();
    await seed(db, HAPPY); await addSecondShipment(db);
    const r = runPacket(url, ['--boundary', BOUNDARY, ...FULL_WAIVERS]);
    const legacyRow = (r.packet?.shadow as Array<Record<string, unknown>> | undefined)?.find((x) => x.verdict === 'OBSERVED-LEGACY');
    if (r.code === 0 && r.packet?.verdict === 'PASS' && legacyRow) {
      ok('full-coverage population + waivers -> PASS (inventory); legacy row OBSERVED-LEGACY');
    } else fail('full-coverage PASS', 'code=' + r.code + ' failures=' + failuresOf(r.packet));
    const r2 = runPacket(url, ['--boundary', BOUNDARY]);
    if (r2.code !== 0 && failuresOf(r2.packet).includes('insurance_adjusted_final_cost')) {
      ok('missing non-derivable cohorts without waivers -> INCOMPLETE');
    } else fail('missing-cohort INCOMPLETE', 'code=' + r2.code);
    await db.end({ timeout: 5 }); await dropDb(name);
  }
  {
    const { url, db, name } = await freshDb();
    await seed(db, [...HAPPY, HOLD_ROW]); await addSecondShipment(db);
    const r = runPacket(url, ['--boundary', BOUNDARY, ...FULL_WAIVERS]);
    if (r.code !== 0 && r.packet?.verdict === 'INCOMPLETE' && failuresOf(r.packet).includes('lack a billable frozen tuple')) {
      ok('post-boundary missing tuple with a CORRECT $0 hold -> INCOMPLETE, never PASS');
    } else fail('coverage hole never PASSes', 'code=' + r.code);
    await db.end({ timeout: 5 }); await dropDb(name);
  }
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
      ok('numeric-string tuple -> portal-rejects-frozen MISMATCH');
    } else fail('numeric-string direction', 'code=' + r.code);
    await db.end({ timeout: 5 }); await dropDb(name);
  }
  {
    const { url, db, name } = await freshDb();
    const half = { ...T508(1.005), shippingMarginAmount: -9.0 };
    await seed(db, [...HAPPY, { shipDate: '2026-07-19T12:00:00Z', json: half,
      line: { type: 'shipping', amt: '1.01', desc: 'Shipping (20%) · order SMK-8 · shipment #8' } }]);
    await addSecondShipment(db);
    const r = runPacket(url, ['--boundary', BOUNDARY, ...FULL_WAIVERS]);
    if (r.code === 0 && r.packet?.verdict === 'PASS') {
      ok('1.005 tuple vs 1.01 billed -> MATCH under canonical roundMoney');
    } else fail('half-cent rounding', 'code=' + r.code + ' failures=' + failuresOf(r.packet));
    await db.end({ timeout: 5 }); await dropDb(name);
  }
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
    } else fail('once-per-shipment counting', 'mismatchShipments=' + mm);
    await db.end({ timeout: 5 }); await dropDb(name);
  }

  // ---- 3. round-6: excluded rows tolerate NO shipping-domain activity ------------------------
  {
    const { url, db, name } = await freshDb();
    await seed(db, [...HAPPY,
      { shipDate: '2026-07-22T12:00:00Z', json: RECEIPT, voided: true,
        line: { type: 'shipping', amt: '0.00', desc: 'zero on a voided row' } },
      { shipDate: '2026-07-23T12:00:00Z', json: RECEIPT, voided: true,
        line: { type: 'shipping_missing', amt: '0.00', desc: 'hold on a voided row' } },
      { shipDate: '2026-07-24T12:00:00Z', json: T508(13), voided: true }, // valid tuple -> Portal money
    ]);
    await addSecondShipment(db);
    const r = runPacket(url, ['--boundary', BOUNDARY, ...FULL_WAIVERS]);
    const details = (r.packet?.shadow as Array<Record<string, unknown>> | undefined ?? [])
      .flatMap((x) => Array.isArray(x.detail) ? x.detail as string[] : []);
    const hasLine = details.some((d) => d.includes('excluded-row-carries-shipping-domain-line'));
    const hasPortal = details.some((d) => d.includes('excluded-row-portal-money'));
    const mm = (r.packet?.counts as Record<string, number>).mismatchShipments;
    if (r.code !== 0 && r.packet?.verdict === 'VIOLATED' && hasLine && hasPortal && mm === 3) {
      ok('excluded rows: a ZERO shipping line, a shipping_missing hold, and Portal-visible money are all MISMATCHES');
    } else fail('exclusion tolerates nothing', 'mm=' + mm + ' hasLine=' + hasLine + ' hasPortal=' + hasPortal);
    await db.end({ timeout: 5 }); await dropDb(name);
  }

  // ---- 4. round-6 (K9): multi_shipment is evidence-grain -------------------------------------
  {
    const { url, db, name } = await freshDb();
    // Clean frozen primary + a PRE-boundary legacy sibling: the order-level count is 2, but
    // only ONE cleanly-compared frozen shipment exists -> multi_shipment NOT represented.
    await seed(db, HAPPY);
    await db.unsafe(
      'insert into shipments (order_id, client_id, ship_date, source, selected_rate_json) '
      + "select order_id, client_id, '2026-05-10T13:00:00Z', 'smoke', $1::text::jsonb from shipments where id = 1",
      [JSON.stringify(RECEIPT)],
    );
    const r = runPacket(url, ['--boundary', BOUNDARY, ...FULL_WAIVERS]);
    if (r.code !== 0 && r.packet?.verdict === 'INCOMPLETE'
        && failuresOf(r.packet).includes('multi_shipment')) {
      ok('a pre-boundary legacy sibling does NOT satisfy multi_shipment (evidence-grain cohort)');
    } else fail('K9 evidence grain', 'code=' + r.code + ' failures=' + failuresOf(r.packet));
    await db.end({ timeout: 5 }); await dropDb(name);
  }

  // ---- 5. waiver refusals --------------------------------------------------------------------
  {
    const { url, db, name } = await freshDb();
    const a = runPacket(url, ['--boundary', BOUNDARY, '--waive', 'ordinary_purchase:whatever']);
    if (a.code !== 0 && a.stderr.includes('derivable cohorts must be REPRESENTED')) {
      ok('waiving a DERIVABLE cohort is refused');
    } else fail('derivable waiver refused', 'code=' + a.code);
    const b = runPacket(url, ['--boundary', BOUNDARY, '--waive', 'insurance_adjusted_final_cost: ']);
    if (b.code !== 0 && b.stderr.includes('nonblank reason')) {
      ok('a blank waiver reason is refused');
    } else fail('blank reason refused', 'code=' + b.code);
    await db.end({ timeout: 5 }); await dropDb(name);
  }

  // ---- 6. round-6: the worker decision owner, all six adversarial states ---------------------
  {
    const nowMs = Date.now();
    const NOW = new Date(nowMs).toISOString();
    const OLD = new Date(nowMs - WORKER_HEARTBEAT_MAX_AGE_MS - 60_000).toISOString();
    const row = (sha: string, hb: string, extra: Record<string, unknown> = {}) => ({
      key: 'worker.status.snapshot:worker-scheduler',
      value: JSON.stringify({ version: 1, service: 'worker', heartbeatAt: hb, runtime: { commitSha: sha }, ...extra }),
    });
    const cases: Array<[string, ReturnType<typeof decideWorkerIdentity>, boolean, string]> = [
      ['missing', decideWorkerIdentity([], REPO_SHA, nowMs), false, 'no canonical worker snapshot'],
      ['stale SHA', decideWorkerIdentity([row('f'.repeat(40), NOW)], REPO_SHA, nowMs), false, 'not the attested deployment SHA'],
      ['stale heartbeat', decideWorkerIdentity([row(REPO_SHA, OLD)], REPO_SHA, nowMs), false, 'heartbeat is'],
      ['malformed', decideWorkerIdentity([{ key: 'worker.status.snapshot:worker-scheduler', value: '{not json' }], REPO_SHA, nowMs), false, 'not parseable'],
      ['duplicate', decideWorkerIdentity([row(REPO_SHA, NOW), row(REPO_SHA, NOW)], REPO_SHA, nowMs), false, 'competing canonical'],
      ['current', decideWorkerIdentity([row(REPO_SHA, NOW)], REPO_SHA, nowMs), true, ''],
    ];
    let all = true;
    for (const [label, d, expectOk, msgPart] of cases) {
      const good = d.ok === expectOk && (expectOk || (d.ok === false && d.reason.includes(msgPart)));
      if (!good) { all = false; fail('worker owner: ' + label, JSON.stringify(d)); }
    }
    // Non-canonical rows must never decide: a placeholder snapshot alone is a refusal.
    const aux = decideWorkerIdentity([
      { key: 'worker.status.snapshot:placeholder', value: JSON.stringify({ service: 'worker', heartbeatAt: NOW, runtime: { commitSha: REPO_SHA } }) },
    ], REPO_SHA, nowMs);
    if (aux.ok) { all = false; fail('worker owner: aux key must not decide', JSON.stringify(aux)); }
    if (all) ok('worker owner: missing / stale-SHA / stale-heartbeat / malformed / duplicate / aux-key refused, current accepted');
  }

  // ---- 7. round-6: portal identity — injection-proof and official-remote sourced -------------
  {
    const { url, db, name } = await freshDb();
    await seed(db, HAPPY); await addSecondShipment(db);
    await seedWorkerSnapshot(db, REPO_SHA, new Date().toISOString());
    const NOW = new Date().toISOString();
    const URLS = ['--ci-run-url', 'https://ci/1', '--pg17-run-url', 'https://ci/2', '--portal-ci-run-url', 'https://ci/3'];
    const IDENT = (portalSha: string, portalRepo: string) => ['--env-clients-readback', String(CLIENT),
      '--env-boundary-readback', BOUNDARY, '--readback-at', NOW, '--api-sha', REPO_SHA,
      '--worker-sha', REPO_SHA, '--portal-sha', portalSha, '--portal-repo', portalRepo,
      ...URLS, ...WAIVER_APPROVAL];
    const ACT = ['--mode', 'activation', '--boundary', BOUNDARY, ...FULL_WAIVERS];

    const injected = runPacket(url, [...ACT, ...IDENT(PORTAL_HEAD, INJECTION_REPO)], BOUNDARY);
    if (injected.code !== 0 && injected.stderr.includes('PORTAL-VERIFY-FAILED')) {
      ok("the audit's shell-injection payload in --portal-repo is REFUSED (argv-array git, no shell)");
    } else fail('injection refused', 'code=' + injected.code + ' err=' + injected.stderr.slice(-200));

    const unpushed = runPacket(url, [...ACT, ...IDENT(UNPUSHED_DESCENDANT, PORTAL_REPO)], BOUNDARY);
    if (unpushed.code !== 0 && unpushed.stderr.includes('PORTAL-SHA-UNPUBLISHED')) {
      ok('an UNPUSHED local descendant (predicate unchanged) is refused — verification objects come from the official remote');
    } else fail('unpushed descendant refused', 'code=' + unpushed.code + ' err=' + unpushed.stderr.slice(-200));

    const fabricated = runPacket(url, [...ACT, ...IDENT(PORTAL_FABRICATED, PORTAL_REPO)], BOUNDARY);
    if (fabricated.code !== 0 && fabricated.stderr.includes('PORTAL-SHA-UNKNOWN')) {
      ok("round-4's fabricated padded SHA is refused as an unknown commit");
    } else fail('fabricated refused', 'code=' + fabricated.code);

    const behind = runPacket(url, [...ACT, ...IDENT(PORTAL_ANCESTOR, PORTAL_REPO)], BOUNDARY);
    if (behind.code !== 0 && behind.stderr.includes('PORTAL-MIRROR-STALE')) {
      ok('a REAL pushed commit BEHIND the mirror fails ancestry -> PORTAL-MIRROR-STALE');
    } else fail('behind-mirror refused', 'code=' + behind.code + ' err=' + behind.stderr.slice(-200));

    const stub = await startHealthStub(REPO_SHA);
    const stubApi = runPacket(url, [...ACT, ...IDENT(PORTAL_HEAD, PORTAL_REPO), '--api', stub.url], BOUNDARY);
    stub.child.kill();
    if (stubApi.code !== 0 && stubApi.stderr.includes('approved production origin')
        && countFailLines(stubApi.stderr) === 1) {
      ok('with EVERY other gate bound (incl. official-remote portal verification), a stub API is the ONE remaining refusal');
    } else fail('origin is the only remaining gate', 'failLines=' + countFailLines(stubApi.stderr) + ' err=' + stubApi.stderr.slice(-300));
    await db.end({ timeout: 5 }); await dropDb(name);
  }

  // ---- 8. inventory-mode health comparison (both directions) ---------------------------------
  {
    const { url, db, name } = await freshDb();
    await seed(db, HAPPY); await addSecondShipment(db);
    const good = await startHealthStub(REPO_SHA);
    const rGood = runPacket(url, ['--boundary', BOUNDARY, ...FULL_WAIVERS, '--api', good.url, '--api-sha', REPO_SHA]);
    good.child.kill();
    if (rGood.code === 0 && rGood.packet?.verdict === 'PASS') {
      ok('inventory + matching /health -> PASS with health identity recorded');
    } else fail('inventory health match', 'code=' + rGood.code + ' failures=' + failuresOf(rGood.packet));
    const bad = await startHealthStub('f'.repeat(40));
    const rBad = runPacket(url, ['--boundary', BOUNDARY, ...FULL_WAIVERS, '--api', bad.url, '--api-sha', REPO_SHA]);
    bad.child.kill();
    if (rBad.code !== 0 && failuresOf(rBad.packet).includes('does not equal --api-sha')) {
      ok('inventory + disagreeing /health -> recorded failure, nonzero exit');
    } else fail('inventory health mismatch', 'code=' + rBad.code);
    await db.end({ timeout: 5 }); await dropDb(name);
  }

  console.log(failures === 0 ? '\nPASS' : '\n' + failures + ' FAILED');
  process.exit(failures === 0 ? 0 : 1);
}

void main();
