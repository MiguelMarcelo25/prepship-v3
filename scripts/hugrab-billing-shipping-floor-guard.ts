import { readFileSync } from 'node:fs';

const script = readFileSync('scripts/hugrab-billing-shipping-floor.ts', 'utf8');
let failures = 0;

function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

check('script is HUGRAB-only', script.includes("const CLIENT_NAME = 'HUGRAB'") && script.includes('c.name = ${CLIENT_NAME}'));
check('script targets only billing shipping rows', script.includes("b.line_type = 'shipping'"));
check('script uses selected-rate threshold below 7.95', script.includes('const SELECTED_RATE_BELOW = 7.95') && script.includes('selected_rate_cost < ${SELECTED_RATE_BELOW}'));
check('script sets billed shipping floor from TARGET_SHIPPING', script.includes('const TARGET_SHIPPING = 7.73') && script.includes('const amount = revert ? Number(row.selected_rate_cost) : TARGET_SHIPPING'));
check('script is dry-run by default', script.includes('if (!apply)') && script.includes('Dry run only'));
check('script updates billing_line_items only after --apply', script.includes("const apply = hasFlag('apply')") && script.includes('update billing_line_items'));
check('script can revert the floor back to selected rate', script.includes("const revert = hasFlag('revert')") && script.includes('back to Selected Rate'));
check('script supports expected row count guard', script.includes("optionalPositiveInt('expect')") && script.includes('Refusing to update: --expect='));
check('script does not touch orders or shipments', !/update\s+(orders|shipments)\b/i.test(script) && !/delete\s+from\s+(orders|shipments)\b/i.test(script));

if (failures > 0) {
  console.error(`\nFAIL HUGRAB billing shipping floor guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS HUGRAB billing shipping floor guard');
