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
// PS-422 cleanup (2026-08-05): the legacy semantic-proof builder in this file was DELETED —
// it had zero call sites and existed only for guards like this one to slice. The delegation
// property this guard cares about ("the FE payload builder asks the canonical selector; it
// never mints authority locally") now lives on buildRateQuoteRefForOrder, which is the
// builder that actually runs. Re-slice THAT; the END anchor is the next top-level function
// getRateBaseAmount. The selection RULES themselves are asserted against their owner
// (web/src/lib/rate-proof.ts) in the same check below — those pins are unchanged.
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

// PS-422: buildRateQuoteRefForOrder is the live payload builder in best-rate/rate-proof.ts;
// its body runs to the next top-level function getRateBaseAmount. NOTE the single-\n anchor
// form: this file is CRLF and read RAW (no \r\n normalization), so a '\n\n' anchor would
// silently return -1 and hand every downstream assertion an empty slice.
// The trailing '(' is load-bearing: without it this anchor PREFIX-matches a renamed
// buildRateQuoteRefForOrderAnything, the slice still resolves, and the rename sails through.
// (Caught by mutation test M2 during the PS-422 cleanup — ps-103 and
// recalculate-best-rate-strict already used the paren form.)
const quoteRefBuilderStart = bestRateProof.indexOf('function buildRateQuoteRefForOrder(');
const quoteRefBuilderEnd = bestRateProof.indexOf('\nexport function getRateBaseAmount', quoteRefBuilderStart);
const quoteRefBuilder = quoteRefBuilderStart >= 0 && quoteRefBuilderEnd > quoteRefBuilderStart
  ? bestRateProof.slice(quoteRefBuilderStart, quoteRefBuilderEnd)
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
  // PS-422 retirement (2026-08-05): the legacy SEMANTIC proof selector whose body these pins
  // used to read was deleted from web/src/lib/rate-proof.ts — zero application callers.
  'frontend clears proof by omitting the selection ref when no backend-issued value exists',
  // The RULE — "emit nothing unless the backend issued something" — did not move out of the
  // lib, it moved onto the surviving opaque selector, whose final line IS that rule. The
  // companion rule ("a backend marker gates the fingerprint") relocated to the live consumer
  // best-rate/rate-proof.ts, so it is pinned there rather than being dropped. Between them
  // these three pins assert exactly what the two deleted-body pins asserted.
  rateProof.includes('const selectionRef = toStr(list.find((rate) => toStr(rate.selectionRef))?.selectionRef)') &&
    rateProof.includes('return selectionRef ? { selectionRef } : {}') &&
    bestRateProof.includes('hasBackendIssuedRateProof(rate ?? null) ? rateProofFingerprint(rate ?? null) : null') &&
    // TEETH: require the LIVE builder's re-sliced body to be non-empty and to delegate, so a
    // missing/renamed definition — or an anchor rotted by a future edit — fails LOUD instead
    // of handing this check an empty string that a negative assertion would pass vacuously.
    quoteRefBuilderStart >= 0 && quoteRefBuilder.length > 0 &&
    quoteRefBuilder.includes('rateQuoteRefFromCandidates('),
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
