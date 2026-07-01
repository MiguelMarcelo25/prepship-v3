/**
 * PS-279 / PS-359 backend Send-to-Queue orchestration guard.
 *
 * The route decision lives in src/services/print-queue. The old frontend
 * route-plan bridge is deleted; OrdersView sends backend job intent only.
 * Pure/offline: imports the real orchestrator and reads files as text.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  classifyQueueOrderRouteServer,
  planQueueRouteForOrders,
  type QueueOrderRouteInput,
} from '../src/services/print-queue/queue-route-orchestrator';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

function readText(rel: string): string {
  return existsSync(rel) ? readFileSync(rel, 'utf8') : '';
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const base = (extra: Partial<QueueOrderRouteInput> = {}): QueueOrderRouteInput => ({
  hasQueueableLabel: false,
  isTest: false,
  isDirectCarrier: false,
  backendQueueRoute: null,
  explicitPayloadProviderId: null,
  ...extra,
});

check('the orchestrator lives in src/services/print-queue/',
  existsSync('src/services/print-queue/queue-route-orchestrator.ts'));
check('existingLabelOnly -> backend (never buy)',
  classifyQueueOrderRouteServer(base({ isDirectCarrier: true }), { existingLabelOnly: true }) === 'backend');
check('batchTestMode -> backend (mock, never buy)',
  classifyQueueOrderRouteServer(base({ isDirectCarrier: true }), { batchTestMode: true }) === 'backend');
check('test order -> backend (mock)',
  classifyQueueOrderRouteServer(base({ isTest: true, isDirectCarrier: true })) === 'backend');
check('existing queueable label -> backend',
  classifyQueueOrderRouteServer(base({ hasQueueableLabel: true, isDirectCarrier: true })) === 'backend');
check('direct-carrier order needing a label -> direct-create classification',
  classifyQueueOrderRouteServer(base({ isDirectCarrier: true })) === 'direct-create');
check('ShipStation order needing a label -> backend',
  classifyQueueOrderRouteServer(base({ isDirectCarrier: false })) === 'backend');
check('explicit synthetic-direct payload id -> direct-create classification',
  classifyQueueOrderRouteServer(base({ explicitPayloadProviderId: 10_000_001 })) === 'direct-create');
check('explicit ShipStation payload id -> backend',
  classifyQueueOrderRouteServer(base({ explicitPayloadProviderId: 42 })) === 'backend');
check('never-buy rungs outrank explicit direct payload',
  classifyQueueOrderRouteServer(base({ hasQueueableLabel: true, explicitPayloadProviderId: 10_000_001 })) === 'backend');

{
  const plan = planQueueRouteForOrders([
    { orderId: 1, route: base({ isDirectCarrier: true }) },
    { orderId: 2, route: base({ isDirectCarrier: false }) },
    { orderId: 3, route: base({ hasQueueableLabel: true }) },
    { orderId: 4, route: base({ isTest: true, isDirectCarrier: true }) },
  ], { directViaBackend: true });
  check('plan can route all selected orders through backend orchestration',
    JSON.stringify(plan.backendOrderIds) === JSON.stringify([1, 2, 3, 4]) &&
    plan.directCreateOrderIds.length === 0);
  check('plan returns a per-order route for every order',
    plan.plans.length === 4 && plan.plans.every((p) => p.route === 'backend'));
}

const src = readText('src/services/print-queue/queue-route-orchestrator.ts');
check('orchestrator imports DIRECT_SYNTHETIC_PROVIDER_ID_FLOOR',
  src.includes('DIRECT_SYNTHETIC_PROVIDER_ID_FLOOR') &&
  src.includes("from '../shipping-workflow/rate-fingerprint'"));
check('orchestrator is pure (no db/network imports)',
  !/from ['"].*\/db['"]/.test(src) && !src.includes('drizzle') && !src.includes('fetch('));

const route = readText('src/routes/print-queue.ts');
check("POST /route-plan is still registered for backend diagnostics/canary",
  route.includes("app.post('/route-plan'"));
check('route-plan is gated on PRINT_QUEUE_BACKEND_ORCHESTRATION',
  route.includes('env.PRINT_QUEUE_BACKEND_ORCHESTRATION'));
check('route-plan returns 503 FEATURE_DISABLED when OFF',
  route.includes("'FEATURE_DISABLED'") && route.includes('503'));
check('route-plan delegates to the server orchestrator',
  route.includes('planQueueRouteForOrders'));
check('existing /batch-send route is left intact',
  route.includes("app.post('/batch-send'") &&
  route.includes("app.get('/batch-send/status/:jobId'"));

const envText = readText('src/lib/env.ts');
check('PRINT_QUEUE_BACKEND_ORCHESTRATION is declared default-OFF',
  envText.includes('PRINT_QUEUE_BACKEND_ORCHESTRATION: booleanFlag(false)'));
check('PRINT_QUEUE_FE_DELEGATION is removed',
  !envText.includes('PRINT_QUEUE_FE_DELEGATION'));

const orders = stripComments(readText('web/src/components/Views/OrdersView.tsx'));
check('OrdersView no longer calls apiClient.createLabel from Send-to-Queue routing',
  !/createDirectCarrierLabelThenQueue/.test(orders));
check('OrdersView no longer imports/calls FE route bridge',
  !orders.includes('classifyQueueOrderRoute') &&
  !orders.includes('resolveBackendRoutePlan') &&
  !orders.includes('bindOrFallbackQueueRoute') &&
  !orders.includes('printQueueFeDelegation'));
check('OrdersView sends every selected queue order through backend job payloads',
  orders.includes('const backendJobOrders = jobOrders') &&
  orders.includes('const prepared = backendJobOrders.map((order) => buildQueueSendOrderPayload(order, options))'));

const users = readText('src/routes/users.ts');
check('GET /users/me no longer exposes printQueueFeDelegation',
  !users.includes('printQueueFeDelegation') && !users.includes('PRINT_QUEUE_FE_DELEGATION'));

if (failures > 0) {
  console.error(`\nFAIL PS-279 backend orchestration guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-279 backend orchestration guard');
