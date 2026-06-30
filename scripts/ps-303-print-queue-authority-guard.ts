/**
 * PS-303 guard - Print Queue create/recover/queue authority stays backend-owned.
 *
 * Offline only: no DB, no network, no providers, no labels, no postage, no
 * marketplace notifications, and no production data mutation. This guard pins
 * the current backend worker boundary plus the deferred frontend cutover state.
 */
import { readFileSync } from 'node:fs';
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
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function blockBetween(text: string, startNeedle: string, endNeedle: string): string {
  const start = text.indexOf(startNeedle);
  if (start < 0) return '';
  const end = text.indexOf(endNeedle, start + startNeedle.length);
  return text.slice(start, end > start ? end : start + 8000);
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

// PS-306/PS-317 (A1) — directViaBackend post-filter. OFF/absent is byte-identical; ON turns a
// would-be FE 'direct-create' buy into a BACKEND create (createLabelV2 owns the direct buy). The
// red-team invariant: it can ONLY reduce FE buys — never add one, never override a never-buy rung.
check('directViaBackend OFF/absent → byte-identical (direct order still direct-create)',
  classifyQueueOrderRouteServer(baseRoute({ isDirectCarrier: true })) === 'direct-create' &&
  classifyQueueOrderRouteServer(baseRoute({ isDirectCarrier: true }), {}) === 'direct-create');
check('directViaBackend ON → a direct-carrier order needing a label routes to BACKEND (not a FE buy)',
  classifyQueueOrderRouteServer(baseRoute({ isDirectCarrier: true }), { directViaBackend: true }) === 'backend' &&
  classifyQueueOrderRouteServer(baseRoute({ isDirectCarrier: true, explicitPayloadProviderId: 10_000_001 }), { directViaBackend: true }) === 'backend');
check('directViaBackend ON NEVER creates a buy: test / existing-label / ShipStation stay backend',
  classifyQueueOrderRouteServer(baseRoute({ isTest: true, isDirectCarrier: true }), { directViaBackend: true }) === 'backend' &&
  classifyQueueOrderRouteServer(baseRoute({ hasQueueableLabel: true, isDirectCarrier: true }), { directViaBackend: true }) === 'backend' &&
  classifyQueueOrderRouteServer(baseRoute({ isDirectCarrier: false }), { directViaBackend: true }) === 'backend');
check('directViaBackend ON → route planner yields ZERO direct-create (all buys move to the backend)',
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
  'export async function getMergedQueueLabels',
);

const findExistingIndex = processBlock.indexOf('findExistingQueueSendLabel(order)');
const createLabelIndex = processBlock.indexOf('createLabelV2({');
const queueIndex = processBlock.indexOf('addToQueue({');

check('backend process checks for an existing queueable label before purchase',
  findExistingIndex >= 0 && createLabelIndex > findExistingIndex);
check('backend process creates missing labels through createLabelV2 with worker scope',
  processBlock.includes('const created = await timeQueueStep(') &&
  processBlock.includes('return await createLabelV2({') &&
  processBlock.includes('const labelInput = order.label') &&
  processBlock.includes('...labelInput') &&
  processBlock.includes('orderId: order.orderId') &&
  processBlock.includes('orderNumber: order.orderNumber ?? labelInput.orderNumber') &&
  processBlock.includes('}, GLOBAL_SCOPE)'));
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
check('startQueueSendJob persists a durable worker job before async processing',
  startJobBlock.includes('await persistQueueSendJobSnapshot(job, { required: true })') &&
  startJobBlock.includes('void runQueueSendJob(jobId, preflight.readyOrders, input.concurrency, input.scope)'));
check('worker calls the backend process and classifies retry eligibility structurally',
  runJobBlock.includes('processQueueSendOrder(order, order.scope ?? scope, {') &&
  runJobBlock.includes('classifyLabelPurchaseRetry(err)') &&
  runJobBlock.includes('const retryEligible = staleLabelAttempt || retry.retryEligible') &&
  runJobBlock.includes('const retryReason = staleLabelAttempt ? err.retryReason : retry.retryReason'));

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

check('/batch-send schema preserves backend selected-rate proof and snapshot refs',
  printQueueRoute.includes('selectedRateProof: z') &&
  printQueueRoute.includes('.passthrough()') &&
  printQueueRoute.includes('rateQuoteId: z.string().min(1).nullable().optional()') &&
  printQueueRoute.includes('selectedRateKey: z.string().min(1).nullable().optional()'));
check('/batch-send forwards selectedRateProof into startQueueSendJob label payload',
  batchSendBlock.includes('selectedRateProof: order.label.selectedRateProof'));
check('/batch-send forwards rateQuoteId and selectedRateKey into the worker',
  batchSendBlock.includes('rateQuoteId: order.label.rateQuoteId') &&
  batchSendBlock.includes('selectedRateKey: order.label.selectedRateKey'));
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
check('label proof gate accepts snapshot refs from the queue worker',
  labels.includes('rateQuoteId: body.rateQuoteId') &&
  labels.includes('selectedRateKey: body.selectedRateKey') &&
  labels.includes('selectedRateProof: body.selectedRateProof'));

const envText = read('src/lib/env.ts');
check('backend route-plan flag defaults off',
  envText.includes('PRINT_QUEUE_BACKEND_ORCHESTRATION: booleanFlag(false)'));
check('frontend queue delegation flag defaults off',
  envText.includes('PRINT_QUEUE_FE_DELEGATION: booleanFlag(false)'));

const routePlanHelper = read('web/src/lib/resolve-backend-route-plan.ts');
check('frontend route-plan helper fails safe to local fallback',
  routePlanHelper.includes('export async function resolveBackendRoutePlan') &&
  /catch\s*\{[\s\S]{0,180}return null/.test(routePlanHelper));

const ordersView = read('web/src/components/Views/OrdersView.tsx');
check('frontend Print Queue delegation is still flag-gated',
  ordersView.includes('printQueueFeDelegation') &&
  /if \(printQueueFeDelegation\)[\s\S]{0,500}resolveBackendRoutePlan\(/.test(ordersView));
// PS-303 (Per user override unlock shipped data on 2026-06-23): the buy-vs-defer route
// DECISION cutover is done — OrdersView consumes the backend plan as BINDING via
// bindOrFallbackQueueRoute when FE delegation is ON (an omitted order defers to 'backend',
// never a silent FE direct-buy). The FE createLabel direct-create path + the local
// classifier remain ONLY for the OFF default and 'direct-create' routes (the backend
// cannot create direct-carrier labels yet). Supersedes the prior "fallback remains until
// cutover" pin; the binding semantics are proven by test:ps-303-fe-route-binding.
check('frontend route DECISION binds to the backend plan when FE delegation is on (cutover done)',
  ordersView.includes('apiClient.createLabel') &&
  ordersView.includes('classifyQueueOrderRoute(') &&
  /bindOrFallbackQueueRoute\(\s*printQueueFeDelegation,/.test(ordersView));

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
