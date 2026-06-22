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
const normalizedRunbook = runbook.replace(/\s+/g, ' ');
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
check('phase 8 marketplace-confirm boundary is explicitly complete',
  /\|\s*8\s*\|\s*Marketplace confirmation boundary\s*\|\s*Complete\s*\|/.test(checklist));
check('phase 10 runbook evidence is explicitly complete',
  /\|\s*10\s*\|\s*Observability and runbook coverage\s*\|\s*Complete\s*\|/.test(checklist));
check('only phases 1, 8, and 10 are marked complete in this evidence slice',
  completeRows.length === 3 &&
    completeRows.some((line) => /^\|\s*1\s*\|/.test(line)) &&
    completeRows.some((line) => /^\|\s*8\s*\|/.test(line)) &&
    completeRows.some((line) => /^\|\s*10\s*\|/.test(line)));
check('remaining phases are still tracked as in progress or not started',
  completeRows.length + inProgressRows.length + notStartedRows.length === 12);
check('checklist records the current conservative 45% estimate',
  /Current completion estimate: PS-285 45%/.test(checklist));
check('matrix records the current conservative 45% estimate',
  /Current completion estimate: PS-285 45%/.test(matrix));
check('checklist says PS-285 is not Final Review-ready yet',
  /PS-285 is not Final Review-ready/i.test(checklist));
check('matrix says PS-285 is not Final Review-ready yet',
  /PS-285 is not Final Review-ready/i.test(matrix));
check('checklist names the existing phase-8 guard as evidence',
  /test:ps-285-marketplace-confirm-boundary/.test(checklist));
check('checklist names the phase-1 protected-file proof guard as evidence',
  /test:ps-285-protected-file-diff-proof/.test(checklist));
check('checklist names the phase-10 runbook guard as evidence',
  /test:ps-285-runbook-evidence/.test(checklist));
check('protected-file proof says phase 1 completion does not close PS-285',
  /does not make PS-285 Final Review-ready/i.test(protectedFileProof));
check('runbook says phase 10 completion does not close PS-285',
  /does not make PS-285 Final Review-ready/i.test(normalizedRunbook) &&
    /not a substitute for the remaining/i.test(normalizedRunbook));
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
