/**
 * PS-069 Guard: Billing Summary/Details panel consistency (pure logic, no DB).
 *
 * Locks the rule that the Line Items panel must never render the normal
 * "No line items found" empty state when the Summary row claims billed orders,
 * and that a real /billing/details API error always surfaces (never hidden as
 * empty). Exercises the ACTUAL classifier used by BillingView.
 *
 *   npx tsx scripts/ps-069-billing-detail-consistency-guard.ts
 *
 * Exits non-zero on any failure. Read-only: touches no DB, mutates nothing.
 */
import { classifyBillingDetailPanel } from '../web/src/components/Views/billing-parity';

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  if (!Object.is(got, want)) {
    failures += 1;
    console.error(`FAIL ${name}: got ${String(got)}, want ${String(want)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// loading always wins.
check(
  'loading wins',
  classifyBillingDetailPanel({ loading: true, hasError: true, rowCount: 0, summaryOrders: 158, summaryTotal: 2007.89 }),
  'loading',
);

// A details API error must surface even when Summary claims orders — this is the
// PS-069 bug: a failed fetch was being shown as a normal empty table.
check(
  'error beats empty even when Summary claims 158 orders',
  classifyBillingDetailPanel({ loading: false, hasError: true, rowCount: 0, summaryOrders: 158, summaryTotal: 2007.89 }),
  'error',
);

// The reported HUGRAB case: Summary nonzero, details empty -> MISMATCH warning,
// NOT a normal empty state.
check(
  'HUGRAB: 158 orders summary + 0 detail rows => mismatch',
  classifyBillingDetailPanel({ loading: false, hasError: false, rowCount: 0, summaryOrders: 158, summaryTotal: 2007.89 }),
  'mismatch',
);

// Totals claim billing even if orderCount somehow read 0 -> still a mismatch.
check(
  'nonzero totals + 0 orders + 0 rows => mismatch',
  classifyBillingDetailPanel({ loading: false, hasError: false, rowCount: 0, summaryOrders: 0, summaryTotal: 176.96 }),
  'mismatch',
);

// Genuinely empty: Summary also zero -> normal empty state is correct.
check(
  'empty summary + 0 rows => empty (legit)',
  classifyBillingDetailPanel({ loading: false, hasError: false, rowCount: 0, summaryOrders: 0, summaryTotal: 0 }),
  'empty',
);

// Happy path: details returned rows.
check(
  'rows present => rows',
  classifyBillingDetailPanel({ loading: false, hasError: false, rowCount: 673, summaryOrders: 190, summaryTotal: 2433.73 }),
  'rows',
);

// Rows present even if Summary momentarily shows 0 (cache lag) -> still rows.
check(
  'rows present beats zero-summary',
  classifyBillingDetailPanel({ loading: false, hasError: false, rowCount: 5, summaryOrders: 0, summaryTotal: 0 }),
  'rows',
);

if (failures > 0) {
  console.error(`\nFAIL PS-069 billing detail consistency guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-069 billing detail consistency guard');
