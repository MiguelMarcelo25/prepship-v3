/**
 * PS-285 print queue durability and idempotency evidence guard.
 *
 * Offline/static only. Pins phase 5 of the PS-285 umbrella to existing print
 * queue recovery, idempotency, durable PDF, and backend authority guards.
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

const docPath = 'docs/ps-tickets/ps-285-print-queue-evidence.md';
const doc = read(docPath);
const normalizedDoc = doc.replace(/\s+/g, ' ');
const checklist = read('docs/ps-tickets/ps-285-phase-checklist.md');
const matrix = read('docs/ps-tickets/ps-285-phase-evidence-matrix.md');
const packageJson = read('package.json');
const printQueue = read('src/services/print-queue.ts');
const printQueueRoute = read('src/routes/print-queue.ts');
const pdfStore = read('src/services/print-queue-pdf-store.ts');
const ps053 = read('scripts/ps-053-print-queue-atomic-recovery-guard.mjs');
const ps253 = read('scripts/ps-253-outbox-stale-reclaim-guard.ts');
const ps256 = read('scripts/ps-256-durable-print-queue-pdf-guard.ts');
const ps303 = read('scripts/ps-303-print-queue-authority-guard.ts');
const selectedRateProof = read('scripts/print-to-queue-selected-rate-proof-guard.ts');
const testOrderQueue = read('scripts/test-order-queue-label-guard.mjs');

check('PS-285 print queue evidence doc exists', existsSync(docPath));
check('print queue packet keeps PS-285 conservative at 55%',
  /Current completion estimate: PS-285 55%/.test(doc));
check('print queue packet explicitly refuses Final Review readiness',
  /does not make PS-285 Final Review-ready/i.test(normalizedDoc));

const ownerFiles = [
  'src/services/print-queue.ts',
  'src/routes/print-queue.ts',
  'src/services/print-queue-pdf-store.ts',
  'scripts/ps-053-print-queue-atomic-recovery-guard.mjs',
  'scripts/ps-253-outbox-stale-reclaim-guard.ts',
  'scripts/ps-256-durable-print-queue-pdf-guard.ts',
  'scripts/ps-303-print-queue-authority-guard.ts',
  'scripts/print-to-queue-selected-rate-proof-guard.ts',
  'scripts/test-order-queue-label-guard.mjs',
  'scripts/ps-285-print-queue-evidence-guard.ts',
];
check('packet lists print queue backend owners',
  missing(doc, ownerFiles).length === 0,
  missing(doc, ownerFiles));

const requiredCommands = [
  'test:ps-053-print-queue-atomic',
  'test:ps-253-outbox-stale-reclaim',
  'test:ps-256-durable-print-queue-pdf',
  'test:ps-303-print-queue-authority',
  'test:print-to-queue-selected-rate-proof',
  'test:test-order-queue-label',
  'test:ps-285-print-queue-evidence',
  'test:ps-285-phase-evidence-matrix',
  'test:ps-285-umbrella-closeout',
  'npm run typecheck',
  'npm run build:web',
];
check('packet lists focused and global verification commands',
  missing(doc, requiredCommands).length === 0,
  missing(doc, requiredCommands));

check('package wires PS-285 print queue evidence guard',
  /"test:ps-285-print-queue-evidence"\s*:\s*"tsx scripts\/ps-285-print-queue-evidence-guard\.ts"/.test(packageJson));
for (const command of requiredCommands.filter((value) => value.startsWith('test:'))) {
  check(`package keeps ${command} wired`, packageJson.includes(`"${command}"`));
}

check('PS-053 guard pins create/recover-and-queue atomicity',
  /Queue mode uses backend create\/recover-and-queue path/.test(ps053) &&
    /Post-label exceptions recover by re-reading active shipment label/.test(ps053) &&
    /Queue insertion remains idempotent/.test(ps053));
check('PS-253 guard pins stale processing outbox reclaim',
  /OUTBOX_PROCESSING_LEASE_MINUTES/.test(ps253) &&
    /reclaims orphaned processing rows past the lease/.test(ps253));
check('PS-256 guard pins durable merged PDF store and default-off no-op',
  /DURABLE_PRINT_QUEUE_PDF/.test(ps256) &&
    /persistMergedPdf resolves without throwing when OFF/.test(ps256) &&
    /getMergedPdfBase64 returns null when OFF/.test(ps256));
check('PS-303 guard pins backend print queue route authority',
  /processQueueSendOrder/.test(ps303) &&
    /createLabelV2/.test(ps303) &&
    /findExistingQueueableLabelForOrder/.test(ps303) &&
    /startQueueSendJob/.test(ps303));
check('selected-rate proof guard keeps queue retry proof backend-aware',
  /retryEligibleOrderIds/.test(selectedRateProof) &&
    /refreshStaleRateForOrder/.test(selectedRateProof) &&
    /Print to Queue/.test(selectedRateProof));
check('test-order queue guard pins existing-label recovery and safe queue scope',
  /Single-order queue recovers from already-shipped\/already-labeled conflicts/.test(testOrderQueue) &&
    /Queue defaults to all authorized clients/.test(testOrderQueue));

check('print queue service recovers created labels before throwing queue failures',
  /findExistingQueueableLabelForOrder\(order\.orderId\)/.test(printQueue) &&
    /const recoverCreatedLabelUrl = existingLabelUrl \?\? await findExistingQueueableLabelForOrder\(order\.orderId\)/.test(printQueue) &&
    /if \(!recoverCreatedLabelUrl\) throw err/.test(printQueue));
check('print queue service upserts queue rows by order and client',
  /\.onConflictDoUpdate/.test(printQueue) &&
    /target: \[printQueue\.orderId, printQueue\.clientId\]/.test(printQueue) &&
    /alreadyQueued/.test(printQueue));
check('print queue service normalizes label URLs before queue persistence',
  /normalizePrintQueueLabelUrl\(input\.labelUrl\)/.test(printQueue) &&
    /PrintQueueLabelUrlError/.test(printQueue));
check('print queue route delegates batch-send to backend job owner',
  /app\.post\('\/batch-send'/.test(printQueueRoute) &&
    /startQueueSendJob/.test(printQueueRoute));
check('durable PDF side-store is additive and flag-gated',
  /CREATE TABLE IF NOT EXISTS print_queue_merged_pdfs/.test(pdfStore) &&
    /DURABLE_PRINT_QUEUE_PDF/.test(pdfStore) &&
    /if \(!durablePrintQueuePdfEnabled\(\)\) return/.test(pdfStore));

check('phase 5 is complete in checklist and matrix',
  /\|\s*5\s*\|\s*Print queue durability and idempotency\s*\|\s*Complete\s*\|/i.test(checklist) &&
    /\|\s*5\s*\|\s*Print queue durability and idempotency\s*\|\s*Complete\s*\|/i.test(matrix));
check('checklist and matrix keep PS-285 at 75% and not Final Review-ready',
  /Current completion estimate: PS-285 75%/.test(checklist) &&
    /Current completion estimate: PS-285 75%/.test(matrix) &&
    /not Final Review-ready/i.test(checklist) &&
    /not Final Review-ready/i.test(matrix));

const safetyPhrases = [
  'offline/static',
  'does not create live labels',
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
  console.error(`\nFAIL PS-285 print queue evidence guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-285 print queue evidence guard');
