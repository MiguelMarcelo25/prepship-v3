/**
 * Guard: single-order Print to Queue handles selected-rate proof failures.
 *
 * The backend queue job returns per-order results instead of throwing the
 * label-purchase error. The side-panel Print to Queue path must recognize a
 * retry-eligible failure there, refresh the rate, and avoid surfacing the raw
 * "missing_current_fingerprint" toast forever.
 *
 * PS-191 re-anchor (2026-06-13): detection moved from message-regex
 * (isSelectedRateProofError) to the BACKEND retry verdict
 * (result.retryEligibleOrderIds, fed by retryEligible on queue-send results),
 * and the same-action auto-retry was REMOVED BY POLICY — the old pin
 * "retries queue with refreshed backend proof in the same user action"
 * certified a silent re-purchase at a possibly higher refreshed rate
 * (promptForRetry:false). The refresh now PROMPTS; the operator confirms the
 * buy by clicking Print to Queue again. test:ps-191-retry-eligibility owns
 * the no-auto-repurchase pins; this guard keeps the recognize/refresh/no-raw-
 * toast protections at their new anchors.
 */
import { readFileSync } from 'node:fs';

const source = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');

let failures = 0;
function check(name: string, condition: boolean) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const createOrQueueStart = source.indexOf("async function createOrQueueLabel(mode: 'print' | 'queue' | 'test'");
const createOrQueueEnd = source.indexOf('\n  async function saveSkuDefaults', createOrQueueStart);
const createOrQueue = createOrQueueStart >= 0 && createOrQueueEnd > createOrQueueStart
  ? source.slice(createOrQueueStart, createOrQueueEnd)
  : '';

check('found createOrQueueLabel block', createOrQueue.length > 0);
check(
  'queue failures branch on the backend retry verdict (no message regex)',
  /const queueErrorMessage = result\.skippedErrors\[0\]/.test(createOrQueue) &&
    /result\.retryEligibleOrderIds\.has\(order\.orderId\)/.test(createOrQueue),
);
check(
  'retryable failure refreshes the stale rate instead of showing raw queue error',
  /refreshStaleRateForOrder\(order, 'Print to Queue'\)/.test(createOrQueue),
);
check(
  'PS-191: the refresh PROMPTS — no same-action re-purchase with the refreshed proof',
  // Pin CODE shapes (the explanatory comment legitimately names the old
  // promptForRetry:false behavior while documenting why it is gone).
  !/buildSelectedRateProofPayload\(order, refreshedRate\)/.test(createOrQueue) &&
    !/const retryResult = await sendOrdersToQueueBackend/.test(createOrQueue) &&
    !createOrQueue.includes('{ promptForRetry: false }') &&
    !createOrQueue.includes('promptForRetry?: boolean'),
);
check(
  'raw missing_current_fingerprint is not shown from the queue skipped error path',
  /showToast\(queueErrorMessage \?\? 'Label was not added to the print queue', 'error'\)/.test(createOrQueue),
);

// Direct-carrier queue path must honor the caller's payload override so the
// refreshed selected-rate proof from the retry actually reaches the label
// purchase. Without this, direct-carrier (Walmart Shipping/SHIPP) Print to
// Queue rebuilds the proof from the stale captured order and loops forever on
// "Rate changed or expired" even after a successful re-rate.
const directFnStart = source.indexOf('async function createDirectCarrierLabelThenQueue(');
const directFnEnd = source.indexOf('\n  async function queueExistingLabels', directFnStart);
const directFn = directFnStart >= 0 && directFnEnd > directFnStart
  ? source.slice(directFnStart, directFnEnd)
  : '';

check('found createDirectCarrierLabelThenQueue block', directFn.length > 0);
check(
  'direct-carrier label path accepts a caller payload override',
  /async function createDirectCarrierLabelThenQueue\(\s*order: OrderSummaryDto,\s*overridePayload\?: Record<string, unknown> \| null,/.test(directFn),
);
check(
  'direct-carrier label path prefers the override selectedRateProof and account-binds the fallback proof',
  /const selectedRateProof =\s*toRecord\(overrideRecord\?\.selectedRateProof\)\s*\?\?\s*buildSelectedRateProofPayload\(order, bestRate \?\? selectedRate, shippingProviderId\)/.test(directFn),
);
check(
  'sendOrdersToQueueBackend forwards the per-order override into the direct-carrier label path',
  /createDirectCarrierLabelThenQueue\(\s*order,\s*options\.labelPayloadOverrides\?\.get\(order\.orderId\)/.test(source),
);

if (failures > 0) {
  console.error(`\nFAIL Print to Queue selected-rate proof guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS Print to Queue selected-rate proof guard');
