/**
 * PS-285 runbook evidence guard.
 *
 * Offline/static only. Pins the phase-10 runbook packet and keeps PS-285 honest:
 * phase 10 can be complete without promoting the whole umbrella to Final Review.
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

const runbookPath = 'docs/ps-tickets/ps-285-runbook-evidence.md';
const checklistPath = 'docs/ps-tickets/ps-285-phase-checklist.md';
const matrixPath = 'docs/ps-tickets/ps-285-phase-evidence-matrix.md';
const runbook = read(runbookPath);
const normalizedRunbook = runbook.replace(/\s+/g, ' ');
const checklist = read(checklistPath);
const matrix = read(matrixPath);
const packageJson = read('package.json');

check('PS-285 runbook evidence doc exists', existsSync(runbookPath));
check('runbook keeps PS-285 at conservative 40%', /Current completion estimate: PS-285 40%/.test(runbook));
check('runbook explicitly refuses Final Review readiness',
  /does not make PS-285 Final Review-ready/i.test(normalizedRunbook) &&
    /not a substitute for the remaining/i.test(normalizedRunbook));

const requiredSourceDocs = [
  'docs/security-readiness-checklist.md',
  'docs/shipping-certification-harness.md',
  'docs/full-workflow-certification-matrix.md',
  'scripts/run-workflow-certification.mjs',
  'docs/ps-tickets/ps-285-phase-checklist.md',
  'docs/ps-tickets/ps-285-phase-evidence-matrix.md',
];
check('runbook references the PS-285 observability source documents',
  missing(runbook, requiredSourceDocs).length === 0,
  missing(runbook, requiredSourceDocs));

const requiredCommands = [
  'test:ps-285-runbook-evidence',
  'test:ps-285-phase-evidence-matrix',
  'test:ps-285-umbrella-closeout',
  'test:ps-245-lockdown-fence',
  'test:ps-245-verification-harness',
  'test:ps-248-label-purchase-lock',
  'test:ps-248-persist-mark-shipped-atomic',
  'test:ps-253-combo-confirm-atomicity',
  'test:ps-285-marketplace-confirm-boundary',
  'test:ts-nocheck-ratchet',
  'test:authz-guard-behavioral-ratchet',
  'typecheck',
  'build:web',
];
check('runbook lists the safe PS-285 command workflow',
  missing(runbook, requiredCommands).length === 0,
  missing(runbook, requiredCommands));
check('package wires PS-285 runbook evidence guard',
  /"test:ps-285-runbook-evidence"\s*:\s*"tsx scripts\/ps-285-runbook-evidence-guard\.ts"/.test(packageJson));

const packageMissing = requiredCommands
  .filter((command) => !['typecheck', 'build:web'].includes(command))
  .filter((command) => !packageJson.includes(`"test:${command.replace(/^test:/, '')}"`) && !packageJson.includes(`"${command}"`));
check('package contains every runbook npm script except global gates', packageMissing.length === 0, packageMissing);

const phase10Pattern = /\|\s*10\s*\|\s*Observability and runbook coverage\s*\|\s*Complete\s*\|/i;
check('phase 10 is marked complete in checklist', phase10Pattern.test(checklist));
check('phase 10 is marked complete in matrix', phase10Pattern.test(matrix));
check('checklist references runbook evidence guard',
  checklist.includes('`test:ps-285-runbook-evidence`') &&
    checklist.includes('`docs/ps-tickets/ps-285-runbook-evidence.md`'));
check('matrix references runbook evidence guard',
  matrix.includes('`test:ps-285-runbook-evidence`') &&
    matrix.includes('`docs/ps-tickets/ps-285-runbook-evidence.md`'));

const completeRows = checklist
  .split(/\r?\n/)
  .filter((line) => /^\|\s*\d+\s*\|/.test(line) && /\|\s*Complete\s*\|/i.test(line));
check('only phases 8 and 10 are complete after this runbook slice',
  completeRows.length === 2 &&
    completeRows.some((line) => /^\|\s*8\s*\|/.test(line)) &&
    completeRows.some((line) => /^\|\s*10\s*\|/.test(line)),
  completeRows);

const safetyPhrases = [
  'offline and read-only',
  'does not buy postage',
  'create labels',
  'print labels',
  'send marketplace notifications',
  'mutate production orders',
  'mutate production queues',
  'shipped/cancelled data',
  'No Trello comment',
];
check('runbook carries no-live/no-mutation/no-Trello safety boundaries',
  missing(normalizedRunbook, safetyPhrases).length === 0,
  missing(normalizedRunbook, safetyPhrases));

if (failures > 0) {
  console.error(`\nFAIL PS-285 runbook evidence guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-285 runbook evidence guard');
