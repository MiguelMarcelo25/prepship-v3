/**
 * Guard: when a direct-carrier rate is selected, the Orders side-panel service
 * dropdown must include the current dynamic service code even when the account
 * has no static ShipStation service list.
 *
 * Read-only: no DB, no network, no provider calls.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = resolve('web/src/components/Views/OrdersView.tsx');
const source = readFileSync(file, 'utf8');

const checks = [
  {
    name: 'panel computes whether current service is missing from static options',
    ok: /const serviceCodeMissingFromOptions =[\s\S]*panelForm\.serviceCode[\s\S]*!serviceOptions\.some\(\(option\) => option\.code === panelForm\.serviceCode\)/.test(source),
  },
  {
    name: 'non-test service select renders current dynamic service option',
    ok: /serviceCodeMissingFromOptions \? \(\s*<option value=\{panelForm\.serviceCode\}>\{formatServiceCode\(panelForm\.serviceCode\)\}<\/option>\s*\) : null/.test(source),
  },
  {
    name: 'dynamic service option is before the blank placeholder option',
    ok: /serviceCodeMissingFromOptions[\s\S]*<option value="">\{panelForm\.serviceCode \? formatServiceCode\(panelForm\.serviceCode\) : 'Select Service'\}<\/option>/.test(source),
  },
];

let failures = 0;
for (const check of checks) {
  if (check.ok) {
    console.log(`ok   ${check.name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${check.name}`);
  }
}

if (failures > 0) {
  console.error(`\nFAIL rate-browser dynamic service selection guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS rate-browser dynamic service selection guard');
