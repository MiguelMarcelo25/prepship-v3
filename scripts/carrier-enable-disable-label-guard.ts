/**
 * Guard: the carrier active-toggle button reads "Enable"/"Disable"
 * (not "Activate"/"Deactivate") per operator preference.
 */
import { readFileSync } from 'node:fs';

const card = readFileSync('web/src/components/Settings/CarrierIntegrationsCard.tsx', 'utf8');

let failures = 0;
function check(name: string, condition: boolean) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

check(
  'active-toggle label is Enable/Disable',
  /label=\{d\.active === false \? 'Enable' : 'Disable'\}/.test(card),
);
check(
  'active-toggle loading label is Enabling/Disabling',
  /loadingLabel=\{d\.active === false \? 'Enabling…' : 'Disabling…'\}/.test(card),
);
check(
  'active-toggle tooltips use Enable/Disable wording',
  /Enable this carrier —/.test(card) && /Disable this carrier —/.test(card),
);

if (failures > 0) {
  console.error(`\nFAIL carrier enable/disable label guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS carrier enable/disable label guard');
