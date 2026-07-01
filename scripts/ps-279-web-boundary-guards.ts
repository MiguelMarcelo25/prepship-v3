/**
 * PS-279 / PS-359 guard - Print Queue routing is no longer a frontend web
 * boundary. The old `web/src/lib/shipping-routes.ts` helper and FE route-plan
 * bridge are intentionally deleted; backend services own routing and purchase.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  classifyQueueOrderRouteServer,
  planQueueRouteForOrders,
} from '../src/services/print-queue/queue-route-orchestrator';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
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

check('obsolete FE shipping-routes helper is deleted',
  !existsSync('web/src/lib/shipping-routes.ts'));
check('obsolete FE route-plan helper is deleted',
  !existsSync('web/src/lib/resolve-backend-route-plan.ts'));

const ov = stripComments(read('web/src/components/Views/OrdersView.tsx'));
check('OrdersView has no Print Queue route classifier import or call',
  !/classifyQueueOrderRoute/.test(ov) &&
  !/resolveBackendRoutePlan/.test(ov) &&
  !/bindOrFallbackQueueRoute/.test(ov) &&
  !/printQueueFeDelegation/.test(ov));
check('OrdersView sends queue intent to backend job owner',
  /const backendJobOrders = jobOrders/.test(ov) &&
  /startQueueSendJob\(\{/.test(ov));
check('OrdersView still has no FE direct-carrier buy path',
  !/createDirectCarrierLabelThenQueue/.test(ov) &&
  !/directLabelAccountRefFromProviderId/.test(ov));

const directFixture = {
  hasQueueableLabel: false,
  isTest: false,
  isDirectCarrier: true,
  backendQueueRoute: null,
  explicitPayloadProviderId: null,
};
check('backend route owner still classifies ShipStation vs direct residual routes',
  classifyQueueOrderRouteServer({ ...directFixture, isDirectCarrier: false }) === 'backend' &&
  classifyQueueOrderRouteServer(directFixture) === 'direct-create');
check('backend route owner still blocks never-buy cases',
  classifyQueueOrderRouteServer({ ...directFixture, hasQueueableLabel: true }) === 'backend' &&
  classifyQueueOrderRouteServer({ ...directFixture, isTest: true }) === 'backend' &&
  classifyQueueOrderRouteServer(directFixture, { existingLabelOnly: true }) === 'backend' &&
  classifyQueueOrderRouteServer(directFixture, { batchTestMode: true }) === 'backend');
check('backend plan can force all residual direct routes through backend orchestration',
  (() => {
    const plan = planQueueRouteForOrders([
      { orderId: 2791, route: directFixture },
      { orderId: 2792, route: { ...directFixture, isDirectCarrier: false } },
    ], { directViaBackend: true });
    return plan.directCreateOrderIds.length === 0 &&
      JSON.stringify(plan.backendOrderIds) === JSON.stringify([2791, 2792]);
  })());

const labelsSvc = read('src/services/labels.ts');
check('labels.ts: backend createLabelV2 owns the label buy',
  /function createLabelV2/.test(labelsSvc));
check('labels.ts: backend detects direct carriers',
  /directLabelAccountRefFromProviderId\(body\.shippingProviderId\)/.test(labelsSvc));
check('labels.ts: backend enforces selected-rate proof + account binding before purchase',
  /assertLabelPurchaseRateSelection\(\{[\s\S]*?selectedRateProof:\s*body\.selectedRateProof[\s\S]*?purchaseShippingProviderId:\s*body\.shippingProviderId[\s\S]*?\}\)/.test(labelsSvc));

const printQueueSvc = read('src/services/print-queue.ts');
check('print-queue.ts: queue worker buys via backend createLabelV2',
  /const labelInput = order\.label/.test(printQueueSvc) &&
  /createLabelV2\(\{\s*\.\.\.labelInput/.test(printQueueSvc));

check('package.json wires test:ps-279-web-boundary-guards',
  /test:ps-279-web-boundary-guards/.test(read('package.json')));

if (failures > 0) {
  console.error(`\nFAIL PS-279 web boundary guards (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-279 web boundary guards');
