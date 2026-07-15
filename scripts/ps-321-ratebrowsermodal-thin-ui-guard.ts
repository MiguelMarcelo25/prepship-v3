/**
 * PS-321 - RateBrowserModal thin UI guard.
 *
 * Offline only: no DB, no network, no provider calls, no labels, no queue mutation.
 * Pins the post-PS-313 boundary: backend DTO facts decide rate availability and
 * proof completeness; the modal only renders rows and passes backend proof through.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  RATE_BROWSER_BACKEND_PROOF_UNAVAILABLE_REASON,
  rateBrowserCanApplyRate,
  rateBrowserShouldHideUnavailableRate,
  rateBrowserUnavailableReason,
} from '../web/src/lib/rate-browser-availability';

let failures = 0;

function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

const modal = readFileSync('web/src/components/RateBrowserModal.tsx', 'utf8');
const rowItem = readFileSync('web/src/components/RateRowItem.tsx', 'utf8');
const rowsView = readFileSync('web/src/components/RateRowsView.tsx', 'utf8');
const carrierSidebar = readFileSync('web/src/components/RateBrowserCarrierSidebar.tsx', 'utf8');
const availability = readFileSync('web/src/lib/rate-browser-availability.ts', 'utf8');
const money = existsSync('web/src/lib/rate-browser-money.ts')
  ? readFileSync('web/src/lib/rate-browser-money.ts', 'utf8')
  : '';
const quoteSnapshotStore = readFileSync('src/services/shipping-workflow/rate-quote-snapshot-store.ts', 'utf8');
const siteActionsSpec = readFileSync('web/e2e/site-actions.spec.js', 'utf8');
const packageJson = readFileSync('package.json', 'utf8');

check('availability helper blocks backend-stamped unavailable rates with backend reason',
  rateBrowserUnavailableReason({
    eligibilityBlocked: true,
    eligibilityBlockReason: 'Backend says no',
    isComplete: true,
  }) === 'Backend says no');

check('availability helper blocks raw backend-stamped unavailable rates',
  rateBrowserUnavailableReason({
    raw: {
      eligibilityBlocked: true,
      eligibilityBlockReason: 'Raw backend says no',
      isComplete: true,
    },
  }) === 'Raw backend says no');

check('availability helper rejects proofless rows before apply',
  rateBrowserUnavailableReason({ eligibilityBlocked: false }) === RATE_BROWSER_BACKEND_PROOF_UNAVAILABLE_REASON);

check('availability helper rejects stale/incomplete backend proof rows',
  !rateBrowserCanApplyRate({ eligibilityBlocked: false, isComplete: false }));

check('availability helper keeps incomplete-proof quoted rows visible under Hide Unavailable',
  rateBrowserShouldHideUnavailableRate({ eligibilityBlocked: false, isComplete: false }) === false);

check('availability helper hides only backend-stamped unavailable rows under Hide Unavailable',
  rateBrowserShouldHideUnavailableRate({ eligibilityBlocked: true, eligibilityBlockReason: 'Backend says no', isComplete: true }) === true);

check('availability helper allows complete unblocked backend rows',
  rateBrowserCanApplyRate({ eligibilityBlocked: false, isComplete: true }));

check('availability helper preserves mock/test rates without minting backend proof',
  rateBrowserCanApplyRate({ raw: { testRate: true, mocked: true } }));

check('availability helper does not recompute HUGRAB/service eligibility from client/service text',
  rateBrowserCanApplyRate({
    carrierCode: 'ups',
    serviceCode: 'ups_ground_saver',
    serviceName: 'UPS Ground Saver',
    isComplete: true,
  }));

check('RateBrowserModal imports the PS-321 availability helper',
  modal.includes("from '../lib/rate-browser-availability'") &&
  modal.includes('rateBrowserUnavailableReason(') &&
  modal.includes('rateBrowserShouldHideUnavailableRate(') &&
  modal.includes('rateBrowserBackendProofIsComplete('));

check('RateBrowserModal no longer calls evaluateShippingServiceEligibility',
  !/evaluateShippingServiceEligibility\(/.test(modal));

check('RateBrowserModal no longer computes visible rate totals from frontend markups',
  !/function\s+rateDisplayTotal\s*\(/.test(modal) &&
  !/function\s+rbMarkupForRate\s*\(/.test(modal) &&
  !/rateDisplayTotal\([^)]*markups/.test(modal));

check('RateBrowserModal All Rates sort delegates to backend display rank reader',
  modal.includes('sortRateRowsByBackendDisplayRank(') &&
  !/sort\(\(a,\s*b\)\s*=>\s*rateDisplayTotal\(a,\s*markups\)\s*-\s*rateDisplayTotal\(b,\s*markups\)\)/.test(modal));

check('RateRowItem renders backend-issued display/rate-cost amounts instead of markup totals',
  rowItem.includes('rateBrowserCustomerAmount(r)') &&
  rowItem.includes('rateBrowserRateCostAmount(r)') &&
  !/rateDisplayTotal|rateBaseTotal|markups:/.test(rowItem));

check('rate-browser money helper reads backend customer/rate-cost fields without markup policy',
  money.includes('cShippingRateAmount') &&
  money.includes('selectedRateCost') &&
  money.includes('sortRateRowsByBackendDisplayRank') &&
  !/Markup|markups|rbMarkup|applyMarkup|rateDisplayTotal/.test(money));

check('RateBrowserModal gates manual row apply through the backend availability fact before onApplyRate',
  /function handleRateClick\(r: RateRow\): void \{[\s\S]{0,500}if \(isBackendUnavailableRate\(r, order, currentRateShippingOptions\)\) return;[\s\S]{0,900}onApplyRate\(/.test(modal));

check('RateBrowserModal gates auto-applied best through the backend availability fact before returning DTO',
  /function toAppliedRate\(r: RateRow\): RbAppliedRate \| null \{[\s\S]{0,500}if \(isBackendUnavailableRate\(r, order, currentRateShippingOptions\)\) return null;[\s\S]{0,400}return \{/.test(modal));

check('Hide Unavailable uses display-only hide helper, not purchase proof blocking',
  modal.includes('shouldHideRate={shouldHideUnavailableRate}') &&
  rowsView.includes('shouldHideRate: (rate: RateRow) => boolean') &&
  carrierSidebar.includes('shouldHideRate: (rate: RateRow) => boolean') &&
  !/filter\(\(r\) => !isBlockedRate/.test(rowsView) &&
  !/filter\(\(r\) => !isBlockedRate/.test(carrierSidebar));

const proofLifterStart = modal.indexOf('function rateBackendProof(r: RateRow)');
const proofLifterEnd = modal.indexOf('\n  function rateIsBackendComplete', proofLifterStart);
const proofLifter = modal.slice(proofLifterStart, proofLifterEnd);
check('RateBrowserModal still passes backend proof via rateBackendProof only',
  modal.includes('...rateBackendProof(r)') &&
  proofLifterStart >= 0 && proofLifterEnd > proofLifterStart &&
  proofLifter.includes("'rateQuoteId'") &&
  proofLifter.includes("'selectedRateKey'") &&
  proofLifter.includes("'requestFingerprint'") &&
  proofLifter.includes('return out;') &&
  !/requestFingerprint:\s*[^,\n]+/.test(proofLifter) &&
  !/selectedRateKey:\s*[^,\n]+/.test(proofLifter));

check('RateBrowserModal still delegates canonical best emission',
  modal.includes('decideBestRateEmission(canonicalBest)') &&
  !/canonicalBest\s*\?\?[\s\S]{0,250}?sort\(/.test(modal));

check('availability helper owns no backend/service policy imports',
  !/shipping-service-eligibility|rate-block-list|markups|apiClient/.test(availability));

check('availability helper does not mint selected-rate proof fields',
  !/rateQuoteId|selectedRateKey|requestFingerprint|proofSource/.test(availability));

check('backend quote finalizer stamps row-level proof/completeness for Rate Browser rows',
  /const rates = rateQuoteId[\s\S]{0,700}rateQuoteId,[\s\S]{0,160}proofSource: BACKEND_RATE_PROOF_SOURCE,[\s\S]{0,160}isComplete,[\s\S]{0,320}proofSource: BACKEND_RATE_PROOF_SOURCE,[\s\S]{0,160}isComplete,/.test(quoteSnapshotStore));

check('site-actions browser proof covers valid, blocked, stale, partial-failure, and selected-proof paths',
  siteActionsSpec.includes('Backend blocked by PS-321 fixture') &&
  siteActionsSpec.includes('Backend rate proof unavailable - browse rates again before selecting.') &&
  siteActionsSpec.includes('ps321-rq-1') &&
  siteActionsSpec.includes('ps321-sr-1') &&
  siteActionsSpec.includes('ps321-fp-1') &&
  siteActionsSpec.includes('Shipp reached the quote API'));

check('package.json wires test:ps-321-ratebrowsermodal-thin-ui',
  packageJson.includes('"test:ps-321-ratebrowsermodal-thin-ui"'));

if (failures > 0) {
  console.error(`\nFAIL PS-321 RateBrowserModal thin UI guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-321 RateBrowserModal thin UI guard');
