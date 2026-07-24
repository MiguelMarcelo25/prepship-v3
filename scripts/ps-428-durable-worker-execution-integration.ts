import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { RATE_BROWSE_MAX_EXECUTION_GENERATIONS } from '../src/services/rate-browse-worker-policy.js';

async function main(): Promise<void> {
  // Keep this integration self-contained in clean CI and prevent local credentials
  // from becoming an accidental database/provider boundary for its dynamic imports.
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgres://ps428:offline@127.0.0.1:1/ps428';
  process.env.SUPABASE_URL = 'https://example.test';
  process.env.SUPABASE_ANON_KEY = 'offline';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'offline';
  process.env.SUPABASE_JWT_SECRET = 'offline';

  const { runDurableWorkerAttempt } = await import(
    '../src/services/durable-worker-attempt.js'
  );

  const db = new PGlite();
  await db.exec(`
    CREATE TABLE rate_browse_jobs (
      job_id text PRIMARY KEY,
      request_key text,
      status text NOT NULL,
      active boolean NOT NULL DEFAULT false,
      message text,
      snapshot jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz
    );
    CREATE TABLE print_queue_merge_jobs (
      job_id text PRIMARY KEY,
      status text NOT NULL,
      active boolean NOT NULL DEFAULT false,
      client_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
      progress integer NOT NULL DEFAULT 0,
      total integer NOT NULL DEFAULT 0,
      current integer NOT NULL DEFAULT 0,
      message text,
      file_name text,
      error_message text,
      snapshot jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE print_queue_pdf_chunks (
      job_id text NOT NULL,
      chunk_number integer NOT NULL,
      pdf_bytes bytea NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (job_id, chunk_number)
    );
    INSERT INTO rate_browse_jobs (job_id, request_key, status, active, snapshot, created_at, updated_at)
    VALUES
      ('rate-old', 'same-request', 'queued', true, '{"jobId":"rate-old","active":true}'::jsonb, now() - interval '1 minute', now() - interval '1 minute'),
      ('rate-new', 'same-request', 'queued', true, '{"jobId":"rate-new","active":true}'::jsonb, now(), now());
  `);

  await db.exec(readFileSync('drizzle/0067_durable_worker_execution_fences.sql', 'utf8'));

  const active = await db.query<{ job_id: string }>(`
    SELECT job_id FROM rate_browse_jobs WHERE request_key = 'same-request' AND active = true
  `);
  assert.deepEqual(active.rows.map((row) => row.job_id), ['rate-new']);

  await assert.rejects(
    db.exec(`
      INSERT INTO rate_browse_jobs (job_id, request_key, status, active, snapshot)
      VALUES ('rate-duplicate', 'same-request', 'queued', true, '{}'::jsonb)
    `),
    /unique|duplicate/i,
  );

  const firstClaim = await db.query<{ generation: number }>(`
    UPDATE rate_browse_jobs
    SET status = 'running', generation = generation + 1, heartbeat_at = now(), updated_at = now()
    WHERE job_id = 'rate-new' AND active = true
      AND (status = 'queued' OR heartbeat_at IS NULL OR heartbeat_at < now() - interval '1 minute')
    RETURNING generation
  `);
  assert.equal(firstClaim.rows[0]?.generation, 1);
  const overlappingClaim = await db.query(`
    UPDATE rate_browse_jobs
    SET generation = generation + 1
    WHERE job_id = 'rate-new' AND active = true
      AND (status = 'queued' OR heartbeat_at IS NULL OR heartbeat_at < now() - interval '1 minute')
    RETURNING generation
  `);
  assert.equal(overlappingClaim.rows.length, 0);
  const staleWrite = await db.query(`
    UPDATE rate_browse_jobs SET message = 'stale writer'
    WHERE job_id = 'rate-new' AND generation = 0
    RETURNING job_id
  `);
  assert.equal(staleWrite.rows.length, 0);
  await db.exec(`
    UPDATE rate_browse_jobs
    SET heartbeat_at = now() - interval '2 minutes'
    WHERE job_id = 'rate-new'
  `);
  const recoverableRate = await db.query<{ job_id: string }>(`
    SELECT job_id FROM rate_browse_jobs
    WHERE active = true AND heartbeat_at < now() - interval '1 minute'
  `);
  assert.deepEqual(recoverableRate.rows.map((row) => row.job_id), ['rate-new']);
  const restartedRateClaim = await db.query<{ generation: number }>(`
    UPDATE rate_browse_jobs
    SET generation = generation + 1, heartbeat_at = now(), updated_at = now()
    WHERE job_id = 'rate-new' AND active = true
      AND heartbeat_at < now() - interval '1 minute'
    RETURNING generation
  `);
  assert.equal(restartedRateClaim.rows[0]?.generation, 2);

  await db.exec(`
    INSERT INTO rate_browse_jobs (
      job_id, request_key, status, active, snapshot, generation, heartbeat_at, created_at, updated_at
    ) VALUES
      (
        'rate-fresh-queued', 'fresh-queued', 'queued', true,
        '{"jobId":"rate-fresh-queued","phase":"queued"}'::jsonb,
        0, NULL, now(), now()
      ),
      (
        'rate-stale-queued', 'stale-queued', 'queued', true,
        '{"jobId":"rate-stale-queued","phase":"queued"}'::jsonb,
        0, NULL, now() - interval '2 minutes', now() - interval '2 minutes'
      ),
      (
        'rate-exhausted', 'exhausted', 'partial', true,
        '{"jobId":"rate-exhausted","phase":"partial"}'::jsonb,
        ${RATE_BROWSE_MAX_EXECUTION_GENERATIONS}, now() - interval '2 minutes',
        now() - interval '5 minutes', now() - interval '2 minutes'
      );
  `);
  const recoveryCandidates = await db.query<{ job_id: string }>(`
    SELECT job_id
    FROM rate_browse_jobs
    WHERE active = true
      AND generation < ${RATE_BROWSE_MAX_EXECUTION_GENERATIONS}
      AND (
        (status = 'queued' AND updated_at < now() - interval '1 minute')
        OR (
          status IN ('running', 'partial')
          AND (heartbeat_at IS NULL OR heartbeat_at < now() - interval '1 minute')
        )
      )
    ORDER BY job_id
  `);
  assert.deepEqual(
    recoveryCandidates.rows.map((row) => row.job_id),
    ['rate-stale-queued'],
    'recovery ignores fresh queued and exhausted jobs',
  );
  await db.exec(`
    UPDATE rate_browse_jobs
    SET status = 'error',
        active = false,
        generation = generation + 1,
        snapshot = snapshot || jsonb_build_object(
          'phase', 'error',
          'generation', generation + 1,
          'error', 'attempts exhausted'
        ),
        updated_at = now(),
        finished_at = now()
    WHERE active = true
      AND generation >= ${RATE_BROWSE_MAX_EXECUTION_GENERATIONS}
      AND status IN ('running', 'partial')
      AND (heartbeat_at IS NULL OR heartbeat_at < now() - interval '1 minute')
  `);
  const exhaustedRate = await db.query<{
    status: string;
    active: boolean;
    generation: number;
    snapshot: { phase: string; generation: number; error: string };
  }>(`
    SELECT status, active, generation, snapshot
    FROM rate_browse_jobs
    WHERE job_id = 'rate-exhausted'
  `);
  assert.deepEqual(exhaustedRate.rows[0], {
    status: 'error',
    active: false,
    generation: RATE_BROWSE_MAX_EXECUTION_GENERATIONS + 1,
    snapshot: {
      jobId: 'rate-exhausted',
      phase: 'error',
      generation: RATE_BROWSE_MAX_EXECUTION_GENERATIONS + 1,
      error: 'attempts exhausted',
    },
  });

  await db.exec(`
    INSERT INTO print_queue_merge_jobs (
      job_id, status, active, snapshot, input_payload, generation
    ) VALUES (
      '00000000-0000-4000-8000-000000000428', 'pending', true,
      '{"jobId":"00000000-0000-4000-8000-000000000428","status":"pending"}'::jsonb,
      '{"entries":[{"id":"entry-1"}],"mergeHeaders":true}'::jsonb,
      0
    );
  `);
  const mergeClaim = await db.query<{ generation: number; input_payload: { entries: Array<{ id: string }> } }>(`
    UPDATE print_queue_merge_jobs
    SET status = 'running', generation = generation + 1, heartbeat_at = now(), updated_at = now()
    WHERE job_id = '00000000-0000-4000-8000-000000000428' AND active = true AND status = 'pending'
    RETURNING generation, input_payload
  `);
  assert.equal(mergeClaim.rows[0]?.generation, 1);
  assert.equal(mergeClaim.rows[0]?.input_payload.entries[0]?.id, 'entry-1');

  await db.exec(`
    INSERT INTO print_queue_pdf_chunks (job_id, chunk_number, pdf_bytes, generation)
    VALUES ('00000000-0000-4000-8000-000000000428', 1, decode('new-generation', 'escape'), 1)
  `);
  const staleChunkOverwrite = await db.query(`
    INSERT INTO print_queue_pdf_chunks (job_id, chunk_number, pdf_bytes, generation)
    VALUES ('00000000-0000-4000-8000-000000000428', 1, decode('stale', 'escape'), 0)
    ON CONFLICT (job_id, chunk_number) DO UPDATE
      SET pdf_bytes = excluded.pdf_bytes, generation = excluded.generation
    WHERE print_queue_pdf_chunks.generation <= excluded.generation
    RETURNING generation
  `);
  assert.equal(staleChunkOverwrite.rows.length, 0);
  await db.exec(`
    UPDATE print_queue_merge_jobs
    SET heartbeat_at = now() - interval '2 minutes', updated_at = now()
    WHERE job_id = '00000000-0000-4000-8000-000000000428'
  `);
  const restartedMergeClaim = await db.query<{ generation: number }>(`
    UPDATE print_queue_merge_jobs
    SET generation = generation + 1, heartbeat_at = now(), updated_at = now()
    WHERE job_id = '00000000-0000-4000-8000-000000000428'
      AND active = true
      AND heartbeat_at < now() - interval '1 minute'
    RETURNING generation
  `);
  assert.equal(restartedMergeClaim.rows[0]?.generation, 2);
  const staleNewChunk = await db.query(`
    INSERT INTO print_queue_pdf_chunks (job_id, chunk_number, pdf_bytes, generation)
    SELECT jobs.job_id, 2, decode('stale-new', 'escape'), 1
    FROM print_queue_merge_jobs AS jobs
    WHERE jobs.job_id = '00000000-0000-4000-8000-000000000428'
      AND jobs.generation = 1
      AND jobs.active = true
    RETURNING generation
  `);
  assert.equal(staleNewChunk.rows.length, 0, 'stale generations cannot insert a new artifact row');

  // Operational rollback leaves the additive sidecars in place while the old
  // application version is restored. Prove legacy inserts that omit every
  // PS-428 column remain valid after the migration.
  await db.exec(`
    INSERT INTO rate_browse_jobs (job_id, request_key, status, active, snapshot)
    VALUES ('rate-legacy-rollback', NULL, 'complete', false, '{"jobId":"rate-legacy-rollback"}'::jsonb);
    INSERT INTO print_queue_merge_jobs (job_id, status, active, snapshot)
    VALUES ('00000000-0000-4000-8000-000000000429', 'done', false, '{"jobId":"legacy-rollback"}'::jsonb);
  `);
  const legacyRollbackRows = await db.query<{ total: number }>(`
    SELECT
      (SELECT count(*)::int FROM rate_browse_jobs WHERE job_id = 'rate-legacy-rollback') +
      (SELECT count(*)::int FROM print_queue_merge_jobs WHERE job_id = '00000000-0000-4000-8000-000000000429') AS total
  `);
  assert.equal(legacyRollbackRows.rows[0]?.total, 2, 'additive schema remains compatible with the previous application');

  let releaseWork!: () => void;
  const workGate = new Promise<void>((resolve) => { releaseWork = resolve; });
  let cancellationRequested = false;
  let cancellationAcknowledged = false;
  let attemptSettled = false;
  const attemptPromise = runDurableWorkerAttempt({
    label: 'ps-428-noncooperative',
    timeoutMs: 10,
    heartbeatIntervalMs: 1_000,
    execute: async () => {
      await workGate;
      return 'settled';
    },
    hooks: {
      heartbeat: async () => true,
      requestCancellation: async () => { cancellationRequested = true; },
      acknowledgeCancellation: async () => { cancellationAcknowledged = true; },
    },
  }).finally(() => { attemptSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(cancellationRequested, true);
  assert.equal(cancellationAcknowledged, false);
  assert.equal(attemptSettled, false, 'claim must remain held while old work is live');
  releaseWork();
  const attempt = await attemptPromise;
  assert.deepEqual(attempt, { value: 'settled', timedOut: true });
  assert.equal(cancellationAcknowledged, true);

  process.env.JOB_HANDLER_TIMEOUT_MS = String(25 * 60_000);
  const { REAPER_MIN_ACTIVE_AGE_MS, selectStuckActiveJobs } = await import(
    '../src/services/sync-stuck-job-reaper.js'
  );
  assert.equal(REAPER_MIN_ACTIVE_AGE_MS, 25 * 60_000 + 30_000);
  const now = Date.parse('2026-07-15T12:00:00.000Z');
  const twentyMinutesAgo = new Date(now - 20 * 60_000).toISOString();
  assert.deepEqual(
    selectStuckActiveJobs(
      [{ id: 'active-20m', name: 'prepship.sync.shipments', state: 'active', started_on: twentyMinutesAgo }],
      {
        nowMs: now,
        minActiveAgeMs: REAPER_MIN_ACTIVE_AGE_MS,
        activeLanesHeld: new Set(['shipstation-sync']),
      },
    ),
    [],
  );

  await db.close();
  console.log('PASS PS-428 durable worker execution integration');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
