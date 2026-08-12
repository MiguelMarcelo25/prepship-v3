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
  "name: 'fulfillmentOutbox'",
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
// PS-503 (2026-08-12): this assertion used to pin the literal destructure
// `const [db, dbWrite, eventLoop] = await Promise.all([`. That is a VALUE pin,
// not a property pin: it blocked adding any probe to the stage, including
// checkMainPool, which runs on db/client's pool and consumes none of the health
// pool budget this rule exists to protect. Third instance of that failure mode
// in this repo. Repointed at the property itself — no concurrent stage may
// exceed the health pool's max of 3 — so a legitimate probe on another pool
// passes while a genuine over-subscription still fails.
const HEALTH_POOL_MAX = 3;
// Probes that do NOT draw from healthSql. Adding to this list is a deliberate,
// reviewable act: get it wrong and the budget check silently under-counts.
const NON_HEALTH_POOL_PROBES = new Set([
  'checkEventLoopDelay', // pure event-loop timing, no DB
  'checkMainPool', // PS-503: queries db/client's main pool
]);

function functionBody(name) {
  const start = healthSource.indexOf(`async function ${name}`);
  assert.notEqual(start, -1, `${name} exists`);
  return healthSource.slice(start, healthSource.indexOf('\n}', start));
}

// PS-503: budget BOTH readiness checkers. This previously covered only
// checkDeepReadiness, leaving checkReadyReadiness — the endpoint Render actually
// rotates on — free to over-subscribe the health pool undetected.
let stagesChecked = 0;
for (const checker of ['checkReadyReadiness', 'checkDeepReadiness']) {
  const body = functionBody(checker);
  const stages = [...body.matchAll(/await Promise\.all\(\[([\s\S]*?)\]\)/g)];
  assert(stages.length >= 1, `${checker} still stages its probes`);
  for (const [, stage] of stages) {
    const healthPoolProbes = [...stage.matchAll(/\b(check[A-Za-z]+)\s*\(/g)]
      .map((match) => match[1])
      .filter((name) => !NON_HEALTH_POOL_PROBES.has(name));
    assert(
      healthPoolProbes.length <= HEALTH_POOL_MAX,
      `${checker} issues ${healthPoolProbes.length} health-pool probes ` +
        `(max ${HEALTH_POOL_MAX}): ${healthPoolProbes.join(', ')}. On Render these ` +
        `queue client-side until their timeout and never reach Postgres.`
    );
    stagesChecked += 1;
  }
}
assert(stagesChecked >= 3, 'both readiness checkers were budget-checked');

assert(
  /const syncFreshness = await checkSyncFreshness\(\)/.test(healthSource) &&
    /const fulfillmentOutbox = await checkFulfillmentOutboxWorker\(\)/.test(healthSource),
  'the two heaviest probes stay sequential'
);
for (const component of [
  'db',
  'dbWrite',
  'mainPool',
  'orders',
  'printQueue',
  'printQueueWorker',
  'syncFreshness',
  'fulfillmentOutbox',
  'eventLoop',
]) {
  assert(
    new RegExp(`const components = \\[[\\s\\S]*?\\b${component},`).test(healthSource),
    `deep readiness reports the ${component} component`
  );
}
assert(
  healthSource.includes('evaluateWorkerJobSkipHealth') &&
    healthSource.includes("worker.status?.jobs['prepship.sync.fulfillment-outbox']") &&
    !readyHealth.includes('checkFulfillmentOutboxWorker'),
  'persistent fulfillment-outbox skips degrade deep health without making /ready heavyweight'
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
