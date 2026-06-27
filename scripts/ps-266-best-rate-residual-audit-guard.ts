/**
 * PS-266 guard - post-SOT Best Rate residual audit.
 *
 * Offline/read-only only: no DB, no network, no providers, no labels, no
 * postage, no marketplace notifications, no production data mutation, and no
 * shipped/cancelled mutation. This guard pins the residual map and verifies
 * the current Best Rate workflow still delegates to the existing backend
 * source-of-truth owners instead of creating another rate authority.
 */
import { existsSync, readFileSync } from 'node:fs';

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

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function checkIncludesAll(name: string, text: string, values: string[]): void {
  const missing = values.filter((value) => !text.includes(value));
  check(name, missing.length === 0, missing);
}

function checkPatterns(name: string, text: string, patterns: RegExp[]): void {
  const missing = patterns.map((pattern) => pattern.source).filter((_, index) => !patterns[index].test(text));
  check(name, missing.length === 0, missing);
}

const packageJson = read('package.json');
const docPath = 'docs/ps-tickets/ps-266-best-rate-residual-audit.md';
const doc = read(docPath);

check('package wires PS-266 residual audit guard',
  /"test:ps-266-best-rate-residual-audit"\s*:\s*"tsx scripts\/ps-266-best-rate-residual-audit-guard\.ts"/.test(packageJson));

check('PS-266 residual audit doc exists', existsSync(docPath));
checkIncludesAll('PS-266 doc records scope, owner placement, and no-new-owner rule', doc, [
  'PS-266 does not create a new Best Rate source of truth',
  'Residual audit scope',
  'Canonical owner map',
  'Imperfect data injection points',
  'No new unowned gap found',
  'No duplicate broad implementation',
]);

checkIncludesAll('PS-266 doc names the backend rate owner cluster', doc, [
  'src/services/rates-combined.ts',
  'src/services/rates.ts',
  'src/services/shipping-workflow/best-rate-workflow-dto.ts',
  'src/services/shipping-workflow/rate-quote-snapshot-store.ts',
  'src/services/shipping-workflow/rate-fingerprint.ts',
  'src/services/shipping-workflow/rate-money.ts',
]);

checkIncludesAll('PS-266 doc covers every residual workflow requested by the card', doc, [
  'Awaiting row',
  'Rate Browser',
  'Recalculate',
  'Apply Best Rate',
  'Create Label',
  'Print Queue',
  'cached/saved rate freshness',
  'HUGRAB-disabled/automation-disabled services',
  'marked-up customer charge',
  'insurance',
  'confirmation',
  'account scope',
  'service eligibility',
]);

checkIncludesAll('PS-266 doc uses the required classification buckets', doc, [
  'already covered',
  'PS-328-owned',
  'PS-330-owned',
  'live/canary-only',
  'new unowned gap',
]);

checkIncludesAll('PS-266 doc ties evidence to predecessor tickets and commands', doc, [
  'PS-313',
  'PS-319',
  'PS-320',
  'PS-321',
  'PS-326',
  'PS-327',
  'PS-328',
  'PS-330',
  'PS-333',
  'PS-334',
  'PS-335',
  'test:rate-source-of-truth',
  'test:ps-319-rate-convergence-certification',
  'test:ps-320-v2-api-client-transport',
  'test:ps-321-ratebrowsermodal-thin-ui',
  'test:ps-326-carrier-account-identity-certification',
  'test:ps-327-hugrab-margin-policy',
  'test:ps-328-rerate-warning-reason',
  'test:ps-330-controlled-canary-certification',
  'test:ps-333-hugrab-current-rate-sot',
  'test:ps-334-house-rate-column',
  'test:sot-guard-pack',
]);

checkIncludesAll('PS-266 doc records offline safety boundaries', doc, [
  'read-only/offline only',
  'No real labels',
  'No postage',
  'No marketplace notifications',
  'No production order mutations',
  'No shipped/cancelled mutations',
]);

for (const command of [
  'test:rate-source-of-truth',
  'test:ps-319-rate-convergence-certification',
  'test:ps-320-v2-api-client-transport',
  'test:ps-321-ratebrowsermodal-thin-ui',
  'test:ps-326-carrier-account-identity-certification',
  'test:ps-327-hugrab-margin-policy',
  'test:ps-328-rerate-warning-reason',
  'test:ps-330-controlled-canary-certification',
  'test:ps-333-hugrab-current-rate-sot',
  'test:ps-334-house-rate-column',
  'test:sot-guard-pack',
]) {
  check(`package keeps PS-266 evidence command ${command}`, packageJson.includes(`"${command}"`));
}

const combinedOwner = read('src/services/rates-combined.ts');
checkPatterns('combined rate owner still owns priced ranking and complete/second-best facts', combinedOwner, [
  /export function combineCarrierUniverses\(/,
  /function customerShippingAmount\(/,
  /export function isPricedRate\(/,
  /\.filter\(isPricedRate\)\.sort\(\(a, b\) => rateTotal\(a\) - rateTotal\(b\)\)/,
  /const secondCheapest = rankedEligibleRates\[1\] \?\? null/,
  /bestRateComplete/,
]);

const ratesRoute = read('src/routes/rates.ts');
checkPatterns('Rate Browser route delegates combined selection and quote proof to backend owners', ratesRoute, [
  /import \{[^}]*combineCarrierUniverses[^}]*rateTotal[^}]*\} from '\.\.\/services\/rates-combined'/,
  /const combined = combineCarrierUniverses\(\{/,
  /finalizeBestRateWithQuote\(\{/,
  /bestRateComplete/,
  /secondBestRate/,
  /loadShippingAutomationRules/,
  /evaluateOrderCarrierEligibility/,
]);

const ratesBackfill = read('src/services/rates-backfill.ts');
checkPatterns('Best Rate backfill delegates to the same combined owner and quote finalizer', ratesBackfill, [
  /import \{ combineCarrierUniverses \} from '\.\/rates-combined'/,
  /const combined = combineCarrierUniverses\(\{/,
  /const secondBest = combined\.secondCheapest/,
  /finalizeBestRateWithQuote\(\{/,
  /bestRateComplete: combined\.bestRateComplete/,
]);

const snapshotStore = read('src/services/shipping-workflow/rate-quote-snapshot-store.ts');
checkPatterns('quote snapshot store remains the backend proof/ref finalizer and purchase resolver', snapshotStore, [
  /export async function finalizeBestRateWithQuote/,
  /export function withSelectedRateKeys/,
  /export async function assertLabelPurchaseRateSelection/,
  /resolveRateQuoteForPurchase\(\{/,
  /selected_rate_not_best/,
  /snapshot_not_final/,
]);

const labelsService = read('src/services/labels.ts');
const proofIndex = labelsService.indexOf('await assertLabelPurchaseRateSelection({');
const directIndex = labelsService.indexOf('const directRef = directLabelAccountRefFromProviderId', proofIndex);
const directBuyIndex = labelsService.indexOf('createDirectCarrierLabelForOrder({', proofIndex);
const shipStationBuyIndex = labelsService.indexOf("createCarrierLabel('shipstation'", proofIndex);
check('label purchase proof gate still runs before direct-carrier and ShipStation purchase branches',
  proofIndex >= 0 && directIndex > proofIndex && directBuyIndex > proofIndex && shipStationBuyIndex > proofIndex);

const printQueueService = read('src/services/print-queue.ts');
checkPatterns('Print Queue delegates missing-label creation and retry classification to backend label/proof owners', printQueueService, [
  /import \{ createLabelV2/,
  /import \{ classifyLabelPurchaseRetry \}/,
  /const created = await createLabelV2\(\{/,
  /classifyLabelPurchaseRetry\(err\)/,
  /retryEligible: retry\.retryEligible/,
]);

const modal = read('web/src/components/RateBrowserModal.tsx');
const modalCode = stripComments(modal);
check('RateBrowserModal does not import or call the backend service-eligibility owner directly',
  !modalCode.includes('evaluateShippingServiceEligibility'));
checkIncludesAll('RateBrowserModal passes backend selected proof/ref and second-best fields through apply state', modal, [
  'canonicalBackendBest',
  'rateQuoteId',
  'selectedRateKey',
  'secondBestRate',
  'onApplyRate({',
]);

const panelFields = read('web/src/components/Views/OrdersPanelShippingFields.tsx');
check('side panel stale warning renders backend rerateCopy rather than inventing package-change copy',
  /packageFacts\.rerateCopy/.test(panelFields) && !/package changed/i.test(panelFields));

if (failures > 0) {
  console.error(`\nPS-266 best-rate residual audit guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}

console.log('\nPS-266 best-rate residual audit guard passed.');
