// PS-510 — PRE-FIX catalog reproduction against REAL PostgreSQL 17.
//
// Hermes requires this BEFORE any applier is changed. The claim under test is inferred from
// source, not observed: that the eight full-chain PS-497 lanes silently fail to create 0104's
// occurrence-identity objects, because their CONCURRENTLY strip is UNIQUE-blind and their
// migration loop swallows every error.
//
// This script does NOT fix anything and does NOT assert a desired outcome. It reproduces the
// CURRENT stable mechanism verbatim — the same breakpoint split, the same UNIQUE-blind regex,
// the same broad catch (see ps-497-occurrence-worker-pg17.ts:38-46) — and then reads the
// catalog back. Its job is to turn an inference into an observation, either way:
//
//   ABSENT  -> confirmed: the lanes assert behaviour against a schema-fidelity-compromised
//              database, and the PS-510 cutover is justified on the stated grounds.
//   PRESENT -> the broad catch is still unsafe, but the specific absence claim is WRONG and
//              the card must be corrected before coding.
//
// It therefore exits 0 on a successful observation of EITHER outcome. A non-zero exit means
// the reproduction itself could not run (no admin URL, not PG17, harness error) — never that
// the schema was found in one state rather than the other. Reading it as a pass/fail guard
// would defeat its purpose.
//
// No production database is used: it creates and drops its own throwaway database on the
// supplied loopback admin URL, exactly as the existing PG17 lanes do.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const ADMIN_URL = process.env.PS510_PG17_ADMIN_URL
  || process.env.PS502_PG17_ADMIN_URL
  || process.env.PS497_PG17_ADMIN_URL;
if (!ADMIN_URL) {
  console.error('FAIL: PS510_PG17_ADMIN_URL not set. Unskippable — a reproduction that skips proves nothing.');
  process.exit(1);
}
const ADMIN: string = ADMIN_URL;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The four objects 0104 is supposed to leave behind. */
const EXPECTED_INDEXES = [
  'fulfillment_line_claims_occ_line_dir_unq',
  'fulfillment_line_claims_reverse_original_unq',
] as const;
const EXPECTED_CONSTRAINTS = [
  'fulfillment_line_claims_occ_identity_present_chk',
  'fulfillment_line_claims_supply_chk',
] as const;

type Swallowed = { file: string; sqlstate: string; message: string };

/**
 * The CURRENT mechanism, copied deliberately rather than imported, so that fixing the real
 * callers later cannot silently change what this reproduction reproduced. The only difference
 * from the original is that swallowed errors are RECORDED instead of discarded — observation,
 * not behaviour: every statement is still executed, in the same order, with the same rewrite.
 */
async function migrateAllTheCurrentWay(sql: postgres.Sql): Promise<Swallowed[]> {
  const swallowed: Swallowed[] = [];
  const dir = path.join(REPO_ROOT, 'drizzle');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const body = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const raw of body.split('--> statement-breakpoint')) {
      let stmt = raw.trim();
      if (!stmt) continue;
      stmt = stmt
        .replace(/CREATE\s+INDEX\s+CONCURRENTLY/gi, 'CREATE INDEX')
        .replace(/DROP\s+INDEX\s+CONCURRENTLY/gi, 'DROP INDEX');
      try {
        await sql.unsafe(stmt);
      } catch (error) {
        swallowed.push({
          file,
          sqlstate: String((error as { code?: string }).code ?? ''),
          message: String((error as Error | null)?.message ?? error).split('\n')[0] ?? '',
        });
      }
    }
  }
  return swallowed;
}

async function main(): Promise<void> {
  const admin = postgres(ADMIN, { max: 1, prepare: false, onnotice: () => {} });
  const [ver] = await admin<{ v: number }[]>`select current_setting('server_version_num')::int as v`;
  const v = Number(ver?.v ?? 0);
  if (v < 170000 || v >= 180000) {
    console.error(`FAIL: not PostgreSQL 17 (server_version_num=${v}). The whole point is the real server.`);
    await admin.end({ timeout: 5 });
    process.exit(1);
  }
  console.log(`ok   server is PostgreSQL 17 (server_version_num ${v})`);

  const dbName = `ps510_prefix_${v}_${process.pid}`;
  await admin.unsafe(`drop database if exists "${dbName}" with (force)`);
  await admin.unsafe(`create database "${dbName}"`);
  const target = ADMIN.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`);
  const db = postgres(target, { max: 1, prepare: false, onnotice: () => {} });

  try {
    const swallowed = await migrateAllTheCurrentWay(db);

    console.log(`\n--- swallowed migration failures: ${swallowed.length} ---`);
    for (const s of swallowed) console.log(`  ${s.file} [${s.sqlstate}]: ${s.message}`);

    const from0104 = swallowed.filter((s) => s.file.startsWith('0104_'));
    console.log(`\n--- of those, from 0104: ${from0104.length} ---`);

    const indexes = await db<{ indexname: string; indisvalid: boolean; indexdef: string }[]>`
      select c.relname as indexname, i.indisvalid, pg_get_indexdef(i.indexrelid) as indexdef
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where c.relname = any(${EXPECTED_INDEXES as unknown as string[]})`;
    const constraints = await db<{ conname: string; convalidated: boolean; condef: string }[]>`
      select con.conname, con.convalidated, pg_get_constraintdef(con.oid) as condef
      from pg_constraint con
      where con.conname = any(${EXPECTED_CONSTRAINTS as unknown as string[]})`;

    console.log('\n--- catalog readback: indexes ---');
    for (const name of EXPECTED_INDEXES) {
      const row = indexes.find((r) => r.indexname === name);
      console.log(row
        ? `  PRESENT  ${name}  indisvalid=${row.indisvalid}\n           ${row.indexdef}`
        : `  ABSENT   ${name}`);
    }
    console.log('\n--- catalog readback: constraints ---');
    for (const name of EXPECTED_CONSTRAINTS) {
      const row = constraints.find((r) => r.conname === name);
      console.log(row
        ? `  PRESENT  ${name}  convalidated=${row.convalidated}\n           ${row.condef}`
        : `  ABSENT   ${name}`);
    }

    const missing = [
      ...EXPECTED_INDEXES.filter((n) => !indexes.some((r) => r.indexname === n)),
      ...EXPECTED_CONSTRAINTS.filter((n) => !constraints.some((r) => r.conname === n)),
    ];
    const invalid = indexes.filter((r) => !r.indisvalid).map((r) => r.indexname);
    const unvalidated = constraints.filter((r) => !r.convalidated).map((r) => r.conname);

    console.log('\n==================== VERDICT ====================');
    if (missing.length === 0 && invalid.length === 0 && unvalidated.length === 0) {
      console.log('PRESENT — all four objects exist, valid and validated, DESPITE the swallowed');
      console.log('failures. The broad catch remains unsafe, but PS-510\'s specific absence claim');
      console.log('is WRONG and the card must be corrected before the cutover is written.');
    } else {
      console.log('ABSENT/COMPROMISED — the current mechanism does not leave 0104 in its intended state.');
      if (missing.length) console.log(`  missing entirely : ${missing.join(', ')}`);
      if (invalid.length) console.log(`  present, invalid : ${invalid.join(', ')}`);
      if (unvalidated.length) console.log(`  present, unvalidated: ${unvalidated.join(', ')}`);
      console.log('Confirms: the eight lanes assert behaviour against a schema-fidelity-compromised');
      console.log('database. PS-510 cutover is justified on the stated grounds.');
    }
    console.log('================================================');
    console.log('\nObservation complete. This script does not pass or fail on the verdict.');
  } finally {
    await db.end({ timeout: 5 });
    await admin.unsafe(`drop database if exists "${dbName}" with (force)`);
    await admin.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error('FAIL: the reproduction itself could not run.');
  console.error(error);
  process.exit(1);
});
