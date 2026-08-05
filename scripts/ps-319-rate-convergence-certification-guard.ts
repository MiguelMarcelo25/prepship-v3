/**
 * PS-319 guard - post-PS-313 rate convergence certification.
 *
 * Offline only: no DB, no network, no providers, no labels, no postage, no
 * marketplace notifications, no production data mutation, and no
 * shipped/cancelled mutation. This guard certifies that existing PS-313/PS-317
 * backend rate owners converge across the purchase and Print Queue boundaries;
 * it must not create a second rate authority.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  assertRateQuoteForLabelPurchase,
  resolveRateQuoteForPurchase,
  selectedRateOpaqueKey,
  type RateQuoteSnapshot,
} from '../src/services/shipping-workflow/rate-quote-snapshot';
import {
  SelectedRateProofError,
  classifyLabelPurchaseRetry,
} from '../src/services/shipping-workflow/rate-fingerprint';

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function checkIncludesAll(name: string, text: string, values: string[]): void {
  const missing = values.filter((value) => !text.includes(value));
  check(name, missing.length === 0, missing);
}

function checkPatterns(name: string, text: string, patterns: RegExp[]): void {
  const missing = patterns.map((pattern) => pattern.source).filter((_, index) => !patterns[index].test(text));
  check(name, missing.length === 0, missing);
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function sliceBetween(source: string, startToken: string, endToken: string): string {
  const start = source.indexOf(startToken);
  if (start < 0) return '';
  const end = source.indexOf(endToken, start + startToken.length);
  return end > start ? source.slice(start, end) : '';
}

type TestRate = {
  shippingProviderId: number;
  carrierCode: string;
  serviceCode: string;
  packageCode: string;
  shipmentCost: number;
  otherCost: number;
};

const packageJson = read('package.json');
const ps319DocPath = 'docs/ps-tickets/ps-319-rate-convergence-certification.md';
const ps319Doc = read(ps319DocPath);

check('PS-319 convergence certification doc exists', existsSync(ps319DocPath));
checkIncludesAll('PS-319 doc names the PS-313 owner cluster and every certified caller', ps319Doc, [
  'Rate convergence SOT owner map',
  'src/services/rates-combined.ts#combineCarrierUniverses',
  'src/services/rates.ts#pickBestRate',
  'src/services/shipping-workflow/rate-quote-snapshot-store.ts',
  'src/services/shipping-workflow/rate-fingerprint.ts',
  'Awaiting Best Rate',
  'Rate Browser',
  'Recalculate',
  'Apply Best Rate',
  'Create + Print',
  'Print Queue',
]);
checkIncludesAll('PS-319 doc records residual gaps and safety limits', ps319Doc, [
  'PS-319 does not create a new canonical rate owner',
  'Strict snapshot-only enforcement remains canary-gated',
  'PRINT_QUEUE_BACKEND_ORCHESTRATION remains default-off',
  'No real label purchases',
  'No postage',
  'No marketplace notifications',
  'No production order mutations',
  'No shipped/cancelled mutations',
]);
checkIncludesAll('PS-319 doc records workflow proof and predecessor guards', ps319Doc, [
  'test:rate-source-of-truth',
  'test:ps-302-apply-best-rate-authority',
  'test:ps-303-print-queue-authority',
  'test:selected-rate-proof-boundary',
  'test:print-to-queue-selected-rate-proof',
  'test:ps-191-retry-eligibility',
  'test:ps-198-rate-quote-proof-passthrough',
  'test:ps-328-rerate-warning-reason',
]);

check('package wires PS-319 rate convergence certification guard',
  /"test:ps-319-rate-convergence-certification"\s*:\s*"tsx scripts\/ps-319-rate-convergence-certification-guard\.ts"/.test(packageJson));

for (const command of [
  'test:ps-079-best-rate-source-of-truth',
  'test:ps-102-best-rate-workflow-dto',
  'test:ps-111-backend-rate-authority',
  'test:ps-124-backend-combined-best-rate',
  'test:ps-203-best-rate-universe',
  'test:ps-279-rate-browser-no-fallback-best',
  'test:ps-286-awaiting-row-rate-truth',
  'test:ps-302-apply-best-rate-authority',
  'test:ps-303-print-queue-authority',
  'test:ps-314-no-sot-bypass-wrappers',
  'test:ps-316-backend-truth-law',
]) {
  check(`package keeps predecessor rate-authority guard ${command}`, packageJson.includes(`"${command}"`));
}

const rateA: TestRate = {
  shippingProviderId: 565377,
  carrierCode: 'ups',
  serviceCode: 'ups_ground',
  packageCode: 'package',
  shipmentCost: 10.25,
  otherCost: 0,
};
const rateB: TestRate = {
  shippingProviderId: 565377,
  carrierCode: 'ups',
  serviceCode: 'ups_2nd_day_air',
  packageCode: 'package',
  shipmentCost: 22.75,
  otherCost: 0,
};
const selectedA = selectedRateOpaqueKey(rateA);
const selectedB = selectedRateOpaqueKey(rateB);
const freshNow = Date.parse('2026-06-26T12:00:00.000Z');
const snapshotBase = {
  cacheKey: 'v=ps319|d=2026-06-26|w=160|z=90210|co=US|c=se-565377',
  rates: [rateA, rateB],
  fetchedAt: freshNow,
  bestRateKey: selectedA,
} satisfies Omit<RateQuoteSnapshot, 'bestRateComplete'>;

const notFinal = resolveRateQuoteForPurchase({
  snapshot: { ...snapshotBase, bestRateComplete: false },
  selectedRateKey: selectedA,
  now: freshNow,
  ttlMs: 60_000,
});
check('snapshot purchase resolver blocks quotes that are still finalizing',
  !notFinal.ok && notFinal.reason === 'snapshot_not_final',
  notFinal);

const manualSelection = resolveRateQuoteForPurchase({
  snapshot: { ...snapshotBase, bestRateComplete: true },
  selectedRateKey: selectedB,
  now: freshNow,
  ttlMs: 60_000,
});
check('snapshot purchase resolver accepts manual non-best selections from complete snapshots',
  manualSelection.ok === true,
  manualSelection);

function thrownReasonFor(input: {
  snapshot: RateQuoteSnapshot;
  selectedRateKey: string;
}): string | null {
  try {
    assertRateQuoteForLabelPurchase({
      snapshot: input.snapshot,
      selectedRateKey: input.selectedRateKey,
      now: freshNow,
      ttlMs: 60_000,
    });
  } catch (err) {
    if (err instanceof SelectedRateProofError) {
      const retry = classifyLabelPurchaseRetry(err);
      return retry.retryEligible ? err.details.reason : `non_retry:${err.details.reason}`;
    }
    throw err;
  }
  return null;
}

check('label purchase assertion throws retry-eligible snapshot_not_final before provider purchase',
  thrownReasonFor({ snapshot: { ...snapshotBase, bestRateComplete: false }, selectedRateKey: selectedA }) === 'snapshot_not_final');
check('label purchase assertion allows manual non-best selections before provider purchase',
  thrownReasonFor({ snapshot: { ...snapshotBase, bestRateComplete: true }, selectedRateKey: selectedB }) === null);

const quoteStore = read('src/services/shipping-workflow/rate-quote-snapshot-store.ts');
check('snapshot store blocks non-final quotes with no carried-proof fallback',
  quoteStore.includes("reason === 'snapshot_not_final'") &&
  quoteStore.includes('if (!resolved.ok) throwStrictRateQuoteError(resolved.reason)') &&
  !quoteStore.includes("resolved.reason === 'selected_rate_not_best'") &&
  !quoteStore.includes('assertSelectedRateProofForLabelPurchase(body.selectedRateProof'));
checkPatterns('snapshot store validates account binding on the strict snapshot path', quoteStore, [
  /authorization\?\.accounts\.find\(\(account\) => account\.shippingProviderId === providerId\)/,
  /if \(!authorization\?\.context \|\| !accountAuthorization\)/,
  /ShippingQuoteAuthorizationError\('order or carrier credential identity'\)/,
]);

const labelsService = read('src/services/labels.ts');
checkPatterns('createLabelV2 resolves selectionRef and validates current context/account before provider branches', labelsService, [
  /await assertLabelPurchaseRateSelection\(\{/,
  /selectionRef: body\.selectionRef/,
  /assertShippingQuoteContextMatches\(\{/,
  /assertShippingQuoteAccountMatches\(\{/,
  /directLabelAccountRefFromProviderId\(body\.shippingProviderId\)/,
  /createDirectCarrierLabelForOrder\(/,
  /createCarrierLabel\('shipstation'/,
]);
check('proof gate runs before every provider purchase branch',
  (() => {
    const proofIndex = labelsService.indexOf('await assertLabelPurchaseRateSelection({');
    const directIndex = labelsService.indexOf('const directRef = directLabelAccountRefFromProviderId');
    const directBuyIndex = labelsService.indexOf('createDirectCarrierLabelForOrder({', proofIndex);
    const shipStationBuyIndex = labelsService.indexOf("createCarrierLabel('shipstation'", proofIndex);
    return proofIndex >= 0 &&
      directIndex > proofIndex &&
      directBuyIndex > proofIndex &&
      shipStationBuyIndex > proofIndex;
  })());

const printQueueService = read('src/services/print-queue.ts');
checkPatterns('Print Queue worker delegates label creation to createLabelV2 and reports retry eligibility structurally', printQueueService, [
  /const labelInput = order\.label;/,
  /createLabelV2\(\{\s*\.\.\.labelInput,/,
  /classifyLabelPurchaseRetry\(err\)/,
  /const retryEligible =[\s\S]*?retry\.retryEligible/,
  /const retryReason =[\s\S]*?retry\.retryReason/,
]);

const printQueueRoute = read('src/routes/print-queue.ts');
checkPatterns('Print Queue route preserves selectionRef into the worker intent', printQueueRoute, [
  /selectionRef: z\.string\(\)\.min\(1\)\.nullable\(\)\.optional\(\)/,
  /selectionRef: order\.label\.selectionRef/,
]);

const rateProof = read('web/src/lib/rate-proof.ts');
const rateProofCode = stripComments(rateProof);
// PS-422 retirement (2026-08-05): the legacy semantic-proof selector was deleted from this
// file (zero application callers). Its pin is dropped rather than repointed — the opaque
// selector below already carries the pass-through claim this check makes.
checkPatterns('frontend rate-proof helper remains pass-through over backend-issued proof/ref fields', rateProof, [
  /export function rateQuoteRefFromCandidates\(/,
  /hasBackendIssuedRateProof/,
  /rateProofFingerprint/,
]);
check('frontend rate-proof helper does not mint backend fingerprints or authority keys',
  !/createHash|buildShippingRateRequestFingerprint|selectedRateAuthorityKey|assertSelectedRateProofForLabelPurchase/.test(rateProofCode));

const rateBrowser = read('web/src/components/RateBrowserModal.tsx');
checkPatterns('Rate Browser lifts backend proof refs through Apply as pass-through fields', rateBrowser, [
  /function rateBackendProof\(r: RateRow\)/,
  /'rateQuoteId'/,
  /'selectedRateKey'/,
  /'selectionRef'/,
  /'requestFingerprint'/,
  /'proofSource'/,
  /findCanonicalBestRate\(canonicalBestRef\.current, \[r\]\)/,
]);

const apiClient = read('web/src/lib/v2-apiClient.ts');
const fetchRatesBlock = sliceBetween(apiClient, 'fetchRates(data: Record<string, unknown>)', '\n  fetchCachedRatesBulk');
const browseRatesBlock = sliceBetween(apiClient, 'browseRates(data: Record<string, unknown>)', '\n  // ');
const rateBrowseTransportBlock = sliceBetween(apiClient, 'async function postRateBrowseTransport(', '\nexport const apiClient');
checkPatterns('v2 api client has one backend /rates/browse transport and pass-through browser DTO', rateBrowseTransportBlock + browseRatesBlock, [
  /api\.post<any>\('\/rates\/browse'/,
  /translateRatePayloadToV4\(data\)/,
  /rateBrowseInflight/,
  /return postRateBrowseTransport\(data\)/,
]);
check('v2 api client does not rebuild browse best/proof/freshness metadata',
  !/bestRate\s*:|secondBestRate\s*:|requestFingerprint|cacheExpiresAt|proofSource|translateRateToLegacyDisplayShape/.test(browseRatesBlock));
check('v2 api client rate methods do not locally select combined[0] or sort cheapest as authority',
  fetchRatesBlock.length > 0 &&
  browseRatesBlock.length > 0 &&
  !/combined\s*\[\s*0\s*\]|combinedBestRate|\.sort\s*\(\s*\([^)]*(?:amount|cost|rate)/.test(fetchRatesBlock + browseRatesBlock));

if (failures > 0) {
  console.error(`\nFAIL PS-319 rate convergence certification guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-319 rate convergence certification guard');
