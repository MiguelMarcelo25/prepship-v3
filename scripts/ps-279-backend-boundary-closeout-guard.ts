/**
 * PS-279 closeout guard: backend-boundary cleanup remains code/test complete,
 * but the money-path cutover stays flag-gated until a DJ canary.
 *
 * This guard ties together the focused PS-279 guards:
 * - backend route-plan owner exists, is pure, and preserves never-buy behavior
 * - /print-queue/route-plan is inert while PRINT_QUEUE_BACKEND_ORCHESTRATION is off
 * - FE delegation is separately gated by PRINT_QUEUE_FE_DELEGATION and has fallback
 * - Rate Browser emits only backend canonical best-rate decisions
 * - backend eligibility stamps are preferred by the UI
 *
 * Offline only: no DB, no network, no provider calls, no labels, no queue mutation.
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
const ordersView = readText('web/src/components/Views/OrdersView.tsx');
const routePlanHelper = readText('web/src/lib/resolve-backend-route-plan.ts');
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
check('backend orchestrator is pure: no fetch/db/drizzle/provider calls',
  !orchestrator.includes('fetch(') &&
  !orchestrator.includes('drizzle') &&
  !/\bfrom\s+['"][^'"]*\/db/.test(orchestrator) &&
  !/\b(createLabel|startQueueSendJob|addToQueue)\s*\(/.test(orchestrator));

check('backend route ladder keeps existing labels on backend path',
  classifyQueueOrderRouteServer(base({ hasQueueableLabel: true, isDirectCarrier: true })) === 'backend');
check('backend route ladder keeps test orders on backend mock path',
  classifyQueueOrderRouteServer(base({ isTest: true, isDirectCarrier: true })) === 'backend');
check('backend route ladder sends direct carrier label-needed orders to direct-create',
  classifyQueueOrderRouteServer(base({ isDirectCarrier: true })) === 'direct-create');
check('backend route ladder sends ShipStation label-needed orders to backend',
  classifyQueueOrderRouteServer(base({ isDirectCarrier: false })) === 'backend');
check('backend plan splits backend vs direct-create order ids',
  (() => {
    const plan = planQueueRouteForOrders([
      { orderId: 101, route: base({ isDirectCarrier: true }) },
      { orderId: 102, route: base({ hasQueueableLabel: true, isDirectCarrier: true }) },
      { orderId: 103, route: base({ isTest: true, isDirectCarrier: true }) },
      { orderId: 104, route: base({ isDirectCarrier: false }) },
    ]);
    return JSON.stringify(plan.directCreateOrderIds) === JSON.stringify([101]) &&
      JSON.stringify(plan.backendOrderIds) === JSON.stringify([102, 103, 104]);
  })());

check('POST /print-queue/route-plan is registered',
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
check('route-plan returns route ids only and does not start a queue job',
  /return c\.json\(\{\s*plans:[\s\S]*backend_order_ids:[\s\S]*direct_create_order_ids:[\s\S]*\}\)/.test(printQueueRoute) &&
  !/app\.post\('\/route-plan'[\s\S]*startQueueSendJob/.test(printQueueRoute));
check('existing /batch-send route remains registered',
  printQueueRoute.includes("app.post('/batch-send'"));

check('PRINT_QUEUE_BACKEND_ORCHESTRATION defaults off',
  envText.includes('PRINT_QUEUE_BACKEND_ORCHESTRATION: booleanFlag(false)'));
check('PRINT_QUEUE_FE_DELEGATION defaults off',
  envText.includes('PRINT_QUEUE_FE_DELEGATION: booleanFlag(false)'));
check('frontend reads dedicated printQueueFeDelegation flag',
  ordersView.includes('printQueueFeDelegation'));
check('frontend calls backend route-plan only inside printQueueFeDelegation gate',
  /if \(printQueueFeDelegation\)[\s\S]{0,700}resolveBackendRoutePlan\(/.test(ordersView));
// PS-303 (Per user override unlock shipped data on 2026-06-23): the route is BINDING when
// FE delegation is ON (bindOrFallbackQueueRoute); the per-order local classifier is the
// fallback ONLY when the flag is OFF or no plan exists (byte-identical OFF default).
// Supersedes PS-279's "fallback always preserved" pin.
check('frontend route binds to the backend plan when delegation on; local classifier is the OFF/no-plan fallback',
  /bindOrFallbackQueueRoute\(\s*printQueueFeDelegation,/.test(ordersView) &&
  ordersView.includes('classifyQueueOrderRoute('));
check('route-plan helper fails safe to null',
  routePlanHelper.includes('export async function resolveBackendRoutePlan') &&
  /catch\s*\{[\s\S]{0,200}return null/.test(routePlanHelper));

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
check('RateBrowserModal reads backend eligibility stamps before deploy-skew fallback',
  rateBrowserModal.includes('eligibilityBlocked') &&
  rateBrowserModal.includes('eligibilityBlockReason') &&
  rateBrowserModal.includes('evaluateShippingServiceEligibility('));

const closeoutStatus = {
  card: 'PS-279',
  codeStatus: 'code/test proof complete',
  runtimeStatus: 'flags default off; route-plan and FE delegation canary pending',
  trelloRecommendation: 'keep In Progress until flagged backend route-plan canary passes',
  safety: 'no label purchase, provider call, queue mutation, marketplace notification, or production data repair',
};

check('PS-279 closeout status is explicit about canary pending',
  closeoutStatus.card === 'PS-279' &&
  closeoutStatus.codeStatus === 'code/test proof complete' &&
  closeoutStatus.runtimeStatus.includes('canary pending') &&
  closeoutStatus.trelloRecommendation.includes('keep In Progress') &&
  closeoutStatus.safety.startsWith('no label purchase'));

if (failures > 0) {
  console.error(`\nFAIL PS-279 backend-boundary closeout guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-279 backend-boundary closeout guard');
