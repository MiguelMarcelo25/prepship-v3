/**
 * PS-285 label purchase boundary evidence guard.
 *
 * Offline/static only. Pins phase 4 of the PS-285 umbrella to existing
 * PS-248 label-purchase safety owners while keeping PS-285 below Final Review.
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

const docPath = 'docs/ps-tickets/ps-285-label-purchase-evidence.md';
const doc = read(docPath);
const normalizedDoc = doc.replace(/\s+/g, ' ');
const checklist = read('docs/ps-tickets/ps-285-phase-checklist.md');
const matrix = read('docs/ps-tickets/ps-285-phase-evidence-matrix.md');
const packageJson = read('package.json');
const lockHelper = read('src/lib/label-purchase-lock.ts');
const labels = read('src/services/labels.ts');
const lockGuard = read('scripts/ps-248-label-purchase-lock-guard.ts');
const atomicGuard = read('scripts/ps-248-persist-mark-shipped-atomic-guard.ts');

check('PS-285 label purchase evidence doc exists', existsSync(docPath));
check('label purchase packet keeps PS-285 conservative at 50%',
  /Current completion estimate: PS-285 50%/.test(doc));
check('label purchase packet explicitly refuses Final Review readiness',
  /does not make PS-285 Final Review-ready/i.test(normalizedDoc));

const ownerFiles = [
  'src/lib/label-purchase-lock.ts',
  'src/services/labels.ts',
  'scripts/ps-248-label-purchase-lock-guard.ts',
  'scripts/ps-248-persist-mark-shipped-atomic-guard.ts',
  'scripts/ps-285-label-purchase-evidence-guard.ts',
];
check('packet lists label-purchase backend owners',
  missing(doc, ownerFiles).length === 0,
  missing(doc, ownerFiles));

const requiredCommands = [
  'test:ps-248-label-purchase-lock',
  'test:ps-248-persist-mark-shipped-atomic',
  'test:ps-285-label-purchase-evidence',
  'test:ps-285-phase-evidence-matrix',
  'test:ps-285-umbrella-closeout',
  'npm run typecheck',
  'npm run build:web',
];
check('packet lists focused and global verification commands',
  missing(doc, requiredCommands).length === 0,
  missing(doc, requiredCommands));

check('package wires PS-285 label purchase evidence guard',
  /"test:ps-285-label-purchase-evidence"\s*:\s*"tsx scripts\/ps-285-label-purchase-evidence-guard\.ts"/.test(packageJson));
check('package keeps PS-248 label-purchase lock guard wired',
  /"test:ps-248-label-purchase-lock"\s*:\s*"tsx scripts\/ps-248-label-purchase-lock-guard\.ts"/.test(packageJson));
check('package keeps PS-248 atomic persist guard wired',
  /"test:ps-248-persist-mark-shipped-atomic"\s*:\s*"tsx scripts\/ps-248-persist-mark-shipped-atomic-guard\.ts"/.test(packageJson));

check('lock helper uses non-blocking advisory lock and explicit in-progress error',
  /pg_try_advisory_lock/.test(lockHelper) &&
    /LabelPurchaseInProgressError/.test(lockHelper) &&
    /LABEL_PURCHASE_IN_PROGRESS/.test(lockHelper));
check('createLabelV2 acquires and releases the purchase lock around impl',
  /acquireLabelPurchaseLock\(body\.orderId\)/.test(labels) &&
    /return await createLabelV2Impl\(body, scope\)/.test(labels) &&
    /finally \{\s*await purchaseLock\.release\(\)/.test(labels));
check('label persist and mark-shipped run in one transaction with tx plumbing',
  /const localShipmentId = await db\.transaction\(async \(tx\) =>/.test(labels) &&
    /persistCreatedLabel\(\{[\s\S]*tx,/.test(labels) &&
    /markOrderShipped\(order\.id, created\.trackingNumber, \{ cleanupQueue: false, tx \}\)/.test(labels));
check('PS-248 lock guard pins purchase lock mechanism',
  /pg_try_advisory_lock/.test(lockGuard) &&
    /LABEL_PURCHASE_IN_PROGRESS/.test(lockGuard) &&
    /createLabelV2 acquires the per-order purchase lock/.test(lockGuard));
check('PS-248 atomic guard pins transaction mechanism',
  /persistCreatedLabel accepts a tx handle/.test(atomicGuard) &&
    /label flow persists \+ marks-shipped inside ONE db\.transaction/.test(atomicGuard));

check('phase 4 is complete in checklist and matrix',
  /\|\s*4\s*\|\s*Label purchase boundary safety\s*\|\s*Complete\s*\|/i.test(checklist) &&
    /\|\s*4\s*\|\s*Label purchase boundary safety\s*\|\s*Complete\s*\|/i.test(matrix));
check('checklist and matrix keep PS-285 at 60% and not Final Review-ready',
  /Current completion estimate: PS-285 60%/.test(checklist) &&
    /Current completion estimate: PS-285 60%/.test(matrix) &&
    /not Final Review-ready/i.test(checklist) &&
    /not Final Review-ready/i.test(matrix));

const safetyPhrases = [
  'offline/static',
  'does not buy postage',
  'create live labels',
  'void labels',
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
  console.error(`\nFAIL PS-285 label purchase evidence guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-285 label purchase evidence guard');
