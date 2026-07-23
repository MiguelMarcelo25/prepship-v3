import 'dotenv/config';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import {
  BILLING_POLICY_LEGACY,
  BILLING_POLICY_WEEKEND_ROLLFORWARD,
  resolveBillingCalendarDay,
} from '../src/services/billing-calendar-policy.js';

/**
 * PS-434 no-write rollout probe.
 *
 * This command does not activate the policy. It requires a candidate effective
 * date and an explicit production-read flag, opens a read-only transaction,
 * and proves that pre-cutoff billing membership/counts/totals are identical
 * under the legacy ship-date key and the additive effective-day fallback.
 * It also prints the first 14 candidate days so DJ can review the exact future
 * weekend-to-Monday behavior before setting the runtime effective date.
 */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

type HistoricalSnapshot = {
  legacy_line_count: string;
  legacy_total: string;
  effective_line_count: string;
  effective_total: string;
  pre_cutoff_rebucketed_count: string;
  post_cutoff_legacy_weekend_count: string;
  active_v2_line_count: string;
};

function argumentValue(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function exactDay(value: string | null): string | null {
  if (!value || !DAY_RE.test(value)) return null;
  const instant = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === value
    ? value
    : null;
}

function addDays(day: string, amount: number): string {
  const instant = new Date(`${day}T00:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() + amount);
  return instant.toISOString().slice(0, 10);
}

export function candidateSchedule(effectiveDate: string, length = 14) {
  return Array.from({ length }, (_, offset) => {
    const actualActivityDay = addDays(effectiveDate, offset);
    return resolveBillingCalendarDay({ actualActivityDay, effectiveDate });
  });
}

function runSelfTest(): void {
  const schedule = candidateSchedule('2026-07-13', 7);
  assert.equal(schedule[0]?.policyVersion, BILLING_POLICY_WEEKEND_ROLLFORWARD);
  assert.equal(schedule[5]?.billingEffectiveDay, '2026-07-20');
  assert.equal(schedule[6]?.billingEffectiveDay, '2026-07-20');
  assert.equal(
    resolveBillingCalendarDay({ actualActivityDay: '2026-07-12', effectiveDate: '2026-07-13' })
      .policyVersion,
    BILLING_POLICY_LEGACY,
  );
  assert.equal(exactDay('2026-02-29'), null);
  assert.equal(exactDay('2028-02-29'), '2028-02-29');
  console.log('PS-434 billing roll-forward readiness self-test passed');
}

async function runProbe(effectiveDate: string): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const sql = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: {
      application_name: 'ps-434-read-only-readiness',
      default_transaction_read_only: 'on',
      statement_timeout: '15000',
    },
  });

  try {
    const snapshot = await sql.begin('read only', async (tx) => {
      const columns = await tx<{ column_name: string }[]>`
        select column_name
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'billing_line_items'
          and column_name in ('billing_effective_date', 'billing_policy_version')
      `;
      const available = new Set(columns.map((row) => row.column_name));
      if (!available.has('billing_effective_date') || !available.has('billing_policy_version')) {
        throw new Error(
          'Migration 0071 is not ready: billing_line_items effective-day columns are missing',
        );
      }

      const rows = await tx<HistoricalSnapshot[]>`
        select
          count(*) filter (
            where ship_date < ${effectiveDate}::date
          )::text as legacy_line_count,
          coalesce(sum(total_cost) filter (
            where ship_date < ${effectiveDate}::date
          ), 0)::text as legacy_total,
          count(*) filter (
            where coalesce(billing_effective_date, ship_date) < ${effectiveDate}::date
          )::text as effective_line_count,
          coalesce(sum(total_cost) filter (
            where coalesce(billing_effective_date, ship_date) < ${effectiveDate}::date
          ), 0)::text as effective_total,
          count(*) filter (
            where ship_date < ${effectiveDate}::date
              and (
                coalesce(billing_effective_date, ship_date) <> ship_date
                or billing_policy_version = ${BILLING_POLICY_WEEKEND_ROLLFORWARD}
              )
          )::text as pre_cutoff_rebucketed_count,
          count(*) filter (
            where ship_date >= ${effectiveDate}::date
              and billing_effective_date is null
              and extract(isodow from ship_date at time zone 'UTC') in (6, 7)
          )::text as post_cutoff_legacy_weekend_count,
          count(*) filter (
            where billing_policy_version = ${BILLING_POLICY_WEEKEND_ROLLFORWARD}
          )::text as active_v2_line_count
        from billing_line_items
      `;
      return rows[0]!;
    });

    const historicalUnchanged =
      snapshot.legacy_line_count === snapshot.effective_line_count &&
      Number(snapshot.legacy_total) === Number(snapshot.effective_total) &&
      snapshot.pre_cutoff_rebucketed_count === '0';

    console.log('PS-434 billing roll-forward readiness (READ ONLY)');
    console.log(`candidate_effective_date=${effectiveDate}`);
    console.log(`historical_legacy_lines=${snapshot.legacy_line_count}`);
    console.log(`historical_effective_lines=${snapshot.effective_line_count}`);
    console.log(`historical_legacy_total=${snapshot.legacy_total}`);
    console.log(`historical_effective_total=${snapshot.effective_total}`);
    console.log(`pre_cutoff_rebucketed_lines=${snapshot.pre_cutoff_rebucketed_count}`);
    console.log(`existing_post_cutoff_legacy_weekend_lines=${snapshot.post_cutoff_legacy_weekend_count}`);
    console.log(`active_v2_lines=${snapshot.active_v2_line_count}`);
    console.log(`historical_unchanged=${historicalUnchanged}`);
    console.log('\nCandidate future calendar behavior:');
    for (const day of candidateSchedule(effectiveDate)) {
      console.log(
        `${day.actualActivityDay} -> ${day.billingEffectiveDay} ` +
          `${day.rolledFromWeekend ? '(weekend roll-forward)' : '(same day)'}`,
      );
    }

    if (!historicalUnchanged) {
      throw new Error('Historical billing counts/totals are not unchanged; activation is not ready');
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  if (hasFlag('self-test')) {
    runSelfTest();
    return;
  }

  const effectiveDate = exactDay(argumentValue('effective-date'));
  if (!hasFlag('read-only-production') || !effectiveDate) {
    throw new Error(
      'Refused. Provide --read-only-production and --effective-date=YYYY-MM-DD. ' +
        'This previews a candidate only; it never activates the policy.',
    );
  }
  await runProbe(effectiveDate);
}

const invokedDirectly =
  process.argv[1] != null && /ps-434-billing-rollforward-readiness\.ts$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((error) => {
    console.error('[ps-434-readiness] failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
