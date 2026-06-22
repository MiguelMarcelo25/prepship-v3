/**
 * PS-291 status guard.
 *
 * Keeps manual-order preview reporting honest: current offline proof is strong
 * enough for 86%, but the card is not Final Review-ready until DJ approves and
 * observes a manual-order runtime canary.
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

const statusPath = 'docs/ps-tickets/ps-291-manual-order-preview-status.md';
const statusDoc = read(statusPath);
const incomingDoc = read('docs/ps-287-through-291-incoming-tickets.md');
const packageJson = read('package.json');
const focusedGuard = read('scripts/ps-291-manual-order-real-optional-items-guard.ts');
const closeoutGuard = read('scripts/ps-291-manual-order-preview-closeout-guard.ts');

check('PS-291 status document exists', existsSync(statusPath));

const requiredScripts = [
  'test:ps-291-manual-order-preview',
  'test:ps-291-manual-order-preview-closeout',
  'test:ps-291-manual-order-preview-status',
];

for (const scriptName of requiredScripts) {
  check(`package.json wires ${scriptName}`, packageJson.includes(`"${scriptName}"`));
  check(`status doc lists ${scriptName}`, statusDoc.includes(`\`${scriptName}\``));
}

check('package wires status guard to this file',
  /"test:ps-291-manual-order-preview-status"\s*:\s*"tsx scripts\/ps-291-manual-order-preview-status-guard\.ts"/.test(packageJson));
check('status doc records PS-291 at 86%',
  /Current completion estimate: PS-291 86%/.test(statusDoc));
check('incoming ticket monitor row has been corrected from stale 38% to 86%',
  /\| PS-291 \|[^\n]*\|\s*86\s*\|/.test(incomingDoc) &&
    !/\| PS-291 \|[^\n]*\|\s*38\s*\|/.test(incomingDoc));
check('incoming ticket monitor no longer claims manual route sets isTest:true',
  !/PS-291[^\n]*isTest:true/.test(incomingDoc));

check('focused guard still proves the core manual-order DoD items',
  /manual orders are REAL/i.test(focusedGuard) &&
    /line items are OPTIONAL/i.test(focusedGuard) &&
    focusedGuard.includes('Ship-From selector') &&
    focusedGuard.includes('excludeMarketplaceOwnedRows') &&
    focusedGuard.includes('buildManualSelectedBestRate') &&
    focusedGuard.includes('Save this location'));
check('closeout guard separates code proof from runtime canary',
  closeoutGuard.includes('code/test proof complete') &&
    closeoutGuard.includes('real non-test manual order behavior still needs explicit safety review') &&
    closeoutGuard.includes('move to Final Review only after DJ approves'));

check('status doc refuses Final Review before canary',
  /not Final Review-ready/.test(statusDoc) &&
    /DJ-approved runtime manual-order canary/.test(statusDoc));
check('status doc carries no-live/no-mutation safety boundaries',
  missing(statusDoc, [
    'offline/static',
    'does not run live labels',
    'buy postage',
    'send marketplace notifications',
    'mutate production orders',
    'mutate production queues',
    'repair production data',
    'shipped/cancelled data',
  ]).length === 0,
  missing(statusDoc, [
    'offline/static',
    'does not run live labels',
    'buy postage',
    'send marketplace notifications',
    'mutate production orders',
    'mutate production queues',
    'repair production data',
    'shipped/cancelled data',
  ]));

if (failures > 0) {
  console.error(`\nFAIL PS-291 manual-order preview status guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-291 manual-order preview status guard');
