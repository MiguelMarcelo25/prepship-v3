/**
 * PS-430 migrated-Postgres integration fixture (offline PGlite).
 *
 * Applies the actual migration 0062 Print Queue tables, exercises stale/fresh
 * durable facts and an atomic recovery generation increment. It never opens a
 * network connection or calls a provider.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import {
  canAutomaticallyRecoverQueueSendJob,
  evaluatePrintQueueWorkerHealth,
  evaluateQueueSendWorkerAdmission,
} from '../src/services/print-queue-worker-policy';

type DurableRow = {
  active_count: number | string;
  oldest_active_age_seconds: number | string | null;
  provider_pending_count: number | string;
};

function migrationBlock(): string {
  const migration = readFileSync('drizzle/0062_runtime_schema_ownership.sql', 'utf8');
  const start = migration.indexOf('CREATE TABLE IF NOT EXISTS print_queue_send_jobs');
  const end = migration.indexOf('CREATE TABLE IF NOT EXISTS print_queue_merged_pdfs');
  assert.ok(start >= 0 && end > start, 'migration 0062 contains Print Queue durable tables');
  return migration.slice(start, end);
}

async function readDurableFacts(pg: PGlite): Promise<DurableRow> {
  const result = await pg.query<DurableRow>(`
    SELECT
      count(*) FILTER (
        WHERE status IN ('pending', 'running') OR active = true
      )::int AS active_count,
      max(extract(epoch from (now() - updated_at))) FILTER (
        WHERE status IN ('pending', 'running') OR active = true
      ) AS oldest_active_age_seconds,
      (
        SELECT count(*)::int
        FROM print_queue_batch_job_items
        WHERE state IN ('provider_pending', 'provider_pending_recovery')
      ) AS provider_pending_count
    FROM print_queue_send_jobs
  `);
  assert.ok(result.rows[0]);
  return result.rows[0];
}

const pg = new PGlite();
try {
  await pg.exec(migrationBlock());
  const snapshot = {
    version: 1,
    jobId: 'ps-430-fixture',
    status: 'running',
    active: true,
    recoveryAttempts: 0,
    workerOrders: [{ orderId: 43001 }],
    results: [],
  };
  await pg.query(
    `INSERT INTO print_queue_send_jobs (
      job_id, status, active, progress, total, current, queued, failed,
      message, snapshot, created_at, updated_at
    ) VALUES ($1, 'running', true, 70, 10, 7, 5, 2, 'stale', $2::jsonb,
      now() - interval '220 seconds', now() - interval '211 seconds')`,
    ['ps-430-fixture', JSON.stringify(snapshot)],
  );
  await pg.query(
    `INSERT INTO print_queue_batch_job_items (job_id, order_id, state)
     VALUES ($1, 43001, 'provider_pending')`,
    ['ps-430-fixture'],
  );

  const stale = await readDurableFacts(pg);
  const staleAge = Math.round(Number(stale.oldest_active_age_seconds));
  assert.equal(Number(stale.active_count), 1);
  assert.ok(staleAge >= 210);
  assert.equal(Number(stale.provider_pending_count), 1);
  const staleVerdict = evaluatePrintQueueWorkerHealth({
    expected: true,
    heartbeatAgeSeconds: 10,
    queueReadOk: true,
    durableReadOk: true,
    pgBossCreated: 0,
    pgBossRetry: 0,
    pgBossActive: 1,
    pgBossNewestFailureAgeSeconds: null,
    pgBossOldestPendingAgeSeconds: null,
    pgBossOldestActiveAgeSeconds: 211,
    durableActive: Number(stale.active_count),
    durableOldestActiveAgeSeconds: staleAge,
    providerPending: Number(stale.provider_pending_count),
    lastWorkerJobStatus: 'running',
    lastWorkerJobAgeSeconds: 10,
  });
  assert.equal(staleVerdict.status, 'fail');
  assert.ok(staleVerdict.reasons.includes('durable_batch_stale'));
  assert.equal(canAutomaticallyRecoverQueueSendJob(Number(stale.provider_pending_count)), false);

  const claimed = await pg.query<{ snapshot: Record<string, unknown> }>(`
    UPDATE print_queue_send_jobs
    SET snapshot = snapshot || jsonb_build_object(
      'status', 'pending',
      'active', true,
      'recoveryAttempts', coalesce((snapshot->>'recoveryAttempts')::int, 0) + 1,
      'updatedAt', now()
    ), status = 'pending', active = true, updated_at = now()
    WHERE job_id = 'ps-430-fixture'
    RETURNING snapshot
  `);
  const recoveryAttempt = Number(claimed.rows[0]?.snapshot.recoveryAttempts);
  assert.equal(recoveryAttempt, 1);
  const staleWrite = await pg.query(`
    UPDATE print_queue_send_jobs
    SET status = 'running', updated_at = now()
    WHERE job_id = 'ps-430-fixture'
      AND (snapshot->>'recoveryAttempts')::int = 0
    RETURNING job_id
  `);
  assert.equal(staleWrite.rows.length, 0, 'old recovery generation cannot prove durable writability');
  const currentWrite = await pg.query(`
    UPDATE print_queue_send_jobs
    SET status = 'running', active = true, updated_at = now()
    WHERE job_id = 'ps-430-fixture'
      AND (snapshot->>'recoveryAttempts')::int = 1
    RETURNING job_id
  `);
  assert.equal(currentWrite.rows.length, 1, 'current generation atomically proves durable writability');
  let providerSpyCalls = 0;
  for (const payloadRecoveryAttempt of [0, recoveryAttempt]) {
    const admission = evaluateQueueSendWorkerAdmission({
      snapshotPresent: true,
      snapshotStatus: 'pending',
      snapshotRecoveryAttempt: recoveryAttempt,
      payloadRecoveryAttempt,
    });
    if (admission.admit) providerSpyCalls += 1;
  }
  assert.equal(providerSpyCalls, 1, 'old and recovered pg-boss payloads admit one provider boundary');

  await pg.exec(`
    UPDATE print_queue_send_jobs
    SET status = 'done', active = false, current = total, progress = 100, updated_at = now()
    WHERE job_id = 'ps-430-fixture';
    UPDATE print_queue_batch_job_items
    SET state = 'queued', updated_at = now()
    WHERE job_id = 'ps-430-fixture';
  `);
  const completed = await readDurableFacts(pg);
  assert.equal(Number(completed.active_count), 0);
  assert.equal(Number(completed.provider_pending_count), 0);
  const completedVerdict = evaluatePrintQueueWorkerHealth({
    expected: true,
    heartbeatAgeSeconds: 10,
    queueReadOk: true,
    durableReadOk: true,
    pgBossCreated: 0,
    pgBossRetry: 0,
    pgBossActive: 0,
    pgBossNewestFailureAgeSeconds: null,
    pgBossOldestPendingAgeSeconds: null,
    pgBossOldestActiveAgeSeconds: null,
    durableActive: 0,
    durableOldestActiveAgeSeconds: null,
    providerPending: 0,
    lastWorkerJobStatus: 'succeeded',
    lastWorkerJobAgeSeconds: 10,
  });
  assert.equal(completedVerdict.status, 'ok');
} finally {
  await pg.close();
}

console.log('PASS PS-430 migrated PostgreSQL worker health/recovery integration');
