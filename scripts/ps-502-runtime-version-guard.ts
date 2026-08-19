/**
 * PS-502 immutable API/worker version evidence.
 *
 * This is provider-free: it validates Render's injected value and the static
 * wiring that exposes the API process separately from the persisted worker
 * process. No network, database, deployment, or feature flag is touched.
 */
import { readFileSync } from 'node:fs';
import { readRuntimeVersionIdentity } from '../src/lib/runtime-version.js';

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

const fullSha = '0a6308712f3da3f1cde7d76b075fcc799fa18755';
const exact = readRuntimeVersionIdentity({
  RENDER_GIT_COMMIT: fullSha.toUpperCase(),
  RENDER_SERVICE_ID: 'srv-api',
  RENDER_INSTANCE_ID: 'instance-api',
});
check('accepts and normalizes the full immutable Render commit',
  exact.commitSha === fullSha && exact.commitSource === 'RENDER_GIT_COMMIT');
check('retains non-secret service and instance correlation facts',
  exact.serviceId === 'srv-api' && exact.instanceId === 'instance-api');

for (const bad of [undefined, '', '0a63087', `${fullSha}suffix`, 'not-a-sha']) {
  const identity = readRuntimeVersionIdentity({ RENDER_GIT_COMMIT: bad });
  check(`rejects non-exact Render SHA ${JSON.stringify(bad)}`,
    identity.commitSha === null && identity.commitSource === 'unknown');
}

const workerStatus = readFileSync('src/services/worker-status.ts', 'utf8');
const health = readFileSync('src/routes/health.ts', 'utf8');
const workerRoute = readFileSync('src/routes/worker.ts', 'utf8');

check('worker snapshots persist the worker process runtime identity',
  /runtime: RuntimeVersionIdentity/.test(workerStatus) &&
  /runtime: runtimeVersionIdentity,[\s\S]*service: mode/.test(workerStatus));
check('API runtime status reports the API process runtime identity',
  /function getApiRuntimeStatus\(\)[\s\S]*runtime: runtimeVersionIdentity/.test(workerStatus));
check('liveness and readiness expose the API process runtime identity',
  (health.match(/runtime: runtimeVersionIdentity/g) ?? []).length >= 2);
check('worker status endpoint returns API and persisted worker facts separately',
  /api: getApiRuntimeStatus\(\),[\s\S]*worker,/.test(workerRoute));

if (failures > 0) {
  console.error(`\nFAIL PS-502 runtime version guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-502 runtime version guard');
