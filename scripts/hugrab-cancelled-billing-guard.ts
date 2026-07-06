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

// PS-377 (2026-07-04, unlock shipped data): cancelled orders are billing source
// rows for EVERY client (was HUGRAB-only). HUGRAB is retained as a LAYERED
// cancelled-BILLING policy — its cancelled orders keep real fees, while every
// other client's cancelled order shows a single $0.00 no-charge row.
const billing = readFileSync('src/services/billing.ts', 'utf8');

check(
  'billing keeps the named HUGRAB cancelled-billing policy + the source-order gate',
  /HUGRAB_CANCELLED_BILLING_CLIENT_NAME\s*=\s*'HUGRAB'/.test(billing) &&
    /function isBillingSourceOrderBillable/.test(billing),
);

check(
  'billing source query admits shipped and cancelled candidates',
  /orderStatus:\s*orders\.orderStatus/.test(billing) &&
    /orderLifecycleBillingSourcePredicate\(\)/.test(billing),
);

check(
  'PS-377: cancelled orders are billing source rows for EVERY client (no longer HUGRAB-only)',
  /resolveOrderLifecycleStatus\(\{[\s\S]*?canonicalStatus/.test(billing) &&
    /isBillingLifecycleSourceStatus\(lifecycle\)/.test(billing) &&
    !/if \(status === 'cancelled'\) return normalizeBillingClientName\(input\.clientName\)/.test(billing),
);

check(
  'PS-377: HUGRAB is layered as the cancelled-BILLING policy; every other cancelled order gets a $0 no-charge line',
  /const cancelledNoCharge =[\s\S]*?=== 'cancelled' &&[\s\S]*?normalizeBillingClientName\(clientNameById\.get\(clientId\)[\s\S]*?!==\s*\n?\s*HUGRAB_CANCELLED_BILLING_CLIENT_NAME/.test(billing) &&
    /lineType: 'cancelled'/.test(billing),
);

check(
  'billing freshness query includes cancelled source rows for every client (not HUGRAB-only)',
  /orderLifecycleBillingSourcePredicateAlias\('o'\)/.test(billing) &&
    !/o\.order_status = 'cancelled' and upper\(trim\(sc\.name\)\) = \$\{HUGRAB_CANCELLED_BILLING_CLIENT_NAME\}/.test(billing),
);

check(
  'empty billing message names shipped or cancelled source rows (not HUGRAB-only)',
  /No billable shipped or cancelled orders found for this range\./.test(billing),
);

if (failures > 0) {
  console.error(`\nFAIL HUGRAB cancelled billing guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS HUGRAB cancelled billing guard');
