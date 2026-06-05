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

let failures = 0;
function check(name: string, condition: boolean) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const metadataStart = ordersView.indexOf('function withRateRequestMetadata(');
const metadataEnd = ordersView.indexOf('\n  function buildStrictBestRateRequest', metadataStart);
const metadataBlock = metadataStart >= 0 && metadataEnd > metadataStart
  ? ordersView.slice(metadataStart, metadataEnd)
  : '';
const proofBuilderStart = ordersView.indexOf('function buildSelectedRateProofPayload(');
const proofBuilderEnd = ordersView.indexOf('\n  function hasAnySavedBestRateForDisplay', proofBuilderStart);
const proofBuilderBlock = proofBuilderStart >= 0 && proofBuilderEnd > proofBuilderStart
  ? ordersView.slice(proofBuilderStart, proofBuilderEnd)
  : '';
const strictApplyStart = ordersView.indexOf('async function applyStrictBestRateResponse(');
const strictApplyEnd = ordersView.indexOf('\n  async function runStrictBestRateRecalculation', strictApplyStart);
const strictApplyBlock = strictApplyStart >= 0 && strictApplyEnd > strictApplyStart
  ? ordersView.slice(strictApplyStart, strictApplyEnd)
  : '';

check('withRateRequestMetadata block found', metadataBlock.length > 0);
check(
  'frontend does not fallback proof fields to locally-built request fingerprint',
  !/requestFingerprint:\s*[^,\n]*request\.fingerprint/.test(metadataBlock) &&
    !/cacheKey:\s*[^,\n]*request\.fingerprint/.test(metadataBlock) &&
    !/requestFingerprint:\s*request\.fingerprint/.test(strictApplyBlock) &&
    !/cacheKey:\s*request\.fingerprint/.test(strictApplyBlock),
);
check(
  'frontend proof builder requires backend proof marker before returning selectedRateProof',
  /function hasBackendIssuedRateProof/.test(ordersView) &&
    /candidates\.find\(\(rate\) => hasBackendIssuedRateProof\(rate\) && rateProofFingerprint\(rate\)\)/.test(proofBuilderBlock),
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
