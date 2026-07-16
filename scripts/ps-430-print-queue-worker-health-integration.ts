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

  // Per user override unlock shipped data on 2026-07-16: exercise the exact
  // bounded operator reconciliation against an isolated migrated fixture.
  // The production statement may update only Print Queue item sidecars after
  // durable shipment receipts prove the provider outcome is already known.
  await pg.exec(`
    CREATE TABLE shipments (
      order_id integer NOT NULL,
      voided boolean NOT NULL DEFAULT false,
      is_return boolean NOT NULL DEFAULT false,
      label_url text,
      label_tracking text,
      tracking_number text,
      label_shipment_id text,
      label_provider_key text
    );
    CREATE TABLE print_queue_orders (
      id text PRIMARY KEY,
      client_id integer NOT NULL,
      order_id text NOT NULL,
      label_url text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE label_purchase_intents (
      order_id integer NOT NULL,
      state text NOT NULL
    );

    INSERT INTO print_queue_send_jobs (
      job_id, status, active, progress, total, current, queued, failed,
      snapshot, created_at, updated_at
    ) VALUES
      ('ps-430-reconcile-a', 'error', false, 100, 3, 3, 0, 3, '{}'::jsonb, now(), now()),
      ('ps-430-reconcile-b', 'error', false, 100, 3, 3, 0, 3, '{}'::jsonb, now(), now()),
      ('ps-430-reconcile-c', 'interrupted', false, 100, 3, 3, 0, 3, '{}'::jsonb, now(), now());

    INSERT INTO print_queue_batch_job_items (job_id, order_id, client_id, state) VALUES
      ('ps-430-reconcile-a', 43011, 1, 'provider_pending'),
      ('ps-430-reconcile-a', 43012, 1, 'provider_pending'),
      ('ps-430-reconcile-a', 43013, 1, 'provider_pending_recovery'),
      ('ps-430-reconcile-b', 43011, 1, 'provider_pending'),
      ('ps-430-reconcile-b', 43014, 1, 'provider_pending'),
      ('ps-430-reconcile-b', 43015, 1, 'provider_pending_recovery'),
      ('ps-430-reconcile-c', 43016, 1, 'provider_pending'),
      ('ps-430-reconcile-c', 43017, 1, 'provider_pending'),
      ('ps-430-reconcile-c', 43018, 1, 'provider_pending');

    INSERT INTO shipments (
      order_id, label_url, label_tracking, label_shipment_id, label_provider_key
    )
    SELECT
      order_id,
      'https://labels.invalid/' || order_id || '.pdf',
      'TRACK-' || order_id,
      'shipment-' || order_id,
      'provider-' || order_id
    FROM generate_series(43011, 43018) AS order_id;

    INSERT INTO print_queue_orders (id, client_id, order_id, label_url)
    SELECT
      'queue-' || order_id,
      1,
      order_id::text,
      'https://labels.invalid/' || order_id || '.pdf'
    FROM generate_series(43011, 43015) AS order_id;
  `);

  const reconciliationSql = readFileSync(
    'docs/final-review/evidence/PS-430-provider-pending-reconciliation.sql',
    'utf8',
  );
  const reconciliation = await pg.query<{
    guard_passed: boolean;
    pending_count: number | string;
    order_count: number | string;
    job_count: number | string;
    durable_receipt_count: number | string;
    matching_queue_entry_count: number | string;
    unresolved_purchase_intent_count: number | string;
    updated_count: number | string;
    reconciled_queued_count: number | string;
    reconciled_shipment_persisted_count: number | string;
  }>(reconciliationSql);
  const reconciliationResult = reconciliation.rows[0];
  assert.equal(reconciliationResult?.guard_passed, true);
  assert.equal(Number(reconciliationResult?.pending_count), 9);
  assert.equal(Number(reconciliationResult?.order_count), 8);
  assert.equal(Number(reconciliationResult?.job_count), 3);
  assert.equal(Number(reconciliationResult?.durable_receipt_count), 9);
  assert.equal(Number(reconciliationResult?.matching_queue_entry_count), 6);
  assert.equal(Number(reconciliationResult?.unresolved_purchase_intent_count), 0);
  assert.equal(Number(reconciliationResult?.updated_count), 9);
  assert.equal(Number(reconciliationResult?.reconciled_queued_count), 6);
  assert.equal(Number(reconciliationResult?.reconciled_shipment_persisted_count), 3);

  const repeat = await pg.query<{ guard_passed: boolean; updated_count: number | string }>(
    reconciliationSql,
  );
  assert.equal(repeat.rows[0]?.guard_passed, false, 'resolved rows cannot be selected again');
  assert.equal(Number(repeat.rows[0]?.updated_count), 0, 'repeat reconciliation is a no-op');
} finally {
  await pg.close();
}

console.log('PASS PS-430 migrated PostgreSQL worker health/recovery integration');
