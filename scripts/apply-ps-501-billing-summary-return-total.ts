/**
 * PS-501 — migration 0095 runner: add billing_summary_metrics.return_total.
 *
 * WHY A RUNNER AND NOT `npm run migrate`
 *
 * Production execution belongs to the operator lane, not a developer session. This runs
 * inside the Render environment that already holds the production DATABASE_URL, so no
 * local credential is needed, minted, or passed through a workstation. Same shape as the
 * PS-488 / 0092 lane.
 *
 * WHAT 0095 DOES, AND WHY IT IS LOW RISK
 *
 * `alter table billing_summary_metrics add column if not exists return_total
 *  numeric(14,2) not null default 0`
 *
 * Purely additive. No existing column changes type or meaning, and `default 0` is the TRUE
 * value for every row that exists today rather than a convenient placeholder — return
 * lines are only written when RETURN_BILLING_ENABLED is on, and it is off. The cache also
 * recomputes any row whose period is stale, so no manual backfill is needed.
 *
 * WHY IT STILL NEEDS A GATE
 *
 * billing_summary_metrics is a MONEY read model. It is the cached answer behind the
 * Billing dashboard, and a column added with the wrong type or a nullable definition would
 * push "unknown" into money arithmetic. So: inspect is the default, apply demands an exact
 * token, and the post-apply read-back asserts the column's type, nullability and default
 * rather than merely its presence.
 *
 * INSPECT IS THE DEFAULT — with no flags this reports and writes nothing.
 *
 *   npx tsx scripts/apply-ps-501-billing-summary-return-total.ts --digest=<sha>
 *   npx tsx scripts/apply-ps-501-billing-summary-return-total.ts --digest=<sha> --apply --confirm=<token>
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const SQL_FILE = 'drizzle/0095_ps501_billing_summary_metrics_return_total.sql';
const CONFIRM_TOKEN = 'APPLY-PS-501-0095-BILLING-SUMMARY-RETURN-TOTAL';
const EXPECTED_DIGEST = 'a3428b6fd373869d0659569053914e1dd43c25f89e448324fb36890da6827d46';

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
function argValue(name: string): string | null {
  const hit = ARGS.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

/**
 * LF-normalised, matching the PS-488 lane. This repo runs core.autocrlf=true, so hashing
 * raw bytes would make the digest depend on which machine checked the file out.
 */
function normalisedDigest(path: string): string {
  return createHash('sha256')
    .update(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'), 'utf8')
    .digest('hex');
}

type ColumnFacts = {
  data_type: string;
  numeric_precision: number | null;
  numeric_scale: number | null;
  is_nullable: string;
  column_default: string | null;
};

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set. This runner is for the operator lane.');

  // The digest is supplied by the caller AND pinned here. Two independent bindings: the
  // constant proves the reviewed content, the argument proves the archive arrived
  // untampered. A mismatch on either stops before any connection is opened.
  const actual = normalisedDigest(SQL_FILE);
  if (actual !== EXPECTED_DIGEST) {
    throw new Error(
      `STOP: ${SQL_FILE} does not match the reviewed content.\n  actual:   ${actual}\n  expected: ${EXPECTED_DIGEST}`,
    );
  }
  const supplied = argValue('digest');
  if (supplied && supplied !== EXPECTED_DIGEST) {
    throw new Error(`STOP: --digest does not match the reviewed content.\n  supplied: ${supplied}\n  expected: ${EXPECTED_DIGEST}`);
  }
  console.log(`ok   ${SQL_FILE} matches the reviewed digest`);

  if (APPLY && argValue('confirm') !== CONFIRM_TOKEN) {
    throw new Error(`STOP: --apply requires --confirm=${CONFIRM_TOKEN}`);
  }

  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    const host = new URL(databaseUrl).hostname;
    console.log(`     target host: ${host}`);
    console.log(`     mode       : ${APPLY ? 'APPLY' : 'INSPECT (read-only)'}\n`);

    const [table] = await sql<{ present: boolean }[]>`
      select to_regclass('public.billing_summary_metrics') is not null as present`;
    if (!table?.present) {
      throw new Error('STOP: billing_summary_metrics does not exist. Run drizzle/0029_reporting_metrics.sql first.');
    }
    console.log('ok   billing_summary_metrics exists');

    const before = await sql<ColumnFacts[]>`
      select data_type, numeric_precision, numeric_scale, is_nullable, column_default
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'billing_summary_metrics'
        and column_name = 'return_total'`;

    const [counts] = await sql<{ rows: number }[]>`
      select count(*)::int as rows from billing_summary_metrics`;
    console.log(`     cached rows: ${counts?.rows ?? 0}`);

    // What the column would be worth today. Reported BEFORE applying so the operator sees
    // whether `default 0` is genuinely the true value or would silently understate rows.
    const [returnMoney] = await sql<{ total: string }[]>`
      select coalesce(sum(total_cost), 0)::text as total
      from billing_line_items
      where line_type in ('return', 'return_label', 'return_processing', 'return_postage', 'return_processing_fee')`;
    console.log(`     return money in billing_line_items: ${returnMoney?.total ?? '0'}`);
    if (Number(returnMoney?.total ?? 0) !== 0) {
      console.log(
        '     NOTE: return lines exist, so `default 0` is NOT the true value for cached rows.\n' +
          '           Those periods must be refreshed after apply — the cache ages rows out by\n' +
          '           period, so confirm the refresh ran rather than assuming it.',
      );
    }

    if (before.length > 0) {
      const c = before[0]!;
      console.log(`ok   return_total already present (${c.data_type}(${c.numeric_precision},${c.numeric_scale}), nullable=${c.is_nullable}, default=${c.column_default})`);
      if (!APPLY) console.log('\nNothing to do — the column exists. INSPECT wrote nothing.');
      if (APPLY) console.log('\nAPPLY is a no-op: the migration is idempotent (add column IF NOT EXISTS).');
    } else if (!APPLY) {
      console.log('     return_total is ABSENT — apply would add it.');
      console.log(`\nINSPECT complete. Nothing was written.\nTo apply:\n  --apply --confirm=${CONFIRM_TOKEN}`);
      return;
    }

    if (!APPLY) return;

    console.log('\napplying...');
    await sql.unsafe(readFileSync(SQL_FILE, 'utf8'));

    // Read-back asserts the SHAPE, not just presence. A numeric(14,2) NOT NULL DEFAULT 0 is
    // the contract; a nullable column would put "unknown" into money arithmetic.
    const after = await sql<ColumnFacts[]>`
      select data_type, numeric_precision, numeric_scale, is_nullable, column_default
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'billing_summary_metrics'
        and column_name = 'return_total'`;

    const col = after[0];
    if (!col) throw new Error('STOP: return_total is still absent after apply.');

    const problems: string[] = [];
    if (col.data_type !== 'numeric') problems.push(`data_type is ${col.data_type}, expected numeric`);
    if (col.numeric_precision !== 14) problems.push(`precision is ${col.numeric_precision}, expected 14`);
    if (col.numeric_scale !== 2) problems.push(`scale is ${col.numeric_scale}, expected 2`);
    if (col.is_nullable !== 'NO') problems.push('column is NULLABLE; money must not carry unknown');
    if (!/^0(\.0+)?$/.test((col.column_default ?? '').replace(/::numeric$/, ''))) {
      problems.push(`default is ${col.column_default}, expected 0`);
    }
    if (problems.length) throw new Error(`STOP: return_total has the wrong shape:\n  - ${problems.join('\n  - ')}`);

    console.log(`ok   return_total is ${col.data_type}(${col.numeric_precision},${col.numeric_scale}) NOT NULL default ${col.column_default}`);
    console.log('\nPS-501 0095 applied and verified.');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
