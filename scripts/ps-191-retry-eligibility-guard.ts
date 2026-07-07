/**
 * PS-191 guard — structured retry-eligibility DTO; the FE must never
 * auto-repurchase postage.
 *
 * Pre-PS-191, Print-to-Queue regex-parsed postage error MESSAGES to decide a
 * retry was warranted, then silently re-rated and RE-FIRED the purchase at the
 * refreshed (possibly higher) price with promptForRetry:false. Now:
 *  - retry eligibility is a BACKEND fact (classifyLabelPurchaseRetry —
 *    structural, from the proof-error code + details.reason, never message
 *    text), returned as retryEligible/retryReason on purchase-failure
 *    responses (labels route + queue-send per-order results).
 *  - the FE branches on the structured fields only, and a retryable failure
 *    PROMPTS the operator to review the refreshed rate and click again —
 *    nothing auto-buys.
 *
 * Layer 1: behavioral matrix on the pure classifier (offline).
 * Layer 2: source pins so the regex/auto-buy cannot quietly return.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { classifyLabelPurchaseRetry } from '../src/services/shipping-workflow/rate-fingerprint';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

// ── 1. Classifier matrix ────────────────────────────────────────────────────
const proofErr = (reason: string, code = 'SELECTED_RATE_PROOF_INVALID') => ({
  code,
  name: 'SelectedRateProofError',
  message: `irrelevant — the classifier must never read this: ${reason}`,
  details: { ok: false, reason },
});

// Re-rate-fixable proof reasons → eligible.
for (const reason of [
  'missing_selected_rate',
  'missing_current_fingerprint',
  'missing_fingerprint',
  'fingerprint_mismatch',
  'not_in_current_eligible_rates',
  'snapshot_not_final',
]) {
  assert.deepEqual(
    classifyLabelPurchaseRetry(proofErr(reason)),
    { retryEligible: true, retryReason: reason },
    `${reason} must be retry-eligible (a rate refresh fixes it)`,
  );
}

// Account mismatch: refreshing the SAME selection just loops — NOT eligible,
// but the reason is still surfaced. Covers all three PS-204 code spellings.
assert.deepEqual(
  classifyLabelPurchaseRetry(proofErr('purchase_account_mismatch')),
  { retryEligible: false, retryReason: 'purchase_account_mismatch' },
);
assert.deepEqual(
  classifyLabelPurchaseRetry(proofErr('purchase_account_mismatch', 'SELECTED_RATE_ACCOUNT_MISMATCH')),
  { retryEligible: false, retryReason: 'purchase_account_mismatch' },
);
assert.deepEqual(
  classifyLabelPurchaseRetry(proofErr('purchase_account_mismatch', 'DIRECT_CARRIER_ON_SHIPSTATION_PATH')),
  { retryEligible: false, retryReason: 'purchase_account_mismatch' },
);

// Non-proof errors → {false, null}. The MESSAGE containing reason-code words
// must not matter (structural classification only).
assert.deepEqual(
  classifyLabelPurchaseRetry(new Error('fingerprint_mismatch happened — rate proof is required before label purchase')),
  { retryEligible: false, retryReason: null },
  'message text must NEVER drive eligibility',
);
assert.deepEqual(classifyLabelPurchaseRetry(new Error('Timed out while sending order 1 to queue')), {
  retryEligible: false,
  retryReason: null,
});
assert.deepEqual(classifyLabelPurchaseRetry({ code: 'LABEL_EXISTS', details: { reason: 'fingerprint_mismatch' } }), {
  retryEligible: false,
  retryReason: null,
  // LABEL_EXISTS is not a proof error — its details must be ignored.
});
assert.deepEqual(classifyLabelPurchaseRetry(null), { retryEligible: false, retryReason: null });
assert.deepEqual(classifyLabelPurchaseRetry(undefined), { retryEligible: false, retryReason: null });
assert.deepEqual(classifyLabelPurchaseRetry('string error'), { retryEligible: false, retryReason: null });

// Proof error with a garbage/unknown reason → not eligible, reason surfaced
// as null (never guess).
assert.deepEqual(classifyLabelPurchaseRetry({ code: 'SELECTED_RATE_PROOF_INVALID', details: { reason: 42 } }), {
  retryEligible: false,
  retryReason: null,
});

// ── 2. Source pins ──────────────────────────────────────────────────────────
const fingerprint = read('src/services/shipping-workflow/rate-fingerprint.ts');
const labelsRoute = read('src/routes/labels.ts');
const printQueueSvc = read('src/services/print-queue.ts');
const apiTs = read('web/src/lib/api.ts');
const ordersView = read('web/src/components/Views/OrdersView.tsx');
const pkg = read('package.json');

// Canonical owner exists and is structural (no message parsing inside it).
assert.ok(fingerprint.includes('export function classifyLabelPurchaseRetry'),
  'classifyLabelPurchaseRetry must live with the proof-error owner');
const classifierBody = fingerprint.slice(
  fingerprint.indexOf('export function classifyLabelPurchaseRetry'),
  fingerprint.indexOf('export function assertPurchaseAccountMatchesProof'),
);
assert.ok(!/\.message/.test(classifierBody) && !/\.test\(/.test(classifierBody),
  'the classifier must never read or regex the error message');

// Labels route returns the DTO on proof-failure responses (single-order path).
assert.ok(labelsRoute.includes('classifyLabelPurchaseRetry'),
  'labels route must classify purchase failures');
assert.ok(labelsRoute.includes('retryEligible: retry.retryEligible') &&
  labelsRoute.includes('retryReason: retry.retryReason'),
  'purchase-failure responses must carry retryEligible/retryReason');

// Queue-send job carries the DTO per failed order (batch path).
assert.ok(printQueueSvc.includes('classifyLabelPurchaseRetry'),
  'queue-send job must classify per-order purchase failures');
assert.ok(/retryEligible\?: boolean/.test(printQueueSvc),
  'QueueSendJobResult/snapshot must type the retry fields');

// FE api layer surfaces the structured fields on thrown errors.
assert.ok(apiTs.includes('retryEligible') && apiTs.includes('retryReason'),
  'ApiRequestError must carry retryEligible/retryReason from the body');

// FE: the postage-error regexes are GONE from web/src (acceptance #1).
for (const [file, text] of [
  ['OrdersView.tsx', ordersView],
  ['api.ts', apiTs],
] as const) {
  assert.ok(!/rate proof is required before label purchase\/i/.test(text),
    `${file} must not regex postage error messages`);
  assert.ok(!/missing_current_fingerprint\|/.test(text),
    `${file} must not regex proof reason codes out of messages`);
}
assert.ok(!ordersView.includes('isSelectedRateProofError'),
  'the regex-based proof-error detector must stay deleted');
assert.ok(ordersView.includes('isRetryEligibleRateFailure'),
  'the structural detector must be what the FE branches on');

// FE: no auto-repurchase. promptForRetry plumbing is deleted entirely
// (option-shape pins; the explanatory comment "promptForRetry:false" without
// a space is deliberately not matched), and the queue path no longer re-fires
// the purchase after a refresh.
assert.ok(!ordersView.includes('promptForRetry?: boolean') &&
  !ordersView.includes('{ promptForRetry: false }'),
  'promptForRetry auto-continue plumbing must stay deleted');
assert.ok(!ordersView.includes('retryPayload') && !ordersView.includes('retryResult'),
  'the queue path must not rebuild + re-send a purchase payload after refresh');
assert.ok(ordersView.includes('retryEligibleOrderIds'),
  'queue failures must branch on the backend retry verdict');
assert.ok(/retryEligibleOrderIds\.has\(order\.orderId\)[\s\S]{0,400}refreshStaleRateForOrder\(order, 'Print to Queue'\)/.test(ordersView),
  'a retryable queue failure must refresh + PROMPT (review and click again)');
// The refresh helper always prompts — no continue-mode message variant.
assert.ok(ordersView.includes('review it and click ${nextActionLabel} again') &&
  !ordersView.includes('continuing ${nextActionLabel}'),
  'refreshStaleRateForOrder must always prompt, never continue a purchase');

// npm wiring.
assert.ok(pkg.includes('"test:ps-191-retry-eligibility"'),
  'guard must be wired into package.json');

console.log('PASS ps-191 retry-eligibility guard (classifier matrix + source pins)');
