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
const runtimeSchemaMigration = read('drizzle/0062_runtime_schema_ownership.sql');

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

check('lock helper uses non-blocking durable lease and explicit in-progress error',
  /CREATE TABLE IF NOT EXISTS label_purchase_locks/.test(runtimeSchemaMigration) &&
    /assertRuntimeSchemaReady/.test(lockHelper) &&
    /ON CONFLICT \(order_id\) DO UPDATE SET/.test(lockHelper) &&
    /WHERE label_purchase_locks\.expires_at <= now\(\)/.test(lockHelper) &&
    /DELETE FROM label_purchase_locks/.test(lockHelper) &&
    /LabelPurchaseInProgressError/.test(lockHelper) &&
    /LABEL_PURCHASE_IN_PROGRESS/.test(lockHelper));
// Repointed 2026-08-05. Required `return await createLabelV2Impl(body, scope)` with
// exactly two arguments. It takes a third now -- `{ purchaseLock }` -- because the
// 2026-07-25 change hands the opaque lease DOWN to nested canonical automation work so
// nested work cannot try to re-acquire a non-reentrant lock. The outer owner still
// releases it in the same finally. Strictly more careful than what this pinned, and
// the handoff is now the more interesting property, so assert it rather than forbid it.
check('createLabelV2 acquires and releases the purchase lock around impl',
  /acquireLabelPurchaseLock\(body\.orderId\)/.test(labels) &&
    /return await createLabelV2Impl\(body, scope(?:, \{[^}]*purchaseLock[^}]*\})?\)/.test(labels) &&
    /finally \{\s*await purchaseLock\.release\(\)/.test(labels));
check('the purchase lease is handed down to nested work instead of being re-acquired',
  /createLabelV2Impl\(body, scope, \{[^}]*purchaseLock[^}]*\}\)/.test(labels));

// The persist+lifecycle transaction is no longer opened inline as
// `const localShipmentId = await db.transaction(async (tx) => ...)`. PS-423 moved it
// under consumeFulfillmentOperation(operationId, async (tx, receipt) => ...), so the
// durable provider RECEIPT is consumed in the same transaction as both projections: a
// local fault rolls back shipment and lifecycle together, and the retry reuses the
// receipt instead of buying a second label. That is a stronger invariant than "one
// transaction", so anchor on it -- and require BOTH writes inside that callback rather
// than merely present somewhere in a 3,500-line file, which is all the old regex asked.
const durableTxStart = labels.indexOf('await consumeFulfillmentOperation(operationId, async (tx, receipt) =>');
const durableTxSpan = durableTxStart >= 0 ? labels.slice(durableTxStart, durableTxStart + 4_000) : '';
check('label persist and lifecycle command run in one transaction with tx plumbing',
  durableTxStart >= 0 &&
    /persistCreatedLabel\(\{[\s\S]*?\btx,/.test(durableTxSpan) &&
    /applyOrderLifecycleCommandInTransaction\(tx, \{[\s\S]*?shipmentId,[\s\S]*?transition: 'shipped'/.test(durableTxSpan));
check('PS-248 lock guard pins purchase lock mechanism',
  /migration owns durable label_purchase_locks/.test(lockGuard) &&
    /LABEL_PURCHASE_IN_PROGRESS/.test(lockGuard) &&
    /createLabelV2 acquires the per-order purchase lock/.test(lockGuard));
check('PS-248 atomic guard pins transaction mechanism',
  // PS-508 hardening: the handle became REQUIRED (was "accepts a tx handle").
  /persistCreatedLabel REQUIRES a tx handle/.test(atomicGuard) &&
    /label flow persists \+ applies lifecycle inside ONE db\.transaction/.test(atomicGuard));

check('phase 4 is complete in checklist and matrix',
  /\|\s*4\s*\|\s*Label purchase boundary safety\s*\|\s*Complete\s*\|/i.test(checklist) &&
    /\|\s*4\s*\|\s*Label purchase boundary safety\s*\|\s*Complete\s*\|/i.test(matrix));
check('checklist and matrix keep PS-285 at 75% and not Final Review-ready',
  /Current completion estimate: PS-285 75%/.test(checklist) &&
    /Current completion estimate: PS-285 75%/.test(matrix) &&
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
