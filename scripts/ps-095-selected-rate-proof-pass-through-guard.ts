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
const rateSyncGuard = fs.readFileSync('scripts/ps-081-rate-sync-guard.ts', 'utf8');
const proofBoundaryGuard = fs.readFileSync('scripts/selected-rate-proof-purchase-boundary-guard.ts', 'utf8');

let failures = 0;

function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const proofBuilderStart = ordersView.indexOf('function buildSelectedRateProofPayload');
const proofBuilderEnd = ordersView.indexOf('function hasAnySavedBestRateForDisplay', proofBuilderStart);
const proofBuilder = proofBuilderStart >= 0 && proofBuilderEnd > proofBuilderStart
  ? ordersView.slice(proofBuilderStart, proofBuilderEnd)
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
  rateProof.includes('const requestFingerprint = rateProofFingerprint(selectedRate)') &&
    rateProof.includes('if (!selectedRate || !requestFingerprint) return undefined') &&
    proofBuilder.includes('selectProofFromCandidates('),
);

check(
  'frontend passes selectedRateProof through all single, batch, backend-queue, and direct-carrier payload paths',
  // PS-104 direct-carrier path uses the override-wrapper form
  // `selectedRateProof: overridePayload?.selectedRateProof ?? buildSelectedRateProofPayload(order, ...)`,
  // so count the wrapper-aware pattern (matches the boundary guard) — the proof is
  // genuinely passed on all 4 single/batch/queue/direct-carrier paths.
  //
  // PS-204 re-anchor (2026-06-12): the property-site census is THREE (the
  // fourth path is the batch-create `let selectedRateProof = ...` pinned
  // below — the property regex never matched it; the old >= 4 was stale since
  // the PS-178 decomposition). The batch-create pin gains PS-204's account
  // binding (third arg) — stricter, never weaker.
  (ordersView.match(/selectedRateProof:[\s\S]{0,160}?buildSelectedRateProofPayload\(order/g)?.length ?? 0) >= 3 &&
    ordersView.includes('let selectedRateProof = buildSelectedRateProofPayload(order, proofRate, orderIsTest ? null : shippingProviderId)') &&
    ordersView.includes('selectedRateProof,') &&
    proofBoundaryGuard.includes('Orders single/batch/queue label payloads pass selectedRateProof'),
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
