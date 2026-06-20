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
const phaseRows = checklist
  .split(/\r?\n/)
  .filter((line) => /^\|\s*\d+\s*\|/.test(line));
const completeRows = phaseRows.filter((line) => /\|\s*Complete\s*\|/i.test(line));
const inProgressRows = phaseRows.filter((line) => /\|\s*In progress\s*\|/i.test(line));
const notStartedRows = phaseRows.filter((line) => /\|\s*Not started\s*\|/i.test(line));

check('phase checklist has exactly 12 phases', phaseRows.length === 12);
check('phase 8 marketplace-confirm boundary is explicitly complete',
  /\|\s*8\s*\|\s*Marketplace confirmation boundary\s*\|\s*Complete\s*\|/.test(checklist));
check('only one phase is marked complete in this evidence slice', completeRows.length === 1);
check('remaining phases are still tracked as in progress or not started',
  completeRows.length + inProgressRows.length + notStartedRows.length === 12);
check('checklist says PS-285 is not Final Review-ready yet',
  /PS-285 is not Final Review-ready/i.test(checklist));
check('checklist names the existing phase-8 guard as evidence',
  /test:ps-285-marketplace-confirm-boundary/.test(checklist));
check('checklist forbids live marketplace or shipped\/cancelled mutation during audit',
  /No live marketplace notifications/.test(checklist) &&
    /no shipped\/cancelled data mutation/.test(checklist));

const pkg = readFileSync('package.json', 'utf8');
check('package.json wires test:ps-285-umbrella-closeout',
  /"test:ps-285-umbrella-closeout"\s*:\s*"tsx scripts\/ps-285-umbrella-closeout-guard\.ts"/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-285 umbrella closeout guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-285 umbrella closeout guard');
