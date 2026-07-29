import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { readDurableStatusWithTimeout } from '../src/services/print-queue/durable-status-read';

function read(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

function blockBetween(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  assert.notEqual(startIndex, -1, `found block start: ${start}`);
  const endIndex = text.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `found block end: ${end}`);
  return text.slice(startIndex, endIndex);
}

const pg = new PGlite();
try {
  await pg.exec(`
    CREATE TABLE print_queue_orders (
      id text PRIMARY KEY,
      client_id integer NOT NULL,
      order_id text NOT NULL,
      label_url text NOT NULL,
      status text NOT NULL,
      UNIQUE (order_id, client_id)
    );
    INSERT INTO print_queue_orders (id, client_id, order_id, label_url, status)
    VALUES ('one', 1, '101', 'old.pdf', 'queued');
  `);

  const initial = await pg.query<{ status: string }>(
    `SELECT status FROM print_queue_orders WHERE order_id = '101' AND client_id = 1`,
  );
  assert.equal(initial.rows[0]?.status, 'queued', 'pre-read observes queued state');
  await pg.exec(`UPDATE print_queue_orders SET status = 'printed' WHERE order_id = '101'`);
  const blocked = await pg.query(`
    INSERT INTO print_queue_orders (id, client_id, order_id, label_url, status)
    VALUES ('replacement', 1, '101', 'new.pdf', 'queued')
    ON CONFLICT (order_id, client_id) DO UPDATE SET
      label_url = excluded.label_url,
      status = 'queued'
    WHERE print_queue_orders.status = 'queued'
    RETURNING id
  `);
  assert.equal(blocked.rows.length, 0, 'finalized row blocks the conflicting refresh');
  const finalized = await pg.query<{ label_url: string; status: string }>(
    `SELECT label_url, status FROM print_queue_orders WHERE order_id = '101'`,
  );
  assert.deepEqual(
    finalized.rows[0],
    { label_url: 'old.pdf', status: 'printed' },
    'race winner remains printed with its original label',
  );

  await pg.exec(`UPDATE print_queue_orders SET status = 'queued' WHERE order_id = '101'`);
  const refreshed = await pg.query(`
    INSERT INTO print_queue_orders (id, client_id, order_id, label_url, status)
    VALUES ('replacement', 1, '101', 'new.pdf', 'queued')
    ON CONFLICT (order_id, client_id) DO UPDATE SET
      label_url = excluded.label_url,
      status = 'queued'
    WHERE print_queue_orders.status = 'queued'
    RETURNING id
  `);
  assert.equal(refreshed.rows.length, 1, 'still-queued row remains refreshable');
} finally {
  await pg.close();
}

// Asserts the two fields this guard is about -- "missing" and "timed out" must
// stay distinguishable -- rather than deepEqual on the whole object. The reader
// also returns elapsedMs now (added while diagnosing a print-queue hang, so an
// over-budget read is measurable rather than merely late), and a whole-object
// deepEqual turned that diagnostic addition into a red guard.
const missing = await readDurableStatusWithTimeout(async () => null, 20);
assert.equal(missing.value, null, 'missing durable status has no value');
assert.equal(missing.timedOut, false, 'missing is NOT reported as a timeout');
const timedOut = await readDurableStatusWithTimeout(
  () => new Promise<string | null>(() => undefined),
  5,
);
assert.equal(timedOut.value, null, 'timed-out durable read has no value');
assert.equal(timedOut.timedOut, true, 'slow durable read is explicit');
assert.equal(typeof timedOut.elapsedMs, 'number', 'a timed-out read reports how long it took');

const service = read('src/services/print-queue.ts');
const worker = read('src/services/print-queue-worker.ts');
const route = read('src/routes/print-queue.ts');
const doc = read('docs/ps-tickets/audit-4.7-print-queue-small-fixes.md');
const addBlock = blockBetween(
  service,
  'export async function addToQueue',
  'export async function startQueueSendJob',
);
const enqueueBlock = blockBetween(
  worker,
  'export async function enqueueQueueSendWorkerJob',
  'async function markRecoverableJobInterrupted',
);
const statusBlock = blockBetween(
  route,
  "app.get('/batch-send/status/:jobId'",
  '// PS-279: backend-owned Send-to-Queue ROUTE PLAN',
);

assert.match(addBlock, /setWhere:\s*eq\(printQueue\.status, 'queued'\)/);
assert.match(addBlock, /if \(!entry\)[\s\S]{0,180}PrintQueueAlreadyFinalizedError/);
assert.ok(
  addBlock.indexOf('if (!entry)') < addBlock.indexOf('repairMissingConfirmationForQueuedLabel'),
  'blocked UPSERT never starts confirmation repair',
);
assert.match(worker, /let enqueueBossPromise: Promise<PgBoss> \| null = null/);
assert.match(worker, /async function getPrintQueueEnqueueBoss\(\)/);
assert.match(enqueueBlock, /await getPrintQueueEnqueueBoss\(\)/);
assert.doesNotMatch(enqueueBlock, /createPrintQueueBoss|\.start\(|\.stop\(/);
assert.match(statusBlock, /if \(!job && durableReadTimedOut\)/);
assert.match(statusBlock, /PRINT_QUEUE_STATUS_UNAVAILABLE[\s\S]{0,160}503/);
assert.match(route, /readDurableStatusWithTimeout/);
assert.doesNotMatch(route, /function withDurableStatusTimeout/);

for (const field of [
  'Business rule/workflow being changed',
  'Canonical backend/domain/read-model/policy owner',
  'Current duplicated/unsafe owners',
  'Where bad/stale/incomplete data can enter',
  'Callers that must delegate to the owner',
  'Wrapper/resolver/helper logic to delete or explicitly forbid',
  'Frontend role: display/action only; no authoritative business logic',
  'Backend boundary tests required',
  'Workflow/UI proof required',
]) {
  assert.ok(doc.includes(field), `placement record includes ${field}`);
}

console.log('PASS Audit 4.7 Print Queue small fixes guard');
