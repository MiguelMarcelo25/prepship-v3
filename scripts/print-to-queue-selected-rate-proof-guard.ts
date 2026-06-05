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

if (failures > 0) {
  console.error(`\nFAIL Print to Queue selected-rate proof guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS Print to Queue selected-rate proof guard');
