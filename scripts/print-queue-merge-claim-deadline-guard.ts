import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DeadlineExceededError, withDeadline } from '../src/lib/with-deadline';

const worker = readFileSync('src/services/print-queue-worker.ts', 'utf8');
const printQueue = readFileSync('src/services/print-queue.ts', 'utf8');

async function main(): Promise<void> {
  await assert.rejects(
    withDeadline(
      () => new Promise<never>(() => undefined),
      25,
      'prepship.print-queue.merge:test:claim',
    ),
    DeadlineExceededError,
  );

  assert.match(
    worker,
    /withDeadline\(\s*\(\) => claimPrintMergeJobRecord\([\s\S]{0,260}PRINT_QUEUE_MERGE_CLAIM_TIMEOUT_MS/,
  );
  assert.match(
    worker,
    /error instanceof DeadlineExceededError[\s\S]{0,160}requestFatalWorkerRestart\('merge_claim_timeout'\)/,
  );
  assert.match(worker, /merge completed[\s\S]{0,180}generation=.*merged=/);
  assert.doesNotMatch(printQueue, /Starting merge[^\n]*â€¦/);
  assert.match(printQueue, /Starting merge[^\n]*…/);

  console.log('print queue merge claim deadline guard passed');
}

void main();
