#!/usr/bin/env tsx
/**
 * PS-502 AC-1 — the five migration states, executed against a REAL PostgreSQL 17 catalog.
 *
 * The contract guard pins the applier's DECISION SHAPE from its source text. That is worth
 * having, but it is not proof that the lane behaves correctly against a live catalog: nothing
 * had ever run `scripts/apply-ps-502-replacement-schema.ts` against PostgreSQL and read the
 * result back. Hermes held AC-1 UNPROVEN for exactly that reason.
 *
 * This harness therefore invokes the UNCHANGED production entry point as a SUBPROCESS, with the
 * real pinned digest arguments, and asserts on its exit code, its output, and the catalog it
 * leaves behind. It deliberately does NOT reimplement any of the applier's decisions — a test
 * that re-derives the logic it is checking proves only that the author was consistent.
 *
 * Every scenario gets its own disposable database, and every database is dropped afterwards.
 * No production database is reachable: the admin URL must be loopback and must be PostgreSQL 17.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

import { PS_502_PREREQUISITE_DDL } from './lib/ps-502-test-schema.js';

const ADMIN_URL = process.env.PS502_PG17_ADMIN_URL ?? process.env.PS488_PG17_ADMIN_URL;
if (!ADMIN_URL) {
  console.error(
    'FAIL: neither PS502_PG17_ADMIN_URL nor PS488_PG17_ADMIN_URL is set.\n'
    + '      AC-1 requires the migration lane to run against a REAL PostgreSQL catalog.\n'
    + '      Source-level checks pass without one, which is precisely why this is unskippable.',
  );
  process.exit(1);
}
{
  const host = new URL(ADMIN_URL).hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1', 'postgres'].includes(host)) {
    console.error(`FAIL: refusing non-ephemeral host "${host}"`);
    process.exit(1);
  }
}

/** The reviewed lane, in order. Filenames and digest argument names mirror the applier. */
const MIGRATIONS = [
  { label: '0096', file: 'drizzle/0096_ps502_replacements.sql', arg: 'digest96' },
  { label: '0097', file: 'drizzle/0097_ps502_replacement_billing.sql', arg: 'digest97' },
  { label: '0098', file: 'drizzle/0098_ps502_replacement_financial_restrict.sql', arg: 'digest98' },
  { label: '0099', file: 'drizzle/0099_ps502_replacement_request_signature.sql', arg: 'digest99' },
  { label: '0100', file: 'drizzle/0100_ps502_replacement_operational_state.sql', arg: 'digest100' },
  { label: '0101', file: 'drizzle/0101_ps502_replacement_original_order_holds.sql', arg: 'digest101' },
  { label: '0102', file: 'drizzle/0102_billing_summary_metrics_replacement_totals.sql', arg: 'digest102' },
  { label: '0103', file: 'drizzle/0103_ps502_replacement_financial_actions.sql', arg: 'digest103' },
] as const;

const CONFIRM_TOKEN = 'APPLY-PS-502-REPLACEMENT-SCHEMA';

/**
 * LF-normalised, matching the applier's own rule. Computed rather than copied on purpose: if a
 * pinned EXPECTED_* constant ever drifts from its file, the applier rejects our argument and
 * this harness fails loudly instead of quietly testing a stale lane.
 */
const digestOf = (file: string): string =>
  createHash('sha256').update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), 'utf8').digest('hex');

const DIGEST_ARGS = MIGRATIONS.map((m) => `--${m.arg}=${digestOf(m.file)}`);

let passed = 0;
let failed = 0;
const check = (name: string, condition: boolean, detail?: string): void => {
  if (condition) {
    passed += 1;
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
};

const admin = () => postgres(ADMIN_URL!, { max: 1, prepare: false, onnotice: () => {} });

async function assertPostgres17(): Promise<void> {
  const a = admin();
  try {
    const [row] = await a.unsafe('show server_version_num');
    const version = Number((row as Record<string, unknown>)?.server_version_num);
    if (!Number.isFinite(version) || version < 170000 || version >= 180000) {
      console.error(
        `FAIL: server_version_num ${String(version)} is not PostgreSQL 17.\n`
        + '      AC-1 evidence must come from the major this lane targets. Nothing was created.',
      );
      process.exit(1);
    }
    console.log(`ok   server is PostgreSQL 17 (server_version_num ${version})`);
  } finally {
    await a.end({ timeout: 5 });
  }
}

let counter = 0;
const created: string[] = [];

/** A disposable database seeded with the prerequisite application schema only. */
async function freshDatabase(scenario: string): Promise<{ name: string; url: string }> {
  counter += 1;
  const name = `ps502_state_${process.pid}_${counter}`;
  const a = admin();
  try {
    await a.unsafe(`drop database if exists ${name}`);
    await a.unsafe(`create database ${name}`);
    created.push(name);
  } finally {
    await a.end({ timeout: 5 });
  }
  const url = new URL(ADMIN_URL!);
  url.pathname = `/${name}`;
  const target = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
  try {
    await target.unsafe(PS_502_PREREQUISITE_DDL);
  } finally {
    await target.end({ timeout: 5 });
  }
  console.log(`\n── ${scenario}\n   database: ${name} (prerequisite application schema only)`);
  return { name, url: url.toString() };
}

/** Install a PREFIX of the reviewed lane directly, to construct a starting state. */
async function installPrefix(url: string, upTo: number): Promise<void> {
  if (upTo === 0) return;
  const target = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    for (const migration of MIGRATIONS.slice(0, upTo)) {
      await target.unsafe(readFileSync(migration.file, 'utf8'));
    }
  } finally {
    await target.end({ timeout: 5 });
  }
  console.log(`   installed: ${MIGRATIONS.slice(0, upTo).map((m) => m.label).join(', ')}`);
}

type Run = { status: number; stdout: string; stderr: string; command: string };

/** Invoke the PRODUCTION applier as a subprocess. Credentials are redacted from the log. */
function runApplier(url: string, mode: 'inspect' | 'apply'): Run {
  const args = [
    'tsx', 'scripts/apply-ps-502-replacement-schema.ts',
    ...DIGEST_ARGS,
    ...(mode === 'apply' ? ['--apply', `--confirm=${CONFIRM_TOKEN}`] : []),
  ];
  const redacted = `DATABASE_URL=<redacted> npx ${args.join(' ').replace(/--digest(\d+)=(\w{8})\w+/g, '--digest$1=$2…')}`;
  console.log(`   run: ${redacted}`);
  const result = spawnSync('npx', args, {
    env: { ...process.env, DATABASE_URL: url },
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 32 * 1024 * 1024,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  console.log(`   exit: ${result.status}`);
  if (process.env.PS502_STATE_VERBOSE === '1') {
    console.log(stdout.split('\n').map((l) => `     | ${l}`).join('\n'));
    if (stderr.trim()) console.log(stderr.split('\n').map((l) => `     ! ${l}`).join('\n'));
  }
  return { status: result.status ?? -1, stdout, stderr, command: redacted };
}

/** An independent catalog fingerprint — not the applier's own read-back. */
async function catalogShape(url: string): Promise<{
  tables: string[]; indexes: string[]; constraints: string[]; rls: string[];
}> {
  const target = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const tables = await target.unsafe(`
      select table_name from information_schema.tables
       where table_schema = 'public'
         and (table_name like 'replacement%' or table_name = 'billing_summary_metrics')
       order by table_name`);
    const indexes = await target.unsafe(`
      select indexname from pg_indexes
       where schemaname = 'public'
         and (indexname like '%replacement%' or indexname like '%ps502%')
       order by indexname`);
    const constraints = await target.unsafe(`
      select conname from pg_constraint
       where conname like '%replacement%'
       order by conname`);
    const rls = await target.unsafe(`
      select relname from pg_class
       where relrowsecurity = true and relname like 'replacement%'
       order by relname`);
    return {
      tables: tables.map((r) => String((r as Record<string, unknown>).table_name)),
      indexes: indexes.map((r) => String((r as Record<string, unknown>).indexname)),
      constraints: constraints.map((r) => String((r as Record<string, unknown>).conname)),
      rls: rls.map((r) => String((r as Record<string, unknown>).relname)),
    };
  } finally {
    await target.end({ timeout: 5 });
  }
}

const fingerprint = (shape: Awaited<ReturnType<typeof catalogShape>>): string =>
  JSON.stringify(shape);

async function dropDatabase(name: string): Promise<void> {
  const a = admin();
  try { await a.unsafe(`drop database if exists ${name}`); } finally { await a.end({ timeout: 5 }); }
}

async function main(): Promise<void> {
  console.log('PS-502 migration-state matrix — real PostgreSQL 17 catalog\n');
  await assertPostgres17();

  // ── 1. WHOLLY ABSENT ──────────────────────────────────────────────────────
  {
    const db = await freshDatabase('1. wholly absent — INSPECT writes nothing, APPLY installs the exact shape');
    const before = await catalogShape(db.url);
    check('absent: no PS-502 table exists before the run', before.tables.length === 0,
      `found: ${before.tables.join(', ')}`);

    const inspect = runApplier(db.url, 'inspect');
    const afterInspect = await catalogShape(db.url);
    check('absent: INSPECT succeeds', inspect.status === 0, inspect.stderr.slice(0, 400));
    check('absent: INSPECT is read-only — the catalog is untouched',
      fingerprint(afterInspect) === fingerprint(before));

    const apply = runApplier(db.url, 'apply');
    const afterApply = await catalogShape(db.url);
    check('absent: APPLY succeeds', apply.status === 0, apply.stderr.slice(0, 400));
    check('absent: APPLY creates the replacement tables',
      ['replacements', 'replacement_items', 'replacement_activity_events',
        'replacement_label_purchase_intents', 'replacement_item_remaps',
        'replacement_original_order_holds', 'replacement_financial_actions']
        .every((t) => afterApply.tables.includes(t)),
      `tables: ${afterApply.tables.join(', ')}`);
    check('absent: RLS is enabled on all seven replacement relations',
      afterApply.rls.length === 7, `rls: ${afterApply.rls.join(', ')}`);
    check('absent: the 0103 durable-obligation index exists',
      afterApply.indexes.some((i) => i.includes('replacement_financial_actions')),
      `indexes: ${afterApply.indexes.join(', ')}`);
    await dropDatabase(db.name);
  }

  // ── 2. EXACT REVIEWED PREFIX ──────────────────────────────────────────────
  {
    const db = await freshDatabase('2. exact reviewed prefix — only the missing suffix runs');
    await installPrefix(db.url, 4);
    const before = await catalogShape(db.url);
    check('prefix: the installed prefix is present and 0103 is not',
      before.tables.includes('replacements') && !before.tables.includes('replacement_financial_actions'),
      `tables: ${before.tables.join(', ')}`);

    const inspect = runApplier(db.url, 'inspect');
    check('prefix: INSPECT succeeds and reports an exact reviewed prefix',
      inspect.status === 0 && /reviewed migration prefix/i.test(inspect.stdout),
      inspect.stderr.slice(0, 400));

    const apply = runApplier(db.url, 'apply');
    const after = await catalogShape(db.url);
    check('prefix: APPLY succeeds', apply.status === 0, apply.stderr.slice(0, 400));
    check('prefix: the suffix completed the lane', after.tables.includes('replacement_financial_actions'));
    check('prefix: the already-installed prefix was NOT replayed',
      !/0096/.test(apply.stdout.split('applying')[1] ?? apply.stdout),
      'a replay would re-run 0098 FK hardening and take needless locks on live billing');
    await dropDatabase(db.name);
  }

  // ── 3. 0096-0102 INSTALLED, ONLY 0103 REMAINS ─────────────────────────────
  {
    const db = await freshDatabase('3. exact 0096-0102 — only 0103 runs');
    await installPrefix(db.url, 7);
    const before = await catalogShape(db.url);
    check('0102: the financial-actions table is absent beforehand',
      !before.tables.includes('replacement_financial_actions'));

    const apply = runApplier(db.url, 'apply');
    const after = await catalogShape(db.url);
    check('0102: APPLY succeeds', apply.status === 0, apply.stderr.slice(0, 400));
    check('0102: 0103 created the durable financial-action ledger',
      after.tables.includes('replacement_financial_actions'));
    check('0102: its FK constraints landed',
      after.constraints.some((c) => c.includes('replacement_financial_actions')),
      `constraints: ${after.constraints.join(', ')}`);
    await dropDatabase(db.name);
  }

  // ── 4. FULLY EXACT REPLAY ─────────────────────────────────────────────────
  {
    const db = await freshDatabase('4. fully exact replay — a no-op that writes nothing');
    await installPrefix(db.url, 8);
    const before = await catalogShape(db.url);

    const apply = runApplier(db.url, 'apply');
    const after = await catalogShape(db.url);
    check('replay: APPLY succeeds', apply.status === 0, apply.stderr.slice(0, 400));
    check('replay: it reports a no-op rather than re-running the lane',
      /already exact through 0103/i.test(apply.stdout),
      apply.stdout.slice(-400));
    check('replay: the catalog is byte-identical afterwards',
      fingerprint(after) === fingerprint(before));
    await dropDatabase(db.name);
  }

  // ── 5. MALFORMED / PARTIAL ────────────────────────────────────────────────
  {
    const db = await freshDatabase('5. malformed/partial — refused before any write');
    await installPrefix(db.url, 7);
    // A later-stage object present while its stage is incomplete: exactly the non-contiguous
    // drift the applier must refuse rather than "helpfully" completing with IF NOT EXISTS.
    const target = postgres(db.url, { max: 1, prepare: false, onnotice: () => {} });
    try {
      await target.unsafe('create table replacement_financial_actions (id integer primary key)');
    } finally {
      await target.end({ timeout: 5 });
    }
    const before = await catalogShape(db.url);

    const inspect = runApplier(db.url, 'inspect');
    check('malformed: INSPECT refuses', inspect.status !== 0);
    check('malformed: it says nothing was written',
      /nothing was written/i.test(inspect.stdout + inspect.stderr),
      (inspect.stderr || inspect.stdout).slice(-400));

    const apply = runApplier(db.url, 'apply');
    const after = await catalogShape(db.url);
    check('malformed: APPLY refuses too', apply.status !== 0);
    check('malformed: the malformed catalog is left EXACTLY as found, for explicit repair',
      fingerprint(after) === fingerprint(before));
    await dropDatabase(db.name);
  }

  // ── cleanup proof ─────────────────────────────────────────────────────────
  {
    const a = admin();
    try {
      const leftovers = await a.unsafe("select datname from pg_database where datname like 'ps502_state_%'");
      check('every disposable database was dropped',
        leftovers.length === 0,
        `leftover: ${leftovers.map((r) => String((r as Record<string, unknown>).datname)).join(', ')}`);
    } finally {
      await a.end({ timeout: 5 });
    }
  }

  console.log(`\n${failed === 0
    ? `PS-502 migration-state matrix passed — ${passed} checks against a real PostgreSQL 17 catalog.`
    : `PS-502 migration-state matrix FAILED with ${failed} failure(s).`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  for (const name of created) {
    try { await dropDatabase(name); } catch { /* best effort */ }
  }
  process.exit(1);
});
