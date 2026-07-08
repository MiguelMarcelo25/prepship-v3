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
  'frontend passes selectedRateProof through the single, batch, and backend-queue-intent payload paths; the deleted FE direct-carrier buy is GONE and its proof/binding is now backend-owned',
  // PS-317 A4 (2026-06-24) re-anchor. The FRONTEND direct-carrier label BUY —
  // createDirectCarrierLabelThenQueue, which assembled its OWN
  //   `const selectedRateProof = toRecord(overrideRecord?.selectedRateProof) ??
  //    buildSelectedRateProofPayload(order, ...)`
  // override-wrapper and then called apiClient.createLabel (POST /labels) for direct
  // carriers — was DELETED from OrdersView. The frontend now buys NOTHING for the
  // queue path; every queue order routes to the backend create/recover job. So the
  // old "queue/override" FE-buy path is converted to an ABSENCE assertion, and the
  // proof + account binding it used to carry is RE-POINTED to its real owners:
  //   - the INTENT payload buildQueueSendOrderPayload (which print-queue.ts /
  //     createLabelV2 consume), and
  //   - the backend purchase gate assertLabelPurchaseRateSelection in
  //     src/services/labels.ts (reached for the queue path via
  //     src/services/print-queue.ts processQueueSendOrder → createLabelV2).
  //
  // The proof still flows on the THREE surviving payload shapes:
  //   (a) 2 INLINE property sites `selectedRateProof: buildSelectedRateProofPayload(order, ...)`
  //       — the panel-live single-create payload AND the queue-send INTENT payload.
  //   (b) the BATCH-PRINT override payload `const selectedRateProof = buildSelectedRateProofPayload(order, rate)`
  //       — buildBatchPrintOverridePayload builds proof from the SAME fresh strict-recalc rate;
  //       the PS-204 account-binding 3rd arg was DROPPED because proof, shippingProviderId, and
  //       buildRateQuoteRefForOrder all derive from that one fresh rate (binding coherent by
  //       construction — see the PS-204 note above the builder in OrdersView).
  //
  // (a) census of the two inline account-bound proof property sites (panel + queue intent).
  (ordersView.match(/selectedRateProof: buildSelectedRateProofPayload\(order/g)?.length ?? 0) >= 2 &&
    // (a-1) the queue-send INTENT payload still emits the account-bound proof AND the
    // rate-quote ref — the SAME proof/binding the deleted FE direct-buy used to carry
    // straight into apiClient.createLabel, now sent to the backend owner instead.
    ordersView.includes('function buildQueueSendOrderPayload') &&
    /selectedRateProof: buildSelectedRateProofPayload\(order, bestRate \?\? selectedRate, shippingProviderId\),\s*\n\s*\.\.\.buildRateQuoteRefForOrder\(order, bestRate \?\? selectedRate, shippingProviderId\)/.test(ordersView) &&
    // (b) the batch-print override payload keeps its proof variable.
    // Repointed (guard rot): the ShipStation batch-create `let selectedRateProof = ...(order,
    // proofRate, orderIsTest ? null : shippingProviderId)` form became the batch-print pipeline's
    // buildBatchPrintOverridePayload, which derives proof from the SAME fresh rate (PS-204
    // binding by construction — account arg dropped).
    ordersView.includes('const selectedRateProof = buildSelectedRateProofPayload(order, rate)') &&
    ordersView.includes('selectedRateProof,') &&
    // ANTI-REGRESSION: the deleted FE direct-carrier buy must NOT come back. Neither
    // the function nor its override-wrapper proof variable (the one it assembled before
    // its own apiClient.createLabel) may exist in OrdersView again.
    !ordersView.includes('createDirectCarrierLabelThenQueue') &&
    !/const selectedRateProof =\s*\n\s*toRecord\(overrideRecord\?\.selectedRateProof\) \?\?\s*\n\s*buildSelectedRateProofPayload\(order/.test(ordersView) &&
    // RELOCATED OWNER 1 — the queue path now buys server-side: print-queue.ts's
    // processQueueSendOrder feeds the FE-built order.label intent into createLabelV2.
    printQueueService.includes('async function processQueueSendOrder') &&
    // Repointed (guard rot): processQueueSendOrder now narrows the intent once
    // (`const labelInput = order.label;`) and spreads THAT into createLabelV2 — same
    // FE-intent-to-backend-buy flow, new local name.
    /const labelInput = order\.label;[\s\S]*?createLabelV2\(\{\s*\r?\n\s*\.\.\.labelInput,/.test(printQueueService) &&
    // RELOCATED OWNER 2 — createLabelV2 enforces the SAME selected-rate proof + PS-204
    // account binding before BOTH the direct-carrier and ShipStation provider calls,
    // and detects direct carriers via directLabelAccountRefFromProviderId. This is the
    // protection the deleted FE override-wrapper used to carry, now backend-owned.
    labelsService.includes('await assertLabelPurchaseRateSelection(') &&
    labelsService.includes('selectedRateProof: body.selectedRateProof') &&
    labelsService.includes('purchaseShippingProviderId: body.shippingProviderId') &&
    labelsService.includes('directLabelAccountRefFromProviderId(body.shippingProviderId)') &&
    labelsService.includes('createDirectCarrierLabelForOrder(') &&
    proofBoundaryGuard.includes('FE direct-carrier label BUY is gone; queue intent still carries the account-bound selected-rate proof'),
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
