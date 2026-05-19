import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function assert(condition, message) {
  if (condition) pass(message);
  else fail(message);
}

const routeSource = read('src/routes/print-queue.ts');
const serviceSource = read('src/services/print-queue.ts');
const packageJson = JSON.parse(read('package.json'));

assert(
  routeSource.includes('assertPrintQueueClientsVisible') &&
    routeSource.includes('canViewMergeJob') &&
    routeSource.includes('canViewQueueSendJob'),
  'print-queue route imports ownership helpers',
);
assert(
  routeSource.includes('addToQueue({') &&
    routeSource.includes('scope: printQueueScopeFromContext(c)'),
  'print-queue add passes auth scope into service',
);
assert(
  routeSource.includes('assertPrintQueueClientsVisible(') &&
    routeSource.includes('b.orders.map((order) => order.client_id)'),
  'print-queue batch-send validates requested client ids before work starts',
);
assert(
  routeSource.includes('canViewQueueSendJob(job, printQueueScopeFromContext(c))'),
  'print-queue batch-send status checks job visibility',
);
assert(
  routeSource.includes('clearQueue(body?.client_id, printQueueScopeFromContext(c))'),
  'print-queue clear passes auth scope into service',
);
assert(
  routeSource.includes('scope: printQueueScopeFromContext(c)') &&
    routeSource.includes('startPrintJob({'),
  'print-queue print job creation passes auth scope into service',
);
assert(
  routeSource.includes('canViewMergeJob(job, printQueueScopeFromContext(c))'),
  'print-queue print status/download checks job visibility',
);
assert(
  routeSource.includes('removeFromQueue(entryId, undefined, printQueueScopeFromContext(c))'),
  'print-queue delete passes auth scope into service',
);
assert(
  serviceSource.includes('clientIds: number[]') &&
    serviceSource.includes('QueueSendJob') &&
    serviceSource.includes('MergeJob'),
  'print-queue jobs persist client ownership ids in memory',
);
assert(
  serviceSource.includes('assertPrintQueueClientsVisible') &&
    serviceSource.includes('canViewQueueSendJob') &&
    serviceSource.includes('canViewMergeJob'),
  'print-queue service exposes ownership guard helpers',
);
assert(
  serviceSource.includes('printQueueClientScopePredicate') &&
    serviceSource.includes('printQueueScopePredicate(scope)'),
  'print-queue service uses client/store predicates for queue ownership',
);
assert(
  packageJson.scripts?.['test:print-queue-ownership'] ===
    'node scripts/print-queue-ownership-guard.mjs',
  'package exposes print-queue ownership guard',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
