/**
 * PS-303 guard - Print Queue create/recover/queue authority stays backend-owned.
 *
 * Offline only: no DB, no network, no providers, no labels, no postage, no
 * marketplace notifications, and no production data mutation. This guard pins
 * the current backend worker boundary plus the deferred frontend cutover state.
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
  try {
    // Normalize CRLF on read. Several sources in this repo are checked out with \r\n,
    // and any needle in this file that spans a line break is written with \n -- e.g. the
    // routePlanBlock end anchor "app.post(\n  '/clear'", which never matched because the
    // route file is CRLF. Combined with blockBetween's old silent truncation that failure
    // was invisible: the block just became an arbitrary 8,000-char window that happened
    // to be large enough for its assertions. Normalize once here rather than making every
    // multi-line needle carry \r\n?.
    return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return '';
  }
}

// Hardened 2026-08-05. This used to return '' when the START needle was missing and an
// arbitrary 8,000-character window when the END needle was missing. The second fallback
// is how this guard broke: `getMergedQueueLabels` was deleted from print-queue.ts, so
// runJobBlock silently became the first 8,000 chars of a ~14,000-char function and five
// of six clauses in the retry check were looking at text that was no longer in scope. No
// regex fix could have repaired that, because the property had left the window.
//
// A missing anchor is a broken guard, not a smaller guard. Say so instead of narrowing
// the search area and letting the assertions explain it badly -- and note that for any
// NEGATIVE assertion (!block.includes(...)) a silently-truncated block passes VACUOUSLY,
// which is the same failure wearing a green tick.
function blockBetween(text: string, startNeedle: string, endNeedle: string): string {
  const start = text.indexOf(startNeedle);
  if (start < 0) {
    console.error(`FAIL blockBetween: start anchor is gone from the source: ${startNeedle}`);
    process.exit(1);
  }
  const end = text.indexOf(endNeedle, start + startNeedle.length);
  if (end <= start) {
    console.error(`FAIL blockBetween: end anchor is gone from the source: ${endNeedle}`);
    console.error('  (a truncated block makes positive checks fail for the wrong reason and negative checks pass vacuously)');
    process.exit(1);
  }
  return text.slice(start, end);
}

const baseRoute = (extra: Partial<QueueOrderRouteInput> = {}): QueueOrderRouteInput => ({
  hasQueueableLabel: false,
  isTest: false,
  isDirectCarrier: false,
  backendQueueRoute: null,
  explicitPayloadProviderId: null,
  ...extra,
});

const routePlan = planQueueRouteForOrders([
  { orderId: 301, route: baseRoute({ isDirectCarrier: true }) },
  { orderId: 302, route: baseRoute({ isDirectCarrier: false }) },
  { orderId: 303, route: baseRoute({ hasQueueableLabel: true, isDirectCarrier: true }) },
  { orderId: 304, route: baseRoute({ isTest: true, isDirectCarrier: true }) },
]);

check('route planner sends only direct-carrier orders needing labels to direct-create',
  JSON.stringify(routePlan.directCreateOrderIds) === JSON.stringify([301]));
check('route planner sends ShipStation, existing-label, and test orders to backend',
  JSON.stringify(routePlan.backendOrderIds) === JSON.stringify([302, 303, 304]));
check('never-buy rungs outrank explicit direct payloads',
  classifyQueueOrderRouteServer(
    baseRoute({ hasQueueableLabel: true, explicitPayloadProviderId: 10_000_001 }),
  ) === 'backend' &&
  classifyQueueOrderRouteServer(
    baseRoute({ isTest: true, explicitPayloadProviderId: 10_000_001 }),
  ) === 'backend');
check('explicit payload provider controls only the residual route question',
  classifyQueueOrderRouteServer(
    baseRoute({ isDirectCarrier: true, explicitPayloadProviderId: 42 }),
  ) === 'backend' &&
  classifyQueueOrderRouteServer(
    baseRoute({ isDirectCarrier: false, explicitPayloadProviderId: 10_000_001 }),
  ) === 'direct-create');

// PS-306/PS-317 (A1) â€” directViaBackend post-filter. OFF/absent is byte-identical; ON turns a
// would-be FE 'direct-create' buy into a BACKEND create (createLabelV2 owns the direct buy). The
// red-team invariant: it can ONLY reduce FE buys â€” never add one, never override a never-buy rung.
check('directViaBackend OFF/absent â†’ byte-identical (direct order still direct-create)',
  classifyQueueOrderRouteServer(baseRoute({ isDirectCarrier: true })) === 'direct-create' &&
  classifyQueueOrderRouteServer(baseRoute({ isDirectCarrier: true }), {}) === 'direct-create');
check('directViaBackend ON â†’ a direct-carrier order needing a label routes to BACKEND (not a FE buy)',
  classifyQueueOrderRouteServer(baseRoute({ isDirectCarrier: true }), { directViaBackend: true }) === 'backend' &&
  classifyQueueOrderRouteServer(baseRoute({ isDirectCarrier: true, explicitPayloadProviderId: 10_000_001 }), { directViaBackend: true }) === 'backend');
check('directViaBackend ON NEVER creates a buy: test / existing-label / ShipStation stay backend',
  classifyQueueOrderRouteServer(baseRoute({ isTest: true, isDirectCarrier: true }), { directViaBackend: true }) === 'backend' &&
  classifyQueueOrderRouteServer(baseRoute({ hasQueueableLabel: true, isDirectCarrier: true }), { directViaBackend: true }) === 'backend' &&
  classifyQueueOrderRouteServer(baseRoute({ isDirectCarrier: false }), { directViaBackend: true }) === 'backend');
check('directViaBackend ON â†’ route planner yields ZERO direct-create (all buys move to the backend)',
  planQueueRouteForOrders([
    { orderId: 401, route: baseRoute({ isDirectCarrier: true }) },
    { orderId: 402, route: baseRoute({ isDirectCarrier: true, explicitPayloadProviderId: 10_000_001 }) },
  ], { directViaBackend: true }).directCreateOrderIds.length === 0);

const printQueueService = read('src/services/print-queue.ts');
const processBlock = blockBetween(
  printQueueService,
  'async function processQueueSendOrder',
  'export async function listQueue',
);
const startJobBlock = blockBetween(
  printQueueService,
  'export async function startQueueSendJob',
  'export function getQueueSendJobStatus',
);
const runJobBlock = blockBetween(
  printQueueService,
  'async function runQueueSendJob',
  // Repointed 2026-08-05: getMergedQueueLabels no longer exists anywhere in src/.
  // removeFromQueue is the next top-level export after runQueueSendJob, so this spans
  // the whole function again instead of the first 8,000 characters of it.
  'export async function removeFromQueue',
);

// Repointed 2026-08-05: the inline label payload was hoisted to `const input = {...}`,
// and PS-444 added a durable receipt-resume branch ahead of the fresh buy. A guard
// demanding an unconditional createLabelV2 demands the double-buy path -- on a resume the
// postage already exists and only the response was lost. Require both branches to take
// the same scoped input instead.
const findExistingIndex = processBlock.indexOf('findExistingQueueSendLabel(order)');
const createLabelIndex = processBlock.indexOf('createLabelV2(input, labelPurchaseScope)');
const queueIndex = processBlock.indexOf('addToQueue({');

check('backend process checks for an existing queueable label before purchase',
  findExistingIndex >= 0 && createLabelIndex > findExistingIndex);
check('backend process creates missing labels through createLabelV2 with worker scope',
  processBlock.includes('const created = await timeQueueStep(') &&
  processBlock.includes('const labelInput = order.label') &&
  processBlock.includes('...labelInput') &&
  processBlock.includes('orderId: order.orderId') &&
  processBlock.includes('orderNumber: order.orderNumber ?? labelInput.orderNumber') &&
  processBlock.includes('createLabelV2(input, labelPurchaseScope)') &&
  processBlock.includes('resumeLabelV2FromDurableReceipt(input, labelPurchaseScope)'));
check('backend process recovers labels created before a later queue failure',
  processBlock.includes('existingLabelUrl = getExistingLabelUrl(err)') &&
  processBlock.includes('findExistingQueueSendLabel(order)') &&
  processBlock.includes('if (!recoverCreatedLabelUrl) throw err'));
check('backend process normalizes the final label URL before queue insert',
  processBlock.includes('const queueableLabelUrl = normalizePrintQueueLabelUrl(labelUrl)') &&
  queueIndex > processBlock.indexOf('const queueableLabelUrl = normalizePrintQueueLabelUrl(labelUrl)'));
check('backend process writes the final queue row through addToQueue',
  queueIndex >= 0 &&
  processBlock.includes('clientId: order.clientId') &&
  processBlock.includes('orderId: String(order.orderId)') &&
  processBlock.includes('labelUrl: queueableLabelUrl'));
check('backend addToQueue owns queue URL normalization and SKU identity derivation',
  printQueueService.includes('export async function addToQueue') &&
  printQueueService.includes('const labelUrl = normalizePrintQueueLabelUrl(input.labelUrl)') &&
  printQueueService.includes('buildQueueSkuIdentityFromItems('));
check('startQueueSendJob persists a durable worker job before worker dispatch',
  startJobBlock.includes('await persistQueueSendJobSnapshot(job, { required: true })') &&
  startJobBlock.includes('workerOrders: preflight.readyOrders') &&
  startJobBlock.includes('const enqueueResult = await enqueueQueueSendWorkerJob({') &&
  startJobBlock.includes('queueSendJobs.delete(jobId)') &&
  !startJobBlock.includes('void runQueueSendJob'));
// Repointed 2026-08-05: `const retryEligible = !labelPurchaseInProgress` no longer starts
// the expression -- PS-360 added `!localTailFailureState` ahead of it when queue-tail
// recovery became its own non-retryable state. Unlike ps-269, this guard was already on
// the CORRECT side of the PS-444 rule (it requires the EXCLUSION, i.e. an in-flight
// purchase is never offered as a retryable buy, so a user retry cannot double-purchase);
// it just pinned that exclusion's position in the chain. Assert that
// labelPurchaseInProgress is negated and ANDed into retryEligible wherever it sits.
check('worker calls the backend process and classifies retry eligibility structurally',
  runJobBlock.includes('processQueueSendOrder(order, order.scope ?? scope, {') &&
  runJobBlock.includes('classifyLabelPurchaseRetry(err)') &&
  runJobBlock.includes('const labelPurchaseInProgress = isLabelPurchaseInProgressError(err)') &&
  runJobBlock.includes('const providerPending = labelPurchaseInProgress') &&
  /const retryEligible = [\s\S]{0,400}?&&\s*!labelPurchaseInProgress\b/.test(runJobBlock) &&
  runJobBlock.includes("? 'label_purchase_reconciliation_required'"));

const printQueueRoute = read('src/routes/print-queue.ts');
const batchSendBlock = blockBetween(
  printQueueRoute,
  "app.post('/batch-send'",
  "app.get('/batch-send/status/:jobId'",
);
const routePlanBlock = blockBetween(
  printQueueRoute,
  "app.post('/route-plan'",
  "app.post(\n  '/clear'",
);

check('/batch-send schema preserves the opaque backend selectionRef',
  printQueueRoute.includes('selectionRef: z.string().min(1).nullable().optional()'));
check('/batch-send forwards selectionRef into the worker',
  batchSendBlock.includes('selectionRef: order.label.selectionRef'));
check('/batch-send starts the backend queue-send job, not a frontend purchase loop',
  batchSendBlock.includes('const result = await startQueueSendJob({') &&
  batchSendBlock.includes('orders: b.orders.map((order) => ({'));
check('/route-plan remains inert when backend orchestration is disabled',
  routePlanBlock.includes('if (!env.PRINT_QUEUE_BACKEND_ORCHESTRATION)') &&
  routePlanBlock.includes("code: 'FEATURE_DISABLED'") &&
  routePlanBlock.includes('503'));
check('/route-plan delegates route computation to the backend orchestrator',
  routePlanBlock.includes('const plan = planQueueRouteForOrders(') &&
  routePlanBlock.includes('backend_order_ids: plan.backendOrderIds') &&
  routePlanBlock.includes('direct_create_order_ids: plan.directCreateOrderIds'));

const labels = read('src/services/labels.ts');
const proofIndex = labels.indexOf('await assertLabelPurchaseRateSelection({');
const directBranchIndex = labels.indexOf('const directRef = directLabelAccountRefFromProviderId');
const shipStationBranchIndex = labels.indexOf('// Per user override unlock shipped data on 2026-06-06 (PS-106): carrier-family');

check('label purchase proof gate runs before direct and ShipStation provider branches',
  proofIndex >= 0 &&
  directBranchIndex > proofIndex &&
  shipStationBranchIndex > directBranchIndex);
check('label proof gate accepts the opaque selectionRef from the queue worker',
  labels.includes('selectionRef: body.selectionRef'));

const envText = read('src/lib/env.ts');
check('backend route-plan flag defaults off',
  envText.includes('PRINT_QUEUE_BACKEND_ORCHESTRATION: booleanFlag(false)'));
check('frontend queue delegation flag is removed after PS-359',
  !envText.includes('PRINT_QUEUE_FE_DELEGATION'));

const ordersView = read('web/src/components/Views/OrdersView.tsx');
const ordersViewCode = ordersView
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');
check('obsolete frontend route-plan helper is deleted',
  !existsSync('web/src/lib/resolve-backend-route-plan.ts'));
check('obsolete frontend route classifier helper is deleted',
  !existsSync('web/src/lib/shipping-routes.ts'));
check('frontend route decision bridge is deleted after PS-359',
  !ordersViewCode.includes('printQueueFeDelegation') &&
  !ordersViewCode.includes('resolveBackendRoutePlan') &&
  !ordersViewCode.includes('bindOrFallbackQueueRoute') &&
  !ordersViewCode.includes('classifyQueueOrderRoute') &&
  ordersViewCode.includes('const backendJobOrders = jobOrders'));
const workflowDoc = read('docs/ps-tickets/ps-300-active-lawrence-execution-workflow.md');
check('workflow doc records PS-303 print queue authority guard',
  workflowDoc.includes('test:ps-303-print-queue-authority'));

const packageJson = read('package.json');
check('package wires PS-303 print queue authority guard',
  /"test:ps-303-print-queue-authority"\s*:\s*"tsx scripts\/ps-303-print-queue-authority-guard\.ts"/.test(packageJson));
check('package still wires predecessor Print Queue guards',
  packageJson.includes('"test:ps-279-backend-orchestration"') &&
  packageJson.includes('"test:ps-202-direct-label-owner"') &&
  packageJson.includes('"test:print-to-queue-selected-rate-proof"'));

if (failures > 0) {
  console.error(`\nFAIL PS-303 Print Queue authority guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-303 Print Queue authority guard');
