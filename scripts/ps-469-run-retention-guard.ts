/**
 * PS-469 automation_runs retention guard.
 *
 * Offline: the REAL prune against in-process PGlite, so the DELETE and its evidence
 * predicate are executed rather than described. No provider, no postage, no production.
 *
 * Why a bound exists. The re-evaluation loop put 926 MB into automation_runs in a week
 * -- measured 2026-08-01, 380,565 of 380,643 rows (99.98%) predate the final fix. The
 * loop is fixed and growth collapsed to ~7 rows/hour, so this is not cleanup; it is the
 * bound that stops the NEXT trigger bug becoming another 926 MB before anyone notices.
 *
 * Why the evidence rule is the important half. `ruleExecutionHistoryExists`
 * (execution-history.ts) decides whether deleting an automation rule is REFUSED, and it
 * reads matched_rule_version_ids ON THIS TABLE. Prune one of those rows and the proof
 * that a rule affected real orders is gone -- a rule that really ran silently becomes
 * deletable, taking its audit trail with it. 8,929 of 380,643 rows carry that evidence
 * (2.3%), and they must survive regardless of age.
 */
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ??= 'postgres://user:pass@127.0.0.1:5432/prepship_guard';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service';
process.env.SUPABASE_JWT_SECRET ??= 'secret';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

const { PGlite } = await import('@electric-sql/pglite');
const {
  pruneExpiredAutomationRuns,
  AUTOMATION_RUN_RETENTION_DAYS,
  AUTOMATION_RUN_RETENTION_BATCH,
  AUTOMATION_RUN_RETENTION_MAX_BATCHES,
} = await import('../src/services/automations/run-retention');

const client = new PGlite();
await client.exec(`
  CREATE TABLE automation_runs (
    id bigserial PRIMARY KEY,
    rule_id integer,
    matched_rule_version_ids integer[],
    started_at timestamptz NOT NULL
  );
`);

const conn = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.reduce(
    (acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ''), '');
  const result = await client.query(text, values as never[]);
  return Object.assign(result.rows, { count: result.affectedRows ?? result.rows.length });
}) as never;

const seed = async () => {
  await client.exec('DELETE FROM automation_runs;');
  await client.exec(`
    INSERT INTO automation_runs (rule_id, matched_rule_version_ids, started_at) VALUES
      -- expired, no evidence: the only prunable shape
      (NULL, NULL,      now() - interval '90 days'),
      (NULL, '{}',      now() - interval '60 days'),
      -- expired BUT carries the evidence ruleExecutionHistoryExists reads
      (NULL, '{7}',     now() - interval '90 days'),
      (NULL, '{7,9}',   now() - interval '400 days'),
      -- expired but carries a rule_id (execution-history checks this too)
      (12,   NULL,      now() - interval '90 days'),
      -- recent, no evidence: inside the window, must stay
      (NULL, NULL,      now() - interval '1 day'),
      (NULL, NULL,      now());
  `);
};
const remaining = async () =>
  ((await client.query('SELECT count(*)::int AS n FROM automation_runs')).rows[0] as { n: number }).n;
const evidenceRemaining = async () =>
  ((await client.query(
    `SELECT count(*)::int AS n FROM automation_runs
     WHERE rule_id IS NOT NULL
        OR (matched_rule_version_ids IS NOT NULL
            AND array_length(matched_rule_version_ids,1) IS NOT NULL)`)).rows[0] as { n: number }).n;

await seed();
const result = await pruneExpiredAutomationRuns(AUTOMATION_RUN_RETENTION_DAYS, conn);

check('the two expired evidence-free runs are deleted', result.deleted === 2, result);
check('five rows survive', (await remaining()) === 5, await remaining());

// THE assertion. If this ever goes false, deleting an automation rule stops being
// refused and a rule that really ran can be erased along with its audit trail.
check('every row carrying rule-execution EVIDENCE survives, however old',
  (await evidenceRemaining()) === 3, await evidenceRemaining());

const survivors = (await client.query(
  'SELECT matched_rule_version_ids AS m, rule_id AS r FROM automation_runs ORDER BY id')).rows;
check('a 400-day-old run that matched a rule version is still there',
  survivors.some((s) => Array.isArray((s as { m: number[] }).m)
    && (s as { m: number[] }).m?.length === 2), survivors);
check('a rule_id-bearing run is retained defensively too',
  survivors.some((s) => (s as { r: number | null }).r === 12), survivors);

// Recent rows are not eligible at all, regardless of evidence.
check('runs inside the retention window are never touched',
  survivors.filter((s) => (s as { m: null }).m === null && (s as { r: null }).r === null).length === 2);

// Refuse a non-positive window rather than treating it as "delete everything".
await seed();
for (const bad of [0, -1, Number.NaN]) {
  const r = await pruneExpiredAutomationRuns(bad, conn);
  check(`a retention window of ${String(bad)} deletes nothing`,
    r.deleted === 0 && (await remaining()) === 7, r);
}

// Idempotence: a second pass finds nothing left to do.
await seed();
await pruneExpiredAutomationRuns(AUTOMATION_RUN_RETENTION_DAYS, conn);
const second = await pruneExpiredAutomationRuns(AUTOMATION_RUN_RETENTION_DAYS, conn);
check('a second prune deletes nothing and stops immediately',
  second.deleted === 0 && second.batches === 1 && !second.reachedLimit, second);

await client.close();

// ── bounds and placement ────────────────────────────────────────────────────
const src = readFileSync('src/services/automations/run-retention.ts', 'utf8').replace(/\r\n/g, '\n');
const queue = readFileSync('src/services/sync-job-queue.ts', 'utf8').replace(/\r\n/g, '\n');

check('the delete is batched, so 371k eligible rows cannot land in one statement',
  /LIMIT \$\{AUTOMATION_RUN_RETENTION_BATCH\}/.test(src)
  && AUTOMATION_RUN_RETENTION_BATCH > 0 && AUTOMATION_RUN_RETENTION_BATCH <= 10_000);
check('batches per tick are bounded, so one maintenance run cannot go long',
  AUTOMATION_RUN_RETENTION_MAX_BATCHES > 0 && AUTOMATION_RUN_RETENTION_MAX_BATCHES <= 20);
check('the evidence predicate is re-checked INSIDE the delete, not read then deleted',
  /DELETE FROM automation_runs[\s\S]*?WHERE id IN \([\s\S]*?matched_rule_version_ids IS NULL/.test(src));
check('the retention window is bounded and at least a month',
  AUTOMATION_RUN_RETENTION_DAYS >= 30 && Number.isFinite(AUTOMATION_RUN_RETENTION_DAYS));
check('this table is the ONLY thing the retention deletes from',
  (src.match(/DELETE FROM (\w+)/g) ?? []).every((d) => d === 'DELETE FROM automation_runs'),
  src.match(/DELETE FROM (\w+)/g));
check('maintenance runs the prune AFTER the reapers, so recovery is never delayed',
  queue.indexOf('reapStaleQueuedCadenceJobs()') < queue.indexOf('pruneExpiredAutomationRuns()'));
check('a failed prune cannot fail the maintenance job',
  /pruneExpiredAutomationRuns\(\)\.catch\(/.test(queue));

if (failures > 0) {
  console.error(`\nFAIL PS-469 automation run retention guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-469 automation run retention guard');
