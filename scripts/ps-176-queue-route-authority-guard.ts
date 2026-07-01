/**
 * PS-176 / PS-359 guard - queue route authority is backend-owned.
 *
 * The row workflow DTO can still stamp queueRoute, but the frontend no longer
 * imports a route classifier or route-plan bridge. All live Send-to-Queue
 * requests are backend job intent; the backend owner keeps the never-buy ladder
 * and direct-via-backend cutover.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  buildBestRateWorkflowDto,
  withOrderRowWorkflow,
  type OrderRowWorkflowFacts,
} from '../src/services/shipping-workflow/best-rate-workflow-dto';
import { classifyQueueOrderRouteServer } from '../src/services/print-queue/queue-route-orchestrator';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` - ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const baseFacts: OrderRowWorkflowFacts = {
  orderStatus: 'awaiting_shipment',
  externallyShipped: false,
  canonicalStatus: null,
  isTest: false,
  hasCompleteDims: true,
  hasWeight: true,
  hasShipment: false,
  hasQueueableLabel: false,
  isDirectCarrierSelection: false,
  bestRateCarrierCode: 'ups',
  bestRateServiceCode: 'ups_ground',
  canonicalCarrierCode: null,
  canonicalServiceCode: null,
  canonicalAccountNickname: null,
  selectedRateCarrierCode: null,
  providerAccountId: 607855,
};

function routeFor(facts: Partial<OrderRowWorkflowFacts>): string | undefined {
  const dto = buildBestRateWorkflowDto({ savedBestRate: null, source: 'none' });
  return withOrderRowWorkflow(dto, { ...baseFacts, ...facts }).queueRoute;
}

check('ShipStation selection needing a label -> backend', routeFor({}) === 'backend');
check('direct-carrier selection needing a label -> direct-create',
  routeFor({ isDirectCarrierSelection: true }) === 'direct-create');
check('existing queueable label -> backend even for direct selections',
  routeFor({ isDirectCarrierSelection: true, hasQueueableLabel: true }) === 'backend');
check('test order -> backend even for direct selections',
  routeFor({ isDirectCarrierSelection: true, isTest: true }) === 'backend');

const NEEDS_LABEL_DIRECT = {
  hasQueueableLabel: false,
  isTest: false,
  isDirectCarrier: true,
  backendQueueRoute: null,
  explicitPayloadProviderId: null,
};
check('backend owner honors backend policy for the residual decision',
  classifyQueueOrderRouteServer({ ...NEEDS_LABEL_DIRECT, isDirectCarrier: false, backendQueueRoute: 'direct-create' }) === 'direct-create' &&
  classifyQueueOrderRouteServer({ ...NEEDS_LABEL_DIRECT, backendQueueRoute: 'backend' }) === 'backend');
check('backend owner never-buy ladder outranks stale direct-create policy',
  classifyQueueOrderRouteServer({ ...NEEDS_LABEL_DIRECT, hasQueueableLabel: true, backendQueueRoute: 'direct-create' }) === 'backend' &&
  classifyQueueOrderRouteServer({ ...NEEDS_LABEL_DIRECT, isTest: true, backendQueueRoute: 'direct-create' }) === 'backend');
check('backend owner operator options override everything',
  classifyQueueOrderRouteServer({ ...NEEDS_LABEL_DIRECT, backendQueueRoute: 'direct-create' }, { existingLabelOnly: true }) === 'backend' &&
  classifyQueueOrderRouteServer({ ...NEEDS_LABEL_DIRECT, backendQueueRoute: 'direct-create' }, { batchTestMode: true }) === 'backend');
check('backend owner can force residual direct routes through backend orchestration',
  classifyQueueOrderRouteServer({ ...NEEDS_LABEL_DIRECT, backendQueueRoute: 'direct-create' }, { directViaBackend: true }) === 'backend');

const ordersRoute = read('src/routes/orders.ts');
check('route derives queueable-label + direct-selection facts for the row workflow DTO',
  /rowHasQueueableLabel/.test(ordersRoute) &&
  /\[object Object\]/.test(ordersRoute) &&
  />= 10_000_000/.test(ordersRoute));

const ordersView = stripComments(read('web/src/components/Views/OrdersView.tsx'));
check('OrdersView has no frontend queue route classifier import/call',
  !ordersView.includes('classifyQueueOrderRoute') &&
  !ordersView.includes('resolveBackendRoutePlan') &&
  !ordersView.includes('bindOrFallbackQueueRoute'));
check('obsolete frontend route helper files stay deleted',
  !existsSync('web/src/lib/shipping-routes.ts') &&
  !existsSync('web/src/lib/resolve-backend-route-plan.ts'));
check('OrdersView sends backend job intent for every selected queue order',
  ordersView.includes('const backendJobOrders = jobOrders') &&
  ordersView.includes('buildQueueSendOrderPayload'));

const queueJobModule = read('web/src/components/Views/orders-persistent-queue-job.ts');
const snapStart = queueJobModule.indexOf('export function createQueueOrderSnapshot');
const snapBlock = queueJobModule.slice(snapStart, queueJobModule.indexOf('\n}', snapStart));
check('persisted queue snapshot carries identifiers only',
  snapStart > 0 &&
  !/bestRate/.test(snapBlock) && !/selectedRate/.test(snapBlock) &&
  !/label:/.test(snapBlock) && !/shipping/.test(snapBlock) && !/raw/.test(snapBlock));
check('OrdersView consumes queue-job machinery from the strict module',
  ordersView.includes("from './orders-persistent-queue-job'") &&
  !/\nfunction createQueueOrderSnapshot/.test(ordersView) &&
  !/\nfunction readPersistentQueueJob/.test(ordersView));

const resumeStart = ordersView.indexOf('async function resumePersistentQueueJob');
const resumeEnd = ordersView.indexOf('\n  useEffect', resumeStart);
const resumeBlock = ordersView.slice(resumeStart, resumeEnd > 0 ? resumeEnd : resumeStart + 9000);
check('resume never buys labels',
  resumeStart > 0 && !/apiClient\.createLabel\(/.test(resumeBlock));
check('interrupted batch-queue jobs hand control back to the operator',
  /Queue send was interrupted/.test(resumeBlock) && /Print to Queue again/.test(resumeBlock));
check('existing-label resume re-reads the label fresh from the backend',
  /apiClient\.retrieveLabel\(ref\.orderId, true\)/.test(resumeBlock));
check('backend-job resume path intact',
  /job\.backendJobId/.test(resumeBlock) && /pollBackendQueueSendJob\(job\.backendJobId/.test(resumeBlock));

if (failures > 0) {
  console.error(`\nFAIL PS-176 queue route authority guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-176 queue route authority guard');
