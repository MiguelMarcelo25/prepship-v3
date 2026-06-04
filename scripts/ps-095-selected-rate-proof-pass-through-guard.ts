/**
 * PS-095 guard - frontend selected-rate proof pass-through + stale-rate UX.
 *
 * Static/pure only: no browser, DB, provider calls, labels, postage, or
 * marketplace notifications.
 */
import fs from 'node:fs';

const ordersView = fs.readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
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
  'frontend extracts only backend-issued proof fingerprints from rate metadata/cache keys',
  ordersView.includes('function rateProofFingerprint') &&
    ordersView.includes('rate?.requestFingerprint') &&
    ordersView.includes('rate?.rateRequestFingerprint') &&
    ordersView.includes('metadata?.requestFingerprint') &&
    ordersView.includes('raw?.requestFingerprint'),
);

check(
  'frontend clears proof by omitting selectedRateProof when no backend fingerprint exists',
  proofBuilder.includes('const requestFingerprint = rateProofFingerprint(selectedRate)') &&
    proofBuilder.includes('if (!selectedRate || !requestFingerprint) return undefined'),
);

check(
  'frontend passes selectedRateProof through all single, batch, backend-queue, and direct-carrier payload paths',
  (ordersView.match(/selectedRateProof: buildSelectedRateProofPayload/g)?.length ?? 0) >= 5 &&
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
  !/stale[^\\n]*(acceptable|allow|allowed|continue|ignore)/i.test(ordersView) &&
    !/selectedRateProof[^\\n]*(force|bypass|override)/i.test(ordersView),
);

if (failures > 0) {
  console.error(`\nFAIL PS-095 selected-rate proof pass-through guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-095 selected-rate proof pass-through guard');
