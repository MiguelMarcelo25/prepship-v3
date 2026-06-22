/**
 * PS-285 protected-file diff proof guard.
 *
 * Offline/static only. Pins phase 1 of the PS-285 umbrella: the protected-file
 * audit is complete for this slice, while the umbrella remains below Final
 * Review because only phases 1, 8, and 10 are complete.
 */
import { existsSync, readFileSync } from 'node:fs';
import { LOCKDOWN_GLOBS, lockdownPathsTouched } from './fence-match';

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

const proofPath = 'docs/ps-tickets/ps-285-protected-file-diff-proof.md';
const proof = read(proofPath);
const normalizedProof = proof.replace(/\s+/g, ' ');
const checklist = read('docs/ps-tickets/ps-285-phase-checklist.md');
const matrix = read('docs/ps-tickets/ps-285-phase-evidence-matrix.md');
const packageJson = read('package.json');
const agents = read('AGENTS.md');
const fence = read('scripts/fence-match.ts');
const fenceGuard = read('scripts/ps-245-lockdown-fence-guard.ts');
const fenceDriver = read('scripts/verify-lockdown-fence.ts');

check('PS-285 protected-file proof doc exists', existsSync(proofPath));
check('proof keeps PS-285 conservative at 45%', /Current completion estimate: PS-285 45%/.test(proof));
check('proof explicitly refuses Final Review readiness',
  /does not make PS-285 Final Review-ready/i.test(proof));

const lockedSurfaceNames = [
  'src/db/schema/orders.ts',
  'src/db/schema/shipments.ts',
  'src/services/fulfillment-deductions.ts',
  'src/routes/orders.ts',
  'web/src/components/Views/OrdersView.tsx',
  'assertOrderEditable()',
  'order_status',
  'shipments',
];
check('proof lists the protected lockdown surfaces',
  missing(proof, lockedSurfaceNames).length === 0,
  missing(proof, lockedSurfaceNames));

const proofSliceFiles = [
  'docs/ps-tickets/ps-285-protected-file-diff-proof.md',
  'scripts/ps-285-protected-file-diff-proof-guard.ts',
  'docs/ps-tickets/ps-285-phase-checklist.md',
  'docs/ps-tickets/ps-285-phase-evidence-matrix.md',
  'scripts/ps-285-phase-evidence-matrix-guard.ts',
  'scripts/ps-285-umbrella-closeout-guard.ts',
  'package.json',
];
check('phase-1 proof slice files are outside lockdown globs',
  lockdownPathsTouched(proofSliceFiles).length === 0,
  lockdownPathsTouched(proofSliceFiles));
check('proof doc records the exact phase-1 proof slice files',
  missing(proof, proofSliceFiles).length === 0,
  missing(proof, proofSliceFiles));

check('fence matcher covers the locked schema and deduction files',
  LOCKDOWN_GLOBS.includes('src/db/schema/orders.ts') &&
    LOCKDOWN_GLOBS.includes('src/db/schema/shipments.ts') &&
    LOCKDOWN_GLOBS.includes('src/services/fulfillment-deductions.ts'));
check('AGENTS.md keeps shipped/cancelled override phrase and locked files visible',
  agents.includes('unlock shipped data') &&
    agents.includes('src/db/schema/orders.ts') &&
    agents.includes('src/db/schema/shipments.ts') &&
    agents.includes('web/src/components/Views/OrdersView.tsx'));
check('fence owner and CI driver are still wired',
  /export const LOCKDOWN_GLOBS/.test(fence) &&
    /git diff --name-only/.test(fenceDriver) &&
    /hasLockdownOverride\(messages\)/.test(fenceDriver) &&
    /test:ps-245-lockdown-fence/.test(packageJson) &&
    /"verify:lockdown-fence"/.test(packageJson));
check('PS-245 guard still verifies lockdown matching behavior',
  fenceGuard.includes('lockdownPathsTouched') &&
    fenceGuard.includes('src/db/schema/shipments.ts') &&
    fenceGuard.includes('verify:lockdown-fence'));

const completeRows = checklist
  .split(/\r?\n/)
  .filter((line) => /^\|\s*\d+\s*\|/.test(line) && /\|\s*Complete\s*\|/i.test(line));
check('phase 1 is complete in checklist and matrix',
  /\|\s*1\s*\|\s*Lockdown fence and protected-file audit\s*\|\s*Complete\s*\|/i.test(checklist) &&
    /\|\s*1\s*\|\s*Lockdown fence and protected-file audit\s*\|\s*Complete\s*\|/i.test(matrix));
check('phase 1 remains complete after later PS-285 evidence slices',
  completeRows.some((line) => /^\|\s*1\s*\|/.test(line)),
  completeRows);
check('checklist and matrix keep PS-285 at 60% and not Final Review-ready',
  /Current completion estimate: PS-285 60%/.test(checklist) &&
    /Current completion estimate: PS-285 60%/.test(matrix) &&
    /not Final Review-ready/i.test(checklist) &&
    /not Final Review-ready/i.test(matrix));
check('package wires PS-285 protected-file proof guard',
  /"test:ps-285-protected-file-diff-proof"\s*:\s*"tsx scripts\/ps-285-protected-file-diff-proof-guard\.ts"/.test(packageJson));

const safetyPhrases = [
  'offline/static',
  'does not run live labels',
  'buy postage',
  'send marketplace notifications',
  'mutate production orders',
  'mutate production queues',
  'shipped/cancelled data',
  'No Trello comment',
];
check('proof carries no-live/no-mutation/no-Trello safety boundaries',
  missing(normalizedProof, safetyPhrases).length === 0,
  missing(normalizedProof, safetyPhrases));

if (failures > 0) {
  console.error(`\nFAIL PS-285 protected-file diff proof guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-285 protected-file diff proof guard');
