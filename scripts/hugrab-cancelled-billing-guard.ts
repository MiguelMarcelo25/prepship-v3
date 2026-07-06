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

// PS-377 made cancelled orders billing source rows for EVERY client (was
// HUGRAB-only). PS-396 (2026-07-06, unlock shipped data) removes the old HUGRAB
// billable-cancelled exception: HUGRAB cancelled rows remain visible, but they
// are the same single $0.00 no-charge audit rows as every client.
const billing = readFileSync('src/services/billing.ts', 'utf8');

check(
  'billing keeps cancelled source-order gate without a named HUGRAB billable-cancelled policy',
  /function isBillingSourceOrderBillable/.test(billing) &&
    !/HUGRAB_CANCELLED_BILLING_CLIENT_NAME\s*=\s*'HUGRAB'/.test(billing),
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
  'PS-396: HUGRAB no longer has a billable-cancelled exception; all cancelled rows get a $0 no-charge line',
  /const cancelledNoCharge =[\s\S]*?isCancelledBillingStatus\(s\.orderStatus\)[\s\S]*?isCancelledBillingStatus\(s\.orderLifecycleStatus\)/.test(billing) &&
    /lineType: 'cancelled'/.test(billing) &&
    !/HUGRAB_CANCELLED_BILLING_CLIENT_NAME/.test(billing),
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
