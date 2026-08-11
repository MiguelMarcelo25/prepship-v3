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
  resolveLegacyRecoveryCutoff,
  createPostgresAutomationExecutionStore,
  reapExpiredAutomationRuns,
} = await import('../src/services/automations/postgres-store');
const { AutomationRunLeaseBusyError } = await import('../src/services/automations/orchestrator');
const recovered = await reapExpiredAutomationRuns({
  database: testDb as never,
  now,
  batchSize: 25,
});
// Two, not three. The legacy null-lease row (id 5) is NOT swept by default — sweeping it is
// historical data mutation and now requires an explicit operator cutoff. Expired FENCED
// leases still recover automatically, which is the whole point of deploying the worker.
assert.equal(recovered, 2, 'expired fenced leases terminalize; legacy and live rows are left alone');

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
  // id 5 is a legacy null-lease row old enough to sweep, and it STAYS running: a deploy
  // must not perform historical disposition as a side effect of shipping code.
  { id: 5, status: 'running', error_code: null, recovery_count: 0, last_recovery_code: null },
  { id: 6, status: 'running', error_code: null, recovery_count: 0, last_recovery_code: null },
]);
// The legacy cohort IS reachable, but only under an explicit bounded cutoff.
assert.equal(
  await reapExpiredAutomationRuns({
    database: testDb as never, now, batchSize: 25, legacyCutoffRaw: '2026-08-11T11:30:00Z',
  }),
  1,
  'an authorised cutoff recovers the legacy row that a default deploy left untouched',
);
assert.equal(
  (await pg.query<{ status: string }>(`select status from automation_runs where id = 5`)).rows[0]?.status,
  'failed',
);
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

// ── a stale run owner cannot ADMIT AN EFFECT after losing the run ────────────
//
// This fence matters more than the one on finish(). finish() protects run history; this
// protects the HANDLER boundary, where tags, hazmat declarations, rate invalidations and any
// future provider call actually happen. Without it a stale worker's finish() is refused, but
// only after its side effect has already landed.
{
  const stalled = createPostgresAutomationExecutionStore(testDb as never);
  const runId = await stalled.begin({
    executionKey: 'effect-fence-run',
    orderId: 400,
    trigger: 'before_rate',
    sourceEventId: 'effect-fence-event',
    factsRevision: 'effect-fence-facts',
    rulesetDigest: 'c'.repeat(64),
    mode: 'apply',
  });
  const originalToken = (await pg.query<{ lease_token: string | null }>(
    `select lease_token from automation_runs where id = $1`, [runId],
  )).rows[0]?.lease_token;
  assert.ok(originalToken, 'the first owner holds a token');

  await pg.query(
    `update automation_runs set started_at = $1, lease_expires_at = $1 where id = $2`,
    ['2026-08-11T11:00:00Z', runId],
  );
  assert.equal(await reapExpiredAutomationRuns({ database: testDb as never, now, batchSize: 25 }), 1);

  const successor = createPostgresAutomationExecutionStore(testDb as never);
  assert.equal(await successor.begin({
    executionKey: 'effect-fence-run',
    orderId: 400,
    trigger: 'before_rate',
    sourceEventId: 'effect-fence-event',
    factsRevision: 'effect-fence-facts',
    rulesetDigest: 'c'.repeat(64),
    mode: 'apply',
  }), runId);
  const successorToken = (await pg.query<{ lease_token: string | null }>(
    `select lease_token from automation_runs where id = $1`, [runId],
  )).rows[0]?.lease_token;
  assert.ok(successorToken && successorToken !== originalToken, 'ownership moved to a NEW token');

  const effectsBefore = (await pg.query(`select id from automation_action_results`)).rows.length;
  await assert.rejects(
    stalled.claimEffect({
      runId, ruleId: 1, versionId: 10, actionIndex: 0,
      actionType: 'tag.add', idempotencyKey: 'stale-owner-effect', status: 'planned',
    } as never),
    /lease lost before effect admission/,
    'a stale run owner must be refused BEFORE any handler can run',
  );
  assert.equal(
    (await pg.query(`select id from automation_action_results`)).rows.length, effectsBefore,
    'the refused stale claim must not create an action-result row',
  );
  assert.equal(
    (await pg.query<{ lease_token: string | null }>(
      `select lease_token from automation_runs where id = $1`, [runId],
    )).rows[0]?.lease_token,
    successorToken,
    'and must not disturb the successor lease',
  );

  // The legitimate owner can still claim and record normally.
  const claim = await successor.claimEffect({
    runId, ruleId: 1, versionId: 10, actionIndex: 0,
    actionType: 'tag.add', idempotencyKey: 'stale-owner-effect', status: 'planned',
  } as never);
  assert.equal(claim.status, 'claimed', 'the rightful owner is admitted');

  // ── recordEffect's own fence, proved directly ──────────────────────────────
  // It has a token predicate, but like finish() it had no test. A second worker reclaiming
  // the effect lease must make the first worker's record attempt fail.
  // claimEffect compares against real wall-clock, not the injected `now`, so this must be a
  // timestamp that is unambiguously in the past whenever the suite runs.
  await pg.query(
    `update automation_action_results set lease_expires_at = $1 where idempotency_key = 'stale-owner-effect'`,
    ['2020-01-01T00:00:00Z'],
  );
  const reclaimer = await successor.claimEffect({
    runId, ruleId: 1, versionId: 10, actionIndex: 0,
    actionType: 'tag.add', idempotencyKey: 'stale-owner-effect', status: 'planned',
  } as never);
  assert.equal(reclaimer.status, 'claimed', 'an expired effect lease is reclaimable');
  assert.notEqual((reclaimer as { claimToken: string }).claimToken, (claim as { claimToken: string }).claimToken);

  await assert.rejects(
    successor.recordEffect({
      runId, ruleId: 1, versionId: 10, actionIndex: 0,
      actionType: 'tag.add', idempotencyKey: 'stale-owner-effect', status: 'applied',
    } as never, (claim as { claimToken: string }).claimToken),
    /lease/i,
    'a stale effect token must not be able to record a result',
  );
  const stillPlanned = (await pg.query<{ status: string; lease_token: string | null }>(
    `select status, lease_token from automation_action_results where idempotency_key = 'stale-owner-effect'`,
  )).rows[0];
  assert.equal(stillPlanned?.status, 'planned', 'the reclaimer\'s row is untouched by the stale record');
  assert.equal(stillPlanned?.lease_token, (reclaimer as { claimToken: string }).claimToken);

  await successor.recordEffect({
    runId, ruleId: 1, versionId: 10, actionIndex: 0,
    actionType: 'tag.add', idempotencyKey: 'stale-owner-effect', status: 'applied',
  } as never, (reclaimer as { claimToken: string }).claimToken);
  assert.equal(
    (await pg.query<{ status: string }>(
      `select status from automation_action_results where idempotency_key = 'stale-owner-effect'`,
    )).rows[0]?.status,
    'applied',
    'the rightful effect owner records normally',
  );

  // An owner whose lease has EXPIRED but has not yet been reaped must also be refused.
  // This is the race window between expiry and the next sweep: the token still matches and
  // the row is still `running`, so only the expiry comparison can catch it. Without this the
  // owner could start a handler at the very moment recovery is about to take the run away.
  {
    const racer = createPostgresAutomationExecutionStore(testDb as never);
    const raceRunId = await racer.begin({
      executionKey: 'expiry-race-run',
      orderId: 401,
      trigger: 'before_rate',
      sourceEventId: 'expiry-race-event',
      factsRevision: 'expiry-race-facts',
      rulesetDigest: 'd'.repeat(64),
      mode: 'apply',
    });
    // Expire the lease in place; do NOT reap. Status stays 'running', token stays the racer's.
    await pg.query(
      `update automation_runs set lease_expires_at = $1 where id = $2`,
      ['2020-01-01T00:00:00Z', raceRunId],
    );
    const before = (await pg.query(`select id from automation_action_results`)).rows.length;
    await assert.rejects(
      racer.claimEffect({
        runId: raceRunId, ruleId: 1, versionId: 10, actionIndex: 0,
        actionType: 'tag.add', idempotencyKey: 'expiry-race-effect', status: 'planned',
      } as never),
      /lease lost before effect admission/,
      'an expired-but-unreaped owner must not start a handler',
    );
    assert.equal(
      (await pg.query(`select id from automation_action_results`)).rows.length, before,
      'and must create no action-result row',
    );
    await pg.query(`update automation_runs set status = 'failed' where id = $1`, [raceRunId]);
  }

  // Close this run out. The suite's injected `now` is later than a real wall-clock lease, so
  // a run left `running` here would look expired to the next reaper call and pollute the
  // legacy assertions below.
  await successor.finish({
    runId, executionKey: 'effect-fence-run', rulesetDigest: 'c'.repeat(64), mode: 'apply',
    status: 'completed', evaluation: { matches: [] }, reduction: {},
  } as never);
}

// ── legacy recovery is OFF unless an operator names a bounded cutoff ─────────
//
// Deploying the worker must not sweep the historical cohort. That is data repair, and DJ has
// authorised none — so it cannot happen as a side effect of shipping code.
{
  const seedLegacy = async (id: number, key: string, startedAt: string) => {
    await pg.query(
      `insert into automation_runs(id, execution_key, order_id, trigger, source_event_id,
         facts_revision, ruleset_digest, engine_version, mode, status, trace_hash, started_at,
         lease_token, lease_expires_at)
       values ($1,$2,500,'before_rate',$2,'legacy-facts',repeat('9',64),'ps-466-v1','apply',
               'running',repeat('9',64),$3,null,null)`,
      [id, key, startedAt],
    );
  };
  await seedLegacy(9001, 'legacy-old', '2026-07-30T06:00:00Z');
  await seedLegacy(9002, 'legacy-newer', '2026-08-05T06:00:00Z');
  const legacyStatuses = async () => (await pg.query<{ id: number; status: string }>(
    `select id, status from automation_runs where id in (9001, 9002) order by id`,
  )).rows;

  // 1. absent cutoff — legacy rows survive a complete pass
  assert.equal(
    await reapExpiredAutomationRuns({ database: testDb as never, now, batchSize: 25, legacyCutoffRaw: undefined }),
    0, 'with no cutoff configured, nothing legacy is swept');
  assert.deepEqual(await legacyStatuses(),
    [{ id: 9001, status: 'running' }, { id: 9002, status: 'running' }],
    'a deploy without an explicit cutoff performs NO historical mutation');

  // 2. invalid cutoff — fail closed, not fail open
  assert.equal(
    await reapExpiredAutomationRuns({ database: testDb as never, now, batchSize: 25, legacyCutoffRaw: 'not-a-date' }),
    0, 'an unparseable cutoff must never be read as "sweep everything"');
  assert.deepEqual(await legacyStatuses(),
    [{ id: 9001, status: 'running' }, { id: 9002, status: 'running' }]);
  assert.equal(resolveLegacyRecoveryCutoff('not-a-date').cutoff, null);
  assert.match(resolveLegacyRecoveryCutoff('not-a-date').diagnostic, /DISABLED/);
  assert.equal(resolveLegacyRecoveryCutoff('   ').cutoff, null, 'blank is off');

  // 3. valid cutoff — bounded to exactly the authorised cohort
  assert.equal(
    await reapExpiredAutomationRuns({
      database: testDb as never, now, batchSize: 25, legacyCutoffRaw: '2026-08-01T00:00:00Z',
    }),
    1, 'only the legacy row at or before the cutoff is recovered');
  assert.deepEqual(await legacyStatuses(),
    [{ id: 9001, status: 'failed' }, { id: 9002, status: 'running' }],
    'a row started AFTER the cutoff is outside the authorisation and survives');

  // 4. repeated passes are idempotent
  assert.equal(
    await reapExpiredAutomationRuns({
      database: testDb as never, now, batchSize: 25, legacyCutoffRaw: '2026-08-01T00:00:00Z',
    }),
    0, 'legacy recovery cannot transition the same row twice');

  // 5. batch bounds still apply while legacy mode is active
  for (let i = 0; i < 4; i += 1) {
    await seedLegacy(9100 + i, `legacy-batch-${i}`, '2026-07-30T06:00:00Z');
  }
  // batchSize bounds CANDIDATES, not recoveries. Run 3 is always a candidate (its lease is
  // expired) but is always skipped because it holds a live effect lease, so it consumes one
  // slot every pass without ever recovering. Three candidates therefore yield two recoveries.
  assert.equal(
    await reapExpiredAutomationRuns({
      database: testDb as never, now, batchSize: 3, legacyCutoffRaw: '2026-08-01T00:00:00Z',
    }),
    2, 'the batch bound is enforced in legacy mode too');
  assert.deepEqual(
    (await pg.query<{ id: number; status: string }>(
      `select id, status from automation_runs where id between 9100 and 9103 order by id`,
    )).rows.filter((r) => r.status === 'running').map((r) => r.id),
    [9102, 9103],
    'the remaining legacy rows wait for the next bounded pass rather than being swept at once',
  );
}

const indexes = await pg.query<{ indexname: string }>(`
  select indexname from pg_indexes where indexname = 'automation_runs_recovery_idx'
`);
assert.equal(indexes.rows.length, 1, 'the hot-table recovery scan is backed by a partial index');

await pg.close();
console.log('PS-466 run/action recovery behavioral integration passed (handler/provider calls: 0)');
