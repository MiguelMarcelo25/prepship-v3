import { readFileSync } from 'node:fs';

let failures = 0;

function check(name: string, condition: boolean) {
  if (condition) {
    console.log(`ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}`);
}

const billing = readFileSync('src/services/billing.ts', 'utf8');

check(
  'billing owns a named HUGRAB cancelled-order exception',
  /HUGRAB_CANCELLED_BILLING_CLIENT_NAME\s*=\s*'HUGRAB'/.test(billing) &&
    /function isBillingSourceOrderBillable/.test(billing),
);

check(
  'billing source query admits shipped and cancelled candidates',
  /orderStatus:\s*orders\.orderStatus/.test(billing) &&
    /inArray\(orders\.orderStatus,\s*\['shipped',\s*'cancelled'\]\)/.test(billing),
);

check(
  'cancelled source rows are filtered by HUGRAB client only',
  /isBillingSourceOrderBillable\(\{[\s\S]*orderStatus:\s*row\.orderStatus,[\s\S]*clientName:[\s\S]*clientNameById\.get\(clientId\)[\s\S]*\}\)/.test(billing) &&
    /if \(status === 'cancelled'\) return normalizeBillingClientName\(input\.clientName\) === HUGRAB_CANCELLED_BILLING_CLIENT_NAME/.test(billing),
);

check(
  'billing freshness query also includes only HUGRAB cancelled source rows',
  /where o\.order_status in \('shipped', 'cancelled'\)/.test(billing) &&
    /o\.order_status = 'cancelled' and upper\(trim\(sc\.name\)\) = \$\{HUGRAB_CANCELLED_BILLING_CLIENT_NAME\}/.test(billing),
);

check(
  'empty billing message names shipped or HUGRAB cancelled source rows',
  /No billable shipped orders or HUGRAB cancelled orders found for this range\./.test(billing),
);

if (failures > 0) {
  console.error(`\nFAIL HUGRAB cancelled billing guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS HUGRAB cancelled billing guard');
