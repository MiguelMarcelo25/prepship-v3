/**
 * PS-166 / PS-258 closeout checkpoint.
 *
 * This guard keeps the broad OrdersView decomposition cards honest: the current
 * extraction slices are wired and documented, but the cards are not Final
 * Review-ready yet.
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}`);
}

const packageJson = readFileSync('package.json', 'utf8');
const doc = readFileSync('docs/ps-tickets/ps-166-ps-258-decomposition-status.md', 'utf8');

const requiredScripts = [
  'test:ps-166-orders-rate-proof',
  'test:ps-258-daily-stats-rollover',
  'test:ps-258-non-critical-scheduler',
  'test:ps-258-orders-queue-parsers',
  'test:ps-258-orders-filtered-sort',
  'test:ps-258-orders-column-prefs-local',
  'test:ps-258-orders-table-density-prefs',
  'test:ps-258-component-boundary',
  'test:ps-258-empty-state-props-contract',
  'test:ps-258-empty-panel-contract',
  'test:ps-258-search-bar-contract',
];

for (const scriptName of requiredScripts) {
  check(`package.json wires ${scriptName}`, packageJson.includes(`"${scriptName}"`));
  check(`status doc lists ${scriptName}`, doc.includes(`\`${scriptName}\``));
}

check('status doc keeps PS-166 conservative at 66%', /PS-166 66%/.test(doc));
check('status doc keeps PS-258 conservative at 72%', /PS-258 72%/.test(doc));
check('status doc explicitly says cards are not Final Review-ready', /not Final Review-ready/.test(doc));
check('status doc requires DOM or byte-equality certification', /DOM or byte-equality certification/.test(doc));
check('status doc preserves shipped/cancelled lockdown warning', /shipped\/cancelled lockdown/.test(doc));

if (failures > 0) {
  console.error(`\nFAIL PS-166/PS-258 decomposition closeout guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-166/PS-258 decomposition closeout guard');
