/**
 * PS-487 slice 3 guard — the GENERATOR WIRING.
 *
 * The planner decides what a return costs; this guard pins how the generator is allowed
 * to write it. Static/offline: no DB, no network, no regeneration, no production
 * mutation.
 *
 * The three things that would hurt if they silently changed:
 *   1. the flag defaults OFF, so a deploy alone never bills anyone;
 *   2. the write is fenced by billingLineItemIsEditablePredicate(), so a finalized or
 *      invoiced period is never rewritten;
 *   3. the generator does not decide amounts — it delegates to the planner.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}: ${err instanceof Error ? err.message : err}`);
  }
}

const envSrc = readFileSync('src/lib/env.ts', 'utf8');
const billing = readFileSync('src/services/billing.ts', 'utf8');
const schema = readFileSync('src/db/schema/returns.ts', 'utf8');

// ── 1. default OFF ───────────────────────────────────────────────────────────
check('RETURN_BILLING_ENABLED exists and defaults to FALSE', () => {
  assert.match(envSrc, /RETURN_BILLING_ENABLED: booleanFlag\(false\)/);
});

check('the whole return-billing pass sits behind the flag', () => {
  assert.match(billing, /if \(env\.RETURN_BILLING_ENABLED\) \{/);
  // Both the DELETE and the INSERT must live inside the flag block — not merely appear
  // somewhere in the file. Ordering by offset is enough here because the block is the
  // only place either statement exists, and the next check pins that the block closes
  // before the unrelated storage pass begins.
  const gate = billing.indexOf('if (env.RETURN_BILLING_ENABLED) {');
  const del = billing.indexOf('inArray(billingLineItems.lineType, [');
  const insert = billing.indexOf('returnPlan.lines.map((line)');
  assert.ok(gate >= 0, 'the flag block must exist');
  assert.ok(del > gate, 'the return-line DELETE must live inside the flag block');
  assert.ok(insert > gate, 'the return-line INSERT must live inside the flag block');
});

check('the flag block closes before the unrelated storage pass', () => {
  const insert = billing.indexOf('returnPlan.lines.map((line)');
  const storage = billing.indexOf('// One inventory read + one ledger read', insert);
  assert.ok(storage > insert, 'the return pass must not swallow the storage pass');
});

// ── 2. never touch a finalized/invoiced period ───────────────────────────────
check('the return-line delete is fenced by the editable predicate', () => {
  const start = billing.indexOf('inArray(billingLineItems.lineType, [');
  assert.ok(start >= 0, 'the return-line delete must exist');
  const span = billing.slice(start, start + 1_200);
  assert.match(span, /billingLineItemIsEditablePredicate\(\)/,
    'a finalized or invoiced period must never be rewritten by return billing');
  assert.match(span, /billingLineItemScopePredicate\(input\)/,
    'the delete must stay client/store scoped');
});

check('the delete is bounded to the requested range, not the whole table', () => {
  const start = billing.indexOf('inArray(billingLineItems.lineType, [');
  const span = billing.slice(start, start + 1_200);
  assert.match(span, /billingEffectiveDate\} >= \$\{fromIso\}/);
  assert.match(span, /billingEffectiveDate\} < \$\{toIso\}/);
});

// ── 3. the generator delegates, it does not decide ───────────────────────────
check('amounts come from the planner, not from arithmetic in the generator', () => {
  assert.match(billing, /planReturnBillingLines\(\{/);
  // The inserted values must be read off the planned line verbatim.
  assert.match(billing, /unitCost: line\.unitCost/);
  assert.match(billing, /totalCost: line\.totalCost/);
  assert.match(billing, /description: line\.description/);
});

check('the insert is a loud failure on duplicates (no onConflictDoNothing)', () => {
  const start = billing.indexOf('returnPlan.lines.map((line)');
  assert.ok(start >= 0);
  const span = billing.slice(start, start + 1_400);
  assert.doesNotMatch(span, /onConflictDoNothing|onConflictDoUpdate/,
    'a duplicate return line must fail loudly — silently ignoring it hides a double charge');
});

check('return lines carry no shipmentId (they are order-scoped, matching the unique index)', () => {
  const start = billing.indexOf('returnPlan.lines.map((line)');
  const span = billing.slice(start, start + 1_400);
  assert.match(span, /shipmentId: null/,
    'the unique index that dedupes these is the order_id/line_type/description one');
});

// ── 4. the returns schema is a read-only mirror ──────────────────────────────
check('the returns schema maps only columns that exist in production', () => {
  // A Drizzle column absent from the database makes a bare select() 500 the route.
  for (const col of [
    'order_id', 'client_id', 'return_shipment_id', 'status', 'created_at',
    'return_customer_shipping_rate', 'return_reference', 'admin_override',
  ]) {
    assert.ok(schema.includes(col), `expected mapped column: ${col}`);
  }
});

// ── 5. AC-6: a finalized period is never written, only adjusted ──────────────
check('a return on a FINALIZED order is excluded from the insert', () => {
  assert.match(
    billing,
    /const openReturnLines = returnPlan\.lines\.filter\(\(l\) => !finalizedOrderIds\.has\(l\.orderId\)\)/,
    'return lines for finalized orders must not be inserted into the frozen period',
  );
});

check('finalized return amounts are folded into the PS-449 reconciliation candidates', () => {
  assert.match(billing, /finalizedReturnTotalsByClient/);
  // They must reach the SAME candidate map the order lines use, so the owner emits one
  // delta per order rather than a parallel return-specific adjustment.
  const fold = billing.indexOf('for (const [clientId, returnTotals] of finalizedReturnTotalsByClient)');
  const recon = billing.indexOf('reconcileFinalizedBillingOrderAdjustments({');
  assert.ok(fold >= 0, 'finalized return totals must be folded in');
  assert.ok(recon > fold, 'the fold must happen BEFORE reconciliation runs');
});

check('AC-6 builds NO second adjustment path — it delegates to the canonical owner', () => {
  // The credit-note/adjustment writer is billing-finalization-policy's. A return-specific
  // insert into billing_credit_notes here would be a duplicate source of truth.
  assert.doesNotMatch(
    billing,
    /insert\(billingCreditNotes\)/,
    'adjustments belong to createBillingCreditNote / reconcileFinalizedBillingOrderAdjustments',
  );
  assert.match(billing, /reconcileFinalizedBillingOrderAdjustments\(\{/);
});

check('PrepShip only READS returns — the generator never writes that table', () => {
  assert.doesNotMatch(
    billing,
    /\.(insert|update|delete)\(returns\)/,
    'the returns lifecycle is owned by the Client Portal; PrepShip bills them, it does not mutate them',
  );
});

if (failures > 0) {
  console.error(`\nFAIL PS-487 return billing wiring guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-487 return billing wiring guard');
