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
  // Repointed (guard rot): the old inline customerShippingAmount() helper was
  // folded into rateTotal(), which reads the marked CUSTOMER charge
  // (cShippingRateAmount) — still the combined owner's Best Rate ranking basis.
  // PS-307/308 added a rateCostTotal() internal-cost tie-breaker to the sort.
  /export function rateTotal\(rate: CombinableRate\): number \{\s*return normalizeShippingRateMoney\(rate\)\.cShippingRateAmount \?\? 0/,
  /export function isPricedRate\(/,
  /const combinedRates = dedupeBrowseRates\(\[\.\.\.input\.ssRates, \.\.\.input\.directRates\]\.filter\(isPricedRate\)\)/,
  /const rankedEligibleRates = \[\.\.\.combinedRates\]\s*\.sort\(\(a, b\) => \(rateTotal\(a\) - rateTotal\(b\)\) \|\| \(rateCostTotal\(a\) - rateCostTotal\(b\)\)\)/,
  /const secondCheapest = rankedEligibleRates\[1\] \?\? null/,
  /bestRateComplete/,
]);

// Repointed (guard rot): the /browse combined-selection + quote-proof logic moved
// out of the route into src/services/rate-browse-response-producer.ts; the route
// now delegates to it via produceRateBrowsePayload(). Pin the delegation on the
// route AND the owner patterns in the producer (where they actually live now).
const ratesRoute = read('src/routes/rates.ts');
check('Rate Browser route delegates to the backend rate-browse producer (no inline rate authority)',
  /import \{ produceRateBrowsePayload \} from '\.\.\/services\/rate-browse-response-producer'/.test(ratesRoute) &&
    /produceRateBrowsePayload\(\{/.test(ratesRoute));
const rateBrowseProducer = read('src/services/rate-browse-response-producer.ts');
checkPatterns('Rate Browser producer delegates combined selection and quote proof to backend owners', rateBrowseProducer, [
  /import \{[^}]*combineCarrierUniverses[^}]*rateTotal[^}]*\} from '\.\/rates-combined'/,
  /const combined = combineCarrierUniverses\(\{/,
  /finalizeBestRateWithQuote\(\{/,
  /bestRateComplete/,
  /secondBestRate/,
  /evaluateOrderCarrierEligibility/,
]);

const ratesBackfill = read('src/services/rates-backfill.ts');
checkPatterns('Best Rate backfill delegates to the same combined owner and quote finalizer', ratesBackfill, [
  // Repointed (guard rot): the import now also pulls rateTotal, so the exact
  // single-name form drifted; the delegation itself is unchanged.
  /import \{[^}]*combineCarrierUniverses[^}]*\} from '\.\/rates-combined'/,
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
  // The import list grew past one line when PS-444 added the resume entry points, so
  // `import { createLabelV2` no longer sits on a single line. Match across the braces.
  /import \{[\s\S]{0,300}?\bcreateLabelV2,/,
  /import \{[\s\S]{0,300}?\bclassifyLabelPurchaseRetry\b/,
  // Repointed 2026-08-05. Two changes, the same pair already fixed in ps-261/267/269/303:
  //  - the label payload was hoisted to `const input = {...}` and PS-444 added a durable
  //    receipt-resume branch, so demanding an unconditional createLabelV2 demands the
  //    DOUBLE-BUY path: on a resume the postage already exists and only the response was
  //    lost, which is exactly what resuming from the receipt avoids paying for twice.
  //  - retryEligible used to OR IN labelPurchaseInProgress, presenting an in-flight
  //    purchase to the operator as a retryable buy. PS-444 flipped it to an exclusion so
  //    a user retry cannot double-purchase. This guard was pinning that defect.
  /const created = await timeQueueStep\(/,
  /resumeLabelV2FromDurableReceipt\(input, labelPurchaseScope\)[\s\S]*?createLabelV2\(input, labelPurchaseScope\)/,
  /classifyLabelPurchaseRetry\(err\)/,
  /const retryEligible = ![\s\S]{0,400}?&& !labelPurchaseInProgress\b/,
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
