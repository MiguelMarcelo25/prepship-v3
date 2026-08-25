/**
 * PS-497 / PS-489 Slice 1 — the OPERATOR APPLY LANE proven against REAL PostgreSQL 17 by invoking
 * the UNCHANGED production runner (scripts/apply-ps-497-fulfillment-occurrences.ts) as a subprocess.
 *
 * The behavior harness (ps-497-fulfillment-occurrences-concurrency-pg17.ts) proves the SCHEMA. This
 * proves the RUNNER: digest binding, dry-run inertness, confirmation gating, exact-catalog apply,
 * idempotent re-run, malformed same-named object fail-closed, invalid-index recovery,
 * reverse-duplicate abort, bounded lock timeout (no hang), concurrent-insert tolerance,
 * concurrent-update conservative red, and session cleanup.
 *
 * Unskippable: absent an admin URL this FAILS rather than skips, and it refuses any non-PG17 server.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { computeDigest, EXPECTED_MIGRATION_SHA256, readVerifiedMigration } from './ps-497-fulfillment-occurrences-digest.js';

const ADMIN_URL =
  process.env.PS497_PG17_ADMIN_URL || process.env.PS487_PG17_ADMIN_URL || process.env.PS508_PG17_ADMIN_URL;
if (!ADMIN_URL) {
  console.error('FAIL: PS497_PG17_ADMIN_URL (or PS487_/PS508_PG17_ADMIN_URL) is not set. This proof is unskippable.');
  process.exit(1);
}
const ADMIN: string = ADMIN_URL;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = 'scripts/apply-ps-497-fulfillment-occurrences.ts';
const CONFIRM = '--confirm=apply-ps-497-fulfillment-occurrences-0104';
const mig = (p: string) => readFileSync(path.join(REPO_ROOT, p), 'utf8');

type RunResult = { code: number; out: string; err: string };
function runRunner(dbUrl: string, args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', RUNNER, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: dbUrl, ...env },
      shell: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('exit', (code) => resolve({ code: code ?? 1, out, err }));
  });
}

// Poll from an INDEPENDENT connection until the runner's backend is provably waiting on a lock. Used
// to time genuine multi-backend interleaving: the harness holds ROW EXCLUSIVE on `orders`, which
// inspect()/snapshot never touch (so they pass) but the runner's FIRST txn statement (CREATE TABLE
// fulfillment_occurrences ... REFERENCES orders) needs ShareRowExclusive on — so the runner blocks
// there, AFTER its pre-snapshot, holding NO lock on fulfillment_line_claims. That leaves an
// independent connection free to INSERT/UPDATE claims (its FK checks take RowShare on orders, which
// is compatible with the held RowExclusive and the runner's pending ShareRowExclusive), commit, and
// only then is the lock released — so the write lands strictly in (beforeSnap, afterSnap).
async function waitUntilRunnerBlocked(dbUrl: string, timeoutMs = 25_000): Promise<void> {
  const w = postgres(dbUrl, { max: 1, prepare: false, onnotice: () => {} });
  const start = Date.now();
  try {
    for (;;) {
      const rows = await w`
        select 1 from pg_stat_activity
        where application_name = 'ps-497-migration-0104' and state = 'active' and wait_event_type = 'Lock'`;
      if (rows.length > 0) return;
      if (Date.now() - start > timeoutMs) throw new Error('runner did not reach a blocked lock wait in time');
      await new Promise((r) => setTimeout(r, 150));
    }
  } finally {
    await w.end({ timeout: 5 });
  }
}

async function applyBase(dbUrl: string): Promise<void> {
  const sql = postgres(dbUrl, { max: 1, prepare: false, onnotice: () => {} });
  await sql.unsafe(`
    create table if not exists orders (id integer primary key);
    create table if not exists shipments (id integer primary key);
    create table if not exists inventory (id integer primary key);
    insert into orders (id) values (1) on conflict do nothing;
  `);
  await sql.unsafe(mig('drizzle/0070_order_lifecycle_commands.sql'));
  await sql.unsafe(mig('drizzle/0090_fulfillment_claim_nullable_quantity.sql'));
  await sql.unsafe(`
    insert into order_lifecycle_events (order_id, command_key, transition, source, effective_at)
      values (1, 'seed:cmd', 'shipped', 'test', now());
    insert into fulfillment_line_claims
      (lifecycle_event_id, order_id, line_key, quantity, direction, status, idempotency_key)
      values (1, 1, 'sku:0', 2, 'deduct', 'pending', 'seed:a'),
             (1, 1, 'sku:1', 1, 'deduct', 'applied', 'seed:b');
  `);
  await sql.end({ timeout: 5 });
}

async function main(): Promise<void> {
  const hardTimeout = setTimeout(() => {
    console.error('HANG: ps-497-apply-lane-pg17 exceeded 300s');
    process.exit(3);
  }, 300_000);
  hardTimeout.unref();

  const admin = postgres(ADMIN, { max: 1, prepare: false, onnotice: () => {} });
  const [ver] = await admin<{ v: number }[]>`select current_setting('server_version_num')::int as v`;
  const v = Number(ver?.v ?? 0);
  if (v < 170000 || v >= 180000) {
    console.error(`FAIL: expected PostgreSQL 17, got ${v}.`);
    await admin.end({ timeout: 5 });
    process.exit(1);
  }

  let dbSeq = 0;
  const made: string[] = [];
  const freshDb = async (): Promise<string> => {
    const name = `ps497_lane_${v}_${process.pid}_${dbSeq++}`;
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.unsafe(`create database "${name}"`);
    made.push(name);
    const url = ADMIN.replace(/\/[^/]*$/, `/${name}`);
    await applyBase(url);
    return url;
  };
  const conn = (url: string) => postgres(url, { max: 1, prepare: false, onnotice: () => {} });

  let passed = 0;
  const ok = (m: string) => { passed += 1; console.log('ok   ' + m); };

  // 0) Digest binding: the real file matches EXPECTED; any byte change flips the digest.
  const verified = readVerifiedMigration();
  assert.equal(verified.digest, EXPECTED_MIGRATION_SHA256, 'the committed migration matches the pinned digest');
  for (const mutate of [
    (s: string) => s.replace('fulfillment_occurrences', 'fulfillment_occurrences /* x */'),
    (s: string) => s.replace("'provider_shipment'", "'provider_shipmentX'"),
    (s: string) => `${s}\n-- trailing comment\n`,
  ]) {
    assert.notEqual(computeDigest(mutate(verified.text)), EXPECTED_MIGRATION_SHA256, 'a byte mutation changes the digest');
  }
  ok('digest binding: committed migration matches the pin; SQL/comment/identifier mutations all change it');

  // 1) Dry run is inert.
  {
    const db = await freshDb();
    const r = await runRunner(db, []);
    assert.equal(r.code, 0, 'dry run exits 0');
    assert.ok(/DRY RUN/.test(r.out), 'dry run announces itself');
    const c = conn(db);
    const [drow] = await c<{ t: string | null }[]>`select to_regclass('public.fulfillment_occurrences')::text as t`;
    await c.end({ timeout: 5 });
    assert.equal(drow?.t, null, 'dry run created nothing');
    ok('dry run: default invocation verifies + reports but mutates nothing');
  }

  // 2) Missing / wrong confirmation never applies.
  {
    const db = await freshDb();
    const miss = await runRunner(db, ['--apply']);
    const wrong = await runRunner(db, ['--apply', '--confirm=nope']);
    assert.ok(/DRY RUN/.test(miss.out) && /DRY RUN/.test(wrong.out), 'both fall back to dry run');
    const c = conn(db);
    const [nrow] = await c<{ t: string | null }[]>`select to_regclass('public.fulfillment_occurrences')::text as t`;
    await c.end({ timeout: 5 });
    assert.equal(nrow?.t, null, 'neither applied');
    ok('confirmation gate: --apply without the exact --confirm token never applies');
  }

  // 3) Apply lands + exact catalog verified; 4) idempotent re-run.
  let appliedDb = '';
  {
    const db = await freshDb();
    appliedDb = db;
    // Pass bounded timeout overrides and assert BOTH phases actually apply them (the transactional
    // SET LOCAL and the session-level bound that governs the CONCURRENTLY builds + the recovery DROP).
    const r = await runRunner(db, ['--apply', CONFIRM], {
      PS497_LOCK_TIMEOUT: '7s',
      PS497_CONCURRENT_STATEMENT_TIMEOUT: '1200s',
    });
    assert.equal(r.code, 0, `apply exits 0 (stderr: ${r.err})`);
    assert.ok(/applied=/.test(r.out) && /exact_catalog_verified=true/.test(r.out), 'apply reports exact-catalog success');
    // Postgres canonicalizes time GUCs (1200s -> 20min) in current_setting, so assert on the stable
    // lock_timeout=7s in BOTH phase logs — proof the SET LOCAL (txn) and session-level (concurrent)
    // bounds actually took effect.
    assert.ok(/txn timeouts lock_timeout=7s/.test(r.out), 'the transactional phase applies the bounded lock_timeout');
    assert.ok(/concurrent timeouts lock_timeout=7s/.test(r.out), 'the CONCURRENTLY phase applies the bounded lock_timeout');
    assert.ok(/session application_name=ps-497-migration-0104/.test(r.out), 'the runner positively attests its session application_name');
    const c = conn(db);
    const idx = await c<{ n: number }[]>`
      select count(*)::int as n from pg_index i join pg_class cc on cc.oid=i.indexrelid
      where cc.relname in ('fulfillment_line_claims_occ_line_dir_unq','fulfillment_line_claims_reverse_original_unq') and i.indisvalid`;
    assert.equal(idx[0]?.n, 2, 'both concurrent indexes are valid');
    await c.end({ timeout: 5 });
    ok('apply: lands the migration and independently verifies both concurrent indexes valid');

    const again = await runRunner(db, ['--apply', CONFIRM]);
    assert.equal(again.code, 0, 'idempotent re-run exits 0');
    assert.ok(/already_applied=true/.test(again.out), 're-run short-circuits as already_applied');
    ok('idempotent: a second apply reports already_applied and does nothing');
  }

  // 5a) Malformed same-named object that BREAKS index DDL fails closed.
  {
    const db = await freshDb();
    const c = conn(db);
    await c.unsafe(`create table public.fulfillment_occurrences (id serial primary key, occurrence_key text)`);
    await c.end({ timeout: 5 });
    const dry = await runRunner(db, []);
    assert.ok(!/already_applied=true/.test(dry.out), 'a malformed same-named table is NOT accepted as already_applied');
    const r = await runRunner(db, ['--apply', CONFIRM]);
    assert.notEqual(r.code, 0, 'apply over an index-DDL-breaking malformed object fails closed');
    ok('fail-closed (a): a same-named table missing an index column is rejected');
  }

  // 5b) Malformed same-named object the DDL does NOT reject — full index columns, but order_id
  // nullable + no FK and no kind CHECK. Only the EXACT-catalog verify can catch this.
  {
    const db = await freshDb();
    const c = conn(db);
    await c.unsafe(`
      create table public.fulfillment_occurrences (
        id serial primary key,
        order_id integer,                 -- WRONG: nullable + no FK to orders
        shipment_id integer,
        occurrence_key text not null,
        discriminator_kind text not null, -- WRONG: no kind CHECK
        first_seen_source text not null,
        superseded_by_occurrence_id integer,
        effective_at timestamptz not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`);
    await c.end({ timeout: 5 });
    const r = await runRunner(db, ['--apply', CONFIRM]);
    assert.notEqual(r.code, 0, 'apply over a catalog-wrong (but index-DDL-valid) same-named table fails closed');
    assert.ok(/mismatches=/.test(r.err), 'the failure is the exact-catalog verify, not an unrelated DDL error');
    assert.ok(/fulfillment_occurrences_kind_chk|fulfillment_occurrences\.order_id/.test(r.err), 'the mismatch names the missing kind CHECK / order_id FK');
    ok('fail-closed (b): a catalog-wrong same-named table (missing kind CHECK / order_id FK / nullability) is rejected by the exact-catalog verify');
  }

  // 5c) Wrong DEFINITION under an expected name: a NON-UNIQUE index named like the unique one. The
  // exact-def comparison is the deciding factor (presence checks alone would pass).
  {
    const db = await freshDb();
    assert.equal((await runRunner(db, ['--apply', CONFIRM])).code, 0, 'baseline apply for the wrong-def case');
    const c = conn(db);
    await c.unsafe(`
      drop index public.fulfillment_line_claims_occ_line_dir_unq;
      create index fulfillment_line_claims_occ_line_dir_unq
        on public.fulfillment_line_claims (occurrence_id, canonical_line_identity, direction) where occurrence_id is not null;
    `);
    await c.end({ timeout: 5 });
    const dry = await runRunner(db, []);
    assert.ok(!/already_applied=true/.test(dry.out), 'a wrong-definition index is NOT accepted as already_applied');
    const r = await runRunner(db, ['--apply', CONFIRM]);
    assert.notEqual(r.code, 0, 'apply over a non-unique same-named index fails closed');
    assert.ok(/def mismatch/.test(r.err), 'the exact index-def comparison is the deciding factor');
    ok('fail-closed (c): a right-name/wrong-definition index (non-unique) is caught by exact-def comparison');
  }

  // 5d) Right columns + kind CHECK + all FKs, but a WEAKENED identity contract: id has no serial
  // default and the timestamps have no default now(). Only the PK/default/timestamp catalog checks
  // catch this — presence + business-column checks alone would pass.
  {
    const db = await freshDb();
    const c = conn(db);
    await c.unsafe(`
      create table public.fulfillment_occurrences (
        id integer primary key,             -- WRONG: no serial/nextval default
        order_id integer not null references public.orders(id),
        shipment_id integer,
        occurrence_key text not null,
        discriminator_kind text not null,
        first_seen_source text not null,
        superseded_by_occurrence_id integer references public.fulfillment_occurrences(id),
        effective_at timestamptz not null,
        created_at timestamptz not null,    -- WRONG: no default now()
        updated_at timestamptz not null,    -- WRONG: no default now()
        constraint fulfillment_occurrences_kind_chk
          check (discriminator_kind in ('provider_shipment','local_shipment','whole_order'))
      )`);
    await c.end({ timeout: 5 });
    const r = await runRunner(db, ['--apply', CONFIRM]);
    assert.notEqual(r.code, 0, 'apply over a table with a weakened id/timestamp default contract fails closed');
    assert.ok(/default/.test(r.err), 'the mismatch names the missing serial/now() defaults');
    ok('fail-closed (d): a same-named table lacking the id-serial / timestamp-default contract is caught by the catalog default checks');
  }

  // 6) Invalid-index recovery: corrupt one concurrent index into INVALID, then the runner rebuilds it.
  {
    const db = await freshDb();
    assert.equal((await runRunner(db, ['--apply', CONFIRM])).code, 0, 'baseline apply for the recovery case');
    const c = conn(db);
    await c.unsafe(`
      insert into public.fulfillment_occurrences (order_id, occurrence_key, discriminator_kind, first_seen_source, effective_at)
        values (1, 'occ:dup', 'whole_order', 't', now());
      drop index public.fulfillment_line_claims_occ_line_dir_unq;
      insert into public.fulfillment_line_claims
        (lifecycle_event_id, order_id, line_key, occurrence_id, canonical_line_identity, quantity, direction, status, idempotency_key)
        values (1,1,'d',(select id from public.fulfillment_occurrences where occurrence_key='occ:dup'),'dup',1,'deduct','pending','dup:a'),
               (1,1,'d',(select id from public.fulfillment_occurrences where occurrence_key='occ:dup'),'dup',1,'deduct','pending','dup:b');
    `);
    // Rebuild concurrently over the duplicate -> fails -> leaves an INVALID index of that name.
    try {
      await c.unsafe(`create unique index concurrently fulfillment_line_claims_occ_line_dir_unq
        on public.fulfillment_line_claims (occurrence_id, canonical_line_identity, direction) where occurrence_id is not null`);
    } catch { /* expected: duplicate */ }
    const [invRow] = await c<{ invalid: boolean }[]>`
      select (i.indisvalid = false) as invalid from pg_class cc join pg_index i on i.indexrelid=cc.oid
      where cc.relname='fulfillment_line_claims_occ_line_dir_unq'`;
    assert.equal(invRow?.invalid, true, 'the index is now INVALID');
    // Remove the duplicate so the rebuild can succeed, then let the runner recover it.
    await c.unsafe(`delete from public.fulfillment_line_claims where idempotency_key='dup:b'`);
    await c.end({ timeout: 5 });
    const r = await runRunner(db, ['--apply', CONFIRM]);
    assert.equal(r.code, 0, `recovery apply exits 0 (stderr: ${r.err})`);
    assert.ok(/dropping invalid index fulfillment_line_claims_occ_line_dir_unq/.test(r.out), 'runner drops the invalid index');
    const c2 = conn(db);
    const [valRow] = await c2<{ valid: boolean }[]>`
      select i.indisvalid as valid from pg_class cc join pg_index i on i.indexrelid=cc.oid
      where cc.relname='fulfillment_line_claims_occ_line_dir_unq'`;
    await c2.end({ timeout: 5 });
    assert.equal(valRow?.valid, true, 'the index is valid again after recovery');
    ok('invalid-index recovery: the runner drops and rebuilds an INVALID concurrent index');
  }

  // 7) Reverse-duplicate pre-audit aborts before the global reversal index.
  {
    const db = await freshDb();
    const c = conn(db);
    await c.unsafe(`
      insert into public.fulfillment_line_claims
        (lifecycle_event_id, order_id, line_key, quantity, direction, original_claim_id, status, idempotency_key)
        values (1,1,'r',2,'reverse',1,'reversed','rev:a'),
               (1,1,'r',2,'reverse',1,'reversed','rev:b');
    `);
    await c.end({ timeout: 5 });
    const r = await runRunner(db, ['--apply', CONFIRM]);
    assert.notEqual(r.code, 0, 'apply aborts when reverse duplicates exist');
    assert.ok(/reverse claim/.test(r.err), 'the abort names the reverse-duplicate cause');
    ok('reverse-duplicate pre-audit: apply refuses until an operator resolves the duplicates');
  }

  // 8) Bounded lock timeout: a held lock does not hang the apply; it fails fast.
  {
    const db = await freshDb();
    const holder = conn(db);
    await holder.unsafe('begin');
    await holder.unsafe('lock table public.order_lifecycle_events in access exclusive mode');
    const started = process.hrtime.bigint();
    const r = await runRunner(db, ['--apply', CONFIRM], { PS497_LOCK_TIMEOUT: '1s' });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    await holder.unsafe('rollback');
    await holder.end({ timeout: 5 });
    assert.notEqual(r.code, 0, 'apply fails rather than hanging when a lock is held');
    assert.ok(elapsedMs < 60_000, `apply returned promptly (${Math.round(elapsedMs)}ms), not hung`);
    ok('bounded lock timeout: a conflicting lock makes the apply fail fast instead of hanging');
  }

  // 9) Concurrent-INSERT tolerance — genuine multi-backend interleaving. Hold ROW EXCLUSIVE on
  // orders so the runner blocks at CREATE TABLE fulfillment_occurrences (AFTER its pre-snapshot);
  // while it is provably waiting, an INDEPENDENT connection inserts a new claim (higher id) and
  // commits; only then is the lock released. The bounded guard ignores the higher id, so apply succeeds.
  {
    const db = await freshDb();
    const holder = conn(db);
    await holder.unsafe('begin');
    await holder.unsafe('lock table public.orders in row exclusive mode');
    const runnerP = runRunner(db, ['--apply', CONFIRM], { PS497_LOCK_TIMEOUT: '30s' });
    await waitUntilRunnerBlocked(db);
    const injector = conn(db);
    await injector`
      insert into public.fulfillment_line_claims (lifecycle_event_id, order_id, line_key, quantity, direction, status, idempotency_key)
      values (1, 1, 'concurrent', 3, 'deduct', 'pending', 'concurrent:new')`;
    await injector.end({ timeout: 5 });
    await holder.unsafe('rollback');
    await holder.end({ timeout: 5 });
    const r = await runnerP;
    assert.equal(r.code, 0, `apply tolerates a genuinely-concurrent insert (stderr: ${r.err})`);
    assert.ok(/preexisting_claims_unchanged=true/.test(r.out), 'the concurrent insert did not trip the integrity guard');
    assert.ok(/total_rows=3/.test(r.out), 'the concurrently-inserted claim is present in the final table (real interleaving)');
    ok('concurrent-insert tolerance: an independent backend inserting a claim (higher id) during the apply window is ignored');
  }

  // 10) Concurrent-UPDATE conservative red — same real interleaving. The independent backend UPDATEs
  // a pre-existing claim's last_error (NOT part of claim_count or by_status), so ONLY the bounded md5
  // h1/h2 set-hash can catch it. The drift trips a conservative red even though the additive schema
  // applied correctly.
  {
    const db = await freshDb();
    const holder = conn(db);
    await holder.unsafe('begin');
    await holder.unsafe('lock table public.orders in row exclusive mode');
    const runnerP = runRunner(db, ['--apply', CONFIRM], { PS497_LOCK_TIMEOUT: '30s' });
    await waitUntilRunnerBlocked(db);
    const injector = conn(db);
    await injector`update public.fulfillment_line_claims set last_error = 'drift' where idempotency_key = 'seed:a'`;
    await injector.end({ timeout: 5 });
    await holder.unsafe('rollback');
    await holder.end({ timeout: 5 });
    const r = await runnerP;
    assert.notEqual(r.code, 0, 'a genuinely-concurrent update of a pre-existing claim trips a conservative red');
    assert.ok(/pre-existing claim/.test(r.err), 'the red names the pre-existing-row mutation');
    const c = conn(db);
    const [srow] = await c<{ t: string | null; drift: string | null }[]>`
      select to_regclass('public.fulfillment_occurrences')::text as t,
             (select last_error from public.fulfillment_line_claims where idempotency_key = 'seed:a') as drift`;
    await c.end({ timeout: 5 });
    assert.ok(srow?.t != null, 'the additive schema still applied despite the conservative red');
    assert.equal(srow?.drift, 'drift', 'the concurrent update really landed (real interleaving); only the md5 checksum caught it');
    ok('concurrent-update conservative red: an independent backend mutating a non-status column (caught only by the md5 checksum) fails closed after a correct apply');
  }

  // 11) Timeout bounds are real: a disabled (0) or absurd (over-max) timeout is REFUSED before connecting.
  {
    const db = await freshDb();
    const zero = await runRunner(db, ['--apply', CONFIRM], { PS497_LOCK_TIMEOUT: '0' });
    assert.notEqual(zero.code, 0, 'a unitless/zero lock_timeout is refused');
    assert.ok(/bounded timeout|bounded range/.test(zero.err), 'the refusal explains the timeout is not bounded');
    const huge = await runRunner(db, ['--apply', CONFIRM], { PS497_LOCK_TIMEOUT: '999999min' });
    assert.notEqual(huge.code, 0, 'an over-maximum lock_timeout is refused');
    assert.ok(/bounded range/.test(huge.err), 'the refusal explains the value exceeds the bounded range');
    const c = conn(db);
    const [t] = await c<{ t: string | null }[]>`select to_regclass('public.fulfillment_occurrences')::text as t`;
    await c.end({ timeout: 5 });
    assert.equal(t?.t, null, 'a refused timeout applied nothing');
    ok('timeout bounds: 0/disabled and over-maximum timeout values are refused before connecting');
  }

  // 11) Session cleanup: no runner connection lingers after the process exits. (This observes state
  // after exit, so it proves no post-exit connection leak — not that client.end() ran mid-process.)
  {
    const c = conn(appliedDb);
    const [actRow] = await c<{ n: number }[]>`
      select count(*)::int as n from pg_stat_activity where application_name = 'ps-497-migration-0104'`;
    await c.end({ timeout: 5 });
    assert.equal(actRow?.n, 0, 'no runner connection lingers after the process exits');
    ok('session cleanup: no ps-497-migration-0104 connection leaks past the runner process exit');
  }

  clearTimeout(hardTimeout);
  for (const name of made) await admin.unsafe(`drop database if exists "${name}" with (force)`);
  await admin.end({ timeout: 5 });
  console.log(`\nPASS PS-497 apply lane (PostgreSQL ${v}) — ${passed}/${passed} checks`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
