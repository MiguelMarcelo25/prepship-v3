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
  'billing result reports the lifecycle-filtered row count with no HUGRAB branch',
  // Repointed 2026-08-05. This pinned the literal copy "No billable shipped or cancelled
  // orders found for this range." That sentence no longer exists anywhere in src/ -- the
  // separate empty-state message was folded into the single result message, which now
  // reports `${billableRows.length} editable shipments/orders` and so covers the empty
  // case by reporting zero. Pinning UI copy was always the weakest assertion in this
  // file; every other check here proves the actual property (cancelled rows are billing
  // source rows for EVERY client, not HUGRAB-only) structurally.
  //
  // Replace the copy pin with the property it was standing in for: the count reported
  // comes from the lifecycle-filtered billable set, and no client-name branch decides it.
  /message: `Generated \$\{generated\} line items from \$\{billableRows\.length\}/.test(billing) &&
    /const billableRows = allBillableRows\.filter\(/.test(billing) &&
    // Scoped to the CANCELLED-billing exception by NAME, not by proximity.
    //
    // A blanket !/HUGRAB/ is wrong -- HUGRAB still appears legitimately for
    // HUGRAB_SHIPPING_RATE_OVERRIDE_*, the PS-220 house shipping-rate override, which
    // has nothing to do with which orders are billable.
    //
    // A "cancelled near HUGRAB" proximity check is also wrong, and instructively so: it
    // matches the COMMENT documenting this very fix ("cancelled orders are billing
    // SOURCE rows for EVERY client (was shipped + HUGRAB...)"), and stripping JS
    // comments does not help because the surviving copy is a `--` SQL comment inside a
    // template literal. A check that fires on the prose explaining a fix will keep
    // firing for as long as the explanation is there, so it is not worth having: the
    // five structural checks above already prove there is no cancelled/HUGRAB branch.
    !/HUGRAB_CANCELLED/.test(billing),
);

if (failures > 0) {
  console.error(`\nFAIL HUGRAB cancelled billing guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS HUGRAB cancelled billing guard');
