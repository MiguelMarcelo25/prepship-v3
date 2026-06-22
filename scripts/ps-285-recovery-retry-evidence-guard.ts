/**
 * PS-285 recovery/retry tooling safety evidence guard.
 *
 * Offline/static only. Pins phase 9 of the PS-285 umbrella to existing
 * dry-run ops, durable worker-status, durable rate-limiter, and no-duplicate-
 * postage label recovery guards.
 */
import { existsSync, readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function missing(text: string, values: string[]): string[] {
  return values.filter((value) => !text.includes(value));
}

const docPath = 'docs/ps-tickets/ps-285-recovery-retry-evidence.md';
const doc = read(docPath);
const normalizedDoc = doc.replace(/\s+/g, ' ');
const checklist = read('docs/ps-tickets/ps-285-phase-checklist.md');
const matrix = read('docs/ps-tickets/ps-285-phase-evidence-matrix.md');
const packageJson = read('package.json');
const opsConfirm = read('src/lib/ops-confirm.ts');
const migrateSupabase = read('scripts/migrate-supabase.ts');
const main = read('src/main.ts');
const workerEvents = read('src/services/worker-status-events.ts');
const workerStatus = read('src/services/worker-status.ts');
const watchdog = read('src/services/sync-staleness-watchdog.ts');
const durableRateLimiter = read('src/lib/shipstation/durable-rate-limiter.ts');
const shipstationClient = read('src/lib/shipstation/v1-client.ts');
const labelRecovery = read('src/services/print-queue-label-recovery.ts');
const secondaryAccount = read('src/services/print-queue-secondary-ss-account.ts');
const printQueue = read('src/services/print-queue.ts');
const ps255 = read('scripts/ps-255-ops-confirm-gate-guard.ts');
const ps256Worker = read('scripts/ps-256-durable-worker-status-guard.ts');
const ps256Rate = read('scripts/ps-256-durable-rate-limiter-guard.ts');
const ps288 = read('scripts/ps-288-label-recovery-guard.ts');

check('PS-285 recovery/retry evidence doc exists', existsSync(docPath));
check('recovery/retry packet keeps PS-285 conservative at 65%',
  /Current completion estimate: PS-285 65%/.test(doc));
check('recovery/retry packet explicitly refuses Final Review readiness',
  /does not make PS-285 Final Review-ready/i.test(normalizedDoc));

const ownerFiles = [
  'src/lib/ops-confirm.ts',
  'scripts/migrate-supabase.ts',
  'src/services/worker-status-events.ts',
  'src/services/worker-status.ts',
  'src/services/sync-staleness-watchdog.ts',
  'src/lib/shipstation/durable-rate-limiter.ts',
  'src/services/print-queue-label-recovery.ts',
  'src/services/print-queue-secondary-ss-account.ts',
  'src/services/print-queue.ts',
  'scripts/ps-255-ops-confirm-gate-guard.ts',
  'scripts/ps-256-durable-worker-status-guard.ts',
  'scripts/ps-256-durable-rate-limiter-guard.ts',
  'scripts/ps-288-label-recovery-guard.ts',
  'scripts/ps-285-recovery-retry-evidence-guard.ts',
];
check('packet lists recovery/retry backend owners',
  missing(doc, ownerFiles).length === 0,
  missing(doc, ownerFiles));

const requiredCommands = [
  'test:ps-255-ops-confirm-gate',
  'test:ps-256-durable-worker-status',
  'test:ps-256-durable-rate-limiter',
  'test:ps-288-label-recovery',
  'test:ps-285-recovery-retry-evidence',
  'test:ps-285-phase-evidence-matrix',
  'test:ps-285-umbrella-closeout',
  'npm run typecheck',
  'npm run build:web',
];
check('packet lists focused and global verification commands',
  missing(doc, requiredCommands).length === 0,
  missing(doc, requiredCommands));

check('package wires PS-285 recovery/retry evidence guard',
  /"test:ps-285-recovery-retry-evidence"\s*:\s*"tsx scripts\/ps-285-recovery-retry-evidence-guard\.ts"/.test(packageJson));
for (const command of requiredCommands.filter((value) => value.startsWith('test:'))) {
  check(`package keeps ${command} wired`, packageJson.includes(`"${command}"`));
}

check('PS-255 guard pins dry-run default, explicit apply, token gate, and admin mount',
  /no flag -> may NOT mutate/.test(ps255) &&
    /requireToken \+ wrong --token -> blocked/.test(ps255) &&
    /\/admin\/\* is behind requireAdmin/.test(ps255));
check('PS-256 worker-status guard pins default-off true no-op and status events',
  /WORKER_STATUS_EVENTS_DURABLE/.test(ps256Worker) &&
    /returns \[\] when OFF/.test(ps256Worker) &&
    /eventType: 'heartbeat'/.test(ps256Worker) &&
    /eventType: 'staleness_alert'/.test(ps256Worker));
check('PS-256 rate-limiter guard pins durable opt-in and in-memory default',
  /RATE_LIMITER_BACKEND=durable/.test(ps256Rate) &&
    /default is the in-memory TokenBucket/.test(ps256Rate) &&
    /atomic refill\+decrement UPDATE/.test(ps256Rate));
check('PS-288 guard pins label recovery without duplicate postage',
  /recovery buys NO postage/.test(ps288) &&
    /no createLabelV2 in the recovery function/.test(ps288) &&
    /backfills ONLY labelUrl \+ labelFormat/.test(ps288));

check('ops-confirm defaults to no mutation unless apply/confirm is supplied',
  /opsApplyRequested/.test(opsConfirm) &&
    /--apply/.test(opsConfirm) &&
    /--confirm/.test(opsConfirm) &&
    /OPS_CONFIRM_TOKEN/.test(opsConfirm));
check('migrate-supabase is dry-run by default through opsMayMutate',
  /import \{ opsMayMutate \} from '\.\.\/src\/lib\/ops-confirm'/.test(migrateSupabase) &&
    /const dryRun = process\.argv\.includes\('--dry-run'\) \|\| !opsMayMutate\(\);/.test(migrateSupabase));
check('admin routes remain mounted behind requireAdmin',
  /app\.use\('\/admin\/\*', requireAdmin\)/.test(main));

check('worker status events are env-gated, additive, and best-effort',
  /CREATE TABLE IF NOT EXISTS worker_status_events/.test(workerEvents) &&
    /WORKER_STATUS_EVENTS_DURABLE/.test(workerEvents) &&
    /if \(!workerStatusEventsEnabled\(\)\) return/.test(workerEvents) &&
    /try \{[\s\S]*INSERT INTO worker_status_events[\s\S]*\} catch/.test(workerEvents));
check('worker status emits heartbeat and job transition events',
  /eventType: 'heartbeat'/.test(workerStatus) &&
    /eventType: 'job_start'/.test(workerStatus) &&
    /eventType: 'job_complete'/.test(workerStatus) &&
    /eventType: 'job_failed'/.test(workerStatus));
check('staleness watchdog emits alert events through the durable observer',
  /eventType: 'staleness_alert'/.test(watchdog) &&
    /stalenessLevel: verdict\.level/.test(watchdog));

check('durable rate limiter is additive and selected only by explicit flag',
  /CREATE TABLE IF NOT EXISTS rate_limiter_state/.test(durableRateLimiter) &&
    /UPDATE rate_limiter_state[\s\S]*RETURNING tokens/.test(durableRateLimiter) &&
    /process\.env\.RATE_LIMITER_BACKEND === 'durable'/.test(shipstationClient) &&
    /: new TokenBucket\(38, 38 \/ 60_000\)/.test(shipstationClient));
check('label recovery is exact-match only and pure',
  /matchRecoverableLabel/.test(labelRecovery) &&
    /trackingNumber/.test(labelRecovery) &&
    /labelShipmentId/.test(labelRecovery) &&
    !/createLabelV2|db\.update|db\.insert|db\.delete/.test(labelRecovery));
check('secondary account recovery avoids duplicate account reads',
  /resolveSecondaryShipstationLabelKey/.test(secondaryAccount) &&
    /SHIPSTATION_API_KEY_V2/.test(secondaryAccount) &&
    /secondary === primary/.test(secondaryAccount));
const recoveryStart = printQueue.indexOf('async function findExistingQueueableLabelForOrder');
const recoveryEnd = printQueue.indexOf('function printQueueScopePredicate');
const recoveryBody = recoveryStart >= 0 && recoveryEnd > recoveryStart
  ? printQueue.slice(recoveryStart, recoveryEnd)
  : '';
check('print queue recovery reads existing labels and does not buy postage',
  recoveryBody.includes('ssListRecentLabels') &&
    recoveryBody.includes('matchRecoverableLabel') &&
    !recoveryBody.includes('createLabelV2'));

check('phase 9 is complete in checklist and matrix',
  /\|\s*9\s*\|\s*Recovery\/retry tooling safety\s*\|\s*Complete\s*\|/i.test(checklist) &&
    /\|\s*9\s*\|\s*Recovery\/retry tooling safety\s*\|\s*Complete\s*\|/i.test(matrix));
check('checklist and matrix keep PS-285 at 65% and not Final Review-ready',
  /Current completion estimate: PS-285 65%/.test(checklist) &&
    /Current completion estimate: PS-285 65%/.test(matrix) &&
    /not Final Review-ready/i.test(checklist) &&
    /not Final Review-ready/i.test(matrix));

const safetyPhrases = [
  'offline/static',
  'does not restart workers',
  'enable live retry flags',
  'create live labels',
  'buy postage',
  'send marketplace notifications',
  'mutate production orders',
  'mutate production queues',
  'shipped/cancelled data',
  'No Trello comment',
];
check('packet carries no-live/no-mutation/no-Trello safety boundaries',
  missing(normalizedDoc, safetyPhrases).length === 0,
  missing(normalizedDoc, safetyPhrases));

if (failures > 0) {
  console.error(`\nFAIL PS-285 recovery/retry evidence guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-285 recovery/retry evidence guard');
