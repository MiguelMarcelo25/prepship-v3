/**
 * Guard: the carrier active-toggle button reads "Enable"/"Disable"
 * (not "Activate"/"Deactivate") per operator preference.
 */
import { readFileSync } from 'node:fs';

const card = readFileSync('web/src/components/Settings/CarrierIntegrationsCard.tsx', 'utf8');
const stateToggle = readFileSync('web/src/components/ui/StateToggle.tsx', 'utf8');

let failures = 0;
function check(name: string, condition: boolean) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// Re-anchor (2026-06-16): the carrier active control was redesigned from a labeled
// button into the StateToggle switch (web/src/components/ui/StateToggle.tsx) — the
// knob position/color IS the state, which reads less ambiguously than a button. The
// operator preference (Enable/Disable wording, never Activate/Deactivate) is preserved
// by the switch's Enabling…/Disabling… loading text + the card's "click to enable/
// disable it" tooltip. Pinned at the live design, not the retired button props.
check(
  'carrier active control is the StateToggle switch bound to d.active',
  /<StateToggle\b[\s\S]{0,400}?on=\{d\.active !== false\}/.test(card),
);
check(
  'StateToggle renders Enabling…/Disabling… loading wording (operator Enable/Disable preference)',
  /'Disabling…' : 'Enabling…'/.test(stateToggle),
);
check(
  'carrier active tooltip uses enable/disable wording (not Activate/Deactivate)',
  /click to enable it/.test(card) && /click to disable it/.test(card),
);

if (failures > 0) {
  console.error(`\nFAIL carrier enable/disable label guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS carrier enable/disable label guard');
