/**
 * Guard: print-worker status must not hide sync-worker liveness.
 *
 * Source of truth: src/services/worker-status.ts owns the durable worker status
 * snapshot consumed by /sync/status. The dedicated print worker needs its own
 * snapshot, but the legacy worker.status.snapshot key remains the scheduler view.
 *
 *   npx tsx scripts/worker-status-role-snapshot-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

const workerStatus = readFileSync('src/services/worker-status.ts', 'utf8');
const packageJson = readFileSync('package.json', 'utf8');

check(
  'declares role-specific worker status modes including sync and print workers',
  /const WORKER_STATUS_MODES = \[[\s\S]*'api-scheduler'[\s\S]*'worker-scheduler'[\s\S]*'print-worker'/.test(
    workerStatus,
  ),
);
check(
  'uses a role-specific settings key per worker mode',
  /function workerStatusSnapshotKey\(mode: WorkerMode\): string \{[\s\S]*`\$\{WORKER_STATUS_KEY\}:\$\{mode\}`/.test(
    workerStatus,
  ),
);
check(
  'persists every mode to its role-specific key',
  /await setSetting\(workerStatusSnapshotKey\(snapshot\.mode\), serialized\)/.test(
    workerStatus,
  ),
);
check(
  'keeps the legacy snapshot reserved for scheduler-enabled workers',
  /if \(snapshot\.schedulerEnabled\) \{[\s\S]*await setSetting\(WORKER_STATUS_KEY, serialized\)/.test(
    workerStatus,
  ),
);
check(
  'documents why print worker cannot overwrite the scheduler view',
  /print[\s\S]*worker must not overwrite it or \/sync\/status will report scheduler=false/.test(
    workerStatus,
  ),
);
check(
  'reads all role snapshots when building persisted worker status',
  /WORKER_STATUS_MODES\.map\([\s\S]*async \(mode\)[\s\S]*getSetting\(workerStatusSnapshotKey\(mode\)\)/.test(
    workerStatus,
  ),
);
check(
  'selects scheduler-enabled snapshots before falling back to legacy status',
  /filter\(\(entry\) => entry\.status\.schedulerEnabled\)[\s\S]*const legacy = parse\(await getSetting\(WORKER_STATUS_KEY\)\)/.test(
    workerStatus,
  ),
);
check(
  'returns role snapshots for diagnostics',
  /snapshots: Record<[\s\S]*return \{[\s\S]*\.\.\.selected,[\s\S]*activeLane:[\s\S]*snapshots,/.test(
    workerStatus,
  ),
);
check(
  'package.json wires the role snapshot guard',
  /"test:worker-status-role-snapshot": "tsx scripts\/worker-status-role-snapshot-guard\.ts"/.test(
    packageJson,
  ),
);

if (failures > 0) {
  console.error(`\nFAIL worker status role snapshot guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS worker status role snapshot guard');
