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
 *
 * PS-317 A4 re-anchor (2026-06-24): the FE direct-carrier label BUY
 * (createDirectCarrierLabelThenQueue -> apiClient.createLabel) was DELETED. The
 * frontend now buys nothing; every queue order routes to the backend
 * create/recover job. The direct-carrier override / selected-rate proof /
 * account-binding this guard used to pin on that FE function were RELOCATED to
 * the intent payload (buildQueueSendOrderPayload) and the backend owners
 * (src/services/labels.ts assertLabelPurchaseRateSelection + the direct-carrier
 * purchase; src/services/print-queue.ts createLabelV2). The block below now
 * asserts the FE buy is gone AND that each protection is present at its new
 * owner — so no money-path coverage was lost.
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

// ── PS-317 A4 re-anchor (2026-06-24) ─────────────────────────────────────────
// The FRONTEND direct-carrier label BUY (createDirectCarrierLabelThenQueue,
// which called apiClient.createLabel = POST /labels) was DELETED. The frontend
// now buys NOTHING: every queue order routes to the backend create/recover job,
// which owns the purchase for BOTH ShipStation and direct carriers (Walmart
// Shipping / SHIPP / direct UPS / EasyPost).
//
// The three protections the deleted FE buy used to carry did NOT disappear —
// they moved to where label truth lives:
//   (a) the caller payload OVERRIDE  -> the intent payload builder
//       buildQueueSendOrderPayload (payload.label = labelPayloadOverrides ?? {…}).
//   (b) the selectedRateProof + ACCOUNT BINDING (shippingProviderId) -> carried
//       in that same intent payload AND re-enforced server-side by
//       assertLabelPurchaseRateSelection in src/services/labels.ts, which runs
//       BEFORE both the direct and ShipStation provider calls.
//   (c) the actual direct-carrier purchase -> src/services/labels.ts
//       directLabelAccountRefFromProviderId -> createDirectCarrierLabelForOrder,
//       reached by src/services/print-queue.ts processQueueSendOrder via
//       createLabelV2({ ...order.label }).
// The checks below assert (1) the FE buy is GONE (anti-regression) and (2) each
// relocated protection is present at its new owner — so no money-path coverage
// is lost.

// ── (1) Anti-regression: the FE direct-carrier buy must NOT come back. ────────
check(
  'FE direct-carrier buy is GONE — createDirectCarrierLabelThenQueue does not exist',
  !source.includes('createDirectCarrierLabelThenQueue'),
);
// The only surviving apiClient.createLabel callsites are the Create+Print path
// (mode !== 'queue'); the queue/Print-to-Queue path must never buy from the FE.
// sendOrdersToQueueBackend is the single queue entry point and must contain no
// FE purchase — it only assembles intent payloads and calls the backend job.
const sendToQueueStart = source.indexOf('async function sendOrdersToQueueBackend(');
const sendToQueueEnd = source.indexOf('\n  async function ', sendToQueueStart + 1);
const sendToQueue = sendToQueueStart >= 0 && sendToQueueEnd > sendToQueueStart
  ? source.slice(sendToQueueStart, sendToQueueEnd)
  : '';
check('found sendOrdersToQueueBackend block', sendToQueue.length > 0);
check(
  'the queue path buys NOTHING from the FE (no apiClient.createLabel inside sendOrdersToQueueBackend)',
  !/apiClient\.createLabel\(/.test(sendToQueue),
);

// ── (2a) Relocated OVERRIDE: the per-order caller payload override now lives in
// the intent payload builder (was createDirectCarrierLabelThenQueue's
// overridePayload param). buildQueueSendOrderPayload merges it into payload.label.
const buildPayloadStart = source.indexOf('function buildQueueSendOrderPayload(');
const buildPayloadEnd = source.indexOf('\n  async function sendOrdersToQueueBackend(', buildPayloadStart);
const buildPayload = buildPayloadStart >= 0 && buildPayloadEnd > buildPayloadStart
  ? source.slice(buildPayloadStart, buildPayloadEnd)
  : '';
check('found buildQueueSendOrderPayload block', buildPayload.length > 0);
check(
  'intent payload honors the per-order caller override (relocated from the deleted FE buy)',
  /buildQueueSendOrderPayload\(order: OrderSummaryDto, options: \{[^}]*labelPayloadOverrides\?: Map<number, Record<string, unknown>>/.test(buildPayload) &&
    /payload\.label = options\.labelPayloadOverrides\?\.get\(order\.orderId\) \?\?/.test(buildPayload),
);
check(
  'intent payload carries the account-filtered opaque selectionRef',
  /\.\.\.buildRateQuoteRefForOrder\(order, bestRate \?\? selectedRate, shippingProviderId\)/.test(buildPayload) &&
    !/selectedRateProof: buildSelectedRateProofPayload/.test(buildPayload) &&
    /shippingProviderId: shippingProviderId \?\? undefined/.test(buildPayload),
);

// ── (2b) Relocated BACKEND ownership: the proof gate + account binding and the
// direct-carrier purchase are now enforced server-side. Pin them so deleting the
// FE buy can never leave the queue path buying without the proof/binding gate.
const printQueueSource = readFileSync('src/services/print-queue.ts', 'utf8');
check(
  'backend queue worker buys via createLabelV2 from the intent payload (order.label)',
  // Repointed 2026-08-04. This demanded the spread be INLINE in the call --
  // createLabelV2({ ...labelInput, -- and broke when the input object was
  // hoisted into a variable so resumeLabelV2FromDurableReceipt could share it.
  // Behaviour never changed: `const input = { ...labelInput, ... }` is still what
  // createLabelV2 receives. The property worth pinning is that the intent payload
  // reaches the purchase, not the syntax it travels in, so match the chain rather
  // than the call shape. Found by the ungated-guard sweep; this guard had rotted
  // silently because nothing ran it.
  /const labelInput = order\.label;[\s\S]*?\{\s*\.\.\.labelInput,[\s\S]*?createLabelV2\(/.test(printQueueSource),
);
const labelsSource = readFileSync('src/services/labels.ts', 'utf8');
check(
  'backend resolves selectionRef and revalidates current account identity before purchase',
  /assertLabelPurchaseRateSelection\(\{/.test(labelsSource) &&
    /selectionRef: body\.selectionRef,/.test(labelsSource) &&
    /assertShippingQuoteAccountMatches\(\{/.test(labelsSource) &&
    /authorized: purchaseRateProof\.accountAuthorization/.test(labelsSource),
);
check(
  'backend owns the direct-carrier purchase (relocated from the deleted FE buy)',
  /directLabelAccountRefFromProviderId\(body\.shippingProviderId\)/.test(labelsSource) &&
    /createDirectCarrierLabelForOrder\(\{/.test(labelsSource),
);

if (failures > 0) {
  console.error(`\nFAIL Print to Queue selected-rate proof guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS Print to Queue selected-rate proof guard');
