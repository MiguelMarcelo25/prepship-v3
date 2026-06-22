/**
 * PS-285 phase evidence matrix guard.
 *
 * Offline/static only. This pins the umbrella map for PS-245 through PS-259 so
 * the card cannot be closed from one child slice and cannot lose track of
 * non-prefixed ratchet evidence for PS-257/PS-259.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolveCardGuards } from '../src/verification/verify-card';

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

function includesAll(text: string, values: string[]): string[] {
  return values.filter((value) => !text.includes(value));
}

const matrixPath = 'docs/ps-tickets/ps-285-phase-evidence-matrix.md';
const checklistPath = 'docs/ps-tickets/ps-285-phase-checklist.md';
const matrix = read(matrixPath);
const checklist = read(checklistPath);
const packageJson = read('package.json');
const disposition = read('docs/ps-tickets/ps-245-259-disposition-2026-06-16.md');
const boardAudit = read('docs/ps-board-audit-verification-2026-06-18.md');

check('phase evidence matrix exists', existsSync(matrixPath));
check('phase checklist exists', existsSync(checklistPath));
check('package wires void/retract evidence guard',
  /"test:ps-285-void-retract-evidence"\s*:\s*"tsx scripts\/ps-285-void-retract-evidence-guard\.ts"/.test(packageJson));
check('package wires print queue evidence guard',
  /"test:ps-285-print-queue-evidence"\s*:\s*"tsx scripts\/ps-285-print-queue-evidence-guard\.ts"/.test(packageJson));
check('package wires label purchase evidence guard',
  /"test:ps-285-label-purchase-evidence"\s*:\s*"tsx scripts\/ps-285-label-purchase-evidence-guard\.ts"/.test(packageJson));
check('package wires protected-file diff proof guard',
  /"test:ps-285-protected-file-diff-proof"\s*:\s*"tsx scripts\/ps-285-protected-file-diff-proof-guard\.ts"/.test(packageJson));
check('package wires phase evidence matrix guard',
  /"test:ps-285-phase-evidence-matrix"\s*:\s*"tsx scripts\/ps-285-phase-evidence-matrix-guard\.ts"/.test(packageJson));
check('package still wires umbrella closeout guard',
  /"test:ps-285-umbrella-closeout"\s*:\s*"tsx scripts\/ps-285-umbrella-closeout-guard\.ts"/.test(packageJson));

const directResolverCards = [
  '245',
  '246',
  '247',
  '248',
  '249',
  '250',
  '251',
  '252',
  '253',
  '254',
  '255',
  '256',
  '258',
];

for (const card of directResolverCards) {
  const guards = resolveCardGuards(`PS-${card}`, packageJson);
  check(`PS-${card} has direct resolver guard coverage`, guards.length > 0, guards);
  check(`matrix lists PS-${card}`, matrix.includes(`| PS-${card} |`));
  for (const guard of guards.slice(0, 3)) {
    check(`matrix lists resolver guard ${guard}`, matrix.includes(`\`${guard}\``));
  }
}

check('PS-257 has explicit non-prefixed ts-nocheck ratchet mapping',
  packageJson.includes('"test:ts-nocheck-ratchet"') &&
    matrix.includes('| PS-257 | `test:ts-nocheck-ratchet` |') &&
    disposition.includes('PS-257-F'));
check('PS-259 has explicit non-prefixed authz ratchet mapping',
  packageJson.includes('"test:authz-guard-behavioral-ratchet"') &&
    matrix.includes('| PS-259 | `test:authz-guard-behavioral-ratchet` |') &&
    disposition.includes('PS-259-F'));

const phaseRows = matrix
  .split(/\r?\n/)
  .filter((line) => /^\|\s*\d+\s*\|/.test(line));
const completeRows = phaseRows.filter((line) => /\|\s*Complete\s*\|/i.test(line));
const inProgressRows = phaseRows.filter((line) => /\|\s*In progress\s*\|/i.test(line));
const notStartedRows = phaseRows.filter((line) => /\|\s*Not started\s*\|/i.test(line));

check('matrix has exactly 12 phase rows', phaseRows.length === 12);
check('phase 1 protected-file proof is complete in the umbrella matrix',
  completeRows.some((line) => /^\|\s*1\s*\|/.test(line)) &&
    matrix.includes('`test:ps-285-protected-file-diff-proof`') &&
    matrix.includes('`docs/ps-tickets/ps-285-protected-file-diff-proof.md`'));
check('phase 4 label-purchase boundary evidence is complete in the umbrella matrix',
  completeRows.some((line) => /^\|\s*4\s*\|/.test(line)) &&
    matrix.includes('`test:ps-248-label-purchase-lock`') &&
    matrix.includes('`test:ps-248-persist-mark-shipped-atomic`') &&
    matrix.includes('`docs/ps-tickets/ps-285-label-purchase-evidence.md`') &&
    matrix.includes('`test:ps-285-label-purchase-evidence`'));
check('phase 5 print queue evidence is complete in the umbrella matrix',
  completeRows.some((line) => /^\|\s*5\s*\|/.test(line)) &&
    matrix.includes('`test:ps-253-outbox-stale-reclaim`') &&
    matrix.includes('`test:ps-256-durable-print-queue-pdf`') &&
    matrix.includes('`test:ps-053-print-queue-atomic`') &&
    matrix.includes('`test:ps-303-print-queue-authority`') &&
    matrix.includes('`docs/ps-tickets/ps-285-print-queue-evidence.md`') &&
    matrix.includes('`test:ps-285-print-queue-evidence`'));
check('phase 7 void/retract evidence is complete in the umbrella matrix',
  completeRows.some((line) => /^\|\s*7\s*\|/.test(line)) &&
    matrix.includes('`test:ps-253-combo-confirm-atomicity`') &&
    matrix.includes('`test:ps-263-void-confirmation-retract`') &&
    matrix.includes('`test:ps-211-universal-void`') &&
    matrix.includes('`test:ps-129-upstream-cancellation-hold`') &&
    matrix.includes('`docs/ps-tickets/ps-285-void-retract-evidence.md`') &&
    matrix.includes('`test:ps-285-void-retract-evidence`'));
check('phase 10 runbook evidence is complete in the umbrella matrix',
  completeRows.some((line) => /^\|\s*10\s*\|/.test(line)) &&
    matrix.includes('`test:ps-285-runbook-evidence`') &&
    matrix.includes('`docs/ps-tickets/ps-285-runbook-evidence.md`'));
check('only phases 1, 4, 5, 7, 8, and 10 are complete in the umbrella matrix',
  completeRows.length === 6 &&
    completeRows.some((line) => /^\|\s*1\s*\|/.test(line)) &&
    completeRows.some((line) => /^\|\s*4\s*\|/.test(line)) &&
    completeRows.some((line) => /^\|\s*5\s*\|/.test(line)) &&
    completeRows.some((line) => /^\|\s*7\s*\|/.test(line)) &&
    completeRows.some((line) => /^\|\s*8\s*\|/.test(line)) &&
    completeRows.some((line) => /^\|\s*10\s*\|/.test(line)));
check('remaining phases stay tracked as in progress, not complete',
  completeRows.length + inProgressRows.length + notStartedRows.length === 12 && inProgressRows.length >= 5);

check('matrix keeps PS-285 conservative at 60%',
  /Current completion estimate: PS-285 60%/.test(matrix));
check('matrix and checklist do not claim Final Review readiness',
  /not Final Review-ready/.test(matrix) && /not Final Review-ready/.test(checklist));
check('board audit still documents the old one-slice overclaim risk',
  boardAudit.includes('slice') &&
    boardAudit.includes('PS-285') &&
    boardAudit.includes('~20') &&
    boardAudit.includes('12-phase umbrella'));

const requiredSafety = [
  'offline/static',
  'does not run live labels',
  'buy postage',
  'send marketplace notifications',
  'mutate production orders',
  'mutate production queues',
  'shipped/cancelled data',
  'No Trello comment',
];
check('matrix carries no-live/no-mutation/no-Trello safety boundaries',
  includesAll(matrix, requiredSafety).length === 0,
  includesAll(matrix, requiredSafety));

if (failures > 0) {
  console.error(`\nFAIL PS-285 phase evidence matrix guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-285 phase evidence matrix guard');
