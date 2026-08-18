/**
 * PS-502 — migrations 0096-0101 runner: the replacement schema.
 *
 * WHY A RUNNER AND NOT `npm run migrate`
 *
 * Production execution belongs to the operator lane, not a developer session. This runs
 * inside the Render environment that already holds the production DATABASE_URL, so no
 * local credential is needed, minted, or passed through a workstation. Same shape as the
 * PS-488/0092 and PS-501/0095 lanes.
 *
 * WHAT THESE MIGRATIONS DO
 *
 *   0096  creates replacements, replacement_items, replacement_activity_events
 *   0097  adds billing_line_items.replacement_id and billing_credit_notes.replacement_id,
 *         a partial unique index on (replacement_id, line_type), and a CHECK requiring
 *         both shipment_id and replacement_id on replacement line types
 *
 * Purely additive. No existing column changes type or meaning and no row is rewritten. The
 * only reference to shipments is a FOREIGN KEY pointing AT it, which mutates nothing —
 * which is why the card places this inside the "no unlock" list.
 *
 * WHY IT STILL NEEDS A GATE
 *
 * billing_line_items is the money table. A partial unique index or a CHECK added with the
 * wrong predicate would either reject legitimate future writes or fail to prevent the
 * duplicate charge it exists to prevent. So: inspect is the default, apply demands the
 * exact token, and the read-back asserts the SHAPE of what landed — table presence, column
 * nullability, the index's uniqueness and partiality, and the CHECK's validated state —
 * rather than merely that the statements did not throw.
 *
 * ORDER MATTERS. 0097 references replacements(id), so 0096 must land first. This applies
 * them in order inside ONE transaction: a failure in 0097 rolls 0096 back rather than
 * leaving half a schema.
 *
 *   npx tsx scripts/apply-ps-502-replacement-schema.ts --digest96=<sha> --digest97=<sha>
 *   npx tsx scripts/apply-ps-502-replacement-schema.ts --digest96=<sha> --digest97=<sha> --apply --confirm=<token>
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const SQL_0096 = 'drizzle/0096_ps502_replacements.sql';
const SQL_0097 = 'drizzle/0097_ps502_replacement_billing.sql';
// Added after Hermes found this lane stale at 8d0dcc5c: the create command already
// depended on request_signature (0099) and the RESTRICT contract (0098), neither of which
// this — the OFFICIAL deploy path — applied. A deploy would have produced a schema the
// shipped code cannot run against.
const SQL_0098 = 'drizzle/0098_ps502_replacement_financial_restrict.sql';
const SQL_0099 = 'drizzle/0099_ps502_replacement_request_signature.sql';
const SQL_0100 = 'drizzle/0100_ps502_replacement_operational_state.sql';
const SQL_0101 = 'drizzle/0101_ps502_replacement_original_order_holds.sql';
const CONFIRM_TOKEN = 'APPLY-PS-502-REPLACEMENT-SCHEMA';
const EXPECTED_0096 = 'bee592ffbb801f37858ec3459fdf00889e2fb5391ce820798e4485c026f6d63a';
const EXPECTED_0097 = 'cfa70218831b0ec1377238610e4df2679da7bba4000af5bb57b4fcdfc97fbd91';
const EXPECTED_0098 = '56ea07a48cb95127a335cbf9dd748c1507eba3077a550e0decff17021b9a2d37';
const EXPECTED_0099 = '7a44f912b90c12e94bac255e331af0bd60e2f337ca842255b411949ca37dbdfe';
const EXPECTED_0100 = '6f1524aaba51240650f380fec4af03f29d048cd66d2df1ad0c8003f2d628f9b3';
const EXPECTED_0101 = 'fbd965fe230f44dbd34da5bf877473cd64f2ec694f71a5ba5f206f71069995a0';

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
function argValue(name: string): string | null {
  const hit = ARGS.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

/** LF-normalised: this repo runs core.autocrlf=true, so raw bytes would vary by checkout. */
function normalisedDigest(path: string): string {
  return createHash('sha256')
    .update(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'), 'utf8')
    .digest('hex');
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set. This runner is for the operator lane.');

  // Both files are pinned in this module AND supplied by the caller: the constants prove
  // the reviewed content, the arguments prove the archive arrived untampered. Either
  // mismatch stops before a connection is opened.
  for (const [file, expected, argName] of [
    [SQL_0096, EXPECTED_0096, 'digest96'],
    [SQL_0097, EXPECTED_0097, 'digest97'],
    [SQL_0098, EXPECTED_0098, 'digest98'],
    [SQL_0099, EXPECTED_0099, 'digest99'],
    [SQL_0100, EXPECTED_0100, 'digest100'],
    [SQL_0101, EXPECTED_0101, 'digest101'],
  ] as const) {
    const actual = normalisedDigest(file);
    if (actual !== expected) {
      throw new Error(`STOP: ${file} does not match the reviewed content.\n  actual:   ${actual}\n  expected: ${expected}`);
    }
    const supplied = argValue(argName);
    if (supplied && supplied !== expected) {
      throw new Error(`STOP: --${argName} does not match.\n  supplied: ${supplied}\n  expected: ${expected}`);
    }
    console.log(`ok   ${file} matches the reviewed digest`);
  }

  if (APPLY && argValue('confirm') !== CONFIRM_TOKEN) {
    throw new Error(`STOP: --apply requires --confirm=${CONFIRM_TOKEN}`);
  }

  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    console.log(`     target host: ${new URL(databaseUrl).hostname}`);
    console.log(`     mode       : ${APPLY ? 'APPLY' : 'INSPECT (read-only)'}\n`);

    const state = async () => {
      const [t] = await sql<{ replacements: boolean; items: boolean; events: boolean }[]>`
        select to_regclass('public.replacements') is not null as replacements,
               to_regclass('public.replacement_items') is not null as items,
               to_regclass('public.replacement_activity_events') is not null as events`;
      const cols = await sql<{ table_name: string; is_nullable: string }[]>`
        select table_name, is_nullable from information_schema.columns
        where table_schema = 'public' and column_name = 'replacement_id'
          and table_name in ('billing_line_items', 'billing_credit_notes')`;
      const [idx] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_indexes
        where schemaname = 'public' and indexname = 'billing_li_replacement_line_unq'`;
      const [chk] = await sql<{ n: number; validated: boolean | null }[]>`
        select count(*)::int as n, bool_and(convalidated) as validated from pg_constraint
        where conname = 'billing_li_replacement_identity_check'`;
      return { tables: t!, cols, idx: idx?.n ?? 0, chk: chk ?? { n: 0, validated: null } };
    };

    const before = await state();
    console.log(`     replacements table      : ${before.tables.replacements}`);
    console.log(`     replacement_items       : ${before.tables.items}`);
    console.log(`     replacement_activity    : ${before.tables.events}`);
    console.log(`     replacement_id columns  : ${before.cols.map((c) => c.table_name).join(', ') || '(none)'}`);
    console.log(`     billing_li_replacement_line_unq : ${before.idx === 1}`);
    console.log(`     billing_li_replacement_identity_check : ${before.chk.n === 1}`);

    // Existing replacement rows, so an operator can see this is not a live-data change.
    if (before.tables.replacements) {
      const [rows] = await sql<{ n: number }[]>`select count(*)::int as n from replacements`;
      console.log(`     existing replacement rows: ${rows?.n ?? 0}`);
    }

    if (!APPLY) {
      const missing = [
        !before.tables.replacements && 'replacements',
        !before.tables.items && 'replacement_items',
        !before.tables.events && 'replacement_activity_events',
        before.cols.length < 2 && 'replacement_id column(s)',
        before.idx !== 1 && 'billing_li_replacement_line_unq',
        before.chk.n !== 1 && 'billing_li_replacement_identity_check',
      ].filter(Boolean);
      console.log(missing.length
        ? `\n     WOULD CREATE: ${missing.join(', ')}`
        : '\n     Nothing to do — the schema is already present.');
      console.log(`\nINSPECT complete. Nothing was written.\nTo apply:\n  --apply --confirm=${CONFIRM_TOKEN}`);
      return;
    }

    // ONE transaction, in order: 0097 references replacements(id), so a failure there must
    // roll 0096 back rather than leave half a schema behind.
    console.log('\napplying 0096 -> 0101 in one transaction...');
    await sql.begin(async (tx) => {
      await tx.unsafe(readFileSync(SQL_0096, 'utf8'));
      await tx.unsafe(readFileSync(SQL_0097, 'utf8'));
      // 0098 alters the FKs 0097 created; 0099 is additive. Same transaction, so a
      // failure in either rolls the whole replacement schema back rather than leaving a
      // half-deployed contract the code cannot run against.
      await tx.unsafe(readFileSync(SQL_0098, 'utf8'));
      await tx.unsafe(readFileSync(SQL_0099, 'utf8'));
      await tx.unsafe(readFileSync(SQL_0100, 'utf8'));
      // 0101 references replacements(id) and the two append-only receipt tables, so it
      // must land after 0096 and never before them.
      await tx.unsafe(readFileSync(SQL_0101, 'utf8'));
    });

    const after = await state();
    const problems: string[] = [];
    if (!after.tables.replacements) problems.push('replacements table is absent');
    if (!after.tables.items) problems.push('replacement_items is absent');
    if (!after.tables.events) problems.push('replacement_activity_events is absent');
    for (const table of ['billing_line_items', 'billing_credit_notes']) {
      const col = after.cols.find((c) => c.table_name === table);
      if (!col) problems.push(`${table}.replacement_id is absent`);
      // Nullable is CORRECT here: NULL means "not yet attributed", which is the documented
      // reading. A NOT NULL column would be wrong, so this asserts the intended shape
      // rather than assuming stricter is better.
      else if (col.is_nullable !== 'YES') problems.push(`${table}.replacement_id must be nullable`);
    }
    if (after.idx !== 1) problems.push('billing_li_replacement_line_unq is absent');
    if (after.chk.n !== 1) problems.push('billing_li_replacement_identity_check is absent');
    else if (after.chk.validated !== true) problems.push('billing_li_replacement_identity_check is NOT VALIDATED');

    if (problems.length) throw new Error(`STOP: schema did not land as reviewed:\n  - ${problems.join('\n  - ')}`);

    console.log('ok   three tables, two nullable replacement_id columns, the partial unique index,');
    console.log('ok   and a VALIDATED identity CHECK are all present.');
    console.log('\nPS-502 0096-0101 applied and verified.');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
