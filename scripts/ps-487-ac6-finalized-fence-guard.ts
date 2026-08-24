/**
 * PS-487 AC-6 structural guard — pins the finalized-period return fence so a refactor cannot
 * quietly re-open it. It asserts, at the source-structure level (constructs, not line numbers):
 *
 *   1. DELEGATION: billing.ts imports and calls the finalization owner's classifier
 *      (classifyReturnLinesByFinalization) — return finality is not re-derived in billing.ts.
 *   2. LOCK + HALF-OPEN OWNERSHIP: the classifier acquires the per-client advisory lock
 *      (pg_advisory_xact_lock(36421, …)), selects the finalizations FOR UPDATE, and matches by the
 *      half-open contract (start <= date < end).
 *   3. FINALIZED LINES CANNOT REACH THE DIRECT INSERT: billing.ts inserts only the classifier's
 *      openLines, calls the classifier with the SAME transaction handle it deletes/inserts on (so
 *      the classify→insert race is closed), and routes finalized lines to the reconciler carrying
 *      zeroBaselineFinalizationId.
 *   4. ZERO-BASELINE in the PS-449 reconciler: it consumes zeroBaselineFinalizationId, treats the
 *      frozen baseline as $0.00, and fails closed (BILLING_ZERO_BASELINE_FINALIZATION_NOT_LOCKED)
 *      when the finalization is not locked.
 *
 * Behaviour is proven by the AC-6 integration + PG17 concurrency tests; this guard prevents the
 * placement from silently regressing.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const BILLING = readFileSync('src/services/billing.ts', 'utf8');
const POLICY = readFileSync('src/services/billing-finalization-policy.ts', 'utf8');

// Isolate the finalization owner's two relevant functions so a match cannot come from an unrelated
// region of a 1,500-line file.
function region(source: string, startAnchor: string, endAnchor: string, label: string): string {
  const start = source.indexOf(startAnchor);
  assert.notEqual(start, -1, `guard anchor missing: "${startAnchor}" (${label})`);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  assert.notEqual(end, -1, `guard end anchor missing: "${endAnchor}" (${label})`);
  return source.slice(start, end);
}

let checks = 0;
const pin = (cond: boolean, message: string) => { checks += 1; assert.ok(cond, message); };

// ── 1. DELEGATION (billing.ts) ───────────────────────────────────────────────────────────────
pin(/import\s*\{[\s\S]*?\bclassifyReturnLinesByFinalization\b[\s\S]*?\}\s*from\s*'\.\/billing-finalization-policy'/.test(BILLING),
  'billing.ts must import classifyReturnLinesByFinalization from the finalization owner');
pin(BILLING.includes('await classifyReturnLinesByFinalization('),
  'billing.ts must delegate return-line finality to classifyReturnLinesByFinalization (not re-derive it)');

// The classifier call, delete, and insert must share ONE transaction handle so the lock spans
// classification through insertion. Assert the classifier is invoked with the tx handle, and that
// the same block deletes+inserts on tx.
const returnBlock = region(
  BILLING,
  'const plannedReturnLines = [...returnPlan.lines];',
  'const finalizedCandidateTotalsByClient',
  'billing.ts return persistence block',
);
pin(/classifyReturnLinesByFinalization\([\s\S]*?,\s*tx,?\s*\)/.test(returnBlock),
  'the classifier must be called with the transaction handle (tx), so its per-client lock spans the insert');
pin(returnBlock.includes('await tx.delete(billingLineItems)') && returnBlock.includes('await tx\n            .insert(billingLineItems)'),
  'the delete and insert must run on the SAME transaction (tx) as the classifier');

// 3a. The INSERT must iterate the classifier's openLines — never the raw plan or a finalizedOrderIds
//     filter — so a finalized-period line can never reach the direct insert.
pin(/\.insert\(billingLineItems\)[\s\S]*?openLines\.map\(\(line\)/.test(returnBlock),
  'the return-line INSERT must map over the classifier openLines (finalized lines must not reach it)');
pin(!/openReturnLines/.test(returnBlock),
  'the old order-level openReturnLines split must be gone (finality is now period-authoritative)');
// 3b. Finalized lines route to the reconciler carrying the zero-baseline finalization id.
pin(returnBlock.includes('zeroBaselineFinalizationByClientOrder'),
  'finalized-period return lines with no invoiced baseline must be recorded for the reconciler');
pin(/\.\.\.\(zeroBaselineFinalizationId\s*\?\s*\{\s*zeroBaselineFinalizationId\s*\}\s*:\s*\{\}\)/.test(BILLING),
  'the reconciler candidates must spread zeroBaselineFinalizationId for zero-baseline finalized returns');

// ── 2. LOCK + HALF-OPEN OWNERSHIP (billing-finalization-policy.ts) ─────────────────────────────
const classifier = region(
  POLICY,
  'export async function classifyReturnLinesByFinalization',
  'export async function findFrozenReplacementLineTotals',
  'classifyReturnLinesByFinalization',
);
pin(/pg_advisory_xact_lock\(36421,\s*\$\{input\.clientId\}\)/.test(classifier),
  'the classifier must take the per-client finalization advisory lock (36421, clientId)');
pin(/for update/.test(classifier),
  'the classifier must select the overlapping finalizations FOR UPDATE');
pin(classifier.includes('b.start <= at && at < b.end'),
  'the classifier must match by the HALF-OPEN period contract (start <= date < end)');

// ── 4. ZERO-BASELINE in the reconciler (billing-finalization-policy.ts) ────────────────────────
const reconciler = region(
  POLICY,
  'export async function reconcileFinalizedBillingOrderAdjustments',
  'export function billingLineItemIsEditablePredicate',
  'reconcileFinalizedBillingOrderAdjustments',
);
pin(reconciler.includes('zeroBaselineFinalizationId'),
  'the reconciler must consume zeroBaselineFinalizationId');
pin(reconciler.includes("frozenTotal: '0.00'"),
  'the zero-baseline path must treat the frozen baseline as $0.00');
pin(reconciler.includes('BILLING_ZERO_BASELINE_FINALIZATION_NOT_LOCKED'),
  'the reconciler must fail closed when a zero-baseline finalization is not locked');

console.log(`PASS PS-487 AC-6 finalized-fence structural guard — ${checks}/${checks} pins`);
