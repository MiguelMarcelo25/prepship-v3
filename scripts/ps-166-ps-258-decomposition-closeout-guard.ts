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
const certificationDoc = readFileSync('docs/ps-tickets/ps-166-ps-258-decomposition-certification.md', 'utf8');

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
  'test:ps-166-ps-258-orders-leaf-render-parity',
  'test:ps-166-ps-258-orders-selection-render-parity',
  'test:ps-166-ps-258-decomposition-certification',
  'test:ps-166-ps-258-decomposition-closeout',
];

for (const scriptName of requiredScripts) {
  check(`package.json wires ${scriptName}`, packageJson.includes(`"${scriptName}"`));
  check(`status doc lists ${scriptName}`, doc.includes(`\`${scriptName}\``));
  check(`certification doc lists ${scriptName}`, certificationDoc.includes(`\`${scriptName}\``));
}

check('status doc keeps PS-166 conservative at 75%', /PS-166 75%/.test(doc));
check('status doc keeps PS-258 conservative at 81%', /PS-258 81%/.test(doc));
check('certification doc keeps PS-166 conservative at 75%', /PS-166 75%/.test(certificationDoc));
check('certification doc keeps PS-258 conservative at 81%', /PS-258 81%/.test(certificationDoc));
check('status doc explicitly says cards are not Final Review-ready', /not Final Review-ready/.test(doc));
check('certification doc explicitly says cards are not Final Review-ready', /not Final Review-ready/.test(certificationDoc));
check('status doc records extracted render parity but still requires larger parity proof',
  /selected-order toolbar/.test(doc) &&
    /not the full table shell or row renderer/.test(doc));
check('certification doc records extracted render parity but still requires larger parity proof',
  /selected-toolbar branches/.test(certificationDoc) &&
    /not the full table shell\s+or row renderer/.test(certificationDoc));
check('status doc preserves shipped/cancelled lockdown warning', /shipped\/cancelled lockdown/.test(doc));
check('certification doc preserves safety boundaries',
  /offline\/static only/.test(certificationDoc) &&
  /does not change runtime UI behavior/.test(certificationDoc) &&
  /No Trello comment or move is authorized/.test(certificationDoc));

if (failures > 0) {
  console.error(`\nFAIL PS-166/PS-258 decomposition closeout guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-166/PS-258 decomposition closeout guard');
