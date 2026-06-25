import { readFileSync } from 'node:fs';

// PS-312 S5 — combined-shipment BILL-ONCE billing-integration safety guard.
//
// A bundle ships under ONE label, so shipping + box are billed ONCE on the primary; each child is
// suppressed and shown as a $0 "Included — bundled with #<primary>" line. This guard pins the SAFETY
// SHAPE of the generateLineItems integration so a refactor can't make it bill twice or inflate totals:
//   • behind the default-OFF BUNDLE_BILL_ONCE flag (OFF -> the map is never loaded -> byte-identical),
//   • delegates the per-order treatment to the pure decideBundleBillingTreatment policy (no re-derive),
//   • a child emits exactly ONE $0 shipping "Included" line (never inflates the total),
//   • a child's box (package_cost) line is suppressed (billed once on the primary).
// It is keyed per ORDER (no shared-shipment coupling) and never UPDATEs shipped orders/shipments.

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const env = readFileSync('src/lib/env.ts', 'utf8');
const billing = readFileSync('src/services/billing.ts', 'utf8');

// (1) the flag exists and is default-OFF (OFF => byte-identical)
check(
  'BUNDLE_BILL_ONCE is a default-OFF booleanFlag in src/lib/env.ts',
  /BUNDLE_BILL_ONCE:\s*booleanFlag\(false\)/.test(env),
);

// (2) the bundle map is loaded ONLY when the flag is ON (OFF -> never queried -> byte-identical)
check(
  'generateLineItems loads the bundle map only when env.BUNDLE_BILL_ONCE (empty Map otherwise)',
  /env\.BUNDLE_BILL_ONCE\s*[\r\n\s]*\?\s*await getBundlesForOrders\(orderIdsInScope\)\s*[\r\n\s]*:\s*new Map\(\)/.test(billing),
);

// (3) the per-order treatment is delegated to the pure policy (the rule is NOT re-derived in billing)
check(
  'billing delegates the per-order treatment to decideBundleBillingTreatment',
  /const bundleTreatment = decideBundleBillingTreatment\(/.test(billing),
);

// (4) a bundle child emits exactly ONE $0 "Included" shipping line (policy note + totalCost 0.00 ->
//     never inflates the invoice total; the unique (order_id, line_type, description) key holds)
check(
  'a bundle child emits a $0 shipping "Included" line (never inflates the total)',
  /lineType: 'shipping',[\s\S]{0,120}description: bundleTreatment\.note,[\s\S]{0,160}totalCost: '0\.00'/.test(billing),
);

// (5) a bundle child's box (package_cost) line is suppressed — the included branch sits BEFORE the
//     package_cost emission so the child never gets a second box charge.
check(
  "a bundle child suppresses its box (package_cost) line",
  /if \(bundleTreatment\.kind === 'included-in-bundle'\) \{[\s\S]{0,200}\} else if \(packageCostDecision\.kind === 'line'\)/.test(billing),
);

// (6) lockdown-safe: bill-once never UPDATEs shipped orders/shipments — it only emits derived
//     billing_line_items (the suppression pushes $0 LineRows; no .update(orders)/.update(shipments)).
check(
  'the bill-once integration adds no shipped-data UPDATE (derived billing_line_items only)',
  !/bundleTreatment[\s\S]{0,400}\.update\((orders|shipments)\)/.test(billing),
);

if (failures > 0) {
  console.error(`\nFAIL PS-312 bundle bill-once guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-312 bundle bill-once guard');
