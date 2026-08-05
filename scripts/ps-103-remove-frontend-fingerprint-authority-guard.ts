/**
 * PS-103 Guard - frontend must not fabricate rate proof authority.
 *
 * Static/offline only: no DB, providers, labels, postage, marketplace calls, or
 * shipped/cancelled mutations.
 */
import { readFileSync } from 'node:fs';

const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
const apiClient = readFileSync('web/src/lib/v2-apiClient.ts', 'utf8');
// Repointed (guard rot): the rate-DTO translator moved to web/src/lib/v2-apiClient/shared.ts
// (translateRateToLegacyDisplayShape; local renamed rate→obj). v2-apiClient.ts's toLegacyRateArray
// maps EVERY backend rate through it, so the proof-metadata pass-through pins now read shared.ts.
const v2Shared = readFileSync('web/src/lib/v2-apiClient/shared.ts', 'utf8');
const directRates = readFileSync('api/carriers/rates.ts', 'utf8');
// PS-135 re-anchor (2026-06-16): the proof-selection logic moved out of OrdersView's
// buildSelectedRateProofPayload into web/src/lib/rate-proof.ts (selectProofFromCandidates),
// which OrdersView now delegates to. Read it so the proof-marker check pins the live owner.
const rateProof = readFileSync('web/src/lib/rate-proof.ts', 'utf8');
// PS-317: withRateRequestMetadata + getBackendRateResponseFingerprint moved to
// ./orders/best-rate/rate-proof.ts (call sites stay in OrdersView), joined by the PS-422
// payload builder. The body slices for those functions read this file.
// applyStrictBestRateResponse STAYS in OrdersView.
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
// PS-422 cleanup (2026-08-05): the legacy semantic-proof builder was DELETED from
// best-rate/rate-proof.ts (zero call sites; it survived only as a guard slice target). The
// live payload builder is buildRateQuoteRefForOrder; its body runs to the next top-level
// function getRateBaseAmount. Single-\n anchor is deliberate — this file is CRLF and read
// RAW, so a '\n\n' anchor would return -1 and yield an empty slice.
const quoteRefBuilderStart = bestRateProof.indexOf('function buildRateQuoteRefForOrder(');
const quoteRefBuilderEnd = bestRateProof.indexOf('\nexport function getRateBaseAmount', quoteRefBuilderStart);
const quoteRefBuilderBlock = quoteRefBuilderStart >= 0 && quoteRefBuilderEnd > quoteRefBuilderStart
  ? bestRateProof.slice(quoteRefBuilderStart, quoteRefBuilderEnd)
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
  // PS-422 retirement (2026-08-05): the marker requirement USED to be owned by the legacy
  // semantic proof selector in web/src/lib/rate-proof.ts, now deleted (zero application
  // callers). The requirement itself is untouched and still executes on every rate — it is
  // the conjunction in the live consumer best-rate/rate-proof.ts, which gates the fingerprint
  // read on the backend-issued marker. The predicate is still DEFINED in the lib (first pin),
  // and now APPLIED in the consumer (second pin), so the FE still cannot fabricate authority.
  /export function hasBackendIssuedRateProof\(/.test(rateProof) &&
    /hasBackendIssuedRateProof\(rate \?\? null\) \? rateProofFingerprint\(rate \?\? null\) : null/.test(bestRateProof) &&
    // PS-422: the deleted wrapper's "delegate, never mint" property now rides on the LIVE
    // builder. TEETH: require a non-empty slice so a missing builder or a rotted anchor fails
    // LOUD instead of passing vacuously on an empty string.
    quoteRefBuilderStart >= 0 && quoteRefBuilderBlock.length > 0 &&
    quoteRefBuilderBlock.includes('return rateQuoteRefFromCandidates('),
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
  // Repointed (guard rot): translateRateToLegacyDisplayShape lives in v2-apiClient/shared.ts
  // now (var rate→obj); toLegacyRateArray in v2-apiClient.ts still maps every rate through it.
  /requestFingerprint:\s*obj\.requestFingerprint/.test(v2Shared) &&
    /proofSource:\s*obj\.proofSource/.test(v2Shared),
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
