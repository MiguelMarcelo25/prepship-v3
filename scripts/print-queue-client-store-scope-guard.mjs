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
  routeSource.includes('getClientStoreScope') && routeSource.includes('type ClientStoreScope'),
  'print-queue route imports client/store scope helpers',
);
assert(
  routeSource.includes('printQueueScopeFromContext') &&
    routeSource.includes("c.get('clientIds'") &&
    routeSource.includes("c.get('storeIds'"),
  'print-queue route builds scope from auth context',
);
assert(
  routeSource.includes('listQueue(q.clientId, q.includePrinted, printQueueScopeFromContext(c))'),
  'print-queue list passes auth scope into service',
);
assert(
  serviceSource.includes('type PrintQueueListScope') &&
    serviceSource.includes('scopeClientIds?: number[]') &&
    serviceSource.includes('scopeStoreIds?: number[]') &&
    serviceSource.includes('scopeRestricted?: boolean'),
  'print-queue service accepts client/store scope input',
);
assert(
  serviceSource.includes('printQueueScopePredicate') &&
    serviceSource.includes('printQueue.clientId') &&
    serviceSource.includes('clients.storeIds'),
  'print-queue service defines client/store scope predicate',
);
assert(
  serviceSource.includes('printQueueScopePredicate(scope)') &&
    serviceSource.includes('and(...conds)'),
  'print-queue list applies client/store scope predicate',
);
assert(
  packageJson.scripts?.['test:print-queue-client-scope'] ===
    'node scripts/print-queue-client-store-scope-guard.mjs',
  'package exposes print-queue client/store scope guard',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
