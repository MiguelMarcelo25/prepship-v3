/**
 * PS-103 Guard - frontend must not fabricate rate proof authority.
 *
 * Static/offline only: no DB, providers, labels, postage, marketplace calls, or
 * shipped/cancelled mutations.
 */
import { readFileSync } from 'node:fs';

const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
const apiClient = readFileSync('web/src/lib/v2-apiClient.ts', 'utf8');
const directRates = readFileSync('api/carriers/rates.ts', 'utf8');
// PS-135 re-anchor (2026-06-16): the proof-selection logic moved out of OrdersView's
// buildSelectedRateProofPayload into web/src/lib/rate-proof.ts (selectProofFromCandidates),
// which OrdersView now delegates to. Read it so the proof-marker check pins the live owner.
const rateProof = readFileSync('web/src/lib/rate-proof.ts', 'utf8');
// PS-317: withRateRequestMetadata + buildSelectedRateProofPayload + getBackendRateResponseFingerprint
// moved to ./orders/best-rate/rate-proof.ts (call sites stay in OrdersView). The body slices for
// those two functions now read the new owner. applyStrictBestRateResponse STAYS in OrdersView.
const bestRateProof = readFileSync('web/src/components/Views/orders/best-rate/rate-proof.ts', 'utf8');

let failures = 0;
function check(name: string, condition: boolean) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// PS-317: withRateRequestMetadata moved to best-rate/rate-proof.ts; its body runs to the
// next top-level function getSavedBestRateRecord.
const metadataStart = bestRateProof.indexOf('function withRateRequestMetadata(');
const metadataEnd = bestRateProof.indexOf('\nexport function getSavedBestRateRecord', metadataStart);
const metadataBlock = metadataStart >= 0 && metadataEnd > metadataStart
  ? bestRateProof.slice(metadataStart, metadataEnd)
  : '';
// PS-317: buildSelectedRateProofPayload moved to best-rate/rate-proof.ts; its body runs to the
// next top-level function buildRateQuoteRefForOrder.
const proofBuilderStart = bestRateProof.indexOf('function buildSelectedRateProofPayload(');
const proofBuilderEnd = bestRateProof.indexOf('\nexport function buildRateQuoteRefForOrder', proofBuilderStart);
const proofBuilderBlock = proofBuilderStart >= 0 && proofBuilderEnd > proofBuilderStart
  ? bestRateProof.slice(proofBuilderStart, proofBuilderEnd)
  : '';
const strictApplyStart = ordersView.indexOf('async function applyStrictBestRateResponse(');
const strictApplyEnd = ordersView.indexOf('\n  async function runStrictBestRateRecalculation', strictApplyStart);
const strictApplyBlock = strictApplyStart >= 0 && strictApplyEnd > strictApplyStart
  ? ordersView.slice(strictApplyStart, strictApplyEnd)
  : '';

check('withRateRequestMetadata block found in rate-proof.ts', metadataStart >= 0 && metadataBlock.length > 0);
check(
  'frontend does not fallback proof fields to locally-built request fingerprint',
  // TEETH: the metadata-half negations would pass vacuously on an empty slice, so gate them on a
  // non-empty body. strictApplyBlock stays in OrdersView and is independently non-empty here.
  metadataStart >= 0 && metadataBlock.length > 0 &&
    strictApplyBlock.length > 0 &&
    !/requestFingerprint:\s*[^,\n]*request\.fingerprint/.test(metadataBlock) &&
    !/cacheKey:\s*[^,\n]*request\.fingerprint/.test(metadataBlock) &&
    !/requestFingerprint:\s*request\.fingerprint/.test(strictApplyBlock) &&
    !/cacheKey:\s*request\.fingerprint/.test(strictApplyBlock),
);
check(
  'frontend proof builder requires backend proof marker before returning selectedRateProof',
  // PS-135 re-anchor: buildSelectedRateProofPayload delegates to selectProofFromCandidates
  // (web/src/lib/rate-proof.ts), which ONLY selects a rate carrying a backend-issued proof
  // marker + fingerprint — so the FE still cannot fabricate proof authority. Property unchanged.
  // PS-317: the builder's delegating call moved with it to best-rate/rate-proof.ts; assert the
  // delegation inside the re-sliced body (TEETH: require a non-empty slice so a missing builder
  // fails LOUD instead of a vacuous pass).
  /export function hasBackendIssuedRateProof/.test(rateProof) &&
    /list\.find\(\(rate\) => hasBackendIssuedRateProof\(rate\) && rateProofFingerprint\(rate\)\)/.test(rateProof) &&
    proofBuilderStart >= 0 && proofBuilderBlock.length > 0 &&
    proofBuilderBlock.includes('return selectProofFromCandidates('),
);
check(
  'strict recalculation stamps proof from backend response request key only',
  /const backendRequestFingerprint = getBackendRateResponseFingerprint\(response\)/.test(strictApplyBlock) &&
    /requestFingerprint:\s*backendRequestFingerprint/.test(strictApplyBlock) &&
    !/requestFingerprint:\s*request\.fingerprint/.test(strictApplyBlock),
);
check(
  'operator-facing proof rejection is sanitized and actionable',
  ordersView.includes("const RATE_PROOF_RETRY_MESSAGE = 'Rate changed or expired. Re-rate this order before creating the label.'") &&
    ordersView.includes('showToast(RATE_PROOF_RETRY_MESSAGE'),
);
check(
  'direct-carrier rate responses expose backend proof metadata',
  /buildDirectCarrierRateRequestFingerprint/.test(directRates) &&
    /requestFingerprint/.test(directRates) &&
    /cacheKey/.test(directRates),
);
check(
  'direct-carrier rates preserve backend proof metadata into frontend rate DTOs',
  /requestFingerprint:\s*rate\.requestFingerprint/.test(apiClient) &&
    /proofSource:\s*rate\.proofSource/.test(apiClient),
);
check(
  'no selected-rate proof bypass or force flag exists',
  !/selectedRateProof[^,\n]*(force|bypass|override)/i.test(ordersView) &&
    !/proof[^,\n]*(force|bypass|override)/i.test(apiClient),
);

if (failures > 0) {
  console.error(`\nFAIL PS-103 remove frontend fingerprint authority guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-103 remove frontend fingerprint authority guard');
