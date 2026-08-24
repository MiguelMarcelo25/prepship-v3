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
  const insert = billing.indexOf('openLines.map((line)');
  assert.ok(gate >= 0, 'the flag block must exist');
  assert.ok(del > gate, 'the return-line DELETE must live inside the flag block');
  assert.ok(insert > gate, 'the return-line INSERT must live inside the flag block');
});

check('the flag block closes before the unrelated storage pass', () => {
  const insert = billing.indexOf('openLines.map((line)');
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
  const start = billing.indexOf('openLines.map((line)');
  assert.ok(start >= 0);
  const span = billing.slice(start, start + 1_400);
  assert.doesNotMatch(span, /onConflictDoNothing|onConflictDoUpdate/,
    'a duplicate return line must fail loudly — silently ignoring it hides a double charge');
});

check('return lines carry no shipmentId (they are order-scoped, matching the unique index)', () => {
  const start = billing.indexOf('openLines.map((line)');
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

// ── 5. AC-6: a finalized PERIOD is never written, only adjusted ──────────────
check('a return in a FINALIZED period is excluded from the insert (period-authoritative)', () => {
  // Finality is a property of billing_finalizations, resolved by the finalization owner's
  // classifier — NOT the order-level finalizedOrderIds (which missed an order with no invoiced
  // baseline). Only the classifier openLines reach the direct insert; finalized-period lines route
  // to the reconciler.
  assert.match(billing, /await classifyReturnLinesByFinalization\(/,
    'return finality must be classified by the finalization owner, not re-derived here');
  assert.match(billing, /\.insert\(billingLineItems\)[\s\S]{0,200}?openLines\.map\(\(line\)/,
    'only the classifier openLines may be inserted directly into a period');
  assert.doesNotMatch(billing, /const openReturnLines = returnPlan\.lines\.filter/,
    'the old order-level finalizedOrderIds split must be gone (it did not fence the period)');
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

// AC-3/AC-5 — the corrected date must reach the planner AND the row selector.
//
// The pure planner guards all passed while this was broken, because they build
// planner inputs by hand. Only the generator can prove the column is actually
// selected, passed, and used for range admission.
check('the generator SELECTS the corrected billing date', () => {
  assert.match(
    billing,
    /billingDateOverride: returns\.billingDateOverride/,
    'returns.billingDateOverride must be in the generator select',
  );
});

check('the corrected date is PASSED to the planner', () => {
  assert.match(
    billing,
    /billingDateOverride: r\.billingDateOverride/,
    'the planner input mapping must carry billingDateOverride',
  );
});

check('range admission uses the effective day, not created_at alone', () => {
  // Selecting by created_at meant a correction never moved a return between
  // periods: the corrected month did not pick it up and the original still did.
  // Must mirror resolveReturnBillingEventDate = coalesce(corrected, created).
  assert.match(
    billing,
    /coalesce\(\$\{returns\.billingDateOverride\}, \$\{returns\.createdAt\}\) >= \$\{fromIso\}/,
    'lower bound must coalesce the override over created_at',
  );
  assert.match(
    billing,
    /coalesce\(\$\{returns\.billingDateOverride\}, \$\{returns\.createdAt\}\) < \$\{toIso\}/,
    'upper bound must coalesce the override over created_at',
  );
  assert.doesNotMatch(
    billing,
    /sql`\$\{returns\.createdAt\} >= \$\{fromIso\}/,
    'the bare created_at lower bound must be gone, not merely supplemented',
  );
});

check('the forward-only cutover still reads created_at, not the override', () => {
  // Widening admission must not let a correction drag a pre-cutover return into
  // scope. The cutover is a policy date about when the return really happened.
  const contract = readFileSync('src/services/billing-return-event-contract.ts', 'utf8');
  const fn = contract.slice(
    contract.indexOf('export function isReturnWithinBillingCutover'),
    contract.indexOf('export type ReturnBillingEventKind'),
  );
  assert.ok(fn.length > 0, 'cutover function must exist');
  assert.match(fn, /toIsoDay\(input\.createdAt\)/);
  assert.doesNotMatch(fn, /correctedDate|billingDateOverride/);
});

// PS-488 M2 — relational return identity on every return billing line.
check('the planner emits returnId on every return line', () => {
  const planner = readFileSync('src/services/billing-return-line-planner.ts', 'utf8');
  // Required, not optional: a line that cannot name its return is the AC-7 gap.
  assert.match(planner, /^\s*returnId: number;$/m, 'ReturnBillingLinePlan.returnId must be required');
  // Count INSIDE each lines.push block. `returnId: row.id` also appears in skip
  // pushes and helper calls, so a file-wide occurrence count proves nothing.
  const blocks: string[] = [];
  let from = planner.indexOf('lines.push({');
  while (from !== -1) {
    const end = planner.indexOf('});', from);
    blocks.push(planner.slice(from, end === -1 ? planner.length : end));
    from = planner.indexOf('lines.push({', from + 1);
  }
  assert.ok(blocks.length > 0, 'planner must emit lines');
  // Anchor on the push's OWN indentation (6 spaces). returnLineDescription({ ...
  // returnId: row.id ... }) is nested inside the same block at 8 spaces, so a loose
  // match stayed green when the top-level field was deleted — caught by mutation.
  blocks.forEach((block, i) => {
    assert.match(
      block,
      /^ {6}returnId: row\.id,$/m,
      `lines.push #${i + 1} must carry returnId as its own field, not only inside a nested call`,
    );
  });
});

check('the generator WRITES returnId on the return insert', () => {
  assert.match(
    billing,
    /returnId: line\.returnId/,
    'the return billing insert must persist the relational return id',
  );
});

check('the return insert is the ONLY writer of return line types', () => {
  // M2 is only trustworthy if nothing else inserts return lines without an id. CP reads
  // these rows but never writes them; the other two inserts here are outbound and
  // storage. If a third writer appears, it must carry returnId too.
  const inserts = billing.match(/\.insert\(billingLineItems\)/g) ?? [];
  assert.equal(inserts.length, 3, `expected 3 billingLineItems inserts, found ${inserts.length}`);
  assert.match(billing, /lineType: 'storage'/, 'storage insert still identified');
});

// ── PS-488 M2 — canonical write vocabulary and writer boundary ────────────────
// Four assertions closing gaps found by an adversarial audit of this guard. Each
// targets a mutation that previously left it green.

check('M2: ReturnBillingLinePlan.returnId is required — anchored to the right type', () => {
  // The existing assertion above uses a file-wide /^\s*returnId: number;$/m.
  // ReturnBillingSkip declares the same field, so it satisfies that regex on its own:
  // making ReturnBillingLinePlan.returnId OPTIONAL left the guard green. Anchor to
  // the declaring block so the decoy cannot answer for it.
  const planner = readFileSync('src/services/billing-return-line-planner.ts', 'utf8');
  const start = planner.indexOf('export type ReturnBillingLinePlan = {');
  assert.notEqual(start, -1, 'ReturnBillingLinePlan must exist');
  const block = planner.slice(start, planner.indexOf('};', start));
  assert.match(block, /^\s*returnId: number;$/m, 'ReturnBillingLinePlan.returnId must be required');
  assert.doesNotMatch(block, /^\s*returnId\?: number;$/m, 'returnId must not become optional');
});

check('M2: the canonical write vocabulary is owned by the contract', () => {
  const contract = readFileSync('src/services/billing-return-event-contract.ts', 'utf8');
  assert.match(contract, /CANONICAL_RETURN_WRITE_LINE_TYPES/, 'the owner must export the write set');
  assert.match(contract, /LEGACY_RETURN_READ_ONLY_LINE_TYPES/, 'the owner must export the frozen read set');
  assert.match(contract, /RETURN_SHIPPING_LINE_TYPE = 'return_postage'/);
  assert.match(contract, /RETURN_PROCESSING_LINE_TYPE = 'return_processing_fee'/);
});

check('M2: no writer emits a frozen legacy alias as a NEW write type', () => {
  // An alias becoming a write type is how a second policy owner is born.
  for (const file of ['src/services/billing.ts', 'src/services/billing-return-line-planner.ts']) {
    const executable = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');
    for (const legacy of ['return_label', 'return_processing']) {
      assert.doesNotMatch(
        executable,
        new RegExp(`lineType:\\s*'${legacy}'`),
        `${file} must never write the frozen legacy type '${legacy}'`,
      );
    }
  }
});

check('M2: the return insert carries returnId and lets duplicates abort', () => {
  const billing = readFileSync('src/services/billing.ts', 'utf8');
  const start = billing.indexOf('openLines.map');
  assert.notEqual(start, -1, 'the return insert must exist');
  const block = billing.slice(start, start + 1200);
  assert.match(block, /returnId: line\.returnId,/, 'every return row must carry its relational identity');
  // No conflict swallowing on this insert: a duplicate (return_id, line_type) must
  // abort loudly against 0092's partial unique index, never be silently ignored.
  assert.doesNotMatch(block, /onConflictDoNothing/, 'a duplicate return charge must not be ignored');
});

if (failures > 0) {
  console.error(`\nFAIL PS-487 return billing wiring guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-487 return billing wiring guard');
