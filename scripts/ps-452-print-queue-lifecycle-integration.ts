/**
 * PS-452 migrated-Postgres and 1,000-order lifecycle certification.
 *
 * Per user override unlock shipped data on 2026-07-21: this runs only against
 * an in-memory PGlite database and pure spies. It cannot buy postage, call a
 * provider, notify a marketplace, or mutate production order/shipment data.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import {
  planQueueSendWorkerChunks,
  queueSendLocalTailFailureState,
  QueueSendJobInterruptedError,
  runQueueSendPool,
} from '../src/services/print-queue/queue-send-execution';
import { planQueueSendRecovery } from '../src/services/print-queue/queue-send-recovery';
import { deriveQueueSendProgressCounters } from '../src/services/print-queue/queue-send-status';
import {
  queueSendPreflightHasBlockingOperation,
  type QueueSendJobItemInput,
} from '../src/services/print-queue/queue-send-item-state';

assert.equal(queueSendLocalTailFailureState('receipt_resume', 1), 'receipt_resume');
assert.equal(queueSendLocalTailFailureState('shipment_persisted', 2), 'shipment_persisted');
assert.equal(queueSendLocalTailFailureState('receipt_resume', 3), 'failed_terminal');
assert.equal(queueSendLocalTailFailureState('provider_pending_recovery', 1), null);
const activeLockOrderIds = new Set([4_521, 4_522]);
assert.equal(queueSendPreflightHasBlockingOperation({
  orderId: 4_521,
  hasActivePurchaseLock: true,
  hasHeldProviderOperation: false,
  ignoreActivePurchaseLockOrderIds: activeLockOrderIds,
}), false, 'receipt/local-tail recovery ignores only the orphaned purchase lock');
assert.equal(queueSendPreflightHasBlockingOperation({
  orderId: 4_521,
  hasActivePurchaseLock: true,
  hasHeldProviderOperation: true,
  ignoreActivePurchaseLockOrderIds: activeLockOrderIds,
}), true, 'an unresolved provider operation remains held even in local-tail recovery');

function basePrintQueueMigration(): string {
  const migration = readFileSync('drizzle/0062_runtime_schema_ownership.sql', 'utf8');
  const start = migration.indexOf('CREATE TABLE IF NOT EXISTS print_queue_send_jobs');
  const end = migration.indexOf('CREATE TABLE IF NOT EXISTS print_queue_merged_pdfs');
  assert.ok(start >= 0 && end > start, 'migration 0062 contains Print Queue durable tables');
  return migration.slice(start, end);
}

const pg = new PGlite();
try {
  await pg.exec(basePrintQueueMigration());
  await pg.query(
    `INSERT INTO print_queue_send_jobs (
      job_id, status, active, total, snapshot, created_at, updated_at
    ) VALUES ($1, 'interrupted', false, 1, $2::jsonb, now() - interval '1 hour', now() - interval '30 minutes')`,
    ['ps-452-legacy', JSON.stringify({
      version: 1,
      jobId: 'ps-452-legacy',
      status: 'interrupted',
      active: false,
      recoveryAttempts: 7,
      chunkSequence: 9,
      workerOrders: [{ orderId: 99 }],
      results: [],
    })],
  );
  await pg.exec(`
    INSERT INTO print_queue_batch_job_items (job_id, order_id, state)
    VALUES ('ps-452-legacy', 99, 'ready');
  `);
  await pg.exec(readFileSync('drizzle/0073_print_queue_send_execution_fences.sql', 'utf8'));
  const legacyBackfill = await pg.query<{
    generation: number;
    current_chunk_sequence: number;
    snapshot_updated_at: Date | string | null;
  }>(`
    SELECT generation, current_chunk_sequence, snapshot_updated_at
    FROM print_queue_send_jobs
    WHERE job_id = 'ps-452-legacy'
  `);
  assert.deepEqual(
    legacyBackfill.rows.map((row) => [
      Number(row.generation),
      Number(row.current_chunk_sequence),
      row.snapshot_updated_at != null,
    ]),
    [[7, 9, true]],
    '0073 backfills legacy recoveryAttempts/chunkSequence and snapshot time',
  );
  const legacyItemBackfill = await pg.query<{ attempt_count: number; generation: number }>(`
    SELECT attempt_count, generation
    FROM print_queue_batch_job_items
    WHERE job_id = 'ps-452-legacy' AND order_id = 99
  `);
  assert.deepEqual(
    legacyItemBackfill.rows.map((row) => [Number(row.attempt_count), Number(row.generation)]),
    [[0, 0]],
    '0073 gives legacy items bounded-attempt defaults',
  );
  const requiredConstraints = await pg.query<{ conname: string }>(`
    SELECT conname
    FROM pg_constraint
    WHERE conname IN (
      'print_queue_send_jobs_generation_nonnegative',
      'print_queue_send_jobs_chunk_sequence_positive',
      'print_queue_batch_job_items_attempt_count_nonnegative',
      'print_queue_batch_job_items_generation_nonnegative'
    )
    ORDER BY conname
  `);
  assert.equal(requiredConstraints.rows.length, 4, '0073 installs all four execution-invariant constraints');
  await assert.rejects(
    pg.exec(`UPDATE print_queue_send_jobs SET generation = -1 WHERE job_id = 'ps-452-legacy'`),
    /check|constraint/i,
    'negative parent generations are rejected by the migrated database',
  );
  await pg.query(
    `INSERT INTO print_queue_send_jobs (
      job_id, status, active, total, snapshot, generation,
      current_chunk_sequence, snapshot_updated_at, created_at, updated_at
    ) VALUES ($1, 'pending', true, 3, $2::jsonb, 0, 1, now(), now(), now())`,
    ['ps-452-db', JSON.stringify({
      version: 1,
      jobId: 'ps-452-db',
      status: 'pending',
      active: true,
      generation: 0,
      chunkSequence: 1,
      recoveryAttempts: 0,
      workerOrders: [{ orderId: 1 }, { orderId: 2 }, { orderId: 3 }],
      results: [],
    })],
  );
  await pg.exec(`
    INSERT INTO print_queue_batch_job_items (
      job_id, order_id, state, attempt_count, generation
    ) VALUES
      ('ps-452-db', 1, 'ready', 0, 0),
      ('ps-452-db', 2, 'ready', 0, 0),
      ('ps-452-db', 3, 'provider_pending', 0, 0);
  `);

  const claim = async () => pg.query(`
    UPDATE print_queue_send_jobs
    SET status = 'running', active = true, claimed_at = now(), heartbeat_at = now()
    WHERE job_id = 'ps-452-db'
      AND status = 'pending'
      AND generation = 0
      AND current_chunk_sequence = 1
    RETURNING job_id
  `);
  const firstClaim = await claim();
  const secondClaim = await claim();
  assert.equal(firstClaim.rows.length, 1, 'one replica claims the generation/chunk');
  assert.equal(secondClaim.rows.length, 0, 'a second replica cannot join a running claim');

  await pg.exec(`
    UPDATE print_queue_send_jobs
    SET updated_at = now() - interval '20 minutes', heartbeat_at = now()
    WHERE job_id = 'ps-452-db';
  `);
  const freshHeartbeatRecovery = await pg.query(`
    UPDATE print_queue_send_jobs
    SET generation = generation + 1, status = 'pending', active = true
    WHERE job_id = 'ps-452-db'
      AND status = 'running'
      AND coalesce(heartbeat_at, updated_at) < now() - interval '210 seconds'
    RETURNING generation
  `);
  assert.equal(freshHeartbeatRecovery.rows.length, 0, 'a fresh heartbeat blocks the reaper');

  await pg.exec(`
    UPDATE print_queue_send_jobs
    SET heartbeat_at = now() - interval '211 seconds'
    WHERE job_id = 'ps-452-db';
  `);
  const recovered = await pg.query<{ generation: number | string }>(`
    UPDATE print_queue_send_jobs
    SET
      generation = generation + 1,
      current_chunk_sequence = 1,
      status = 'pending',
      active = true,
      claimed_at = NULL,
      heartbeat_at = NULL,
      snapshot_updated_at = now(),
      updated_at = now()
    WHERE job_id = 'ps-452-db'
      AND status = 'running'
      AND coalesce(heartbeat_at, updated_at) < now() - interval '210 seconds'
    RETURNING generation
  `);
  assert.equal(Number(recovered.rows[0]?.generation), 1);

  const staleParentWrite = await pg.query(`
    UPDATE print_queue_send_jobs SET progress = 90
    WHERE job_id = 'ps-452-db' AND generation = 0
    RETURNING job_id
  `);
  assert.equal(staleParentWrite.rows.length, 0, 'generation zero cannot overwrite generation one');
  const fencedItemUpsert = (generation: number) => pg.query(`
    INSERT INTO print_queue_batch_job_items (
      job_id, order_id, attempt_count, generation, state
    )
    SELECT 'ps-452-db', x.order_id, x.attempt_count, x.generation, x.state
    FROM jsonb_to_recordset($1::jsonb) AS x(
      order_id integer, attempt_count integer, generation integer, state text
    )
    JOIN print_queue_send_jobs AS jobs
      ON jobs.job_id = 'ps-452-db' AND jobs.generation = x.generation
    ON CONFLICT (job_id, order_id) DO UPDATE SET
      attempt_count = CASE
        WHEN print_queue_batch_job_items.state IN ('provider_pending', 'provider_pending_recovery')
          AND EXCLUDED.state IN ('receipt_resume', 'shipment_persisted')
          THEN EXCLUDED.attempt_count
        ELSE greatest(print_queue_batch_job_items.attempt_count, EXCLUDED.attempt_count)
      END,
      generation = EXCLUDED.generation,
      state = EXCLUDED.state
    WHERE print_queue_batch_job_items.generation <= EXCLUDED.generation
    RETURNING order_id
  `, [JSON.stringify([{ order_id: 2, attempt_count: 0, generation, state: 'ready' }])]);
  assert.equal((await fencedItemUpsert(0)).rows.length, 0,
    'the real upsert shape rejects a stale parent generation');
  assert.equal((await fencedItemUpsert(1)).rows.length, 1,
    'the real upsert shape admits the current parent generation');
  await pg.exec(`
    UPDATE print_queue_batch_job_items SET generation = 1 WHERE job_id = 'ps-452-db';
    UPDATE print_queue_send_jobs SET status = 'running' WHERE job_id = 'ps-452-db';
  `);
  const staleItemWrite = await pg.query(`
    UPDATE print_queue_batch_job_items SET state = 'failed_terminal'
    WHERE job_id = 'ps-452-db' AND order_id = 1 AND generation = 0
    RETURNING order_id
  `);
  assert.equal(staleItemWrite.rows.length, 0, 'stale item writes are fenced');

  for (let generation = 1; generation <= 3; generation += 1) {
    await pg.query(
      `UPDATE print_queue_send_jobs SET generation = $1 WHERE job_id = 'ps-452-db'`,
      [generation],
    );
    const attempt = await pg.query<{ attempt_count: number | string }>(`
      UPDATE print_queue_batch_job_items
      SET attempt_count = attempt_count + 1, generation = $1
      WHERE job_id = 'ps-452-db'
        AND order_id = 1
        AND state IN ('ready', 'validating_rate', 'acquiring_lock', 'receipt_resume', 'shipment_persisted')
        AND attempt_count < 3
        AND generation <= $1
        AND EXISTS (
          SELECT 1 FROM print_queue_send_jobs AS jobs
          WHERE jobs.job_id = 'ps-452-db'
            AND jobs.status = 'running'
            AND jobs.generation = $1
            AND jobs.current_chunk_sequence = 1
        )
      RETURNING attempt_count
    `, [generation]);
    assert.equal(Number(attempt.rows[0]?.attempt_count), generation);
  }
  await pg.exec(`
    UPDATE print_queue_batch_job_items
    SET state = 'failed_terminal', blocked_reason = 'recovery_attempts_exhausted'
    WHERE job_id = 'ps-452-db'
      AND state IN ('ready', 'validating_rate', 'acquiring_lock', 'receipt_resume', 'shipment_persisted')
      AND attempt_count >= 3;
  `);
  const parked = await pg.query<{
    order_id: number;
    state: string;
    attempt_count: number | string;
  }>(`
    SELECT order_id, state, attempt_count
    FROM print_queue_batch_job_items
    WHERE job_id = 'ps-452-db'
    ORDER BY order_id
  `);
  assert.deepEqual(
    parked.rows.map((row) => [row.order_id, row.state, Number(row.attempt_count)]),
    [
      [1, 'failed_terminal', 3],
      [2, 'ready', 0],
      [3, 'provider_pending', 0],
    ],
    'one poison item parks without consuming or falsifying sibling/provider state',
  );

  await pg.exec(`
    UPDATE print_queue_batch_job_items
    SET state = 'provider_pending', attempt_count = 3, generation = 3
    WHERE job_id = 'ps-452-db' AND order_id = 3;
  `);
  const recoveredReceiptTail = await pg.query(`
    INSERT INTO print_queue_batch_job_items (
      job_id, order_id, attempt_count, generation, state, blocked_reason
    ) VALUES (
      'ps-452-db', 3, 0, 3, 'receipt_resume', 'provider_receipt_ready_for_local_resume'
    )
    ON CONFLICT (job_id, order_id) DO UPDATE SET
      attempt_count = CASE
        WHEN print_queue_batch_job_items.state IN ('provider_pending', 'provider_pending_recovery')
          AND EXCLUDED.state IN ('receipt_resume', 'shipment_persisted')
          THEN EXCLUDED.attempt_count
        ELSE greatest(print_queue_batch_job_items.attempt_count, EXCLUDED.attempt_count)
      END,
      generation = EXCLUDED.generation,
      state = EXCLUDED.state,
      blocked_reason = EXCLUDED.blocked_reason
    RETURNING attempt_count, state
  `);
  assert.deepEqual(
    recoveredReceiptTail.rows.map((row: any) => [Number(row.attempt_count), row.state]),
    [[0, 'receipt_resume']],
    'known provider truth starts a separate bounded local queue-tail budget',
  );
  const recoveredTailAttempt = await pg.query<{ attempt_count: number | string }>(`
    UPDATE print_queue_batch_job_items
    SET attempt_count = attempt_count + 1
    WHERE job_id = 'ps-452-db'
      AND order_id = 3
      AND state IN ('ready', 'validating_rate', 'acquiring_lock', 'receipt_resume', 'shipment_persisted')
      AND attempt_count < 3
      AND EXISTS (
        SELECT 1 FROM print_queue_send_jobs AS jobs
        WHERE jobs.job_id = 'ps-452-db'
          AND jobs.status = 'running'
          AND jobs.generation = 3
          AND jobs.current_chunk_sequence = 1
      )
    RETURNING attempt_count
  `);
  assert.equal(Number(recoveredTailAttempt.rows[0]?.attempt_count), 1,
    'the recovered receipt can execute its queue-only tail even after the provider-phase cap');
  await pg.exec(`
    UPDATE print_queue_batch_job_items
    SET state = 'provider_pending', attempt_count = 0, generation = 3, blocked_reason = NULL
    WHERE job_id = 'ps-452-db' AND order_id = 3;
  `);

  const advance = async () => pg.query(`
    UPDATE print_queue_send_jobs
    SET status = 'pending', active = true, current_chunk_sequence = 2
    WHERE job_id = 'ps-452-db'
      AND status IN ('pending', 'interrupted')
      AND generation = 1
      AND current_chunk_sequence = 1
    RETURNING job_id
  `);
  await pg.exec(`
    UPDATE print_queue_send_jobs
    SET status = 'interrupted', generation = 1, current_chunk_sequence = 1
    WHERE job_id = 'ps-452-db'
  `);
  assert.equal((await advance()).rows.length, 1);
  assert.equal((await advance()).rows.length, 0, 'continuation chunk CAS is exclusive');
  const lateChunkOneInterruption = await pg.query(`
    UPDATE print_queue_send_jobs
    SET status = 'interrupted', active = false
    WHERE job_id = 'ps-452-db'
      AND generation = 1
      AND current_chunk_sequence = 1
    RETURNING job_id
  `);
  assert.equal(
    lateChunkOneInterruption.rows.length,
    0,
    'a late chunk-one failure cannot interrupt already-reserved chunk two',
  );

  await pg.exec(`
    UPDATE print_queue_send_jobs
    SET status = 'interrupted', generation = 30,
        heartbeat_at = NULL, updated_at = now() - interval '211 seconds'
    WHERE job_id = 'ps-452-db';
  `);
  const parentCap = await pg.query<{ exhausted_count: number | string }>(`
    WITH exhausted AS (
      UPDATE print_queue_send_jobs
      SET status = 'error', active = false, generation = generation + 1,
          heartbeat_at = NULL, updated_at = now()
      WHERE job_id = 'ps-452-db'
        AND status IN ('pending', 'running', 'interrupted')
        AND coalesce(heartbeat_at, updated_at) < now() - interval '210 seconds'
        AND generation >= 30
      RETURNING job_id, generation
    ), parked AS (
      UPDATE print_queue_batch_job_items AS items
      SET state = 'failed_terminal', generation = exhausted.generation,
          blocked_reason = 'parent_recovery_attempts_exhausted', updated_at = now()
      FROM exhausted
      WHERE items.job_id = exhausted.job_id
        AND items.state IN ('ready', 'validating_rate', 'acquiring_lock', 'receipt_resume', 'shipment_persisted')
        AND items.generation < exhausted.generation
      RETURNING items.job_id
    )
    SELECT count(*)::integer AS exhausted_count FROM exhausted
  `);
  assert.equal(Number(parentCap.rows[0]?.exhausted_count), 1);
  const capped = await pg.query<{ order_id: number; state: string }>(`
    SELECT order_id, state FROM print_queue_batch_job_items
    WHERE job_id = 'ps-452-db' ORDER BY order_id
  `);
  assert.deepEqual(capped.rows.map((row) => [row.order_id, row.state]), [
    [1, 'failed_terminal'],
    [2, 'failed_terminal'],
    [3, 'provider_pending'],
  ], 'the parent cap parks only safe unfinished items');
} finally {
  await pg.close();
}

let releaseSibling!: () => void;
let siblingStarted!: () => void;
const siblingGate = new Promise<void>((resolve) => { releaseSibling = resolve; });
const siblingAdmission = new Promise<void>((resolve) => { siblingStarted = resolve; });
const admitted: number[] = [];
const drainRun = runQueueSendPool([1, 2, 3], async (item) => {
  admitted.push(item);
  if (item === 1) throw new Error('synthetic worker failure');
  siblingStarted();
  await siblingGate;
}, 2);
let drainSettled = false;
void drainRun.then(
  () => { drainSettled = true; },
  () => { drainSettled = true; },
);
await siblingAdmission;
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(drainSettled, false, 'the pool retains its claim while an admitted sibling is live');
releaseSibling();
await assert.rejects(drainRun, /synthetic worker failure/);
assert.deepEqual(admitted, [1, 2], 'failure stops admission but drains the sibling');

type SyntheticOrder = { orderId: number; clientId: number };
const orders: SyntheticOrder[] = Array.from({ length: 1_000 }, (_, index) => ({
  orderId: index + 1,
  clientId: 1,
}));
const chunks = planQueueSendWorkerChunks(orders);
assert.equal(chunks.length, 50);
assert.deepEqual(chunks.map((chunk) => chunk.length), Array(50).fill(20));

const poisonOrderId = 450;
const itemStates = new Map<number, QueueSendJobItemInput>(
  orders.map((order) => [order.orderId, {
    orderId: order.orderId,
    clientId: order.clientId,
    attemptCount: 0,
    generation: 0,
    state: 'ready',
  }]),
);
const providerSpy = new Map<number, number>();
const progressSamples: number[] = [];
let generation = 0;
let crashCount = 0;

function sampleProgress(): void {
  const counters = deriveQueueSendProgressCounters({
    status: 'running',
    current: 0,
    total: orders.length,
    queued: 0,
    failed: 0,
    itemStates: [...itemStates.values()],
  });
  progressSamples.push(counters.completedOrderAttempts);
}

while (true) {
  const plan = planQueueSendRecovery({
    workerOrders: orders,
    itemStates: [...itemStates.values()],
  });
  if (plan.safeOrders.length === 0) break;
  let crashed = false;
  for (const chunk of planQueueSendWorkerChunks(plan.safeOrders)) {
    try {
      await runQueueSendPool(chunk, async (order) => {
        const state = itemStates.get(order.orderId)!;
        state.attemptCount = (state.attemptCount ?? 0) + 1;
        state.generation = generation;
        if (order.orderId === poisonOrderId) {
          throw new Error('synthetic poison');
        }
        providerSpy.set(order.orderId, (providerSpy.get(order.orderId) ?? 0) + 1);
        state.state = 'queued';
        state.queueEntryId = `queue-${order.orderId}`;
      }, 4);
      sampleProgress();
    } catch (error) {
      assert.match(error instanceof Error ? error.message : String(error), /synthetic poison/);
      crashCount += 1;
      const poison = itemStates.get(poisonOrderId)!;
      if ((poison.attemptCount ?? 0) >= 3) {
        poison.state = 'failed_terminal';
        poison.blockedReason = 'recovery_attempts_exhausted';
      }
      sampleProgress();
      generation += 1;
      crashed = true;
      break;
    }
  }
  if (!crashed) break;
}

const finalCounters = deriveQueueSendProgressCounters({
  status: 'done',
  current: 0,
  total: orders.length,
  queued: 0,
  failed: 0,
  itemStates: [...itemStates.values()],
});
assert.equal(crashCount, 3);
assert.equal(finalCounters.completedOrderAttempts, 1_000);
assert.equal(finalCounters.queued, 999);
assert.equal(finalCounters.failed, 1);
assert.equal(providerSpy.get(poisonOrderId) ?? 0, 0);
assert.ok([...providerSpy.values()].every((count) => count === 1), 'zero double sends');
assert.ok(
  progressSamples.every((value, index) => index === 0 || value >= progressSamples[index - 1]!),
  'parent progress is monotonic across three crash/recovery generations',
);
assert.equal(
  planQueueSendRecovery({ workerOrders: orders, itemStates: [...itemStates.values()] }).safeOrders.length,
  0,
  'repeat recovery cannot re-admit terminal items',
);

const unknownProviderStates: QueueSendJobItemInput[] = [{
  orderId: 2_001,
  clientId: 1,
  attemptCount: 1,
  generation: 0,
  state: 'provider_pending_recovery',
}];
const unknownPlan = planQueueSendRecovery({
  workerOrders: [{ orderId: 2_001, clientId: 1 } as SyntheticOrder],
  itemStates: unknownProviderStates,
});
assert.deepEqual(unknownPlan.safeOrders, []);
assert.deepEqual(unknownPlan.providerPendingOrderIds, [2_001]);

const worker = readFileSync('src/services/print-queue-worker.ts', 'utf8');
const service = readFileSync('src/services/print-queue.ts', 'utf8');
const store = readFileSync('src/services/print-queue/queue-send-job-store.ts', 'utf8');
const reconciler = readFileSync('src/services/print-queue/shipstation-operation-reconciler.ts', 'utf8');
const ledger = readFileSync('src/services/fulfillment-operation-ledger.ts', 'utf8');
const route = readFileSync('src/routes/print-queue.ts', 'utf8');
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
const applyScript = readFileSync('scripts/apply-ps-452-print-queue-lifecycle-migration.ts', 'utf8');
const packageJson = readFileSync('package.json', 'utf8');
assert.match(worker, /heartbeatQueueSendJobWorkerClaim/);
assert.match(worker, /advanceQueueSendJobChunk/);
assert.match(worker, /retryLimit:\s*0/);
assert.ok(
  worker.lastIndexOf('await handlerPromise.catch(() => undefined)') <
    worker.lastIndexOf('clearInterval(heartbeatTimer)'),
  'timeout keeps the heartbeat lease until every admitted task settles',
);
assert.match(
  worker,
  /reconciliationLeaseCurrent = await heartbeatQueueSendJobWorkerClaim/,
  'long reconciliation passes renew their exact generation lease',
);
assert.match(service, /claimQueueSendJobItemAttempt[\s\S]*?preflightQueueSendOrders/,
  'execution-time canonical preflight follows the durable item claim');
assert.match(store, /status = 'pending'[\s\S]*?generation = \$\{normalizedAttempt\}/,
  'only pending exact-generation rows can be worker-claimed');
assert.match(store, /state IN \('ready', 'validating_rate', 'acquiring_lock', 'receipt_resume', 'shipment_persisted'\)/);
assert.match(store, /EXCLUDED\.state IN \('receipt_resume', 'shipment_persisted'\)[\s\S]*?THEN EXCLUDED\.attempt_count/,
  'known provider truth receives a separate bounded local queue-tail budget');
assert.match(store, /JOIN print_queue_send_jobs AS jobs[\s\S]*?jobs\.generation = x\.generation/,
  'all item-state upserts are fenced by the current parent generation');
assert.match(store, /expectedChunkSequence[\s\S]*?current_chunk_sequence/,
  'interruption writes are fenced by both generation and chunk sequence');
assert.match(ledger, /getLatestLabelOperationForOrder[\s\S]*?orderBy/,
  'recovery reads the latest canonical operation, including terminal local truth');
assert.match(reconciler, /consumedQueueLabelShipmentId[\s\S]*?eq\(shipments\.id, localShipmentId\)/,
  'all consumed label providers recover from the exact committed shipment row without replay');
// Per user override unlock shipped data on 2026-07-22: the injected name is
// test-only; the assertion still proves only a voided historical receipt can
// re-enter before a new provider operation.
assert.match(reconciler, /consumedShipment\.status !== 'voided'[\s\S]*?nextSemanticGeneration[\s\S]*?isHistoricalConsumedQueueLabelOperation/,
  'only an exact voided historical consumed label can re-admit a new pre-ledger attempt');
assert.match(reconciler, /operation\.state === 'receipt_recorded'[\s\S]*?status: 'resume_receipt'/,
  'non-ShipStation durable receipts are re-admitted only through canonical receipt consumption');
assert.match(worker, /reconciliation\.status === 'resume_receipt'[\s\S]*?attemptCount: 0[\s\S]*?state: 'receipt_resume'/,
  'the worker re-enters a durable receipt without classifying it as a new provider attempt');
assert.match(reconciler, /if \(!operation\) return \{ status: 'no_effect' \}/,
  'a crash before ledger acquisition is safely re-admitted because dispatch was impossible');
assert.match(reconciler, /isQueueLabelSafeNoEffect/,
  'repeat recovery recognizes canonical failed-before-dispatch proof');
assert.match(service, /QueueSendReceiptPendingError[\s\S]*?state: localTailFailureState[\s\S]*?receiptPending[\s\S]*?\? 'receipt_resume'/,
  'a still-pending durable receipt stays in the bounded local recovery phase');
assert.match(service, /queueSendLocalTailFailureState[\s\S]*?admittedLocalTailState[\s\S]*?admittedAttemptCount/,
  'caught local-tail failures retain their phase until the bounded cap is exhausted');
const labels = readFileSync('src/services/labels.ts', 'utf8');
assert.match(labels, /action\.kind === 'resume_receipt'[\s\S]*?pollShopifyPurchaseToTerminal/,
  'Shopify resumes by polling the existing purchase result and never purchasing again');
assert.match(labels, /resumeLabelV2FromDurableReceipt[\s\S]*?allowProviderDispatch: false/,
  'carrier receipt recovery bypasses the orphaned process lock but forbids provider dispatch');
assert.match(labels, /resumeShopifyShippingLabelFromDurableReceipt[\s\S]*?allowProviderDispatch: false/,
  'Shopify receipt recovery bypasses the orphaned process lock but forbids a new purchase');
assert.equal(
  labels.match(/execution\.allowProviderDispatch === false/g)?.length,
  3,
  'Shopify, direct-carrier, and ShipStation dispatch branches all fail closed in receipt-only recovery',
);
assert.match(service, /admittedLocalTailState[\s\S]*?ignoreActivePurchaseLockOrderIds/,
  'execution preflight retains scope and status checks while ignoring only the local-tail process lock');
assert.match(service, /recoveryState === 'shipment_persisted'[\s\S]*?LabelArtifactMissingAfterPurchaseError/,
  'a persisted shipment with a missing artifact cannot fall through to provider purchase');
assert.match(route, /generation < PRINT_QUEUE_SEND_MAX_PARENT_RECOVERY_ATTEMPTS/,
  'the API does not advertise resume after the hard parent generation cap');
assert.match(ordersView, /status\.status === 'error'[\s\S]*?setQueueRecoveryStatus\(status\)/,
  'terminal per-order outcomes remain visible for operator review');
assert.match(applyScript, /--apply[\s\S]*?--confirm=/,
  'production migration application requires an explicit confirmation token');
assert.match(applyScript, /Migration refused: orders\/shipments mutation detected/);
assert.match(packageJson, /migrate:ps-452-print-queue-lifecycle/);

console.log(
  'PASS PS-452 lifecycle (migrated DB fences, heartbeat/reaper, 50x20 chunks, ' +
  '1,000 orders, poison parked after 3 attempts, 999 queued, zero double sends)',
);
