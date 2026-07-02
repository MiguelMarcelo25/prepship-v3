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
check('script sets billed shipping to 7.73 only', script.includes('const TARGET_SHIPPING = 7.73') && script.includes('set unit_cost = ${TARGET_SHIPPING.toFixed(2)}::numeric'));
check('script is dry-run by default', script.includes('if (!apply)') && script.includes('Dry run only'));
check('script updates billing_line_items only after --apply', script.includes("const apply = hasFlag('apply')") && script.includes('update billing_line_items'));
check('script does not touch orders or shipments', !/update\s+(orders|shipments)\b/i.test(script) && !/delete\s+from\s+(orders|shipments)\b/i.test(script));

if (failures > 0) {
  console.error(`\nFAIL HUGRAB billing shipping floor guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS HUGRAB billing shipping floor guard');
