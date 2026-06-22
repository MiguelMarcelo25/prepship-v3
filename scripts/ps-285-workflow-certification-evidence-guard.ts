/**
 * PS-285 workflow certification evidence guard.
 *
 * Offline/static only. Pins phase 11 of the PS-285 umbrella to the existing
 * workflow certification matrix and offline runner.
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

const docPath = 'docs/ps-tickets/ps-285-workflow-certification-evidence.md';
const doc = read(docPath);
const normalizedDoc = doc.replace(/\s+/g, ' ');
const checklist = read('docs/ps-tickets/ps-285-phase-checklist.md');
const matrix = read('docs/ps-tickets/ps-285-phase-evidence-matrix.md');
const workflowMatrix = read('docs/full-workflow-certification-matrix.md');
const runner = read('scripts/run-workflow-certification.mjs');
const roundtrip = read('scripts/shipping-roundtrip-certification.mjs');
const harness = read('docs/shipping-certification-harness.md');
const packageJson = read('package.json');

check('PS-285 workflow certification evidence doc exists', existsSync(docPath));
check('workflow certification packet keeps PS-285 conservative at 70%',
  /Current completion estimate: PS-285 70%/.test(doc));
check('workflow certification packet explicitly refuses Final Review readiness',
  /does not make PS-285 Final Review-ready/i.test(normalizedDoc));

const ownerFiles = [
  'docs/full-workflow-certification-matrix.md',
  'scripts/run-workflow-certification.mjs',
  'scripts/shipping-roundtrip-certification.mjs',
  'docs/shipping-certification-harness.md',
  'scripts/ps-285-workflow-certification-evidence-guard.ts',
];
check('packet lists workflow certification owners',
  missing(doc, ownerFiles).length === 0,
  missing(doc, ownerFiles));

const requiredCommands = [
  'test:workflow-suites',
  'test:ps-285-workflow-certification-evidence',
  'test:ps-285-phase-evidence-matrix',
  'test:ps-285-umbrella-closeout',
  'npm run typecheck',
  'npm run build:web',
];
check('packet lists focused and global verification commands',
  missing(doc, requiredCommands).length === 0,
  missing(doc, requiredCommands));

check('package wires PS-285 workflow certification evidence guard',
  /"test:ps-285-workflow-certification-evidence"\s*:\s*"tsx scripts\/ps-285-workflow-certification-evidence-guard\.ts"/.test(packageJson));
for (const command of requiredCommands.filter((value) => value.startsWith('test:'))) {
  check(`package keeps ${command} wired`, packageJson.includes(`"${command}"`));
}

check('workflow matrix defines test:workflow-suites as offline behavioral core',
  /test:workflow-suites/.test(workflowMatrix) &&
    /no server, no live providers, no real DB/i.test(workflowMatrix) &&
    /Runnable in plain CI/i.test(workflowMatrix));
check('workflow matrix records the current 81/81 offline suite result',
  /81\/81 offline suites pass/.test(workflowMatrix));
check('workflow matrix explicitly excludes browser-required and live commands',
  /Browser\/server-required/.test(workflowMatrix) &&
    /Live \/ DJ-supervised only/.test(workflowMatrix) &&
    /smoke:shipping:real-label/.test(workflowMatrix) &&
    /marketplace:reconcile:apply/.test(workflowMatrix));

const runnerScripts = Array.from(new Set([...runner.matchAll(/'test:[^']+'/g)].map((match) => match[0].slice(1, -1))));
const bannedRunnerCommands = [
  'test:full-site-certification',
  'test:full-workflow-certification',
  'smoke:shipping:preflight',
  'smoke:shipping:test-label',
  'smoke:shipping:real-label',
  'smoke:marketplace-confirm',
  'marketplace:confirm:retry',
  'marketplace:reconcile:apply',
  'shipstation:awaiting:reconcile:apply',
  'best-rate:dims:apply',
  'billing:repair-shipment-linkage',
  'watchdog:production',
];
check('offline runner has the current 81 unique workflow suites',
  runnerScripts.length === 81,
  runnerScripts.length);
check('offline runner continues on failure and exits non-zero for failed suites',
  /Continues on failure/.test(runner) &&
    /process\.exit\(1\)/.test(runner));
check('offline runner keeps browser/live/DJ-supervised commands out',
  bannedRunnerCommands.every((command) => !runnerScripts.includes(command)),
  bannedRunnerCommands.filter((command) => runnerScripts.includes(command)));
check('offline runner includes backend authority and ops hardening groups',
  /PS-172/.test(runner) &&
    /PS-254\/255/.test(runner) &&
    /test:ps-178-fe-authority-ratchet/.test(runner) &&
    /test:ps-255-ops-confirm-gate/.test(runner));

check('shipping roundtrip runner composes safe fixture/mock plus offline workflow suites',
  /guard:shipping-certification/.test(roundtrip) &&
    /smoke:shipping:test-label/.test(roundtrip) &&
    /--fixture/.test(roundtrip) &&
    /smoke:marketplace-confirm/.test(roundtrip) &&
    /--mock-process-once/.test(roundtrip) &&
    /test:workflow-suites/.test(roundtrip));
check('shipping roundtrip runner supports notify dry-run',
  /notify-dry-run/.test(roundtrip));
check('shipping certification harness documents the safe roundtrip and real-label approval boundary',
  /test:shipping-roundtrip-certification/.test(harness) &&
    /--notify-dry-run/.test(harness) &&
    /smoke:shipping:real-label/.test(harness) &&
    /live-approved/.test(harness));

check('phase 11 is complete in checklist and matrix',
  /\|\s*11\s*\|\s*End-to-end certification matrix\s*\|\s*Complete\s*\|/i.test(checklist) &&
    /\|\s*11\s*\|\s*End-to-end certification matrix\s*\|\s*Complete\s*\|/i.test(matrix));
check('checklist and matrix keep PS-285 at 70% and not Final Review-ready',
  /Current completion estimate: PS-285 70%/.test(checklist) &&
    /Current completion estimate: PS-285 70%/.test(matrix) &&
    /not Final Review-ready/i.test(checklist) &&
    /not Final Review-ready/i.test(matrix));

const excludedCommands = [
  'npm run test:full-site-certification',
  'npm run test:full-workflow-certification',
  'npm run smoke:shipping:real-label',
  'npm run marketplace:confirm:retry -- --live-approved',
];
check('packet lists unsafe/browser exclusions',
  missing(doc, excludedCommands).length === 0,
  missing(doc, excludedCommands));

const safetyPhrases = [
  'offline/static',
  'does not start a server',
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
  console.error(`\nFAIL PS-285 workflow certification evidence guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-285 workflow certification evidence guard');
