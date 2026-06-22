/**
 * PS-285 umbrella closeout guard.
 *
 * PS-285 covers PS-245 through PS-259, so a single marketplace-confirmation
 * boundary slice must not close the whole umbrella. This guard pins the
 * report/status artifact that keeps the card honest: exactly 12 phases, only
 * the marketplace-confirm boundary marked complete here, and no claim that the
 * card is Final Review-ready.
 *
 *   npx tsx scripts/ps-285-umbrella-closeout-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, condition: boolean) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const checklist = readFileSync('docs/ps-tickets/ps-285-phase-checklist.md', 'utf8');
const matrix = readFileSync('docs/ps-tickets/ps-285-phase-evidence-matrix.md', 'utf8');
const runbook = readFileSync('docs/ps-tickets/ps-285-runbook-evidence.md', 'utf8');
const protectedFileProof = readFileSync('docs/ps-tickets/ps-285-protected-file-diff-proof.md', 'utf8');
const labelPurchaseEvidence = readFileSync('docs/ps-tickets/ps-285-label-purchase-evidence.md', 'utf8');
const printQueueEvidence = readFileSync('docs/ps-tickets/ps-285-print-queue-evidence.md', 'utf8');
const voidRetractEvidence = readFileSync('docs/ps-tickets/ps-285-void-retract-evidence.md', 'utf8');
const recoveryRetryEvidence = readFileSync('docs/ps-tickets/ps-285-recovery-retry-evidence.md', 'utf8');
const workflowCertificationEvidence = readFileSync('docs/ps-tickets/ps-285-workflow-certification-evidence.md', 'utf8');
const normalizedRunbook = runbook.replace(/\s+/g, ' ');
const normalizedLabelPurchaseEvidence = labelPurchaseEvidence.replace(/\s+/g, ' ');
const normalizedPrintQueueEvidence = printQueueEvidence.replace(/\s+/g, ' ');
const normalizedVoidRetractEvidence = voidRetractEvidence.replace(/\s+/g, ' ');
const normalizedRecoveryRetryEvidence = recoveryRetryEvidence.replace(/\s+/g, ' ');
const normalizedWorkflowCertificationEvidence = workflowCertificationEvidence.replace(/\s+/g, ' ');
const phaseRows = checklist
  .split(/\r?\n/)
  .filter((line) => /^\|\s*\d+\s*\|/.test(line));
const matrixPhaseRows = matrix
  .split(/\r?\n/)
  .filter((line) => /^\|\s*\d+\s*\|/.test(line));
const completeRows = phaseRows.filter((line) => /\|\s*Complete\s*\|/i.test(line));
const inProgressRows = phaseRows.filter((line) => /\|\s*In progress\s*\|/i.test(line));
const notStartedRows = phaseRows.filter((line) => /\|\s*Not started\s*\|/i.test(line));

check('phase checklist has exactly 12 phases', phaseRows.length === 12);
check('phase evidence matrix has exactly 12 phases', matrixPhaseRows.length === 12);
check('phase 1 protected-file audit is explicitly complete',
  /\|\s*1\s*\|\s*Lockdown fence and protected-file audit\s*\|\s*Complete\s*\|/.test(checklist));
check('phase 4 label purchase boundary safety is explicitly complete',
  /\|\s*4\s*\|\s*Label purchase boundary safety\s*\|\s*Complete\s*\|/.test(checklist));
check('phase 5 print queue durability is explicitly complete',
  /\|\s*5\s*\|\s*Print queue durability and idempotency\s*\|\s*Complete\s*\|/.test(checklist));
check('phase 7 void/retract safety is explicitly complete',
  /\|\s*7\s*\|\s*Void\/retract and cancellation safety\s*\|\s*Complete\s*\|/.test(checklist));
check('phase 8 marketplace-confirm boundary is explicitly complete',
  /\|\s*8\s*\|\s*Marketplace confirmation boundary\s*\|\s*Complete\s*\|/.test(checklist));
check('phase 9 recovery/retry tooling safety is explicitly complete',
  /\|\s*9\s*\|\s*Recovery\/retry tooling safety\s*\|\s*Complete\s*\|/.test(checklist));
check('phase 10 runbook evidence is explicitly complete',
  /\|\s*10\s*\|\s*Observability and runbook coverage\s*\|\s*Complete\s*\|/.test(checklist));
check('phase 11 workflow certification is explicitly complete',
  /\|\s*11\s*\|\s*End-to-end certification matrix\s*\|\s*Complete\s*\|/.test(checklist));
check('only phases 1, 4, 5, 7, 8, 9, 10, and 11 are marked complete in this evidence slice',
  completeRows.length === 8 &&
    completeRows.some((line) => /^\|\s*1\s*\|/.test(line)) &&
    completeRows.some((line) => /^\|\s*4\s*\|/.test(line)) &&
    completeRows.some((line) => /^\|\s*5\s*\|/.test(line)) &&
    completeRows.some((line) => /^\|\s*7\s*\|/.test(line)) &&
    completeRows.some((line) => /^\|\s*8\s*\|/.test(line)) &&
    completeRows.some((line) => /^\|\s*9\s*\|/.test(line)) &&
    completeRows.some((line) => /^\|\s*10\s*\|/.test(line)) &&
    completeRows.some((line) => /^\|\s*11\s*\|/.test(line)));
check('remaining phases are still tracked as in progress or not started',
  completeRows.length + inProgressRows.length + notStartedRows.length === 12);
check('checklist records the current conservative 70% estimate',
  /Current completion estimate: PS-285 70%/.test(checklist));
check('matrix records the current conservative 70% estimate',
  /Current completion estimate: PS-285 70%/.test(matrix));
check('checklist says PS-285 is not Final Review-ready yet',
  /PS-285 is not Final Review-ready/i.test(checklist));
check('matrix says PS-285 is not Final Review-ready yet',
  /PS-285 is not Final Review-ready/i.test(matrix));
check('checklist names the existing phase-8 guard as evidence',
  /test:ps-285-marketplace-confirm-boundary/.test(checklist));
check('checklist names the phase-1 protected-file proof guard as evidence',
  /test:ps-285-protected-file-diff-proof/.test(checklist));
check('checklist names the phase-4 label purchase evidence guard as evidence',
  /test:ps-285-label-purchase-evidence/.test(checklist));
check('checklist names the phase-5 print queue evidence guard as evidence',
  /test:ps-285-print-queue-evidence/.test(checklist));
check('checklist names the phase-7 void/retract evidence guard as evidence',
  /test:ps-285-void-retract-evidence/.test(checklist));
check('checklist names the phase-9 recovery/retry evidence guard as evidence',
  /test:ps-285-recovery-retry-evidence/.test(checklist));
check('checklist names the phase-10 runbook guard as evidence',
  /test:ps-285-runbook-evidence/.test(checklist));
check('checklist names the phase-11 workflow certification guard as evidence',
  /test:ps-285-workflow-certification-evidence/.test(checklist));
check('protected-file proof says phase 1 completion does not close PS-285',
  /does not make PS-285 Final Review-ready/i.test(protectedFileProof));
check('label-purchase evidence says phase 4 completion does not close PS-285',
  /does not make PS-285 Final Review-ready/i.test(normalizedLabelPurchaseEvidence));
check('print queue evidence says phase 5 completion does not close PS-285',
  /does not make PS-285 Final Review-ready/i.test(normalizedPrintQueueEvidence));
check('void/retract evidence says phase 7 completion does not close PS-285',
  /does not make PS-285 Final Review-ready/i.test(normalizedVoidRetractEvidence));
check('recovery/retry evidence says phase 9 completion does not close PS-285',
  /does not make PS-285 Final Review-ready/i.test(normalizedRecoveryRetryEvidence));
check('runbook says phase 10 completion does not close PS-285',
  /does not make PS-285 Final Review-ready/i.test(normalizedRunbook) &&
    /not a substitute for the remaining/i.test(normalizedRunbook));
check('workflow certification evidence says phase 11 completion does not close PS-285',
  /does not make PS-285 Final Review-ready/i.test(normalizedWorkflowCertificationEvidence));
check('matrix maps every child PS-245 through PS-259',
  Array.from({ length: 15 }, (_, index) => `PS-${245 + index}`).every((ticket) => matrix.includes(ticket)));
check('checklist forbids live marketplace or shipped\/cancelled mutation during audit',
  /No live marketplace notifications/.test(checklist) &&
    /no shipped\/cancelled data mutation/.test(checklist));
check('matrix forbids live labels, queue/order mutation, Trello mutation, and shipped\/cancelled mutation',
  /does not run live labels/.test(matrix) &&
    /mutate production orders/.test(matrix) &&
    /mutate production queues/.test(matrix) &&
    /No Trello comment/.test(matrix) &&
    /shipped\/cancelled data/.test(matrix));

const pkg = readFileSync('package.json', 'utf8');
check('package.json wires test:ps-285-workflow-certification-evidence',
  /"test:ps-285-workflow-certification-evidence"\s*:\s*"tsx scripts\/ps-285-workflow-certification-evidence-guard\.ts"/.test(pkg));
check('package.json wires test:ps-285-recovery-retry-evidence',
  /"test:ps-285-recovery-retry-evidence"\s*:\s*"tsx scripts\/ps-285-recovery-retry-evidence-guard\.ts"/.test(pkg));
check('package.json wires test:ps-285-void-retract-evidence',
  /"test:ps-285-void-retract-evidence"\s*:\s*"tsx scripts\/ps-285-void-retract-evidence-guard\.ts"/.test(pkg));
check('package.json wires test:ps-285-print-queue-evidence',
  /"test:ps-285-print-queue-evidence"\s*:\s*"tsx scripts\/ps-285-print-queue-evidence-guard\.ts"/.test(pkg));
check('package.json wires test:ps-285-label-purchase-evidence',
  /"test:ps-285-label-purchase-evidence"\s*:\s*"tsx scripts\/ps-285-label-purchase-evidence-guard\.ts"/.test(pkg));
check('package.json wires test:ps-285-protected-file-diff-proof',
  /"test:ps-285-protected-file-diff-proof"\s*:\s*"tsx scripts\/ps-285-protected-file-diff-proof-guard\.ts"/.test(pkg));
check('package.json wires test:ps-285-phase-evidence-matrix',
  /"test:ps-285-phase-evidence-matrix"\s*:\s*"tsx scripts\/ps-285-phase-evidence-matrix-guard\.ts"/.test(pkg));
check('package.json wires test:ps-285-runbook-evidence',
  /"test:ps-285-runbook-evidence"\s*:\s*"tsx scripts\/ps-285-runbook-evidence-guard\.ts"/.test(pkg));
check('package.json wires test:ps-285-umbrella-closeout',
  /"test:ps-285-umbrella-closeout"\s*:\s*"tsx scripts\/ps-285-umbrella-closeout-guard\.ts"/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-285 umbrella closeout guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-285 umbrella closeout guard');
