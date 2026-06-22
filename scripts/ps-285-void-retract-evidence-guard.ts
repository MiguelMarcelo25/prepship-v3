/**
 * PS-285 void/retract and cancellation safety evidence guard.
 *
 * Offline/static only. Pins phase 7 of the PS-285 umbrella to existing
 * provider-aware void, confirmation retract, idempotent confirmation, and
 * upstream cancellation safety guards.
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

const docPath = 'docs/ps-tickets/ps-285-void-retract-evidence.md';
const doc = read(docPath);
const normalizedDoc = doc.replace(/\s+/g, ' ');
const checklist = read('docs/ps-tickets/ps-285-phase-checklist.md');
const matrix = read('docs/ps-tickets/ps-285-phase-evidence-matrix.md');
const packageJson = read('package.json');
const labels = read('src/services/labels.ts');
const voidPolicy = read('src/services/label-void-policy.ts');
const voidability = read('src/services/label-voidability.ts');
const outbox = read('src/services/fulfillment/outbox.ts');
const shippingSafety = read('src/services/fulfillment/shipping-safety.ts');
const ps211 = read('scripts/ps-211-universal-void-guard.ts');
const ps219 = read('scripts/ps-219-void-label-ui-guard.ts');
const ps253 = read('scripts/ps-253-combo-confirm-atomicity-guard.ts');
const ps263 = read('scripts/ps-263-void-confirmation-retract-guard.ts');
const ps129 = read('scripts/ps-128-129-upstream-shipping-safety-guard.ts');

check('PS-285 void/retract evidence doc exists', existsSync(docPath));
check('void/retract packet keeps PS-285 conservative at 60%',
  /Current completion estimate: PS-285 60%/.test(doc));
check('void/retract packet explicitly refuses Final Review readiness',
  /does not make PS-285 Final Review-ready/i.test(normalizedDoc));

const ownerFiles = [
  'src/services/labels.ts',
  'src/services/label-void-policy.ts',
  'src/services/label-voidability.ts',
  'src/services/fulfillment/outbox.ts',
  'src/services/fulfillment/shipping-safety.ts',
  'scripts/ps-211-universal-void-guard.ts',
  'scripts/ps-219-void-label-ui-guard.ts',
  'scripts/ps-253-combo-confirm-atomicity-guard.ts',
  'scripts/ps-263-void-confirmation-retract-guard.ts',
  'scripts/ps-128-129-upstream-shipping-safety-guard.ts',
  'scripts/ps-285-void-retract-evidence-guard.ts',
];
check('packet lists void/retract backend owners',
  missing(doc, ownerFiles).length === 0,
  missing(doc, ownerFiles));

const requiredCommands = [
  'test:ps-211-universal-void',
  'test:ps-219-void-label-ui',
  'test:ps-253-combo-confirm-atomicity',
  'test:ps-263-void-confirmation-retract',
  'test:ps-129-upstream-cancellation-hold',
  'test:ps-285-void-retract-evidence',
  'test:ps-285-phase-evidence-matrix',
  'test:ps-285-umbrella-closeout',
  'npm run typecheck',
  'npm run build:web',
];
check('packet lists focused and global verification commands',
  missing(doc, requiredCommands).length === 0,
  missing(doc, requiredCommands));

check('package wires PS-285 void/retract evidence guard',
  /"test:ps-285-void-retract-evidence"\s*:\s*"tsx scripts\/ps-285-void-retract-evidence-guard\.ts"/.test(packageJson));
for (const command of requiredCommands.filter((value) => value.startsWith('test:'))) {
  check(`package keeps ${command} wired`, packageJson.includes(`"${command}"`));
}

check('PS-211 guard pins provider-aware void dispatch and single local void write',
  /resolveLabelVoidDispatch/.test(ps211) &&
    /voidCarrierLabel/.test(ps211) &&
    /exactly ONE local voided:true write/.test(ps211));
check('PS-219 guard pins backend-owned voidability and thin UI',
  /resolveOrderLabelVoidability/.test(ps219) &&
    /FE voids with the backend-stamped shipmentId/.test(ps219) &&
    /OrdersView never optimistically marks a label voided/.test(ps219));
check('PS-253 guard pins idempotent marketplace confirmation',
  /processOutboxRow re-checks the shipment confirmation state before dispatch/.test(ps253) &&
    /already-confirmed shipment settles the row WITHOUT re-confirming/.test(ps253));
check('PS-263 guard pins void confirmation retract owner',
  /cancelShipmentConfirmationsForVoid is exported/.test(ps263) &&
    /voidLabelV2 calls the retract owner/.test(ps263) &&
    /retract runs AFTER the local void write/.test(ps263));
check('PS-128/129 guard pins upstream shipped/cancelled safety',
  /local cancelled -> block/.test(ps129) &&
    /externally shipped -> block/.test(ps129) &&
    /createLabelV2 calls assertOrderSafeToShip/.test(ps129));

check('labels service dispatches voids through policy and connector orchestrator',
  /resolveLabelVoidDispatch\(/.test(labels) &&
    /voidCarrierLabel\(dispatch\.provider/.test(labels) &&
    /carrierConnectorSupportsVoid\(dispatch\.provider\)/.test(labels));
check('labels service calls void retract owner after local void write',
  /await cancelShipmentConfirmationsForVoid\(\{/.test(labels) &&
    labels.indexOf('.set({ voided: true, updatedAt: now })') < labels.indexOf('await cancelShipmentConfirmationsForVoid({'));
check('void policy handles already-voided, test, provider, unsupported, and not-voidable cases',
  /already_voided/.test(voidPolicy) &&
    /local_test/.test(voidPolicy) &&
    /provider_label_id/.test(voidPolicy) &&
    /not_voidable/.test(voidPolicy));
check('voidability resolver is read-only and reuses PS-211 policy',
  /resolveOrderLabelVoidability/.test(voidability) &&
    /resolveLabelVoidDispatch/.test(voidability) &&
    !/db\.update|db\.insert|db\.delete|\.set\(/.test(voidability));
check('outbox retract owner cancels only not-yet-succeeded confirmation sends',
  /cancelShipmentConfirmationsForVoid/.test(outbox) &&
    /event_type = 'shipment_confirmation_requested'/.test(outbox) &&
    /status <> 'succeeded'/.test(outbox) &&
    /next_run_at = 'infinity'/.test(outbox));
check('shipping safety blocks cancelled and shipped source signals',
  /local_cancelled/.test(shippingSafety) &&
    /upstream_cancelled/.test(shippingSafety) &&
    /externally_shipped/.test(shippingSafety) &&
    /upstream_shipped/.test(shippingSafety));

check('phase 7 is complete in checklist and matrix',
  /\|\s*7\s*\|\s*Void\/retract and cancellation safety\s*\|\s*Complete\s*\|/i.test(checklist) &&
    /\|\s*7\s*\|\s*Void\/retract and cancellation safety\s*\|\s*Complete\s*\|/i.test(matrix));
check('checklist and matrix keep PS-285 at 70% and not Final Review-ready',
  /Current completion estimate: PS-285 70%/.test(checklist) &&
    /Current completion estimate: PS-285 70%/.test(matrix) &&
    /not Final Review-ready/i.test(checklist) &&
    /not Final Review-ready/i.test(matrix));

const safetyPhrases = [
  'offline/static',
  'does not void live labels',
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
  console.error(`\nFAIL PS-285 void/retract evidence guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-285 void/retract evidence guard');
