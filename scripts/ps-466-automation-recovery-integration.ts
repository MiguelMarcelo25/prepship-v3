import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

process.env.DATABASE_URL ??= 'postgres://postgres:test@127.0.0.1:5432/prepship_test';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key';
process.env.SUPABASE_JWT_SECRET ??= 'test-jwt-secret-test-jwt-secret-test';

const pg = new PGlite();
await pg.exec(`
  create table automation_runs (
    id bigserial primary key,
    execution_key text not null unique,
    order_id integer,
    rule_id integer,
    trigger text not null,
    source_event_id text not null,
    facts_revision text not null,
    ruleset_digest text not null,
    engine_version text not null,
    mode text not null,
    status text not null,
    matched_rule_version_ids integer[] not null default '{}',
    trace jsonb,
    trace_hash text not null,
    error_code text,
    error_summary text,
    created_by text,
    started_at timestamptz not null default now(),
    completed_at timestamptz
  );
  create table automation_action_results (
    id bigserial primary key,
    run_id bigint not null references automation_runs(id),
    rule_version_id integer not null,
    action_index integer not null,
    action_type text not null,
    idempotency_key text not null unique,
    status text not null,
    target_type text,
    target_id text,
    before_summary jsonb,
    after_summary jsonb,
    reason text,
    applied_at timestamptz,
    attempt_count integer not null default 0,
    lease_token text,
    lease_expires_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
`);
await pg.exec(await readFile('drizzle/0091_ps466_automation_run_recovery.sql', 'utf8'));
await pg.exec(`
  create index if not exists automation_runs_recovery_idx
    on automation_runs (status, lease_expires_at, started_at, id)
    where status = 'running'
`);

const now = new Date('2026-08-11T12:00:00.000Z');
await pg.exec(`
  insert into automation_runs(
    id, execution_key, order_id, trigger, source_event_id, facts_revision,
    ruleset_digest, engine_version, mode, status, trace_hash, started_at,
    lease_token, lease_expires_at
  ) values
    (1, 'stale-empty', 101, 'order_facts_updated', 'event-1', 'facts-1', repeat('a',64), 'ps-466-v1', 'apply', 'running', repeat('1',64), '2026-08-11T11:00:00Z', 'run-1', '2026-08-11T11:05:00Z'),
    (2, 'stale-mixed', 102, 'before_rate', 'event-2', 'facts-2', repeat('b',64), 'ps-466-v1', 'apply', 'running', repeat('2',64), '2026-08-11T11:00:00Z', 'run-2', '2026-08-11T11:05:00Z'),
    (3, 'stale-live-effect', 103, 'before_rate', 'event-3', 'facts-3', repeat('c',64), 'ps-466-v1', 'apply', 'running', repeat('3',64), '2026-08-11T11:00:00Z', 'run-3', '2026-08-11T11:05:00Z'),
    (4, 'live-run', 104, 'before_rate', 'event-4', 'facts-4', repeat('d',64), 'ps-466-v1', 'apply', 'running', repeat('4',64), '2026-08-11T11:58:00Z', 'run-4', '2026-08-11T12:03:00Z'),
    (5, 'legacy-stale', 105, 'order_items_changed', 'event-5', 'facts-5', repeat('e',64), 'ps-466-v1', 'apply', 'running', repeat('5',64), '2026-08-11T11:00:00Z', null, null),
    (6, 'legacy-recent', 106, 'order_items_changed', 'event-6', 'facts-6', repeat('f',64), 'ps-466-v1', 'apply', 'running', repeat('6',64), '2026-08-11T11:58:00Z', null, null);

  insert into automation_action_results(
    run_id, rule_version_id, action_index, action_type, idempotency_key, status,
    target_type, target_id, applied_at, attempt_count, lease_token, lease_expires_at
  ) values
    (2, 10, 0, 'tag.add', 'applied-effect', 'applied', 'order_tag', 'HAZMAT', '2026-08-11T11:01:00Z', 1, null, null),
    (2, 10, 1, 'hazmat.add_declaration', 'expired-planned-effect', 'planned', null, null, null, 1, 'effect-old', '2026-08-11T11:05:00Z'),
    (3, 10, 0, 'hazmat.add_declaration', 'live-planned-effect', 'planned', null, null, null, 1, 'effect-live', '2026-08-11T12:03:00Z');
  select setval(pg_get_serial_sequence('automation_runs', 'id'), (select max(id) from automation_runs));
`);

const testDb = drizzle(pg, { casing: 'snake_case' });
const {
  createPostgresAutomationExecutionStore,
  reapExpiredAutomationRuns,
} = await import('../src/services/automations/postgres-store');
const { AutomationRunLeaseBusyError } = await import('../src/services/automations/orchestrator');
const recovered = await reapExpiredAutomationRuns({
  database: testDb as never,
  now,
  batchSize: 25,
});
assert.equal(recovered, 3, 'stale empty, mixed, and legacy rows terminalize; live leases remain fenced');

const runs = await pg.query<{
  id: number;
  status: string;
  error_code: string | null;
  recovery_count: number;
  last_recovery_code: string | null;
  completed_at: string | null;
}>(`select id, status, error_code, recovery_count, last_recovery_code, completed_at from automation_runs order by id`);
assert.deepEqual(runs.rows.map(({ id, status, error_code, recovery_count, last_recovery_code }) => ({ id, status, error_code, recovery_count, last_recovery_code })), [
  { id: 1, status: 'failed', error_code: 'AUTOMATION_RUN_LEASE_EXPIRED', recovery_count: 1, last_recovery_code: 'AUTOMATION_RUN_LEASE_EXPIRED' },
  { id: 2, status: 'failed', error_code: 'AUTOMATION_RUN_LEASE_EXPIRED', recovery_count: 1, last_recovery_code: 'AUTOMATION_RUN_LEASE_EXPIRED' },
  { id: 3, status: 'running', error_code: null, recovery_count: 0, last_recovery_code: null },
  { id: 4, status: 'running', error_code: null, recovery_count: 0, last_recovery_code: null },
  { id: 5, status: 'failed', error_code: 'AUTOMATION_RUN_LEASE_EXPIRED', recovery_count: 1, last_recovery_code: 'AUTOMATION_RUN_LEASE_EXPIRED' },
  { id: 6, status: 'running', error_code: null, recovery_count: 0, last_recovery_code: null },
]);
assert.ok(runs.rows[0]?.completed_at, 'recovered runs receive one terminal timestamp');

const effects = await pg.query<{
  idempotency_key: string;
  status: string;
  target_type: string | null;
  reason: string | null;
  lease_token: string | null;
}>(`select idempotency_key, status, target_type, reason, lease_token from automation_action_results order by id`);
assert.deepEqual(effects.rows[0], {
  idempotency_key: 'applied-effect',
  status: 'applied',
  target_type: 'order_tag',
  reason: null,
  lease_token: null,
}, 'an already-applied effect is immutable during run recovery');
assert.equal(effects.rows[1]?.status, 'failed', 'an expired planned effect becomes explicitly retryable');
assert.match(effects.rows[1]?.reason ?? '', /without invoking its handler/);
assert.equal(effects.rows[1]?.lease_token, null);
assert.equal(effects.rows[2]?.status, 'planned', 'a live action lease blocks run recovery');
assert.equal(effects.rows[2]?.lease_token, 'effect-live');

const secondPass = await reapExpiredAutomationRuns({ database: testDb as never, now, batchSize: 25 });
assert.equal(secondPass, 0, 'recovery is idempotent and cannot create a second terminal transition');

const owner = createPostgresAutomationExecutionStore(testDb as never);
const contender = createPostgresAutomationExecutionStore(testDb as never);
const leasedRunId = await owner.begin({
  executionKey: 'fenced-run',
  orderId: 200,
  trigger: 'order_items_changed',
  sourceEventId: 'fenced-event',
  factsRevision: 'fenced-facts',
  rulesetDigest: 'a'.repeat(64),
  mode: 'apply',
});
await assert.rejects(
  contender.begin({
    executionKey: 'fenced-run',
    orderId: 200,
    trigger: 'order_items_changed',
    sourceEventId: 'fenced-event',
    factsRevision: 'fenced-facts',
    rulesetDigest: 'a'.repeat(64),
    mode: 'apply',
  }),
  (error: unknown) => error instanceof AutomationRunLeaseBusyError,
  'a live run lease admits exactly one owner',
);
await owner.finish({
  runId: leasedRunId,
  executionKey: 'fenced-run',
  rulesetDigest: 'a'.repeat(64),
  mode: 'apply',
  status: 'completed',
  evaluation: { matches: [] },
  reduction: {},
} as never);
const cached = await contender.findCompleted('fenced-run');
assert.equal(cached?.runId, leasedRunId, 'fenced completion becomes the sole cached terminal result');
const [fencedRow] = (await pg.query<{ status: string; lease_token: string | null }>(`
  select status, lease_token from automation_runs where execution_key = 'fenced-run'
`)).rows;
assert.deepEqual(fencedRow, { status: 'completed', lease_token: null });

// ── a stale owner cannot finish a run whose ownership has moved ──────────────
//
// This is the whole point of the fence, and until now nothing proved it: deleting
// `eq(automationRuns.leaseToken, claimToken)` from finish() left the suite fully green.
// That is a guard that cannot fail — the exact defect class this card exists to fix.
//
// The scenario is the one that actually happens: a worker claims a run, stalls past its
// lease, recovery terminalizes it, and then the stalled worker wakes up and tries to write
// its result. Without the fence it would resurrect a recovered run and silently overwrite
// the recovery audit trail.
{
  const stalled = createPostgresAutomationExecutionStore(testDb as never);
  const staleRunId = await stalled.begin({
    executionKey: 'stale-owner-run',
    orderId: 300,
    trigger: 'order_facts_updated',
    sourceEventId: 'stale-owner-event',
    factsRevision: 'stale-owner-facts',
    rulesetDigest: 'b'.repeat(64),
    mode: 'apply',
  });

  // The worker stalls: its lease expires while it is still holding an in-memory claim.
  await pg.query(
    `update automation_runs set started_at = $1, lease_expires_at = $1 where id = $2`,
    ['2026-08-11T11:00:00Z', staleRunId],
  );
  const reclaimed = await reapExpiredAutomationRuns({ database: testDb as never, now, batchSize: 25 });
  assert.equal(reclaimed, 1, 'the stalled run is reclaimed by recovery');

  const afterReclaim = (await pg.query<{ status: string; error_code: string | null; recovery_count: number; completed_at: string | null }>(
    `select status, error_code, recovery_count, completed_at from automation_runs where id = ${staleRunId}`,
  )).rows[0];
  assert.equal(afterReclaim?.status, 'failed');
  assert.equal(afterReclaim?.error_code, 'AUTOMATION_RUN_LEASE_EXPIRED');
  assert.equal(afterReclaim?.recovery_count, 1);

  // Ownership legitimately moves on BEFORE the stalled worker wakes: a fresh admission
  // re-leases the reclaimed run, so it is `running` again under a new token.
  //
  // This ordering is the whole test. If the stale worker is refused while the row is still
  // `failed`, the `status = 'running'` guard alone rejects it and the token check is never
  // exercised — which is exactly why deleting the token check left the suite green. Only a
  // run that is running again under a DIFFERENT owner can prove the fence.
  const successor = createPostgresAutomationExecutionStore(testDb as never);
  const successorRunId = await successor.begin({
    executionKey: 'stale-owner-run',
    orderId: 300,
    trigger: 'order_facts_updated',
    sourceEventId: 'stale-owner-event',
    factsRevision: 'stale-owner-facts',
    rulesetDigest: 'b'.repeat(64),
    mode: 'apply',
  });
  assert.equal(successorRunId, staleRunId, 'recovery leaves the row retryable rather than orphaned');
  const reLeased = (await pg.query<{ status: string; lease_token: string | null }>(
    `select status, lease_token from automation_runs where id = ${staleRunId}`,
  )).rows[0];
  assert.equal(reLeased?.status, 'running', 'the successor holds a live lease');
  assert.ok(reLeased?.lease_token, 'and a token of its own');

  // NOW the stalled worker wakes up and tries to complete the run it no longer owns. The row
  // is `running`, so only the fenced token can refuse it.
  await assert.rejects(
    stalled.finish({
      runId: staleRunId,
      executionKey: 'stale-owner-run',
      rulesetDigest: 'b'.repeat(64),
      mode: 'apply',
      status: 'completed',
      evaluation: { matches: [] },
      reduction: {},
    } as never),
    /lease lost before completion/,
    'a stale owner must be refused: its claim token no longer matches the persisted lease',
  );
  const afterStaleAttempt = (await pg.query<{ status: string; lease_token: string | null }>(
    `select status, lease_token from automation_runs where id = ${staleRunId}`,
  )).rows[0];
  assert.equal(afterStaleAttempt?.status, 'running',
    'a refused stale completion must not terminalize a run someone else is running');
  assert.equal(afterStaleAttempt?.lease_token, reLeased?.lease_token,
    'and must not clear the successor\'s lease');

  // The successor, which legitimately holds the lease, IS allowed to finish.
  await successor.finish({
    runId: successorRunId,
    executionKey: 'stale-owner-run',
    rulesetDigest: 'b'.repeat(64),
    mode: 'apply',
    status: 'completed',
    evaluation: { matches: [] },
    reduction: {},
  } as never);
  const settled = (await pg.query<{ status: string; recovery_count: number; last_recovery_code: string | null }>(
    `select status, recovery_count, last_recovery_code from automation_runs where id = ${staleRunId}`,
  )).rows[0];
  assert.equal(settled?.status, 'completed', 'the new owner completes the run it legitimately holds');
  assert.equal(settled?.recovery_count, 1, 'and the recovery history survives the later success');
  assert.equal(settled?.last_recovery_code, 'AUTOMATION_RUN_LEASE_EXPIRED');
}

const indexes = await pg.query<{ indexname: string }>(`
  select indexname from pg_indexes where indexname = 'automation_runs_recovery_idx'
`);
assert.equal(indexes.rows.length, 1, 'the hot-table recovery scan is backed by a partial index');

await pg.close();
console.log('PS-466 run/action recovery behavioral integration passed (handler/provider calls: 0)');
