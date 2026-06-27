/**
 * PS-267 guard - post-SOT label purchase residual certification.
 *
 * Offline/read-only only: no DB, no network, no providers, no labels, no
 * postage, no queue insert, no marketplace notifications, no production data
 * mutation, and no shipped/cancelled mutation. This guard pins the residual
 * label-purchase map and verifies Create + Print, Rate Browser apply/save,
 * Print Queue create/recover/queue, direct-carrier, and ShipStation paths still
 * delegate to the existing backend source-of-truth owners.
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
const docPath = 'docs/ps-tickets/ps-267-label-purchase-residual-audit.md';
const doc = read(docPath);

check('package wires PS-267 label purchase residual guard',
  /"test:ps-267-label-purchase-residual-audit"\s*:\s*"tsx scripts\/ps-267-label-purchase-residual-audit-guard\.ts"/.test(packageJson));

check('PS-267 label purchase residual matrix exists', existsSync(docPath));
checkIncludesAll('PS-267 doc records no-new-owner scope and current finding', doc, [
  'PS-267 does not create a new label purchase source of truth',
  'Label purchase residual scope',
  'Canonical owner map',
  'Imperfect data injection points',
  'No new unowned gap found',
  'No broad label refactor',
]);

checkIncludesAll('PS-267 doc names backend label/proof owner cluster', doc, [
  'src/services/labels.ts#createLabelV2',
  'src/services/fulfillment/shipping-safety.ts',
  'src/services/shipping-workflow/rate-quote-snapshot-store.ts',
  'src/services/shipping-workflow/rate-fingerprint.ts',
  'src/services/shipping-workflow/hugrab-label-purchase-preflight.ts',
  'src/services/labels-direct.ts',
  'src/services/print-queue.ts',
  'src/services/print-queue/queue-route-orchestrator.ts',
  'src/services/fulfillment/outbox.ts',
]);

checkIncludesAll('PS-267 doc covers every label path requested by the card', doc, [
  'side panel Create + Print',
  'Rate Browser apply/save-to-label',
  'Print Queue create-and-queue',
  'existing-label requeue/reprint',
  'direct-carrier label route',
  'ShipStation label route',
  'selected-rate proof',
  'current fingerprint',
  'HUGRAB insurance proof',
  'duplicate active label protection',
  'carrier/account identity',
  'synthetic IDs cannot fall through to ShipStation',
]);

checkIncludesAll('PS-267 doc classifies residual ownership buckets', doc, [
  'already covered',
  'PS-328 impacted',
  'PS-330 canary-only',
  'new unowned gap',
]);

checkIncludesAll('PS-267 doc ties evidence to predecessor cards and commands', doc, [
  'PS-317',
  'PS-318',
  'PS-319',
  'PS-326',
  'PS-327',
  'PS-328',
  'PS-330',
  'test:ps-318-shipping-workflow-certification',
  'test:ps-319-rate-convergence-certification',
  'test:ps-326-carrier-account-identity-certification',
  'test:ps-327-hugrab-margin-policy',
  'test:selected-rate-proof-boundary',
  'test:print-to-queue-selected-rate-proof',
  'test:ps-098-shipping-purchase-boundary',
  'test:ps-261-hugrab-label-purchase-gate',
  'test:ps-303-print-queue-authority',
  'test:direct-carrier-labels',
  'test:direct-carrier-queue-route',
  'test:shipping-roundtrip-certification',
  'test:ps-330-controlled-canary-certification',
]);

checkIncludesAll('PS-267 doc records offline safety boundaries', doc, [
  'read-only/offline only',
  'No real labels',
  'No postage',
  'No queue insertions',
  'No marketplace notifications',
  'No production order mutations',
  'No shipped/cancelled mutations',
]);

for (const command of [
  'test:ps-318-shipping-workflow-certification',
  'test:ps-319-rate-convergence-certification',
  'test:ps-326-carrier-account-identity-certification',
  'test:ps-327-hugrab-margin-policy',
  'test:selected-rate-proof-boundary',
  'test:print-to-queue-selected-rate-proof',
  'test:ps-098-shipping-purchase-boundary',
  'test:ps-261-hugrab-label-purchase-gate',
  'test:ps-303-print-queue-authority',
  'test:direct-carrier-labels',
  'test:direct-carrier-queue-route',
  'test:shipping-roundtrip-certification',
  'test:ps-330-controlled-canary-certification',
]) {
  check(`package keeps PS-267 evidence command ${command}`, packageJson.includes(`"${command}"`));
}

const labelsService = read('src/services/labels.ts');
checkPatterns('createLabelV2 owns safety, proof, HUGRAB preflight, provider purchase, persistence, and confirmation enqueue', labelsService, [
  /export async function createLabelV2/,
  /await assertOrderSafeToShip\(order, \{ entryPoint: 'createLabelV2' \}\)/,
  /await assertLabelPurchaseRateSelection\(\{/,
  /purchaseShippingProviderId: body\.shippingProviderId/,
  /resolveHugrabLabelPurchasePreflight\(\{/,
  /directLabelAccountRefFromProviderId\(body\.shippingProviderId\)/,
  /createDirectCarrierLabelForOrder\(\{/,
  /createCarrierLabel\('shipstation'/,
  /async function persistCreatedLabel/,
  /selectedRateJson:/,
  /providerAccountNickname:/,
  /carrierProvider:/,
  /enqueueShipmentConfirmation\(\{/,
]);

check('label safety/proof/HUGRAB preflight all happen before provider purchase branches',
  (() => {
    const safetyIndex = labelsService.indexOf("await assertOrderSafeToShip(order, { entryPoint: 'createLabelV2' });");
    const proofIndex = labelsService.indexOf('await assertLabelPurchaseRateSelection({', safetyIndex);
    const hugrabIndex = labelsService.indexOf('const hugrabCoveragePreflight = resolveHugrabLabelPurchasePreflight({', proofIndex);
    const directIndex = labelsService.indexOf('createDirectCarrierLabelForOrder({', hugrabIndex);
    const shipStationIndex = labelsService.indexOf("createCarrierLabel('shipstation'", hugrabIndex);
    return safetyIndex >= 0 && proofIndex > safetyIndex && hugrabIndex > proofIndex &&
      directIndex > hugrabIndex && shipStationIndex > hugrabIndex;
  })());

const safetyOwner = read('src/services/fulfillment/shipping-safety.ts');
checkPatterns('shipping safety owner blocks terminal/upstream shipped states before side effects', safetyOwner, [
  /export function decideShippingSafety/,
  /Order is already shipped/,
  /Order was already shipped externally\/upstream/,
  /A shipped event was received from the source marketplace/,
  /export async function assertOrderSafeToShip/,
]);

const snapshotStore = read('src/services/shipping-workflow/rate-quote-snapshot-store.ts');
checkPatterns('selected-rate proof owner resolves snapshot refs and enforces exact purchase proof', snapshotStore, [
  /export async function assertLabelPurchaseRateSelection/,
  /rateQuoteId/,
  /selectedRateKey/,
  /selectedRateProof/,
  /assertSelectedRateProofForLabelPurchase/,
  /assertPurchaseAccountMatchesProof/,
  /snapshot_not_final/,
  /selected_rate_not_best/,
]);

const hugrabPreflight = read('src/services/shipping-workflow/hugrab-label-purchase-preflight.ts');
checkPatterns('HUGRAB label purchase preflight blocks unresolved insurance proof before provider calls', hugrabPreflight, [
  /export function resolveHugrabLabelPurchasePreflight/,
  /resolveInsuranceCertainty/,
  /resolveInsuranceCoverageStatus/,
  /resolveHugrabLabelPurchaseGate/,
  /coverage\.status/,
  /return \{\s*\.\.\.decision,/,
]);

const directStub = read('api/carriers/labels.ts');
check('legacy direct-carrier label API remains retired instead of bypassing createLabelV2',
  /LEGACY_LABEL_ENDPOINT_RETIRED|cannot purchase postage/i.test(directStub));

const printQueueService = read('src/services/print-queue.ts');
checkPatterns('Print Queue owner queues existing labels without rebuy and creates missing labels through createLabelV2', printQueueService, [
  /findExistingQueueableLabelForOrder/,
  /let existingLabelUrl = await findExistingQueueableLabelForOrder\(order\.orderId\)/,
  /if \(!labelUrl\) \{/,
  /const created = await createLabelV2\(\{/,
  /\.\.\.order\.label/,
  /const recoverCreatedLabelUrl = existingLabelUrl \?\? await findExistingQueueableLabelForOrder\(order\.orderId\)/,
  /normalizePrintQueueLabelUrl\(labelUrl\)/,
  /classifyLabelPurchaseRetry\(err\)/,
  /ensureShipmentConfirmationLifecycle\(\{/,
]);

const printQueueRoute = read('src/routes/print-queue.ts');
checkPatterns('Print Queue route preserves backend-issued proof refs into worker intent', printQueueRoute, [
  /selectedRateProof: z/,
  /rateQuoteId: z\.string\(\)\.min\(1\)\.nullable\(\)\.optional\(\)/,
  /selectedRateKey: z\.string\(\)\.min\(1\)\.nullable\(\)\.optional\(\)/,
  /selectedRateProof: order\.label\.selectedRateProof/,
  /rateQuoteId: order\.label\.rateQuoteId/,
  /selectedRateKey: order\.label\.selectedRateKey/,
]);

const queueRouteOwner = read('src/services/print-queue/queue-route-orchestrator.ts');
checkPatterns('Queue route owner preserves existing-label never-buy ladder and direct-via-backend cutover', queueRouteOwner, [
  /if \(options\.existingLabelOnly\) return 'backend'/,
  /if \(input\.hasQueueableLabel\) return 'backend'/,
  /if \(options\.directViaBackend === true && route === 'direct-create'\) return 'backend'/,
  /directCreateOrderIds/,
  /backendOrderIds/,
]);

const ordersView = read('web/src/components/Views/OrdersView.tsx');
const ordersViewCode = stripComments(ordersView);
check('frontend direct-carrier buy stays removed from OrdersView',
  !ordersViewCode.includes('createDirectCarrierLabelThenQueue'));
checkIncludesAll('OrdersView sends label/queue intent with backend-issued proof/ref fields', ordersView, [
  'buildSelectedRateProofPayload',
  'buildRateQuoteRefForOrder',
  'selectedRateProof:',
  'rateQuoteId',
  'sendOrdersToQueueBackend',
  'apiClient.createLabel',
]);
const rateProofHelper = read('web/src/components/Views/orders/best-rate/rate-proof.ts');
checkPatterns('rate proof helper returns backend rateQuoteId and selectedRateKey refs', rateProofHelper, [
  /export function buildRateQuoteRefForOrder/,
  /rateQuoteId/,
  /selectedRateKey/,
]);

const apiClient = read('web/src/lib/v2-apiClient.ts');
checkPatterns('v2 api client keeps Create Label and Print Queue as backend intent posts', apiClient, [
  /createLabel\(/,
  /api\.post<any>\('\/labels', payload\)/,
  /addToQueue\(/,
  /api\.post<any>\('\/print-queue\/add', payload\)/,
]);

if (failures > 0) {
  console.error(`\nPS-267 label purchase residual audit guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}

console.log('\nPS-267 label purchase residual audit guard passed.');
