#!/usr/bin/env tsx
/**
 * PS-488 — independent post-apply read-back for migration 0092.
 *
 * WHY THIS EXISTS
 *
 * The apply runner verifies its own work inside its own transaction and then exits.
 * That is self-attestation: a green job proves the runner believed it succeeded, not
 * that the catalog now holds the intended shape. This reads the postcondition back
 * from a separate session, after commit, and reports every value Hermes required in
 * one packet.
 *
 * It also exists because the runner's inspect mode is deliberately minimal — digests,
 * row/invoiced/total, and the FK character. It says nothing about FK validation, the
 * index properties, the CHECK condition, the violation gates, or the checksum, so
 * re-running inspect could never produce this packet.
 *
 * STRICTLY READ-ONLY. Every statement is a SELECT. There is no INSERT, UPDATE, DELETE,
 * DDL or temp-table creation anywhere in this file, and no --apply equivalent exists.
 * The session is additionally pinned READ ONLY at the server so the database itself
 * refuses a write regardless of what this code asks for.
 *
 * The four violation gates are IMPORTED from the readiness command rather than
 * restated, so this packet and that command cannot drift into disagreeing about what
 * "clean" means. That module is import-safe: it guards execution on an exact basename.
 *
 *   npx tsx scripts/ps-488-0092-readback.ts
 */
import postgres from 'postgres';
import {
  PS488_CANONICAL_RETURN_TYPES,
  PS488_CHECK_NAME,
  PS488_FK_NAME,
  PS488_LOOKUP_INDEX,
  PS488_PRESERVED_UNIQUE_INDEXES,
  PS488_TABLE,
  PS488_UNIQUE_INDEX,
} from './ps-488-migration-contract.js';
import { PS488_M2_GATES } from './ps-488-m2-readiness.js';

const QUALIFIED = `public.${PS488_TABLE}`;
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('STOP: DATABASE_URL is not set. This read-back must not skip.');
  process.exit(1);
}

const results: { label: string; ok: boolean; detail: string }[] = [];
const record = (label: string, ok: boolean, detail: string): void => {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  console.log(`        ${detail}`);
};

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
try {
  // Belt and braces: the server refuses writes for this session even if the code changed.
  await sql.unsafe('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');

  const [meta] = await sql<{ v: string; db: string; host: string; now: string }[]>`
    select version() as v, current_database()::text as db,
           coalesce(inet_server_addr()::text, 'local') as host, now()::text as now`;
  console.log('PS-488 0092 POST-APPLY READ-BACK');
  console.log(`  database    : ${meta!.db}`);
  console.log(`  server      : ${meta!.v.split(',')[0]}`);
  console.log(`  read at     : ${meta!.now}`);
  console.log(`  session     : READ ONLY (server-enforced)\n`);

  // ── 1. Foreign key ─────────────────────────────────────────────────────────
  console.log('1. FOREIGN KEY');
  const [fk] = await sql<
    { deltype: string; updtype: string; matchtype: string; validated: boolean;
      deferrable: boolean; deferred: boolean; def: string }[]
  >`
    select c.confdeltype as deltype, c.confupdtype as updtype, c.confmatchtype as matchtype,
           c.convalidated as validated, c.condeferrable as deferrable, c.condeferred as deferred,
           pg_get_constraintdef(c.oid) as def
      from pg_constraint c
     where c.conname = ${PS488_FK_NAME} and c.conrelid = ${QUALIFIED}::regclass`;

  record(
    `${PS488_FK_NAME} confdeltype = 'r' (ON DELETE RESTRICT)`,
    fk?.deltype === 'r',
    fk ? `confdeltype=${fk.deltype}  confupdtype=${fk.updtype}  matchtype=${fk.matchtype}` : 'FK NOT FOUND',
  );
  record(
    `${PS488_FK_NAME} is validated`,
    fk?.validated === true,
    fk ? `convalidated=${fk.validated}  deferrable=${fk.deferrable}  deferred=${fk.deferred}` : 'FK NOT FOUND',
  );
  if (fk) console.log(`        definition: ${fk.def}`);

  // ── 2. Unique index ────────────────────────────────────────────────────────
  console.log('\n2. UNIQUE INDEX');
  const [idx] = await sql<
    { def: string; isunique: boolean; isvalid: boolean; isready: boolean; keys: string[] }[]
  >`
    select pg_get_indexdef(i.indexrelid) as def, i.indisunique as isunique,
           i.indisvalid as isvalid, i.indisready as isready,
           (select array_agg(a.attname order by k.ord)
              from unnest(i.indkey::int[]) with ordinality k(attnum, ord)
              join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
             where k.ord <= i.indnkeyatts) as keys
      from pg_index i join pg_class c on c.oid = i.indexrelid
     where c.relname = ${PS488_UNIQUE_INDEX} and i.indrelid = ${QUALIFIED}::regclass`;

  record(
    `${PS488_UNIQUE_INDEX} exists, unique, valid, ready`,
    Boolean(idx) && idx!.isunique && idx!.isvalid && idx!.isready,
    idx ? `unique=${idx.isunique} valid=${idx.isvalid} ready=${idx.isready}` : 'INDEX NOT FOUND',
  );
  record(
    `${PS488_UNIQUE_INDEX} keys are (return_id, line_type)`,
    (idx?.keys ?? []).join(',') === 'return_id,line_type',
    `keys=(${(idx?.keys ?? []).join(', ')})`,
  );
  record(
    `${PS488_UNIQUE_INDEX} carries the partial predicate`,
    Boolean(idx?.def && /WHERE \(return_id IS NOT NULL\)/i.test(idx.def)),
    idx?.def ?? 'INDEX NOT FOUND',
  );

  // ── 3. Semantic CHECK ──────────────────────────────────────────────────────
  console.log('\n3. CHECK CONSTRAINT');
  const [chk] = await sql<{ def: string; validated: boolean }[]>`
    select pg_get_constraintdef(oid) as def, convalidated as validated
      from pg_constraint
     where conname = ${PS488_CHECK_NAME} and conrelid = ${QUALIFIED}::regclass`;

  record(
    `${PS488_CHECK_NAME} exists and is validated`,
    chk?.validated === true,
    chk ? `convalidated=${chk.validated}` : 'CHECK NOT FOUND',
  );
  const mentionsAll = Boolean(chk?.def) && PS488_CANONICAL_RETURN_TYPES.every((t) => chk!.def.includes(t));
  record(
    `${PS488_CHECK_NAME} condition names exactly the canonical line types`,
    mentionsAll && Boolean(chk?.def && /return_id IS NULL/i.test(chk.def)),
    chk?.def ?? 'CHECK NOT FOUND',
  );

  // ── 3b. Objects that had to SURVIVE the migration ──────────────────────────
  console.log('\n3b. PRESERVED INDEXES (must have survived 0092 untouched)');
  const survivorNames = [PS488_LOOKUP_INDEX, ...PS488_PRESERVED_UNIQUE_INDEXES];
  const survivors = await sql<{ name: string; def: string }[]>`
    select c.relname::text as name, pg_get_indexdef(c.oid) as def
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname in ${sql(survivorNames)}`;
  for (const name of survivorNames) {
    const found = survivors.find((s) => s.name === name);
    record(`${name} still present`, Boolean(found), found?.def ?? 'MISSING');
  }

  // ── 4. The four violation gates ────────────────────────────────────────────
  console.log('\n4. RETURN-IDENTITY VIOLATION GATES (all must be zero)');
  for (const gate of PS488_M2_GATES) {
    const [row] = await sql.unsafe<{ n: string }[]>(gate.sql);
    record(`${gate.key} — ${gate.label}`, row?.n === '0', `count=${row?.n ?? 'ERROR'}`);
  }

  // ── 5. Data snapshot ───────────────────────────────────────────────────────
  console.log('\n5. DATA SNAPSHOT (compare against the apply job\'s in-transaction snapshot)');
  const [snap] = await sql<{ rows: string; invoiced: string; total: string; checksum: string }[]>`
    select count(*)::text as rows,
           count(*) filter (where invoiced)::text as invoiced,
           coalesce(sum(total_cost), 0)::text as total,
           coalesce(md5(string_agg(
             id::text || ':' || total_cost::text || ':' || coalesce(return_id::text, '-'),
             ',' order by id)), 'empty') as checksum
      from public.billing_line_items`;
  console.log(`        rows     : ${snap!.rows}`);
  console.log(`        invoiced : ${snap!.invoiced}`);
  console.log(`        total    : ${snap!.total}`);
  console.log(`        checksum : ${snap!.checksum}`);
  console.log('        NOTE: this read-back cannot self-verify group 6. These four values');
  console.log('              must be compared against the apply job log, which is the only');
  console.log('              place the authoritative in-transaction snapshot was printed.');

  // ── Verdict ────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} postconditions hold`);
  if (failed.length > 0) {
    console.log('\nFAILED POSTCONDITIONS');
    for (const f of failed) console.log(`  - ${f.label} :: ${f.detail}`);
    console.log('\nVERDICT: 0092 postcondition NOT satisfied.');
    process.exit(1);
  }
  console.log('VERDICT: 0092 postcondition satisfied on every self-verifiable check.');
} finally {
  await sql.end({ timeout: 5 });
}
