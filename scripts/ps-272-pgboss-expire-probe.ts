import 'dotenv/config';
import { sql } from '../src/db/client';
import { env } from '../src/lib/env';

/**
 * PS-272 — pg-boss expire_in PROBE (LOCAL-ONLY diagnostic, refuses to run unprotected).
 *
 * WHY: PS-272's canonical fix turns on pg-boss's own maintenance loop (supervise + a 60s
 * maintenanceIntervalSeconds) and sets an explicit expireInSeconds on the constructor, each
 * createQueue, and every boss.send. pg-boss can only expire() a stale 'active' row if that row
 * actually carries an expire deadline. This probe reads <schema>.job.expire_in so an operator can
 * confirm the column is POPULATED (non-null, ~30 min) after the fix deploys — i.e. that pg-boss will
 * self-heal orphans instead of leaning solely on the custom reaper.
 *
 * SAFETY — this is a probe an agent must NEVER point at production:
 *   - It REFUSES to run without an explicit `--local` flag.
 *   - It ALSO refuses unless DATABASE_URL resolves to a loopback host (localhost / 127.0.0.1 / ::1),
 *     so even `--local` cannot accidentally read a remote/Render/Supabase database.
 *   - It is READ-ONLY: a single SELECT against the pgboss job table. No INSERT/UPDATE/DELETE, no
 *     pg-boss mutation, no provider calls, no postage, no order/shipment access.
 *   - It runs only when invoked directly, so importing it never connects.
 *
 *   npx tsx scripts/ps-272-pgboss-expire-probe.ts --local
 */

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** True only when DATABASE_URL points at a loopback host — the hard guard against a remote read. */
function isLoopbackDatabaseUrl(databaseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(databaseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  // URL() wraps IPv6 hosts in brackets; strip them for the comparison.
  const bare = host.replace(/^\[/, '').replace(/\]$/, '');
  return bare === 'localhost' || bare === '127.0.0.1' || bare === '::1' || bare === '0.0.0.0';
}

type ExpireProbeRow = {
  state: string;
  total: number | string;
  with_expire: number | string;
  null_expire: number | string;
  sample_expire_in: string | null;
};

async function main(): Promise<void> {
  if (!hasFlag('local')) {
    console.error(
      [
        'PS-272 pg-boss expire probe REFUSED to run.',
        'This probe reads the pgboss job table and must NEVER touch production.',
        'Re-run with the explicit local flag against a LOCAL database only:',
        '  npx tsx scripts/ps-272-pgboss-expire-probe.ts --local',
      ].join('\n'),
    );
    process.exit(2);
  }

  if (!isLoopbackDatabaseUrl(env.DATABASE_URL)) {
    console.error(
      [
        'PS-272 pg-boss expire probe REFUSED: DATABASE_URL is not a loopback host.',
        'Even with --local, this probe only reads a local database (localhost / 127.0.0.1 / ::1).',
        'Point DATABASE_URL at your local Postgres and re-run.',
      ].join('\n'),
    );
    process.exit(2);
  }

  // Identifier-safe table reference: postgres-js renders the single dotted "schema"."job" string via
  // the Identifier path (same pattern as src/services/sync-stuck-job-reaper.ts). READ-ONLY SELECT.
  const jobTable = `${env.PG_BOSS_SCHEMA}.job`;
  const rows = await sql<ExpireProbeRow[]>`
    SELECT
      state,
      count(*)                                   AS total,
      count(*) FILTER (WHERE expire_in IS NOT NULL) AS with_expire,
      count(*) FILTER (WHERE expire_in IS NULL)     AS null_expire,
      max(expire_in)::text                        AS sample_expire_in
    FROM ${sql(jobTable)}
    GROUP BY state
    ORDER BY state
  `;

  console.log(`PS-272 pg-boss expire probe — schema "${env.PG_BOSS_SCHEMA}", READ-ONLY\n`);
  if (rows.length === 0) {
    console.log('No rows in the pgboss job table (nothing queued yet).');
  } else {
    for (const row of rows) {
      console.log(
        `state=${row.state.padEnd(10)} total=${row.total} with_expire=${row.with_expire} ` +
          `null_expire=${row.null_expire} sample_expire_in=${row.sample_expire_in ?? '(none)'}`,
      );
    }
    console.log(
      '\nExpect with_expire == total (expire_in populated, ~00:30:00) once the PS-272 supervise + ' +
        'expireInSeconds fix is live — that proves pg-boss can expire() stale active rows itself.',
    );
  }

  await sql.end({ timeout: 5 });
  process.exit(0);
}

// Only run when invoked directly so importing this module never connects.
const invokedDirectly =
  process.argv[1] != null && /ps-272-pgboss-expire-probe\.ts$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[ps-272-probe] failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export { isLoopbackDatabaseUrl };
