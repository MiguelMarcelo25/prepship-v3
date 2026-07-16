import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const healthSource = readFileSync('src/routes/health.ts', 'utf8');
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));

function routeBody(routePath) {
  const marker = `app.get('${routePath}'`;
  const start = healthSource.indexOf(marker);
  assert.notEqual(start, -1, `health route defines ${routePath}`);
  const next = healthSource.indexOf('\napp.get(', start + marker.length);
  return healthSource.slice(start, next === -1 ? undefined : next);
}

const lightHealth = routeBody('/');
const readyHealth = routeBody('/ready');
const deepHealth = routeBody('/deep');

assert.equal(
  packageJson.scripts?.['test:health-deep-readiness'],
  'node scripts/health-deep-readiness-guard.mjs',
  'package exposes health deep-readiness guard'
);

assert(
  !lightHealth.includes('checkDbHealth') &&
    !lightHealth.includes('checkDeepReadiness') &&
    !lightHealth.includes('healthSql'),
  '/health remains lightweight and does not perform DB/deep dependency checks'
);

assert(
  readyHealth.includes('checkReadyReadiness') && !readyHealth.includes('checkDeepReadiness'),
  '/ready uses the lightweight rotation-signal checker'
);
assert(
  deepHealth.includes('checkDeepReadiness'),
  '/deep uses the full dependency checker'
);

for (const expected of [
  "checkComponent('db'",
  "checkComponent('dbWrite'",
  "checkComponent('orders'",
  "checkComponent('printQueue'",
  "checkComponent('eventLoop'",
  "name: 'printQueueWorker'",
  "name: 'syncFreshness'",
]) {
  assert(healthSource.includes(expected), `deep readiness reports ${expected}`);
}

assert(healthSource.includes('select 1'), 'deep readiness verifies DB select 1');
assert(
  /from\s+orders/i.test(healthSource),
  'deep readiness verifies minimal orders dependency'
);
assert(
  /from\s+print_queue_orders/i.test(healthSource),
  'deep readiness verifies print queue summary dependency'
);
assert(
  healthSource.includes('queuedCount') && healthSource.includes('totalCount'),
  'print queue readiness returns sanitized queue counts only'
);
assert(
  healthSource.includes('Promise.race') && healthSource.includes('timeoutMs'),
  'deep readiness checks run under explicit timeouts'
);
assert(
  /const \[db, dbWrite, eventLoop\] = await Promise\.all\(\[/.test(healthSource) &&
    /const \[orders, printQueue, printQueueWorker\] = await Promise\.all\(\[/.test(healthSource) &&
    /const syncFreshness = await checkSyncFreshness\(\)/.test(healthSource) &&
    /const components = \[[\s\S]*db,[\s\S]*dbWrite,[\s\S]*orders,[\s\S]*printQueue,[\s\S]*printQueueWorker,[\s\S]*syncFreshness,[\s\S]*eventLoop,[\s\S]*\]/.test(healthSource),
  'deep readiness stages DB probes within the bounded health pool'
);
assert(
  /status: health\.verdict\.alert \? 'fail' : 'ok'/.test(healthSource),
  'deep readiness fails closed on backend sync freshness/watchdog alerts'
);
assert(
  healthSource.includes('503'),
  'deep readiness returns HTTP 503 when any required component fails'
);
assert(
  !readyHealth.includes('error:') &&
    !readyHealth.includes('warning:') &&
    !deepHealth.includes('error:') &&
    !deepHealth.includes('warning:'),
  'readiness responses do not expose raw errors'
);

console.log('PASS health deep-readiness guard');
