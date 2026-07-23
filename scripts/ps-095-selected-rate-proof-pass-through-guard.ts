/**
 * PS-095 guard - frontend selected-rate proof pass-through + stale-rate UX.
 *
 * Static/pure only: no browser, DB, provider calls, labels, postage, or
 * marketplace notifications.
 */
import fs from 'node:fs';

const ordersView = fs.readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
// PS-135: the proof helpers moved to the canonical lib; OrdersView delegates to it.
const rateProof = fs.readFileSync('web/src/lib/rate-proof.ts', 'utf8');
// PS-317: buildSelectedRateProofPayload moved to ./orders/best-rate/rate-proof.ts
// (its call sites stay in OrdersView). Re-slice its body from the new owner; the END
// anchor is the next top-level function buildRateQuoteRefForOrder.
const bestRateProof = fs.readFileSync('web/src/components/Views/orders/best-rate/rate-proof.ts', 'utf8');
const rateSyncGuard = fs.readFileSync('scripts/ps-081-rate-sync-guard.ts', 'utf8');
const proofBoundaryGuard = fs.readFileSync('scripts/selected-rate-proof-purchase-boundary-guard.ts', 'utf8');
// PS-317 A4: the deleted FE direct-carrier buy's queue/override proof path now lives
// in the backend create/recover job. Pin its new owners so the relocated proof +
// account binding is verified where it actually runs (not just as FE text).
const labelsService = fs.readFileSync('src/services/labels.ts', 'utf8');
const printQueueService = fs.readFileSync('src/services/print-queue.ts', 'utf8');

let failures = 0;

function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// PS-317: buildSelectedRateProofPayload now lives in best-rate/rate-proof.ts; its body runs
// to the next top-level function buildRateQuoteRefForOrder. (hasAnySavedBestRateForDisplay
// moved to a DIFFERENT file — rate-display-predicates.ts — so it is no longer the END anchor.)
const proofBuilderStart = bestRateProof.indexOf('function buildSelectedRateProofPayload');
const proofBuilderEnd = bestRateProof.indexOf('function buildRateQuoteRefForOrder', proofBuilderStart);
const proofBuilder = proofBuilderStart >= 0 && proofBuilderEnd > proofBuilderStart
  ? bestRateProof.slice(proofBuilderStart, proofBuilderEnd)
  : '';

check(
  // PS-135: extraction lives in the canonical lib (rate-proof.ts); OrdersView delegates to it.
  'frontend extracts only backend-issued proof fingerprints from rate metadata/cache keys',
  rateProof.includes('export function rateProofFingerprint') &&
    rateProof.includes('rate?.requestFingerprint') &&
    rateProof.includes('rate?.rateRequestFingerprint') &&
    rateProof.includes('metadata?.requestFingerprint') &&
    rateProof.includes('raw?.requestFingerprint') &&
    ordersView.includes("from '../../lib/rate-proof'"),
);

check(
  // PS-135: the "omit proof when no backend fingerprint" logic now lives in
  // selectProofFromCandidates (rate-proof.ts); OrdersView's builder delegates to it.
  'frontend clears proof by omitting selectedRateProof when no backend fingerprint exists',
  // TEETH: require the re-sliced buildSelectedRateProofPayload body (from best-rate/rate-proof.ts)
  // to be non-empty so a missing/renamed definition fails LOUD instead of silently passing.
  proofBuilderStart >= 0 && proofBuilder.length > 0 &&
    rateProof.includes('const requestFingerprint = rateProofFingerprint(selectedRate)') &&
    rateProof.includes('if (!selectedRate || !requestFingerprint) return undefined') &&
    proofBuilder.includes('selectProofFromCandidates('),
);

check(
  'frontend passes only selectionRef through label and queue payloads; backend owns exact context/account validation',
  bestRateProof.includes('function buildRateQuoteRefForOrder') &&
    !/selectedRateProof: buildSelectedRateProofPayload/.test(ordersView) &&
    ordersView.includes('function buildQueueSendOrderPayload') &&
    ordersView.includes('...buildRateQuoteRefForOrder(order, bestRate ?? selectedRate, shippingProviderId),') &&
    ordersView.includes('const selection = buildRateQuoteRefForOrder(order, rate, shippingProviderId)') &&
    ordersView.includes('...selection,') &&
    !ordersView.includes('createDirectCarrierLabelThenQueue') &&
    printQueueService.includes('async function processQueueSendOrder') &&
    /const input = \{\s*\r?\n\s*\.\.\.labelInput,\s*\r?\n\s*orderId: order\.orderId,\s*\r?\n\s*orderNumber: order\.orderNumber \?\? labelInput\.orderNumber,\s*\r?\n\s*\};/.test(printQueueService) &&
    printQueueService.includes('resumeLabelV2FromDurableReceipt(input, labelPurchaseScope)') &&
    printQueueService.includes('createLabelV2(input, labelPurchaseScope)') &&
    labelsService.includes('selectionRef: body.selectionRef') &&
    labelsService.includes('assertShippingQuoteContextMatches({') &&
    labelsService.includes('assertShippingQuoteAccountMatches({') &&
    labelsService.includes('directLabelAccountRefFromProviderId(body.shippingProviderId)') &&
    labelsService.includes('createDirectCarrierLabelForOrder(') &&
    proofBoundaryGuard.includes('queue intent carries only the account-filtered opaque selectionRef'),
);

check(
  'stale row rates stay non-final and prompt a bounded retry/rate path instead of being treated as acceptable',
  rateSyncGuard.includes('stale-key entry never shows the rate') &&
    rateSyncGuard.includes('stale-key entry is a bounded spinner') &&
    ordersView.includes('Rate unavailable · Retry'),
);

check(
  'panel rate-affecting changes trigger re-rate instead of frontend accepting stale proof',
  ordersView.includes('void refreshPanelBestRate({ order: panelOrder, dims, weightOz, silent: true })') &&
    ordersView.includes('void refreshPanelBestRate({ order: panelOrder, dims, weightOz, panelForm: nextForm, silent: true })'),
);

check(
  'backend proof rejection is surfaced to the operator as a safe label/create error',
  ordersView.includes("showToast(error instanceof Error ? error.message : 'Label creation failed', 'error')") &&
    ordersView.includes("showLabelPdfPlaceholderMessage(labelPopup, 'Label creation failed'"),
);

check(
  'frontend remains pass-through only and does not locally decide stale selected-rate proof is acceptable',
  // Precise, unambiguous bypass check (the prior `[^\\n]` form was a fragile
  // backslash-vs-newline regex). Intent: the frontend must not force/bypass/skip
  // selected-rate proof, nor locally declare a stale rate acceptable. The PS-104
  // `overridePayload` is a legitimate caller PAYLOAD override, not a proof bypass,
  // so we match force/bypass/skip-proof flags specifically (not the word "override").
  !/selectedRateProof[^\n]{0,80}\b(force|bypass)\b/i.test(ordersView) &&
    !/\bskip(Proof|RateProof|SelectedRate|Validation)\b/i.test(ordersView) &&
    !/stale[^\n]{0,40}\b(acceptable|ignore)\b/i.test(ordersView),
);

if (failures > 0) {
  console.error(`\nFAIL PS-095 selected-rate proof pass-through guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-095 selected-rate proof pass-through guard');
