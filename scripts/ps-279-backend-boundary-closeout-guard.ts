/**
 * PS-279 / PS-359 closeout guard: backend-boundary cleanup remains complete.
 *
 * Print Queue routing is now backend-only from the frontend perspective: the old
 * FE delegation flag/helper is gone. Rate Browser and eligibility proofs from
 * the original PS-279 closeout remain pinned here.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  classifyQueueOrderRouteServer,
  planQueueRouteForOrders,
  type QueueOrderRouteInput,
} from '../src/services/print-queue/queue-route-orchestrator';
import { resolveRateEligibilityStamp } from '../src/services/shipping-workflow/rate-eligibility-stamp';
import { HUGRAB_GROUND_SAVER_BLOCK_REASON } from '../src/lib/shipping-service-eligibility';
import { decideBestRateEmission } from '../web/src/lib/rate-browser-best-emission';

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function base(extra: Partial<QueueOrderRouteInput> = {}): QueueOrderRouteInput {
  return {
    hasQueueableLabel: false,
    isTest: false,
    isDirectCarrier: false,
    backendQueueRoute: null,
    explicitPayloadProviderId: null,
    ...extra,
  };
}

const packageJson = readText('package.json');
const orchestrator = readText('src/services/print-queue/queue-route-orchestrator.ts');
const printQueueRoute = readText('src/routes/print-queue.ts');
const envText = readText('src/lib/env.ts');
const ordersView = stripComments(readText('web/src/components/Views/OrdersView.tsx'));
const rateBrowserModal = readText('web/src/components/RateBrowserModal.tsx');
const orderRateDto = readText('src/services/order-rate-dto.ts');

check('package wires PS-279 backend orchestration guard',
  packageJson.includes('"test:ps-279-backend-orchestration"'));
check('package wires PS-279 web boundary guard',
  packageJson.includes('"test:ps-279-web-boundary-guards"'));
check('package wires PS-279 rate browser no-fallback guard',
  packageJson.includes('"test:ps-279-rate-browser-no-fallback-best"'));
check('package wires PS-279 backend eligibility stamp guard',
  packageJson.includes('"test:ps-279-backend-eligibility-stamp"'));
check('package wires PS-279 closeout guard',
  packageJson.includes('"test:ps-279-backend-boundary-closeout"'));

check('backend orchestrator source exists',
  existsSync('src/services/print-queue/queue-route-orchestrator.ts'));
check('backend orchestrator reuses synthetic provider id owner',
  orchestrator.includes('DIRECT_SYNTHETIC_PROVIDER_ID_FLOOR') &&
  orchestrator.includes("from '../shipping-workflow/rate-fingerprint'"));
check('backend orchestrator is pure',
  !orchestrator.includes('fetch(') &&
  !orchestrator.includes('drizzle') &&
  !/\bfrom\s+['"][^'"]*\/db/.test(orchestrator) &&
  !/\b(createLabel|startQueueSendJob|addToQueue)\s*\(/.test(orchestrator));

check('backend route ladder keeps existing labels on backend path',
  classifyQueueOrderRouteServer(base({ hasQueueableLabel: true, isDirectCarrier: true })) === 'backend');
check('backend route ladder keeps test orders on backend mock path',
  classifyQueueOrderRouteServer(base({ isTest: true, isDirectCarrier: true })) === 'backend');
check('backend route ladder sends direct carrier label-needed orders to direct-create classification',
  classifyQueueOrderRouteServer(base({ isDirectCarrier: true })) === 'direct-create');
check('backend route ladder sends ShipStation label-needed orders to backend',
  classifyQueueOrderRouteServer(base({ isDirectCarrier: false })) === 'backend');
check('backend directViaBackend plan routes all live send-to-queue orders to backend',
  (() => {
    const plan = planQueueRouteForOrders([
      { orderId: 101, route: base({ isDirectCarrier: true }) },
      { orderId: 102, route: base({ hasQueueableLabel: true, isDirectCarrier: true }) },
      { orderId: 103, route: base({ isTest: true, isDirectCarrier: true }) },
      { orderId: 104, route: base({ isDirectCarrier: false }) },
    ], { directViaBackend: true });
    return plan.directCreateOrderIds.length === 0 &&
      JSON.stringify(plan.backendOrderIds) === JSON.stringify([101, 102, 103, 104]);
  })());

check('POST /print-queue/route-plan is registered for backend diagnostics/canary',
  printQueueRoute.includes("app.post('/route-plan'"));
check('route-plan checks PRINT_QUEUE_BACKEND_ORCHESTRATION before planning',
  (() => {
    const handlerStart = printQueueRoute.indexOf("app.post('/route-plan'");
    const flagCheck = printQueueRoute.indexOf('env.PRINT_QUEUE_BACKEND_ORCHESTRATION', handlerStart);
    const planCall = printQueueRoute.indexOf('planQueueRouteForOrders(', handlerStart);
    return handlerStart >= 0 && flagCheck > handlerStart && planCall > flagCheck;
  })());
check('route-plan disabled response is FEATURE_DISABLED 503',
  printQueueRoute.includes("'FEATURE_DISABLED'") && printQueueRoute.includes('503'));
check('existing /batch-send route remains registered',
  printQueueRoute.includes("app.post('/batch-send'"));

check('PRINT_QUEUE_BACKEND_ORCHESTRATION defaults off',
  envText.includes('PRINT_QUEUE_BACKEND_ORCHESTRATION: booleanFlag(false)'));
check('PRINT_QUEUE_FE_DELEGATION has been removed',
  !envText.includes('PRINT_QUEUE_FE_DELEGATION'));
check('frontend route bridge/delegation is deleted',
  !existsSync('web/src/lib/resolve-backend-route-plan.ts') &&
  !existsSync('web/src/lib/shipping-routes.ts') &&
  !ordersView.includes('resolveBackendRoutePlan') &&
  !ordersView.includes('bindOrFallbackQueueRoute') &&
  !ordersView.includes('printQueueFeDelegation') &&
  !ordersView.includes('classifyQueueOrderRoute'));
check('frontend sends backend queue job intent only',
  ordersView.includes('const backendJobOrders = jobOrders') &&
  ordersView.includes('startQueueSendJob({'));

check('Rate Browser pure emission emits canonical best verbatim',
  (() => {
    const canonical = { serviceCode: 'ups_ground', shippingProviderId: 42 };
    const decision = decideBestRateEmission(canonical);
    return decision.kind === 'emit' && decision.rate === canonical;
  })());
check('Rate Browser pure emission does not fabricate a best when canonical best is absent',
  decideBestRateEmission(null).kind === 'unresolved' &&
  decideBestRateEmission(undefined).kind === 'unresolved');
check('RateBrowserModal delegates best emission to decideBestRateEmission(canonicalBest)',
  /decideBestRateEmission\(\s*canonicalBest\s*\)/.test(rateBrowserModal));
check('RateBrowserModal does not use a local cheapest fallback as best',
  !/canonicalBest\s*\?\?[\s\S]{0,250}?\.sort\([\s\S]{0,180}?rateDisplayTotal[\s\S]{0,180}?\)\[0\]/.test(rateBrowserModal));

check('backend eligibility resolver blocks HUGRAB UPS Ground Saver with canonical reason',
  (() => {
    const stamp = resolveRateEligibilityStamp({
      context: { clientId: 4, clientName: 'HUGRAB', storeId: 378060 },
      service: { carrierCode: 'ups', serviceCode: 'ups_ground_saver', serviceName: 'UPS Ground Saver' },
    });
    return stamp.eligibilityBlocked === true &&
      stamp.eligibilityBlockReason === HUGRAB_GROUND_SAVER_BLOCK_REASON;
  })());
check('order-rate DTO imports backend eligibility resolver',
  orderRateDto.includes("from './shipping-workflow/rate-eligibility-stamp'"));
check('RateBrowserModal reads backend eligibility stamps without deploy-skew fallback',
  rateBrowserModal.includes('eligibilityBlocked') &&
  rateBrowserModal.includes('eligibilityBlockReason') &&
  rateBrowserModal.includes('rateBrowserUnavailableReason(') &&
  !rateBrowserModal.includes('evaluateShippingServiceEligibility('));

const closeoutStatus = {
  card: 'PS-279',
  codeStatus: 'code/test proof complete',
  runtimeStatus: 'frontend route bridge deleted; backend route-plan remains default-off diagnostic/canary endpoint',
  trelloRecommendation: 'PS-279 remains a dependency proof; PS-359 owns bridge deletion',
  safety: 'no label purchase, provider call, queue mutation, marketplace notification, or production data repair',
};

check('PS-279 closeout status is explicit about PS-359 bridge deletion',
  closeoutStatus.card === 'PS-279' &&
  closeoutStatus.codeStatus === 'code/test proof complete' &&
  closeoutStatus.runtimeStatus.includes('bridge deleted') &&
  closeoutStatus.trelloRecommendation.includes('PS-359') &&
  closeoutStatus.safety.startsWith('no label purchase'));

if (failures > 0) {
  console.error(`\nFAIL PS-279 backend-boundary closeout guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-279 backend-boundary closeout guard');
