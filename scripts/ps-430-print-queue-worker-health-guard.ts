/**
 * PS-430 Print Queue worker health/recovery boundary fixtures.
 *
 * Offline only: no DB, providers, labels, postage, marketplace notifications,
 * service restarts, or production order/shipment mutations.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  canAutomaticallyRecoverQueueSendJob,
  createPrintQueueWorkerFatalSignalState,
  evaluatePrintQueueWorkerHealth,
  evaluateQueueSendWorkerAdmission,
  recordPrintQueueWorkerFatalSignal,
  resolvePrintQueueWorkerDatabaseUrl,
  type PrintQueueWorkerHealthFacts,
} from '../src/services/print-queue-worker-policy';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function check(name: string, action: () => void): void {
  try {
    action();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const healthyFacts: PrintQueueWorkerHealthFacts = {
  expected: true,
  heartbeatAgeSeconds: 15,
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
  lastWorkerJobAgeSeconds: 15,
};

check('normal created-active-done lifecycle is healthy after completion', () => {
  assert.deepEqual(evaluatePrintQueueWorkerHealth(healthyFacts), {
    status: 'ok',
    reasons: [],
    restartRequired: false,
  });
});

check('stale durable batch fails even when Print Queue list queuedCount would be zero', () => {
  const verdict = evaluatePrintQueueWorkerHealth({
    ...healthyFacts,
    durableActive: 1,
    durableOldestActiveAgeSeconds: 211,
  });
  assert.equal(verdict.status, 'fail');
  assert.equal(verdict.restartRequired, true);
  assert.ok(verdict.reasons.includes('durable_batch_stale'));
});

check('old active pg-boss claim with fresh durable progress is not falsely restarted', () => {
  const verdict = evaluatePrintQueueWorkerHealth({
    ...healthyFacts,
    pgBossActive: 1,
    pgBossOldestActiveAgeSeconds: 600,
    durableActive: 1,
    durableOldestActiveAgeSeconds: 10,
  });
  assert.equal(verdict.status, 'ok');
});

check('recent pg-boss/worker failure is visible while retry work remains', () => {
  const verdict = evaluatePrintQueueWorkerHealth({
    ...healthyFacts,
    pgBossRetry: 1,
    pgBossOldestPendingAgeSeconds: 10,
    pgBossNewestFailureAgeSeconds: 5,
    lastWorkerJobStatus: 'failed',
    lastWorkerJobAgeSeconds: 5,
  });
  assert.equal(verdict.status, 'fail');
  assert.equal(verdict.restartRequired, false);
  assert.ok(verdict.reasons.includes('pgboss_recent_failure'));
  assert.ok(verdict.reasons.includes('worker_job_recent_failure'));
});

check('unresolved provider outcome degrades health but does not create a restart loop', () => {
  const verdict = evaluatePrintQueueWorkerHealth({ ...healthyFacts, providerPending: 1 });
  assert.equal(verdict.status, 'fail');
  assert.equal(verdict.restartRequired, false);
  assert.deepEqual(verdict.reasons, ['provider_reconciliation_required']);
  assert.equal(canAutomaticallyRecoverQueueSendJob(1), false);
  assert.equal(canAutomaticallyRecoverQueueSendJob(0), true);
});

check('recovery generation fence admits exactly one current attempt', () => {
  let providerSpyCalls = 0;
  for (const payloadRecoveryAttempt of [0, 1]) {
    const admission = evaluateQueueSendWorkerAdmission({
      snapshotPresent: true,
      snapshotStatus: 'pending',
      snapshotRecoveryAttempt: 1,
      payloadRecoveryAttempt,
    });
    if (admission.admit) providerSpyCalls += 1;
  }
  assert.equal(providerSpyCalls, 1);
  assert.equal(
    evaluateQueueSendWorkerAdmission({
      snapshotPresent: false,
      snapshotStatus: null,
      snapshotRecoveryAttempt: null,
      payloadRecoveryAttempt: 0,
    }).admit,
    false,
  );
});

check('three timeout failures inside the bounded window request a fatal restart', () => {
  let state = createPrintQueueWorkerFatalSignalState();
  let result = recordPrintQueueWorkerFatalSignal(state, 'statement_timeout', 1_000);
  assert.equal(result.fatal, false);
  state = result.state;
  result = recordPrintQueueWorkerFatalSignal(state, 'idle_in_transaction_timeout', 2_000);
  assert.equal(result.fatal, false);
  state = result.state;
  result = recordPrintQueueWorkerFatalSignal(state, 'statement_timeout', 3_000);
  assert.equal(result.fatal, true);
});

check('two sustained pg-boss timekeeper skew warnings request a fatal restart', () => {
  let state = createPrintQueueWorkerFatalSignalState();
  let result = recordPrintQueueWorkerFatalSignal(state, 'timekeeper_skew', 1_000);
  assert.equal(result.fatal, false);
  state = result.state;
  result = recordPrintQueueWorkerFatalSignal(state, 'timekeeper_skew', 61_000);
  assert.equal(result.fatal, true);
});

check('production worker requires direct/session URL and rejects Supabase transaction mode', () => {
  assert.throws(() => resolvePrintQueueWorkerDatabaseUrl({
    databaseUrl: 'postgresql://user:secret@host.example:6543/postgres',
    nodeEnv: 'production',
    runWorker: true,
  }), /PRINT_QUEUE_PG_BOSS_DATABASE_URL/);
  assert.throws(() => resolvePrintQueueWorkerDatabaseUrl({
    databaseUrl: 'postgresql://user:secret@host.example:6543/postgres',
    dedicatedDatabaseUrl:
      'postgresql://postgres.ref:secret@aws-1-us.pooler.supabase.com:6543/postgres',
    nodeEnv: 'production',
    runWorker: true,
  }), /port 6543/);
  assert.match(resolvePrintQueueWorkerDatabaseUrl({
    databaseUrl: 'postgresql://user:secret@host.example:6543/postgres',
    dedicatedDatabaseUrl:
      'postgresql://postgres.ref:secret@aws-1-us.pooler.supabase.com:5432/postgres',
    nodeEnv: 'production',
    runWorker: true,
  }), /:5432/);
});

check('worker wiring checks generation before importing the provider-capable service', () => {
  const worker = read('src/services/print-queue-worker.ts');
  const admissionIndex = worker.indexOf('evaluateQueueSendWorkerAdmission({');
  const durableWriteIndex = worker.indexOf('await markQueueSendJobWorkerClaimed(');
  const providerServiceIndex = worker.indexOf("await import('./print-queue')");
  assert.ok(
    admissionIndex >= 0 &&
      durableWriteIndex > admissionIndex &&
      providerServiceIndex > durableWriteIndex,
  );
  assert.match(worker, /readQueueSendJobRecoverySafety/);
  assert.match(worker, /canAutomaticallyRecoverQueueSendJob/);
  assert.match(worker, /recordWorkerJobStart/);
  assert.match(worker, /recordWorkerJobSuccess/);
  assert.match(worker, /recordWorkerJobFailure/);
  assert.match(worker, /idle_in_transaction_session_timeout/);
  assert.match(worker, /statement_timeout/);
  assert.match(worker, /pg-boss-w02/);
  assert.match(worker, /process\.exit\(1\)/);
  const store = read('src/services/print-queue/queue-send-job-store.ts');
  assert.match(store, /export async function markQueueSendJobWorkerClaimed/);
  assert.match(store, /status IN \('pending', 'running'\)/);
  assert.match(store, /snapshot->>'recoveryAttempts'/);
  assert.match(store, /RETURNING job_id/);
});

check('worker process fails fast and publishes the dedicated role before claims', () => {
  const workerProcess = read('src/worker.ts');
  assert.match(workerProcess, /RUN_PRINT_QUEUE_WORKER && env\.RUN_SYNC_SCHEDULER/);
  assert.ok(
    workerProcess.indexOf("await setWorkerMode('print-worker')") <
      workerProcess.indexOf('await startPrintQueueWorker()'),
  );
  assert.match(workerProcess, /main\(\)\.catch/);
  assert.match(workerProcess, /startup failed; exiting unhealthy/);
});

check('deep health separates list rows from worker/durable health', () => {
  const health = read('src/routes/health.ts');
  assert.match(health, /name: 'printQueueWorker'/);
  assert.match(health, /queuedCount: Number\(summary\?\.queued_count/);
  assert.match(health, /durableOldestActiveAgeSeconds/);
  assert.match(health, /providerPending/);
});

console.log('PS-430 Print Queue worker health/recovery guard passed.');
