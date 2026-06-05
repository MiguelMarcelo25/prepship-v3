/**
 * Guard: single-order Print to Queue handles selected-rate proof failures.
 *
 * The backend queue job returns per-order skipped errors instead of throwing the
 * label-purchase error. The side-panel Print to Queue path must recognize the
 * selected-rate-proof error there, refresh the rate, and avoid surfacing the raw
 * "missing_current_fingerprint" toast forever.
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
  'queue skippedErrors are inspected for selected-rate proof failures',
  /const queueErrorMessage = result\.skippedErrors\[0\]/.test(createOrQueue) &&
    /isSelectedRateProofError\(queueErrorMessage\)/.test(createOrQueue),
);
check(
  'proof failure refreshes stale rate instead of showing raw queue error',
  /await refreshStaleRateForOrder\(order, 'Print to Queue'/.test(createOrQueue),
);
check(
  'proof failure retries queue with refreshed backend proof in the same user action',
  /const refreshedRate = await refreshStaleRateForOrder\(order, 'Print to Queue'/.test(createOrQueue) &&
    /buildSelectedRateProofPayload\(order, refreshedRate\)/.test(createOrQueue) &&
    /selectedRateProof: refreshedRateProof/.test(createOrQueue) &&
    /const retryResult = await sendOrdersToQueueBackend/.test(createOrQueue),
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
  'direct-carrier label path prefers the override selectedRateProof before rebuilding from the stale order',
  /overridePayload\?\.selectedRateProof[\s\S]*?\?\?\s*buildSelectedRateProofPayload\(order, bestRate \?\? selectedRate\)/.test(directFn),
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
