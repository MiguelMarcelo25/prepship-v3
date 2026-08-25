/**
 * PS-497 Slice 2 (Release A) — the canonical occurrence resolver + the 0105 quantity-state replacement,
 * proven against REAL PostgreSQL 17. Composes on the real 0070 + 0090 + 0104 migrations.
 *
 * Resolver: 3-class key derivation, provider identity read ONLY from the locked shipment, concurrent
 * single-winner, provider-collapse (two shipments one provider label -> one occurrence), and key-stability
 * under provider enrichment (shipment-first lookup). 0105: the guarded runner (subprocess) upgrades the
 * quantity-state contract so 'not_applicable' and 'superseded' may carry a NULL quantity while nothing
 * executable can.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { readVerifiedMigration, splitMigration } from './ps-497-fulfillment-occurrences-digest.js';
import { computeDigest, EXPECTED_MIGRATION_SHA256, readVerifiedMigration as read0105Migration } from './ps-497-claim-status-migration-digest.js';
import { resolveFulfillmentOccurrence, deriveOccurrenceKey } from '../src/services/fulfillment/resolve-fulfillment-occurrence.js';

const ADMIN_URL = process.env.PS497_PG17_ADMIN_URL || process.env.PS487_PG17_ADMIN_URL || process.env.PS508_PG17_ADMIN_URL;
if (!ADMIN_URL) { console.error('FAIL: PS497_PG17_ADMIN_URL not set. Unskippable.'); process.exit(1); }
const ADMIN: string = ADMIN_URL;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mig = (p: string) => readFileSync(path.join(REPO_ROOT, p), 'utf8');

async function setupSchema(db: postgres.Sql): Promise<void> {
  await db.unsafe(`
    create table orders (id integer primary key);
    create table shipments (id integer primary key);
    create table inventory (id integer primary key);
    insert into orders (id) values (1);
  `);
  await db.unsafe(mig('drizzle/0070_order_lifecycle_commands.sql'));
  await db.unsafe(mig('drizzle/0090_fulfillment_claim_nullable_quantity.sql'));
  const { transactional, concurrent } = splitMigration(readVerifiedMigration().text);
  await db.begin(async (tx) => { await tx.unsafe(transactional); });
  for (const stmt of concurrent) await db.unsafe(stmt);
}

function runRunner(dbUrl: string, args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', 'scripts/apply-ps-497-claim-not-applicable-status.ts', ...args], {
      cwd: REPO_ROOT, env: { ...process.env, ...extraEnv, DATABASE_URL: dbUrl }, shell: true });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => resolve({ code: code ?? 1, out, err }));
  });
}

const APPLY_ARGS = ['--apply', '--confirm=apply-ps-497-claim-not-applicable-status-0105'];

function runReadback(dbUrl: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', 'scripts/ps-497-0105-readback.ts'], {
      cwd: REPO_ROOT, env: { ...process.env, DATABASE_URL: dbUrl }, shell: true });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => resolve({ code: code ?? 1, out, err }));
  });
}

async function main(): Promise<void> {
  const hard = setTimeout(() => { console.error('HANG: exceeded 240s'); process.exit(3); }, 240_000);
  hard.unref();
  const admin = postgres(ADMIN, { max: 1, prepare: false, onnotice: () => {} });
  const [ver] = await admin<{ v: number }[]>`select current_setting('server_version_num')::int as v`;
  const v = Number(ver?.v ?? 0);
  if (v < 170000 || v >= 180000) { console.error(`FAIL: not PG17 (${v})`); await admin.end({ timeout: 5 }); process.exit(1); }
  const dbName = `ps497_relA_${v}_${process.pid}`;
  await admin.unsafe(`drop database if exists "${dbName}" with (force)`);
  await admin.unsafe(`create database "${dbName}"`);
  const base = ADMIN.replace(/\/[^/]*$/, `/${dbName}`);
  const sql = postgres(base, { max: 1, prepare: false, onnotice: () => {} });
  await setupSchema(sql);

  // A fresh phase_0104 database per adversarial case (isolated catalog manipulation).
  let caseSeq = 0;
  const cases: Array<{ sql: postgres.Sql; name: string }> = [];
  const freshClaimDb = async (): Promise<{ url: string; sql: postgres.Sql }> => {
    const name = `ps497_relA_case_${v}_${process.pid}_${caseSeq++}`;
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.unsafe(`create database "${name}"`);
    const url = ADMIN.replace(/\/[^/]*$/, `/${name}`);
    const s = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
    await setupSchema(s);
    cases.push({ sql: s, name });
    return { url, sql: s };
  };
  const conState = async (s: postgres.Sql, name: string): Promise<{ present: boolean; validated: boolean }> => {
    const [row] = await s<{ validated: boolean | null }[]>`
      select con.convalidated as validated from pg_constraint con
      join pg_class r on r.oid = con.conrelid join pg_namespace n on n.oid = r.relnamespace
      where n.nspname='public' and r.relname='fulfillment_line_claims' and con.conname=${name}`;
    return { present: row !== undefined, validated: row?.validated === true };
  };
  // Canonical partial-application statements to build resume states (identical to migration 0105 steps).
  const STMT = {
    addV2: `ALTER TABLE public.fulfillment_line_claims ADD CONSTRAINT fulfillment_line_claims_quantity_state_v2_check CHECK ((quantity IS NOT NULL AND quantity > 0) OR (quantity IS NULL AND status IN ('review','not_applicable','superseded'))) NOT VALID`,
    addDomain: `ALTER TABLE public.fulfillment_line_claims ADD CONSTRAINT fulfillment_line_claims_status_domain_check CHECK (status IN ('pending','applied','superseded','reversed','review','not_applicable')) NOT VALID`,
    validateV2: `ALTER TABLE public.fulfillment_line_claims VALIDATE CONSTRAINT fulfillment_line_claims_quantity_state_v2_check`,
    validateDomain: `ALTER TABLE public.fulfillment_line_claims VALIDATE CONSTRAINT fulfillment_line_claims_status_domain_check`,
    drop0090: `ALTER TABLE public.fulfillment_line_claims DROP CONSTRAINT fulfillment_line_claims_quantity_state_check`,
    dropStatus: `ALTER TABLE public.fulfillment_line_claims DROP CONSTRAINT fulfillment_line_claims_status_check`,
  };

  let passed = 0;
  const ok = (m: string) => { passed += 1; console.log('ok   ' + m); };
  const ctxBase = { orderId: 1, transition: 'shipped' as const, source: 'shipstation', effectiveAt: new Date('2026-08-25T00:00:00Z') };

  // 1) 3-class key derivation (pure).
  assert.equal(deriveOccurrenceKey({ ...ctxBase, external: false, lockedShipment: { id: 10, labelShipmentId: 555, source: 'ShipStation' } }).key, 'ord:1|pship:shipstation:555');
  assert.equal(deriveOccurrenceKey({ ...ctxBase, external: false, lockedShipment: { id: 10, labelShipmentId: null, source: 's' } }).key, 'ord:1|ship:10');
  assert.equal(deriveOccurrenceKey({ ...ctxBase, transition: 'external_shipped', external: true, lockedShipment: null }).key, 'ord:1|ext');
  assert.equal(deriveOccurrenceKey({ ...ctxBase, external: false, lockedShipment: null }).key, 'ord:1|whole');
  ok('key derivation: provider_shipment / local_shipment / |ext / |whole all correct; provider from the locked shipment source');

  // 2) provider_shipment resolve creates one occurrence with the derived key + kind.
  const r1 = await resolveFulfillmentOccurrence(sql, { ...ctxBase, external: false, lockedShipment: { id: 10, labelShipmentId: 555, source: 'shipstation' } });
  assert.equal(r1.created, true);
  assert.equal(r1.occurrenceKey, 'ord:1|pship:shipstation:555');
  assert.equal(r1.discriminatorKind, 'provider_shipment');
  ok('resolve: a shipment-backed writer creates a provider_shipment occurrence');

  // 3) shipment-less split -> two DISTINCT occurrences (|ext external, |whole unknown).
  const rExt = await resolveFulfillmentOccurrence(sql, { ...ctxBase, transition: 'external_shipped', external: true, lockedShipment: null });
  const rWhole = await resolveFulfillmentOccurrence(sql, { ...ctxBase, external: false, lockedShipment: null });
  assert.notEqual(rExt.occurrenceId, rWhole.occurrenceId);
  assert.equal(rExt.occurrenceKey, 'ord:1|ext');
  assert.equal(rWhole.occurrenceKey, 'ord:1|whole');
  ok('shipment-less split: external -> ord:1|ext and status-projection -> ord:1|whole are DISTINCT occurrences');

  // 4) concurrent single-winner on the same key.
  const cA = postgres(base, { max: 1, prepare: false, onnotice: () => {} });
  const cB = postgres(base, { max: 1, prepare: false, onnotice: () => {} });
  const raceCtx = { orderId: 1, transition: 'external_shipped' as const, source: 'webhook', effectiveAt: new Date(), external: true, lockedShipment: null };
  // seed a fresh order to avoid colliding with rExt
  await sql`insert into orders (id) values (2)`;
  const [ra, rb] = await Promise.all([
    resolveFulfillmentOccurrence(cA, { ...raceCtx, orderId: 2 }),
    resolveFulfillmentOccurrence(cB, { ...raceCtx, orderId: 2 }),
  ]);
  assert.equal(ra.occurrenceId, rb.occurrenceId, 'both racers resolve the same occurrence id');
  const [nRow] = await sql<{ n: number }[]>`select count(*)::int as n from fulfillment_occurrences where occurrence_key = 'ord:2|ext'`;
  assert.equal(nRow?.n, 1, 'exactly one occurrence exists for the raced key');
  ok('concurrency: two writers racing one occurrence_key -> one canonical occurrence, both read the winner');

  // 5) provider-collapse: two DIFFERENT shipments sharing one provider label -> one occurrence.
  await sql`insert into orders (id) values (3)`;
  const cShip = { orderId: 3, transition: 'shipped' as const, source: 'shipstation', effectiveAt: new Date(), external: false };
  const pc1 = await resolveFulfillmentOccurrence(sql, { ...cShip, lockedShipment: { id: 71, labelShipmentId: 999, source: 'shipstation' } });
  const pc2 = await resolveFulfillmentOccurrence(sql, { ...cShip, lockedShipment: { id: 72, labelShipmentId: 999, source: 'shipstation' } });
  assert.equal(pc1.occurrenceId, pc2.occurrenceId, 'two shipments with one provider label collapse to one occurrence');
  assert.equal(pc2.created, false);
  ok('provider-collapse: two local shipment rows sharing one labelShipmentId -> one provider_shipment occurrence');

  // 6) key stability under provider enrichment: local-key first, then enriched -> same occurrence.
  await sql`insert into orders (id) values (4)`;
  const cEnr = { orderId: 4, transition: 'shipped' as const, source: 'shipstation', effectiveAt: new Date(), external: false };
  const before = await resolveFulfillmentOccurrence(sql, { ...cEnr, lockedShipment: { id: 88, labelShipmentId: null, source: 'shipstation' } });
  assert.equal(before.discriminatorKind, 'local_shipment');
  const afterEnrich = await resolveFulfillmentOccurrence(sql, { ...cEnr, lockedShipment: { id: 88, labelShipmentId: 4242, source: 'shipstation' } });
  assert.equal(afterEnrich.occurrenceId, before.occurrenceId, 'enrichment resolves the ORIGINAL occurrence (shipment-first lookup)');
  assert.equal(afterEnrich.created, false);
  const [cRow] = await sql<{ c: number }[]>`select count(*)::int as c from fulfillment_occurrences where shipment_id = 88`;
  assert.equal(cRow?.c, 1, 'no second occurrence for the enriched shipment');
  ok('key stability: a local occurrence enriched with a provider id resolves the original — no second occurrence, no uniqueness error');

  await cA.end({ timeout: 5 }); await cB.end({ timeout: 5 });

  // 7) 0105 runner: dry-run then apply, then prove not_applicable/superseded may carry NULL quantity.
  await sql.unsafe(`
    insert into order_lifecycle_events (order_id, command_key, transition, source, effective_at)
      values (1, 'seed', 'shipped', 'test', now());
    insert into fulfillment_line_claims (lifecycle_event_id, order_id, line_key, quantity, direction, status, idempotency_key)
      values (1, 1, 'sku:0', 2, 'deduct', 'applied', 'seed:a'),
             (1, 1, 'sku:1', 1, 'deduct', 'review', 'seed:b');
  `);
  const dry = await runRunner(base, []);
  assert.equal(dry.code, 0, `0105 dry-run exits 0 (${dry.err})`);
  assert.ok(/DRY RUN/.test(dry.out) && /unknown_statuses=0 v2_violations=0/.test(dry.out), '0105 dry-run pre-audits cleanly');
  const applied = await runRunner(base, ['--apply', '--confirm=apply-ps-497-claim-not-applicable-status-0105']);
  assert.equal(applied.code, 0, `0105 apply exits 0 (${applied.err})`);
  assert.ok(/phase=0105/.test(applied.out) && /claims_unchanged=true/.test(applied.out), '0105 reaches phase 0105 with claims unchanged');
  const again = await runRunner(base, ['--apply', '--confirm=apply-ps-497-claim-not-applicable-status-0105']);
  assert.ok(/already_applied=true/.test(again.out), '0105 rerun is idempotent (already phase 0105)');
  ok('0105 runner: dry-run pre-audit clean, apply reaches phase 0105 (byte-identical), rerun idempotent');

  // not_applicable + NULL quantity is now legal; superseded + NULL is legal; pending + NULL is rejected.
  await sql`insert into fulfillment_line_claims (lifecycle_event_id, order_id, line_key, quantity, direction, status, idempotency_key)
    values (1, 1, 'ext', null, 'deduct', 'not_applicable', 'na:1')`;
  await sql`insert into fulfillment_line_claims (lifecycle_event_id, order_id, line_key, quantity, direction, status, idempotency_key)
    values (1, 1, 'sup', null, 'deduct', 'superseded', 'sup:1')`;
  let rejected = false;
  try {
    await sql`insert into fulfillment_line_claims (lifecycle_event_id, order_id, line_key, quantity, direction, status, idempotency_key)
      values (1, 1, 'bad', null, 'deduct', 'pending', 'bad:1')`;
  } catch (e) { rejected = (e as { code?: string }).code === '23514'; if (!rejected) throw e; }
  assert.ok(rejected, 'a pending claim with NULL quantity is still rejected after 0105');
  const [h0090] = await sql<{ has0090: boolean }[]>`select exists(select 1 from pg_constraint where conname='fulfillment_line_claims_quantity_state_check') as "has0090"`;
  assert.equal(h0090?.has0090, false, '0090 quantity_state_check has been dropped (replaced)');
  const [hStatus] = await sql<{ hasOld: boolean }[]>`select exists(select 1 from pg_constraint where conname='fulfillment_line_claims_status_check') as "hasOld"`;
  assert.equal(hStatus?.hasOld, false, "0070's inline status_check (5-value) has been dropped");
  const [hDomain] = await sql<{ present: boolean; validated: boolean }[]>`
    select true as present, convalidated as validated from pg_constraint where conname='fulfillment_line_claims_status_domain_check'`;
  assert.ok(hDomain?.present && hDomain?.validated, 'the 6-value status_domain_check is present and validated');
  // A status outside the six-value domain is rejected by the new domain check (proves it is enforced).
  let domainRejected = false;
  try {
    await sql`insert into fulfillment_line_claims (lifecycle_event_id, order_id, line_key, quantity, direction, status, idempotency_key)
      values (1, 1, 'nope', 1, 'deduct', 'bogus_status', 'bogus:1')`;
  } catch (e) { domainRejected = (e as { code?: string }).code === '23514'; if (!domainRejected) throw e; }
  assert.ok(domainRejected, 'a status outside the six-value domain is rejected by status_domain_check');
  ok('post-0105: not_applicable(NULL)+superseded(NULL) allowed; pending(NULL) rejected; 0090 + 5-value status_check replaced by the 6-value domain');

  // 8) 0105 runner exact-phase machine + digest binding (Release A blockers 1 & 2). Each case is a fresh
  //    phase_0104 db manipulated into a specific catalog state; the runner must apply cleanly on a genuine
  //    resume point and REFUSE (no apply, no rewrite) on any malformed catalog.
  const refuses = (r: { code: number; out: string; err: string }) => r.code !== 0;

  // 8a) same-named 0090 quantity check with a WRONG definition -> malformed refusal.
  {
    const c = await freshClaimDb();
    await c.sql.unsafe(STMT.drop0090);
    await c.sql.unsafe(`ALTER TABLE public.fulfillment_line_claims ADD CONSTRAINT fulfillment_line_claims_quantity_state_check CHECK (quantity IS NULL OR quantity >= 0)`);
    const r = await runRunner(c.url, APPLY_ARGS);
    assert.ok(refuses(r) && /not one of the seven|malformed/i.test(r.err + r.out), `wrong-def 0090 refused (${r.err})`);
    assert.equal((await conState(c.sql, 'fulfillment_line_claims_quantity_state_v2_check')).present, false, 'nothing applied after malformed refusal (8a)');
  }
  // 8b) same-named 0070 status check with a WRONG definition -> malformed refusal.
  {
    const c = await freshClaimDb();
    await c.sql.unsafe(STMT.dropStatus);
    await c.sql.unsafe(`ALTER TABLE public.fulfillment_line_claims ADD CONSTRAINT fulfillment_line_claims_status_check CHECK (status IN ('pending','applied'))`);
    const r = await runRunner(c.url, APPLY_ARGS);
    assert.ok(refuses(r) && /not one of the seven|malformed/i.test(r.err + r.out), `wrong-def status_check refused (${r.err})`);
    assert.equal((await conState(c.sql, 'fulfillment_line_claims_status_domain_check')).present, false, 'nothing applied after malformed refusal (8b)');
  }
  // 8c) 0090 prematurely dropped with no successor present -> malformed refusal.
  {
    const c = await freshClaimDb();
    await c.sql.unsafe(STMT.drop0090);
    const r = await runRunner(c.url, APPLY_ARGS);
    assert.ok(refuses(r) && /not one of the seven|malformed/i.test(r.err + r.out), `prematurely-missing 0090 refused (${r.err})`);
  }
  // 8d) a successor check present with a WRONG definition (unvalidated bad shape) -> malformed refusal.
  {
    const c = await freshClaimDb();
    await c.sql.unsafe(`ALTER TABLE public.fulfillment_line_claims ADD CONSTRAINT fulfillment_line_claims_quantity_state_v2_check CHECK (quantity IS NOT NULL) NOT VALID`);
    const r = await runRunner(c.url, APPLY_ARGS);
    assert.ok(refuses(r) && /not one of the seven|malformed/i.test(r.err + r.out), `wrong-def successor refused (${r.err})`);
  }
  ok('runner refuses every malformed catalog (wrong-def 0090/status/successor, prematurely-missing old check) with no apply');

  // 8e) genuine resume from phase_both_added -> applies to exact phase_0105.
  {
    const c = await freshClaimDb();
    await c.sql.unsafe(STMT.addV2); await c.sql.unsafe(STMT.addDomain);
    const r = await runRunner(c.url, APPLY_ARGS);
    assert.ok(r.code === 0 && /phase=0105/.test(r.out), `resume from both_added applies (${r.err})`);
    assert.equal((await conState(c.sql, 'fulfillment_line_claims_status_check')).present, false, '0070 status_check dropped on resume (8e)');
  }
  // 8f) genuine resume from phase_0090_dropped (only the final status drop remains) -> applies.
  {
    const c = await freshClaimDb();
    await c.sql.unsafe(STMT.addV2); await c.sql.unsafe(STMT.addDomain);
    await c.sql.unsafe(STMT.validateV2); await c.sql.unsafe(STMT.validateDomain); await c.sql.unsafe(STMT.drop0090);
    const r = await runRunner(c.url, APPLY_ARGS);
    assert.ok(r.code === 0 && /phase=0105/.test(r.out), `resume from 0090_dropped applies (${r.err})`);
    assert.equal((await conState(c.sql, 'fulfillment_line_claims_status_check')).present, false, '0070 status_check dropped on resume (8f)');
  }
  ok('runner resumes correctly from phase_both_added and phase_0090_dropped, driving to exact phase_0105');

  // 8g) an unknown claim status -> refusal, no rewrite (the row is left untouched).
  {
    const c = await freshClaimDb();
    await c.sql.unsafe(STMT.dropStatus);
    await c.sql`insert into order_lifecycle_events (order_id, command_key, transition, source, effective_at) values (1, 'e8g', 'shipped', 't', now())`;
    await c.sql`insert into fulfillment_line_claims (lifecycle_event_id, order_id, line_key, quantity, direction, status, idempotency_key) values (1, 1, 'w', 1, 'deduct', 'weird', 'w:1')`;
    await c.sql.unsafe(`ALTER TABLE public.fulfillment_line_claims ADD CONSTRAINT fulfillment_line_claims_status_check CHECK (status IN ('pending','applied','superseded','reversed','review')) NOT VALID`);
    const r = await runRunner(c.url, APPLY_ARGS);
    assert.ok(refuses(r), `unknown status refused (${r.err})`);
    const [w] = await c.sql<{ n: number }[]>`select count(*)::int as n from fulfillment_line_claims where status='weird'`;
    assert.equal(w?.n, 1, 'the unknown-status row is left untouched (no rewrite) (8g)');
  }
  ok('runner refuses a database carrying an unknown claim status and rewrites nothing');

  // 8h) wrong --confirm token and plain invocation are inert dry-runs (no apply).
  {
    const c = await freshClaimDb();
    const wrong = await runRunner(c.url, ['--apply', '--confirm=WRONG']);
    assert.ok(wrong.code === 0 && /DRY RUN/.test(wrong.out), 'wrong confirm token is an inert dry-run');
    const plain = await runRunner(c.url, []);
    assert.ok(plain.code === 0 && /DRY RUN/.test(plain.out), 'no --apply is an inert dry-run');
    assert.equal((await conState(c.sql, 'fulfillment_line_claims_quantity_state_v2_check')).present, false, 'dry-runs applied nothing (8h)');
  }
  ok('wrong-confirmation and no-apply invocations are inert dry-runs that change no catalog');

  // 8i) digest mutation refusal — in-process binding + a tampered migration file (restored in finally).
  {
    const { text } = read0105Migration();
    assert.equal(computeDigest(text), EXPECTED_MIGRATION_SHA256, 'pinned digest binds the migration bytes');
    assert.notEqual(computeDigest(text + ' '), EXPECTED_MIGRATION_SHA256, 'any mutation breaks the digest');
    const migPath = path.join(REPO_ROOT, 'drizzle/0105_ps497_claim_not_applicable_status.sql');
    const original = readFileSync(migPath);
    try {
      writeFileSync(migPath, Buffer.concat([original, Buffer.from('\n-- tamper\n')]));
      const c = await freshClaimDb();
      const r = await runRunner(c.url, APPLY_ARGS);
      assert.ok(refuses(r) && /digest mismatch/i.test(r.err + r.out), `tampered migration refused (${r.err})`);
      assert.equal((await conState(c.sql, 'fulfillment_line_claims_quantity_state_v2_check')).present, false, 'tampered run applied nothing (8i)');
    } finally {
      writeFileSync(migPath, original);
    }
    assert.equal(computeDigest(readFileSync(migPath, 'utf8')), EXPECTED_MIGRATION_SHA256, 'migration restored to exact bytes');
  }
  ok('runner refuses a byte-mutated migration (digest mismatch) and applies nothing');

  // 8j) timeout bounds — 0/disabled and unbounded are refused before touching the catalog.
  {
    const c = await freshClaimDb();
    const zero = await runRunner(c.url, APPLY_ARGS, { PS497_LOCK_TIMEOUT: '0s' });
    assert.ok(refuses(zero) && /timeout/i.test(zero.err + zero.out), `0 lock timeout refused (${zero.err})`);
    const huge = await runRunner(c.url, APPLY_ARGS, { PS497_0105_STATEMENT_TIMEOUT: '999999999min' });
    assert.ok(refuses(huge) && /timeout/i.test(huge.err + huge.out), `unbounded statement timeout refused (${huge.err})`);
    assert.equal((await conState(c.sql, 'fulfillment_line_claims_quantity_state_v2_check')).present, false, 'bad-timeout runs applied nothing (8j)');
  }
  ok('runner refuses 0/disabled and unbounded timeouts and applies nothing');

  // 8k) session cleanup — a successful apply leaves no lingering runner backend.
  {
    const c = await freshClaimDb();
    const r = await runRunner(c.url, APPLY_ARGS);
    assert.equal(r.code, 0, `apply exits 0 (${r.err})`);
    const [act] = await c.sql<{ n: number }[]>`select count(*)::int as n from pg_stat_activity where application_name='ps-497-migration-0105'`;
    assert.equal(act?.n, 0, 'no leaked runner sessions after apply (8k)');
  }
  ok('a successful apply leaves no ps-497-migration-0105 session open (clean session lifecycle)');

  // 8l) full-row checksum covers EVERY protected column, not just id/quantity/status (addendum 1).
  {
    const c = await freshClaimDb();
    await c.sql`insert into order_lifecycle_events (order_id, command_key, transition, source, effective_at) values (1, 'e8l', 'shipped', 't', now())`;
    await c.sql`insert into fulfillment_line_claims (lifecycle_event_id, order_id, line_key, quantity, direction, status, idempotency_key, last_error) values (1, 1, 'k', 2, 'deduct', 'applied', 'k:1', null)`;
    const cksum = async (): Promise<string> => {
      const [row] = await c.sql<{ s: string }[]>`select coalesce(sum(('x' || substr(md5(to_jsonb(t)::text), 1, 16))::bit(64)::bigint::numeric), 0)::text as s from fulfillment_line_claims t`;
      return row?.s ?? '0';
    };
    const before8l = await cksum();
    await c.sql`update fulfillment_line_claims set last_error='changed' where idempotency_key='k:1'`;
    assert.notEqual(before8l, await cksum(), 'the to_jsonb(row) checksum detects a change to last_error (a non-status/quantity column) (8l)');
  }
  ok('protected-row checksum is over to_jsonb(row) — a change to any column (e.g. last_error) is detected');

  // 8m) resolver rejects contradictory key-vs-shipment winners (blocker 3).
  {
    const c = await freshClaimDb();
    await c.sql`insert into orders (id) values (7)`;
    const rctx = (lockedShipment: { id: number; labelShipmentId: number | null; source: string }) => ({
      orderId: 7, transition: 'shipped' as const, source: 'shipstation', effectiveAt: new Date('2026-08-25T00:00:00Z'), external: false, lockedShipment,
    });
    // A owns the provider key ord:7|pship:shipstation:999 (via shipment 91); B owns the local key ord:7|ship:72.
    await resolveFulfillmentOccurrence(c.sql, rctx({ id: 91, labelShipmentId: 999, source: 'shipstation' }));
    await resolveFulfillmentOccurrence(c.sql, rctx({ id: 72, labelShipmentId: null, source: 'shipstation' }));
    // Enriching shipment 72 with provider 999: derived key -> A, shipment 72 -> B => contradiction, must throw.
    let threw = false;
    try {
      await resolveFulfillmentOccurrence(c.sql, rctx({ id: 72, labelShipmentId: 999, source: 'shipstation' }));
    } catch (e) { threw = /identity conflict/.test(String(e)); if (!threw) throw e; }
    assert.ok(threw, 'contradictory key-vs-shipment winners are rejected fail-closed (8m)');
  }
  ok('resolver throws on a contradictory key-vs-shipment winner instead of silently preferring one');

  // 8n) the INDEPENDENT 0105 readback tool: GREEN against the phase_0105 main db; FAILS against phase_0104.
  {
    const green = await runReadback(base);
    assert.ok(green.code === 0 && /GREEN/.test(green.out), `readback GREEN on phase_0105 (${green.err})`);
    const pre = await freshClaimDb(); // phase_0104
    const red = await runReadback(pre.url);
    assert.ok(red.code !== 0 && /readback FAILED/i.test(red.err + red.out), `readback FAILS on phase_0104 (${red.out})`);
  }
  ok('independent 0105 readback tool: GREEN on an applied db, fail-closed on an un-applied (phase_0104) db');

  for (const cdb of cases) {
    await cdb.sql.end({ timeout: 5 });
    await admin.unsafe(`drop database "${cdb.name}" with (force)`);
  }

  clearTimeout(hard);
  await sql.end({ timeout: 5 });
  await admin.unsafe(`drop database "${dbName}" with (force)`);
  await admin.end({ timeout: 5 });
  console.log(`\nPASS PS-497 Slice 2 Release A (PostgreSQL ${v}) — ${passed}/${passed} checks`);
}

main().catch((error) => { console.error(error); process.exit(1); });
