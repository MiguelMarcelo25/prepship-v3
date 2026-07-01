/**
 * PS-359 / PS-303 guard - frontend Print Queue route-plan bridge deletion.
 *
 * The backend queue job is now the source of truth for create/recover/queue
 * routing. The frontend may send queue intent and render job results, but it
 * must not keep a route-plan bridge, delegation flag, or local direct-vs-backend
 * classifier on the Print Queue money path.
 *
 * Offline only: reads files and imports the pure backend route orchestrator.
 * No DB, no network, no labels, no postage, no shipped/cancelled mutation.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  classifyQueueOrderRouteServer,
  planQueueRouteForOrders,
  type QueueOrderRouteInput,
} from '../src/services/print-queue/queue-route-orchestrator';

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
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

const ordersView = stripComments(read('web/src/components/Views/OrdersView.tsx'));
const env = read('src/lib/env.ts');
const usersRoute = read('src/routes/users.ts');
const printQueueRoute = read('src/routes/print-queue.ts');

check('obsolete FE route-plan helper file is deleted',
  !existsSync('web/src/lib/resolve-backend-route-plan.ts'));
check('obsolete FE shipping route classifier file is deleted',
  !existsSync('web/src/lib/shipping-routes.ts'));

check('OrdersView does not import or call the FE route-plan bridge',
  !ordersView.includes('resolveBackendRoutePlan') &&
  !ordersView.includes('bindOrFallbackQueueRoute') &&
  !ordersView.includes("'/print-queue/route-plan'") &&
  !ordersView.includes('"/print-queue/route-plan"'));
check('OrdersView does not import or call the FE queue route classifier',
  !ordersView.includes('classifyQueueOrderRoute'));
check('OrdersView no longer reads a printQueueFeDelegation switch',
  !ordersView.includes('printQueueFeDelegation'));
check('OrdersView sends all Send-to-Queue orders through backend job payloads',
  ordersView.includes('const backendJobOrders = jobOrders') &&
  ordersView.includes('const prepared = backendJobOrders.map((order) => buildQueueSendOrderPayload(order, options))'));
check('OrdersView no longer keeps inert direct-queue result assembly',
  !ordersView.includes('directQueuedItems') &&
  !ordersView.includes('directErrors') &&
  !ordersView.includes('directQueued'));

check('PRINT_QUEUE_FE_DELEGATION env flag is removed',
  !env.includes('PRINT_QUEUE_FE_DELEGATION'));
check('GET /users/me no longer exposes printQueueFeDelegation',
  !usersRoute.includes('printQueueFeDelegation'));

check('backend route-plan endpoint remains backend-only and flag-gated',
  printQueueRoute.includes("app.post('/route-plan'") &&
  printQueueRoute.includes('env.PRINT_QUEUE_BACKEND_ORCHESTRATION') &&
  printQueueRoute.includes('planQueueRouteForOrders('));

const base = (extra: Partial<QueueOrderRouteInput> = {}): QueueOrderRouteInput => ({
  hasQueueableLabel: false,
  isTest: false,
  isDirectCarrier: false,
  backendQueueRoute: null,
  explicitPayloadProviderId: null,
  ...extra,
});

check('backend owner still prevents existing-label/test routes from buying',
  classifyQueueOrderRouteServer(base({ hasQueueableLabel: true, isDirectCarrier: true })) === 'backend' &&
  classifyQueueOrderRouteServer(base({ isTest: true, isDirectCarrier: true })) === 'backend');
check('backend owner still owns direct-vs-backend route plans',
  (() => {
    const plan = planQueueRouteForOrders([
      { orderId: 3031, route: base({ isDirectCarrier: true }) },
      { orderId: 3032, route: base({ isDirectCarrier: false }) },
    ], { directViaBackend: true });
    return plan.directCreateOrderIds.length === 0 &&
      JSON.stringify(plan.backendOrderIds) === JSON.stringify([3031, 3032]);
  })());

if (failures > 0) {
  console.error(`\nPS-359 frontend Print Queue route bridge deletion guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}

console.log('\nPS-359 frontend Print Queue route bridge deletion guard passed.');
