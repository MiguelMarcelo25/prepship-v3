/**
 * PS-269 guard - Print Queue residual certification.
 *
 * Offline/read-only only: no DB, no network, no providers, no labels, no
 * postage, no queue insert, no PDF print, no marketplace notifications, no
 * production data mutation, and no shipped/cancelled mutation. This guard pins
 * the residual Print Queue map after PS-303/317/318/319/326/330.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  classifyQueueOrderRouteServer,
  planQueueRouteForOrders,
  type QueueOrderRouteInput,
} from '../src/services/print-queue/queue-route-orchestrator';

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

function blockBetween(text: string, startNeedle: string, endNeedle: string): string {
  const start = text.indexOf(startNeedle);
  if (start < 0) return '';
  const end = text.indexOf(endNeedle, start + startNeedle.length);
  return text.slice(start, end > start ? end : start + 10_000);
}

const packageJson = read('package.json');
const docPath = 'docs/ps-tickets/ps-269-print-queue-residual-audit.md';
const doc = read(docPath);

check('package wires PS-269 Print Queue residual guard',
  /"test:ps-269-print-queue-residual-audit"\s*:\s*"tsx scripts\/ps-269-print-queue-residual-audit-guard\.ts"/.test(packageJson));

check('PS-269 Print Queue residual matrix exists', existsSync(docPath));
checkIncludesAll('PS-269 doc records no-new-owner scope and current finding', doc, [
  'PS-269 does not create a new Print Queue source of truth',
  'Print Queue residual scope',
  'Canonical owner map',
  'Imperfect data injection points',
  'No new unowned gap found',
  'No broad Print Queue rewrite',
]);

checkIncludesAll('PS-269 doc names backend Print Queue owner cluster', doc, [
  'src/services/print-queue.ts',
  'src/services/print-queue/queue-route-orchestrator.ts',
  'src/routes/print-queue.ts',
  'src/services/labels.ts#createLabelV2',
  'src/services/labels-direct.ts',
  'src/services/fulfillment/outbox.ts',
  'src/services/print-queue-pdf-store.ts',
  'web/src/components/Views/OrdersView.tsx',
  'PS-359 deleted the obsolete FE route-plan bridge',
]);

checkIncludesAll('PS-269 doc covers every Print Queue path requested by the card', doc, [
  'existing-label queue/reprint',
  'create-label-then-queue',
  'partial-success recovery',
  'duplicate-label prevention',
  'direct-carrier synthetic IDs',
  'queued, printed, shipped, and marketplace-confirmed states',
  'label/print state',
  'fulfillment outbox state',
  'marketplace-confirmation separation',
  'PRINT_QUEUE_BACKEND_ORCHESTRATION',
]);

checkIncludesAll('PS-269 doc classifies residual ownership buckets', doc, [
  'already guarded',
  'PS-330 canary-only',
  'new unowned gap',
]);

checkIncludesAll('PS-269 doc ties evidence to predecessor cards and commands', doc, [
  'PS-303',
  'PS-317',
  'PS-318',
  'PS-319',
  'PS-326',
  'PS-330',
  'test:ps-269-print-queue-residual-audit',
  'test:ps-303-print-queue-authority',
  'test:ps-303-fe-route-binding',
  'test:ps-317-fe-buy-anti-regression',
  'test:ps-318-shipping-workflow-certification',
  'test:ps-319-rate-convergence-certification',
  'test:ps-326-carrier-account-identity-certification',
  'test:print-to-queue-selected-rate-proof',
  'test:selected-rate-proof-boundary',
  'test:ps-098-shipping-purchase-boundary',
  'test:ps-053-print-queue-atomic',
  'test:ps-256-durable-print-queue-pdf',
  'test:ps-285-print-queue-evidence',
  'test:direct-carrier-labels',
  'test:direct-carrier-queue-route',
  'test:shipping-roundtrip-certification',
  'test:ps-330-controlled-canary-certification',
]);

checkIncludesAll('PS-269 doc records offline safety boundaries', doc, [
  'read-only/offline only',
  'No real labels',
  'No postage',
  'No queue insertions',
  'No PDF print',
  'No marketplace notifications',
  'No production order mutations',
  'No shipped/cancelled mutations',
]);

for (const command of [
  'test:ps-303-print-queue-authority',
  'test:ps-303-fe-route-binding',
  'test:ps-317-fe-buy-anti-regression',
  'test:ps-318-shipping-workflow-certification',
  'test:ps-319-rate-convergence-certification',
  'test:ps-326-carrier-account-identity-certification',
  'test:print-to-queue-selected-rate-proof',
  'test:selected-rate-proof-boundary',
  'test:ps-098-shipping-purchase-boundary',
  'test:ps-053-print-queue-atomic',
  'test:ps-256-durable-print-queue-pdf',
  'test:ps-285-print-queue-evidence',
  'test:direct-carrier-labels',
  'test:direct-carrier-queue-route',
  'test:shipping-roundtrip-certification',
  'test:ps-330-controlled-canary-certification',
]) {
  check(`package keeps PS-269 evidence command ${command}`, packageJson.includes(`"${command}"`));
}

const queueRoute = read('src/services/print-queue/queue-route-orchestrator.ts');
checkPatterns('queue route owner keeps never-buy rungs and direct-via-backend post-filter', queueRoute, [
  /export function classifyQueueOrderRouteServer/,
  /export function planQueueRouteForOrders/,
  /if \(options\.existingLabelOnly\) return 'backend'/,
  /if \(options\.batchTestMode\) return 'backend'/,
  /if \(input\.isTest\) return 'backend'/,
  /if \(input\.hasQueueableLabel\) return 'backend'/,
  /explicitPayloadProviderId/,
  /DIRECT_SYNTHETIC_PROVIDER_ID_FLOOR/,
  /if \(options\.directViaBackend === true && route === 'direct-create'\) return 'backend'/,
]);

const routeFixture = (extra: Partial<QueueOrderRouteInput> = {}): QueueOrderRouteInput => ({
  hasQueueableLabel: false,
  isTest: false,
  isDirectCarrier: false,
  backendQueueRoute: null,
  explicitPayloadProviderId: null,
  ...extra,
});
check('queue route behavior preserves existing-label/test never-buy rungs',
  classifyQueueOrderRouteServer(routeFixture({ hasQueueableLabel: true, isDirectCarrier: true })) === 'backend' &&
  classifyQueueOrderRouteServer(routeFixture({ isTest: true, isDirectCarrier: true })) === 'backend' &&
  classifyQueueOrderRouteServer(routeFixture({ isDirectCarrier: true }), { existingLabelOnly: true }) === 'backend' &&
  classifyQueueOrderRouteServer(routeFixture({ isDirectCarrier: true }), { batchTestMode: true }) === 'backend');
check('queue route behavior routes residual direct-carrier buys only until directViaBackend takes ownership',
  classifyQueueOrderRouteServer(routeFixture({ isDirectCarrier: true })) === 'direct-create' &&
  classifyQueueOrderRouteServer(routeFixture({ isDirectCarrier: true }), { directViaBackend: true }) === 'backend' &&
  planQueueRouteForOrders([
    { orderId: 2691, route: routeFixture({ isDirectCarrier: true }) },
    { orderId: 2692, route: routeFixture({ isDirectCarrier: false }) },
  ], { directViaBackend: true }).directCreateOrderIds.length === 0);
check('queue route behavior prevents synthetic explicit provider IDs from falling through when backend direct route is enabled',
  classifyQueueOrderRouteServer(routeFixture({
    isDirectCarrier: false,
    explicitPayloadProviderId: 10_000_269,
  }), { directViaBackend: true }) === 'backend');

const printQueue = read('src/services/print-queue.ts');
const processBlock = blockBetween(
  printQueue,
  'async function processQueueSendOrder',
  '// ---- CRUD',
);
checkPatterns('Print Queue worker owns existing-label, missing-label, recovery, normalization, and queue write sequence', processBlock, [
  /let existingLabelUrl = await timeQueueStep\([\s\S]*?findExistingQueueSendLabel\(order\)/,
  /const created = await timeQueueStep\(/,
  // Repointed 2026-08-05: the inline literal was hoisted to `const input = {...}` and
  // PS-444 added a receipt-resume branch ahead of the fresh buy. Both branches must take
  // the same scoped input; demanding an unconditional createLabelV2 would demand the
  // double-buy path.
  /resumeLabelV2FromDurableReceipt\(input, labelPurchaseScope\)[\s\S]*?createLabelV2\(input, labelPurchaseScope\)/,
  /const labelInput = order\.label/,
  /\.\.\.labelInput/,
  /labelUrl = created\.labelUrl/,
  /existingLabelUrl = getExistingLabelUrl\(err\)/,
  /const recoverCreatedLabelUrl = existingLabelUrl \?\? await timeQueueStep\([\s\S]*?findExistingQueueSendLabel\(order\)/,
  /if \(!recoverCreatedLabelUrl\) throw err/,
  /const queueableLabelUrl = normalizePrintQueueLabelUrl\(labelUrl\)/,
  /timeQueueStep\([\s\S]*?addToQueue\(\{/,
]);
// Repointed 2026-08-05: `createLabelV2({` -> `createLabelV2(input, labelPurchaseScope)`.
// The ordering invariant (look for an existing label BEFORE buying one) is unchanged.
check('Print Queue worker checks existing label before createLabelV2',
  processBlock.indexOf('findExistingQueueSendLabel(order)') >= 0 &&
  processBlock.indexOf('createLabelV2(input, labelPurchaseScope)') > processBlock.indexOf('findExistingQueueSendLabel(order)'));

checkPatterns('Print Queue addToQueue owns duplicate queue idempotency and confirmation repair', printQueue, [
  /export async function addToQueue/,
  /normalizePrintQueueLabelUrl\(input\.labelUrl\)/,
  /target: \[printQueue\.orderId, printQueue\.clientId\]/,
  /status: 'queued'/,
  /alreadyQueued/,
  /await repairMissingConfirmationForQueuedLabel\(input\.orderId\)/,
  /ensureShipmentConfirmationLifecycle\(\{/,
  /processFulfillmentOutboxOnce\(\{ orderId: parsedOrderId/,
]);
checkPatterns('Print Queue state transitions keep queued, printed, delivered, and PDF merge distinct', printQueue, [
  /if \(!includePrinted\) conds\.push\(eq\(printQueue\.status, 'queued'\)\)/,
  /export async function confirmPrintedQueueEntries/,
  /eq\(printQueue\.status, 'queued'\)/,
  /status: 'printed'/,
  /export async function removeQueueEntriesForOrder\(orderId: number\): Promise<number> \{\s*void orderId;\s*return 0;/,
  /status: 'delivered'/,
]);
// PS-403 (9d12ad47) removed the "PDF is not proof of physical printing" doctrine COMMENT from the
// runMergeJob finalization during the chunked-PDF rewrite; its canonical home is now the residual
// matrix doc. Behavioral distinctness stays pinned structurally above (confirm requires
// queued->printed; merge produces a separate MergeJob). Pin the doctrine where it now lives.
check('PS-269 doc keeps the PDF-is-not-proof-of-physical-printing doctrine (relocated from print-queue.ts by PS-403 chunking)',
  /PDF generation\/open\/download is not proof of physical printing; explicit confirm moves only successful queued entry ids to `printed`/.test(doc));

// 1bf6d37a ("Fix print queue interrupted retry status") added a third structural classifier
// (labelPurchaseInProgress) to the retry ladder — still typed classifiers, never raw
// proof-message parsing.
checkPatterns('Print Queue job reports structural retry eligibility instead of raw proof-message ownership', printQueue, [
  /classifyLabelPurchaseRetry\(err\)/,
  /const staleLabelAttempt = isQueueSendStaleLabelAttemptError\(err\)/,
  /const labelPurchaseInProgress = isLabelPurchaseInProgressError\(err\)/,
  // ── Repointed 2026-08-05, and this one was INVERTED, not merely stale. ──
  //
  // It required:  const retryEligible = staleLabelAttempt || labelPurchaseInProgress || retry.retryEligible
  // i.e. an in-flight label purchase made the job RETRYABLE and offered the operator a
  // retry button. PS-444 flipped that to `&& !labelPurchaseInProgress` for the reason
  // stated at the site: "PS-444 never presents an active/unknown label purchase as a
  // retryable buy. It is held for reconciliation so a user retry cannot double-purchase."
  //
  // So the guard was pinning a real money defect -- satisfying it means an operator can
  // press retry on a purchase that is still in flight and buy a second label with real
  // postage. Third guard in this sweep found asserting the defect rather than the fix,
  // and the most expensive of the three. Flipped to require the exclusion, and to require
  // that every reconciliation-pending condition is excluded rather than only this one.
  /const retryEligible = ![\s\S]{0,400}?&& !labelPurchaseInProgress[\s\S]{0,400}?&& \(staleLabelAttempt \|\| retry\.retryEligible\)/,
  /const retryReason = [\s\S]{0,600}?'label_purchase_reconciliation_required'/,
  /retryEligible,\s*retryReason,/,
  /retryEligible\s*\?\s*'failed_retryable'\s*:\s*'failed_terminal'/,
  /blockedReason: retryReason \?\? null/,
  /persistQueueSendJobSnapshot\(job, \{ required: true \}\)/,
]);

const printQueueRoute = read('src/routes/print-queue.ts');
checkPatterns('Print Queue route forwards proof refs and delegates batch-send to backend job owner', printQueueRoute, [
  /selectedRateProof: z/,
  /\.passthrough\(\)/,
  /rateQuoteId: z\.string\(\)\.min\(1\)\.nullable\(\)\.optional\(\)/,
  /selectedRateKey: z\.string\(\)\.min\(1\)\.nullable\(\)\.optional\(\)/,
  /selectedRateProof: order\.label\.selectedRateProof/,
  /rateQuoteId: order\.label\.rateQuoteId/,
  /selectedRateKey: order\.label\.selectedRateKey/,
  /const result = await startQueueSendJob\(\{/,
]);
checkPatterns('Print Queue route-plan is flag-gated, pure, and backend-owned', printQueueRoute, [
  /if \(!env\.PRINT_QUEUE_BACKEND_ORCHESTRATION\)/,
  /code: 'FEATURE_DISABLED'/,
  /const plan = planQueueRouteForOrders\(/,
  /backend_order_ids: plan\.backendOrderIds/,
  /direct_create_order_ids: plan\.directCreateOrderIds/,
  /directViaBackend: env\.PRINT_QUEUE_DIRECT_VIA_BACKEND/,
]);
checkPatterns('Print Queue print/confirm routes only move explicit successful queued entries to printed', printQueueRoute, [
  /startPrintJob\(\{/,
  /successful_entry_ids/,
  /confirmPrintedQueueEntries\(\{/,
  /queueEntryIds: b\.queue_entry_ids/,
]);

const labels = read('src/services/labels.ts');
checkPatterns('createLabelV2 remains the missing-label purchase owner for queue-created labels', labels, [
  /export async function createLabelV2/,
  /await assertOrderSafeToShip\(order, \{ entryPoint: 'createLabelV2' \}\)/,
  /await assertLabelPurchaseRateSelection\(\{/,
  // Repointed 2026-08-05 (same as ps-267): PS-422 replaced the request-body rate facts at
  // the purchase boundary with one opaque backend-minted selectionRef, and moved the
  // purchaseShippingProviderId binding into the canonical rate-fingerprint owner.
  /assertLabelPurchaseRateSelection\(\{\s*selectionRef: body\.selectionRef,?\s*\}\)/,
  /resolveHugrabLabelPurchasePreflight\(\{/,
  /directLabelAccountRefFromProviderId\(body\.shippingProviderId\)/,
  /createDirectCarrierLabelForOrder\(\{/,
  /createCarrierLabel\('shipstation'/,
  /enqueueShipmentConfirmation\(\{/,
]);
check('createLabelV2 proof and HUGRAB gates run before provider purchase branches',
  (() => {
    const safety = labels.indexOf("await assertOrderSafeToShip(order, { entryPoint: 'createLabelV2' });");
    const proof = labels.indexOf('await assertLabelPurchaseRateSelection({', safety);
    const hugrab = labels.indexOf('const hugrabCoveragePreflight = resolveHugrabLabelPurchasePreflight({', proof);
    const direct = labels.indexOf('createDirectCarrierLabelForOrder({', hugrab);
    const shipstation = labels.indexOf("createCarrierLabel('shipstation'", hugrab);
    return safety > 0 && proof > safety && hugrab > proof && direct > hugrab && shipstation > hugrab;
  })());

const labelsDirect = read('src/services/labels-direct.ts');
checkPatterns('direct-carrier label owner preserves synthetic shipment ids and provider label identity', labelsDirect, [
  /resolveDirectLabelShipmentRef\(\{/,
  /providerLabelId/,
  /labelShipmentId/,
  /provider's real id is preserved in labelId/i,
  /labelUrl/,
]);

const ordersView = read('web/src/components/Views/OrdersView.tsx');
const ordersViewCode = stripComments(ordersView);
check('frontend direct-carrier buy remains deleted from OrdersView',
  !ordersViewCode.includes('createDirectCarrierLabelThenQueue') &&
  !/createDirectCarrierLabel(ThenQueue|ForOrder)?\s*\(/.test(ordersViewCode));
// Repointed 2026-08-05 (same finding as ps-267): PS-422 removed the FE-built semantic
// rate proof in favour of an opaque backend-minted selectionRef, because reconstructable
// rate fields cannot be purchase authority. PS-313 forbids the frontend minting
// selected-rate proof, and ps-422's own guard asserts the NEGATIVE of what this required.
checkIncludesAll('OrdersView sends Print Queue intent to the backend job owner', ordersView, [
  'function buildQueueSendOrderPayload',
  'sendOrdersToQueueBackend',
  'backendJobOrders',
  'buildRateQuoteRefForOrder',
]);
check('OrdersView Print Queue intent carries no reconstructable purchase proof',
  !/selectedRateProof: buildSelectedRateProofPayload/.test(ordersView) &&
    !/function buildQueueSendOrderPayload\([\s\S]*?selectedRateProof: buildSelectedRateProofPayload/.test(ordersView));

check('obsolete frontend route-plan bridge remains deleted',
  !existsSync('web/src/lib/resolve-backend-route-plan.ts') &&
  !existsSync('web/src/lib/shipping-routes.ts') &&
  !ordersViewCode.includes('resolveBackendRoutePlan') &&
  !ordersViewCode.includes('bindOrFallbackQueueRoute') &&
  !ordersViewCode.includes('classifyQueueOrderRoute'));

const envText = read('src/lib/env.ts');
checkIncludesAll('remaining Print Queue cutover flags default off', envText, [
  'PRINT_QUEUE_BACKEND_ORCHESTRATION: booleanFlag(false)',
  'PRINT_QUEUE_DIRECT_VIA_BACKEND: booleanFlag(false)',
]);
check('legacy durable-PDF env setting cannot disable mandatory PS-428 chunks',
  /durablePrintQueuePdfEnabled\(\): boolean \{\s*return true/.test(read('src/services/print-queue-pdf-store.ts')));
check('Print Queue FE delegation flag is removed', !envText.includes('PRINT_QUEUE_FE_DELEGATION'));

const ps303 = read('scripts/ps-303-print-queue-authority-guard.ts');
const ps317 = read('scripts/ps-317-fe-buy-anti-regression-guard.ts');
const ps318 = read('scripts/ps-318-shipping-workflow-certification-guard.ts');
checkIncludesAll('predecessor guards already pin core Print Queue authority boundaries', ps303 + ps317 + ps318, [
  'backend process checks for an existing queueable label before purchase',
  'backend process recovers labels created before a later queue failure',
  'FE direct-carrier buy',
  'Print Queue owner creates/recovers/queues labels through backend services',
]);

if (failures > 0) {
  console.error(`PS-269 Print Queue residual guard failed with ${failures} issue(s).`);
  process.exit(1);
}

console.log('PS-269 Print Queue residual guard passed.');
